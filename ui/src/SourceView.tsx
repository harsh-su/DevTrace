import { memo } from 'react'
import { buildRuns, stateClass, tokenizeLine } from '@devtrace/core'
import type { CharState } from '@devtrace/core'

export interface LineProps {
  text: string
  off: number
  states: Uint8Array
  wrongAt: Map<number, string>
  num: number
  isCur: boolean
  /** Column of the caret, or -1 when this line doesn't hold it. */
  caret: number
  /** Bumped whenever this line's character states change. Drives the memo. */
  v: number
  /** Read-only text that precedes the trace on the first traced line. */
  prefix?: string
  /** Read-only text that follows the trace on the last traced line. */
  suffix?: string
  /** Whether this line belongs to a changed hunk. */
  isHunk?: boolean
  /** Called when this line is clicked. */
  onClick?: () => void
  /** Language identifier or file path for syntax highlighting. */
  language?: string
}

/**
 * Memoized on (v, isCur, caret, isHunk). `states` and `wrongAt` are stable mutable
 * refs, so the shallow compare is honest: lines you aren't touching never
 * re-render, and a keystroke costs two line updates instead of one per line in
 * the file.
 */
export const Line = memo(function Line({
  text,
  off,
  states,
  wrongAt,
  num,
  isCur,
  caret,
  v,
  prefix,
  suffix,
  isHunk,
  onClick,
  language,
}: LineProps) {
  const syntaxTags = tokenizeLine(text, language)
  const runs = buildRuns(text, states, off, isCur ? caret : -1, wrongAt, syntaxTags)
  void v
  const clsName = isCur ? 'ln cur' : isHunk ? 'ln hunk-line' : 'ln'
  return (
    <div className={clsName} onClick={onClick}>
      <span className="lnum">{num}</span>
      <span className="lcode">
        {prefix ? <span className="ctx">{prefix}</span> : null}
        {runs.map((r, i) => {
          if (r.caret) return <i key={i} className="caret" />
          const synCls = r.syn ? ` syn-${r.syn}` : ''
          const cls = r.got ? 'g' : stateClass(r.c as CharState) + (r.cur ? ' curc' : '') + synCls
          return (
            <span key={i} className={cls}>
              {r.t}
            </span>
          )
        })}
        {suffix ? <span className="ctx">{suffix}</span> : null}
      </span>
    </div>
  )
})

/** A read-only neighbour line, shown so the change can be read in context. */
const ContextLine = memo(function ContextLine({ text, num }: { text: string; num: number }) {
  return (
    <div className="ln ctxln">
      <span className="lnum">{num}</span>
      <span className="lcode">{text.length > 0 ? text : ' '}</span>
    </div>
  )
})

export interface SourceViewProps {
  lines: string[]
  lineStarts: number[]
  states: Uint8Array
  wrongAt: Map<number, string>
  versions: Uint32Array
  cursor: number
  lineOf: Uint32Array
  scrollerRef: React.RefObject<HTMLDivElement | null>
  /** 1-based number of the first traced line. Defaults to 1. */
  firstLine?: number
  /** Read-only lines above the trace, nearest last. */
  contextBefore?: string[]
  /** Read-only lines below the trace, nearest first. */
  contextAfter?: string[]
  /** Text on the first traced line that precedes the change. */
  linePrefix?: string
  /** Text on the last traced line that follows the change. */
  lineSuffix?: string
  /** Language identifier or file path for syntax highlighting. */
  language?: string
}

export default function SourceView({
  lines,
  lineStarts,
  states,
  wrongAt,
  versions,
  cursor,
  lineOf,
  scrollerRef,
  firstLine = 1,
  contextBefore = [],
  contextAfter = [],
  linePrefix,
  lineSuffix,
  language,
}: SourceViewProps) {
  const curLine = cursor < lineOf.length ? (lineOf[cursor] as number) : lines.length - 1
  const caretCol = cursor - (lineStarts[curLine] ?? 0)
  const base = firstLine - 1
  const last = lines.length - 1

  return (
    <div className="source" ref={scrollerRef}>
      {contextBefore.map((text, i) => (
        <ContextLine key={`b${i}`} text={text} num={firstLine - contextBefore.length + i} />
      ))}

      {lines.map((text, li) => (
        <Line
          key={li}
          text={text}
          off={lineStarts[li] as number}
          states={states}
          wrongAt={wrongAt}
          num={base + li + 1}
          isCur={li === curLine}
          caret={caretCol}
          v={versions[li] as number}
          prefix={li === 0 ? linePrefix : undefined}
          suffix={li === last ? lineSuffix : undefined}
          language={language}
        />
      ))}

      {contextAfter.map((text, i) => (
        <ContextLine key={`a${i}`} text={text} num={firstLine + lines.length + i} />
      ))}
    </div>
  )
}
