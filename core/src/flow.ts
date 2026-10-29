/** A source file supplied to the flow extractor. */
export interface FlowSource {
  path: string
  text: string
}

export type FlowNodeKind = 'file' | 'function' | 'class' | 'external'
export type FlowEdgeKind = 'contains' | 'imports' | 'calls'

export interface FlowNode {
  id: string
  label: string
  path: string
  kind: FlowNodeKind
  line?: number
}

export interface FlowEdge {
  id: string
  from: string
  to: string
  kind: FlowEdgeKind
  label?: string
}

export interface FlowGraph {
  nodes: FlowNode[]
  edges: FlowEdge[]
  files: number
}

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java'])

function extension(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? '' : path.slice(dot)
}

function cleanPath(path: string): string {
  const parts: string[] = []
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

function relativeImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = from.slice(0, Math.max(0, from.lastIndexOf('/')))
  return cleanPath(`${base}/${specifier}`)
}

function lineNumber(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset; i++) if (text[i] === '\n') line++
  return line
}

function symbolMatches(text: string): Array<{ name: string; kind: 'function' | 'class'; offset: number }> {
  const result: Array<{ name: string; kind: 'function' | 'class'; offset: number }> = []
  const re = /\b(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=]*\)?\s*=>/g
  for (const match of text.matchAll(re)) {
    const name = match[1] ?? match[2]
    if (!name) continue
    result.push({ name, kind: match[1] ? (match[0].includes('class') ? 'class' : 'function') : 'function', offset: match.index })
  }
  return result
}

/** Extract a small, predictable call/import graph without a parser dependency. */
export function extractFlowGraph(sources: FlowSource[]): FlowGraph {
  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []
  const byPath = new Map<string, FlowNode>()
  const symbols = new Map<string, FlowNode>()
  const external = new Map<string, FlowNode>()
  const addEdge = (from: string, to: string, kind: FlowEdgeKind, label?: string): void => {
    const id = `${from}->${to}:${kind}:${label ?? ''}`
    if (!edges.some((edge) => edge.id === id)) edges.push({ id, from, to, kind, ...(label ? { label } : {}) })
  }

  for (const source of sources) {
    if (!SOURCE_EXTENSIONS.has(extension(source.path))) continue
    const path = cleanPath(source.path)
    const file: FlowNode = { id: `file:${path}`, label: path.split('/').pop() ?? path, path, kind: 'file' }
    nodes.push(file)
    byPath.set(path, file)
    for (const symbol of symbolMatches(source.text)) {
      const node: FlowNode = {
        id: `symbol:${path}:${symbol.name}`,
        label: symbol.name,
        path,
        kind: symbol.kind,
        line: lineNumber(source.text, symbol.offset),
      }
      nodes.push(node)
      symbols.set(`${path}:${symbol.name}`, node)
      addEdge(file.id, node.id, 'contains')
    }
  }

  for (const source of sources) {
    const path = cleanPath(source.path)
    const file = byPath.get(path)
    if (!file) continue
    const localSymbols = [...symbols.values()].filter((node) => node.path === path)
    const imports = /(?:import\s+(?:[^'";]+?\s+from\s+)?|require\s*\(|from\s+|use\s+)["']([^"']+)["']/g
    for (const match of source.text.matchAll(imports)) {
      const specifier = match[1]
      if (!specifier) continue
      const relative = relativeImport(path, specifier)
      const candidates = relative
        ? [relative, `${relative}.ts`, `${relative}.tsx`, `${relative}.js`, `${relative}.jsx`, `${relative}/index.ts`, `${relative}/index.js`]
        : []
      const target = candidates.map((candidate) => byPath.get(candidate)).find(Boolean)
      let targetNode = target
      if (!targetNode) {
        const id = `external:${specifier}`
        targetNode = external.get(specifier) ?? { id, label: specifier, path: specifier, kind: 'external' }
        if (!external.has(specifier)) {
          external.set(specifier, targetNode)
          nodes.push(targetNode)
        }
      }
      addEdge(file.id, targetNode.id, 'imports', specifier)
    }
    for (const caller of localSymbols) {
      const declarationEnd = source.text.indexOf('\n', (caller.line ?? 1) - 1)
      const body = source.text.slice(Math.max(0, declarationEnd))
      for (const callee of localSymbols) {
        if (caller === callee || !new RegExp(`\\b${callee.label}\\s*\\(`).test(body)) continue
        addEdge(caller.id, callee.id, 'calls')
      }
    }
  }
  return { nodes, edges, files: byPath.size }
}
