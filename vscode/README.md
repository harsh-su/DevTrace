# AItrace for VS Code

**AI proposes, you type it.**

AItrace helps you understand AI-generated code by making you write it yourself.
Instead of accepting a diff you only skimmed, you trace the change character by
character inside VS Code — so you ship code you can actually explain.

AItrace works with GitHub Copilot, OpenCode, and Google Antigravity. AI edits are
staged for hand-typing instead of being written straight to disk. You decide what
lands.

## Why AItrace?

AI can write code faster than we can understand it. Accepting a diff is fast, but
it skips the part where the code becomes yours.

AItrace adds a deliberate pause:

- See exactly what the AI wants to change.
- Type the change yourself, with real syntax context.
- Measure what stuck: speed, accuracy, indentation, and repeated mistakes.
- Save exactly what you typed — or discard the proposal entirely.

No account. No server. Everything stays in your workspace.

## Quick start

1. Install AItrace and open the **AItrace** sidebar (the keyboard icon).
2. Choose an integration:
   - **Setup GitHub Copilot Integration**
   - **Install OpenCode Plugin**
   - **Setup Google Antigravity Integration**
3. Ask your AI assistant to make a code change.
4. AItrace stages the edit under `.aitrace/pending/` instead of writing it.
5. Open **Pending Changes**, trace the highlighted hunks, then **Save** or
   **Discard**.

You can also trace existing code without any integration: select code and run
*AItrace: Trace Selection*, or use *AItrace: Trace File Range* for the whole file.

## Features

### Trace AI edits before they land

The Copilot hook, OpenCode plugin, and Antigravity hook capture proposed edits and
stage them in `.aitrace/pending/`. Nothing is written to your source file until
you finish tracing.

- Only the changed hunks are typeable; the rest of the file stays as context.
- Correct characters become normal code. Wrong characters keep the source glyph,
  show a red mark, and record the key you pressed.
- **Save** writes exactly what you typed. **Discard** (or Esc) writes nothing.
- Auto-close, auto-indent, and editor edits cannot corrupt a session — AItrace
  reverts them while you trace.

### Take a guided tour of a codebase

Ask an agent to “tour me through this project”. AItrace reads the generated
`.aitrace/tour.json` and turns it into an ordered learning path.

Each step explains the concept first, then asks you to type the relevant code.
Your scores are recorded in `.aitrace/tour-progress.json`, which the agent can read
to adapt the next steps.

### Run traced code without leaving the panel

AItrace can execute the code you just traced. Run controls appear only after at
least one hunk or step is complete, and nothing ever runs automatically.

- **Proposal mode** — *Run up to hunk N* applies the completed hunks to the current
  file text using exactly what you typed, leaves later hunks unchanged, and runs
  the result.
- **Tour mode** — *Run step* runs the file from the start through the step’s last
  line, so imports and earlier setup are included. *Run whole file* is available
  when a truncated step is not valid on its own.
- **Inline console** — stdout, stderr, compiler errors, exit code, duration,
  timeout state, and a Stop button, all below the trace.

Supported targets:

| Language | Files | Tool |
| --- | --- | --- |
| Python | `.py` | `python3 -` |
| Node | `.js`, `.mjs`, `.cjs` | `node` |
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` | `tsx` |
| Rust | `.rs` | `rustc` (single-file compile) |
| C++ | `.cpp`, `.cc`, `.cxx`, `.c++` | `c++` (single-file compile) |

Rust and C++ are compiled to a temporary binary and then executed. This is a
single-translation-unit runner, not a Cargo/CMake project build. Files need an
`fn main` / `int main` entry point, and local modules or quoted includes are
resolved on a best-effort basis.

Use `aitrace.run.command` when a project needs a custom command. The template
receives `${file}`, pointing at a temporary copy of the traced source, and runs
through your shell.

### Metrics that reflect real typing

Every session is scored from the full keystroke log:

- Net and raw WPM
- Accuracy and consistency
- Indentation accuracy per line
- Average key interval
- Most-missed keys

The same trace engine runs in the extension and the browser, so scores are
comparable everywhere.

## Commands

| Command | What it does |
| --- | --- |
| `AItrace: Open Sidebar (Pending Changes)` | Open the AItrace sidebar |
| `AItrace: Trace Selection` | Trace the current editor selection |
| `AItrace: Trace File Range` | Trace the entire active file |
| `AItrace: End Trace Session` | End the current trace |
| `AItrace: Show Last Results` | Reopen the last metrics summary |
| `AItrace: Trace Next Learning Step` | Continue the guided tour |
| `AItrace: Clear Learning Path Progress` | Reset tour scores |
| `AItrace: Setup GitHub Copilot Integration` | Install the Copilot hook in this workspace |
| `AItrace: Install OpenCode Plugin` | Install the OpenCode plugin for your user |
| `AItrace: Setup Google Antigravity Integration` | Install the Antigravity hook in this workspace |

The sidebar also provides inline actions for accepting, tracing, or discarding
pending files.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `aitrace.enabled` | `true` | Whether AItrace staging is on |
| `aitrace.autoTrace` | `false` | Open the trace panel automatically for each pending file |
| `aitrace.showGhost` | `true` | Render remaining target text as ghost text |
| `aitrace.advanceOnError` | `true` | Advance even on a wrong keystroke (non-blocking tracing) |
| `aitrace.playSound` | `false` | Play subtle keystroke feedback |
| `aitrace.queueDir` | `.aitrace` | Workspace-relative staging directory |
| `aitrace.debug` | `false` | Log trace input handling to the AItrace output channel |
| `aitrace.run.python` | `python3` | Python interpreter for Run |
| `aitrace.run.node` | `node` | Node.js executable for Run |
| `aitrace.run.tsx` | `tsx` | TypeScript runner for Run |
| `aitrace.run.rustc` | `rustc` | Rust compiler for Run |
| `aitrace.run.cpp` | `c++` | C++ compiler for Run |
| `aitrace.run.rustEdition` | `2021` | Rust edition passed to `rustc` |
| `aitrace.run.cppStandard` | `c++17` | C++ standard passed to the compiler |
| `aitrace.run.command` | empty | Custom command template using `${file}` |
| `aitrace.run.timeoutMs` | `15000` | Timeout per compile or run phase |

## Integrations

Each integration stages AI edits into `.aitrace/pending/` and turns staging on by
creating the queue directory in the workspace.

- **GitHub Copilot** — writes `.github/hooks/aitrace.json` and the hook script.
  Works with Copilot in VS Code and the Copilot CLI.
- **OpenCode** — installs the plugin into `~/.config/opencode/plugins/`.
- **Google Antigravity** — writes the hook into `.agents/`.

Setup is available from the AItrace sidebar. You can disable staging at any time
from the same sidebar.

## Safety and privacy

- AItrace does not run AI code automatically.
- Staged changes stay in `.aitrace/` until you trace and save them or discard them.
- Run executes real code and compilers on your machine. Only run code you trust.
  AItrace asks for consent once per workspace before the first run.
- Everything happens locally in your workspace. No account or remote service is
  required.

## Requirements

- VS Code 1.90 or newer.
- An optional AI integration: GitHub Copilot, OpenCode, or Google Antigravity.
- For Run: the relevant runtime or compiler must be installed and available on
  `PATH` (`python3`, `node`, `tsx`, `rustc`, or `c++`).

## Tips

- Trace a small selection first. One function is a better lesson than one file.
- Turn on `aitrace.autoTrace` if you want every staged edit to open automatically.
- Use the hunk navigator to jump between changes; only the active hunk is scored.
- On a guided tour, trace the step before running it. Reading plus typing plus
  running is the full loop.
- If a Rust/C++ tour step will not compile, use *Run whole file* to include the
  missing surrounding code.

## Feedback

Found a bug or have an idea? Open an issue in the project repository.
