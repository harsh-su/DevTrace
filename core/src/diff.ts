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

/** Cap on the character-level Myers edit distance before using line anchors. */
const MAX_EDIT_DISTANCE = 1200
/**
 * Cap on the line-level edit distance. Lines change far less often than
 * characters, so this is only reached by a near-total rewrite.
 */
const MAX_LINE_EDIT_DISTANCE = 1200

type Op = { kind: 'eq' | 'del' | 'ins'; text: string }

/**
 * Myers O(ND) diff over an array of tokens (UTF-16 code units or whole lines).
 * Returns the edit script, or null when the edit distance exceeds `maxDistance`.
 */
function myersOps(a: string[], b: string[], maxDistance: number): Op[] | null {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  if (n === 0) return b.map((text) => ({ kind: 'ins' as const, text }))
  if (m === 0) return a.map((text) => ({ kind: 'del' as const, text }))

  const max = Math.min(n + m, maxDistance)
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

/** Character-level diff over UTF-16 code units. */
function diffOps(before: string, after: string): Op[] | null {
  return myersOps(before.split(''), after.split(''), MAX_EDIT_DISTANCE)
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

/** Build hunks from one edit script, relative to the scanned text. */
function hunksFromOps(ops: Op[]): Hunk[] {
  const hunks: Hunk[] = []
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
      hunks.push(current)
    }
    if (op.kind === 'del') {
      current.oldText += op.text
      offset += op.text.length
    } else {
      current.newText += op.text
      afterOffset += op.text.length
    }
  }

  return hunks
}

/**
 * Coalesce micro-hunks separated by small intra-line unchanged gaps (e.g. within
 * a word) so one small edit stays one hunk.
 */
function coalesceHunks(before: string, hunks: Hunk[]): Hunk[] {
  if (hunks.length <= 1) return hunks

  const coalesced: Hunk[] = [{ ...hunks[0]! }]
  for (let i = 1; i < hunks.length; i++) {
    const prev = coalesced[coalesced.length - 1]!
    const curr = hunks[i]!
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

/** Split text into lines, keeping each line's trailing newline. */
function splitLines(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

/** Offset of each line, plus one entry for the end of the text. */
function lineStarts(lines: string[]): number[] {
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length
  }
  starts.push(offset)
  return starts
}

function commonLinePrefix(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

/**
 * Refine one contiguous block of changed lines with a character-level diff. The
 * block is already free of unchanged lines, so a coarse hunk here cannot pull in
 * unrelated code between hunks.
 */
function refineBlock(
  before: string,
  after: string,
  bStart: number,
  bEnd: number,
  aStart: number,
  aEnd: number,
): Hunk[] {
  const bText = before.slice(bStart, bEnd)
  const aText = after.slice(aStart, aEnd)
  const ops = diffOps(bText, aText)
  if (ops) {
    return hunksFromOps(ops).map((h) => ({
      ...h,
      start: h.start + bStart,
      afterStart: h.afterStart + aStart,
    }))
  }
  const coarse = diffHunk(bText, aText)
  if (coarse.oldText === '' && coarse.newText === '') return []
  return [{ ...coarse, start: coarse.start + bStart, afterStart: coarse.afterStart + aStart }]
}

/**
 * Line-anchored fallback used when the character-level edit distance exceeds the
 * cap. Unchanged lines stay `eq` ops, so two distant edits (or an edit followed
 * by a large insertion) become separate hunks instead of one coarse span.
 */
function diffHunksByLines(before: string, after: string): Hunk[] {
  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)
  const beforeStarts = lineStarts(beforeLines)
  const afterStarts = lineStarts(afterLines)
  const ops = myersOps(beforeLines, afterLines, MAX_LINE_EDIT_DISTANCE)

  if (!ops) {
    // A near-total rewrite: trim the common lines, then treat the middle as one
    // block. This is still tighter than trimming only characters.
    const prefix = commonLinePrefix(beforeLines, afterLines)
    let suffix = 0
    const limit = Math.min(beforeLines.length, afterLines.length) - prefix
    while (
      suffix < limit &&
      beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
    ) {
      suffix++
    }
    return coalesceHunks(
      before,
      refineBlock(
        before,
        after,
        beforeStarts[prefix]!,
        beforeStarts[beforeLines.length - suffix]!,
        afterStarts[prefix]!,
        afterStarts[afterLines.length - suffix]!,
      ),
    )
  }

  const hunks: Hunk[] = []
  let b = 0
  let a = 0
  let blockB = -1
  let blockA = -1
  const flush = (): void => {
    if (blockB < 0) return
    hunks.push(
      ...refineBlock(
        before,
        after,
        beforeStarts[blockB]!,
        beforeStarts[b]!,
        afterStarts[blockA]!,
        afterStarts[a]!,
      ),
    )
    blockB = -1
    blockA = -1
  }

  for (const op of ops) {
    if (op.kind === 'eq') {
      flush()
      b++
      a++
      continue
    }
    if (blockB < 0) {
      blockB = b
      blockA = a
    }
    if (op.kind === 'del') b++
    else a++
  }
  flush()

  return coalesceHunks(before, hunks)
}

/**
 * All minimal changed hunks between two versions of a file. Distant edits become
 * separate hunks, so a trace never scores the unchanged text between them.
 */
export function diffHunks(before: string, after: string): Hunk[] {
  if (before === after) return []

  const ops = diffOps(before, after)
  if (ops) return coalesceHunks(before, hunksFromOps(ops))

  return diffHunksByLines(before, after)
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

