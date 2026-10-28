export interface SkipRun {
  start: number
  end: number
}

export type SourceLanguage = 'c' | 'html' | 'hash' | 'none'

export function languageId(fileName: string): SourceLanguage {
  const ext = fileName.toLowerCase().split('.').pop() ?? ''
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'java', 'go', 'rs', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'swift', 'kt'].includes(ext)) return 'c'
  if (['html', 'htm', 'xml', 'svg'].includes(ext)) return 'html'
  if (['py', 'pyi', 'rb', 'sh', 'bash', 'zsh', 'yaml', 'yml', 'toml', 'r'].includes(ext)) return 'hash'
  return 'none'
}

function merge(runs: SkipRun[]): SkipRun[] {
  const out: SkipRun[] = []
  for (const run of runs.sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && run.start <= last.end) last.end = Math.max(last.end, run.end)
    else if (run.end > run.start) out.push({ ...run })
  }
  return out
}

/** Finds comments, Python-style docstrings, and leading comment headers. */
export function skipRuns(text: string, language: SourceLanguage): SkipRun[] {
  if (language === 'none' || text.length === 0) return []
  const runs: SkipRun[] = []
  const lines = text.split('\n')
  let offset = 0
  let blockStart = -1
  let blockEnd = ''
  let quote = ''

  for (const line of lines) {
    let commentAt = -1
    let i = 0
    while (i < line.length) {
      const ch = line[i] as string
      const next = line[i + 1] as string | undefined
      if (blockStart >= 0) {
        const at = line.indexOf(blockEnd, i)
        if (at < 0) {
          i = line.length
          continue
        }
        runs.push({ start: blockStart, end: offset + at + blockEnd.length })
        blockStart = -1
        blockEnd = ''
        i = at + blockEnd.length
        continue
      }
      if (quote) {
        if (ch === '\\') {
          i += 2
          continue
        }
        if (ch === quote) quote = ''
        i++
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        // Triple quotes are docstrings in Python and are skipped as a block.
        const triple = line.slice(i, i + 3)
        if (language === 'hash' && (triple === '"""' || triple === "'''")) {
          const close = line.indexOf(triple, i + 3)
          if (close >= 0) runs.push({ start: offset + i, end: offset + close + 3 })
          else {
            blockStart = offset + i
            blockEnd = triple
          }
          i += close >= 0 ? close + 3 - i : line.length - i
          continue
        }
        quote = ch
        i++
        continue
      }
      if ((language === 'c' && ch === '/' && next === '/') || (language === 'hash' && ch === '#')) {
        commentAt = i
        break
      }
      if (language === 'c' && ch === '/' && next === '*') {
        blockStart = offset + i
        blockEnd = '*/'
        i += 2
        continue
      }
      if (language === 'html' && ch === '<' && line.slice(i, i + 4) === '<!--') {
        blockStart = offset + i
        blockEnd = '-->'
        i += 4
        continue
      }
      i++
    }
    if (commentAt >= 0) runs.push({ start: offset + commentAt, end: offset + line.length })
    offset += line.length + 1
  }
  if (blockStart >= 0) runs.push({ start: blockStart, end: text.length })

  // A leading comment block is a license/header and is never useful typing practice.
  let headerEnd = 0
  let headerSeen = false
  offset = 0
  for (const line of lines) {
    const trimmed = line.trim()
    const isHeader = trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('#') ||
      trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('<!--') ||
      trimmed.startsWith('*') || trimmed.startsWith('"""') || trimmed.startsWith("'''")
    if (!isHeader) break
    if (trimmed !== '') headerSeen = true
    if (headerSeen) headerEnd = offset + line.length + 1
    offset += line.length + 1
  }
  if (headerSeen) runs.push({ start: 0, end: Math.min(headerEnd, text.length) })
  return merge(runs)
}
