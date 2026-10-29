/**
 * The trace engine. Pure data, zero React, zero DOM. Every metric is derived
 * from the keystroke log at the end rather than accumulated during typing, so
 * we can change the maths later without invalidating old sessions.
 *
 * M0 scope: whole-file chunks, "advance on error" mode, Python-flavoured
 * indentation scoring. M1 adds function chunks, fix-mode, and symbol buckets.
 */

export const PENDING = 0
export const CORRECT = 1
export const WRONG = 2
/** Accepted untouched via the skip shortcut: kept in the artifact, not typed. */
export const SKIPPED = 3
/**
 * Read-only file text a multi-region trace renders around its editable hunks.
 * Never written into a real `Trace`'s `states`; only the full-file view layer
 * uses it, to mark a character that is context rather than a target.
 */
export const CONTEXT = 4
export type CharState = 0 | 1 | 2 | 3 | 4

export interface Keystroke {
  /** Absolute offset into doc.text that this keystroke targeted. */
  i: number
  got: string
  exp: string
  ok: boolean
  t: number
  kind: 'type' | 'back' | 'tab' | 'newline' | 'skip'
}

export interface Doc {
  text: string
  lines: string[]
  /** Offset of the first character of each line. */
  lineStarts: number[]
  /** offset -> line number. */
  lineOf: Uint32Array
  /** Number of leading whitespace characters per line. */
  indentLen: Uint16Array
  /** Lines that actually carry indentation (the denominator for indent accuracy). */
  indentedLines: number
}

export function buildDoc(text: string): Doc {
  const lines = text.split('\n')
  const lineStarts: number[] = []
  const indentLen: number[] = []
  let indentedLines = 0
  let off = 0
  for (const line of lines) {
    lineStarts.push(off)
    let n = 0
    while (n < line.length && (line[n] === ' ' || line[n] === '\t')) n++
    indentLen.push(n)
    if (n > 0) indentedLines++
    off += line.length + 1 // +1 for the '\n'
  }
  const lineOf = new Uint32Array(text.length)
  let li = 0
  for (let i = 0; i < text.length; i++) {
    while (li + 1 < lineStarts.length && lineStarts[li + 1]! <= i) li++
    lineOf[i] = li
  }
  return {
    text,
    lines,
    lineStarts,
    lineOf,
    indentLen: Uint16Array.from(indentLen),
    indentedLines,
  }
}

export interface Trace {
  doc: Doc
  states: Uint8Array
  cursor: number
  keystrokes: Keystroke[]
  firstT: number | null
  lastT: number | null
  /** Per-line render version. Bumped only for lines whose state changed. */
  versions: Uint32Array
  finalized: Uint8Array
  indentHits: number
  indentMisses: number
  lineErrors: number
  /**
   * Offset -> the key the user actually pressed. Needed to render your own
   * character next to the source one on a miss; a Set of offsets can't hold it.
   */
  wrongAt: Map<number, string>
}

export function createTrace(text: string): Trace {
  const doc = buildDoc(text)
  return {
    doc,
    states: new Uint8Array(doc.text.length),
    cursor: 0,
    keystrokes: [],
    firstT: null,
    lastT: null,
    versions: new Uint32Array(doc.lines.length + 1),
    finalized: new Uint8Array(doc.lines.length + 1),
    indentHits: 0,
    indentMisses: 0,
    lineErrors: 0,
    wrongAt: new Map(),
  }
}

/** Mark source ranges that should be retained but never typed or scored. */
export function markSkipped(t: Trace, start: number, end: number): void {
  const lo = Math.max(0, start)
  const hi = Math.min(t.states.length, end)
  for (let i = lo; i < hi; i++) t.states[i] = SKIPPED
}

/** Move over pre-skipped source until the next typeable character. */
export function advanceSkipped(t: Trace): number {
  while (t.cursor < t.doc.text.length && t.states[t.cursor] === SKIPPED) t.cursor++
  return t.cursor
}

export function isComplete(t: Trace): boolean {
  return t.cursor >= t.doc.text.length
}

/** Tabs advance to the next stop, they don't insert a fixed run. Matches how Python is actually written. */
export const TAB_WIDTH = 4
export function tabFill(currentLine: string): string {
  return ' '.repeat(TAB_WIDTH - (currentLine.length % TAB_WIDTH))
}

function finalizeLine(t: Trace, li: number): void {
  if (t.finalized[li] === 1) return
  t.finalized[li] = 1
  const start = t.doc.lineStarts[li]!
  const len = (t.doc.lines[li] as string).length
  // A line the developer chose to skip was never theirs to type, so it neither
  // passes nor fails the indent check.
  for (let i = start; i < start + len; i++) {
    if (t.states[i] === SKIPPED) return
  }
  const n = t.doc.indentLen[li]!
  if (n === 0 || start === undefined) return
  let bad = 0
  for (let k = 0; k < n; k++) {
    if (t.states[start + k] === WRONG) bad++
  }
  if (bad === 0) t.indentHits++
  else {
    t.indentMisses++
    for (let k = 0; k < n; k++) if (t.states[start + k] === WRONG) t.lineErrors++
  }
}

/** Character typed at the cursor. Always advances; errors are counted, not blocking. */
export function press(t: Trace, got: string, now: number, kind: Keystroke['kind'] = 'type'): boolean {
  if (isComplete(t)) return false
  const i = t.cursor
  const exp = t.doc.text[i] as string
  const ok = got === exp

  if (t.states[i] !== PENDING) t.finalized[t.doc.lineOf[i] as number] = 0
  t.states[i] = ok ? CORRECT : WRONG
  if (ok) t.wrongAt.delete(i)
  else t.wrongAt.set(i, got)
  t.keystrokes.push({ i, got, exp, ok, t: now, kind })
  if (t.firstT === null) t.firstT = now
  t.lastT = now
  t.cursor = i + 1

  // A line is finished exactly when the character just typed is its newline.
  // (Triggering off "the cursor moved" scored the indent before you'd even
  // finished typing the line — see the lineOf[cursor-1] mistake.)
  if (t.doc.text[i] === '\n') {
    finalizeLine(t, t.doc.lineOf[i] as number)
  }
  return true
}

export function isNonTypableUnicode(text: string, index = 0): number {
  if (!text || index >= text.length) return 0
  const code = text.codePointAt(index) ?? 0
  if (code > 127) {
    const glyph = String.fromCodePoint(code)
    if (/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE00-\uFE0F\u200D\u20E3\u2500-\u2BFF]/u.test(glyph)) {
      return glyph.length
    }
  }
  return 0
}

/** Automatically advance past emojis or non-typable unicode glyphs. */
export function autoAdvanceNonTypable(t: Trace, now: number): void {
  while (!isComplete(t)) {
    const skipLen = isNonTypableUnicode(t.doc.text, t.cursor)
    if (skipLen > 0) {
      for (let k = 0; k < skipLen; k++) {
        const ch = t.doc.text[t.cursor] as string
        press(t, ch, now, 'type')
      }
    } else {
      break
    }
  }
}

/** Automatically advance past leading indentation spaces/tabs on a new line. */
export function autoAdvanceLeadingIndent(t: Trace, now: number): void {
  while (!isComplete(t)) {
    const ch = t.doc.text[t.cursor] as string
    if (ch === ' ' || ch === '\t') {
      press(t, ch, now, 'indent')
    } else {
      break
    }
  }
  autoAdvanceNonTypable(t, now)
}

/** Autocomplete the rest of the current line with target code. */
export function autocompleteLine(t: Trace, now: number): boolean {
  if (isComplete(t)) return false
  const curLine = t.doc.lineOf[t.cursor] as number
  while (!isComplete(t) && (t.doc.lineOf[t.cursor] as number) === curLine) {
    const ch = t.doc.text[t.cursor] as string
    press(t, ch, now, 'type')
  }
  autoAdvanceLeadingIndent(t, now)
  return true
}

/** Record a typo at the current cursor without advancing (Stop on Error mode). */
export function recordError(t: Trace, got: string, now: number): void {
  if (isComplete(t)) return
  const i = t.cursor
  const exp = t.doc.text[i] as string
  t.states[i] = WRONG
  t.wrongAt.set(i, got)
  t.keystrokes.push({ i, got, exp, ok: false, t: now, kind: 'type' })
  if (t.firstT === null) t.firstT = now
  t.lastT = now
}

export function backspace(t: Trace, now: number): boolean {
  // If the cursor is currently on an error character (from stop-on-error), clear it first
  if (t.states[t.cursor] === WRONG) {
    const i = t.cursor
    t.states[i] = PENDING
    t.wrongAt.delete(i)
    t.keystrokes.push({ i, got: '', exp: t.doc.text[i] as string, ok: true, t: now, kind: 'back' })
    t.lastT = now
    return true
  }
  if (t.cursor === 0) return false
  const i = t.cursor - 1
  t.states[i] = PENDING
  t.wrongAt.delete(i)
  t.finalized[t.doc.lineOf[i] as number] = 0
  t.keystrokes.push({ i, got: '', exp: t.doc.text[i] as string, ok: true, t: now, kind: 'back' })
  t.lastT = now
  t.cursor = i
  return true
}

/**
 * Jump past the line the cursor is on, accepting that line's source text
 * untouched. Skipped characters keep the proposed glyph, so saving writes them
 * verbatim (a skip means "not now", not "delete this"), but they are excluded
 * from typing metrics — you didn't type them. The newline is consumed too, so
 * the cursor lands at the start of the next line.
 */
export function skipLine(t: Trace, now: number): boolean {
  if (isComplete(t)) return false
  const li = t.doc.lineOf[t.cursor] as number
  const start = t.doc.lineStarts[li] as number
  const lineLen = (t.doc.lines[li] as string).length
  let end = start + lineLen
  if (t.doc.text[end] === '\n') end++
  if (end <= t.cursor) return false

  for (let i = t.cursor; i < end; i++) {
    t.states[i] = SKIPPED
    t.wrongAt.delete(i)
    t.keystrokes.push({ i, got: '', exp: t.doc.text[i] as string, ok: true, t: now, kind: 'skip' })
  }
  t.cursor = end
  if (t.firstT === null) t.firstT = now
  t.lastT = now
  finalizeLine(t, li)
  return true
}

/**
 * Reconstruct exactly what the user typed at the current cursor: a prefix of
 * the target with the keys actually pressed substituted at every wrong offset.
 * A PENDING offset (never reached, or backspaced away) contributes nothing, so
 * an unfinished session yields only the prefix the user actually wrote. This is
 * the artifact to write to disk when a trace is saved as-typed.
 */
export function typedText(t: Trace): string {
  const out: string[] = []
  for (let i = 0; i < t.cursor; i++) {
    const st = t.states[i] as CharState
    if (st === CORRECT || st === SKIPPED) out.push(t.doc.text[i] as string)
    else if (st === WRONG) out.push(t.wrongAt.get(i) ?? (t.doc.text[i] as string))
  }
  return out.join('')
}

export function finalizeAll(t: Trace): void {
  for (let li = 0; li < t.doc.lines.length; li++) {
    const start = t.doc.lineStarts[li] as number
    if (start >= t.cursor) break
    // Only score lines the cursor actually reached the end of. A line you
    // walked away from mid-way shouldn't count as a clean indent.
    const end = start + (t.doc.lines[li] as string).length
    if (t.cursor < end) break
    finalizeLine(t, li)
  }
}

export interface Metrics {
  chars: number
  correct: number
  errors: number
  backspaces: number
  /** Lines accepted untouched with the skip shortcut. Not typed, not scored. */
  skipped: number
  /** Seconds between first and last keystroke. */
  seconds: number
  /** Correct chars per 5, per minute. */
  netWpm: number
  /** All keystrokes per 5, per minute. Penalises correcting. */
  rawWpm: number
  accuracy: number
  /** 1 - (coefficient of variation of per-5-char chunk times). */
  consistency: number
  indentLines: number
  indentHits: number
  indentMisses: number
  indentAccuracy: number
  /** Mean seconds between keystrokes, for pacing diagnosis. */
  avgIntervalMs: number
}

/** The raw material every metric is derived from, so one trace and a bundle of
 * traces can be scored by the exact same formulas. */
interface MetricsInput {
  keystrokes: Keystroke[]
  skipped: number
  indentHits: number
  indentMisses: number
  firstT: number | null
  lastT: number | null
}

function computeMetrics(input: MetricsInput): Metrics {
  const { keystrokes, skipped, indentHits, indentMisses, firstT, lastT } = input
  const typed = keystrokes.filter((k) => k.kind !== 'back' && k.kind !== 'skip')
  const correct = typed.filter((k) => k.ok).length
  const errors = typed.length - correct
  const backspaces = keystrokes.filter((k) => k.kind === 'back').length

  const seconds = firstT !== null && lastT !== null ? Math.max(0, (lastT - firstT) / 1000) : 0
  const minutes = seconds / 60
  const netWpm = minutes > 0 ? correct / 5 / minutes : 0
  const rawWpm = minutes > 0 ? typed.length / 5 / minutes : 0
  const accuracy = typed.length > 0 ? correct / typed.length : 0

  // Consistency from the spread of per-word (5 char) chunk durations.
  let consistency = 0
  if (typed.length >= 20 && seconds > 0) {
    const perWord: number[] = []
    for (let i = 0; i + 5 <= typed.length; i += 5) {
      const a = typed[i] as Keystroke
      const b = typed[i + 4] as Keystroke
      const d = (b.t - a.t) / 1000
      if (d > 0) perWord.push(d)
    }
    if (perWord.length > 1) {
      const mean = perWord.reduce((s, v) => s + v, 0) / perWord.length
      const sd = Math.sqrt(perWord.reduce((s, v) => s + (v - mean) ** 2, 0) / perWord.length)
      consistency = Math.max(0, Math.min(1, 1 - sd / mean))
    }
  }

  const indentLines = indentHits + indentMisses
  const indentAccuracy = indentLines > 0 ? indentHits / indentLines : 1

  const avgIntervalMs = typed.length > 1 && seconds > 0
    ? (seconds * 1000) / (typed.length - 1)
    : 0

  return {
    chars: typed.length,
    correct,
    errors,
    backspaces,
    skipped,
    seconds,
    netWpm,
    rawWpm,
    accuracy,
    consistency,
    indentLines,
    indentHits,
    indentMisses,
    indentAccuracy,
    avgIntervalMs,
  }
}

export function metrics(t: Trace): Metrics {
  let skipped = 0
  for (let i = 0; i < t.states.length; i++) if (t.states[i] === SKIPPED) skipped++
  return computeMetrics({
    keystrokes: t.keystrokes,
    skipped,
    indentHits: t.indentHits,
    indentMisses: t.indentMisses,
    firstT: t.firstT,
    lastT: t.lastT,
  })
}

/**
 * Score several traces — the changed hunks of one file — as a single session.
 * Keystrokes are merged in timestamp order and every formula runs over the
 * combined log, so the aggregate is identical to having traced it in one go.
 */
export function aggregateMetrics(traces: Trace[]): Metrics {
  const keystrokes: Keystroke[] = []
  let skipped = 0
  let indentHits = 0
  let indentMisses = 0
  let firstT: number | null = null
  let lastT: number | null = null
  for (const t of traces) {
    for (const k of t.keystrokes) keystrokes.push(k)
    for (let i = 0; i < t.states.length; i++) if (t.states[i] === SKIPPED) skipped++
    indentHits += t.indentHits
    indentMisses += t.indentMisses
    if (t.firstT !== null && (firstT === null || t.firstT < firstT)) firstT = t.firstT
    if (t.lastT !== null && (lastT === null || t.lastT > lastT)) lastT = t.lastT
  }
  keystrokes.sort((a, b) => a.t - b.t)
  return computeMetrics({ keystrokes, skipped, indentHits, indentMisses, firstT, lastT })
}

/**
 * Where the weakest symbols were, for the post-session breakdown.
 *
 * Keys are `got\0exp`. NUL, not a space, and not an object key: a keystroke or
 * an expected character can itself be a space, so a space separator would make
 * `split(' ')` return ['',''] and report every space miss as got="" exp="".
 * NUL can't appear in either. Keep this as the two-character escape `\0` — a
 * raw 0x00 byte in the source makes git treat the whole file as binary and
 * refuse to diff it.
 */
export interface Offender {
  got: string
  expected: string
  count: number
}

export function topOffendersFrom(keystrokes: Keystroke[], limit = 12): Offender[] {
  const m = new Map<string, number>()
  for (const k of keystrokes) {
    if (k.kind === 'back' || k.ok) continue
    const key = `${k.got}\0${k.exp}`
    m.set(key, (m.get(key) ?? 0) + 1)
  }
  return [...m.entries()]
    .map(([key, count]) => {
      const [got, expected] = key.split('\0')
      return { got: got as string, expected: expected as string, count }
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

export function topOffenders(t: Trace, limit = 12): Offender[] {
  return topOffendersFrom(t.keystrokes, limit)
}

/** Most-missed keys across several traces of the same file. */
export function topOffendersAcross(traces: Trace[], limit = 12): Offender[] {
  const keystrokes: Keystroke[] = []
  for (const t of traces) for (const k of t.keystrokes) keystrokes.push(k)
  return topOffendersFrom(keystrokes, limit)
}
