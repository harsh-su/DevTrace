import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import FileTraceView from '../src/FileTraceView.js'
import { buildDoc, CONTEXT, createTrace, press } from '@devtrace/core'

/**
 * The full-file contract: the whole file is present as text, every line keeps
 * its real number, unchanged characters render as inert context, and only the
 * changed hunk carries the typed states and the caret.
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

/** Every source glyph, context or traceable, in document order. */
const textOf = (html: string) =>
  [...html.matchAll(/<span class="(?:ctx|[cpws])(?: [^"]*)?">([^<]*)<\/span>/g)]
    .map((m) => m[1] as string)
    .join('')

// Two edits in the same file: "beta" (line 2) and "delta" (line 4).
const after = 'alpha\nbeta\ngamma\ndelta\n'
const doc = buildDoc(after)
const states = new Uint8Array(after.length).fill(CONTEXT)
const wrongAt = new Map<number, string>()
const versions = new Uint32Array(doc.lines.length + 1)

// The first hunk is being typed: one correct character so far.
const betaStart = after.indexOf('beta')
const t = createTrace('beta')
press(t, 'b', 1000)
for (let k = 0; k < t.doc.text.length; k++) states[betaStart + k] = t.states[k] as number

const html = renderToStaticMarkup(
  createElement(FileTraceView, {
    lines: doc.lines,
    lineStarts: doc.lineStarts,
    lineOf: doc.lineOf,
    states,
    wrongAt,
    versions,
    cursorAfter: betaStart + 1,
    scrollerRef: createRef<HTMLDivElement>(),
  }),
)

console.log('\nthe whole file is rendered')
{
  // Every non-empty line contributes its glyphs; the trailing blank line
  // contributes the single placeholder space an empty line always draws.
  const expected = after.replace(/\n/g, '') + ' '
  ok('source text is intact', textOf(html) === expected, JSON.stringify(textOf(html)))
  ok('every line keeps its real number', doc.lines.every((_, i) => html.includes(`>${i + 1}</span>`)))
  ok('untouched code renders as inert context', /<span class="ctx">alpha<\/span>/.test(html))
  ok('context after the second hunk is present', /<span class="ctx">gamma<\/span>/.test(html))
}

console.log('\nonly the hunk is scored')
{
  ok('the typed character is a correct run', /<span class="c">b<\/span>/.test(html))
  ok('the rest of the hunk is pending', /<span class="p curc">eta<\/span>/.test(html))
  ok('exactly one caret', (html.match(/<i class="caret">/g) ?? []).length === 1)
  ok('the active line is highlighted', html.includes('class="ln cur"'))
  ok('context is never marked correct or wrong', !/<span class="[cw]">alpha<\/span>/.test(html))
}

console.log(failures === 0 ? '\nAll file-view checks passed.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
