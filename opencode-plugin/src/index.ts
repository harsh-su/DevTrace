/**
 * opencode-tether
 *
 * Blocks OpenCode's writing tools (`edit`, `write`, `multiedit`) and stages each
 * proposed change under `<worktree>/.tether/pending/` instead. The Tether
 * VS Code extension watches that directory, opens the file, and lets the
 * developer *type the change by hand* over a ghost overlay. Nothing is written
 * until the developer has typed it.
 *
 * Every tool call gets its own pending record. Later calls still compose on top
 * of the newest staged text so dependent edits are not lost, but the queue and
 * the developer-facing trace remain one-to-one with the AI's edits.
 *
 * Opt-in: staging activates when `TETHER_STAGE=1` is set, or when a
 * `.tether/` directory exists in the worktree (the extension creates it).
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve, sep } from 'node:path'

interface PluginContext {
  directory: string
  worktree: string
  client?: {
    app?: {
      log?: (input: {
        body: { service: string; level: string; message: string; extra?: unknown }
      }) => Promise<unknown>
    }
  }
}

interface ToolInput {
  tool: string
}

interface ToolOutput {
  args: Record<string, unknown>
}

interface StagedRecord {
  id: string
  ts: number
  tool: string
  file: string
  before: string
  after: string
}

function applyOne(before: string, args: Record<string, unknown>): string {
  const oldString = args.oldString
  const newString = args.newString
  if (typeof oldString !== 'string' || typeof newString !== 'string') return before
  if (args.replaceAll === true) return before.split(oldString).join(newString)
  const i = before.indexOf(oldString)
  if (i === -1) return before
  return before.slice(0, i) + newString + before.slice(i + oldString.length)
}

function applyEdits(before: string, args: Record<string, unknown>): string {
  const edits = args.edits
  if (Array.isArray(edits)) {
    let out = before
    for (const e of edits) {
      if (e && typeof e === 'object') out = applyOne(out, e as Record<string, unknown>)
    }
    return out
  }
  return applyOne(before, args)
}

export const TetherPlugin = async ({ directory, worktree, client }: PluginContext) => {
  const root = worktree && worktree.length > 0 ? worktree : directory
  const devDir = join(root, '.tether')
  const pendingDir = join(devDir, 'pending')

  const enabled = (): boolean => process.env.TETHER_STAGE === '1' || existsSync(devDir)

  const readSafe = async (path: string): Promise<string> => {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return ''
    }
  }

  /** Every pending record that already targets `file`, oldest first. */
  const readPendingFor = async (file: string): Promise<StagedRecord[]> => {
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
        const rec = JSON.parse(
          await readFile(join(pendingDir, name), 'utf8'),
        ) as StagedRecord
        if (rec && rec.file === file && typeof rec.after === 'string') records.push(rec)
      } catch {
        // partially written or garbage — ignore, the next stage will retry
      }
    }
    return records.sort((a, b) => a.ts - b.ts)
  }

  const stage = async (input: ToolInput, output: ToolOutput): Promise<void> => {
    const tool = input.tool
    if (tool !== 'edit' && tool !== 'write' && tool !== 'multiedit') return
    if (!enabled()) return

    const args = output.args ?? {}
    const filePath = args.filePath
    if (typeof filePath !== 'string' || filePath.length === 0) return

    const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath)

    // Tether's own bookkeeping (tour.json, tour-progress.json, ...) lives in
    // the queue directory. The agent must be able to write it directly, so
    // writes there pass through untouched instead of being staged.
    if (abs === devDir || abs.startsWith(devDir + sep)) return
    const disk = await readSafe(abs)

    // Compose on top of anything already staged for this file, rather than the
    // unchanged disk: the extension blocks writes, so an edit that references
    // text a previous (still-pending) edit introduced would otherwise be lost.
    const prior = await readPendingFor(abs)
    const newest = prior[prior.length - 1]
    const base = newest ? newest.after : disk

    const after =
      tool === 'write' && typeof args.content === 'string' ? args.content : applyEdits(base, args)
    if (after === base) return

    await mkdir(pendingDir, { recursive: true })
    const id = randomUUID()
    const ts = Date.now()
    // `before` mirrors the committed file so the extension's diff against disk
    // yields exactly the pending hunks.
    const record: StagedRecord = { id, ts, tool, file: abs, before: disk, after }
    const tmp = join(pendingDir, `${id}.json.tmp`)
    await writeFile(tmp, JSON.stringify(record), 'utf8')
    await rename(tmp, join(pendingDir, `${id}.json`))

    await client?.app?.log?.({
      body: {
        service: 'opencode-tether',
        level: 'info',
        message: `staged ${tool} for ${abs}`,
      },
    })

    // The message is deliberately phrased as a successful outcome. It is still a
    // thrown error (that is the only way to block a tool), so we also inject a
    // system rule and a tool-description note below telling the model that this
    // result is expected and must not be retried.
    throw new Error(
      `Tether: ${tool} staged successfully for the developer to type by hand. ` +
        `The file is intentionally left unchanged for now — the developer will apply ` +
        `this exact change. This is the expected behavior, NOT a failure. Do not retry ` +
        `this edit, do not call ${tool} again for this file, and continue with other work.`,
    )
  }

  const devTraceTools = new Set(['edit', 'write', 'multiedit'])

  /**
   * How the agent authors guided learning tours. Returned as separate rules so
   * the staging rule and the tour protocol stay individually readable.
   */
  function tourRules(): string[] {
    return [
      'Guided tours: when the developer asks to learn, understand, or be guided through ' +
        'this codebase (e.g. "teach me this project", "tour me through the code"), build a ' +
        'learning path instead of summarizing in chat. First explore enough of the repo to ' +
        'order it: entry point first, then config/build, then the heart of the domain logic, ' +
        'then the surrounding surfaces. Then write .tether/tour.json (this exact shape: ' +
        'title, goal, steps[]) where each step is ' +
        '{ id: "step-01", title, file (workspace-relative), start (1-based line), lines, why ' +
        '(why this step comes next), concept (the single idea it teaches), explanation ' +
        '(plain-English walk-through of that code — say what it does, what its inputs and ' +
        'outputs are, and which other parts call it) }. Keep each step\'s range modest: ' +
        '6-30 lines the developer will type. 6-10 ordered steps beats one giant file. ' +
        'Writing tour.json and tour-progress.json inside the Tether directory is allowed ' +
        'directly — those files are NOT staged. Files show up in order in the Tether ' +
        'VS Code sidebar\'s "Learning path" list; the developer opens each, reads your ' +
        'explanation, and types the code.',
      'Adaptation: BEFORE writing or updating tour.json, read .tether/tour-progress.json ' +
        '(create-tolerant; the extension maintains it). Rows look like ' +
        '"step-id: done=true, attempts=2, last 41 wpm / 96% — title". A row marked ' +
        '"not completed — retrace wanted" means the developer struggled: remix the remaining ' +
        'unread steps around that concept (different file, shorter range, or a scaffolding ' +
        'step) instead of moving on. When every step is done, offer a next tour that builds ' +
        'on the goal, or propose a small practice change (a real edit through the normal ' +
        'write tools) for the developer to type. Teaching text answers "why", not just "what".',
    ]
  }

  return {
    'tool.execute.before': stage,

    // Tell the model up front that intercepted edits are success.
    'experimental.chat.system.transform': async (
      _input: unknown,
      output: { system: string[] },
    ) => {
      if (!enabled()) return
      output.system.push(
        'Tether mode is active. File writes (edit/write/multiedit) are intercepted: ' +
          'each is staged for the developer to type by hand and the tool returns a message ' +
          'starting with "Tether:". Treat that result as SUCCESS. Do not retry the edit, ' +
          'do not re-read the file expecting the change to be present yet, and do not ' +
          'apologize or warn about the file being unchanged. Continue with the task.',
        ...tourRules(),
      )
    },

    // And annotate the writing tools themselves, where the model looks first.
    'tool.definition': async (
      input: { toolID: string },
      output: { description: string },
    ) => {
      if (!enabled()) return
      if (devTraceTools.has(input.toolID)) {
        output.description +=
          ' Note: Tether may stage this change for hand-typing and return a "Tether:" ' +
          'message. That is expected success — do not retry.'
      }
    },
  }
}

export default TetherPlugin
