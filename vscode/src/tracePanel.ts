import * as vscode from 'vscode'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import {
  applyHunksUpTo,
  detectRunSpec,
  stepRunSource,
  type Hunk,
  type RunLanguage,
  type SourceLanguage,
} from '@aitrace/core'
import { resolveModuleType, startRun, type RunHandle, type RunPhase, type RunStream } from './runner.js'

/** One changed hunk of the file, located in the proposed `after` text. */
export interface TraceRegionInit {
  /** Offset in `after` where this hunk's new text begins. */
  start: number
  /** The text to type for this hunk (empty for a pure deletion). */
  target: string
}

export interface TracePanelResult {
  action: 'save' | 'discard'
  /** What was typed for each region, aligned with the regions sent in. */
  typedTexts: string[]
  /** Net WPM / accuracy of the session, when the webview reported them. */
  metrics?: { netWpm: number; accuracy: number }
}

export interface TraceRunContext {
  /** Absolute path of the file being traced. */
  file: string
  /** Current file text the run is applied to. */
  baseText: string
  /** Proposal mode: hunks between the base text and the proposed text. */
  hunks?: Hunk[]
  /** Tour mode: the 1-based start and length of the step. */
  step?: { start: number; lines: number }
}

interface PendingInit {
  after: string
  label: string
  regions: TraceRegionInit[]
  mode?: 'proposal' | 'tour'
  brief?: string
  language?: SourceLanguage
}

interface TraceMetrics {
  netWpm?: number
  accuracy?: number
}

type RunKind = 'stdin' | 'compile' | 'custom'

interface RunAvailability {
  canRun: boolean
  kind?: RunKind
  language?: RunLanguage | 'custom'
}

/**
 * The dedicated AItrace surface for AI changes.
 *
 * Instead of ghost-typing over the real editor buffer, the proposed hunk is
 * rendered in a webview beside the editor. The developer types it there and the
 * same `@aitrace/core` engine scores it. On **Save** the host writes exactly
 * what was typed back to the file; on **Discard** (or Esc, or closing the
 * panel) nothing is written.
 *
 * One panel is reused across a queue of staged changes.
 */
export class TracePanel {
  static current: TracePanel | undefined
  /** Set by the extension to mirror progress into the status bar. */
  static onProgress: ((pct: number) => void) | undefined
  /** Set by the extension. Resolves true once the workspace has consented. */
  static runConsent: (() => Promise<boolean>) | undefined

  private readonly panel: vscode.WebviewPanel
  private readonly disposables: vscode.Disposable[] = []
  private resolver: ((r: TracePanelResult) => void) | undefined
  private pending: PendingInit | null = null
  private runContext: TraceRunContext | null = null
  private activeRun: RunHandle | undefined
  private activeRunId: string | undefined
  private ready = false

  private constructor(private readonly extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(
      'aitrace.trace',
      'AItrace',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
      },
    )
    this.panel.webview.html = this.html(this.panel.webview)
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), undefined, this.disposables)
    this.panel.onDidDispose(() => this.handleDispose(), undefined, this.disposables)
  }

  /** Open (or reuse) the panel and resolve when the developer saves or discards. */
  static show(
    extensionUri: vscode.Uri,
    after: string,
    regions: TraceRegionInit[],
    label: string,
    opts?: {
      mode?: 'proposal' | 'tour'
      brief?: string
      language?: SourceLanguage
      run?: TraceRunContext
    },
  ): Promise<TracePanelResult> {
    const instance = TracePanel.current ?? new TracePanel(extensionUri)
    TracePanel.current = instance
    instance.panel.title = `AItrace · ${label}`
    instance.panel.reveal(vscode.ViewColumn.Beside, false)
    return instance.begin(after, label, regions, opts)
  }

  /** Cancel any in-flight request without writing. */
  static discardActive(): void {
    TracePanel.current?.settle({ action: 'discard', typedTexts: [] })
  }

  private begin(
    after: string,
    label: string,
    regions: TraceRegionInit[],
    opts?: {
      mode?: 'proposal' | 'tour'
      brief?: string
      language?: SourceLanguage
      run?: TraceRunContext
    },
  ): Promise<TracePanelResult> {
    return new Promise((resolve) => {
      this.cancelRun()
      this.resolver = resolve
      this.runContext = opts?.run ?? null
      this.pending = { after, label, regions, mode: opts?.mode, brief: opts?.brief, language: opts?.language }
      this.flush()
    })
  }

  private flush(): void {
    if (!this.ready || !this.pending) return
    void this.panel.webview.postMessage({
      type: 'init',
      after: this.pending.after,
      label: this.pending.label,
      regions: this.pending.regions,
      mode: this.pending.mode,
      brief: this.pending.brief,
      language: this.pending.language,
      fileName: this.runContext?.file,
      run: this.runAvailability(),
    })
    this.pending = null
  }

  private runAvailability(): RunAvailability | undefined {
    if (!this.runContext) return undefined
    const cfg = vscode.workspace.getConfiguration('aitrace', vscode.Uri.file(this.runContext.file))
    const override = cfg.get<string>('run.command', '').trim()
    if (override) return { canRun: true, kind: 'custom', language: 'custom' }
    const spec = detectRunSpec(this.runContext.file, {
      python: cfg.get<string>('run.python', 'python3'),
      node: cfg.get<string>('run.node', 'node'),
      tsx: cfg.get<string>('run.tsx', 'tsx'),
      rustc: cfg.get<string>('run.rustc', 'rustc'),
      cpp: cfg.get<string>('run.cpp', 'c++'),
      rustEdition: cfg.get<string>('run.rustEdition', '2021'),
      cppStandard: cfg.get<string>('run.cppStandard', 'c++17'),
      exeSuffix: process.platform === 'win32' ? '.exe' : '',
    })
    if (!spec) return { canRun: false }
    return { canRun: true, kind: spec.kind, language: spec.language }
  }

  private async onMessage(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) return
    const m = message as {
      type?: string
      texts?: unknown
      pct?: number
      metrics?: TraceMetrics
      runId?: string
      upTo?: number
      scope?: string
    }
    if (m.type === 'ready') {
      this.ready = true
      this.flush()
      return
    }
    if (m.type === 'progress') {
      if (typeof m.pct === 'number') TracePanel.onProgress?.(m.pct)
      return
    }
    if (m.type === 'run') {
      await this.handleRun(m)
      return
    }
    if (m.type === 'runCancel') {
      if (!m.runId || m.runId === this.activeRunId) this.cancelRun()
      return
    }
    if (m.type === 'save') {
      const texts = Array.isArray(m.texts) ? m.texts.filter((x): x is string => typeof x === 'string') : []
      const metrics =
        m.metrics && typeof m.metrics === 'object'
          ? {
              netWpm: typeof m.metrics.netWpm === 'number' ? m.metrics.netWpm : 0,
              accuracy: typeof m.metrics.accuracy === 'number' ? m.metrics.accuracy : 0,
            }
          : undefined
      this.settle({ action: 'save', typedTexts: texts, metrics })
      return
    }
    if (m.type === 'discard') {
      this.settle({ action: 'discard', typedTexts: [] })
    }
  }

  private async handleRun(m: { texts?: unknown; upTo?: number; scope?: string }): Promise<void> {
    const runId = randomBytes(8).toString('hex')
    const context = this.runContext
    if (!context) {
      this.postRunError(runId, 'There is no runnable file for this trace.')
      return
    }
    if (this.activeRun) {
      this.postRunError(runId, 'A run is already in progress. Stop it before starting another.')
      return
    }

    const uri = vscode.Uri.file(context.file)
    const cfg = vscode.workspace.getConfiguration('aitrace', uri)
    const override = cfg.get<string>('run.command', '').trim()
    const moduleType = await resolveModuleType(context.file)
    const spec = detectRunSpec(context.file, {
      python: cfg.get<string>('run.python', 'python3'),
      node: cfg.get<string>('run.node', 'node'),
      tsx: cfg.get<string>('run.tsx', 'tsx'),
      rustc: cfg.get<string>('run.rustc', 'rustc'),
      cpp: cfg.get<string>('run.cpp', 'c++'),
      rustEdition: cfg.get<string>('run.rustEdition', '2021'),
      cppStandard: cfg.get<string>('run.cppStandard', 'c++17'),
      moduleType,
      exeSuffix: process.platform === 'win32' ? '.exe' : '',
    })

    if (!override && !spec) {
      this.postRunError(
        runId,
        `AItrace cannot run ${vscode.workspace.asRelativePath(uri, false)}. Configure aitrace.run.command to provide a command.`,
      )
      return
    }

    if (TracePanel.runConsent) {
      const allowed = await TracePanel.runConsent()
      if (!allowed) {
        this.postRunError(runId, 'Run cancelled.')
        return
      }
    }

    const source = this.buildSource(context, m)
    const command = override || (spec ? [spec.command, ...spec.args].join(' ') : '')
    const language = override ? 'custom' : spec?.language
    const kind: RunKind = override ? 'custom' : (spec?.kind ?? 'stdin')
    const phase: RunPhase = kind === 'compile' ? 'build' : 'run'

    void this.panel.webview.postMessage({
      type: 'runStarted',
      runId,
      command,
      cwd: dirname(context.file),
      language,
      runKind: kind,
      phase,
    })

    const handle = startRun({
      source,
      filePath: context.file,
      spec,
      commandOverride: override || undefined,
      timeoutMs: cfg.get<number>('run.timeoutMs', 15000),
      onPhase: (next: RunPhase) => {
        void this.panel.webview.postMessage({ type: 'runPhase', runId, phase: next })
      },
      onOutput: (stream: RunStream, chunk: string) => {
        void this.panel.webview.postMessage({ type: 'runOutput', runId, stream, chunk })
      },
    })
    this.activeRun = handle
    this.activeRunId = runId

    try {
      const result = await handle.result
      if (this.activeRun === handle) {
        this.activeRun = undefined
        this.activeRunId = undefined
      }
      if (result.spawnError) {
        this.postRunError(runId, this.spawnMessage(command, result.spawnError), result.failedPhase)
        return
      }
      void this.panel.webview.postMessage({
        type: 'runDone',
        runId,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        truncated: result.truncated,
        failedPhase: result.failedPhase,
      })
    } catch (err) {
      this.postRunError(runId, (err as Error).message)
    }
  }

  private buildSource(
    context: TraceRunContext,
    m: { texts?: unknown; upTo?: number; scope?: string },
  ): string {
    if (context.step) {
      return m.scope === 'file'
        ? context.baseText
        : stepRunSource(context.baseText, context.step.start, context.step.lines)
    }
    const hunks = context.hunks ?? []
    const upTo =
      typeof m.upTo === 'number'
        ? Math.max(-1, Math.min(Math.floor(m.upTo), hunks.length - 1))
        : hunks.length - 1
    const texts = Array.isArray(m.texts)
      ? m.texts.filter((x): x is string => typeof x === 'string')
      : []
    return applyHunksUpTo(context.baseText, hunks, texts, upTo)
  }

  private spawnMessage(command: string, detail: string): string {
    const name = command.trim().split(/\s+/)[0] ?? command
    return `Could not start ${name}: ${detail}. Check that it is installed and on PATH, or configure the matching aitrace.run setting.`
  }

  private postRunError(runId: string, message: string, phase?: RunPhase): void {
    void this.panel.webview.postMessage({ type: 'runError', runId, message, phase })
  }

  private cancelRun(): void {
    this.activeRun?.cancel()
    this.activeRun = undefined
    this.activeRunId = undefined
  }

  private settle(result: TracePanelResult): void {
    this.cancelRun()
    const r = this.resolver
    this.resolver = undefined
    r?.(result)
  }

  private handleDispose(): void {
    TracePanel.current = undefined
    this.cancelRun()
    this.settle({ action: 'discard', typedTexts: [] })
    for (const d of this.disposables) d.dispose()
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64')
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'))
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ')

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${style}" />
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`
  }
}
