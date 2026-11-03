import * as vscode from 'vscode'
import type { TourStep } from '@aitrace/core'
import type { TourStore } from './tour.js'

/** One stop on the learning path, shown with trace/reveal actions. */
export class TourItem extends vscode.TreeItem {
  constructor(
    readonly step: TourStep,
    index: number,
    done: boolean,
    current: boolean,
  ) {
    super(`${index + 1}. ${step.title}`, vscode.TreeItemCollapsibleState.None)
    this.id = step.id
    this.contextValue = done ? 'aitrace.tour.done' : 'aitrace.tour.step'
    this.iconPath = new vscode.ThemeIcon(
      done ? 'check' : current ? 'play-circle' : 'circle-outline',
      done ? new vscode.ThemeColor('testing.iconPassed') : undefined,
    )
    const detail = done ? 'traced' : current ? 'up next' : 'not traced'
    this.description = `${step.file}:${step.start} · ${detail}`
    const range = `${step.start}–${step.start + step.lines - 1}`
    this.tooltip = new vscode.MarkdownString(
      `**${step.title}** — _${step.concept || 'code'}_\n\n` +
        (step.why ? `${step.why}\n\n` : '') +
        `\`${step.file}\` lines ${range} (${step.lines} lines to type)\n\n` +
        (done
          ? '✅ Traced.'
          : current
            ? '▶ Click to read the brief and trace it.'
            : 'Not traced yet.'),
    )
    this.command = {
      command: done ? 'aitrace.tour.reveal' : 'aitrace.tour.trace',
      title: done ? 'Reveal file' : 'Trace step',
      arguments: [step.id],
    }
  }
}

/**
 * The "Learning path" view: every tour step in order, with your progress, so a
 * guided tour reads like a checklist you work through by typing.
 */
export class TourTreeProvider implements vscode.TreeDataProvider<TourItem> {
  private readonly emitter = new vscode.EventEmitter<TourItem | undefined | void>()
  readonly onDidChangeTreeData = this.emitter.event

  constructor(private readonly store: TourStore) {
    store.onDidChange(() => this.emitter.fire())
  }

  refresh(): void {
    this.emitter.fire()
  }

  getTreeItem(element: TourItem): vscode.TreeItem {
    return element
  }

  getChildren(): TourItem[] {
    const tour = this.store.getTour()
    if (!tour) return []
    let current: number | undefined
    for (let i = 0; i < tour.steps.length; i++) {
      if (!this.store.done(tour.steps[i]!.id)) {
        current = i
        break
      }
    }
    return tour.steps.map((step, i) =>
      new TourItem(step, i, this.store.done(step.id), i === current),
    )
  }

  dispose(): void {
    this.emitter.dispose()
  }
}
