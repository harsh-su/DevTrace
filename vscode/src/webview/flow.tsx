import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { FlowGraph } from '@devtrace/core'
import '../../../ui/src/styles.css'
import './flow.css'

declare function acquireVsCodeApi(): { postMessage(message: unknown): void }
const vscode = acquireVsCodeApi()

function App() {
  const [graph, setGraph] = useState<FlowGraph>({ nodes: [], edges: [], files: 0 })
  const [selected, setSelected] = useState('')
  useEffect(() => {
    const receive = (event: MessageEvent<{ type?: string; graph?: FlowGraph; selected?: string }>) => {
      if (event.data.type === 'graph' && event.data.graph) { setGraph(event.data.graph); if (event.data.selected) setSelected(event.data.selected) }
    }
    window.addEventListener('message', receive)
    vscode.postMessage({ type: 'ready' })
    return () => window.removeEventListener('message', receive)
  }, [])
  const files = graph.nodes.filter((node) => node.kind === 'file')
  const focused = graph.nodes.find((node) => node.id === selected)
  const focusedEdges = focused
    ? graph.edges.filter((edge) => edge.from === focused.id || edge.to === focused.id)
    : graph.edges
  const nodeLabel = (id: string) => graph.nodes.find((node) => node.id === id)?.label ?? id
  return <main className="flow-page">
    <header className="flow-header"><div><strong>Code flow</strong><span>{graph.files} files · {graph.edges.length} relationships</span></div><button onClick={() => vscode.postMessage({ type: 'refresh' })}>Refresh</button></header>
    {graph.nodes.length === 0 ? <div className="empty">No supported source files found in this workspace.</div> : <section className="flow-graph">
      {files.map((file) => <article className={`flow-file${selected === file.id ? ' selected' : ''}`} key={file.id}>
        <button className="flow-node" onClick={() => setSelected(file.id)}><b>{file.label}</b><small>{file.path}</small></button>
        {graph.nodes.filter((node) => node.path === file.path && node.kind !== 'file').map((node) => <button className={`flow-symbol${selected === node.id ? ' selected' : ''}`} key={node.id} onClick={() => setSelected(node.id)}>{node.label}<small>{node.kind} · line {node.line}</small></button>)}
      </article>)}
      <article className="flow-edges">
        <div className="flow-edge-title">{focused ? `Flow around ${focused.label}` : 'Relationships'}</div>
        {focused && <div className="flow-focus-summary">
          <strong>{focused.label}</strong>
          <span>{focused.path}{focused.line ? `:${focused.line}` : ''}</span>
          <small>{focusedEdges.filter((edge) => edge.to === focused.id).length} incoming · {focusedEdges.filter((edge) => edge.from === focused.id).length} outgoing</small>
        </div>}
        {focusedEdges.map((edge) => <div className="flow-edge" key={edge.id}>
          <code>{nodeLabel(edge.from)}</code>
          <span className={`edge-kind ${edge.kind}`}>{edge.kind}</span>
          <code>{nodeLabel(edge.to)}</code>
          {edge.label && <small>{edge.label}</small>}
        </div>)}
        {focused && focusedEdges.length === 0 && <div className="empty">No recorded callers or callees for this node.</div>}
      </article>
    </section>}
    <footer className="flow-footer">{selected ? `Selected: ${graph.nodes.find((node) => node.id === selected)?.label ?? selected}` : 'Select a file or symbol to inspect it'}</footer>
  </main>
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
