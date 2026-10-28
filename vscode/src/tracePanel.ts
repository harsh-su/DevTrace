import * as vscode from 'vscode'
import { randomBytes } from 'node:crypto'
import type { SourceLanguage } from '@devtrace/core'

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

/**
 * The dedicated DevTrace surface for AI changes.
 *
 * Instead of ghost-typing over the real editor buffer, the proposed hunk is
 * rendered in a webview beside the editor. The developer types it there and the
 * same `@devtrace/core` engine scores it. On **Save** the host writes exactly
 * what was typed back to the file; on **Discard** (or Esc, or closing the
 * panel) nothing is written.
 *
 * One panel is reused across a queue of staged changes.
 */
export class TracePanel {
  static current: TracePanel | undefined
  /** Set by the extension to mirror progress into the status bar. */
  static onProgress: ((pct: number) => void) | undefined

  private readonly panel: vscode.WebviewPanel
  private readonly disposables: vscode.Disposable[] = []
  private resolver: ((r: TracePanelResult) => void) | undefined
  private pending: PendingInit | null = null
  private ready = false

  private constructor(private readonly extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(
      'devtrace.trace',
      'DevTrace',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
      },
    )
    this.panel.webview.html = this.html(this.panel.webview)
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), undefined, this.disposables)
    this.panel.onDidDispose(() => this.handleDispose(), undefined, this.disposables)
  }

  /** Open (or reuse) the panel and resolve when the developer saves or discards. */
  static show(
    extensionUri: vscode.Uri,
    after: string,
    regions: TraceRegionInit[],
    label: string,
    opts?: { mode?: 'proposal' | 'tour'; brief?: string; language?: SourceLanguage },
  ): Promise<TracePanelResult> {
    const instance = TracePanel.current ?? new TracePanel(extensionUri)
    TracePanel.current = instance
    instance.panel.title = `DevTrace · ${label}`
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
    opts?: { mode?: 'proposal' | 'tour'; brief?: string; language?: SourceLanguage },
  ): Promise<TracePanelResult> {
    return new Promise((resolve) => {
      this.resolver = resolve
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
    })
    this.pending = null
  }

  private onMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const m = message as { type?: string; texts?: unknown; pct?: number; metrics?: TraceMetrics }
    if (m.type === 'ready') {
      this.ready = true
      this.flush()
      return
    }
    if (m.type === 'progress') {
      if (typeof m.pct === 'number') TracePanel.onProgress?.(m.pct)
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

  private settle(result: TracePanelResult): void {
    const r = this.resolver
    this.resolver = undefined
    r?.(result)
  }

  private handleDispose(): void {
    TracePanel.current = undefined
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
