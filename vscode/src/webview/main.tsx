import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  aggregateMetrics,
  buildDoc,
  CONTEXT,
  SKIPPED,
  createTrace,
  languageId,
  markSkipped,
  skipRuns,
  advanceSkipped,
  finalizeAll,
  isComplete,
  topOffendersAcross,
  typedText,
  type Doc,
  type Metrics,
  type Offender,
  type Trace,
} from '@devtrace/core'
import {
  FileTraceView,
  Results,
  ThemeToggle,
  useMultiTraceInput,
  useTheme,
} from '@devtrace/ui'
import '../../../ui/src/styles.css'

interface VsCodeApi {
  postMessage(message: unknown): void
}
declare function acquireVsCodeApi(): VsCodeApi
const vscode = acquireVsCodeApi()

/** One changed hunk of the file, located in the proposed `after` text. */
interface RegionInit {
  start: number
  target: string
}

interface InitMessage {
  type: 'init'
  after: string
  label: string
  regions: RegionInit[]
  /** `proposal` (AI diffs, default) or `tour` (explain-then-type the whole range). */
  mode?: 'proposal' | 'tour'
  /** Tour mode only: the plain-English explanation shown before typing. */
  brief?: string
  language?: ReturnType<typeof languageId>
}

type Phase = 'idle' | 'brief' | 'trace' | 'done'

/** Offset -> line, over the whole proposed file. */
function lineAtDoc(doc: Doc, off: number): number {
  if (doc.text.length === 0) return 0
  const o = Math.max(0, Math.min(off, doc.text.length - 1))
  return doc.lineOf[o] as number
}

function App() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [label, setLabel] = useState('')
  const [mode, setMode] = useState<NonNullable<InitMessage['mode']>>('proposal')
  const [brief, setBrief] = useState('')
  const [language, setLanguage] = useState<ReturnType<typeof languageId>>('none')
  const [activeIndex, setActiveIndex] = useState(-1)
  const [final, setFinal] = useState<Metrics | null>(null)
  const [offenders, setOffenders] = useState<Offender[]>([])
  const [tick, setTick] = useState(0)
  const { theme, toggle } = useTheme()

  const docRef = useRef<Doc | null>(null)
  const regionsRef = useRef<RegionInit[]>([])
  const tracesRef = useRef<Trace[]>([])
  const statesRef = useRef<Uint8Array>(new Uint8Array(0))
  const wrongAtRef = useRef<Map<number, string>>(new Map())
  const versionsRef = useRef<Uint32Array>(new Uint32Array(0))
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  /** Copy one hunk's live states back into the whole-file arrays. */
  const syncRegion = useCallback((index: number): void => {
    const region = regionsRef.current[index]
    const t = tracesRef.current[index]
    if (!region || !t) return
    const states = statesRef.current
    const wrongAt = wrongAtRef.current
    for (let k = 0; k < t.doc.text.length; k++) {
      states[region.start + k] = t.states[k] as number
      const abs = region.start + k
      const pressed = t.wrongAt.get(k)
      if (pressed !== undefined) wrongAt.set(abs, pressed)
      else wrongAt.delete(abs)
    }
  }, [])

  const postProgress = useCallback(() => {
    const regions = regionsRef.current
    const traces = tracesRef.current
    let total = 0
    let done = 0
    for (let i = 0; i < regions.length; i++) {
      const trace = traces[i]
      if (!trace) continue
      for (let k = 0; k < trace.states.length; k++) {
        if (trace.states[k] === SKIPPED) continue
        total++
        if (trace.states[k] !== 0) done++
      }
    }
    const pct = total > 0 ? Math.round((done / total) * 100) : 100
    vscode.postMessage({ type: 'progress', pct })
  }, [])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as InitMessage | undefined
      if (m?.type !== 'init') return

      const doc = buildDoc(m.after)
      const states = new Uint8Array(m.after.length).fill(CONTEXT)
      const wrongAt = new Map<number, string>()
      const versions = new Uint32Array(doc.lines.length + 1)
       const runs = skipRuns(m.after, m.language ?? 'none')
       const traces = m.regions.map((r) => {
         const trace = createTrace(r.target)
         for (const run of runs) {
           const start = Math.max(run.start - r.start, 0)
           const end = Math.min(run.end - r.start, r.target.length)
           if (end > start) markSkipped(trace, start, end)
         }
         advanceSkipped(trace)
         return trace
       })
      for (let i = 0; i < m.regions.length; i++) {
        const r = m.regions[i] as RegionInit
        const t = traces[i] as Trace
        for (let k = 0; k < r.target.length; k++) states[r.start + k] = t.states[k] as number
      }

      docRef.current = doc
      regionsRef.current = m.regions
      tracesRef.current = traces
      statesRef.current = states
      wrongAtRef.current = wrongAt
      versionsRef.current = versions

      setLabel(m.label)
       setMode(m.mode ?? 'proposal')
       setLanguage(m.language ?? 'none')
      setBrief(m.brief ?? '')
      setFinal(null)
      setOffenders([])
      let first = -1
      for (let i = 0; i < m.regions.length; i++) {
        if (!isComplete(traces[i] as Trace)) {
          first = i
          break
        }
      }
      setActiveIndex(first)
      setTick(0)
       if (m.mode === 'tour') setPhase('brief')
       else if (first >= 0) setPhase('trace')
       else {
         setFinal(aggregateMetrics(traces))
         setOffenders(topOffendersAcross(traces))
         setPhase('done')
       }
      postProgress()
    }
    window.addEventListener('message', onMessage)
    vscode.postMessage({ type: 'ready' })
    return () => window.removeEventListener('message', onMessage)
  }, [postProgress])

  const finishAll = useCallback(() => {
    const traces = tracesRef.current
    for (const t of traces) finalizeAll(t)
    setFinal(aggregateMetrics(traces))
    setOffenders(topOffendersAcross(traces))
    setPhase('done')
  }, [])

  const onBump = useCallback(
    (index: number, before: number, after: number) => {
      const doc = docRef.current
      const region = regionsRef.current[index]
      if (!doc || !region) return
      syncRegion(index)
      const versions = versionsRef.current
      const lo = lineAtDoc(doc, region.start + Math.min(before, after))
      const hi = lineAtDoc(doc, region.start + Math.max(before, after))
      for (let i = lo; i <= hi; i++) versions[i] = (versions[i] as number) + 1
      setTick((x) => x + 1)
      postProgress()
    },
    [postProgress, syncRegion],
  )

  const onHunkComplete = useCallback(
    (index: number) => {
      const regions = regionsRef.current
      const traces = tracesRef.current
      let next = -1
      for (let i = index + 1; i < regions.length; i++) {
        if (!isComplete(traces[i] as Trace)) {
          next = i
          break
        }
      }
      if (next >= 0) setActiveIndex(next)
      else finishAll()
    },
    [finishAll],
  )

  const discard = useCallback(() => {
    vscode.postMessage({ type: 'discard' })
  }, [])

  const start = useCallback(() => {
    setPhase('trace')
  }, [])

  const save = useCallback(() => {
    const traces = tracesRef.current
    const finalMetrics = aggregateMetrics(traces)
    vscode.postMessage({
      type: 'save',
      texts: traces.map((t) => typedText(t)),
      metrics: { netWpm: finalMetrics.netWpm, accuracy: finalMetrics.accuracy },
    })
  }, [])

  const retrace = useCallback(() => {
    const regions = regionsRef.current
    const states = statesRef.current
    const versions = versionsRef.current
     const runs = skipRuns(docRef.current?.text ?? '', language)
     const traces = regions.map((r) => {
       const trace = createTrace(r.target)
       for (const run of runs) {
         const start = Math.max(run.start - r.start, 0)
         const end = Math.min(run.end - r.start, r.target.length)
         if (end > start) markSkipped(trace, start, end)
       }
       advanceSkipped(trace)
       return trace
     })
    states.fill(CONTEXT)
    wrongAtRef.current.clear()
    versions.fill(0)
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i] as RegionInit
      const t = traces[i] as Trace
      for (let k = 0; k < r.target.length; k++) states[r.start + k] = t.states[k] as number
    }
    tracesRef.current = traces
    let first = -1
    for (let i = 0; i < regions.length; i++) {
       if (!isComplete(traces[i] as Trace)) {
        first = i
        break
      }
    }
    setActiveIndex(first)
    setFinal(null)
    setOffenders([])
    setTick(0)
     if (first >= 0) setPhase('trace')
     else {
       setFinal(aggregateMetrics(traces))
       setOffenders(topOffendersAcross(traces))
       setPhase('done')
     }
    postProgress()
   }, [language, postProgress])

  useMultiTraceInput(phase === 'trace', tracesRef.current, activeIndex, {
    onBump,
    onHunkComplete,
    onAllComplete: finishAll,
    onEscape: discard,
  })

  useEffect(() => {
    const c = scrollerRef.current
    if (phase !== 'trace' || !c) return
    c.querySelector<HTMLElement>('.ln.cur')?.scrollIntoView({ block: 'nearest' })
  }, [tick, activeIndex, phase])

  useEffect(() => {
    if (phase !== 'trace') return
    const c = scrollerRef.current
    if (c) c.scrollTop = 0
  }, [label, phase])

  if (phase === 'idle') return <div className="empty">Waiting for a change to trace…</div>

  if (phase === 'brief') {
    return (
      <div className="tour-brief">
        <header className="topbar">
          <span className="chunklabel">{label}</span>
          <ThemeToggle theme={theme} onToggle={toggle} />
        </header>
        <main className="brief-main">
          <article className="brief-card">
            <div className="brief-kicker">Before you type</div>
            <div className="brief-body">{brief}</div>
            <div className="brief-hint">
              Reading is step one. When you trace this code below, your hands
              write it too — that is how it stays.
            </div>
          </article>
        </main>
        <footer className="brief-actions">
          <button className="go" onClick={start}>
            Start typing
          </button>
          <button className="ghost" onClick={discard}>
            Later
          </button>
        </footer>
      </div>
    )
  }

  const doc = docRef.current
  const traces = tracesRef.current
  const regions = regionsRef.current

  if (phase === 'done' && final) {
    const mismatch =
      mode === 'proposal' && regions.some((r, i) => typedText(traces[i] as Trace) !== r.target)
    return (
      <Results
        offenders={offenders}
        metrics={final}
        label={label}
        title={mode === 'tour' ? 'Step typed' : 'Change traced'}
        note={
          mismatch ? (
            <div className="panel-note">
              <span>Saving writes exactly what you typed, which differs from the proposed code.</span>
            </div>
          ) : undefined
        }
        onRetrace={retrace}
        onAnother={discard}
        onFiles={discard}
        actions={
          <div className="ractions">
            <button className="go" onClick={save}>
              {mode === 'tour' ? 'Mark step done' : 'Save typed code'}
            </button>
            <button onClick={retrace}>Trace again</button>
            <button className="ghost" onClick={discard}>
              {mode === 'tour' ? 'Later' : 'Discard'}
            </button>
          </div>
        }
      />
    )
  }

  if (!doc) return null

  const total = regions.reduce((s, r) => s + r.target.length, 0)
  const done = traces.reduce((s, t) => s + t.cursor, 0)
  const progress = total > 0 ? Math.round((done / total) * 100) : 100
  const active = activeIndex >= 0 ? traces[activeIndex] : undefined
  const cursorAfter = active ? (regions[activeIndex] as RegionInit).start + active.cursor : -1

  return (
    <div className="tracing">
      <header className="topbar">
        <span className="chunklabel">{label}</span>
        <div className="progress">
          <div className="pbar">
            <div className="pfill" style={{ width: `${progress}%` }} />
          </div>
          <span className="pnum">{progress}%</span>
        </div>
        <ThemeToggle theme={theme} onToggle={toggle} />
        <button className="ghost" onClick={finishAll}>
          End
        </button>
      </header>

      <div className="trace-layout">
        <main className="typing-surface">
          <div className="surface-head">
            <span>Type the highlighted change</span>
            <span className="surface-step">{activeIndex + 1} / {regions.filter((r) => r.target.length > 0).length}</span>
          </div>
          <FileTraceView
            lines={doc.lines}
            lineStarts={doc.lineStarts}
            lineOf={doc.lineOf}
            states={statesRef.current}
            wrongAt={wrongAtRef.current}
            versions={versionsRef.current}
            cursorAfter={cursorAfter}
            scrollerRef={scrollerRef}
          />
        </main>
      </div>

      <footer className="foot">
        {mode === 'proposal' ? (
          <>
            The whole file is shown; only the highlighted changes are traced. Type them
            in order — the untouched code stays as it is. Errors are kept; saving writes
            exactly what you type.
          </>
        ) : (
          <>
            Every character of this code is traced. Errors are kept, so keep moving —
            finish the pass, then retrace the mess if you want it clean.
          </>
        )}
        <span className="esc">ctrl/⌘+enter skips a line · esc to discard</span>
      </footer>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
