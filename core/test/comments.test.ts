import { languageId, skipRuns } from '../src/comments.js'
import { advanceSkipped, createTrace, markSkipped, metrics, typedText } from '../src/trace.js'

let failures = 0
function ok(label: string, value: boolean): void {
  if (!value) { failures++; console.log(`FAIL ${label}`) }
  else console.log(`ok ${label}`)
}

const source = '// license\nconst url = "https://example.test//ok" // note\n/* block\n * detail\n */\nrun()\n'
const runs = skipRuns(source, languageId('sample.ts'))
ok('skips leading header', runs.some((r) => r.start === 0 && r.end >= 10))
ok('does not treat URL as comment', !runs.some((r) => r.start <= source.indexOf('https://') && r.end > source.indexOf('https://')))
ok('skips trailing comment', runs.some((r) => source.slice(r.start, r.end).trim() === '// note'))
ok('skips block comment', runs.some((r) => source.slice(r.start, r.end).startsWith('/* block')))

const t = createTrace('// note\ncode')
markSkipped(t, 0, 8)
advanceSkipped(t)
ok('advances over pre-skipped text', t.cursor === 8)
ok('typed text keeps skipped text', typedText(t) === '// note\n')
ok('skips are not counted as typed', metrics(t).chars === 0)

if (failures > 0) process.exit(1)
