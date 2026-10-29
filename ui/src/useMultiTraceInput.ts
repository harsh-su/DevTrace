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

/**
 * The keyboard contract for a file-wise trace: several hunks of one file are
 * scored together, but only the active hunk accepts input. Completing a hunk
 * hands off to the next one; completing the last one finishes the session.
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
    const t = traces[activeIndex]
    if (t) {
      // Auto-advance any emojis or non-typable symbols waiting at the cursor on entry
      const now = performance.now()
      const before = t.cursor
      autoAdvanceNonTypable(t, now)
      if (t.cursor !== before) {
        onBump?.(activeIndex, before, t.cursor)
      }
    }

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

      // Tab autocompletes the rest of the line with target code
      if (e.key === 'Tab') {
        autocompleteLine(t, now)
        onFeedback?.('tab')
        onBump?.(activeIndex, before, t.cursor)
        done()
        return
      }

      if (e.key === 'Enter') {
        const expected = t.doc.text[t.cursor]
        if (expected === '\n') {
          press(t, '\n', now, 'newline')
          autoAdvanceLeadingIndent(t, now)
          onFeedback?.('enter')
        } else {
          recordError(t, '\n', now)
          onFeedback?.('err')
        }
      } else if (e.key.length === 1) {
        const expected = t.doc.text[t.cursor]
        if (e.key === expected) {
          press(t, e.key, now)
          autoAdvanceNonTypable(t, now)
          onFeedback?.('ok')
        } else {
          // Stop on error: locks at error without runaway cursor advancement
          recordError(t, e.key, now)
          onFeedback?.('err')
        }
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
