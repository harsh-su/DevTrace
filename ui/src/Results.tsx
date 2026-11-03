import type { ReactNode } from 'react'
import type { Metrics, Offender } from '@tether/core'
import { showChar } from '@tether/core'

interface Props {
  /** The most-missed keys for the session, already tallied by the host. */
  offenders: Offender[]
  metrics: Metrics
  label: string
  /** Heading override for the panel flow. Defaults to "Session complete". */
  title?: string
  /** Message shown above the stats, e.g. a warning about uncorrected errors. */
  note?: ReactNode
  /** Replaces the default action row (used by the panel's save/discard flow). */
  actions?: ReactNode
  onRetrace: () => void
  onAnother: () => void
  onFiles: () => void
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`

export default function Results({ offenders, metrics: m, label, title, note, actions, onRetrace, onAnother, onFiles }: Props) {
  return (
    <div className="panel results">
      <div className="rhead">
        <h2>{title ?? 'Session complete'}</h2>
        <div className="rlabel">{label}</div>
      </div>

      {note}

      <div className="statgrid">
        <div className="stat big">
          <div className="v">{m.netWpm.toFixed(1)}</div>
          <div className="k">net WPM</div>
        </div>
        <div className="stat">
          <div className="v">{pct(m.accuracy)}</div>
          <div className="k">accuracy</div>
        </div>
        <div className="stat">
          <div className="v">{m.errors}</div>
          <div className="k">errors</div>
        </div>
        <div className="stat">
          <div className="v">{m.rawWpm.toFixed(1)}</div>
          <div className="k">raw WPM</div>
        </div>
        <div className="stat">
          <div className="v">{pct(m.consistency)}</div>
          <div className="k">consistency</div>
        </div>
        <div className="stat">
          <div className="v">{m.seconds.toFixed(1)}s</div>
          <div className="k">duration</div>
        </div>
        <div className="stat">
          <div className="v">{m.backspaces}</div>
          <div className="k">backspaces</div>
        </div>
        {m.skipped > 0 && (
          <div className="stat">
            <div className="v">{m.skipped}</div>
            <div className="k">skipped</div>
          </div>
        )}
        <div className="stat">
          <div className="v">{m.avgIntervalMs.toFixed(0)}ms</div>
          <div className="k">avg key</div>
        </div>
      </div>

      <div className="indentbox">
        <div className="ihead">
          <span>Indentation accuracy</span>
          <span className="ival">
            {pct(m.indentAccuracy)}{' '}
            <em>
              {m.indentHits}/{m.indentLines} lines
            </em>
          </span>
        </div>
        <div className="ibar">
          <div className="ifill" style={{ width: pct(m.indentAccuracy) }} />
        </div>
        <p className="ihint">
          Whitespace is where Python fights back. This is the number that moves
          first.
        </p>
      </div>

      {offenders.length > 0 && (
        <div className="offenders">
          <div className="ohead">Most-missed keys</div>
          <div className="ochips">
            {offenders.map((o) => (
              <span key={`${o.got}${o.expected}`} className="ochip">
                <code>{showChar(o.got)}</code>
                <span className="arrow">for</span>
                <code className="exp">{showChar(o.expected)}</code>
                <b>{o.count}</b>
              </span>
            ))}
          </div>
        </div>
      )}

      {actions ?? (
        <div className="ractions">
          <button className="go" onClick={onRetrace}>
            Trace it again
          </button>
          <button onClick={onAnother}>Another range</button>
          <button className="ghost" onClick={onFiles}>
            All files
          </button>
        </div>
      )}
    </div>
  )
}
