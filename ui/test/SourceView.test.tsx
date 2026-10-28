import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import SourceView from '../src/SourceView.js'
import { backspace, createTrace, press, skipLine, type Trace } from '@devtrace/core'

/**
 * Locks the visual contract: the source character is never replaced. We render
 * a real trace with errors and assert on the markup, because "the character
 * disappeared" is a rendering bug no amount of engine unit testing catches.
 */

let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  if (!cond) {
    failures++
    console.log(`  FAIL  ${label} ${detail}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}

function markup(t: Trace): string {
  return renderToStaticMarkup(
    createElement(SourceView, {
      lines: t.doc.lines,
      lineStarts: t.doc.lineStarts,
      states: t.states,
      wrongAt: t.wrongAt,
      versions: t.versions,
      cursor: t.cursor,
      lineOf: t.doc.lineOf,
      scrollerRef: createRef<HTMLDivElement>(),
    }),
  )
}

function type(t: Trace, keys: string): Trace {
  let now = 1000
  for (const ch of keys) {
    press(t, ch, now)
    now += 120
  }
  return t
}

/**
 * Everything that isn't the caret or an annotation is verbatim source text.
 * Newlines are absent by design: they are the line structure, not a glyph —
 * `split('\n')` never hands them to a line. A miss on a newline shows as the
 * caret dropping to a new line, with no ↵ annotation, which is the honest
 * rendering of "you pressed Enter too early or too late".
 */
const sourceOnly = (html: string) =>
  [...html.matchAll(/<span class="[cpws](?: [^"]*)?">([^<]*)<\/span>/g)]
    .map((m) => m[1] as string)
    .join('')

const SRC = 'def f():\n    return 1'
const SRC_NO_NEWLINES = SRC.replace(/\n/g, '')

console.log('\na keystroke error never removes the source character')
{
  // A bad 4th indent space, and a miss on the space before "1".
  const t = type(createTrace(SRC), 'def f():\n   xreturn21')
  const html = markup(t)

  ok('the missed indent space is still rendered as a space', /<span class="w"> <\/span>/.test(html))
  ok('the key I pressed there is annotated', /<span class="g">x<\/span>/.test(html))
  ok('the space before 1 is still rendered as a space', /<span class="w"> <\/span>/.test(html))
  ok('the key I pressed there is annotated', /<span class="g">2<\/span>/.test(html))
  ok('correct text is collapsed, not per-character', /<span class="c">return<\/span>/.test(html))
  ok('a caret is rendered', /<i class="caret"><\/i>/.test(html))
  ok(
    'source-only runs reconstruct the file exactly (newlines are line structure)',
    sourceOnly(html) === SRC_NO_NEWLINES,
    JSON.stringify(sourceOnly(html)),
  )
}

console.log('\nthe character under the cursor is outlined')
{
  // Stop partway: 3 of the 4 indent spaces typed, so col 3 is still pending.
  const t = type(createTrace(SRC), 'def f():\n   ')
  const html = markup(t)
  ok('the current character is outlined', /class="p curc"/.test(html))
  ok(
    'the outline is on the next untyped character',
    /class="c">   <\/span><i class="caret"><\/i><span class="p curc"> return 1/.test(html),
  )
  ok('only one character is outlined', (html.match(/curc/g) ?? []).length === 1)
}

console.log('\nat the end of a line nothing is outlined, only the caret')
{
  const t = type(createTrace(SRC), 'def f():')
  const html = markup(t)
  ok('no character is outlined past the end of the line', !html.includes('curc'))
  ok('the caret is still shown', /<i class="caret"><\/i>/.test(html))
  ok('the line below is still intact', html.includes('return 1'))
}

console.log('\na backspace removes the annotation')
{
  // One keystroke in, so the cursor sits right after the bad char and ⌫
  // targets it. (Backspace edits cursor-1, so the cursor has to be adjacent.)
  const t = type(createTrace('ab'), 'x')
  ok('annotation is present before the fix', markup(t).includes('<span class="g">x</span>'))
  backspace(t, 2000)
  press(t, 'a', 2100)
  const html = markup(t)
  ok('annotation is gone after the fix', !html.includes('class="g"'))
  ok('the character is back to a plain correct span', /<span class="c(?:\s+[^"]*)?">a<\/span>/.test(html))
  ok('the untyped remainder is still there', /class="p(?:\s+[^"]*)? curc">b<\/span>/.test(html))
  ok('source is intact', sourceOnly(html) === 'ab', JSON.stringify(sourceOnly(html)))
}

console.log('\ncontext lines are shown but never scored')
{
  const t = type(createTrace('b'), 'b')
  const html = renderToStaticMarkup(
    createElement(SourceView, {
      lines: t.doc.lines,
      lineStarts: t.doc.lineStarts,
      states: t.states,
      wrongAt: t.wrongAt,
      versions: t.versions,
      cursor: t.cursor,
      lineOf: t.doc.lineOf,
      scrollerRef: createRef<HTMLDivElement>(),
      firstLine: 10,
      contextBefore: ['a', 'a2'],
      contextAfter: ['c'],
      linePrefix: 'pre',
      lineSuffix: 'post',
    }),
  )
  ok('all neighbour lines render as context', (html.match(/ln ctxln/g) ?? []).length === 3)
  ok('context above keeps real line numbers', html.includes('>8</span>') && html.includes('>9</span>'))
  ok('the traced line keeps its real number', html.includes('>10</span>'))
  ok('context below is numbered after the trace', html.includes('>11</span>'))
  ok(
    'partial line fragments render as inert context',
    html.includes('<span class="ctx">pre</span>') && html.includes('<span class="ctx">post</span>'),
  )
  ok('context is not part of the scored source', sourceOnly(html) === 'b', JSON.stringify(sourceOnly(html)))
}

console.log('\nskipped lines keep their glyph but are marked')
{
  const t = type(createTrace('ab\ncd'), 'ab\n')
  skipLine(t, 2000)
  const html = markup(t)
  ok('skipped chars render with the skip class', /<span class="s(?:\s+[^"]*)?">cd<\/span>/.test(html))
  ok('a skipped char is not a wrong char', !html.includes('class="w"'))
  ok('source is intact', sourceOnly(html) === 'abcd', JSON.stringify(sourceOnly(html)))
}

console.log(failures === 0 ? '\nAll render checks passed.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)