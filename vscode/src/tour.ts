import * as vscode from 'vscode'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  emptyProgress,
  normalizeProgress,
  recordStep as foldAttempt,
  validateTour,
  type Tour,
  type TourProgress,
} from '@tether/core'

/**
 * The learning path, backed by `<workspace>/.tether/tour.json` — the file the
 * OpenCode agent writes when the developer asks to be guided through the
 * codebase. Scores land in `tour-progress.json`, which is the feedback the
 * agent re-reads to adapt the remaining steps.
 *
 * Both files are watched, so an agent mid-rewrite is picked up live. Like the
 * pending queue, nothing here creates the queue directory: Tether staging is
 * owned by the enable/disable command.
 */
export class TourStore implements vscode.Disposable {
  private readonly watchers: vscode.Disposable[] = []
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChange = this.emitter.event

  private tour: Tour | undefined
  private progress: TourProgress = emptyProgress()
  private dir: string | undefined

  async start(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      await this.watch(folder)
      break // one learning path per session; multiroot picks the first folder
    }
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
        if (this.dir || e.added.length === 0) return
        await this.watch(e.added[0] as vscode.WorkspaceFolder)
      }),
    )
  }

  private async watch(folder: vscode.WorkspaceFolder): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('tether', folder.uri)
    const rel = cfg.get<string>('queueDir', '.tether')
    this.dir = join(folder.uri.fsPath, rel)

    for (const file of ['tour.json', 'tour-progress.json']) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, `${rel}/${file}`),
      )
      watcher.onDidCreate(() => void this.reload())
      watcher.onDidChange(() => void this.reload())
      watcher.onDidDelete(() => void this.reload())
      this.watchers.push(watcher)
    }

    await this.reload()
  }

  async reload(): Promise<void> {
    if (!this.dir) return
    this.progress = (await this.read(this.jsonPath('tour-progress.json'), normalizeProgress)) ?? {
      ...emptyProgress(),
    }
    const tour = await this.read(this.jsonPath('tour.json'), validateTour)
    this.tour = tour
    this.emitter.fire()
  }

  private async read<T>(
    path: string,
    parse: (value: unknown) => T,
  ): Promise<T | undefined> {
    try {
      const raw = await readFile(path, 'utf8')
      if (!raw.trim()) return undefined
      try {
        return parse(JSON.parse(raw))
      } catch {
        return undefined // partially written JSON — the watcher will re-fire
      }
    } catch {
      return undefined
    }
  }

  /** True when a tour.json exists and parsed. */
  get loaded(): boolean {
    return this.tour !== undefined
  }

  getTour(): Tour | undefined {
    return this.tour
  }

  getProgress(): TourProgress {
    return this.progress
  }

  done(stepId: string): boolean {
    return this.progress.steps[stepId]?.completed === true
  }

  private jsonPath(file: string): string {
    return join(this.dir as string, file)
  }

  /** Fold one traced attempt into the progress file, then hand it to the agent. */
  async recordAttempt(
    stepId: string,
    attempt: { netWpm: number; accuracy: number },
  ): Promise<void> {
    if (!this.dir) return
    this.progress = foldAttempt(this.progress, stepId, attempt)
    try {
      await writeFile(this.jsonPath('tour-progress.json'), JSON.stringify(this.progress, null, 2))
    } catch {
      /* read-only workspace — progress stays in memory for the session */
    }
    this.emitter.fire()
  }

  /** Forget every score so the path restarts from the first step. */
  async resetProgress(): Promise<void> {
    if (!this.dir) return
    this.progress = emptyProgress()
    await unlink(this.jsonPath('tour-progress.json')).catch(() => {})
    this.emitter.fire()
  }

  private readonly disposables: vscode.Disposable[] = []

  dispose(): void {
    this.emitter.dispose()
    for (const d of this.watchers) d.dispose()
    for (const d of this.disposables) d.dispose()
  }
}
