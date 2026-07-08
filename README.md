# Clodex

A visual multi-agent PTY manager for **Cl**aude Code and C**odex** CLIs. Run multiple agent sessions side-by-side in a single Mac app, with built-in inter-agent messaging — agents can DM each other and discover peers.

![Sidebar with agent sessions, terminal viewport on the right](./docs/screenshot.png)

## What it does

- **Sidebar with agent sessions** — switch between Claude, Codex, and bash sessions with a click
- **Embedded xterm.js terminals** — each session is a real PTY with full terminal support
- **Inter-agent IPC** — agents can write `[agent:dm bob] hello` in their responses to message each other; DMs land in the recipient's stdin as `[agent:from alice] hello`. Sidebar tab pulses amber when a session receives a message.
- **Self-managing agents** — beyond messaging, agents can compact / clear / reload their own context window, save and recall persistent memories, and spawn new peer sessions — all through `[agent:…]` intents emitted in their normal responses.
- **Multi-window workspaces** — each window is a workspace with its own session set; restored on relaunch. `[agent:who]` is workspace-scoped; DM is global by agent name.
- **Live context indicator** — for Claude sessions, sidebar shows a color-coded badge (green/orange/red) with the current context window usage
- **Prompts library** — author reusable prompts as files (typed *system* or *append*) that sessions reference by name; edit one file and every session that references it picks up the change. Inject into a running session, or attach at spawn — a replacement system prompt and/or ordered append blocks
- **Templates** — save New Session dialog configs and pick them from a dropdown
- **Edit args mid-stream** — right-click a session → "Edit Args…" to update its CLI args; choose to apply on next spawn or restart immediately (sessionId is preserved across restart)
- **Customizable statusline** — via Preferences (⌘,), pick which components show in Claude and Codex statuslines
- **[wirescope](https://github.com/avirtual/wirescope) integration** — route sessions through a wirescope proxy to get a live telemetry bar (context tokens, cache warmth, turn count, cost) and a one-click "keep warm" cache hold
- **Persistence** — sessions resume across app restarts via `claude --resume` / `codex resume`
- **Clodex-to-Clodex peering** — attach to sessions running on another machine's Clodex over an SSH tunnel: view live, take control, mirrored popups, remote restart. Also runs **headless on a Linux server** as a peer node — see [`peering/`](peering/)
- **Self-contained runtime** — registry, sockets, and message files live under `~/.clodex/`, owned entirely by Clodex

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

- Apple Silicon Mac (M1 or later), macOS 12 (Monterey) or later (Intel: build from source, also macOS 12+)
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (`claude` in PATH) — for Claude sessions
- [Codex CLI](https://github.com/openai/codex) (`codex` in PATH) — for Codex sessions

## Usage

1. Click **+** in the sidebar (or press ⌘T)
2. Choose a name, type (claude/codex/bash), and working directory
3. Optionally pick a **System Prompt** from your library to seed the session
4. Hit **Create** — terminal appears, agent starts
5. Click sidebar items (or press ⌘1…9) to switch between them

### Inter-agent messaging

Once two or more agent sessions are running, they can message each other. Just talk to Claude/Codex normally — the protocol is injected as a system prompt at spawn time. Examples:

- *"Who is online?"* → agent writes `[agent:who]` → gets `[agent:peers] alice, bob`
- *"DM bob and ask him to check the failing test"* → agent writes `[agent:dm bob] please check the failing test` → bob receives it as `[agent:from alice] please check the failing test`

Bash sessions are private terminals — they don't participate in IPC.

**Scoping:** `[agent:who]` is scoped to the sender's workspace — it only sees agents in the same window. `[agent:dm <name>]` is global: if an agent by that name exists in any workspace, it'll receive the DM.

### Self-management intents

Agents can also act on their own session — useful for long-running, unattended work where there's no operator to drive the CLI:

- **Context** — `[agent:context compact]` (compact in place; optional trailing text is injected as the agent's first turn afterward so it keeps working instead of stalling), `[agent:context clear]` (drop history, keep the session), `[agent:context reload] <handoff>` (cold-restart the session, adopting any edited config; the handoff body is required and becomes turn one for the fresh instance).
- **Memory** — `[agent:memory remember] <text>` saves a unit that persists across sessions (optional leading `scope=<tag>`), `[agent:memory list]` enumerates them, `[agent:memory recall] <id|query>` surfaces one back into the agent's input. Stored per-agent under `~/.clodex/library/memory/`.
- **Spawn** — `[agent:spawn name:X cwd:Y]` mints a new persistent peer session named `X` rooted at `Y` (creating the directory if absent); it joins the spawner's workspace and is immediately DM-able.

### Prompts library

Click the 📝 icon in the sidebar header to open the library. Prompts are stored as files under `~/.clodex/library/prompts/`, typed by subfolder:

- **system** prompts *replace* the CLI's default system prompt
- **append** prompts are *added* to it (a session can reference several, applied in filename order)

Sessions reference prompts by name rather than copying them — edit a file once and every session that references it picks up the change on its next spawn. You can:

- **Inject** a prompt into the active session (types it into the PTY like you pasted it)
- **Attach** at launch — the New Session and Edit Session dialogs have a "System Prompt" picker (replace) and an "Append prompts" checklist. Claude gets `--system-prompt-file` + `--append-system-prompt-file`; Codex folds them into `model_instructions_file`. The inter-agent IPC protocol is always prepended to the append blob, so messaging survives even a replaced system prompt.

### Workspaces

`⌘⇧N` opens a new workspace window. Each workspace has its own sidebar of sessions. Close a window and the sessions keep running in the background; reopen it from the tray or the Window menu. Only the most-recently-focused workspace opens on startup (IDE-style). "Close Workspace Permanently" from the Window menu kills its sessions and removes the record.

### Preferences

`⌘,` opens the Preferences dialog. It controls the statusline and the default API proxy.

- **Claude statusline**: pick any of model name, context % (real-time), session cost, working directory, git branch. Session name (`[clodex:NAME]`) is always shown.
- **Codex statusline**: pick any native components Codex supports (context-used, model-name, project-root, git-branch, five-hour-limit, current-dir, context-remaining, model-with-reasoning).
- **API proxy**: a default proxy base URL (on/off) that new sessions inherit. Per-session overrides live in the New Session / Edit Session dialog.

Running Claude sessions update live. Codex sessions pick up changes on next spawn.

### wirescope integration

Clodex can route a session's API traffic through a local proxy by pointing the CLI's base URL at it. Set a default in Preferences (proxy URL + on/off), or override per session in the New Session / Edit Session dialog (**Default** / **Off** / **Custom** URL). Claude sessions get `ANTHROPIC_BASE_URL=<proxy>/agent/<name>/anthropic`; Codex gets `-c openai_base_url=<proxy>/agent/<name>/openai/v1`.

When that proxy is [**wirescope**](https://github.com/avirtual/wirescope), Clodex pulls live per-session telemetry off the wire and shows it in a status bar under the terminal:

- **Context usage** — tokens used / window size and percentage (e.g. `ctx 113k/1M (11%)`), from the CLI statusline; falls back to message count for Codex
- **Turn count** and **model**
- **Cache warmth** — a live countdown to prompt-cache expiry, shown per sidebar tab even while a session is unfocused (the statusline can't do this — its script only runs while you interact)
- **Cost** — a wire-accurate estimate (`px est.`)
- **🔍 wirescope** — a link to the session's page on the proxy
- **keep warm** — arm a cache hold (`1h` / `4h` / `8h`) so the proxy pings periodically to keep the prompt cache warm while you're away; `✕` disarms

Telemetry is pulled (one `/_status` poll per proxy every few seconds), not pushed, and the bar only appears for sessions actually routed through a wirescope proxy. See the [wirescope repo](https://github.com/avirtual/wirescope) for the proxy itself.

### Keyboard shortcuts

- `⌘T` new session
- `⌘⇧N` new workspace window
- `⌘,` Preferences
- `⌘W` close/kill active session (with confirm) or close dialog
- `⌘1` … `⌘9` switch session by index
- `⌘⇧]` / `⌘⇧[` next / previous session
- `⌘F` terminal search

## Building from source

```bash
git clone https://github.com/avirtual/clodex
cd clodex
npm install            # postinstall also renames dev Electron.app to Clodex
npm start              # dev mode
npm run dist:mac       # build .dmg + .zip for both archs
```

## How it works

Each agent session is a node-pty subprocess running `claude` or `codex`. Clodex does three things at spawn:

1. **Registers on `~/.clodex/{name}.sock`** so messages can be delivered across Clodex windows.
2. **Installs a SessionStart hook** that creates a symlink (`~/.clodex/{name}.jsonl`) pointing at the agent's transcript file.
3. **Injects the IPC protocol as a system prompt** — `--append-system-prompt-file` for Claude, `-c model_instructions_file=…` for Codex — so the agent knows the `[agent:…]` intents it can emit.

A watcher tails the JSONL (seeking to EOF on first open so past turns don't re-fire), extracts assistant text, and scans it for `[agent:…]` intents. Matching intents get routed to the target session's PTY stdin. Messages larger than 500 bytes spill to `~/.clodex/messages/` and are delivered as a pointer for the recipient to read via its file-access tool.

Persistent data lives under `~/Library/Application Support/Clodex/`:
- `sessions.json` — one entry per session with name, type, cwd, extraArgs, sessionId (for resume), workspaceId, label, and prompt references (`systemPromptFile` / `appendPromptFiles`)
- `workspaces.json` — id, name, bounds, `lastFocusedAt`
- `agent-defaults.json` — per-agent-name defaults that outlive a kill (e.g. strip level)
- `templates.json` — saved new-session dialog configs
- `ui-settings.json` — statusline component choices

Prompt and memory files live under `~/.clodex/library/` (`prompts/{system,append}/*.md` and `memory/<agent>/*.md`), so they're shared across windows and editable outside the app.

Clodex is derived from the [wb-wrap project](https://github.com/bogdan/wb-wrap), a proof-of-concept CLI version of the same idea. As of v0.6.6 they are independent: Clodex owns its runtime dir (`~/.clodex/`) and no longer shares the `/tmp/wb-wrap/` namespace with wb-wrap sessions.

## License

MIT
