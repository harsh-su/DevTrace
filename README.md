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

## Run traced code

AItrace can execute the code you just traced, without leaving the panel:

- **Proposal mode** — *Run up to hunk N* applies the completed hunks to the
  current file text using exactly what you typed, leaves later hunks unchanged,
  and runs the result. When every hunk is traced, *Run all traced changes* runs
  the finished file.
- **Tour mode** — *Run step* runs the file from the start through the step's last
  line, so imports and earlier setup are included. *Run whole file* runs the
  complete file when a truncated step is not valid on its own.
- **Manual only** — nothing runs automatically. The Run controls appear once at
  least one hunk or step is complete, and every run can be stopped. Output,
  compiler errors, exit code, duration, and timeout state appear in the inline
  console below the trace.

Supported targets:

| Language | Files | Tool |
| --- | --- | --- |
| Python | `.py` | `python3 -` |
| Node | `.js`, `.mjs`, `.cjs` | `node` |
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` | `tsx` |
| Rust | `.rs` | `rustc` (single-file compile) |
| C++ | `.cpp`, `.cc`, `.cxx`, `.c++` | `c++` (single-file compile) |

Rust and C++ are compiled into a temporary binary and then executed. This is a
single-translation-unit runner, not a Cargo/CMake project build; files need an
`fn main` / `int main` entry point, and local modules or quoted includes are
resolved on a best-effort basis. Configure `aitrace.run.rustc`,
`aitrace.run.cpp`, `aitrace.run.cppStandard`, or `aitrace.run.command` when a
project needs a different toolchain. The `aitrace.run.command` template receives
`${file}` pointing at a temporary copy of the traced source and runs through
your shell.

**Safety:** Run executes real code and compilers on your machine. Only run code
you trust. AItrace asks for consent once per workspace before the first run.

## Setup

Open the AItrace sidebar (the keyboard icon) and choose an integration:

- **Setup GitHub Copilot Integration** writes `.github/hooks/aitrace.json` and
  the hook script into the workspace. It works with Copilot in VS Code and the
  Copilot CLI.
- **Setup OpenCode Plugin** installs the plugin into `~/.config/opencode/plugins/`.
- **Setup Google Antigravity Integration** writes the hook into `.agents/`.

Each setup also turns staging on by creating `.aitrace/` in the workspace.
