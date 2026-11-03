import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AItracePlugin from '../src/index.js'

let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  if (!cond) {
    failures++
    console.log(`  FAIL  ${label} ${detail}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}

interface Staged {
  id: string
  ts: number
  tool: string
  file: string
  before: string
  after: string
}

/** A fresh worktree with staging on, plus a helper to run the plugin's stage hook. */
async function setup(file: string, contents: string) {
  const root = await mkdtemp(join(tmpdir(), 'aitrace-plugin-'))
  await mkdir(join(root, '.aitrace', 'pending'), { recursive: true })
  await writeFile(join(root, file), contents, 'utf8')
  const plugin = await AItracePlugin({ directory: root, worktree: root })
  const stage = plugin['tool.execute.before'] as (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: Record<string, unknown> },
  ) => Promise<void>
  const run = async (tool: string, args: Record<string, unknown>) => {
    try {
      await stage({ tool, sessionID: 's', callID: 'c' }, { args })
    } catch {
      // staging blocks the tool by throwing; expected
    }
  }
  const pending = async (): Promise<Staged[]> => {
    const dir = join(root, '.aitrace', 'pending')
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()
    return Promise.all(
      names.map(async (n) => JSON.parse(await readFile(join(dir, n), 'utf8')) as Staged),
    )
  }
  return { root, run, pending, cleanup: () => rm(root, { recursive: true, force: true }) }
}

console.log('\nsame-file edits stay as separate pending records')

{
  const t = await setup('a.ts', 'const a = 1\nconst b = 2\n')
  await t.run('edit', { filePath: 'a.ts', oldString: 'const a = 1', newString: 'const a = 10' })
  await t.run('edit', { filePath: 'a.ts', oldString: 'const b = 2', newString: 'const b = 20' })
  const records = await t.pending()
  ok('two records for two edits', records.length === 2, `got ${records.length}`)
  ok('first edit is isolated', records.some((r) => r.after === 'const a = 10\nconst b = 2\n'))
  ok(
    'second edit composes on staged text',
    records.some((r) => r.after === 'const a = 10\nconst b = 20\n'),
    `got ${JSON.stringify(records.map((r) => r.after))}`,
  )
  ok('each before stays the committed text', records.every((r) => r.before === 'const a = 1\nconst b = 2\n'))
  await t.cleanup()
}

console.log('\ndependent edits compose on top of the pending text')

{
  const t = await setup('b.ts', 'let x = 0\n')
  await t.run('edit', { filePath: 'b.ts', oldString: 'let x = 0', newString: 'let x = 1' })
  // References text that only exists in the staged (not yet written) version.
  await t.run('edit', { filePath: 'b.ts', oldString: 'let x = 1', newString: 'let x = 2' })
  const records = await t.pending()
  ok('two records', records.length === 2, `got ${records.length}`)
  ok('dependent edit applied', records.some((r) => r.after === 'let x = 2\n'), `got ${JSON.stringify(records.map((r) => r.after))}`)
  await t.cleanup()
}

console.log('\ndifferent files stay separate')

{
  const t = await setup('c.ts', 'c\n')
  await writeFile(join(t.root, 'd.ts'), 'd\n', 'utf8')
  await t.run('edit', { filePath: 'c.ts', oldString: 'c', newString: 'cc' })
  await t.run('edit', { filePath: 'd.ts', oldString: 'd', newString: 'dd' })
  const records = await t.pending()
  ok('two records', records.length === 2, `got ${records.length}`)
  await t.cleanup()
}

console.log('\na write replaces the staged file')

{
  const t = await setup('e.ts', 'one\n')
  await t.run('edit', { filePath: 'e.ts', oldString: 'one', newString: 'two' })
  await t.run('write', { filePath: 'e.ts', content: 'three\n' })
  const records = await t.pending()
  ok('two records', records.length === 2, `got ${records.length}`)
  ok('write is its own change', records.some((r) => r.after === 'three\n'), `got ${JSON.stringify(records.map((r) => r.after))}`)
  await t.cleanup()
}

console.log('\nno-op edit stages nothing')

{
  const t = await setup('f.ts', 'same\n')
  await t.run('edit', { filePath: 'f.ts', oldString: 'same', newString: 'same' })
  const records = await t.pending()
  ok('no record', records.length === 0, `got ${records.length}`)
  ok('no stray temp file', !existsSync(join(t.root, '.aitrace', 'pending', 'tmp')))
  await t.cleanup()
}

console.log('\nbookkeeping inside .aitrace/ passes through unstaged')

{
  const t = await setup('g.ts', 'g\n')
  const tour = { title: 'Learn', goal: 'understand', steps: [] }
  await t.run('write', { filePath: '.aitrace/tour.json', content: JSON.stringify(tour) })
  await t.run('edit', {
    filePath: join(t.root, '.aitrace', 'tour-progress.json'),
    oldString: '{}',
    newString: '{"steps":{}}',
  })
  const records = await t.pending()
  ok('neither write was staged', records.length === 0, `got ${records.length}`)
  await t.cleanup()
}

console.log(failures === 0 ? '\nAll bridge checks passed.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
