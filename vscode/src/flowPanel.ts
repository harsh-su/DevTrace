import * as vscode from 'vscode'
import { randomBytes } from 'node:crypto'
import type { FlowGraph } from '@devtrace/core'

export class FlowPanel {
  private static current: FlowPanel | undefined
  private readonly panel: vscode.WebviewPanel
  private graph: FlowGraph = { nodes: [], edges: [], files: 0 }
  private ready = false

  private constructor(private readonly extensionUri: vscode.Uri, private readonly refresh: () => void) {
    this.panel = vscode.window.createWebviewPanel('devtrace.flow', 'Code flow', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    })
    this.panel.webview.html = this.html(this.panel.webview)
    this.panel.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message.type === 'ready') { this.ready = true; this.send() }
      if (message.type === 'refresh') this.refresh()
    })
    this.panel.onDidDispose(() => { FlowPanel.current = undefined })
  }

  static show(extensionUri: vscode.Uri, graph: FlowGraph, selected?: string, onRefresh: () => void = () => undefined): void {
    const instance = FlowPanel.current ?? new FlowPanel(extensionUri, onRefresh)
    FlowPanel.current = instance
    instance.graph = graph
    instance.panel.reveal(vscode.ViewColumn.Beside, false)
    instance.send(selected)
  }

  static update(graph: FlowGraph): void {
    const instance = FlowPanel.current
    if (!instance) return
    instance.graph = graph
    instance.send()
  }

  private send(selected?: string): void {
    if (this.ready) void this.panel.webview.postMessage({ type: 'graph', graph: this.graph, selected })
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64')
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'flow.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'flow.css'))
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'`
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="${style}"></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`
  }
}
