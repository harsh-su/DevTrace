# DevTrace for VS Code

**AI proposes, you type it.** DevTrace turns AI-generated code into a *trace*:
the proposed code appears in your editor as dim ghost text, you type it by hand,
and every keystroke is scored. Nothing is auto-applied — the code becomes yours
because you wrote it.

This is the editor surface of DevTrace. It shares the exact trace engine
with the web app (`@devtrace/core`), so the numbers are identical.

## Features

- **Type-over tracing in the real editor.** The document is kept immutable and
  the untyped remainder is rendered as ghost text. A correct character turns
  normal, a wrong one keeps the source glyph with a red mark plus the key you
  actually pressed. Auto-close and auto-indent can't corrupt a session because
  every editor edit is reverted.
- **Trace existing code.** Select a block and run *DevTrace: Trace Selection*,
  or *DevTrace: Trace File Range* for the whole file.
- **Trace AI changes from OpenCode.** With the `opencode-devtrace` plugin, edits
  the agent wants to make are staged instead of written. All pending edits to the
  same file collapse into one entry; DevTrace opens a dedicated panel beside the
  editor showing every outstanding hunk as ghost text — you type it there, not
  over the real file. **Save** writes the file once; **Discard** (or Esc, or
  closing the panel) writes nothing. No prompts,
  no choices. Run **DevTrace: Install OpenCode Plugin** to set it up, then
  restart opencode.
- **Metrics worth having.** Net/raw WPM, accuracy, consistency, indentation
  accuracy, average key interval, and a most-missed-keys breakdown — computed
  from the full keystroke log.

## Commands

| Command | What it does |
| --- | --- |
| `DevTrace: Trace Selection` | Trace the selected text in place |
| `DevTrace: Trace File Range` | Trace the active file |
| `DevTrace: End Trace Session` | End early (also `Esc` while tracing) |
| `DevTrace: Show Last Results` | Reopen the last session's results |

While a session runs, `Enter`, `Tab`, and `Backspace` are bound so the editor
never inserts them itself — they drive the tracer.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `devtrace.advanceOnError` | `true` | Keep going on a wrong keystroke (DevTrace's model) |
| `devtrace.showGhost` | `true` | Dim the untyped remainder |
| `devtrace.queueDir` | `.devtrace` | Where the OpenCode plugin writes staged changes |
| `devtrace.debug` | `false` | Log input handling to the DevTrace output channel (if typing isn't being scored) |

## Develop

```bash
npm install          # from the repo root (workspaces)
cd vscode
npm run build        # bundles to dist/extension.js
npm run typecheck
```

Press <kbd>F5</kbd> in VS Code to launch the Extension Development Host, then run
`DevTrace: Trace Selection` on any file.

## Package

```bash
cd vscode && npm run package   # produces devtrace-<version>.vsix
```

Share the `.vsix` and anyone can install it:

- VS Code UI: **Extensions → … → Install from VSIX…**, or
- CLI: `code --install-extension devtrace-0.0.1.vsix`

Once installed, run **DevTrace: Install OpenCode Plugin**, then restart
`opencode`.

To publish to the Marketplace instead, set a real `publisher` and `repository`
in `package.json`, create a Personal Access Token, then:

```bash
npx @vscode/vsce publish
```
