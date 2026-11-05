import { applyHunksUpTo, detectRunSpec, stepRunSource } from '../src/run.js'
import { diffHunks } from '../src/diff.js'

let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  if (!cond) {
    failures++
    console.log(`  FAIL  ${label} ${detail}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}

console.log('\napplyHunksUpTo')

{
  const before = 'a\nb\nc\nd\n'
  const after = 'a\nB\nc\nD\n'
  const hunks = diffHunks(before, after)
  ok('two hunks found', hunks.length === 2)
  ok('upTo -1 leaves before untouched', applyHunksUpTo(before, hunks, [], -1) === before)
  ok(
    'upTo 0 applies only the first hunk',
    applyHunksUpTo(before, hunks, ['B'], 0) === 'a\nB\nc\nd\n',
  )
  ok(
    'upTo 1 applies every hunk',
    applyHunksUpTo(before, hunks, ['B', 'D'], 1) === after,
  )
  ok(
    'missing typed text falls back to proposed text',
    applyHunksUpTo(before, hunks, [], 1) === after,
  )
  ok(
    'typed text differing from proposal is used',
    applyHunksUpTo(before, hunks, ['X', 'D'], 0) === 'a\nX\nc\nd\n',
  )
}

{
  const before = 'a\nc\n'
  const after = 'a\nb\nc\n'
  const hunks = diffHunks(before, after)
  ok('pure insertion leaves later text alone when not applied', applyHunksUpTo(before, hunks, [], -1) === before)
  ok('pure insertion applies typed text', applyHunksUpTo(before, hunks, ['b\n'], 0) === after)
}

{
  const before = 'a\nb\nc\n'
  const after = 'a\nc\n'
  const hunks = diffHunks(before, after)
  ok('pure deletion applies typed empty text', applyHunksUpTo(before, hunks, [''], 0) === after)
}

console.log('\nstepRunSource')

{
  const text = 'one\ntwo\nthree\nfour\n'
  ok('prefix through the step end line', stepRunSource(text, 2, 2) === 'one\ntwo\nthree\n')
  ok('first line only', stepRunSource(text, 1, 1) === 'one\n')
  ok('range past EOF returns the whole file', stepRunSource(text, 4, 10) === text)
  ok('start past EOF returns the whole file', stepRunSource(text, 99, 2) === text)
  ok('empty file stays empty', stepRunSource('', 1, 5) === '')
}

console.log('\ndetectRunSpec')

{
  ok('python', detectRunSpec('app.py')?.command === 'python3')
  ok('node esm', detectRunSpec('app.mjs')?.args?.[0] === '--input-type=module')
  ok('node cjs', detectRunSpec('app.cjs')?.args?.[0] === '-')
  ok('js defaults to commonjs', detectRunSpec('app.js')?.args?.[0] === '-')
  ok(
    'js module type override',
    detectRunSpec('app.js', { moduleType: 'module' })?.args?.[0] === '--input-type=module',
  )
  ok('typescript', detectRunSpec('app.ts')?.command === 'tsx')
  ok('tsx', detectRunSpec('app.tsx')?.command === 'tsx')
  ok('mts', detectRunSpec('app.mts')?.language === 'tsx')
  ok('cts', detectRunSpec('app.cts')?.language === 'tsx')
  ok('rust is compiled', detectRunSpec('main.rs')?.kind === 'compile')
  const rust = detectRunSpec('main.rs', { rustc: 'rustc-nightly', rustEdition: '2024' })
  ok('rust command override', rust?.command === 'rustc-nightly')
  ok('rust edition override', rust?.args?.includes('2024') === true)
  ok('rust uses src/out placeholders', rust?.args?.includes('{src}') === true && rust?.args?.includes('{out}') === true)
  ok('cpp is compiled', detectRunSpec('main.cpp')?.kind === 'compile')
  ok('cc extension', detectRunSpec('main.cc')?.language === 'cpp')
  ok('cxx extension', detectRunSpec('main.cxx')?.language === 'cpp')
  ok('c++ extension', detectRunSpec('main.c++')?.language === 'cpp')
  const cpp = detectRunSpec('main.cpp', { cpp: 'clang++', cppStandard: 'c++20', exeSuffix: '.exe' })
  ok('cpp command override', cpp?.command === 'clang++')
  ok('cpp standard override', cpp?.args?.includes('-std=c++20') === true)
  ok('exe suffix applied', cpp?.output === 'program.exe')
  ok('unknown extension has no spec', detectRunSpec('notes.md') === undefined)
  ok('case-insensitive extension', detectRunSpec('MAIN.RS')?.language === 'rust')
}

if (failures > 0) process.exit(1)
