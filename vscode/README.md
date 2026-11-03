# AItrace for VS Code

**AI proposes, you type it.** AItrace turns AI-generated code into a *trace*:
the proposed code appears in your editor as dim ghost text, you type it by hand,
and every keystroke is scored. Nothing is auto-applied — the code becomes yours
because you wrote it.

This is the editor surface of AItrace. It shares the exact trace engine
with the web app (`@aitrace/core`), so the numbers are identical.

## Features

- **Type-over tracing in the real editor.** The document is kept immutable and
  the untyped remainder is rendered as ghost text. A correct character turns
  normal, a wrong one keeps the source glyph with a red mark plus the key you
  actually pressed. Auto-close and auto-indent can't corrupt a session because
  every editor edit is reverted.
- **Trace existing code.** Select a block and run *AItrace: Trace Selection*,
  or *AItrace: Trace File Range* for the whole file.
- **Trace AI changes from OpenCode.** With the `opencode-aitrace` plugin, edits
  the agent wants to make are staged instead of written. All pending edits to the
  same file collapse into one entry; AItrace opens a dedicated panel beside the
  editor showing every outstanding hunk as ghost text — you type it there, not
  over the real file. **Save** writes the file once; **Discard** (or Esc, or
  closing the panel) writes nothing. No prompts,
  no choices. Run **AItrace: Install OpenCode Plugin** to set it up, then
  restart opencode.
- **Metrics worth having.** Net/raw WPM, accuracy, consistency, indentation
  accuracy, average key interval, and a most-missed-keys breakdown — computed
  from the full keystroke log.

## Commands

| Command | What it does |
| --- | --- |
| `AItrace: Trace Selection` | Trace the selected text in place |
| `AItrace: Trace File Range` | Trace the active file |
| `AItrace: End Trace Session` | End early (also `Esc` while tracing) |
| `AItrace: Show Last Results` | Reopen the last session's results |

While a session runs, `Enter`, `Tab`, and `Backspace` are bound so the editor
never inserts them itself — they drive the tracer.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `aitrace.advanceOnError` | `true` | Keep going on a wrong keystroke (AItrace's model) |
| `aitrace.showGhost` | `true` | Dim the untyped remainder |
| `aitrace.queueDir` | `.aitrace` | Where the OpenCode plugin writes staged changes |
| `aitrace.debug` | `false` | Log input handling to the AItrace output channel (if typing isn't being scored) |

## Develop

```bash
npm install          # from the repo root (workspaces)
cd vscode
npm run build        # bundles to dist/extension.js
npm run typecheck
```

Press <kbd>F5</kbd> in VS Code to launch the Extension Development Host, then run
`AItrace: Trace Selection` on any file.

## Package

```bash
cd vscode && npm run package   # produces aitrace-<version>.vsix
```

Share the `.vsix` and anyone can install it:

- VS Code UI: **Extensions → … → Install from VSIX…**, or
- CLI: `code --install-extension aitrace-1.0.0.vsix`

Once installed, run **AItrace: Install OpenCode Plugin**, then restart
`opencode`.

To publish from GitHub Actions, create a **Trusted Publishing** policy on the
publisher page for this repository and `.github/workflows/release.yml`, then run
the *Release VS Code Extension* workflow. It authenticates with OIDC
(`vsce publish --oidc`), so no `VSCE_PAT` secret is needed.

For a manual publish from your machine, `npx @vscode/vsce publish` still works
with a Personal Access Token.
