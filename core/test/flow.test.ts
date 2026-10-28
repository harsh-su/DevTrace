import { extractFlowGraph } from '../src/flow.js'

const graph = extractFlowGraph([
  { path: 'src/main.ts', text: "import { run } from './run'\nexport function run() { return 1 }\nexport function main() { run() }" },
  { path: 'src/run.ts', text: 'export function run() { return 1 }' },
])

const ok = (label: string, value: boolean) => {
  if (!value) throw new Error(`FAIL ${label}`)
  console.log(`ok ${label}`)
}

ok('indexes files', graph.files === 2)
ok('resolves relative imports', graph.edges.some((edge) => edge.kind === 'imports' && edge.to === 'file:src/run.ts'))
ok('extracts declarations', graph.nodes.some((node) => node.id === 'symbol:src/main.ts:main'))
ok('extracts calls', graph.edges.some((edge) => edge.kind === 'calls' && edge.to === 'symbol:src/main.ts:run'))
ok('ignores unsupported files', extractFlowGraph([{ path: 'README.md', text: 'function nope() {}' }]).files === 0)
