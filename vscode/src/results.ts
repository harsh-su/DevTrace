import * as vscode from 'vscode'
import { showChar, topOffenders, type Metrics, type Trace } from '@aitrace/core'

/** Post-session summary, reusing the same numbers the web tracer computes. */
export class ResultsPanel {
  private static current: ResultsPanel | undefined
  private readonly panel: vscode.WebviewPanel
  private disposed = false

  private constructor() {
    this.panel = vscode.window.createWebviewPanel(
      'aitrace.results',
      'AItrace Results',
      vscode.ViewColumn.Beside,
      { enableScripts: false, retainContextWhenHidden: false },
    )
    this.panel.onDidDispose(() => {
      this.disposed = true
      if (ResultsPanel.current === this) ResultsPanel.current = undefined
    })
  }

  static show(trace: Trace, metrics: Metrics, label: string, completed: boolean): void {
    ResultsPanel.current ??= new ResultsPanel()
    ResultsPanel.current.update(trace, metrics, label, completed)
    ResultsPanel.current.panel.reveal(vscode.ViewColumn.Beside, true)
  }

  private update(trace: Trace, m: Metrics, label: string, completed: boolean): void {
    if (this.disposed) return
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`
    const offenders = topOffenders(trace)
    const chips = offenders
      .map(
        (o) =>
          `<span class="chip"><code>${esc(showChar(o.got))}</code><em>for</em><code class="exp">${esc(
            showChar(o.expected),
          )}</code><b>${o.count}</b></span>`,
      )
      .join('')

    this.panel.webview.html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px 24px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { color: var(--vscode-descriptionForeground); margin: 0 0 20px; font-size: 12px; }
  .banner { padding: 8px 12px; border-radius: 6px; margin-bottom: 16px; font-size: 12px;
    background: var(--vscode-inputValidation-infoBackground); border: 1px solid var(--vscode-inputValidation-infoBorder); }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 22px; }
  .stat { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px 14px; }
  .stat .v { font-size: 24px; font-weight: 700; }
  .stat .k { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .bar { height: 8px; border-radius: 4px; background: var(--vscode-input-background); overflow: hidden; margin: 6px 0 4px; }
  .fill { height: 100%; background: var(--vscode-progressBar-background); }
  .row { display: flex; justify-content: space-between; align-items: baseline; font-size: 13px; margin-top: 18px; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 4px 0 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 12px; }
  .chip em { opacity: .7; font-style: normal; font-size: 10px; }
  .chip code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 4px; }
  .chip b { opacity: .85; }
</style></head>
<body>
  <h1>AItrace session ${completed ? 'complete' : 'ended'}</h1>
  <p class="sub">${esc(label)}</p>
  ${
    completed
      ? ''
      : `<div class="banner">Ended early — only the characters you reached are scored. AI-staged code has been rolled back.</div>`
  }
  <div class="grid">
    <div class="stat"><div class="v">${m.netWpm.toFixed(1)}</div><div class="k">net wpm</div></div>
    <div class="stat"><div class="v">${pct(m.accuracy)}</div><div class="k">accuracy</div></div>
    <div class="stat"><div class="v">${m.errors}</div><div class="k">errors</div></div>
    <div class="stat"><div class="v">${m.rawWpm.toFixed(1)}</div><div class="k">raw wpm</div></div>
    <div class="stat"><div class="v">${pct(m.consistency)}</div><div class="k">consistency</div></div>
    <div class="stat"><div class="v">${m.seconds.toFixed(1)}s</div><div class="k">duration</div></div>
    <div class="stat"><div class="v">${m.backspaces}</div><div class="k">backspaces</div></div>
    <div class="stat"><div class="v">${m.avgIntervalMs.toFixed(0)}ms</div><div class="k">avg key</div></div>
    ${m.skipped > 0 ? `<div class="stat"><div class="v">${m.skipped}</div><div class="k">skipped</div></div>` : ''}
  </div>
  <div class="row"><span>Indentation accuracy</span><span>${pct(m.indentAccuracy)} <em>${m.indentHits}/${m.indentLines} lines</em></span></div>
  <div class="bar"><div class="fill" style="width:${pct(m.indentAccuracy)}"></div></div>
  <p class="hint">Whitespace is where structure fights back. This is the number that moves first.</p>
  ${offenders.length ? `<div class="row">Most-missed keys</div><div class="chips">${chips}</div>` : ''}
</body></html>`
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
}
