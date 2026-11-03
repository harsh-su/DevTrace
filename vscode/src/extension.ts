import * as vscode from 'vscode'
import * as os from 'node:os'
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { diffHunks, languageId, lineSlice, type Hunk, type Metrics, type Trace } from '@aitrace/core'
import { TraceSession } from './session.js'
import { ResultsPanel } from './results.js'
import { PendingStore, type PendingFile } from './staging.js'
import { PendingDecorations, PendingTreeProvider } from './pendingView.js'
import { TracePanel } from './tracePanel.js'
import { TourStore } from './tour.js'
import { TourTreeProvider } from './tourView.js'

interface LastResults {
  trace: Trace
  metrics: Metrics
  label: string
  completed: boolean
}

let statusItem: vscode.StatusBarItem
let lastResults: LastResults | undefined
let extensionUri: vscode.Uri
let store: PendingStore
let treeProvider: PendingTreeProvider
let treeView: vscode.TreeView<unknown>
let tourStore: TourStore
let tourProvider: TourTreeProvider
let tourTreeView: vscode.TreeView<unknown>

let processing = false
let autoPumping = false

const hooks = {
  onProgress: (t: Trace): void => {
    const total = t.doc.text.length
    const pct = total > 0 ? Math.round((t.cursor / total) * 100) : 0
    statusItem.text = `$(keyboard) AItrace ${pct}%`
    statusItem.tooltip = 'Tracing — click (or Esc) to end the session'
    statusItem.show()
  },
  onFinish: (t: Trace, m: Metrics, completed: boolean): void => {
    const label = TraceSession.active?.sessionLabel ?? 'session'
    lastResults = { trace: t, metrics: m, label, completed }
    statusItem.text = '$(keyboard) AItrace'
    statusItem.command = 'aitrace.openSidebar'
    statusItem.tooltip = 'AItrace: Click to open Pending Changes sidebar'
    ResultsPanel.show(t, m, label, completed)
  },
}

/** Start a trace, chaining `onDone` after the session ends. */
async function begin(
  editor: vscode.TextEditor,
  target: string,
  range: vscode.Range,
  replace: boolean,
  onDone?: () => void,
): Promise<void> {
  if (TraceSession.active) {
    void vscode.window.showWarningMessage('A AItrace session is already running.')
    return
  }
  const wrapped = {
    onProgress: hooks.onProgress,
    onFinish: (t: Trace, m: Metrics, completed: boolean) => {
      hooks.onFinish(t, m, completed)
      onDone?.()
    },
  }
  await TraceSession.start(editor, { target, range, replace, hooks: wrapped })
  statusItem.show()
}

/**
 * Trace every outstanding change to one file in the dedicated panel. Later
 * pending records compose on earlier ones, so the newest `after` is the whole
 * proposed file; diffing it against disk yields every hunk that has not been
 * typed yet. Nothing is written unless the developer saves, then the file is
 * written once and exactly those records are retired.
 *
 * Returns what the developer chose, so the caller can retire the queue entries.
 */
async function applyPending(group: PendingFile): Promise<'save' | 'discard'> {
  const uri = vscode.Uri.file(group.file)
  let current = ''
  try {
    current = (await vscode.workspace.openTextDocument(uri)).getText()
  } catch {
    // New file the AI wanted to create: it is not on disk yet.
    current = ''
  }

  const hunks = diffHunks(current, group.after)
  if (hunks.length === 0) {
    await store.removeSnapshots(group.entries)
    void vscode.window.showInformationMessage('AItrace: those staged changes were already applied.')
    return 'save'
  }

  const rel = vscode.workspace.asRelativePath(uri, false)
  const changes = hunks.length === 1 ? '1 change' : `${hunks.length} changes`
  const label = `${rel} · ${changes}`

  // Every hunk of the file is traced in one panel, over the whole proposed file:
  // the developer sees the complete file as context and only types the changes.
  const regions = hunks.map((h) => ({ start: h.afterStart, target: h.newText }))

  statusItem.text = '$(keyboard) AItrace 0%'
  statusItem.tooltip = 'Tracing an AI change — Save writes what you type, Esc discards'
  statusItem.show()

  const result = await TracePanel.show(extensionUri, group.after, regions, label, {
    language: languageId(group.file),
  })

  statusItem.text = '$(keyboard) AItrace'
  statusItem.tooltip = 'Click to end a running session'

  if (result.action === 'discard') return 'discard'

  // One typed string per hunk: a pure deletion has nothing to type and is
  // accepted as-is, matching the empty target the panel was given.
  const typed = hunks.map((h, i) => (h.newText.length === 0 ? '' : (result.typedTexts[i] ?? '')))

  await writeHunks(uri, current, hunks, typed)
  await store.removeSnapshots(group.entries)
  return 'save'
}

/**
 * Write exactly what was typed for each hunk, leaving the unchanged text between
 * them untouched. The editor buffer is only touched here, once, after every hunk
 * has been traced.
 */
async function writeHunks(
  uri: vscode.Uri,
  current: string,
  hunks: Hunk[],
  typed: string[],
): Promise<void> {
  let out = ''
  let pos = 0
  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i] as Hunk
    out += current.slice(pos, hunk.start) + typed[i]
    pos = hunk.start + hunk.oldText.length
  }
  out += current.slice(pos)

  try {
    await vscode.workspace.fs.stat(uri)
  } catch {
    await vscode.workspace.fs.writeFile(uri, new Uint8Array())
  }

  const doc = await vscode.workspace.openTextDocument(uri)
  const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
  const edit = new vscode.WorkspaceEdit()
  edit.replace(uri, full, out)
  const applied = await vscode.workspace.applyEdit(edit)
  if (!applied) {
    void vscode.window.showErrorMessage('AItrace: could not write the traced change.')
    return
  }
  await doc.save()
}

/** Trace one pending file, retiring the records in the snapshot on save. */
async function tracePendingFile(file: string): Promise<'save' | 'discard' | undefined> {
  if (processing) {
    void vscode.window.showInformationMessage('AItrace is already tracing a change.')
    return undefined
  }
  processing = true
  try {
    const group = store.group(file)
    if (!group) return undefined
    return await applyPending(group)
  } finally {
    processing = false
  }
}

function autoTraceEnabled(): boolean {
  return vscode.workspace.getConfiguration('aitrace').get<boolean>('autoTrace', false)
}

/**
 * Trace one learning-path step: read the file, cut the step's range, explain it
 * in the panel, then have the developer type it. A save records the score in
 * tour-progress.json — nothing is ever written to the file itself, since the
 * step points at code that already exists.
 */
async function traceTourStep(stepId: string): Promise<void> {
  const tour = tourStore.getTour()
  if (!tour) {
    void vscode.window.showInformationMessage(
      'AItrace: no learning path yet. Ask OpenCode to "tour me through this project".',
    )
    return
  }
  const idx = tour.steps.findIndex((s) => s.id === stepId)
  if (idx < 0) {
    void vscode.window.showWarningMessage(
      `AItrace: no step "${stepId}" in the current learning path.`,
    )
    return
  }
  const step = tour.steps[idx] as NonNullable<(typeof tour.steps)[number]>
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return

  const abs = vscode.Uri.joinPath(folder.uri, step.file.replace(/^\//, ''))
  let text: string
  try {
    text = (await vscode.workspace.openTextDocument(abs)).getText()
  } catch {
    void vscode.window.showWarningMessage(
      `AItrace: the step points at ${step.file}, which could not be read. The tour may be stale — ask OpenCode to rebuild it.`,
    )
    return
  }

  const target = lineSlice(text, step.start, step.lines)
  if (!target.trim()) {
    void vscode.window.showWarningMessage(`AItrace: lines ${step.start}+ of ${step.file} are empty.`)
    return
  }

  const label =
    `Step ${idx + 1}/${tour.steps.length} · ${step.title}` +
    (step.concept ? ` — ${step.concept}` : '')

  statusItem.text = '$(keyboard) AItrace 0%'
  statusItem.tooltip = 'Tracing a learning-path step — Esc pauses, does not record'
  statusItem.show()

  const result = await TracePanel.show(extensionUri, target, [{ start: 0, target }], label, {
    mode: 'tour',
    brief: step.explanation,
    language: languageId(step.file),
  })

  statusItem.text = '$(keyboard) AItrace'
  tourProvider.refresh()

  if (result.action !== 'save' || !result.metrics) return

  await tourStore.recordAttempt(stepId, result.metrics)
  const m = result.metrics
  const done = tourStore.done(stepId)
  const next = tour.steps[idx + 1]
  const summary =
    `AItrace · ${step.title}: ${Math.round(m.netWpm)} wpm, ` +
    `${Math.round(m.accuracy * 100)}% — ${done ? 'step complete' : 'retrace this step to finish it'}`
  const actions = next && done ? ['Next step'] : []
  const pick = await vscode.window.showInformationMessage(
    summary + (next && done ? ` Up next: ${next.title}.` : ''),
    ...actions,
  )
  if (pick === 'Next step' && next) await traceTourStep(next.id)
}

/** With auto-trace on, work through the queue until one is discarded or empty. */
async function autoPump(): Promise<void> {
  if (autoPumping || !autoTraceEnabled()) return
  autoPumping = true
  try {
    while (!processing) {
      const next = store.groups()[0]
      if (!next) break
      const action = await tracePendingFile(next.file)
      if (action !== 'save') break
    }
  } finally {
    autoPumping = false
  }
}

/** Trace every pending file in order, stopping if one is discarded. */
async function traceAll(): Promise<void> {
  while (!processing) {
    const next = store.groups()[0]
    if (!next) break
    const action = await tracePendingFile(next.file)
    if (action !== 'save') break
  }
}

/** The workspace-relative queue directory, e.g. `<root>/.aitrace`. */
function queueDirUri(folder: vscode.WorkspaceFolder): vscode.Uri {
  const cfg = vscode.workspace.getConfiguration('aitrace', folder.uri)
  const rel = cfg.get<string>('queueDir', '.aitrace')
  return vscode.Uri.joinPath(folder.uri, rel)
}

/**
 * AItrace staging is on exactly when a `.aitrace/` queue directory exists —
 * that is the same signal the OpenCode plugin watches.
 */
function isStagingEnabled(): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some((f) => existsSync(queueDirUri(f).fsPath))
}

async function updateStagingContext(): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'aitrace.stagingEnabled', isStagingEnabled())
}

/** On startup, honour the persisted preference by ensuring the queue exists. */
async function ensureStagingFromSetting(): Promise<void> {
  if (!vscode.workspace.getConfiguration('aitrace').get<boolean>('enabled', true)) return
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(queueDirUri(folder), 'pending'))
    } catch {
      /* unwritable folder — staging just stays off */
    }
  }
}

/** Turn staging on/off by creating or removing the queue directory. */
async function setStaging(enabled: boolean): Promise<void> {
  if (enabled === isStagingEnabled()) {
    await updateStagingContext()
    return
  }

  if (!enabled) {
    const n = store.groups().length
    const detail =
      n > 0
        ? `This removes ${n} pending file${n === 1 ? '' : 's'} that haven't been traced.`
        : 'OpenCode edits will no longer be staged for hand-typing.'
    const pick = await vscode.window.showWarningMessage(`Turn off AItrace? ${detail}`, { modal: true }, 'Turn off')
    if (pick !== 'Turn off') return
  }

  const folders = vscode.workspace.workspaceFolders ?? []
  const target =
    folders.length > 0 ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
  await vscode.workspace.getConfiguration('aitrace').update('enabled', enabled, target)

  for (const folder of folders) {
    const dir = queueDirUri(folder)
    try {
      if (enabled) await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dir, 'pending'))
      else await vscode.workspace.fs.delete(dir, { recursive: true })
    } catch {
      /* best effort */
    }
  }

  await store.reset()
  await updateStagingContext()
}

interface PluginInstallResult {
  changed: boolean
  created: boolean
  pluginsDir: vscode.Uri
}

/** Copy the bundled OpenCode plugin into `~/.config/opencode/plugins/`. */
async function installOpencodePlugin(
  context: vscode.ExtensionContext,
  enableStaging: boolean,
): Promise<PluginInstallResult> {
  const source = vscode.Uri.joinPath(context.extensionUri, 'assets', 'opencode-plugin.ts')
  const pluginsDir = vscode.Uri.file(path.join(os.homedir(), '.config', 'opencode', 'plugins'))
  const target = vscode.Uri.joinPath(pluginsDir, 'aitrace.ts')
  const bytes = await vscode.workspace.fs.readFile(source)

  let created = true
  let changed = true
  try {
    const existing = await vscode.workspace.fs.readFile(target)
    created = false
    changed = Buffer.compare(Buffer.from(existing), Buffer.from(bytes)) !== 0
  } catch {
    // Not installed yet.
  }

  if (changed) {
    await vscode.workspace.fs.createDirectory(pluginsDir)
    await vscode.workspace.fs.writeFile(target, bytes)
  }

  // Staging is opt-in via the queue directory, which is the same signal the
  // plugin watches. Create it so the plugin is live after a restart.
  if (enableStaging) await setStaging(true)

  return { changed, created, pluginsDir }
}

/**
 * Install the OpenCode plugin automatically when OpenCode is already set up.
 * Skipped when `~/.config/opencode` is missing so we do not create config for
 * people who do not use OpenCode. The sidebar button remains for manual repair.
 */
async function autoInstallOpencodePlugin(context: vscode.ExtensionContext): Promise<void> {
  const opencodeDir = path.join(os.homedir(), '.config', 'opencode')
  if (!existsSync(opencodeDir)) return
  const source = path.join(context.extensionUri.fsPath, 'assets', 'opencode-plugin.ts')
  if (!existsSync(source)) return
  try {
    const result = await installOpencodePlugin(context, false)
    if (result.created) {
      void vscode.window.showInformationMessage(
        'AItrace: OpenCode plugin installed. Restart opencode to load it.',
      )
    }
  } catch {
    // A manual install is still available from the sidebar.
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionUri = context.extensionUri
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusItem.command = 'aitrace.openSidebar'
  statusItem.text = '$(keyboard) AItrace'
  statusItem.tooltip = 'AItrace: Click to open Pending Changes sidebar'
  statusItem.show()

  TracePanel.onProgress = (pct) => {
    statusItem.text = `$(keyboard) AItrace ${pct}%`
    statusItem.command = 'aitrace.endSession'
    statusItem.tooltip = 'Tracing — click (or Esc) to end session'
    statusItem.show()
  }

  // The pending-changes panel: a Source Control-like list of AI edits waiting to
  // be typed by hand.
  store = new PendingStore(() => void autoPump())
  treeProvider = new PendingTreeProvider(store)
  treeView = vscode.window.createTreeView('aitrace.pending', {
    treeDataProvider: treeProvider,
  })
  const decorations = new PendingDecorations(store)
  store.onDidChange(() => {
    treeProvider.refresh()
    const n = store.groups().length
    treeView.badge = n > 0 ? { value: n, tooltip: `${n} pending file${n === 1 ? '' : 's'}` } : undefined
    if (!TraceSession.active) {
      statusItem.text = n > 0 ? `$(keyboard) AItrace (${n})` : '$(keyboard) AItrace'
      statusItem.command = 'aitrace.openSidebar'
      statusItem.tooltip = 'AItrace: Click to open Pending Changes sidebar'
      statusItem.show()
    }
  })
  void (async () => {
    await ensureStagingFromSetting()
    await autoInstallOpencodePlugin(context)
    await store.start()
    await updateStagingContext()
    await autoPump()
  })()

  // The learning path: an AI-authored tour.json the developer works through by
  // typing each step.
  tourStore = new TourStore()
  tourProvider = new TourTreeProvider(tourStore)
  tourTreeView = vscode.window.createTreeView('aitrace.tour', {
    treeDataProvider: tourProvider,
  })
  const updateTourContext = (): void => {
    void vscode.commands.executeCommand('setContext', 'aitrace.tourHasTour', tourStore.loaded)
    const tour = tourStore.getTour()
    let badge: { value: number; tooltip: string } | undefined
    if (tour) {
      const left = tour.steps.filter((s) => !tourStore.done(s.id)).length
      badge = { value: left, tooltip: 'steps left to trace' }
    }
    tourTreeView.badge = badge
  }
  tourStore.onDidChange(updateTourContext)
  void tourStore.start()

  const traceSelection = vscode.commands.registerCommand('aitrace.traceSelection', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) return
    if (editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('Select the code you want to trace first.')
      return
    }
    const range = new vscode.Range(editor.selection.start, editor.selection.end)
    const target = editor.document.getText(range)
    if (!target.trim()) {
      void vscode.window.showInformationMessage('That selection is empty.')
      return
    }
    await begin(editor, target, range, false)
  })

  const traceFile = vscode.commands.registerCommand('aitrace.traceFile', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) return
    const doc = editor.document
    const target = doc.getText()
    if (!target.trim()) {
      void vscode.window.showInformationMessage('This file is empty.')
      return
    }
    const range = new vscode.Range(doc.positionAt(0), doc.positionAt(target.length))
    await begin(editor, target, range, false)
  })

  const endSession = vscode.commands.registerCommand('aitrace.endSession', () => {
    TracePanel.discardActive()
    TraceSession.active?.abort()
  })

  const showResults = vscode.commands.registerCommand('aitrace.showResults', () => {
    if (!lastResults) {
      void vscode.window.showInformationMessage('No AItrace results yet.')
      return
    }
    ResultsPanel.show(lastResults.trace, lastResults.metrics, lastResults.label, lastResults.completed)
  })

/** A pending item, a group.file string, or a legacy entry argument. */
function extractFile(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg
  if (arg && typeof arg === 'object') {
    if ('group' in arg) {
      const item = arg as { group?: { file?: string } }
      return item.group?.file
    }
    if ('entry' in arg) {
      const item = arg as { entry?: { change?: { file?: string } } }
      return item.entry?.change?.file
    }
  }
  return undefined
}

async function applyDirectly(group: PendingFile): Promise<void> {
  const uri = vscode.Uri.file(group.file)
  const fullBytes = Buffer.from(group.after, 'utf8')
  await vscode.workspace.fs.writeFile(uri, fullBytes)
}

  const tracePending = vscode.commands.registerCommand('aitrace.pending.trace', async (arg: unknown) => {
    const file = extractFile(arg)
    if (!file) return
    await tracePendingFile(file)
  })

  const acceptPending = vscode.commands.registerCommand('aitrace.pending.accept', async (arg: unknown) => {
    const file = extractFile(arg)
    if (!file) return
    const group = store.group(file)
    if (!group) return
    await applyDirectly(group)
    await store.removeSnapshots(group.entries)
    void vscode.window.showInformationMessage(
      `AItrace: Accepted changes for ${vscode.workspace.asRelativePath(group.file, false)}.`,
    )
  })

  const acceptAllPending = vscode.commands.registerCommand('aitrace.pending.acceptAll', async () => {
    const groups = store.groups()
    if (groups.length === 0) return
    for (const group of groups) {
      await applyDirectly(group)
      await store.removeSnapshots(group.entries)
    }
    void vscode.window.showInformationMessage(
      `AItrace: Accepted all changes for ${groups.length} pending file${groups.length === 1 ? '' : 's'}.`,
    )
  })

  const discardPending = vscode.commands.registerCommand('aitrace.pending.discard', async (arg: unknown) => {
    const file = extractFile(arg)
    if (!file) return
    const group = store.group(file)
    if (!group) return
    const rel = vscode.workspace.asRelativePath(group.file, false)
    const pick = await vscode.window.showWarningMessage(
      `Discard all pending changes to ${rel}?`,
      { modal: true },
      'Discard',
    )
    if (pick === 'Discard') {
      const latest = store.group(file)
      if (latest) await store.removeSnapshots(latest.entries)
    }
  })

  const revealPending = vscode.commands.registerCommand('aitrace.pending.reveal', async (arg: unknown) => {
    const file = extractFile(arg)
    if (!file) return
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(file))
    } catch {
      void vscode.window.showWarningMessage('AItrace: that file no longer exists.')
    }
  })

  const traceAllPending = vscode.commands.registerCommand('aitrace.pending.traceAll', () => void traceAll())

  const clearPending = vscode.commands.registerCommand('aitrace.pending.clear', async () => {
    const groups = store.groups()
    if (groups.length === 0) return
    const pick = await vscode.window.showWarningMessage(
      `Discard all pending changes to ${groups.length} file${groups.length === 1 ? '' : 's'}?`,
      { modal: true },
      'Discard all',
    )
    if (pick !== 'Discard all') return
    for (const group of groups) await store.removeSnapshots(group.entries)
  })

  const refreshPending = vscode.commands.registerCommand('aitrace.pending.refresh', () =>
    treeProvider.refresh(),
  )

  const enableStaging = vscode.commands.registerCommand('aitrace.enableStaging', () => setStaging(true))
  const disableStaging = vscode.commands.registerCommand('aitrace.disableStaging', () => setStaging(false))

  const traceTour = vscode.commands.registerCommand('aitrace.tour.trace', async (id: string) => {
    if (!tourStore.loaded) {
      void vscode.window.showInformationMessage(
        'AItrace: no learning path yet. Ask OpenCode to "tour me through this project".',
      )
      return
    }
    await traceTourStep(id)
  })

  const traceNextTourStep = vscode.commands.registerCommand('aitrace.tour.next', async () => {
    const tour = tourStore.getTour()
    if (!tour) {
      void vscode.window.showInformationMessage(
        'AItrace: no learning path yet. Ask OpenCode to "tour me through this project".',
      )
      return
    }
    const step = tour.steps.find((s) => !tourStore.done(s.id)) ?? tour.steps[0]
    if (step) await traceTourStep(step.id)
  })

  const revealTourStep = vscode.commands.registerCommand('aitrace.tour.reveal', async (id: string) => {
    const tour = tourStore.getTour()
    const step = tour?.steps.find((s) => s.id === id)
    if (!tour || !step) return
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) return
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, step.file))
      const editor = await vscode.window.showTextDocument(doc, { preview: true })
      const line = Math.min(Math.max(0, step.start - 1), doc.lineCount - 1)
      editor.revealRange(
        new vscode.Range(line, 0, Math.max(line, Math.min(line + step.lines, doc.lineCount) - 1), 0),
        vscode.TextEditorRevealType.InCenter,
      )
    } catch {
      void vscode.window.showWarningMessage(`AItrace: could not open ${step.file}.`)
    }
  })

  const resetTourProgress = vscode.commands.registerCommand('aitrace.tour.reset', async () => {
    if (!tourStore.loaded) {
      void vscode.window.showInformationMessage('AItrace: no learning path to reset.')
      return
    }
    const pick = await vscode.window.showWarningMessage(
      'Clear all learning-path progress? Your scores are deleted; the steps stay.',
      { modal: true },
      'Clear progress',
    )
    if (pick === 'Clear progress') await tourStore.resetProgress()
  })

  const refreshTour = vscode.commands.registerCommand('aitrace.tour.refresh', () =>
    tourProvider.refresh(),
  )

  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('aitrace.enabled') || e.affectsConfiguration('aitrace.queueDir')) {
      void updateStagingContext()
    }
  })

  const setupAntigravity = vscode.commands.registerCommand('aitrace.setupAntigravity', async () => {
    const folders = vscode.workspace.workspaceFolders
    if (!folders || folders.length === 0) {
      void vscode.window.showErrorMessage('AItrace: please open a workspace folder first.')
      return
    }
    const folder = folders[0] as vscode.WorkspaceFolder
    const agentsDir = vscode.Uri.joinPath(folder.uri, '.agents')
    const rulesDir = vscode.Uri.joinPath(agentsDir, 'rules')
    const hookSource = vscode.Uri.joinPath(context.extensionUri, 'assets', 'antigravity-aitrace.mjs')
    const hookTarget = vscode.Uri.joinPath(agentsDir, 'aitrace-hook.mjs')
    const hooksJsonTarget = vscode.Uri.joinPath(agentsDir, 'hooks.json')
    const ruleTarget = vscode.Uri.joinPath(rulesDir, 'aitrace.md')

    try {
      await vscode.workspace.fs.createDirectory(rulesDir)
      const hookBytes = await vscode.workspace.fs.readFile(hookSource)
      await vscode.workspace.fs.writeFile(hookTarget, hookBytes)

      const hooksConfig = {
        aitrace: {
          PreToolUse: [
            {
              matcher: 'write_to_file|replace_file_content|multi_replace_file_content',
              hooks: [
                {
                  type: 'command',
                  command: 'node aitrace-hook.mjs',
                  timeout: 15,
                },
              ],
            },
          ],
        },
      }
      await vscode.workspace.fs.writeFile(
        hooksJsonTarget,
        Buffer.from(JSON.stringify(hooksConfig, null, 2), 'utf8'),
      )

      const ruleContent = `# AItrace Mode Active
When file editing tools (\`write_to_file\`, \`replace_file_content\`, \`multi_replace_file_content\`) return a message starting with "AItrace:", treat this result as EXPECTED SUCCESS.
- The proposed change has been safely staged into \`.aitrace/pending/\` for the developer to type by hand.
- Do NOT retry the edit, do not attempt alternative editing tools, and do not apologize or complain that the file is unchanged.
- Proceed with subsequent steps or inform the developer that the code is staged for tracing in AItrace.
`
      await vscode.workspace.fs.writeFile(ruleTarget, Buffer.from(ruleContent, 'utf8'))

      // Enable staging in workspace
      await setStaging(true)

      void vscode.window.showInformationMessage(
        'AItrace: Google Antigravity integration configured! Proposed edits will now be staged for hand-typing.',
      )
    } catch (err) {
      void vscode.window.showErrorMessage(`AItrace: setup failed — ${(err as Error).message}`)
    }
  })

  const installPlugin = vscode.commands.registerCommand('aitrace.installOpencodePlugin', async () => {
    try {
      const { pluginsDir } = await installOpencodePlugin(context, true)
      const open = 'Show folder'
      void vscode.window
        .showInformationMessage(
          'AItrace: OpenCode plugin installed and staging enabled. Restart opencode to load it.',
          open,
        )
        .then((pick) => {
          if (pick === open) void vscode.env.openExternal(pluginsDir)
        })
    } catch (err) {
      void vscode.window.showErrorMessage(`AItrace: could not install plugin — ${(err as Error).message}`)
    }
  })

  const openSidebar = vscode.commands.registerCommand('aitrace.openSidebar', async () => {
    try {
      await vscode.commands.executeCommand('workbench.view.extension.aitrace')
    } catch {
      await vscode.commands.executeCommand('aitrace.pending.focus')
    }
  })

  context.subscriptions.push(
    openSidebar,
    statusItem,
    store,
    treeProvider,
    treeView,
    decorations,
    tourStore,
    tourProvider,
    tourTreeView,
    vscode.window.registerFileDecorationProvider(decorations),
    traceSelection,
    traceFile,
    endSession,
    showResults,
    tracePending,
    acceptPending,
    acceptAllPending,
    discardPending,
    revealPending,
    traceAllPending,
    clearPending,
    refreshPending,
    enableStaging,
    disableStaging,
    configListener,
    setupAntigravity,
    installPlugin,
    traceTour,
    traceNextTourStep,
    revealTourStep,
    resetTourProgress,
    refreshTour,

    // Special keys. Bound only while a session runs so the editor never inserts
    // anything for them — the document must stay immutable.
    vscode.commands.registerCommand('aitrace.enter', () => TraceSession.active?.enter()),
    vscode.commands.registerCommand('aitrace.tab', () => TraceSession.active?.tab()),
    vscode.commands.registerCommand('aitrace.backspace', () => TraceSession.active?.backspace()),
    vscode.commands.registerCommand('aitrace.skipLine', () => TraceSession.active?.skipLine()),
  )
}

export function deactivate(): void {
  TraceSession.active?.dispose()
}
