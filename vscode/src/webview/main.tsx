import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  aggregateMetrics,
  buildDoc,
  CONTEXT,
  createTrace,
  finalizeAll,
  isComplete,
  skipLine,
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
  initAudio,
  isMuted,
  playClick,
  playComplete,
  setMuted,
  useMultiTraceInput,
  useTheme,
  type FeedbackKind,
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
}

type Phase = 'idle' | 'brief' | 'trace' | 'done'

/** Offset -> line, over the whole proposed file. */
function lineAtDoc(doc: Doc, off: number): number {
  if (doc.text.length === 0) return 0
  const o = Math.max(0, Math.min(off, doc.text.length - 1))
  return doc.lineOf[o] as number
}

function ProposalPane({ regions, activeIndex }: { regions: RegionInit[]; activeIndex: number }) {
  return (
    <aside className="proposal-pane" aria-label="AI proposed edits">
      <div className="proposal-kicker">AI proposal</div>
      <p className="proposal-copy">Read the change first. Only the separate trace surface accepts your typing.</p>
      <div className="proposal-list">
        {regions.map((region, index) => (
          <section className={`proposal-card${index === activeIndex ? ' active' : ''}`} key={`${region.start}-${index}`}>
            <div className="proposal-card-head">
              <span>Change {index + 1}</span>
              <span>{region.target.length} chars</span>
            </div>
            <pre>{region.target || '(deletion)'}</pre>
          </section>
        ))}
      </div>
    </aside>
  )
}

function App() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [label, setLabel] = useState('')
  const [mode, setMode] = useState<NonNullable<InitMessage['mode']>>('proposal')
  const [brief, setBrief] = useState('')
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
      total += (regions[i] as RegionInit).target.length
      done += traces[i]?.cursor ?? 0
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
      const traces = m.regions.map((r) => createTrace(r.target))
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
      setBrief(m.brief ?? '')
      setFinal(null)
      setOffenders([])
      let first = -1
      for (let i = 0; i < m.regions.length; i++) {
        if ((m.regions[i] as RegionInit).target.length > 0) {
          first = i
          break
        }
      }
      setActiveIndex(first)
      setTick(0)
      setPhase(m.mode === 'tour' ? 'brief' : 'trace')
      postProgress()
    }
    window.addEventListener('message', onMessage)
    vscode.postMessage({ type: 'ready' })
    return () => window.removeEventListener('message', onMessage)
  }, [postProgress])

  const [soundMuted, setSoundMutedState] = useState(isMuted())
  const toggleSound = useCallback(() => {
    const next = !soundMuted
    setMuted(next)
    setSoundMutedState(next)
  }, [soundMuted])

  const finishAll = useCallback(() => {
    const traces = tracesRef.current
    for (const t of traces) finalizeAll(t)
    setFinal(aggregateMetrics(traces))
    setOffenders(topOffendersAcross(traces))
    playComplete()
    setPhase('done')
  }, [])

  const onFeedback = useCallback((kind: FeedbackKind) => {
    initAudio()
    playClick(kind)
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
      let next = -1
      for (let i = index + 1; i < regions.length; i++) {
        if ((regions[i] as RegionInit).target.length > 0) {
          next = i
          break
        }
      }
      if (next >= 0) setActiveIndex(next)
      else finishAll()
    },
    [finishAll],
  )

  const goToHunk = useCallback((index: number) => {
    const regions = regionsRef.current
    if (index < 0 || index >= regions.length) return
    setActiveIndex(index)
    setTick((x) => x + 1)
  }, [])

  const acceptCurrentHunk = useCallback(() => {
    const t = tracesRef.current[activeIndex]
    const region = regionsRef.current[activeIndex]
    if (!t || !region) return
    while (!isComplete(t)) {
      skipLine(t, performance.now())
    }
    syncRegion(activeIndex)
    setTick((x) => x + 1)
    onHunkComplete(activeIndex)
  }, [activeIndex, onHunkComplete, syncRegion])

  const acceptAllAndSave = useCallback(() => {
    const regions = regionsRef.current
    vscode.postMessage({ type: 'save', texts: regions.map((r) => r.target) })
  }, [])

  const skipHunk = useCallback(() => {
    const t = tracesRef.current[activeIndex]
    if (!t) return
    while (!isComplete(t)) {
      skipLine(t, performance.now())
    }
    syncRegion(activeIndex)
    setTick((x) => x + 1)
    onHunkComplete(activeIndex)
  }, [activeIndex, onHunkComplete, syncRegion])

  const onLineClick = useCallback(
    (li: number) => {
      const doc = docRef.current
      const regions = regionsRef.current
      if (!doc) return
      for (let i = 0; i < regions.length; i++) {
        const r = regions[i] as RegionInit
        const startLine = doc.lineOf[r.start] as number
        const endOffset = Math.max(r.start, r.start + r.target.length - 1)
        const endLine = doc.lineOf[endOffset] as number
        if (li >= startLine && li <= endLine) {
          goToHunk(i)
          return
        }
      }
    },
    [goToHunk],
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
    const traces = regions.map((r) => createTrace(r.target))
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
      if ((regions[i] as RegionInit).target.length > 0) {
        first = i
        break
      }
    }
    setActiveIndex(first)
    setFinal(null)
    setOffenders([])
    setTick(0)
    setPhase('trace')
    postProgress()
  }, [postProgress])

  useMultiTraceInput(phase === 'trace', tracesRef.current, activeIndex, {
    onBump,
    onHunkComplete,
    onAllComplete: finishAll,
    onEscape: discard,
    onFeedback,
  })

  // Center the active hunk line in view when switching hunks or on mount
  useEffect(() => {
    const c = scrollerRef.current
    if (phase !== 'trace' || !c) return
    const targetEl = c.querySelector<HTMLElement>('.ln.cur') ?? c.querySelector<HTMLElement>('.ln.hunk-line')
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeIndex, phase])

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

  // Compute live typing speed (WPM) & accuracy
  let totalCorrect = 0
  let totalErrors = 0
  let earliestT: number | null = null
  let latestT: number | null = null

  for (const t of traces) {
    for (const k of t.keystrokes) {
      if (k.ok) totalCorrect++
      else totalErrors++
      if (earliestT === null || k.t < earliestT) earliestT = k.t
      if (latestT === null || k.t > latestT) latestT = k.t
    }
  }

  const elapsedMin = earliestT !== null && latestT !== null && latestT > earliestT
    ? (latestT - earliestT) / 60000
    : 0
  const liveWpm = elapsedMin > 0 ? Math.round((totalCorrect / 5) / elapsedMin) : 0
  const liveAcc = totalCorrect + totalErrors > 0
    ? Math.round((totalCorrect / (totalCorrect + totalErrors)) * 100)
    : 100

  let nextKeyHint = ''
  let nextTokenHint = ''
  if (active && active.cursor < active.doc.text.length) {
    const text = active.doc.text
    const cur = active.cursor
    const ch = text[cur]!
    if (ch === ' ') nextKeyHint = '␣ Space'
    else if (ch === '\t') nextKeyHint = '⇥ Tab'
    else if (ch === '\n') nextKeyHint = '↵ Enter'
    else nextKeyHint = ch

    // Check if at word/identifier token start
    if (/[a-zA-Z_]/.test(ch) && (cur === 0 || !/[a-zA-Z0-9_]/.test(text[cur - 1]!))) {
      let wEnd = cur
      while (wEnd < text.length && /[a-zA-Z0-9_]/.test(text[wEnd]!)) wEnd++
      const word = text.slice(cur, wEnd)
      if (word.length > 1) {
        nextTokenHint = word
      }
    }
  }

  return (
    <div className="tracing">
      <header className="topbar">
        <div className="chunk-info">
          <span className="file-badge" title={label}>📄 {label}</span>
          {regions.length > 1 && (
            <div className="hunk-nav">
              <button
                className="hud-nav-btn"
                onClick={() => goToHunk(activeIndex - 1)}
                disabled={activeIndex <= 0}
                title="Previous hunk (or click any hunk line in the editor)"
              >
                ◀
              </button>
              <span className="hud-pill hunk-pill" title={`Hunk ${activeIndex + 1} of ${regions.length} — click line to jump`}>
                Hunk <b>{activeIndex + 1}</b> / {regions.length}
              </span>
              <button
                className="hud-nav-btn"
                onClick={() => goToHunk(activeIndex + 1)}
                disabled={activeIndex >= regions.length - 1}
                title="Next hunk (or click any hunk line in the editor)"
              >
                ▶
              </button>
            </div>
          )}
        </div>

        <div className="hud-stats">
          <div className="hud-pill stat-wpm" title="Live typing speed (Words Per Minute)">
            <span className="hud-label">⚡ WPM</span>
            <span className="hud-val">{liveWpm}</span>
          </div>

          <div className="hud-pill stat-acc" title="Live typing accuracy">
            <span className="hud-label">🎯 ACC</span>
            <span className="hud-val">{liveAcc}%</span>
          </div>

          {nextKeyHint && (
            <div className="hud-pill stat-next" title={`Next: ${nextKeyHint}${nextTokenHint ? ` (${nextTokenHint})` : ''}`}>
              <span className="hud-label">NEXT</span>
              <span className="hud-key">{nextKeyHint}</span>
              {nextTokenHint && <span className="hud-token-preview">({nextTokenHint})</span>}
            </div>
          )}
        </div>

        <div className="hud-controls">
          <div className="progress" title={`${progress}% complete`}>
            <div className="pbar">
              <div className="pfill" style={{ width: `${progress}%` }} />
            </div>
            <span className="pnum">{progress}%</span>
          </div>

          <button
            className="icon-btn sound-toggle"
            onClick={toggleSound}
            title={soundMuted ? 'Unmute typing sounds' : 'Mute typing sounds'}
          >
            {soundMuted ? '🔇' : '🔊'}
          </button>

          <ThemeToggle theme={theme} onToggle={toggle} />

          <button
            className="hud-btn hud-accept-hunk"
            onClick={acceptCurrentHunk}
            title="Accept this hunk without typing and jump to next"
          >
            Accept Hunk ✓
          </button>

          <button
            className="hud-btn hud-accept-all"
            onClick={acceptAllAndSave}
            title="Accept all changes immediately and save to disk"
          >
            Accept All & Save ✓
          </button>

          {regions.length > 1 && activeIndex < regions.length - 1 && (
            <button className="hud-skip-btn" onClick={skipHunk} title="Skip this hunk and jump to next">
              Skip Hunk ↷
            </button>
          )}

          <button className="ghost end-btn" onClick={finishAll} title="End trace session early">
            End
          </button>
        </div>
      </header>

      <div className="trace-layout">
        {mode === 'proposal' && <ProposalPane regions={regions} activeIndex={activeIndex} />}
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
            onLineClick={onLineClick}
            language={label}
          />
        </main>
      </div>

      <footer className="foot">
        <span>Click line to jump · <kbd className="kb">Tab</kbd> autocomplete line · <kbd className="kb">Enter</kbd> auto-indent</span>
        <span className="esc"><kbd className="kb">Ctrl+Enter</kbd> skip line · <kbd className="kb">Esc</kbd> discard</span>
      </footer>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
