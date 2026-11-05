import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

export interface HookInput {
  hook_event_name?: string
  event?: string
  cwd?: string
  source?: string
  initialPrompt?: string
  initial_prompt?: string
  tool_name?: string
  toolName?: string
  tool_input?: unknown
  toolArgs?: unknown
  tool_use_id?: string
}

export interface HookOutput {
  permissionDecision?: 'deny'
  permissionDecisionReason?: string
  additionalContext?: string
  hookSpecificOutput?: {
    hookEventName: string
    permissionDecision?: 'deny'
    permissionDecisionReason?: string
    additionalContext?: string
  }
}

export interface StagedRecord {
  id: string
  ts: number
  tool: string
  file: string
  before: string
  after: string
}

interface EditOp {
  file: string
  tool: string
  apply: (base: string) => string | null
}

interface PatchLine {
  kind: 'context' | 'add' | 'del'
  text: string
}

interface UpdateChunk {
  anchor?: string
  lines: PatchLine[]
}

interface PatchHunk {
  kind: 'add' | 'delete' | 'update'
  path: string
  content?: string
  chunks?: UpdateChunk[]
  movePath?: string
}

const CREATE_TOOLS = new Set(['create_file', 'create', 'write', 'Write'])
const REPLACE_TOOLS = new Set(['replace_string_in_file', 'edit', 'Edit'])
const MULTI_REPLACE_TOOLS = new Set(['multi_replace_string_in_file', 'MultiEdit', 'multiedit', 'multi_edit'])
const APPLY_PATCH_TOOLS = new Set(['apply_patch', 'ApplyPatch'])
const STR_REPLACE_TOOLS = new Set(['str_replace_editor', 'str_replace_based_edit_tool'])

const AITRACE_RULES = [
  'AItrace mode is active. File writes from Copilot (create_file, replace_string_in_file, ' +
    'multi_replace_string_in_file, apply_patch) are intercepted: each change is staged for the ' +
    'developer to type by hand and the tool returns a message starting with "AItrace:". Treat that ' +
    'result as SUCCESS. Do not retry the edit, do not re-read the file expecting the change to be ' +
    'present yet, and do not apologize or warn about the file being unchanged. Continue with the task.',
  'Guided tours: when the developer asks to learn, understand, or be guided through this ' +
    'codebase (e.g. "teach me this project", "tour me through the code"), build a learning path ' +
    'instead of summarizing in chat. First explore enough of the repo to order it: entry point ' +
    'first, then config/build, then the heart of the domain logic, then the surrounding surfaces. ' +
    'Then write .aitrace/tour.json (this exact shape: title, goal, steps[]) where each step is ' +
    '{ id: "step-01", title, file (workspace-relative), start (1-based line), lines, why (why this ' +
    'step comes next), concept (the single idea it teaches), explanation (plain-English ' +
    'walk-through of that code — say what it does, what its inputs and outputs are, and which ' +
    'other parts call it) }. Keep each step\'s range modest: 6-30 lines the developer will type. ' +
    '6-10 ordered steps beats one giant file. Writing tour.json and tour-progress.json inside the ' +
    'AItrace directory is allowed directly — those files are NOT staged. Files show up in order ' +
    'in the AItrace VS Code sidebar\'s "Learning path" list; the developer opens each, reads your ' +
    'explanation, and types the code.',
  'Adaptation: BEFORE writing or updating tour.json, read .aitrace/tour-progress.json ' +
    '(create-tolerant; the extension maintains it). Rows look like "step-id: done=true, ' +
    'attempts=2, last 41 wpm / 96% — title". A row marked "not completed — retrace wanted" means ' +
    'the developer struggled: remix the remaining unread steps around that concept (different ' +
    'file, shorter range, or a scaffolding step) instead of moving on. When every step is done, ' +
    'offer a next tour that builds on the goal, or propose a small practice change (a real edit ' +
    'through the normal write tools) for the developer to type. Teaching text answers "why", not ' +
    'just "what".',
].join('\n\n')

/** Normalize CRLF to LF for consistent indexing and replacement. */
function normalizeEol(str: string): string {
  return str.replace(/\r\n/g, '\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return isRecord(value) ? value : {}
}

function readString(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function readBool(args: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    if (args[key] === true) return true
  }
  return false
}

export function applyStringReplace(
  base: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string | null {
  if (oldString.length === 0) return null
  if (replaceAll) {
    if (!base.includes(oldString)) return null
    return base.split(oldString).join(newString)
  }
  const idx = base.indexOf(oldString)
  if (idx === -1) return null
  return base.slice(0, idx) + newString + base.slice(idx + oldString.length)
}

export function applyUpdate(base: string, chunks: UpdateChunk[]): string | null {
  let out = base
  let cursor = 0

  for (const chunk of chunks) {
    const oldText = chunk.lines
      .filter((line) => line.kind !== 'add')
      .map((line) => line.text)
      .join('\n')
    const newText = chunk.lines
      .filter((line) => line.kind !== 'del')
      .map((line) => line.text)
      .join('\n')

    if (oldText.length === 0) {
      const suffix = newText.endsWith('\n') ? '' : '\n'
      if (chunk.anchor) {
        const idx = out.indexOf(chunk.anchor, cursor)
        if (idx === -1) return null
        const lineEnd = out.indexOf('\n', idx + chunk.anchor.length)
        const insertAt = lineEnd === -1 ? out.length : lineEnd + 1
        out = out.slice(0, insertAt) + newText + suffix + out.slice(insertAt)
        cursor = insertAt + newText.length + suffix.length
      } else {
        out = out.slice(0, cursor) + newText + suffix + out.slice(cursor)
        cursor += newText.length + suffix.length
      }
      continue
    }

    let idx = out.indexOf(oldText, cursor)
    if (idx === -1) idx = out.indexOf(oldText)
    if (idx === -1) return null
    out = out.slice(0, idx) + newText + out.slice(idx + oldText.length)
    cursor = idx + newText.length
  }

  return out
}

export function parsePatch(text: string): PatchHunk[] | null {
  const lines = normalizeEol(text).split('\n')
  let i = 0

  while (
    i < lines.length &&
    !(
      lines[i]?.startsWith('*** Begin Patch') ||
      lines[i]?.startsWith('*** Add File:') ||
      lines[i]?.startsWith('*** Delete File:') ||
      lines[i]?.startsWith('*** Update File:')
    )
  ) {
    i++
  }
  if (lines[i]?.startsWith('*** Begin Patch')) i++

  const hunks: PatchHunk[] = []
  while (i < lines.length) {
    const line = lines[i]
    if (!line || line.startsWith('*** End Patch')) break

    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim()
      i++
      const contentLines: string[] = []
      while (i < lines.length && !lines[i]?.startsWith('***')) {
        const current = lines[i] as string
        if (current.startsWith('+')) contentLines.push(current.slice(1))
        else if (current.length > 0) contentLines.push(current)
        i++
      }
      let content = contentLines.join('\n')
      if (content.length > 0 && !content.endsWith('\n')) content += '\n'
      hunks.push({ kind: 'add', path, content })
      continue
    }

    if (line.startsWith('*** Delete File:')) {
      hunks.push({ kind: 'delete', path: line.slice('*** Delete File:'.length).trim() })
      i++
      continue
    }

    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim()
      i++
      let movePath: string | undefined
      if (lines[i]?.startsWith('*** Move to:')) {
        movePath = (lines[i] as string).slice('*** Move to:'.length).trim()
        i++
      }

      const chunks: UpdateChunk[] = []
      let current: UpdateChunk = { lines: [] }
      const flush = (): void => {
        if (current.lines.length > 0) {
          chunks.push(current)
          current = { lines: [] }
        }
      }

      while (i < lines.length && !lines[i]?.startsWith('***')) {
        const currentLine = lines[i] as string
        if (currentLine.startsWith('@@')) {
          flush()
          const anchor = currentLine.slice(2).trim()
          if (anchor) current.anchor = anchor
          i++
          continue
        }
        if (currentLine.length === 0) {
          i++
          continue
        }
        const prefix = currentLine[0]
        if (prefix === ' ' || prefix === '+' || prefix === '-') {
          current.lines.push({
            kind: prefix === ' ' ? 'context' : prefix === '+' ? 'add' : 'del',
            text: currentLine.slice(1),
          })
        } else {
          current.lines.push({ kind: 'context', text: currentLine })
        }
        i++
      }
      flush()
      hunks.push({ kind: 'update', path, chunks, movePath })
      continue
    }

    i++
  }

  return hunks.length > 0 ? hunks : null
}

function collectEdits(tool: string, rawArgs: unknown, args: Record<string, unknown>): EditOp[] | null {
  if (CREATE_TOOLS.has(tool)) {
    const file = readString(args, 'filePath', 'file_path', 'path')
    const content = readString(args, 'content', 'file_text', 'fileText', 'code')
    if (!file || content === undefined) return null
    return [{ file, tool, apply: () => normalizeEol(content) }]
  }

  if (REPLACE_TOOLS.has(tool) || STR_REPLACE_TOOLS.has(tool)) {
    const file = readString(args, 'filePath', 'file_path', 'path')
    const command = readString(args, 'command')
    if (!file) return null

    if (command === 'create') {
      const content = readString(args, 'file_text', 'fileText', 'content')
      if (content === undefined) return null
      return [{ file, tool, apply: () => normalizeEol(content) }]
    }
    if (command === 'insert') return null

    const oldString = readString(args, 'oldString', 'old_string', 'old_str')
    const newString = readString(args, 'newString', 'new_string', 'new_str')
    if (oldString === undefined || newString === undefined) return null
    const replaceAll = readBool(args, 'replaceAll', 'replace_all', 'AllowMultiple')
    return [
      {
        file,
        tool,
        apply: (base) => applyStringReplace(base, normalizeEol(oldString), normalizeEol(newString), replaceAll),
      },
    ]
  }

  if (MULTI_REPLACE_TOOLS.has(tool)) {
    if (tool === 'MultiEdit' || tool === 'multiedit' || tool === 'multi_edit') {
      const file = readString(args, 'filePath', 'file_path', 'path')
      const edits = args.edits
      if (!file || !Array.isArray(edits)) return null
      const ops: EditOp[] = []
      for (const edit of edits) {
        if (!isRecord(edit)) return null
        const oldString = readString(edit, 'oldString', 'old_string', 'old_str')
        const newString = readString(edit, 'newString', 'new_string', 'new_str')
        if (oldString === undefined || newString === undefined) return null
        const replaceAll = readBool(edit, 'replaceAll', 'replace_all')
        ops.push({
          file,
          tool,
          apply: (base) =>
            applyStringReplace(base, normalizeEol(oldString), normalizeEol(newString), replaceAll),
        })
      }
      return ops.length > 0 ? ops : null
    }

    const replacements = args.replacements
    if (!Array.isArray(replacements)) return null
    const ops: EditOp[] = []
    for (const replacement of replacements) {
      if (!isRecord(replacement)) return null
      const file = readString(replacement, 'filePath', 'file_path', 'path')
      const oldString = readString(replacement, 'oldString', 'old_string', 'old_str')
      const newString = readString(replacement, 'newString', 'new_string', 'new_str')
      if (!file || oldString === undefined || newString === undefined) return null
      const replaceAll = readBool(replacement, 'replaceAll', 'replace_all')
      ops.push({
        file,
        tool,
        apply: (base) =>
          applyStringReplace(base, normalizeEol(oldString), normalizeEol(newString), replaceAll),
      })
    }
    return ops.length > 0 ? ops : null
  }

  if (APPLY_PATCH_TOOLS.has(tool)) {
    const patch =
      typeof rawArgs === 'string'
        ? rawArgs
        : readString(args, 'input', 'patch', 'patchText', 'text')
    if (!patch) return null
    const hunks = parsePatch(patch)
    if (!hunks) return null
    const ops: EditOp[] = []
    for (const hunk of hunks) {
      if (hunk.movePath) return null
      if (hunk.kind === 'add') {
        const content = hunk.content ?? ''
        ops.push({ file: hunk.path, tool, apply: () => content })
      } else if (hunk.kind === 'delete') {
        ops.push({ file: hunk.path, tool, apply: () => '' })
      } else {
        const chunks = hunk.chunks ?? []
        ops.push({ file: hunk.path, tool, apply: (base) => applyUpdate(base, chunks) })
      }
    }
    return ops.length > 0 ? ops : null
  }

  return null
}

function isSessionStart(input: HookInput): boolean {
  const event = input.hook_event_name ?? input.event
  if (event === 'SessionStart' || event === 'sessionStart') return true
  if (event) return false
  return (
    typeof input.source === 'string' ||
    typeof input.initialPrompt === 'string' ||
    typeof input.initial_prompt === 'string'
  )
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
      const record = JSON.parse(raw) as StagedRecord
      if (record && record.file === file && typeof record.after === 'string') records.push(record)
    } catch {
      // partially written or garbage — ignore, the next stage will retry
    }
  }
  return records.sort((a, b) => a.ts - b.ts)
}

export function resolveProjectRoot(targetFile: string, inputRoot?: string): string {
  if (inputRoot) return inputRoot

  let dir = isAbsolute(targetFile)
    ? dirname(targetFile)
    : resolve(process.cwd(), dirname(targetFile))
  while (dir) {
    if (existsSync(join(dir, '.aitrace')) || existsSync(join(dir, '.github', 'hooks'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return process.cwd()
}

function toAbsolute(file: string, root: string): string | undefined {
  if (file.startsWith('file://')) {
    try {
      return fileURLToPath(file)
    } catch {
      return undefined
    }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(file)) return undefined
  return isAbsolute(file) ? file : resolve(root, file)
}

function isInside(file: string, dir: string): boolean {
  return file === dir || file.startsWith(dir + sep)
}

function deny(reason: string): HookOutput {
  return {
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
      additionalContext: reason,
    },
  }
}

export async function handleHook(input: HookInput, workspaceRoot?: string): Promise<HookOutput> {
  if (isSessionStart(input)) {
    const cwd = input.cwd ?? workspaceRoot ?? process.cwd()
    const root = workspaceRoot ?? resolveProjectRoot(join(cwd, '_'))
    const enabled = process.env.AITRACE_STAGE === '1' || existsSync(join(root, '.aitrace'))
    return enabled ? { additionalContext: AITRACE_RULES } : {}
  }

  const tool = input.tool_name ?? input.toolName
  if (!tool) return {}

  const rawArgs = input.tool_input ?? input.toolArgs
  const args = parseArgs(rawArgs)
  const edits = collectEdits(tool, rawArgs, args)
  if (!edits || edits.length === 0) return {}

  const cwd = input.cwd ?? workspaceRoot ?? process.cwd()
  const firstFile = edits.find((edit) => !edit.file.startsWith('file://'))?.file
  const startFile = firstFile
    ? isAbsolute(firstFile)
      ? firstFile
      : resolve(cwd, firstFile)
    : join(cwd, '_')
  const root = workspaceRoot ?? resolveProjectRoot(startFile)
  const devDir = join(root, '.aitrace')

  const enabled = process.env.AITRACE_STAGE === '1' || existsSync(devDir)
  if (!enabled) return {}

  // Writes to AItrace's own bookkeeping (tour.json, tour-progress.json, ...)
  // must land directly. If a single tool call mixes those with source edits,
  // fall back to a normal edit so the tour file is not lost.
  const groups = new Map<string, EditOp[]>()
  let hasSourceEdit = false
  let hasQueueEdit = false

  for (const edit of edits) {
    const abs = toAbsolute(edit.file, root)
    if (!abs) return {}
    if (isInside(abs, devDir)) {
      hasQueueEdit = true
      continue
    }
    hasSourceEdit = true
    const group = groups.get(abs) ?? []
    group.push(edit)
    groups.set(abs, group)
  }

  if (!hasSourceEdit || hasQueueEdit) return {}

  const pendingDir = join(devDir, 'pending')
  const records: StagedRecord[] = []

  for (const [abs, group] of groups) {
    const disk = await readSafe(abs)
    const prior = await readPendingFor(pendingDir, abs)
    const newest = prior[prior.length - 1]
    const base = newest ? newest.after : disk

    let after = base
    for (const edit of group) {
      const next = edit.apply(after)
      if (next === null) {
        // Could not reproduce Copilot's edit exactly — let Copilot apply it
        // normally rather than staging the wrong text.
        return {}
      }
      after = next
    }

    if (after === base) continue
    records.push({
      id: randomUUID(),
      ts: Math.max(Date.now(), (newest?.ts ?? 0) + 1) + records.length,
      tool,
      file: abs,
      before: disk,
      after,
    })
  }

  if (records.length === 0) return {}

  try {
    await mkdir(pendingDir, { recursive: true })
    for (const record of records) {
      const tmp = join(pendingDir, `${record.id}.json.tmp`)
      await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8')
      await rename(tmp, join(pendingDir, `${record.id}.json`))
    }
  } catch {
    return {}
  }

  return deny(
    `AItrace: ${tool} staged successfully for the developer to type by hand. ` +
      `The file is intentionally left unchanged on disk until it is traced. ` +
      `This is the expected behavior, NOT a failure. Do not retry this edit, do not call ` +
      `editing tools again for this file, and do not re-read the file expecting the change ` +
      `to be present yet. Continue with your next task.`,
  )
}
