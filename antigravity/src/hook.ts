import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve, dirname } from 'node:path'

export interface PreToolUseInput {
  toolCall?: {
    name?: string
    args?: Record<string, unknown>
  }
  stepIdx?: number
  workspacePaths?: string[]
  conversationId?: string
}

export interface PreToolUseOutput {
  decision: 'allow' | 'deny' | 'ask' | 'force_ask'
  reason?: string
  overwrite?: Record<string, unknown>
}

export interface StagedRecord {
  id: string
  ts: number
  tool: string
  file: string
  before: string
  after: string
}

/** Normalize CRLF to LF for consistent indexing and replacement. */
function normalizeEol(str: string): string {
  return str.replace(/\r\n/g, '\n')
}

export function applyReplaceFileContent(before: string, args: Record<string, unknown>): string {
  const target = args.TargetContent
  const replacement = args.ReplacementContent
  if (typeof target !== 'string' || typeof replacement !== 'string') return before

  const allowMultiple = args.AllowMultiple === true

  // Try exact line-range slice first if lines provided
  const startLine = typeof args.StartLine === 'number' ? Math.max(1, args.StartLine | 0) : undefined
  const endLine = typeof args.EndLine === 'number' ? Math.max(1, args.EndLine | 0) : undefined

  if (startLine !== undefined && endLine !== undefined) {
    const lines = before.split('\n')
    const sliceStart = Math.max(0, Math.min(startLine - 1, lines.length - 1))
    const sliceEnd = Math.max(sliceStart, Math.min(endLine, lines.length))
    const sliceText = lines.slice(sliceStart, sliceEnd).join('\n')

    if (sliceText.includes(target)) {
      const replacedSlice = allowMultiple
        ? sliceText.split(target).join(replacement)
        : sliceText.replace(target, replacement)
      lines.splice(sliceStart, sliceEnd - sliceStart, ...replacedSlice.split('\n'))
      return lines.join('\n')
    }
  }

  // Fallback: direct string replacement over the whole file
  if (allowMultiple) {
    return before.split(target).join(replacement)
  }
  const idx = before.indexOf(target)
  if (idx === -1) return before
  return before.slice(0, idx) + replacement + before.slice(idx + target.length)
}

export function applyMultiReplace(before: string, args: Record<string, unknown>): string {
  const chunks = args.ReplacementChunks
  if (!Array.isArray(chunks)) return before

  let result = before
  for (const chunk of chunks) {
    if (chunk && typeof chunk === 'object') {
      result = applyReplaceFileContent(result, chunk as Record<string, unknown>)
    }
  }
  return result
}

export function computeAfter(
  tool: string,
  baseText: string,
  args: Record<string, unknown>,
): string {
  if (tool === 'write_to_file') {
    const code = args.CodeContent
    return typeof code === 'string' ? normalizeEol(code) : baseText
  }
  if (tool === 'replace_file_content') {
    return applyReplaceFileContent(baseText, args)
  }
  if (tool === 'multi_replace_file_content') {
    return applyMultiReplace(baseText, args)
  }
  return baseText
}

export async function readSafe(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

export async function readPendingFor(pendingDir: string, file: string): Promise<StagedRecord[]> {
  let names: string[]
  try {
    names = await readdir(pendingDir)
  } catch {
    return []
  }
  const records: StagedRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await readFile(join(pendingDir, name), 'utf8')
      const rec = JSON.parse(raw) as StagedRecord
      if (rec && rec.file === file && typeof rec.after === 'string') records.push(rec)
    } catch {
      // ignore invalid / partial json
    }
  }
  return records.sort((a, b) => a.ts - b.ts)
}

export function resolveProjectRoot(targetFile: string, inputRoot?: string): string {
  if (inputRoot) {
    return inputRoot
  }

  // 1. Walk up from targetFile to find a directory containing .devtrace or .agents
  let dir = isAbsolute(targetFile) ? dirname(targetFile) : resolve(process.cwd(), dirname(targetFile))
  while (dir) {
    if (existsSync(join(dir, '.devtrace')) || existsSync(join(dir, '.agents'))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // 2. If cwd is inside .agents, the project root is the parent directory
  const cwd = process.cwd()
  if (cwd.endsWith('.agents') || existsSync(join(cwd, 'hooks.json'))) {
    const parent = dirname(cwd)
    if (existsSync(join(parent, '.agents')) || existsSync(join(parent, '.devtrace'))) {
      return parent
    }
  }

  return cwd
}

/**
 * Handle an Antigravity PreToolUse hook invocation.
 */
export async function handlePreToolUse(
  input: PreToolUseInput,
  workspaceRoot?: string,
): Promise<PreToolUseOutput> {
  const tool = input.toolCall?.name
  const writingTools = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content'])
  if (!tool || !writingTools.has(tool)) {
    return { decision: 'allow' }
  }

  const args = input.toolCall?.args ?? {}
  const rawTargetFile = args.TargetFile
  if (typeof rawTargetFile !== 'string' || rawTargetFile.length === 0) {
    return { decision: 'allow' }
  }

  const explicitRoot =
    workspaceRoot ??
    (input.workspacePaths && input.workspacePaths.length > 0
      ? input.workspacePaths[0]
      : undefined)

  const root = resolveProjectRoot(rawTargetFile, explicitRoot)

  const devDir = join(root, '.devtrace')
  const pendingDir = join(devDir, 'pending')

  const isEnabled = process.env.DEVTRACE_STAGE === '1' || existsSync(devDir)
  if (!isEnabled) {
    return { decision: 'allow' }
  }

  const absFile = isAbsolute(rawTargetFile) ? rawTargetFile : resolve(root, rawTargetFile)
  const disk = await readSafe(absFile)

  // Compose on top of any prior pending change for this file
  const prior = await readPendingFor(pendingDir, absFile)
  const newest = prior[prior.length - 1]
  const base = newest ? newest.after : disk

  const after = computeAfter(tool, base, args)
  if (after === base) {
    return { decision: 'allow' }
  }

  await mkdir(pendingDir, { recursive: true })
  const id = newest ? newest.id : randomUUID()
  const ts = newest ? newest.ts : Date.now()

  const record: StagedRecord = {
    id,
    ts,
    tool,
    file: absFile,
    before: disk,
    after,
  }

  const tmpPath = join(pendingDir, `${id}.json.tmp`)
  await writeFile(tmpPath, JSON.stringify(record, null, 2), 'utf8')
  await rename(tmpPath, join(pendingDir, `${id}.json`))

  // Clean up any older pending records for this file so only the latest remains
  for (const r of prior) {
    if (r.id !== id) {
      await unlink(join(pendingDir, `${r.id}.json`)).catch(() => {})
    }
  }

  return {
    decision: 'deny',
    reason:
      `DevTrace: ${tool} staged successfully for the developer to type by hand. ` +
      `The file is intentionally left unchanged on disk until typed. ` +
      `This is the expected behavior, NOT a failure. Do not retry this edit, ` +
      `do not call writing tools again for this file, and continue with your next task.`,
  }
}
