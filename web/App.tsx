import { useCallback, useEffect, useRef, useState } from 'react'
import RepoPicker from './components/RepoPicker.js'
import FileList, { type RepoFile } from './components/FileList.js'
import {
  Results,
  SourceView,
  ThemeToggle,
  useTheme,
  useTraceInput,
  initAudio,
  isMuted,
  playClick,
  playComplete,
  setMuted,
  type FeedbackKind,
} from '@devtrace/ui'
import { createTrace, finalizeAll, metrics, topOffenders, type Metrics, type Trace } from '@devtrace/core'

type Screen = 'pick' | 'browse' | 'trace' | 'done'

const RECENTS_KEY = 'devtrace.recents'

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    const arr: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string').slice(0, 8) : []
  } catch {
    return []
  }
}

/** A chunk that starts or ends on a blank line is pure friction. */
function trimForTyping(text: string): string {
  return text.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '')
}

function lineAt(t: Trace, off: number): number {
  if (t.doc.text.length === 0) return 0
  const o = Math.max(0, Math.min(off, t.doc.text.length - 1))
  return t.doc.lineOf[o] as number
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('pick')
  const [root, setRoot] = useState('')
  const [repoName, setRepoName] = useState('')
  const [files, setFiles] = useState<RepoFile[]>([])
  const [recents, setRecents] = useState<string[]>(loadRecents)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chunkLabel, setChunkLabel] = useState('')
  const [final, setFinal] = useState<Metrics | null>(null)
  const [muted, setMutedState] = useState(isMuted())
  const [tick, setTick] = useState(0)
  const { theme, toggle } = useTheme()

  const traceRef = useRef<Trace | null>(null)
  const finalRef = useRef<Metrics | null>(null)
  const textRef = useRef('')
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  // --- repo -----------------------------------------------------------------

  const doScan = useCallback(async (path: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/scan?path=${encodeURIComponent(path)}`)
      const body = (await res.json()) as { error?: string; root?: string; name?: string; files?: RepoFile[] }
      if (!res.ok) throw new Error(body.error ?? `scan failed (${res.status})`)
      setRoot(body.root as string)
      setRepoName(body.name as string)
      setFiles(body.files ?? [])
      const next = [body.root as string, ...recents.filter((r) => r !== body.root)].slice(0, 8)
      setRecents(next)
      try {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
      } catch {
        /* private mode: recents are a nicety */
      }
      setScreen('browse')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [recents])

  // --- session --------------------------------------------------------------

  const startTrace = useCallback(
    async (f: RepoFile, start: number, count: number) => {
      setError(null)
      const qs = new URLSearchParams({ root, rel: f.rel, start: String(start), lines: String(count) })
      try {
        const res = await fetch(`/api/file?${qs}`)
        const body = (await res.json()) as { error?: string; text?: string }
        if (!res.ok) throw new Error(body.error ?? `read failed (${res.status})`)
        const text = trimForTyping(body.text ?? '')
        if (!text) throw new Error('That range is empty.')
        textRef.current = text
        traceRef.current = createTrace(text)
        finalRef.current = null
        setFinal(null)
        setChunkLabel(`${f.rel}:${start + 1}–${start + count}`)
        setScreen('trace')
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [root],
  )

  const trace = traceRef.current

  // Bump render versions for exactly the lines that changed, then repaint.
  const bump = useCallback((t: Trace, before: number, after: number) => {
    const n = t.doc.lines.length
    const lo = Math.max(0, Math.min(lineAt(t, before), lineAt(t, after)))
    const hi = Math.min(n - 1, Math.max(lineAt(t, before), lineAt(t, after)))
    for (let i = lo; i <= hi; i++) t.versions[i] = (t.versions[i] as number) + 1
    setTick((x) => x + 1)
  }, [])

  const finish = useCallback((t: Trace) => {
    finalizeAll(t)
    const m = metrics(t)
    finalRef.current = m
    setFinal(m)
    playComplete()
    setScreen('done')
  }, [])

  /** Same text, clean slate. Recreating the Trace is cheaper than resetting it. */
  const retrace = useCallback(() => {
    if (!textRef.current) return
    traceRef.current = createTrace(textRef.current)
    finalRef.current = null
    setFinal(null)
    setScreen('trace')
  }, [])

  /** Bail out mid-file: score whatever was typed. */
  const abandon = useCallback(() => {
    const t = traceRef.current
    if (!t || t.keystrokes.length === 0) {
      setScreen('browse')
      return
    }
    finish(t)
  }, [finish])

  // --- input ----------------------------------------------------------------

  const onFeedback = useCallback((kind: FeedbackKind) => {
    initAudio()
    playClick(kind)
  }, [])
  const onBump = useCallback(
    (before: number, after: number) => {
      const t = traceRef.current
      if (t) bump(t, before, after)
    },
    [bump],
  )
  const onEscape = useCallback(() => setScreen('browse'), [])
  const onCompleteInput = useCallback((t: Trace) => finish(t), [finish])

  useTraceInput(screen === 'trace', trace, {
    onBump,
    onComplete: onCompleteInput,
    onEscape,
    onFeedback,
  })

  // --- follow the caret -----------------------------------------------------

  useEffect(() => {
    const c = scrollerRef.current
    if (screen !== 'trace' || !c) return
    const line = c.querySelector<HTMLElement>('.ln.cur')
    line?.scrollIntoView({ block: 'nearest' })
    const caret = c.querySelector<HTMLElement>('.caret')
    if (caret) {
      const x = caret.offsetLeft
      const rel = x - c.scrollLeft
      if (rel > c.clientWidth * 0.75 || rel < 0) c.scrollLeft = x - c.clientWidth * 0.3
    }
  }, [tick, screen])

  useEffect(() => {
    if (screen !== 'trace') return
    const c = scrollerRef.current
    if (c) {
      c.scrollTop = 0
      c.scrollLeft = 0
    }
  }, [chunkLabel, screen])

  const toggleMute = () => {
    const next = !muted
    setMuted(next)
    setMutedState(next)
  }

  // --- render ---------------------------------------------------------------

  const fab = (
    <div className="theme-fab">
      <ThemeToggle theme={theme} onToggle={toggle} />
    </div>
  )

  if (screen === 'pick') {
    return (
      <>
        {fab}
        <RepoPicker onScan={doScan} busy={busy} error={error} recents={recents} />
      </>
    )
  }

  if (screen === 'browse') {
    return (
      <div>
        {fab}
        {error && <div className="err floating">{error}</div>}
        <FileList files={files} onStart={startTrace} onBack={() => setScreen('pick')} />
        <div className="repohead">
          <b>{repoName}</b> <span>{root}</span>
        </div>
      </div>
    )
  }

  if (screen === 'done' && trace && final) {
    return (
      <>
        {fab}
        <Results
          offenders={topOffenders(trace)}
          metrics={final}
          label={chunkLabel}
          onRetrace={retrace}
          onAnother={() => setScreen('browse')}
          onFiles={() => setScreen('browse')}
        />
      </>
    )
  }

  if (!trace) return null

  const progress = trace.doc.text.length
    ? Math.round((trace.cursor / trace.doc.text.length) * 100)
    : 0

  let correctCount = 0
  let errCount = 0
  let firstT: number | null = null
  let lastT: number | null = null
  for (const k of trace.keystrokes) {
    if (k.ok) correctCount++
    else errCount++
    if (firstT === null || k.t < firstT) firstT = k.t
    if (lastT === null || k.t > lastT) lastT = k.t
  }
  const elapsedMin = firstT !== null && lastT !== null && lastT > firstT ? (lastT - firstT) / 60000 : 0
  const liveWpm = elapsedMin > 0 ? Math.round((correctCount / 5) / elapsedMin) : 0
  const liveAcc = correctCount + errCount > 0 ? Math.round((correctCount / (correctCount + errCount)) * 100) : 100

  let nextKeyHint = ''
  if (trace.cursor < trace.doc.text.length) {
    const ch = trace.doc.text[trace.cursor]
    if (ch === ' ') nextKeyHint = '␣ Space'
    else if (ch === '\t') nextKeyHint = '⇥ Tab'
    else if (ch === '\n') nextKeyHint = '↵ Enter'
    else nextKeyHint = ch
  }

  return (
    <div className="tracing">
      <header className="topbar">
        <div className="chunk-info">
          <button className="ghost" onClick={() => setScreen('browse')}>
            ← Files
          </button>
          <span className="file-badge" title={chunkLabel}>📄 {chunkLabel}</span>
        </div>

        <div className="hud-stats">
          <div className="hud-pill stat-wpm" title="Live typing speed">
            <span className="hud-label">⚡ WPM</span>
            <span className="hud-val">{liveWpm}</span>
          </div>

          <div className="hud-pill stat-acc" title="Live typing accuracy">
            <span className="hud-label">🎯 ACC</span>
            <span className="hud-val">{liveAcc}%</span>
          </div>

          {nextKeyHint && (
            <div className="hud-pill stat-next" title="Next character to type">
              <span className="hud-label">NEXT</span>
              <span className="hud-key">{nextKeyHint}</span>
            </div>
          )}
        </div>

        <div className="hud-controls">
          <div className="progress">
            <div className="pbar">
              <div className="pfill" style={{ width: `${progress}%` }} />
            </div>
            <span className="pnum">{progress}%</span>
          </div>

          <button className="icon-btn" onClick={toggleMute} title={muted ? 'Unmute typing sounds' : 'Mute typing sounds'}>
            {muted ? '🔇' : '🔊'}
          </button>
          <ThemeToggle theme={theme} onToggle={toggle} />
          <button className="ghost end-btn" onClick={abandon}>
            End
          </button>
        </div>
      </header>

      <SourceView
        lines={trace.doc.lines}
        lineStarts={trace.doc.lineStarts}
        states={trace.states}
        wrongAt={trace.wrongAt}
        versions={trace.versions}
        cursor={trace.cursor}
        lineOf={trace.doc.lineOf}
        scrollerRef={scrollerRef}
      />

      <footer className="foot">
        Type over the characters. Errors turn red and the cursor keeps moving —
        fix them with ⌫ if you want the accuracy to count.
        <span className="esc">⌃⏎ to skip a line · esc to exit</span>
      </footer>
    </div>
  )
}
