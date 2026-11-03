import {
  currentStepIndex,
  emptyProgress,
  isDone,
  lineSlice,
  normalizeProgress,
  progressSummary,
  recordStep,
  validateTour,
  tourPaths,
} from '../src/tour.js'

let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  if (!cond) {
    failures++
    console.log(`  FAIL  ${label} ${detail}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}

const steps = [
  {
    id: 'step-01',
    title: 'The trace engine',
    file: 'core/src/trace.ts',
    start: 46,
    lines: 40,
    why: 'start at the heart',
    concept: 'Trace state machine',
    explanation: 'press() advances on every key.',
  },
  {
    id: 'step-02',
    title: 'The hunk locator',
    file: 'core/src/diff.ts',
    start: 130,
    lines: 25,
    why: 'then find what changed',
    concept: 'Myers diff',
    explanation: 'diffHunks splits an edit.',
  },
]

console.log('\nvalidateTour')

{
  const tour = validateTour({ title: 'Learn AItrace', goal: 'understand the engine', steps })
  ok('valid tour passes', tour !== undefined)
  ok(
    'steps survive validation',
    tour?.steps.length === 2 && tour?.steps[1]?.title === 'The hunk locator',
  )
  ok(
    'lines are capped at 80',
    validateTour({ title: 't', goal: 'g', steps: [{ ...steps[0], lines: 999 }] })?.steps[0]?.lines ===
      80,
  )
  ok(
    'malformed step dropped, valid one kept',
    validateTour({ title: 't', goal: 'g', steps: [null, steps[0], { id: 'x' }] })?.steps.length === 1,
  )
  ok('no steps -> rejected', validateTour({ title: 't', goal: 'g', steps: [null] }) === undefined)
  ok('wrong shape -> rejected', validateTour('hello') === undefined)
  ok('missing title -> rejected', validateTour({ goal: 'g', steps }) === undefined)
  ok('empty fields -> rejected', validateTour({ title: '  ', goal: 'g', steps }) === undefined)
  ok(
    'bare minimum step defaults',
    validateTour({ title: 't', goal: 'g', steps: [{ id: 'a', title: 'A', file: 'f.ts' }] })
      ?.steps[0]?.start === 1,
  )
}

console.log('\nprogress')

{
  let p = emptyProgress()
  ok('fresh progress is empty', Object.keys(p.steps).length === 0)

  p = recordStep(p, 'step-01', { netWpm: 41.2, accuracy: 0.98 })
  p = recordStep(p, 'step-01', { netWpm: 50, accuracy: 1 })
  const r = p.steps['step-01'] as Record<string, unknown>
  ok('attempts accumulate', r.attempts === 2, `got ${r.attempts}`)
  ok('last values win', r.lastWpm === 50, `got ${r.lastWpm}`)
  ok('best accuracy never falls', r.bestAccuracy === 1)
  ok('completed when accuracy reaches 1', r.completed === true)

  p = recordStep(p, 'step-02', { netWpm: 30, accuracy: 0.8 })
  ok('low accuracy attempt not complete', !isDone(p, 'step-02'))
  ok('accuracy is kept', (p.steps['step-02'] as Record<string, unknown>).bestAccuracy === 0.8)
}

console.log('\ncurrentStepIndex')

{
  const tour = validateTour({
    title: 't',
    goal: 'g',
    steps,
  }) as NonNullable<ReturnType<typeof validateTour>>
  let p = emptyProgress()
  ok('starts at first step', currentStepIndex(tour, p) === 0)
  p = recordStep(p, 'step-01', { netWpm: 40, accuracy: 1 })
  ok('moves past completed steps', currentStepIndex(tour, p) === 1)
  p = recordStep(p, 'step-02', { netWpm: 40, accuracy: 1 })
  ok('all done -> first step', currentStepIndex(tour, p) === 0)
}

console.log('\nnormalizeProgress')

{
  ok('garbage -> clean empty', Object.keys(normalizeProgress('nope').steps).length === 0)
  ok('bad row dropped', Object.keys(normalizeProgress({ steps: { a: null, b: 3 } }).steps).length === 0)
  const p = normalizeProgress({
    steps: { 'step-01': { completed: true, attempts: 2, lastAccuracy: 0.97, lastWpm: 38.4 } },
  })
  ok('good row kept', p.steps['step-01']?.completed === true && p.steps['step-01']?.attempts === 2)
  ok('non-numeric ignored', p.steps['step-01']?.lastUp === undefined)
}

console.log('\nprogressSummary')

{
  const tour = validateTour({
    title: 't',
    goal: 'g',
    steps: [...steps, { ...steps[1], id: 'step-03', title: 'The third stop' }],
  }) as NonNullable<ReturnType<typeof validateTour>>
  let p = emptyProgress()
  p = recordStep(p, 'step-01', { netWpm: 41.25, accuracy: 0.98 })
  p = recordStep(p, 'step-02', { netWpm: 30, accuracy: 0.8 })
  const text = progressSummary(tour, p)
  ok('one line per step', text.split('\n').length === 3, `got ${text.split('\n').length}`)
  ok('untraced rows say so', text.includes('not traced'), text)
  ok('incomplete rows ask for a retrace', text.includes('not completed — retrace wanted'), text)
  ok('numbers rounded', text.includes('41 wpm / 98%'), text)
}

console.log('\nlineSlice')

{
  const text = 'one\ntwo\nthree\n'
  ok('single line', lineSlice(text, 1, 1) === 'one\n')
  ok('two lines', lineSlice(text, 2, 2) === 'two\nthree\n')
  ok('last line without trailing newline', lineSlice('a\nb', 2, 4) === 'b')
  ok('start past end -> empty tail', lineSlice(text, 99, 1) === '')
  ok('range past end clamps to end', lineSlice(text, 2, 99) === 'two\nthree\n')
  ok('empty text', lineSlice('', 1, 5) === '')
}

console.log('\ntourPaths')

{
  ok('tour path', tourPaths.tour() === '.aitrace/tour.json')
  ok('progress path', tourPaths.progress() === '.aitrace/tour-progress.json')
  ok('custom root', tourPaths.tour('my-trace') === 'my-trace/tour.json')
}

console.log(failures === 0 ? '\nAll tour checks passed.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
