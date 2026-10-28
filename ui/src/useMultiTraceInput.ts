import { useEffect } from 'react'
import { advanceSkipped, backspace, isComplete, press, skipLine, tabFill, type Trace } from '@devtrace/core'
import type { FeedbackKind } from './useTraceInput.js'

export interface MultiTraceInputHandlers {
  /** Fired after a keystroke moved the cursor, with the hunk and its offsets. */
  onBump?: (index: number, before: number, after: number) => void
  /** Fired when the active hunk is fully typed and more hunks remain. */
  onHunkComplete?: (index: number) => void
  /** Fired when the last typeable hunk is fully typed. */
  onAllComplete?: () => void
  /** Escape was pressed while tracing. */
  onEscape?: () => void
  /** Optional per-keystroke feedback (e.g. audio). */
  onFeedback?: (kind: FeedbackKind) => void
}

function lineAt(t: Trace, off: number): number {
  if (t.doc.text.length === 0) return 0
  const o = Math.max(0, Math.min(off, t.doc.text.length - 1))
  return t.doc.lineOf[o] as number
}

/**
 * The keyboard contract for a file-wise trace: several hunks of one file are
 * scored together, but only the active hunk accepts input. Completing a hunk
 * hands off to the next one; completing the last one finishes the session.
 * The keyboard behaviour per hunk is identical to `useTraceInput`.
 */
export function useMultiTraceInput(
  active: boolean,
  traces: Trace[],
  activeIndex: number,
  handlers: MultiTraceInputHandlers,
): void {
  const { onBump, onHunkComplete, onAllComplete, onEscape, onFeedback } = handlers

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      // Escape always exits, even when the change has no typeable hunk.
      if (e.key === 'Escape') {
        e.preventDefault()
        onEscape?.()
        return
      }

      const t = traces[activeIndex]
      if (!t) return
      advanceSkipped(t)

      const done = (): void => {
        if (!isComplete(t)) return
        if (activeIndex < traces.length - 1) onHunkComplete?.(activeIndex)
        else onAllComplete?.()
      }

      // Ctrl/Cmd+Enter jumps past the current line without typing it.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.key === 'NumpadEnter')) {
        e.preventDefault()
        if (isComplete(t)) return
        const before = t.cursor
        if (skipLine(t, performance.now())) {
          onFeedback?.('skip')
          onBump?.(activeIndex, before, t.cursor)
          done()
        }
        return
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isComplete(t)) return

      const now = performance.now()

      if (e.key === 'Backspace') {
        e.preventDefault()
        const before = t.cursor
        if (backspace(t, now)) {
          advanceSkipped(t)
          onFeedback?.('ok')
          onBump?.(activeIndex, before, t.cursor)
        }
        return
      }

      e.preventDefault()
      const before = t.cursor

      if (e.key === 'Tab') {
        const li = lineAt(t, t.cursor)
        const soFar = t.doc.text.slice(t.doc.lineStarts[li] as number, t.cursor)
        for (const ch of tabFill(soFar)) press(t, ch, now, 'tab')
        onFeedback?.('tab')
        onBump?.(activeIndex, before, t.cursor)
        done()
        return
      }

      if (e.key === 'Enter') {
        press(t, '\n', now, 'newline')
        onFeedback?.('enter')
      } else if (e.key.length === 1) {
        const expected = t.doc.text[t.cursor]
        const ok = press(t, e.key, now)
        if (ok) onFeedback?.(e.key === expected ? 'ok' : 'err')
      } else {
        return
      }

      onBump?.(activeIndex, before, t.cursor)
      done()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, traces, activeIndex, onBump, onHunkComplete, onAllComplete, onEscape, onFeedback])
}
