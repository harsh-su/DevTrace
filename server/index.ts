import Fastify from 'fastify'
import { randomBytes } from 'node:crypto'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve, extname, relative, isAbsolute } from 'node:path'
import { scan, isDir } from './lib/walk.js'

const PORT = 3001
const HOST = '127.0.0.1' // never 0.0.0.0 — this process serves arbitrary file reads
const SESSION_FILE = '.tether-session'

// ---------------------------------------------------------------------------
// Single-file API. It's one browser tab on one machine; a router would be
// ceremony. Add routes here when the surface actually grows (M3 adds /api/git).
// ---------------------------------------------------------------------------

export interface RepoFileDTO {
  rel: string
  size: number
  mtime: number
  ext: string
  lines: number
}

/**
 * Stable across restarts. Vite reads this file once at startup and caches the
 * value for the proxy header, so a fresh random token per boot would hand you
 * a permanent 403 after the first `tsx watch` reload.
 */
function stableToken(): string {
  try {
    if (existsSync(SESSION_FILE)) {
      const existing = readFileSync(SESSION_FILE, 'utf8').trim()
      if (existing.length >= 32) return existing
    }
  } catch {
    /* fall through and mint a new one */
  }
  const fresh = randomBytes(24).toString('hex')
  try {
    writeFileSync(SESSION_FILE, fresh, { encoding: 'utf8', mode: 0o600 })
  } catch {
    /* non-fatal: dev proxy just won't attach a token */
  }
  return fresh
}

const token = stableToken()

const app = Fastify({ logger: { level: 'warn' } })

app.addHook('onRequest', async (req, reply) => {
  if (req.headers['x-tether-token'] !== token) {
    reply.code(403).send({ error: 'bad or missing session token' })
  }
})

/** Reject anything that isn't a readable directory the user actually pointed at. */
function resolveRoot(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 4096) return null
  const p = isAbsolute(input) ? input : resolve(process.cwd(), input)
  return p
}

app.get('/api/health', async () => ({ ok: true }))

app.get('/api/scan', async (req, reply) => {
  const input = (req.query as Record<string, unknown>)['path']
  const root = resolveRoot(input)
  if (!root) return reply.code(400).send({ error: 'path required' })
  if (!(await isDir(root))) return reply.code(400).send({ error: `not a directory: ${root}` })

  const result = await scan(root)
  const files: RepoFileDTO[] = []
  for (const f of result.files) {
    let lines = 0
    try {
      const text = readFileSync(f.abs, 'utf8')
      lines = text.length === 0 ? 0 : text.split('\n').length
    } catch {
      continue
    }
    files.push({ rel: f.rel, size: f.size, mtime: f.mtime, ext: f.ext, lines })
  }
  return { root: result.root, name: result.name, files, truncated: result.truncated, skipped: result.skipped }
})

/** Read a slice of a file. M0 uses whole-file chunks, so start=0/lines=big. */
app.get('/api/file', async (req, reply) => {
  const q = req.query as Record<string, unknown>
  const root = resolveRoot(q['root'])
  const rel = q['rel']
  if (!root || typeof rel !== 'string' || rel.length === 0) {
    return reply.code(400).send({ error: 'root and rel required' })
  }
  if (rel.includes('\0')) return reply.code(400).send({ error: 'bad path' })

  const abs = resolve(root, rel)
  // Containment check: the client must not escape the scanned root.
  const back = relative(root, abs)
  if (back.startsWith('..') || isAbsolute(back)) {
    return reply.code(403).send({ error: 'path escapes repo root' })
  }

  let text: string
  try {
    text = readFileSync(abs, 'utf8')
  } catch (err) {
    return reply.code(404).send({ error: (err as Error).message })
  }

  const allLines = text.split('\n')
  const start = Math.max(0, Number(q['start'] ?? 0) | 0)
  const count = Math.max(1, Number(q['lines'] ?? allLines.length) | 0)
  const slice = allLines.slice(start, start + count)

  return {
    rel,
    ext: extname(rel).toLowerCase(),
    startLine: start,
    totalLines: allLines.length,
    text: slice.join('\n'),
  }
})

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`[tether] api on http://${HOST}:${PORT}`)
})
