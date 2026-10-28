/**
 * Minimal changed hunk between two versions of a file. `start`/`oldText` locate
 * the replaced region in `before`; `newText` is what replaces it. Used to turn an
 * AI edit into a traceable region: the extension only ghosts and scores the part
 * that actually changed.
 */
export interface Hunk {
  /** Offset in `before` where the changed region starts. */
  start: number
  /** Offset in `after` where the changed region starts. */
  afterStart: number
  /** Text being replaced (empty for a pure insertion). */
  oldText: string
  /** Text being inserted (empty for a pure deletion). */
  newText: string
}

/**
 * A single hunk found by trimming the common prefix and suffix. Exact for one
 * localized edit, but spans the whole gap between two distant edits — prefer
 * `diffHunks`, which splits those apart.
 */
export function diffHunk(before: string, after: string): Hunk {
  if (before === after) return { start: before.length, afterStart: after.length, oldText: '', newText: '' }

  const n = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < n && before[prefix] === after[prefix]) prefix++

  let suffix = 0
  while (
    suffix < n - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++
  }

  return {
    start: prefix,
    afterStart: prefix,
    oldText: before.slice(prefix, before.length - suffix),
    newText: after.slice(prefix, after.length - suffix),
  }
}

/** Cap on the Myers edit distance before we fall back to a coarse single hunk. */
const MAX_EDIT_DISTANCE = 1200

type Op = { kind: 'eq' | 'del' | 'ins'; text: string }

/**
 * Myers O(ND) diff over UTF-16 code units. Returns the edit script, or null when
 * the edit distance exceeds `MAX_EDIT_DISTANCE` (a near-total rewrite, where the
 * quadratic trace would be wasteful and a coarse hunk is good enough).
 */
function diffOps(before: string, after: string): Op[] | null {
  const a = before.split('')
  const b = after.split('')
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  if (n === 0) return b.map((text) => ({ kind: 'ins' as const, text }))
  if (m === 0) return a.map((text) => ({ kind: 'del' as const, text }))

  const max = Math.min(n + m, MAX_EDIT_DISTANCE)
  const v = new Map<number, number>()
  const trace: Map<number, number>[] = []

  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v))
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && (v.get(k - 1) ?? -Infinity) < (v.get(k + 1) ?? -Infinity))) {
        x = v.get(k + 1) ?? 0
      } else {
        x = (v.get(k - 1) ?? 0) + 1
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v.set(k, x)
      if (x >= n && y >= m) return backtrack(trace, a, b)
    }
  }
  return null
}

/** Walk a stored Myers trace backwards into a forward edit script. */
function backtrack(trace: Map<number, number>[], a: string[], b: string[]): Op[] {
  const ops: Op[] = []
  let x = a.length
  let y = b.length

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && (v.get(k - 1) ?? -Infinity) < (v.get(k + 1) ?? -Infinity))) {
      prevK = k + 1
    } else {
      prevK = k - 1
    }
    const prevX = v.get(prevK) ?? 0
    const prevY = prevX - prevK

    while (x > prevX && y > prevY) {
      ops.push({ kind: 'eq', text: a[x - 1]! })
      x--
      y--
    }
    if (d > 0) {
      if (x > prevX) {
        ops.push({ kind: 'del', text: a[x - 1]! })
      } else {
        ops.push({ kind: 'ins', text: b[y - 1]! })
      }
      x = prevX
      y = prevY
    }
  }
  return ops.reverse()
}

/**
 * All minimal changed hunks between two versions of a file. Distant edits become
 * separate hunks, so a trace never scores the unchanged text between them.
 */
export function diffHunks(before: string, after: string): Hunk[] {
  if (before === after) return []

  const ops = diffOps(before, after)
  if (!ops) {
    const coarse = diffHunk(before, after)
    return coarse.oldText === '' && coarse.newText === ''
      ? []
      : [coarse]
  }

  const rawHunks: Hunk[] = []
  let current: Hunk | undefined
  let offset = 0
  let afterOffset = 0

  for (const op of ops) {
    if (op.kind === 'eq') {
      offset += op.text.length
      afterOffset += op.text.length
      current = undefined
      continue
    }
    if (!current) {
      current = { start: offset, afterStart: afterOffset, oldText: '', newText: '' }
      rawHunks.push(current)
    }
    if (op.kind === 'del') {
      current.oldText += op.text
      offset += op.text.length
    } else {
      current.newText += op.text
      afterOffset += op.text.length
    }
  }

  // Coalesce micro-hunks that are separated by small intra-line unchanged gaps (e.g. within a word)
  if (rawHunks.length <= 1) return rawHunks

  const coalesced: Hunk[] = [{ ...rawHunks[0]! }]
  for (let i = 1; i < rawHunks.length; i++) {
    const prev = coalesced[coalesced.length - 1]!
    const curr = rawHunks[i]!
    const gap = before.slice(prev.start + prev.oldText.length, curr.start)
    if (!gap.includes('\n') && gap.length <= 8) {
      prev.oldText += gap + curr.oldText
      prev.newText += gap + curr.newText
    } else {
      coalesced.push({ ...curr })
    }
  }

  return coalesced
}

/**
 * The unedited code that surrounds a hunk, so a trace panel can show the change
 * in its original neighbourhood. Only the hunk itself is traceable; these lines
 * are rendered read-only for context.
 */
export interface TraceContext {
  /** Complete lines above the hunk, nearest last. */
  before: string[]
  /** Complete lines below the hunk, nearest first. */
  after: string[]
  /** 1-based line number of the first traced line. */
  startLine: number
  /** Text on the first traced line that precedes the change. */
  linePrefix: string
  /** Text on the last traced line that follows the change. */
  lineSuffix: string
}

/**
 * Split the file around a hunk into the context a reader needs. The hunk often
 * starts and ends mid-line, so the partial fragments are returned separately as
 * `linePrefix`/`lineSuffix` rather than smuggled into the line lists.
 */
export function traceContext(current: string, hunk: Hunk, radius = 3): TraceContext {
  const beforeLines = current.slice(0, hunk.start).split('\n')
  const linePrefix = beforeLines.pop() ?? ''
  const startLine = beforeLines.length + 1

  const afterLines = current.slice(hunk.start + hunk.oldText.length).split('\n')
  const lineSuffix = afterLines.shift() ?? ''

  return {
    before: beforeLines.slice(-radius),
    after: afterLines.slice(0, radius),
    startLine,
    linePrefix,
    lineSuffix,
  }
}

/** Character-level diff between the frozen base and the live text. */
export interface SpanDiff {
  /** Offset in the live text where the difference starts. */
  prefix: number
  /** Text present in `base` but not `now` (what a restore must put back). */
  baseChanged: string
  /** Text present in `now` but not `base` (what the user just typed). */
  nowChanged: string
}

export function diffSpan(base: string, now: string): SpanDiff {
  const n = Math.min(base.length, now.length)
  let prefix = 0
  while (prefix < n && base[prefix] === now[prefix]) prefix++
  let suffix = 0
  while (
    suffix < n - prefix &&
    base[base.length - 1 - suffix] === now[now.length - 1 - suffix]
  ) {
    suffix++
  }
  return {
    prefix,
    baseChanged: base.slice(prefix, base.length - suffix),
    nowChanged: now.slice(prefix, now.length - suffix),
  }
}

/** A change the editor reported, reduced to what a tracer needs. */
export interface Insertion {
  /** Offset in the pre-change text. */
  offset: number
  /** Inserted text (empty for a deletion). */
  text: string
}

export interface ResolvedEdit {
  /** What the user typed at the caret, or undefined if this edit is not theirs. */
  typed: string | undefined
  /** How to put the document back to `base`. */
  restore: SpanDiff
}

/**
 * Decide what a document change means.
 *
 * Position is taken from the editor's reported `offset` (which is in the
 * pre-change text), not from the text diff: typing "a" at the start of "aaa"
 * diffs to the *end* of the run, so a text diff cannot tell where the caret was.
 * The diff is still used to restore the frozen document, where it is exact.
 */
export function resolveEdit(
  base: string,
  now: string,
  insertions: Insertion[],
  expected: number,
): ResolvedEdit {
  const restore = diffSpan(base, now)

  let typed: string | undefined
  for (const ins of insertions) {
    if (ins.text.length > 0 && ins.offset === expected) {
      typed = ins.text
      break
    }
  }

  if (
    typed === undefined &&
    restore.baseChanged.length === 0 &&
    restore.prefix === expected &&
    restore.nowChanged.length > 0
  ) {
    typed = restore.nowChanged
  }

  return { typed, restore }
}

