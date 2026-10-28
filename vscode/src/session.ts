import * as vscode from 'vscode'
import {
  SKIPPED,
  advanceSkipped,
  WRONG,
  backspace as coreBackspace,
  createTrace,
  finalizeAll,
  isComplete,
  languageId,
  markSkipped,
  skipRuns,
  metrics as coreMetrics,
  press as corePress,
  resolveEdit,
  showChar,
  skipLine as coreSkipLine,
  tabFill,
  type Metrics,
  type SpanDiff,
  type Trace,
} from '@devtrace/core'

/**
 * A native trace session.
 *
 * The trick that makes this work inside a real editor: the document under the
 * trace is kept **immutable**. It always equals the target text. Every keystroke
 * is treated as an intent, fed to the core engine, and then the resulting edit
 * is reverted — so the source characters are never destroyed. Untyped characters
 * are rendered as dim ghost text; typed-correct characters look normal; a wrong
 * character keeps the source glyph and gets a red mark plus an annotation of the
 * key you actually pressed. This mirrors the web tracer's rendering contract
 * exactly, and it means auto-closing brackets and auto-indent can never corrupt
 * the session: whatever the editor inserts gets reverted.
 */

let ghostType: vscode.TextEditorDecorationType | undefined
let wrongType: vscode.TextEditorDecorationType | undefined
let annotType: vscode.TextEditorDecorationType | undefined
let currentType: vscode.TextEditorDecorationType | undefined
let skipType: vscode.TextEditorDecorationType | undefined

function decorationTypes(): {
  ghost: vscode.TextEditorDecorationType
  wrong: vscode.TextEditorDecorationType
  annot: vscode.TextEditorDecorationType
  current: vscode.TextEditorDecorationType
  skip: vscode.TextEditorDecorationType
} {
  ghostType ??= vscode.window.createTextEditorDecorationType({
    opacity: '0.45',
    fontStyle: 'italic',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })
  wrongType ??= vscode.window.createTextEditorDecorationType({
    textDecoration: 'underline wavy',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })
  annotType ??= vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 0.35em',
      color: new vscode.ThemeColor('errorForeground'),
      fontStyle: 'italic',
    },
  })
  currentType ??= vscode.window.createTextEditorDecorationType({
    border: '1px solid',
    borderColor: new vscode.ThemeColor('focusBorder'),
    borderRadius: '2px',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })
  skipType ??= vscode.window.createTextEditorDecorationType({
    opacity: '0.4',
    textDecoration: 'underline dotted',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })
  return { ghost: ghostType, wrong: wrongType, annot: annotType, current: currentType, skip: skipType }
}

let channel: vscode.OutputChannel | undefined

/** Opt-in diagnostics (`devtrace.debug`). Never throws. */
function log(message: string): void {
  try {
    if (!vscode.workspace.getConfiguration('devtrace').get<boolean>('debug', false)) return
    channel ??= vscode.window.createOutputChannel('DevTrace')
    channel.appendLine(`[${new Date().toISOString()}] ${message}`)
  } catch {
    /* logging must never break a session */
  }
}

export interface SessionHooks {
  /** Fired after every processed keystroke so the host can update UI. */
  onProgress?: (trace: Trace) => void
  /** Fired once when the session ends via `finish`. */
  onFinish?: (trace: Trace, metrics: Metrics, completed: boolean) => void
}

export interface StartOptions {
  /** The text the user will type. */
  target: string
  /** Region of the document the target occupies. */
  range: vscode.Range
  /**
   * When true the target is written into `range` before the session starts
   * (used for AI changes, where the document still holds the old text). When
   * false the range already contains the target (tracing existing code).
   */
  replace: boolean
  hooks?: SessionHooks
}

export class TraceSession implements vscode.Disposable {
  static active: TraceSession | undefined

  private readonly trace: Trace
  private readonly disposables: vscode.Disposable[] = []
  /** The in-memory target with the session's frozen layout. Never mutated. */
  private baseText: string
  private regionStart: number
  private disposed = false
  /** True while we are applying our own reversal edit, so we ignore its event. */
  private applying = false
  /** The text that was in the region before an AI change was staged, for abort. */
  private readonly originalRegion: string
  private readonly hadReplaced: boolean
  private readonly label: string
  private readonly hooks: SessionHooks

  private constructor(
    private readonly editor: vscode.TextEditor,
    target: string,
    regionStart: number,
    baseText: string,
    originalRegion: string,
    hadReplaced: boolean,
    label: string,
    hooks: SessionHooks,
  ) {
    this.trace = createTrace(target)
    for (const run of skipRuns(target, languageId(editor.document.fileName))) {
      markSkipped(this.trace, run.start, run.end)
    }
    advanceSkipped(this.trace)
    this.regionStart = regionStart
    this.baseText = baseText
    this.originalRegion = originalRegion
    this.hadReplaced = hadReplaced
    this.label = label
    this.hooks = hooks

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
    )

    TraceSession.active = this
    void vscode.commands.executeCommand('setContext', 'devtrace.tracing', true)
    this.moveCaret()
    this.render()
  }

  static async start(editor: vscode.TextEditor, opts: StartOptions): Promise<TraceSession> {
    const doc = editor.document
    const originalRegion = doc.getText(opts.range)
    const hadReplaced = opts.replace && originalRegion !== opts.target

    if (hadReplaced) {
      const edit = new vscode.WorkspaceEdit()
      edit.replace(doc.uri, opts.range, opts.target)
      await vscode.workspace.applyEdit(edit)
    }

    const regionStart = doc.offsetAt(opts.range.start)
    const label = `${vscode.workspace.asRelativePath(doc.uri)} · ${opts.target.length} chars`
    const session = new TraceSession(
      editor,
      opts.target,
      regionStart,
      doc.getText(),
      originalRegion,
      hadReplaced,
      label,
      opts.hooks ?? {},
    )
    return session
  }

  get text(): Trace {
    return this.trace
  }

  // --- input -----------------------------------------------------------------

  private onChange(e: vscode.TextDocumentChangeEvent): void {
    if (this.disposed) return
    if (e.document !== this.editor.document) return

    const base = this.baseText
    const now = e.document.getText()
    // Our own reversal edit (or a no-op) leaves the document identical to base.
    // This check — rather than an async flag — is what makes the loop safe.
    if (now === base) return

    const t = this.trace
    const expected = this.regionStart + t.cursor
    const insertions = e.contentChanges.map((c) => ({
      offset: c.rangeOffset ?? (c.range ? e.document.offsetAt(c.range.start) : -1),
      text: c.text,
    }))

    const { typed, restore } = resolveEdit(base, now, insertions, expected)

      if (typed !== undefined) {
        for (const ch of typed) {
          advanceSkipped(t)
          if (isComplete(t)) break
        corePress(t, ch, performance.now())
      }
      log(`typed "${typed}" @${expected} -> cursor ${t.cursor}`)
    } else {
      log(`ignored edit: expected=${expected} -"${restore.baseChanged}" +"${restore.nowChanged}"`)
    }

    // The document must always return to the frozen target.
    this.restore(restore)
    this.moveCaret()
    this.render()

    if (isComplete(t)) this.complete()
  }

  /** Reverse the user's edit so the document stays equal to the target. */
  private restore(diff: SpanDiff): void {
    const doc = this.editor.document
    const edit = new vscode.WorkspaceEdit()
    const from = doc.positionAt(diff.prefix)
    const to = doc.positionAt(diff.prefix + diff.nowChanged.length)
    edit.replace(doc.uri, new vscode.Range(from, to), diff.baseChanged)

    this.applying = true
    void Promise.resolve(vscode.workspace.applyEdit(edit)).finally(() => {
      this.applying = false
    })
  }

  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    if (this.disposed || this.applying) return
    if (e.textEditor !== this.editor) return
    this.moveCaret()
  }

  // --- special keys (bound by the host so the editor never inserts anything) --

  enter(): void {
    this.feed('\n', 'newline')
  }

  tab(): void {
    const t = this.trace
    advanceSkipped(t)
    if (isComplete(t)) return
    const line = t.doc.lineOf[t.cursor] as number
    const lineStart = t.doc.lineStarts[line] as number
    const soFar = t.doc.text.slice(lineStart, t.cursor)
    const now = performance.now()
    for (const ch of tabFill(soFar)) {
      if (isComplete(t)) break
      corePress(t, ch, now, 'tab')
    }
    this.afterFeed()
  }

  backspace(): void {
    if (this.disposed) return
    coreBackspace(this.trace, performance.now())
    advanceSkipped(this.trace)
    this.moveCaret()
    this.render()
    this.hooks.onProgress?.(this.trace)
  }

  /** Accept the current line's source text untouched and move to the next one. */
  skipLine(): void {
    if (this.disposed || isComplete(this.trace)) return
    coreSkipLine(this.trace, performance.now())
    this.afterFeed()
  }

  private feed(ch: string, kind: 'type' | 'newline'): void {
    if (this.disposed || isComplete(this.trace)) return
    advanceSkipped(this.trace)
    corePress(this.trace, ch, performance.now(), kind)
    this.afterFeed()
  }

  private afterFeed(): void {
    advanceSkipped(this.trace)
    this.moveCaret()
    this.render()
    if (isComplete(this.trace)) this.complete()
  }

  // --- rendering -------------------------------------------------------------

  private moveCaret(): void {
    if (this.disposed) return
    const pos = this.editor.document.positionAt(this.regionStart + this.trace.cursor)
    const cur = this.editor.selection.active
    // Assigning the selection fires the event, so only assign when it moved.
    if (!cur.isEqual(pos)) {
      this.editor.selection = new vscode.Selection(pos, pos)
    }
    this.editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }

  private render(): void {
    if (this.disposed) return
    const t = this.trace
    const doc = this.editor.document
    const base = this.regionStart
    const types = decorationTypes()
    const end = t.doc.text.length

    const ghost: vscode.Range[] = []
    const current: vscode.Range[] = []
    const wrong: vscode.Range[] = []
    const skip: vscode.Range[] = []
    const annot: vscode.DecorationOptions[] = []

    if (t.cursor < end) {
      ghost.push(new vscode.Range(doc.positionAt(base + t.cursor), doc.positionAt(base + end)))
      current.push(new vscode.Range(doc.positionAt(base + t.cursor), doc.positionAt(base + t.cursor + 1)))
    }

    for (let i = 0; i < t.states.length; i++) {
      if (t.states[i] !== WRONG) continue
      const ch = t.doc.text[i]
      if (ch === '\n') continue // a wrong newline shows only as the caret moving on
      const range = new vscode.Range(doc.positionAt(base + i), doc.positionAt(base + i + 1))
      wrong.push(range)
      const got = t.wrongAt.get(i)
      if (got !== undefined) {
        annot.push({
          range,
          renderOptions: { after: { contentText: ` ${showChar(got)}` } },
        })
      }
    }

    // Skipped runs are contiguous by construction (a skip consumes a whole
    // line), so one range per stretch keeps the decoration count low.
    let s = -1
    for (let i = 0; i <= t.states.length; i++) {
      const on = i < t.states.length && t.states[i] === SKIPPED && t.doc.text[i] !== '\n'
      if (on && s < 0) s = i
      else if (!on && s >= 0) {
        skip.push(new vscode.Range(doc.positionAt(base + s), doc.positionAt(base + i)))
        s = -1
      }
    }

    this.editor.setDecorations(types.ghost, ghost)
    this.editor.setDecorations(types.current, current)
    this.editor.setDecorations(types.wrong, wrong)
    this.editor.setDecorations(types.annot, annot)
    this.editor.setDecorations(types.skip, skip)
    this.hooks.onProgress?.(t)
  }

  // --- lifecycle -------------------------------------------------------------

  private complete(): void {
    finalizeAll(this.trace)
    const m = coreMetrics(this.trace)
    this.hooks.onFinish?.(this.trace, m, true)
    this.dispose()
  }

  /** End early. AI-staged changes are rolled back to the original text. */
  abort(): void {
    if (this.disposed) return
    if (this.trace.keystrokes.length > 0) {
      finalizeAll(this.trace)
      const m = coreMetrics(this.trace)
      this.hooks.onFinish?.(this.trace, m, false)
    }
    if (this.hadReplaced) void this.restoreOriginal()
    this.dispose()
  }

  private async restoreOriginal(): Promise<void> {
    const doc = this.editor.document
    const range = new vscode.Range(
      doc.positionAt(this.regionStart),
      doc.positionAt(this.regionStart + this.trace.doc.text.length),
    )
    const edit = new vscode.WorkspaceEdit()
    edit.replace(doc.uri, range, this.originalRegion)
    await vscode.workspace.applyEdit(edit)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const types = decorationTypes()
    this.editor.setDecorations(types.ghost, [])
    this.editor.setDecorations(types.current, [])
    this.editor.setDecorations(types.wrong, [])
    this.editor.setDecorations(types.annot, [])
    this.editor.setDecorations(types.skip, [])
    for (const d of this.disposables) d.dispose()
    if (TraceSession.active === this) TraceSession.active = undefined
    void vscode.commands.executeCommand('setContext', 'devtrace.tracing', false)
  }

  get sessionLabel(): string {
    return this.label
  }
}
