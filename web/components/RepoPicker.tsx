import { useState } from 'react'

interface Props {
  onScan: (path: string) => void
  busy: boolean
  error: string | null
  recents: string[]
}

const SUGGESTIONS = ['/Users/you/projects/YOUR_REPO', '~/projects/YOUR_REPO']

export default function RepoPicker({ onScan, busy, error, recents }: Props) {
  const [path, setPath] = useState(recents[0] ?? '')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (path.trim() && !busy) onScan(path.trim())
  }

  return (
    <div className="panel picker">
      <h1>Tether</h1>
      <p className="sub">Trace the code you actually write.</p>

      <form onSubmit={submit}>
        <label htmlFor="repo-path">Project folder</label>
        <div className="row">
          <input
            id="repo-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={SUGGESTIONS[0]}
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
          <button type="submit" disabled={busy || !path.trim()}>
            {busy ? 'Scanning…' : 'Scan'}
          </button>
        </div>
      </form>

      {error && <div className="err">{error}</div>}

      {recents.length > 0 && (
        <div className="recents">
          <span className="label">Recent</span>
          {recents.map((r) => (
            <button key={r} className="chip" onClick={() => setPath(r)}>
              {r}
            </button>
          ))}
        </div>
      )}

      <p className="hint">
        Nothing leaves your machine. The server reads files on localhost and
        nothing is uploaded.
      </p>
    </div>
  )
}
