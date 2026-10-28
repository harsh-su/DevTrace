import { useEffect } from 'react'
import { advanceSkipped, backspace, isComplete, press, skipLine, tabFill, type Trace } from '@devtrace/core'

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

function lineAt(t: Trace, off: number): number {
  if (t.doc.text.length === 0) return 0
  const o = Math.max(0, Math.min(off, t.doc.text.length - 1))
  return t.doc.lineOf[o] as number
}

/**
 * The keyboard contract shared by every DevTrace surface. It is deliberately
 * host-agnostic: the browser tab and the VS Code webview both attach it and get
 * identical scoring, because both feed the same `@devtrace/core` engine.
 */
export function useTraceInput(active: boolean, trace: Trace | null, handlers: TraceInputHandlers): void {
  const { onBump, onComplete, onEscape, onFeedback } = handlers

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const t = trace
      if (!t) return
      advanceSkipped(t)

      // Ctrl/Cmd+Enter jumps past the current line without typing it. Handled
      // before the modifier guard below, which would otherwise swallow it.
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
          advanceSkipped(t)
          onFeedback?.('ok')
          onBump?.(before, t.cursor)
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
        onBump?.(before, t.cursor)
        if (isComplete(t)) onComplete?.(t)
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

      onBump?.(before, t.cursor)
      if (isComplete(t)) onComplete?.(t)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, trace, onBump, onComplete, onEscape, onFeedback])
}
