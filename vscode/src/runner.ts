import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { CompileRunSpec, RunSpec } from '@aitrace/core'

export type RunPhase = 'build' | 'run'
export type RunStream = 'stdout' | 'stderr'

export interface RunResult {
  exitCode: number | null
  durationMs: number
  timedOut: boolean
  cancelled: boolean
  truncated: boolean
  failedPhase?: RunPhase
  spawnError?: string
}

export interface RunRequest {
  source: string
  filePath: string
  spec?: RunSpec
  timeoutMs?: number
  maxOutputBytes?: number
  commandOverride?: string
  onPhase?: (phase: RunPhase) => void
  onOutput?: (stream: RunStream, chunk: string) => void
}

export interface RunHandle {
  result: Promise<RunResult>
  cancel(): void
}

interface ProcessOutcome {
  exitCode: number | null
  spawnError?: string
  timedOut: boolean
  cancelled: boolean
}

interface PreparedSource {
  source: string
  output: string
  adjacent: boolean
  cleanup(): Promise<void>
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024

function existingDir(filePath: string): string {
  let dir = dirname(filePath)
  while (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent === dir) return tmpdir()
    dir = parent
  }
  return dir
}

function exeSuffix(): string {
  return process.platform === 'win32' ? '.exe' : ''
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replaceAll('"', '""')}"`
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function killTree(child: ChildProcess | undefined): void {
  if (!child || child.killed || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      /* fall through to a direct kill */
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

async function prepareCompiledSource(
  source: string,
  filePath: string,
  spec: CompileRunSpec,
): Promise<PreparedSource> {
  const base = `aitrace_run_${randomBytes(6).toString('hex')}`
  const suffix = spec.output.endsWith('.exe') ? '.exe' : exeSuffix()
  const adjacentDir = existingDir(filePath)
  const adjacentSource = join(adjacentDir, `${base}.${spec.sourceExt}`)
  const adjacentOutput = join(adjacentDir, `${base}${suffix}`)

  try {
    await writeFile(adjacentSource, source, 'utf8')
    return {
      source: adjacentSource,
      output: adjacentOutput,
      adjacent: true,
      cleanup: async () => {
        await unlink(adjacentSource).catch(() => {})
        await unlink(adjacentOutput).catch(() => {})
      },
    }
  } catch {
    /* read-only directory, fall back to the OS temp directory */
  }

  const dir = await mkdtemp(join(tmpdir(), 'aitrace-run-'))
  const tempSource = join(dir, `${base}.${spec.sourceExt}`)
  const tempOutput = join(dir, `${base}${suffix}`)
  await writeFile(tempSource, source, 'utf8')
  return {
    source: tempSource,
    output: tempOutput,
    adjacent: false,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

export async function resolveModuleType(filePath: string): Promise<'module' | 'commonjs'> {
  let dir = existingDir(filePath)
  while (true) {
    try {
      const raw = await readFile(join(dir, 'package.json'), 'utf8')
      const pkg = JSON.parse(raw) as { type?: unknown }
      return pkg.type === 'module' ? 'module' : 'commonjs'
    } catch {
      /* keep walking up */
    }
    const parent = dirname(dir)
    if (parent === dir) return 'commonjs'
    dir = parent
  }
}

export function startRun(request: RunRequest): RunHandle {
  const startedAt = Date.now()
  const timeoutMs = Math.max(100, request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const maxBytes = Math.max(1024, request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)
  const cwd = existingDir(request.filePath)
  let current: ChildProcess | undefined
  let cancelled = false
  let outputBytes = 0
  let truncated = false

  const emitOutput = (stream: RunStream, chunk: string): void => {
    if (!chunk) return
    if (outputBytes >= maxBytes) {
      truncated = true
      return
    }
    const remaining = maxBytes - outputBytes
    const text = chunk.length > remaining ? chunk.slice(0, remaining) : chunk
    outputBytes += text.length
    if (text.length < chunk.length) truncated = true
    request.onOutput?.(stream, text)
  }

  const runProcess = (
    command: string,
    args: string[],
    opts: { input?: string; shell?: boolean } = {},
  ): Promise<ProcessOutcome> =>
    new Promise((resolve) => {
      if (cancelled) {
        resolve({ exitCode: null, timedOut: false, cancelled: true })
        return
      }

      let child: ChildProcess
      try {
        child = spawn(command, args, {
          cwd,
          shell: opts.shell ?? false,
          env: process.env,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (err) {
        resolve({
          exitCode: null,
          spawnError: (err as Error).message,
          timedOut: false,
          cancelled: false,
        })
        return
      }

      current = child
      let settled = false
      let localTimedOut = false

      const finish = (outcome: ProcessOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (current === child) current = undefined
        resolve(outcome)
      }

      const timer = setTimeout(() => {
        localTimedOut = true
        killTree(child)
      }, timeoutMs)

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => emitOutput('stdout', chunk))
      child.stderr?.on('data', (chunk: string) => emitOutput('stderr', chunk))
      child.on('error', (err) => {
        finish({
          exitCode: null,
          spawnError: err.message,
          timedOut: localTimedOut,
          cancelled,
        })
      })
      child.on('close', (code) => {
        finish({
          exitCode: code,
          timedOut: localTimedOut,
          cancelled: cancelled && !localTimedOut,
        })
      })

      child.stdin?.on('error', () => {})
      child.stdin?.end(opts.input ?? '')
    })

  const result = (async (): Promise<RunResult> => {
    let outcome: ProcessOutcome = {
      exitCode: null,
      timedOut: false,
      cancelled: false,
    }
    let failedPhase: RunPhase | undefined
    let cleanup: (() => Promise<void>) | undefined

    try {
      if (request.commandOverride) {
        const dir = await mkdtemp(join(tmpdir(), 'aitrace-run-'))
        const ext = extname(request.filePath) || '.txt'
        const sourcePath = join(dir, `source${ext}`)
        cleanup = async () => {
          await rm(dir, { recursive: true, force: true }).catch(() => {})
        }
        await writeFile(sourcePath, request.source, 'utf8')
        const template = request.commandOverride.includes('${file}')
          ? request.commandOverride.replaceAll('${file}', shellQuote(sourcePath))
          : `${request.commandOverride} ${shellQuote(sourcePath)}`
        request.onPhase?.('run')
        outcome = await runProcess(template, [], { shell: true })
        failedPhase = outcome.exitCode === 0 ? undefined : 'run'
      } else if (request.spec && request.spec.kind === 'stdin') {
        request.onPhase?.('run')
        outcome = await runProcess(request.spec.command, request.spec.args, {
          input: request.source,
        })
        failedPhase = outcome.exitCode === 0 ? undefined : 'run'
      } else if (request.spec && request.spec.kind === 'compile') {
        const prepared = await prepareCompiledSource(
          request.source,
          request.filePath,
          request.spec,
        )
        cleanup = prepared.cleanup
        const args = request.spec.args.map((arg) =>
          arg === '{src}' ? prepared.source : arg === '{out}' ? prepared.output : arg,
        )
        if (request.spec.language === 'cpp' && !prepared.adjacent) {
          args.unshift(`-I${existingDir(request.filePath)}`)
        }

        request.onPhase?.('build')
        outcome = await runProcess(request.spec.command, args)
        if (outcome.exitCode !== 0 || outcome.spawnError || outcome.timedOut || outcome.cancelled) {
          failedPhase = 'build'
        } else {
          request.onPhase?.('run')
          outcome = await runProcess(prepared.output, [])
          failedPhase = outcome.exitCode === 0 ? undefined : 'run'
        }
      } else {
        throw new Error('No run command detected for this file.')
      }
    } catch (err) {
      outcome = {
        exitCode: null,
        spawnError: (err as Error).message,
        timedOut: false,
        cancelled: false,
      }
    } finally {
      if (cleanup) await cleanup().catch(() => {})
    }

    return {
      exitCode: outcome.exitCode,
      durationMs: Date.now() - startedAt,
      timedOut: outcome.timedOut,
      cancelled: outcome.cancelled,
      truncated,
      failedPhase,
      spawnError: outcome.spawnError,
    }
  })()

  return {
    result,
    cancel(): void {
      cancelled = true
      killTree(current)
    },
  }
}
