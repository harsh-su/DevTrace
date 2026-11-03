import * as vscode from 'vscode'
import { diffHunks } from '@aitrace/core'
import type { PendingFile, PendingStore } from './staging.js'

/** Added / Modified / Deleted, in the same spirit as Source Control letters. */
type ChangeStatus = 'A' | 'M' | 'D'

function statusOf(group: PendingFile): ChangeStatus {
  const { before, after } = group
  if (before.length === 0 && after.length > 0) return 'A'
  if (after.length === 0) return 'D'
  return 'M'
}

function editCount(n: number): string {
  return n === 1 ? '1 edit' : `${n} edits`
}

function hunkCount(n: number): string {
  return n === 1 ? '1 hunk' : `${n} hunks`
}

/** One pending file, shown like a Source Control file row. */
export class PendingItem extends vscode.TreeItem {
  constructor(readonly group: PendingFile) {
    const rel = vscode.workspace.asRelativePath(group.file, false)
    super(rel, vscode.TreeItemCollapsibleState.None)
    this.id = `file:${group.file}`
    this.contextValue = 'aitrace.pending'
    this.resourceUri = vscode.Uri.file(group.file)

    let hunks = 0
    try {
      hunks = diffHunks(group.before, group.after).length
    } catch {
      hunks = 0
    }
    this.description = `${editCount(group.entries.length)} · ${hunkCount(hunks)}`
    this.tooltip = new vscode.MarkdownString(
      `**${rel}**\n\n${editCount(group.entries.length)} · ${hunkCount(hunks)} · ` +
        `last staged ${new Date(group.lastTs).toLocaleTimeString()}\n\n` +
        `Click to trace every outstanding change to this file.`,
    )
    this.command = {
      command: 'aitrace.pending.trace',
      title: 'Trace file changes',
      arguments: [group.file],
    }
  }
}

export class PendingTreeProvider implements vscode.TreeDataProvider<PendingItem> {
  private readonly emitter = new vscode.EventEmitter<PendingItem | undefined | void>()
  readonly onDidChangeTreeData = this.emitter.event

  constructor(private readonly store: PendingStore) {}

  refresh(): void {
    this.emitter.fire()
  }

  getTreeItem(element: PendingItem): vscode.TreeItem {
    return element
  }

  getChildren(): PendingItem[] {
    return this.store.groups().map((group) => new PendingItem(group))
  }

  dispose(): void {
    this.emitter.dispose()
  }
}

/**
 * Colours each pending file with the familiar Source Control M/A/D badge, so the
 * panel reads at a glance the way the Changes list does.
 */
export class PendingDecorations implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>()
  readonly onDidChangeFileDecorations = this.emitter.event
  private readonly byPath = new Map<string, ChangeStatus>()

  constructor(store: PendingStore) {
    store.onDidChange(() => {
      this.byPath.clear()
      for (const group of store.groups()) {
        this.byPath.set(vscode.Uri.file(group.file).toString(), statusOf(group))
      }
      this.emitter.fire(undefined)
    })
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const status = this.byPath.get(uri.toString())
    if (!status) return undefined
    const color =
      status === 'A'
        ? new vscode.ThemeColor('gitDecoration.addedResourceForeground')
        : status === 'D'
          ? new vscode.ThemeColor('gitDecoration.deletedResourceForeground')
          : new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
    return {
      badge: status,
      color,
      propagate: false,
      tooltip: status === 'A' ? 'New file' : status === 'D' ? 'Deletes code' : 'Edits code',
    }
  }

  dispose(): void {
    this.emitter.dispose()
  }
}
