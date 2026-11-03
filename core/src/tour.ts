/**
 * Guided tours: an ordered learning path the AI writes, the developer traces.
 *
 * The OpenCode agent (or any author) writes `tour.json`; the extension reads it,
 * serves each step as explain-then-type in the trace panel, and appends the
 * developer's scores to `tour-progress.json`. Any agent can re-read that file
 * before writing the next steps — that is the whole feedback loop, and it is
 * plain JSON on disk so it needs no protocol, server, or repo access.
 */

/** One stop on the path. Steps are traced top to bottom. */
export interface TourStep {
  /** Stable identifier the progress file is keyed on, e.g. `step-01`. */
  id: string
  /** Short name shown in the learning-path list. */
  title: string
  /** Source file of the code to trace, workspace-relative with forward slashes. */
  file: string
  /** 1-based first line of the trace. */
  start: number
  /** How many lines, clamped to what the file has. */
  lines: number
  /** Why this step comes here — where you just were and where you're going. */
  why: string
  /** The one idea this step teaches ("the Trace state machine"). */
  concept: string
  /** Plain-English walk-through of the code being traced. */
  explanation: string
}

export interface Tour {
  title: string
  /** What tracing all the steps should add up to. */
  goal: string
  createdAt: number
  steps: TourStep[]
}

/** The developer's record for one step after tracing it. */
export interface StepRecord {
  completed?: boolean
  attempts?: number
  /** Net WPM of the most recent attempt. */
  lastWpm?: number
  /** 0..1 accuracy of the most recent attempt. */
  lastAccuracy?: number
  /** Best accuracy across attempts. */
  bestAccuracy?: number
  /** Epoch ms of the last attempt. */
  lastUp?: number
}

export interface TourProgress {
  version: 1
  steps: Record<string, StepRecord>
}

const TOUR_FILE = 'tour.json'
const PROGRESS_FILE = 'tour-progress.json'

/** Workspace-relative paths Tether's own bookkeeping lives at. */
export const tourPaths = {
  tour: (rel = '.tether') => `${rel}/${TOUR_FILE}`,
  progress: (rel = '.tether') => `${rel}/${PROGRESS_FILE}`,
}

export function emptyProgress(): TourProgress {
  return { version: 1, steps: {} }
}

/**
 * Cut `lines` lines out of `text`, starting at the 1-based `start`. Falls back
 * to the end of the file when the range runs past it, and to the last line when
 * `start` is past the end, so a stale tour still traces something sane.
 */
export function lineSlice(text: string, start: number, lines: number): string {
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)

  const from = Math.min(Math.max(0, start - 1), lineStarts.length - 1)
  const to = Math.min(Math.max(0, start - 1 + lines), lineStarts.length)
  const fromOff = lineStarts[from] as number
  return to === lineStarts.length
    ? text.slice(fromOff)
    : text.slice(fromOff, lineStarts[to] as number)
}

/**
 * Validate an untrusted JSON value as a tour. Returns a cleaned tour, or
 * undefined if it is not a tour. Fields are trimmed and the shape is normalised
 * so the tree view and panel never meet raw agent output.
 */
export function validateTour(value: unknown): Tour | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.title !== 'string' || !raw.title.trim()) return undefined
  if (typeof raw.goal !== 'string' || !raw.goal.trim()) return undefined
  if (!Array.isArray(raw.steps)) return undefined

  const steps: TourStep[] = []
  for (const s of raw.steps) {
    const step = validateStep(s)
    if (!step) continue
    steps.push(step)
  }
  if (steps.length === 0) return undefined
  return { title: raw.title.trim(), goal: raw.goal.trim(), createdAt: Date.now(), steps }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function validateStep(value: unknown): TourStep | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const s = value as Record<string, unknown>
  const id = str(s.id)
  const title = str(s.title)
  const file = str(s.file)
  if (!id || !title || !file) return undefined
  const start = typeof s.start === 'number' && Number.isFinite(s.start) ? Math.floor(s.start) : 1
  const lines = typeof s.lines === 'number' && Number.isFinite(s.lines) ? Math.floor(s.lines) : 20
  if (start < 1 || lines < 1) return undefined
  return {
    id,
    title,
    file: file.replaceAll('\\', '/'),
    start,
    lines: Math.min(lines, 80),
    why: str(s.why),
    concept: str(s.concept),
    explanation: str(s.explanation),
  }
}

/** Merge an untrusted JSON value into a progress object, ignoring bad rows. */
export function normalizeProgress(value: unknown): TourProgress {
  const out = emptyProgress()
  if (typeof value !== 'object' || value === null) return out
  const steps = (value as Record<string, unknown>).steps
  if (typeof steps !== 'object' || steps === null) return out
  for (const [id, rec] of Object.entries(steps as Record<string, unknown>)) {
    if (typeof rec !== 'object' || rec === null) continue
    const r = rec as Record<string, unknown>
    const entry: StepRecord = {
      completed: r.completed === true,
      attempts: typeof r.attempts === 'number' && r.attempts > 0 ? Math.floor(r.attempts) : 0,
      lastWpm: typeof r.lastWpm === 'number' ? r.lastWpm : undefined,
      lastAccuracy: typeof r.lastAccuracy === 'number' ? r.lastAccuracy : undefined,
      bestAccuracy: typeof r.bestAccuracy === 'number' ? r.bestAccuracy : undefined,
      lastUp: typeof r.lastUp === 'number' ? r.lastUp : undefined,
    }
    out.steps[id] = entry
  }
  return out
}

/** True when the step was traced until it was complete at least once. */
export function isDone(progress: TourProgress, stepId: string): boolean {
  return progress.steps[stepId]?.completed === true
}

/** Index of the first not-yet-completed step, or the first step at all. */
export function currentStepIndex(tour: Tour, progress: TourProgress): number {
  const i = tour.steps.findIndex((s) => !isDone(progress, s.id))
  return i === -1 ? 0 : i
}

/**
 * Fold one trace attempt into the progress file. Accuracy is clamped to 0..1;
 * `bestAccuracy` only rises; `completed` only ever becomes true — once at or
 * above the threshold, or on a flawless trace.
 */
const DONE_THRESHOLD = 0.9

export function recordStep(
  progress: TourProgress,
  stepId: string,
  attempt: { netWpm: number; accuracy: number },
): TourProgress {
  const prev = progress.steps[stepId] ?? { attempts: 0 }
  const accuracy = Math.max(0, Math.min(1, attempt.accuracy))
  return {
    ...progress,
    steps: {
      ...progress.steps,
      [stepId]: {
        ...prev,
        attempts: (prev.attempts ?? 0) + 1,
        lastWpm: attempt.netWpm,
        lastAccuracy: accuracy,
        bestAccuracy: Math.max(prev.bestAccuracy ?? 0, accuracy),
        lastUp: Date.now(),
        completed: (prev.completed ?? false) || accuracy >= DONE_THRESHOLD,
      },
    },
  }
}

/**
 * The compact summary agents are meant to read back. One line per step keeps it
 * small enough to drop straight into a prompt.
 */
export function progressSummary(tour: Tour, progress: TourProgress): string {
  const rows = tour.steps.map((s) => {
    const r = progress.steps[s.id]
    if (!r) return `${s.id}: not traced — ${s.title}`
    const pct = r.lastAccuracy !== undefined ? Math.round(r.lastAccuracy * 100) : '?'
    const wpm = r.lastWpm !== undefined ? Math.round(r.lastWpm) : '?'
    const tail = r.completed ? '' : ' (not completed — retrace wanted)'
    return `${s.id}: done=${r.completed === true}, attempts=${r.attempts ?? 0}, last ${wpm} wpm / ${pct}%${tail} — ${s.title}`
  })
  return rows.join('\n')
}
