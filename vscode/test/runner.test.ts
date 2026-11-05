import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectRunSpec } from '@aitrace/core'
import { startRun } from '../src/runner.js'

let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  if (!cond) {
    failures++
    console.log(`  FAIL  ${label} ${detail}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}

function available(command: string, args: string[] = ['--version']): boolean {
  const probe = spawnSync(command, args, { stdio: 'ignore' })
  return probe.status === 0
}

async function runSnippet(
  fileName: string,
  source: string,
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; cancelled: boolean }> {
  const spec = detectRunSpec(fileName)
  if (!spec) throw new Error(`no run spec for ${fileName}`)
  const stdout: string[] = []
  const stderr: string[] = []
  const handle = startRun({
    source,
    filePath: join(tmpdir(), fileName),
    spec,
    timeoutMs,
    onOutput: (stream, chunk) => (stream === 'stdout' ? stdout : stderr).push(chunk),
  })
  const result = await handle.result
  return {
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
  }
}

async function main(): Promise<void> {
  console.log('\nrunner: interpreted')

  {
    const r = await runSnippet('probe.mjs', 'console.log("node-ok")')
    ok('node runs source from stdin', r.stdout.includes('node-ok'))
    ok('node exits zero', r.exitCode === 0)
  }

  {
    const r = await runSnippet('probe-exit.mjs', 'process.exitCode = 7')
    ok('non-zero exit is reported', r.exitCode === 7)
  }

  {
    const r = await runSnippet('probe-timeout.mjs', 'setTimeout(() => console.log("late"), 5000)', 150)
    ok('timeout kills the process', r.timedOut === true)
  }

  {
    const stdout: string[] = []
    const spec = detectRunSpec('probe-cancel.mjs')
    if (!spec) throw new Error('no spec')
    const handle = startRun({
      source: 'setTimeout(() => {}, 5000)',
      filePath: join(tmpdir(), 'probe-cancel.mjs'),
      spec,
      timeoutMs: 15_000,
      onOutput: (_stream, chunk) => stdout.push(chunk),
    })
    setTimeout(() => handle.cancel(), 50)
    const result = await handle.result
    ok('cancel stops the process', result.cancelled === true && result.timedOut === false)
  }

  if (available('python3')) {
    const r = await runSnippet('probe.py', 'print("py-ok")')
    ok('python runs source from stdin', r.stdout.includes('py-ok'))
    ok('python exits zero', r.exitCode === 0)
  } else {
    console.log('  skip  python3 not available')
  }

  console.log('\nrunner: compiled')

  if (available('c++')) {
    const source = '#include <iostream>\nint main() { std::cout << "cpp-ok" << std::endl; return 0; }\n'
    const r = await runSnippet('probe.cpp', source)
    ok('cpp compile and run', r.stdout.includes('cpp-ok'))
    ok('cpp exits zero', r.exitCode === 0)
  } else {
    console.log('  skip  c++ not available')
  }

  if (available('rustc')) {
    const r = await runSnippet('probe.rs', 'fn main() { println!("rust-ok"); }\n')
    ok('rust compile and run', r.stdout.includes('rust-ok'))
    ok('rust exits zero', r.exitCode === 0)
  } else {
    console.log('  skip  rustc not available')
  }

  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
