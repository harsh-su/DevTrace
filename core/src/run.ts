import type { Hunk } from './diff.js'

export type RunLanguage = 'python' | 'node' | 'tsx' | 'rust' | 'cpp'

export interface StdinRunSpec {
  kind: 'stdin'
  language: 'python' | 'node' | 'tsx'
  command: string
  args: string[]
}

export interface CompileRunSpec {
  kind: 'compile'
  language: 'rust' | 'cpp'
  command: string
  args: string[]
  output: string
  sourceExt: string
}

export type RunSpec = StdinRunSpec | CompileRunSpec

export interface DetectRunOptions {
  python?: string
  node?: string
  tsx?: string
  rustc?: string
  cpp?: string
  rustEdition?: string
  cppStandard?: string
  moduleType?: 'module' | 'commonjs'
  exeSuffix?: string
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

export function applyHunksUpTo(
  before: string,
  hunks: Hunk[],
  texts: string[],
  upTo: number,
): string {
  let out = ''
  let pos = 0
  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i] as Hunk
    out += before.slice(pos, hunk.start)
    if (i <= upTo) {
      const typed = texts[i]
      out += typed !== undefined ? typed : hunk.newText
    } else {
      out += hunk.oldText
    }
    pos = hunk.start + hunk.oldText.length
  }
  out += before.slice(pos)
  return out
}

export function stepRunSource(text: string, start: number, lines: number): string {
  const starts = lineStarts(text)
  const from = Math.max(1, Math.floor(start))
  const count = Math.max(1, Math.floor(lines))
  const lastLine = from + count - 1
  if (lastLine >= starts.length) return text
  return text.slice(0, starts[lastLine] as number)
}

export function detectRunSpec(fileName: string, opts: DetectRunOptions = {}): RunSpec | undefined {
  const base = (fileName.toLowerCase().split(/[/\\]/).pop() ?? fileName.toLowerCase()).trim()
  const ext = base.includes('.') ? (base.split('.').pop() ?? '') : ''
  const exe = opts.exeSuffix ?? ''

  switch (ext) {
    case 'py':
      return { kind: 'stdin', language: 'python', command: opts.python ?? 'python3', args: ['-'] }
    case 'mjs':
      return {
        kind: 'stdin',
        language: 'node',
        command: opts.node ?? 'node',
        args: ['--input-type=module', '-'],
      }
    case 'cjs':
      return { kind: 'stdin', language: 'node', command: opts.node ?? 'node', args: ['-'] }
    case 'js':
      return {
        kind: 'stdin',
        language: 'node',
        command: opts.node ?? 'node',
        args: opts.moduleType === 'module' ? ['--input-type=module', '-'] : ['-'],
      }
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return { kind: 'stdin', language: 'tsx', command: opts.tsx ?? 'tsx', args: ['-'] }
    case 'rs':
      return {
        kind: 'compile',
        language: 'rust',
        command: opts.rustc ?? 'rustc',
        args: ['--edition', opts.rustEdition ?? '2021', '{src}', '-o', '{out}'],
        output: `program${exe}`,
        sourceExt: 'rs',
      }
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'c++':
      return {
        kind: 'compile',
        language: 'cpp',
        command: opts.cpp ?? 'c++',
        args: [`-std=${opts.cppStandard ?? 'c++17'}`, '-O0', '{src}', '-o', '{out}'],
        output: `program${exe}`,
        sourceExt: 'cpp',
      }
    default:
      return undefined
  }
}
