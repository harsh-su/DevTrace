import { useEffect } from 'react'
import {
  autoAdvanceLeadingIndent,
  autoAdvanceNonTypable,
  autocompleteLine,
  backspace,
  isComplete,
  press,
  recordError,
  skipLine,
  type Trace,
} from '@devtrace/core'

export type FeedbackKind = 'ok' | 'err' | 'enter' | 'tab' | 'skip'

export interface TraceInputHandlers {
  /** Fired after a keystroke moved the cursor, with the before/after offsets. */
  onBump?: (before: number, after: number) => void
  /** Fired once when the trace reaches the end of the target. */
  onComplete?: (trace: Trace) => void
  /** Escape was pressed while tracing. */
  onEscape?: () => void
  /** Optional per-keystroke feedback (e.g. audio). */
  onFeedback?: (kind: FeedbackKind) => void
}

/**
 * The keyboard contract shared by every DevTrace surface. It is deliberately
 * host-agnostic: the browser tab and the VS Code webview both attach it and get
 * identical scoring, because both feed the same `@devtrace/core` engine.
 */
export function useTraceInput(active: boolean, trace: Trace | null, handlers: TraceInputHandlers): void {
  const { onBump, onComplete, onEscape, onFeedback } = handlers

  useEffect(() => {
    if (!active || !trace) return
    const t = trace

    // Auto-advance emojis / non-typable characters on start
    const now = performance.now()
    const initBefore = t.cursor
    autoAdvanceNonTypable(t, now)
    if (t.cursor !== initBefore) {
      onBump?.(initBefore, t.cursor)
    }

    const onKey = (e: KeyboardEvent) => {
      // Ctrl/Cmd+Enter jumps past the current line without typing it.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.key === 'NumpadEnter')) {
        e.preventDefault()
        if (isComplete(t)) return
        const before = t.cursor
        if (skipLine(t, performance.now())) {
          onFeedback?.('skip')
          onBump?.(before, t.cursor)
          if (isComplete(t)) onComplete?.(t)
        }
        return
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === 'Escape') {
        e.preventDefault()
        onEscape?.()
        return
      }
      if (isComplete(t)) return

      const now = performance.now()

      if (e.key === 'Backspace') {
        e.preventDefault()
        const before = t.cursor
        if (backspace(t, now)) {
          onFeedback?.('ok')
          onBump?.(before, t.cursor)
        }
        return
      }

      e.preventDefault()
      const before = t.cursor

      if (e.key === 'Tab') {
        autocompleteLine(t, now)
        onFeedback?.('tab')
        onBump?.(before, t.cursor)
        if (isComplete(t)) onComplete?.(t)
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
          // Stop on error: records error without runaway cursor jump
          recordError(t, e.key, now)
          onFeedback?.('err')
        }
      } else {
        return
      }

      onBump?.(before, t.cursor)
      if (isComplete(t)) onComplete?.(t)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, trace, onBump, onComplete, onEscape, onFeedback])
}
