import { Line } from './SourceView.js'

export interface FileTraceViewProps {
  /** Every line of the proposed file, in order. */
  lines: string[]
  /** Offset of the first character of each line. */
  lineStarts: number[]
  /** offset -> line number, over the whole file. */
  lineOf: Uint32Array
  /**
   * One state per file character. Characters inside a hunk carry that hunk's
   * state; everything else is `CONTEXT`, rendered as read-only surroundings.
   */
  states: Uint8Array
  /** offset -> the key pressed there, over the whole file. */
  wrongAt: Map<number, string>
  /** Per-line render version, bumped when a hunk on that line changes. */
  versions: Uint32Array
  /** Cursor of the active hunk, mapped into file offsets, or -1 when idle. */
  cursorAfter: number
  scrollerRef: React.RefObject<HTMLDivElement | null>
  /** Optional click handler when a line is clicked */
  onLineClick?: (lineIndex: number) => void
  /** Language identifier or file path for syntax highlighting. */
  language?: string
}

/**
 * The whole file, with only the changed hunks typeable. The file reads as
 * itself — line numbers are real, context is intact — and the edit stands out
 * because the untouched text is rendered in the quieter context colour while
 * the pending, correct, and wrong states land on the hunks.
 */
export default function FileTraceView({
  lines,
  lineStarts,
  lineOf,
  states,
  wrongAt,
  versions,
  cursorAfter,
  scrollerRef,
  onLineClick,
  language,
}: FileTraceViewProps) {
  const last = lines.length - 1
  const curLine = cursorAfter < 0 ? -1 : cursorAfter < lineOf.length ? (lineOf[cursorAfter] as number) : last
  const caretCol = curLine >= 0 ? cursorAfter - (lineStarts[curLine] ?? 0) : -1

  return (
    <div className="source" ref={scrollerRef}>
      {lines.map((text, li) => {
        const off = lineStarts[li] as number
        let isHunk = false
        const len = text.length
        for (let c = 0; c < len; c++) {
          if (states[off + c] !== 4) {
            isHunk = true
            break
          }
        }
        return (
          <Line
            key={li}
            text={text}
            off={off}
            states={states}
            wrongAt={wrongAt}
            num={li + 1}
            isCur={li === curLine}
            caret={caretCol}
            v={versions[li] as number}
            isHunk={isHunk}
            onClick={() => onLineClick?.(li)}
            language={language}
          />
        )
      })}
    </div>
  )
}
