import * as vscode from 'vscode'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** One change staged by the OpenCode plugin. Mirrors the plugin's record. */
export interface StagedChange {
  id: string
  ts: number
  tool: string
  file: string
  before: string
  after: string
}

/** A staged change together with the queue file that holds it on disk. */
export interface StagedEntry {
  change: StagedChange
  fsPath: string
}

/**
 * Every pending edit for one file, collapsed into the unit the developer
 * traces. Later records compose on earlier ones, so `after` from the newest
 * record is the complete file the developer is working towards.
 */
export interface PendingFile {
  file: string
  /** Oldest first. */
  entries: StagedEntry[]
  /** Earliest `before`, for display/status only; tracing diffs against disk. */
  before: string
  /** Newest `after`: the whole proposed file, not just the latest edit. */
  after: string
  /** Earliest timestamp, so files queue in the order they were first touched. */
  ts: number
  lastTs: number
}

/**
 * The set of AI changes waiting to be hand-traced, backed by the
 * `<workspace>/.aitrace/pending/*.json` files the OpenCode plugin writes.
 *
 * Records are kept until they are traced or discarded, so the list survives a
 * window reload — the panel mirrors the queue rather than draining it. An
 * optional `onArrive` callback fires once per new record, for auto-tracing.
 *
 * This store never creates the queue directory: its presence is what turns
 * AItrace staging on, so the directory is owned by the enable/disable command.
 */
export class PendingStore implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = []
  private readonly watchers: vscode.Disposable[] = []
  private readonly byId = new Map<string, StagedEntry>()
  private readonly emitter = new vscode.EventEmitter<void>()
  /** Fired whenever the set of pending changes changes. */
  readonly onDidChange = this.emitter.event

  constructor(private readonly onArrive?: (change: StagedChange) => void) {}

  async start(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) await this.watch(folder)
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
        for (const folder of e.added) await this.watch(folder)
      }),
    )
  }

  /** Re-read the queue from scratch (after the queue directory was created or removed). */
  async reset(): Promise<void> {
    for (const w of this.watchers) w.dispose()
    this.watchers.length = 0
    this.byId.clear()
    this.emitter.fire()
    for (const folder of vscode.workspace.workspaceFolders ?? []) await this.watch(folder)
  }

  /** Oldest first, so the queue is traced in the order the AI produced it. */
  list(): StagedEntry[] {
    return [...this.byId.values()].sort((a, b) => a.change.ts - b.change.ts)
  }

  find(id: string): StagedEntry | undefined {
    return this.byId.get(id)
  }

  /**
   * All pending edits collapsed per file, oldest-first by when the file was
   * first touched. The newest record's `after` is the complete proposed file.
   */
  groups(): PendingFile[] {
    const byFile = new Map<string, PendingFile>()
    for (const entry of this.list()) {
      const change = entry.change
      const existing = byFile.get(change.file)
      if (existing) {
        existing.entries.push(entry)
        existing.after = change.after
        existing.lastTs = change.ts
      } else {
        byFile.set(change.file, {
          file: change.file,
          entries: [entry],
          before: change.before,
          after: change.after,
          ts: change.ts,
          lastTs: change.ts,
        })
      }
    }
    return [...byFile.values()]
  }

  /** Snapshot the pending edits for one file, or undefined if none remain. */
  group(file: string): PendingFile | undefined {
    return this.groups().find((pending) => pending.file === file)
  }

  /**
   * Remove exactly the records that were traced. A record staged while the
   * panel was open has a different id (OpenCode) or a different `after`
   * (Antigravity upserts in place), so it survives for the next trace.
   */
  async removeSnapshots(entries: StagedEntry[]): Promise<void> {
    let changed = false
    for (const snapshot of entries) {
      const current = this.byId.get(snapshot.change.id)
      if (!current) continue
      if (
        current.fsPath !== snapshot.fsPath ||
        current.change.ts !== snapshot.change.ts ||
        current.change.after !== snapshot.change.after
      ) {
        continue
      }
      this.byId.delete(snapshot.change.id)
      await unlink(current.fsPath).catch(() => {})
      changed = true
    }
    if (changed) this.emitter.fire()
  }

  /** Drop a change from the queue and delete its file. */
  async remove(id: string): Promise<void> {
    const entry = this.byId.get(id)
    if (!entry) return
    this.byId.delete(id)
    await unlink(entry.fsPath).catch(() => {})
    this.emitter.fire()
  }

  private async watch(folder: vscode.WorkspaceFolder): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('aitrace', folder.uri)
    const rel = cfg.get<string>('queueDir', '.aitrace')
    const pendingDir = join(folder.uri.fsPath, rel, 'pending')

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, `${rel}/pending/*.json`),
    )
    watcher.onDidCreate((uri) => void this.load(uri))
    watcher.onDidChange((uri) => void this.load(uri))
    watcher.onDidDelete((uri) => this.drop(uri.fsPath))
    this.watchers.push(watcher)
    this.disposables.push(watcher)

    await this.drain(pendingDir)
  }

  private async drain(dir: string): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return // queue directory absent: AItrace staging is off
    }
    for (const name of names) {
      if (name.endsWith('.json')) await this.load(vscode.Uri.file(join(dir, name)))
    }
  }

  private async load(uri: vscode.Uri): Promise<void> {
    let change: StagedChange
    try {
      change = JSON.parse(await readFile(uri.fsPath, 'utf8')) as StagedChange
    } catch {
      return // still being written, or garbage — the watcher will re-fire
    }
    if (
      !change ||
      typeof change.id !== 'string' ||
      typeof change.file !== 'string' ||
      typeof change.after !== 'string'
    ) {
      return
    }
    const isNew = !this.byId.has(change.id)
    this.byId.set(change.id, { change, fsPath: uri.fsPath })
    this.emitter.fire()
    if (isNew) this.onArrive?.(change)
  }

  private drop(fsPath: string): void {
    for (const [id, entry] of this.byId) {
      if (entry.fsPath === fsPath) {
        this.byId.delete(id)
        this.emitter.fire()
        return
      }
    }
  }

  dispose(): void {
    this.emitter.dispose()
    for (const d of this.disposables) d.dispose()
  }
}
