import {
  aggregateMetrics,
  autoAdvanceLeadingIndent,
  autoAdvanceNonTypable,
  autocompleteLine,
  backspace,
  buildDoc,
  CORRECT,
  createTrace,
  finalizeAll,
  isComplete,
  metrics,
  press,
  recordError,
  SKIPPED,
  skipLine,
  tabFill,
  topOffenders,
  topOffendersAcross,
  typedText,
  WRONG,
} from '../src/trace.js'
import { tokenizeLine } from '../src/syntax.js'
import { buildRuns } from '../src/tokenize.js'
import { showChar } from '../src/format.js'

let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  if (!cond) {
    failures++
    console.log(`  FAIL  ${label} ${detail}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}
function near(label: string, a: number, b: number, eps = 0.001) {
  ok(`${label} (${a.toFixed(3)} ~= ${b})`, Math.abs(a - b) < eps)
}

/** Types `text` at a fixed cadence so the numbers are deterministic. */
function typeAll(t: ReturnType<typeof createTrace>, str: string, step = 200) {
  let now = 1000
  for (const ch of str) {
    press(t, ch, now)
    now += step
  }
  return now
}

console.log('\n1. perfect run')
{
  const src = 'def f():\n    return 1\n'
  const t = createTrace(src)
  typeAll(t, src)
  ok('complete', isComplete(t))
  finalizeAll(t)
  const m = metrics(t)
  near('accuracy', m.accuracy, 1)
  ok('errors 0', m.errors === 0, `got ${m.errors}`)
  // 22 chars in 21 gaps of 200ms = 4.2s -> 22/5 per (4.2/60) min
  near('netWpm', m.netWpm, 22 / 5 / (4.2 / 60))
  ok('one indented line', m.indentLines === 1, `got ${m.indentLines}`)
  near('indentAccuracy', m.indentAccuracy, 1)
  ok('keystrokes logged', t.keystrokes.length === 22, `got ${t.keystrokes.length}`)
}

console.log('\n2. one bad indent char (substituted in place, no shift)')
{
  const src = 'def f():\n    return 1\n'
  const t = createTrace(src)
  const wrong = src.slice(0, 12) + 'x' + src.slice(13)
  ok('substitution is length-preserving', wrong.length === src.length)
  typeAll(t, wrong)
  finalizeAll(t)
  const m = metrics(t)
  near('accuracy', m.accuracy, 21 / 22)
  ok('1 error', m.errors === 1, `got ${m.errors}`)
  ok('indent miss', m.indentMisses === 1, `got ${m.indentMisses}`)
  near('indentAccuracy', m.indentAccuracy, 0)
}

console.log('\n3. backspace clears the error, but accuracy still counts it')
{
  const src = 'def f():\n    return 1\n'
  const t = createTrace(src)
  typeAll(t, src.slice(0, 12)) // through 3 of the 4 indent spaces
  ok('no errors so far', t.keystrokes.filter((k) => !k.ok).length === 0)
  press(t, 'x', 2000) // wrong char on the 4th indent space
  backspace(t, 2100)
  typeAll(t, src.slice(12)) // retype the rest correctly
  ok('complete', isComplete(t))
  finalizeAll(t)
  const m = metrics(t)
  ok('backspace logged', t.keystrokes.filter((k) => k.kind === 'back').length === 1)
  ok('1 backspace in metrics', m.backspaces === 1, `got ${m.backspaces}`)
  ok('1 error still counted', m.errors === 1, `got ${m.errors}`)
  near('accuracy = 22/23, the error is not forgiven', m.accuracy, 22 / 23)
  // The whole point: indentAccuracy reads final state, accuracy reads history.
  ok('indent is clean after the fix', m.indentMisses === 0, `got ${m.indentMisses}`)
  near('indentAccuracy', m.indentAccuracy, 1)
  ok('rawWpm >= netWpm', m.rawWpm >= m.netWpm)
}

console.log('\n4. tab stops')
{
  ok('empty line -> 4 spaces', tabFill('') === '    ')
  ok('col 4 -> 4 spaces', tabFill('def ') === '    ')
  ok('col 2 -> 2 spaces', tabFill('  ') === '  ')
  ok('col 7 -> 1 space', tabFill('       ') === ' ')
  ok('col 8 -> 4 spaces', tabFill('        ') === '    ')
}

console.log('\n5. doc indexing')
{
  const src = 'a\nbb\n\nccc'
  const d = buildDoc(src)
  ok('4 lines', d.lines.length === 4, `got ${d.lines.length}`)
  ok('starts', JSON.stringify(d.lineStarts) === '[0,2,5,6]', JSON.stringify(d.lineStarts))
  ok('lineOf[0]=0', d.lineOf[0] === 0)
  ok('lineOf[2]=1', d.lineOf[2] === 1)
  ok('lineOf[5]=2', d.lineOf[5] === 2)
  ok('lineOf[6]=3', d.lineOf[6] === 3)
  ok('indent lengths', JSON.stringify([...d.indentLen]) === '[0,0,0,0]')
  ok('indentedLines', d.indentedLines === 0)
}

console.log('\n6. empty input is safe')
{
  const t = createTrace('')
  ok('starts complete', isComplete(t))
  ok('press is a no-op', press(t, 'a', 1) === false)
  ok('backspace is a no-op', backspace(t, 1) === false)
  finalizeAll(t)
  const m = metrics(t)
  ok('no NaN in metrics', Object.values(m).every((v) => typeof v !== 'number' || !Number.isNaN(v)))
}

console.log('\n7. empty-line indent does not count')
{
  const src = 'x\n    y\n\nz'
  const d = buildDoc(src)
  ok('indentedLines counts only line 1', d.indentedLines === 1, `got ${d.indentedLines}`)
}

// ---------------------------------------------------------------------------
// Rendering. The rule under test: the source character is never replaced.
// ---------------------------------------------------------------------------

/** Everything that isn't the caret or an annotation is verbatim source text. */
const sourceOf = (runs: ReturnType<typeof buildRuns>) =>
  runs
    .filter((r) => !r.caret && !r.got)
    .map((r) => r.t)
    .join('')

console.log('\n8. a wrong keystroke keeps the source character')
{
  const src = 'ab'
  const t = createTrace(src)
  press(t, 'x', 1000) // wrong on 'a'
  const runs = buildRuns(src, t.states, 0, 1, t.wrongAt)

  ok('source text is intact', sourceOf(runs) === src, JSON.stringify(sourceOf(runs)))
  const srcRun = runs.find((r) => r.c === WRONG && !r.got)
  ok('source char "a" is rendered', srcRun?.t === 'a', `got ${JSON.stringify(srcRun?.t)}`)
  const ann = runs.find((r) => r.got)
  ok('what I pressed is annotated', ann?.t === 'x', `got ${JSON.stringify(ann?.t)}`)
  ok('annotation is not mistaken for source', sourceOf(runs).indexOf('x') === -1)
  ok('exactly one caret', runs.filter((r) => r.caret).length === 1)
}

console.log('\n9. a miss on a space keeps the space, annotates what I hit')
{
  const src = 'if x:'
  const t = createTrace(src)
  press(t, 'z', 1000) // wrong on 'i'
  press(t, 'f', 1200) // correct on 'f'
  press(t, 'q', 1400) // wrong on the space at index 2
  const runs = buildRuns(src, t.states, 0, 3, t.wrongAt)

  ok('source text is intact', sourceOf(runs) === src, JSON.stringify(sourceOf(runs)))
  ok('the space is still there', runs.some((r) => r.c === WRONG && !r.got && r.t === ' '))
  ok('annotated with what I pressed', runs.some((r) => r.got && r.t === 'q'))
  ok('showChar maps space to ␣', showChar(' ') === '␣')
  ok('showChar maps newline to ↵', showChar('\n') === '↵')
  ok('showChar maps tab to ⇥', showChar('\t') === '⇥')
  ok('showChar passes a letter through', showChar('a') === 'a')
}

console.log('\n10. correct runs still collapse (the perf property)')
{
  const src = 'return 1'
  const t = createTrace(src)
  typeAll(t, src)
  const runs = buildRuns(src, t.states, 0, src.length, t.wrongAt)
  ok('one span for 8 correct chars + caret', runs.length === 2, `got ${runs.length}`)
  ok('the span holds the whole line', runs[0]?.t === src)
  ok('typed run is CORRECT', runs[0]?.c === CORRECT)
}

console.log('\n11. exactly one caret at every position, errors present')
{
  const src = '  if x:\n\ty = 1'
  const t = createTrace(src)
  let now = 1000
  // A deliberately messy run: wrong chars, a correct space, a tab-as-␣ miss.
  for (const ch of ['q', ' ', 'Z', 'f', ' ', 'x', ':', '\n', '\t', 'y', ' ', '=', ' ', 'Q']) {
    press(t, ch, now)
    now += 50
  }
  const lineStart = t.doc.lineStarts[1] as number
  const line = (t.doc.lines[1] as string)

  let caretCounts = new Set<number>()
  let sourceOk = true
  for (let c = 0; c <= line.length; c++) {
    const runs = buildRuns(line, t.states, lineStart, c, t.wrongAt)
    caretCounts.add(runs.filter((r) => r.caret).length)
    if (sourceOf(runs) !== line) sourceOk = false
  }
  ok('one caret at every column', caretCounts.size === 1 && caretCounts.has(1), `counts: ${[...caretCounts]}`)
  ok('source text intact at every column', sourceOk)

  const none = buildRuns(line, t.states, lineStart, -1, t.wrongAt)
  ok('caretCol -1 emits no caret', none.filter((r) => r.caret).length === 0)
  ok('caretCol -1 marks no current char', none.filter((r) => r.cur).length === 0)
}

console.log('\n12. the current character is always marked')
{
  const src = 'hello'
  const t = createTrace(src)
  typeAll(t, 'hel')
  for (let c = 0; c < src.length; c++) {
    const runs = buildRuns(src, t.states, 0, c, t.wrongAt)
    const cur = runs.filter((r) => r.cur)
    ok(`  col ${c} has exactly one current run`, cur.length === 1, `got ${cur.length}`)
  }
  // Past the last character there is nothing under the caret, so nothing is
  // marked. The caret bar is the only indicator there, which is correct: the
  // next thing to type is Enter, not a character.
  const past = buildRuns(src, t.states, 0, src.length, t.wrongAt)
  ok('end of line marks no character', past.filter((r) => r.cur).length === 0)
  ok('end of line still places the caret', past.filter((r) => r.caret).length === 1)
}

console.log('\n13. backspace removes the annotation')
{
  const src = 'ab'
  const t = createTrace(src)
  press(t, 'x', 1000)
  ok('annotation present', t.wrongAt.get(0) === 'x')
  backspace(t, 1100)
  ok('annotation cleared', t.wrongAt.has(0) === false)
  press(t, 'a', 1200)
  ok('annotation stays cleared on a correct retype', t.wrongAt.size === 0)
  ok('no leftover got runs', buildRuns(src, t.states, 0, 1, t.wrongAt).filter((r) => r.got).length === 0)
}

console.log('\n14. a space keystroke round-trips through topOffenders')
{
  const src = 'a b'
  const t = createTrace(src)
  press(t, 'q', 1000) // expected 'a'
  press(t, 'x', 1200) // expected a SPACE
  press(t, 'b', 1400) // correct
  const off = topOffenders(t)
  const spaceMiss = off.find((o) => o.expected === ' ')
  ok('space miss is recorded', spaceMiss !== undefined)
  ok('its "got" is not empty', spaceMiss?.got === 'x', `got ${JSON.stringify(spaceMiss?.got)}`)
  ok('expected "a" miss intact', off.some((o) => o.expected === 'a' && o.got === 'q'))
}

console.log('\n15. typedText reconstructs exactly what was typed')
{
  const src = 'def f():\n    return 1'
  const t = createTrace(src)
  typeAll(t, src)
  ok('a clean run reproduces the target', typedText(t) === src, JSON.stringify(typedText(t)))

  const bad = createTrace('ab')
  press(bad, 'x', 1000) // wrong on 'a'
  press(bad, 'b', 1200) // correct
  ok('a wrong key is kept as typed', typedText(bad) === 'xb', JSON.stringify(typedText(bad)))

  const partial = createTrace('hello')
  typeAll(partial, 'hel')
  ok('an unfinished run yields only the prefix', typedText(partial) === 'hel', JSON.stringify(typedText(partial)))

  const fixed = createTrace('ab')
  press(fixed, 'x', 1000) // wrong on 'a'
  backspace(fixed, 1100)
  press(fixed, 'a', 1200) // corrected
  ok('a backspace-then-fix yields the final characters', typedText(fixed) === 'a', JSON.stringify(typedText(fixed)))

  const newline = createTrace('a\nb')
  press(newline, 'a', 1000)
  press(newline, 'x', 1200) // wrong on '\n'
  ok('a wrong newline is kept as the pressed char', typedText(newline) === 'ax', JSON.stringify(typedText(newline)))

  const empty = createTrace('')
  ok('empty trace yields empty text', typedText(empty) === '')
}

console.log('\n16. skip accepts a line without typing it')
{
  const src = 'def f():\n    return 1\nx = 2\n'
  const t = createTrace(src)
  typeAll(t, 'def f():\n')
  const before = t.cursor
  ok('skip returns true', skipLine(t, 2000) === true)
  ok('cursor lands on the next line', t.doc.lineOf[t.cursor] === 2, `got ${t.doc.lineOf[t.cursor]}`)
  ok('cursor moved forward', t.cursor > before)
  const skippedLine = '    return 1\n'
  ok('cursor advanced the whole line', t.cursor === before + skippedLine.length)

  const line2Start = t.doc.lineStarts[1] as number
  ok('skipped chars carry the SKIPPED state', t.states[line2Start] === SKIPPED)

  typeAll(t, src.slice(t.cursor))
  finalizeAll(t)
  const m = metrics(t)
  ok('complete', isComplete(t))
  ok('skipped chars counted', m.skipped === skippedLine.length, `got ${m.skipped}`)
  ok('no errors from a skip', m.errors === 0, `got ${m.errors}`)
  ok('skipped chars are not typed chars', m.chars === src.length - skippedLine.length, `got ${m.chars}`)
  ok('skipped line is not scored for indent', m.indentLines === 0, `got ${m.indentLines}`)
  ok('typedText keeps the skipped source', typedText(t) === src, JSON.stringify(typedText(t)))
}

console.log('\n17. skipping the last line completes the trace')
{
  const src = 'a\nb'
  const t = createTrace(src)
  press(t, 'a', 1000)
  press(t, '\n', 1100)
  ok('not complete on entry', !isComplete(t))
  ok('skip last line', skipLine(t, 1200))
  ok('complete after skipping', isComplete(t))
  finalizeAll(t)
  ok('typedText keeps the last line', typedText(t) === src, JSON.stringify(typedText(t)))
  ok('skipped counts the last line', metrics(t).skipped === 1, `got ${metrics(t).skipped}`)
}

console.log('\n18. skipping a blank line preserves its newline')
{
  const src = 'a\n\nb'
  const t = createTrace(src)
  press(t, 'a', 1000)
  press(t, '\n', 1100)
  skipLine(t, 1200)
  ok('cursor reaches the line after the blank', t.doc.lineOf[t.cursor] === 2, `got ${t.doc.lineOf[t.cursor]}`)
  typeAll(t, 'b')
  finalizeAll(t)
  ok('typedText round-trips', typedText(t) === src, JSON.stringify(typedText(t)))
}

console.log('\n19. aggregateMetrics scores several hunks as one session')
{
  const a = createTrace('return 1')
  const b = createTrace('x = 2')
  typeAll(a, 'return 1', 100)
  // Continue the clock so the second hunk's keystrokes come after the first.
  let now = 1000 + 9 * 100
  for (const ch of 'x = 2') {
    press(b, ch, now)
    now += 100
  }
  finalizeAll(a)
  finalizeAll(b)
  const agg = aggregateMetrics([a, b])
  const ma = metrics(a)
  const mb = metrics(b)
  ok('chars are the sum', agg.chars === ma.chars + mb.chars, `got ${agg.chars}`)
  ok('correct is the sum', agg.correct === ma.correct + mb.correct)
  ok('errors are the sum', agg.errors === ma.errors + mb.errors)
  near('accuracy over the combined log', agg.accuracy, (ma.correct + mb.correct) / (ma.chars + mb.chars))
  ok('span covers both hunks', agg.seconds > ma.seconds && agg.seconds > mb.seconds, `got ${agg.seconds}`)
  ok('an empty bundle is safe', aggregateMetrics([]).chars === 0)

  const bad = createTrace('ab')
  press(bad, 'x', 1000) // wrong on 'a'
  press(bad, 'b', 1200)
  ok('topOffendersAcross reads every trace', topOffendersAcross([a, bad]).some((o) => o.got === 'x'))
}

console.log('\n20. autoAdvanceNonTypable skips emojis and unicode symbols')
{
  const src = 'hello 👋 world 🚀'
  const t = createTrace(src)
  typeAll(t, 'hello ')
  ok('cursor is at emoji', t.doc.text[t.cursor] !== 'w')
  autoAdvanceNonTypable(t, 2000)
  ok('cursor skipped emoji to space/world', t.doc.text.slice(t.cursor).startsWith(' world'))
  press(t, ' ', 2100)
  typeAll(t, 'world ')
  autoAdvanceNonTypable(t, 2200)
  ok('complete after skipping final emoji', isComplete(t))
}

console.log('\n21. autoAdvanceLeadingIndent consumes leading whitespace on newlines')
{
  const src = 'def init():\n    return True'
  const t = createTrace(src)
  typeAll(t, 'def init():')
  press(t, '\n', 2000, 'newline')
  autoAdvanceLeadingIndent(t, 2001)
  ok('cursor auto-advanced past 4 leading spaces', t.doc.text.slice(t.cursor).startsWith('return'))
  ok('auto-advanced spaces are marked CORRECT', t.states[t.doc.text.indexOf('r') - 1] === CORRECT)
}

console.log('\n22. autocompleteLine autocompletes rest of line on Tab')
{
  const src = 'x = 100\ny = 200\n'
  const t = createTrace(src)
  press(t, 'x', 1000)
  autocompleteLine(t, 1100)
  ok('cursor jumped to next line after Tab autocomplete', t.cursor === src.indexOf('y'))
  ok('completed line characters marked CORRECT', t.states[src.indexOf('=')] === CORRECT)
}

console.log('\n23. recordError locks cursor on error (Stop on Error mode)')
{
  const src = 'hello'
  const t = createTrace(src)
  press(t, 'h', 1000)
  ok('cursor moved to 1', t.cursor === 1)
  recordError(t, 'z', 1100)
  ok('cursor stays locked at 1 on typo', t.cursor === 1)
  ok('state at cursor is WRONG', t.states[1] === WRONG)
  ok('wrongAt records pressed char', t.wrongAt.get(1) === 'z')
  backspace(t, 1200)
  ok('backspace clears WRONG state at cursor', t.states[1] === 0)
  ok('wrongAt is cleared', !t.wrongAt.has(1))
  press(t, 'e', 1300)
  ok('cursor advances after fixing error', t.cursor === 2)
}

console.log('\n24. tokenizeLine extracts syntax tags for Python and JS/TS')
{
  const pyLine = 'def hello(name: str): # comment'
  const pyTags = tokenizeLine(pyLine, 'test.py')
  ok('keyword def tagged with k', pyTags[0] === 'k' && pyTags[2] === 'k')
  ok('function hello tagged with f', pyTags[4] === 'f' && pyTags[8] === 'f')
  ok('comment tagged with c', pyTags[pyLine.indexOf('#')] === 'c')

  const jsLine = 'const val = "world";'
  const jsTags = tokenizeLine(jsLine, 'main.ts')
  ok('keyword const tagged with k', jsTags[0] === 'k')
  ok('string tagged with s', jsTags[jsLine.indexOf('"')] === 's')
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
