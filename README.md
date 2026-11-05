# AItrace for VS Code

**AI proposes, you type it.** AItrace helps you understand AI-generated code by
making you write it yourself, so you ship code you actually know.

## Features

- **Type-over tracing in the real editor.** The target stays as ghost text. A
  correct character turns normal; a wrong one keeps the source glyph with a red
  mark and the key you pressed. Auto-close and auto-indent can't corrupt a
  session because every editor edit is reverted.
- **Trace existing code.** Trace the current selection, or the whole file with
  *AItrace: Trace File Range*.
- **Trace AI edits before they land.** The GitHub Copilot hook, OpenCode plugin,
  and Antigravity hook stage proposed changes in `.aitrace/pending/` instead of
  writing them. Pending hunks open as ghost text beside the editor; **Save**
  writes once, **Discard** (or Esc) writes nothing.
- **Take a guided tour.** Agents author `tour.json`; AItrace turns it into an
  ordered learning path, serves each step as explain-then-type, and records your
  scores in `tour-progress.json`.
- **Metrics.** Net/raw WPM, accuracy, consistency, indentation accuracy, average
  key interval, and most-missed keys, all derived from the full keystroke log.

## Setup

Open the AItrace sidebar (the keyboard icon) and choose an integration:

- **Setup GitHub Copilot Integration** writes `.github/hooks/aitrace.json` and
  the hook script into the workspace. It works with Copilot in VS Code and the
  Copilot CLI.
- **Setup OpenCode Plugin** installs the plugin into `~/.config/opencode/plugins/`.
- **Setup Google Antigravity Integration** writes the hook into `.agents/`.

Each setup also turns staging on by creating `.aitrace/` in the workspace.
