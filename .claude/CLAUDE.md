# Clodex — Visual multi-agent PTY manager

## What it is

Clodex is an Electron app that wraps the Claude Code CLI and Codex CLI, giving
them a sidebar-based UI with inter-agent IPC. It's a standalone port of the
[wb-wrap](https://github.com/bogdan/wb-wrap) Python project — **not** a wrapper
around wb-wrap, but a re-implementation of its functionality directly in
Node.js so we ship one app instead of two.

Repository: https://github.com/avirtual/clodex (public)
Local dev path: `/Users/bogdan/projects/tmux/wb-wrap-ui/`
Note: the on-disk folder is still `wb-wrap-ui` for historical reasons;
`productName` / `appId` / `repo` are all "Clodex".

## Stack

- **Electron** (main + renderer, Node 18+ bundled)
- **node-pty** (PTY spawning, native addon — `electron-rebuild` required after
  `npm install`)
- **xterm.js** + `@xterm/addon-fit` + `@xterm/addon-search` (terminal
  rendering in the renderer)
- Vanilla HTML/CSS/JS for the UI (no framework — keep it simple)
- `contextIsolation: false` + `nodeIntegration: true` in the renderer so
  xterm modules can be `require()`d directly

## File layout

```
.
├── main.js               # Electron main process (everything backend)
├── preload.js            # Context bridge; exposes window.api
├── renderer/
│   ├── index.html        # Sidebar + terminal area + dialogs + IPC log
│   ├── styles.css
│   └── renderer.js       # xterm wiring, session UI, prompts, search, etc.
├── build/
│   ├── icon.svg          # Source for the app icon
│   ├── icon.icns         # Packaged app icon (generated)
│   ├── icon.iconset/     # Multi-size PNGs for iconutil (generated)
│   ├── tray-icon.svg     # Menu bar (tray) icon — template image
│   ├── tray-iconTemplate.png     # 22×22 template PNG
│   ├── tray-iconTemplate@2x.png  # 44×44 retina
│   └── afterPack.js      # Ad-hoc codesigns the .app after packaging
├── package.json          # electron-builder config lives under "build"
└── .claude/
    └── CLAUDE.md         # This file
```

## Running

```
npm install
npx electron-rebuild       # rebuilds node-pty for the Electron version
npm start                  # dev mode
npm run dist:mac           # builds .dmg + .zip for arm64 AND x64
```

`dist:mac` runs `electron-builder --mac --arm64 && electron-builder --mac --x64`.
The two builds are sequenced because running them in parallel races on
`hdiutil` for DMG creation.

## Shipping a release

1. Bump `"version"` in `package.json`.
2. `rm -rf dist && npm run dist:mac`.
3. `git add -A && git commit -m "vX.Y.Z: …"` and `git push`.
4. `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. `gh release create vX.Y.Z dist/*.dmg dist/*.zip --title "…" --notes "…"`.

No CI — builds are local. `gh auth` uses the user's existing GitHub CLI login
(`avirtual` account).

## Signing / distribution

- The app is **ad-hoc signed** by `build/afterPack.js` (runs `codesign -s -`
  on the packaged `.app`). This prevents the "killed" error on Apple Silicon
  that happens when a native module (node-pty) is unsigned.
- It is **not** notarized — no Apple Developer account. On first launch users
  need to right-click → Open → Open, or `xattr -cr /Applications/Clodex.app`
  if Gatekeeper flags it as "damaged". README has instructions.
- If you need true auto-install updates someday, that requires a Developer ID
  Application cert ($99/yr) and notarization.

## Architecture

### Main process (main.js)

Responsibilities, roughly in order they appear in the file:

- **Persistence modules** (top of file):
  - `persistence` — sessions.json, one entry per session with
    `{ name, type, cwd, extraArgs, sessionId, workspaceId, label }`.
    Auto-migrates old entries to `workspaceId: 'default'` on load.
  - `workspaces` — workspaces.json, `{ id, name, bounds }` per window.
  - `templates` — saved session configs for the new-session dialog.
  - `prompts` — saved prompts for the Prompts Library drawer.
  - Files live in `app.getPath('userData')` which on macOS is
    `~/Library/Application Support/Clodex/`.

- **IntentScanner** — ports `wb-wrap/scanner.py`. Strips ANSI escapes and
  decorator chars (⏺, •, ►, etc.) from a line, then matches
  `[cli:dm target]`, `[cli:broadcast]`, `[cli:who]`, `[cli:name]`,
  escape (`\[cli:…]`).

- **Registry + Transport** — ports `wb-wrap/registry.py` and `transport.py`.
  - `/tmp/wb-wrap/{name}.json` file-based registry with atomic link/unlink
    for O_EXCL-like registration.
  - `/tmp/wb-wrap/{name}.sock` Unix socket per agent session; each session
    accepts incoming messages from external `wb-wrap send` callers.
  - Stale entries (dead pid) are force-cleaned on registration retry.

- **JsonlWatcher** — ports `wb-wrap/jsonl_watcher.py`:
  - Polls `/tmp/wb-wrap/{name}.jsonl` (a symlink created by the SessionStart
    hook) every 250ms.
  - Follows the symlink target through `/clear` and compact operations.
  - Extracts assistant text from both formats:
    - Claude: `{type: "assistant", message.content: [{type:"text", text:…}]}`
    - Codex: `{type: "event_msg", payload: {type:"agent_message", message:…}}`
  - Buffers by requestId, flushes on new requestId, non-assistant entry,
    or 1s of silence (turn complete).
  - Emits: `onText(text)` for intent scanning, `onSessionId(id)` for
    persistence, `onActivity('thinking'|'idle')` for UI and notifications.

- **Claude / Codex hook setup**:
  - Claude: generates `/tmp/wb-wrap/{name}-hook.sh` + `{name}-hook.json`
    (settings file passed via `--settings`). Hook reads stdin JSON for
    `transcript_path`, creates atomic symlink, `cat`s a pre-rendered
    `{name}-hook-output.json` (additionalContext with IPC protocol prompt).
  - Codex: writes a project-level `.codex/hooks.json` (backed up to
    `.wb-wrap-backup` if one already exists). Shared hook script at
    `/tmp/wb-wrap/codex-session-hook.sh` reads `WB_WRAP_NAME` env var to
    route to the right session.
  - `cleanupClaudeHook(name)` / `cleanupCodexHook(name, cwd)` run on
    session exit.

- **SessionManager**:
  - `sessions: Map<name, Session>` — global across the app, regardless of
    which window owns a session.
  - `windows: Map<workspaceId, BrowserWindow>` — tracks which window maps
    to which workspace.
  - `_sendToSession(name, channel, ...)` — sends IPC to the window that
    owns the session.
  - `_broadcast(channel, ...)` — sends to all windows (used for
    `ipc-message` channel so every window's IPC log shows all traffic).
  - `create(name, type, cwd, extraArgs, resumeId, workspaceId)`:
    1. Build argv based on type (inject `--settings` for Claude, hooks for
       Codex, `--resume` if resumeId, `--add-dir MSG_DIR` for both).
    2. Spawn PTY.
    3. For agent types: start Transport on Unix socket, register in
       `/tmp/wb-wrap/`, start JsonlWatcher. Bash sessions are private —
       no socket, no registration, invisible to `[cli:who]`.
    4. Persist the session in sessions.json.
    5. Hook up PTY onData (forward to window, scan intents if non-agent)
       and onExit (cleanup, notify renderer, refresh tray).
  - `_handleIntent(sender, intent)`:
    - `dm`: deliver to local agent session if target is one, else forward
      to external peer via Unix socket.
    - `broadcast`: deliver to every local agent + every external peer
      (skip bash — they can't process intents).
    - `who`: inject `[peers] <names>` into the sender's stdin (excludes
      bash sessions).
    - `name`: inject `[name] <senderName>`.
  - `_injectText(session, text)`: Ctrl-U (clear line) + text with `\n`→`\r`
    + sleep (50ms short, 1s for text >200 chars) + `\r` (Enter).
  - `_deliverMessage(target, sender, body, type)`: spills to
    `/tmp/wb-wrap/messages/` if body >500 bytes, injects
    `[from SENDER] body` or pointer text.
  - `kill(name)` marks `_userKilled = true` and removes from persistence.
  - `killAll()` (shutdown) marks `_shuttingDown = true` and keeps
    persistence intact so sessions resume next launch.

- **Update checker**:
  - Hits `https://api.github.com/repos/avirtual/clodex/releases/latest` on
    startup and every 6h.
  - Simple semver compare against `app.getVersion()`.
  - If newer: notification + renderer banner + tray menu entry. Clicking
    opens the release URL in the default browser. No auto-install (ad-hoc
    signing would fight it).

- **Tray (menu bar) icon**:
  - Template PNG (black silhouette, macOS auto-tints for light/dark menu
    bar). Shows session list grouped by workspace, New Session, New
    Window, update entry, Check for Updates, Quit.
  - `refreshTrayMenu()` is called on session create/exit, update detection,
    workspace rename/create.

- **App menu** (`Menu.setApplicationMenu(…)`):
  - Adds File > New Window (Cmd+Shift+N), New Session (Cmd+T), and lists
    workspaces under Window for quick navigation.
  - `refreshAppMenu()` is called when workspaces change.

- **App lifecycle**:
  - On `whenReady`: load all persistence paths, start update checker,
    `initTray()`, register all IPC handlers, call `buildAppMenu()`,
    then open one window per saved workspace (or default if none).
  - On macOS `window-all-closed`: **do not quit**. App stays alive in tray,
    sessions keep running. Reopen a window via tray to see them.
  - `before-quit`: `killAll()` — this is the "real" quit path.

### Preload (preload.js)

Assigns `window.api = { … }`. Three categories:

1. **Invokable** (round-trip): `createSession`, `listSessions`, `killSession`,
   `resizeSession`, `setSessionLabel`, `broadcast`, `exportSessionMarkdown`,
   `selectDirectory`, `confirmKill`, `restoreSessions`,
   `list|save|removeTemplate`, `list|save|removePrompt`, `injectPrompt`,
   `checkForUpdate`, `getUpdateInfo`, `openUpdate`, `getVersion`,
   `listWorkspaces`, `currentWorkspace`, `setWorkspaceName`, `newWorkspace`.
2. **Fire-and-forget**: `writeToSession(name, data)` (PTY stdin),
   `showSessionContextMenu(name, cwd)`.
3. **Event listeners**: `onPtyData`, `onSessionExit`, `onIpcMessage`,
   `onSessionActivity`, `onUpdateAvailable`, `onSessionContextAction`,
   `onRequestSwitchSession`, `onRequestOpenNewDialog`.

With `contextIsolation: false`, this just writes to the window object
directly — no `contextBridge.exposeInMainWorld` indirection needed.

### Renderer (renderer/renderer.js)

Single-file orchestrator, roughly:

1. Grab DOM refs for every widget (sidebar, dialog, IPC log, prompts
   drawer, prompt editor, search bar, update banner).
2. **Workspace** — initial fetch of `currentWorkspace()` + `listWorkspaces()`
   to show the workspace name in the sidebar header; double-click to rename.
3. **Session UI**:
   - `addSessionToSidebar(name, type, cwd, label)` — renders a sidebar
     item with type badge + shortened cwd. Right-click → IPC to main for
     native context menu. Double-click name to rename (display-only label,
     doesn't change the IPC name).
   - `createTerminal(name)` — instantiates an xterm.js Terminal, a FitAddon,
     and a SearchAddon. Stores them in `sessions: Map<name, {terminal,
     fitAddon, searchAddon, wrapperEl}>`. Each wrapper div is kept in the
     DOM; we swap `visibility: hidden/visible` to switch active session
     (hiding via `display:none` breaks xterm's measurement).
   - `switchSession(name)` — toggles visibility, updates sidebar active
     state, fits/focuses/resizes the PTY, closes the search bar if open.
4. **New-session dialog**: name, type (with default args per type), cwd,
   extra CLI args (with hint per type), and a Templates dropdown +
   "Save as Template…" button.
5. **Keyboard shortcuts** (captured at document level with `capture: true`
   so xterm doesn't swallow them):
   - `Cmd+T` new session · `Cmd+W` kill active (with confirm) or close
     dialog · `Cmd+1..9` switch session by index · `Cmd+Shift+]`/`Cmd+Shift+[`
     next/prev · `Cmd+F` open search bar.
6. **IPC log panel**: bottom drawer, collapsible. Broadcast input +
   Send button at the top. Entries show timestamp, sender → target (or
   "all" for broadcasts), body. Counter badge for unread messages while
   collapsed.
7. **Prompts library**: 📝 button in sidebar header opens a side drawer.
   Click a prompt to inject into the active session's PTY stdin (via
   `window.api.injectPrompt` which uses the same Ctrl-U + text + Enter
   routine as agent-to-agent delivery).
8. **Update banner**: red pill at the bottom of the sidebar when a newer
   version is available on GitHub. Click opens the release page.
9. **Restore** (IIFE at end of file): calls `window.api.restoreSessions()`
   for this window's workspace, creates terminal + sidebar entry for each,
   switches to the first.

## Session lifecycle

1. User picks type/name/cwd/args in the dialog (or a template) → renderer
   calls `createSession(name, type, cwd, extraArgs)`.
2. Main's `session:create` handler looks up the sender window's workspace
   ID and calls `manager.create(…)`.
3. Manager spawns the PTY (with hook injection for agents), registers on
   the shared `/tmp/wb-wrap/` socket + json file (agents only), persists
   the session, starts the JsonlWatcher (agents only).
4. Terminal appears in sidebar → xterm opens, renderer pipes keystrokes
   through `writeToSession` → main writes to PTY stdin.
5. Agent responds — hook has already fired on SessionStart, creating the
   JSONL symlink. JsonlWatcher sees new entries, buffers by requestId,
   flushes on turn complete, scans flushed text for `[cli:…]` intents.
6. Intents route via `_handleIntent`. Non-agent (bash) sessions scan
   their PTY stdout directly (old-style wb-wrap stdout scanner).
7. On `--resume`, we pass the persisted sessionId from sessions.json so
   the agent picks up the prior conversation. The JsonlWatcher updates
   the stored sessionId every time the symlink points at a new transcript
   (Claude mints a new ID on /clear/compact).
8. User kills session → `kill(name)` → `_userKilled = true`, persistence
   entry removed, SIGTERM (SIGKILL escalation after 5s), `_cleanup(name)`
   tears down watcher, transport, registry, hooks.
9. App quit → `killAll()` marks all sessions `_shuttingDown = true` and
   kills PTYs, but **does not** remove from persistence — sessions resume
   on next launch.

## Workspaces (multi-window)

- Each BrowserWindow = one workspace with a stable UUID.
- `DEFAULT_WORKSPACE_ID = 'default'` for the original/primary window.
- Sessions carry a `workspaceId`; `session:list` IPC returns
  workspace-scoped sessions (derived from `workspaceOfSender(e)`).
- `session:listAll` exists for the tray (which shows all sessions grouped
  by workspace).
- Window position + size are persisted per workspace via
  `win.on('resize'|'move', saveBounds)`.
- The renderer's workspaceId is passed in via
  `webPreferences.additionalArguments: [--workspace-id=…]`, though the
  renderer actually just asks via `currentWorkspace()` IPC — no parsing
  needed.
- IPC traffic (`ipc-message` channel) broadcasts to every window, because
  any window might care about conversations in another.

### Closing and reopening workspaces

- Closing a workspace window does NOT kill its sessions. The workspace
  record stays in workspaces.json, sessions keep running in the background
  with `workspaceId` set to that closed workspace.
- While a workspace has no window:
  - `_sendToSession()` detects no attached window and buffers `pty-data`
    into `session.pendingOutput` (capped at 2MB, oldest bytes dropped
    if exceeded).
  - `session-exit` and `session-activity` events for detached sessions
    are silently dropped — they'll be recomputed when a window reopens.
- Reopening a workspace:
  - File > New Workspace creates a brand-new workspace (new UUID).
  - **Reopening a specific existing workspace** happens via:
    - Window menu > Workspaces > click the ○ (closed) workspace
    - Tray menu > Reopen Workspace > pick one
    - Quit and relaunch — all workspaces restore automatically
  - When a window reattaches to an existing workspace, `restore-sessions`
    finds sessions already in `manager.sessions`, returns them with
    `replay: session.pendingOutput` so the renderer can prepopulate the
    xterm with missed output before live data resumes.
- **Close Workspace Permanently** (Window menu): prompts for confirmation,
  kills all sessions in that workspace, removes the workspace record.
  This is the only way to actually delete a workspace.
- Renaming: Double-click the workspace name in the sidebar header, or
  File > Rename Workspace…. Triggers an inline input that calls
  `setWorkspaceName` IPC on blur/Enter. Name shows up in the tray,
  Window menu, and window title.

## Gotchas / non-obvious

- **`sessions.set(name, …)` is keyed by name globally** — two windows
  can't have a session with the same name. That's by design (matches
  wb-wrap's global namespace) but worth knowing.
- **Bash sessions are private**: no registry, no socket, not shown in
  `[cli:who]`, not targetable by `[cli:dm]`. They're just terminals.
- **`contextIsolation: false`** is required because the renderer needs
  `require()` for xterm modules. This is a common Electron dev tool
  pattern; not a concern for a local CLI-wrapper app but be aware if the
  threat model ever changes.
- **Ad-hoc signing MUST happen in `afterPack`** (not via
  `electron-builder`'s `identity: "-"`, which doesn't work reliably).
  Without it, node-pty fails to load on Apple Silicon with "killed".
- **DMG build races on hdiutil** — `dist:mac` runs the two archs
  sequentially; don't "optimize" by parallelizing.
- **`PERSIST_FILE` et al. are `let`-declared and assigned in
  `app.whenReady()`** because `app.getPath('userData')` isn't available
  until then. Any code that reads these before `whenReady` will crash.
- **wb-wrap-ui → Clodex productName rename**: userData path went from
  `~/Library/Application Support/wb-wrap-ui/` to `…/Clodex/`. A one-time
  `cp` was needed for early users who upgraded from v0.1.x. All new
  installs are clean.
- **Session name regex**: `[a-zA-Z0-9._-]{1,64}` (same as wb-wrap).
  Hyphens are allowed despite one false alarm during early testing.
- **IPC log panel uses `visibility` not `display`** for collapsing so
  xterm.js doesn't lose its measurements — this same gotcha bit us with
  session switching initially.

## Related

- Upstream Python version: `/Users/bogdan/projects/tmux/wb-wrap/` — the
  original CLI wrapper. Clodex re-implements its protocol in Node but
  shares the registry directory (`/tmp/wb-wrap/`), so a Clodex session
  and an external `wb-wrap` session on the same machine can still DM
  each other.
- The protocol reference (intent syntax + rules) lives in
  `wb-wrap/wb_wrap/prompt.txt` and is duplicated as the `IPC_PROMPT`
  constant in `main.js`.
