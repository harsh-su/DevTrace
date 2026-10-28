import * as vscode from 'vscode'
import { extractFlowGraph, type FlowGraph, type FlowNode } from '@devtrace/core'

const ignored = '**/{node_modules,.git,dist,build,out,.next,coverage}/**'
const supported = '**/*.{js,jsx,ts,tsx,mjs,cjs,py,go,rs,java}'

export class FlowIndex implements vscode.Disposable {
  private graph: FlowGraph = { nodes: [], edges: [], files: 0 }
  private readonly emitter = new vscode.EventEmitter<FlowGraph>()
  readonly onDidChange = this.emitter.event

  async scan(): Promise<void> {
    const files = await vscode.workspace.findFiles(supported, ignored)
    const sources = await Promise.all(files.map(async (uri) => ({
      path: vscode.workspace.asRelativePath(uri, false),
      text: (await vscode.workspace.openTextDocument(uri)).getText(),
    })))
    this.graph = extractFlowGraph(sources)
    this.emitter.fire(this.graph)
  }

  getGraph(): FlowGraph { return this.graph }

  node(id: string): FlowNode | undefined { return this.graph.nodes.find((node) => node.id === id) }

  dispose(): void { this.emitter.dispose() }
}

export class FlowItem extends vscode.TreeItem {
  constructor(readonly node: FlowNode, collapsible = vscode.TreeItemCollapsibleState.None) {
    super(node.label, collapsible)
    this.id = node.id
    this.contextValue = 'devtrace.flow.node'
    this.description = node.kind === 'file' ? node.path : `${node.kind} · line ${node.line ?? '?'}`
    this.iconPath = new vscode.ThemeIcon(node.kind === 'file' ? 'file-code' : node.kind === 'class' ? 'symbol-class' : 'symbol-function')
    this.tooltip = `${node.path}${node.line ? `:${node.line}` : ''}`
    this.command = { command: 'devtrace.flow.open', title: 'Open code flow', arguments: [node.id] }
  }
}

export class FlowTreeProvider implements vscode.TreeDataProvider<FlowItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<FlowItem | undefined | void>()
  readonly onDidChangeTreeData = this.emitter.event

  constructor(private readonly index: FlowIndex) { index.onDidChange(() => this.emitter.fire()) }
  refresh(): void { void this.index.scan() }
  getTreeItem(element: FlowItem): vscode.TreeItem { return element }
  getChildren(element?: FlowItem): FlowItem[] {
    const graph = this.index.getGraph()
    if (!element) return graph.nodes.filter((node) => node.kind === 'file').map((node) => new FlowItem(node, vscode.TreeItemCollapsibleState.Collapsed))
    if (element.node.kind !== 'file') return []
    return graph.nodes.filter((node) => node.path === element.node.path && node.kind !== 'file').map((node) => new FlowItem(node))
  }
  dispose(): void { this.emitter.dispose() }
}
