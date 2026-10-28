import { diffHunk, diffHunks, diffSpan, resolveEdit, traceContext, type Hunk } from '../src/diff.js'

let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  if (!cond) {
    failures++
    console.log(`  FAIL  ${label} ${detail}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}

console.log('\ndiffHunk')

{
  const h = diffHunk('abc', 'abc')
  ok('no change -> empty hunk', h.oldText === '' && h.newText === '' && h.start === 3)
}

{
  const h = diffHunk('hello world', 'hello brave world')
  ok('pure insertion start', h.start === 6, `got ${h.start}`)
  ok('pure insertion old', h.oldText === '', `got ${JSON.stringify(h.oldText)}`)
  ok('pure insertion new', h.newText === 'brave ', `got ${JSON.stringify(h.newText)}`)
}

{
  const h = diffHunk('const x = 1\n', 'const x = 42\n')
  ok('replacement start', h.start === 10, `got ${h.start}`)
  ok('replacement old', h.oldText === '1', `got ${JSON.stringify(h.oldText)}`)
  ok('replacement new', h.newText === '42', `got ${JSON.stringify(h.newText)}`)
}

{
  const h = diffHunk('a\nb\nc\n', 'a\nc\n')
  ok('deletion start', h.start === 2, `got ${h.start}`)
  ok('deletion old', h.oldText === 'b\n', `got ${JSON.stringify(h.oldText)}`)
  ok('deletion new', h.newText === '', `got ${JSON.stringify(h.newText)}`)
}

{
  const before = 'def f():\n    return 1\n'
  const after = 'def f():\n    return 2\n\nprint(f())\n'
  const h = diffHunk(before, after)
  ok('undo: before reconstructs', before.slice(0, h.start) + h.oldText + before.slice(h.start + h.oldText.length) === before)
  ok('undo: after reconstructs', after.slice(0, h.start) + h.newText + after.slice(h.start + h.newText.length) === after)
}

console.log('\ndiffHunks (minimal, split apart)')

/** Apply hunks to `before` to rebuild `after`. */
function applyHunks(before: string, hunks: Hunk[]): string {
  let out = ''
  let pos = 0
  for (const h of hunks) {
    out += before.slice(pos, h.start) + h.newText
    pos = h.start + h.oldText.length
  }
  return out + before.slice(pos)
}

{
  ok('no change -> no hunks', diffHunks('abc', 'abc').length === 0)
}

{
  const before = 'const x = 1\n'
  const after = 'const x = 42\n'
  const hs = diffHunks(before, after)
  ok('single change -> one hunk', hs.length === 1, `got ${hs.length}`)
  ok(
    'single change is minimal',
    hs[0]?.oldText === '1' && hs[0]?.newText === '42' && hs[0]?.start === 10,
    JSON.stringify(hs),
  )
}

{
  // The bug this fixes: two edits far apart must not collapse into one hunk that
  // also traces the unchanged text between them.
  const before = 'alpha\nbeta\ngamma\ndelta\nepsilon\n'
  const after = 'alpha\nBETA\ngamma\ndelta\nEPSILON\n'
  const hs = diffHunks(before, after)
  ok('two distant edits -> two hunks', hs.length === 2, `got ${hs.length} ${JSON.stringify(hs)}`)
  ok('first hunk is only the changed word', hs[0]?.oldText === 'beta' && hs[0]?.newText === 'BETA', JSON.stringify(hs[0]))
  ok(
    'second hunk is only the changed word',
    hs[1]?.oldText === 'epsilon' && hs[1]?.newText === 'EPSILON',
    JSON.stringify(hs[1]),
  )
  ok('unchanged middle is never traced', !hs.some((h) => h.oldText.includes('gamma') || h.newText.includes('gamma')))
  ok('hunks rebuild after', applyHunks(before, hs) === after, applyHunks(before, hs))
  ok('afterStart locates the first hunk in after', hs[0]?.afterStart === before.indexOf('beta'), `got ${hs[0]?.afterStart}`)
  ok('afterStart locates the second hunk in after', hs[1]?.afterStart === after.indexOf('EPSILON'), `got ${hs[1]?.afterStart}`)
  ok(
    'afterStart slices the new text back out of after',
    hs.every((h) => after.slice(h.afterStart, h.afterStart + h.newText.length) === h.newText),
    JSON.stringify(hs),
  )
}

{
  const before = 'def f():\n    return 1\n'
  const after = 'def f():\n    return 2\n\nprint(f())\n'
  const hs = diffHunks(before, after)
  ok('mixed insertion + edit rebuilds after', applyHunks(before, hs) === after, applyHunks(before, hs))
}

{
  const hs = diffHunks('', 'one\ntwo\n')
  ok('new file -> one pure insertion hunk', hs.length === 1 && hs[0]?.newText === 'one\ntwo\n', JSON.stringify(hs))
}

{
  const before = 'print("FlowDo server is starting at http://127.0.0.1:5000")\n'
  const after = 'print("FlowDo server is launching at http://127.0.0.1:5000")\n'
  const hs = diffHunks(before, after)
  ok('intra-word edit coalesces into one hunk', hs.length === 1, `got ${hs.length} hunks: ${JSON.stringify(hs)}`)
  ok('coalesced hunk replaces start with launch', hs[0]?.oldText === 'start' && hs[0]?.newText === 'launch')
  ok('coalesced hunk rebuilds after', applyHunks(before, hs) === after)
}

console.log('\ntraceContext (unedited surroundings)')

{
  const current = 'l1\nl2\nl3\nl4\nl5\nl6\n'
  const hunk = diffHunk(current, 'l1\nl2\nl3\nL4\nl5\nl6\n')
  const ctx = traceContext(current, hunk)
  ok('hunk starts on line 4', ctx.startLine === 4, `got ${ctx.startLine}`)
  ok('the changed line keeps its untouched tail', ctx.lineSuffix === '4', JSON.stringify(ctx.lineSuffix))
  ok('context above is the preceding lines', ctx.before.join('|') === 'l1|l2|l3', ctx.before.join('|'))
  ok('context below begins with the next line', ctx.after[0] === 'l5', JSON.stringify(ctx.after))
}

{
  // Insertion in the middle of a line: the fragments must be returned, not lost.
  const current = 'hello world\nbye\n'
  const hunk = diffHunk(current, 'hello brave world\nbye\n')
  const ctx = traceContext(current, hunk)
  ok('mid-line prefix is captured', ctx.linePrefix === 'hello ', JSON.stringify(ctx.linePrefix))
  ok('mid-line suffix is captured', ctx.lineSuffix === 'world', JSON.stringify(ctx.lineSuffix))
  ok('start line is the shared line', ctx.startLine === 1, `got ${ctx.startLine}`)
  ok('no complete lines above a first-line edit', ctx.before.length === 0)
  ok('following lines are offered as context', ctx.after[0] === 'bye', JSON.stringify(ctx.after))
}

console.log('\nresolveEdit (editor input)')

/** A restore must always turn `now` back into `base`. */
function restores(base: string, now: string): boolean {
  const r = diffSpan(base, now)
  return now.slice(0, r.prefix) + r.baseChanged + now.slice(r.prefix + r.nowChanged.length) === base
}

{
  const r = resolveEdit('abc', 'aXbc', [{ offset: 1, text: 'X' }], 1)
  ok('insert at caret is typed', r.typed === 'X', `got ${JSON.stringify(r.typed)}`)
  ok('restore reconstructs base', restores('abc', 'aXbc'))
}

{
  // The bug a plain text diff cannot solve: typing "a" before "aaa".
  const r = resolveEdit('aaa', 'aaaa', [{ offset: 0, text: 'a' }], 0)
  ok('repeated char at caret is typed', r.typed === 'a', `got ${JSON.stringify(r.typed)}`)
  ok('restore still reconstructs base', restores('aaa', 'aaaa'))
}

{
  const r = resolveEdit('abc', 'aXbc', [{ offset: 1, text: 'X' }], 0)
  ok('insert away from caret is ignored', r.typed === undefined, `got ${JSON.stringify(r.typed)}`)
}

{
  // Auto-close: "(" inserts "(" at caret and ")" one past it.
  const r = resolveEdit('f', 'f()', [{ offset: 1, text: '(' }, { offset: 2, text: ')' }], 1)
  ok('auto-close scores only the opening char', r.typed === '(', `got ${JSON.stringify(r.typed)}`)
  ok('auto-close restore reconstructs base', restores('f', 'f()'))
}

{
  const r = resolveEdit('abc', 'ac', [{ offset: 1, text: '' }], 1)
  ok('deletion is not typed', r.typed === undefined, `got ${JSON.stringify(r.typed)}`)
  ok('deletion restore reconstructs base', restores('abc', 'ac'))
}

{
  // No offsets available: fall back to the diff, but only when unambiguous.
  const r = resolveEdit('abc', 'aXbc', [], 1)
  ok('fallback diff scores when prefix matches', r.typed === 'X', `got ${JSON.stringify(r.typed)}`)
  const ambiguous = resolveEdit('aaa', 'aaaa', [], 0)
  ok('fallback diff bails on repeated-char ambiguity', ambiguous.typed === undefined)
}

console.log(failures === 0 ? '\nAll diff checks passed.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
