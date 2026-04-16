# Clodex

A visual multi-agent PTY manager for **Cl**aude Code and C**odex** CLIs. Run multiple agent sessions side-by-side in a single Mac app, with built-in inter-agent messaging — agents can DM each other, broadcast updates, and discover peers.

![Sidebar with agent sessions, terminal viewport on the right](./docs/screenshot.png)

## What it does

- **Sidebar with agent sessions** — switch between Claude, Codex, and bash sessions with a click
- **Embedded xterm.js terminals** — each session is a real PTY with full terminal support
- **Inter-agent IPC** — agents can write `[cli:dm bob] hello` in their responses to message each other; DMs land in the recipient's stdin as `[from alice] hello`
- **Persistence** — sessions resume across app restarts via `claude --resume <session_id>`
- **Wire-compatible with [wb-wrap](https://github.com/bogdan/wb-wrap)** — registers on `/tmp/wb-wrap/` so Clodex sessions and external `wb-wrap` instances can talk

## Install

Download the latest DMG from [Releases](https://github.com/avirtual/clodex/releases):

- **Apple Silicon (M1/M2/M3/M4)**: `Clodex-x.y.z-arm64.dmg`
- **Intel Macs**: `Clodex-x.y.z.dmg`

Open the DMG, drag **Clodex** to your Applications folder.

### First launch

Clodex is **ad-hoc signed** but not notarized by Apple (no $99/year developer cert). On first launch:

1. Right-click `Clodex.app` in Applications → **Open**
2. Click **Open** in the warning dialog
3. From now on, double-click works normally

If you see *"Clodex is damaged and can't be opened"*, run:

```bash
xattr -cr /Applications/Clodex.app
```

This removes macOS's quarantine flag, which is added to anything downloaded from the internet.

## Requirements

- macOS 10.12+
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (`claude` in PATH) — for Claude sessions
- [Codex CLI](https://github.com/openai/codex) (`codex` in PATH) — for Codex sessions

## Usage

1. Click **+** in the sidebar
2. Choose a name, type (claude/codex/bash), and working directory
3. Hit **Create** — terminal appears, agent starts
4. Repeat for as many sessions as you want
5. Click sidebar items to switch between them

### Inter-agent messaging

Once two or more agent sessions are running, they can message each other. Just talk to Claude/Codex normally — the protocol is auto-injected into their session via SessionStart hooks. Examples:

- *"Who is online?"* → agent writes `[cli:who]` → gets `[peers] alice, bob`
- *"DM bob and ask him to check the failing test"* → agent writes `[cli:dm bob] please check the failing test` → bob receives it as `[from alice] please check the failing test`
- *"Tell everyone the build is broken"* → `[cli:broadcast] heads up, build is broken on main`

Bash sessions are private terminals — they don't participate in IPC.

## Building from source

```bash
git clone https://github.com/avirtual/clodex
cd clodex
npm install
npm start              # dev mode
npm run dist:mac       # build .dmg for both archs
```

## How it works

Each agent session is a node-pty subprocess running `claude` or `codex`. Clodex injects a SessionStart hook (via `--settings` for Claude, via `.codex/hooks.json` for Codex) that creates a symlink to the JSONL transcript. A watcher tails that JSONL, extracts assistant text, and scans it for `[cli:...]` intents. Matching intents get routed to the target session's PTY stdin or to an external peer's Unix socket.

See the [wb-wrap project](https://github.com/bogdan/wb-wrap) for the original CLI version this app is derived from.

## License

MIT
