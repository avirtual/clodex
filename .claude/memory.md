# Session memory — Clodex

This file preserves context between Claude sessions. Read it at start so you don't re-litigate settled design decisions or miss in-flight work.

## Last shipped: v0.6.1

Tagged + pushed + GitHub release created. Nothing in-flight.

**Changes included in v0.6.1:**
- Sidebar context-% badge (green/orange/red at 60/80 thresholds) — reads live from Claude's statusline via `/tmp/wb-wrap/{name}-ctx` side-channel file
- Mention pulse: 1.6s amber animation on sidebar tab when a session receives a DM or broadcast
- `[cli:broadcast]` and `[cli:who]` are now **workspace-scoped** for Clodex-originated intents. DM stays global by name. External wb-wrap peers unchanged (they have no workspace concept).
- UI panel broadcasts are labeled `user` instead of `_ui`
- Restore-payload ctx fix: badge shows immediately on Clodex restart instead of waiting for first value change

## Settled design positions — DO NOT re-propose these

The user made deliberate calls on several things. If a new session re-raises any of these unprompted, it'll feel like déjà vu in a bad way.

1. **No opinionated default prompts.** Clodex is a tool, not an opinion. Don't ship "contrarian reviewer" / "pair implementer" / "planner" as seeded starter prompts. Don't ship "agent role presets" (template + system prompt + name combos) either — the user explicitly rejected that as "shoving opinion down the user's throat." The original wb-wrap already does it; Clodex is intentionally neutral.
2. **IPC protocol delivery** is via system prompt (`--append-system-prompt-file` for Claude, `-c model_instructions_file=...` for Codex), NOT via SessionStart hook's `additionalContext`. The hook still runs — it creates the `.jsonl` symlink — but the IPC prompt `cat` is commented out in both scripts as a revert path. Don't revive that transport.
3. **`.claude` project reader** (e.g., show agents/skills/CLAUDE.md from the target project) is explicitly NOT a priority. User feedback: "we run the cli, which has its own system of agents, skills etc. the starting prompt is probably the most we can do without getting in the way."
4. **Workspace-scoped broadcast/who, global DM** is the intended split. Don't unify. External wb-wrap peers still broadcast globally on their side (protocol unchanged for them).
5. **System prompt only applies on first create**, not on resume. IPC prompt applies always. This is product contract, not a bug.
6. **Templates do NOT currently save the System Prompt selection.** User is aware. This is a noted follow-up but not a fire.
7. **PTY-only intent capture was attempted and reverted (post-v0.6.1).** The
   theory: scan PTY bytes for `[cli:*]` intents instead of JSONL, escaping the
   JSONL-symlink dependency (which Workbench especially suffers from due to
   subagent session_id hijacking). The reality: Claude's renderer composes the
   visual terminal row with the assistant's text on the left and chrome (✻
   Thinking…, horizontal divider, status widgets) on the right via absolute
   column positioning. In the PTY byte stream, the entire row arrives as one
   logical line. `parseIntent` happily matches the opener and swallows the
   chrome into the body. This is NOT fixable by flush-timing (the chrome is
   intra-line, not inter-line), and is NOT fixable by cursor-up detection (the
   chrome is emitted as part of the same line, not after a cursor move). JSONL
   exists precisely because it carries semantic content, not terminal
   composition. For modern rich CLIs with status widgets, PTY-live intent
   capture is structurally hostile. Do not re-attempt for Clodex. For
   Workbench's migration away from JSONL, this is the hard part — not a
   drop-in refactor.

## Open follow-ups the user might pick up

Listed in the order we discussed them; none are committed. Don't start any without a direct "yes, do that" from the user.

- **IPC log export** — "Save as markdown" from the IPC panel. Preserves the multi-agent conversation artifact.
- **Drag-and-drop file onto session** — drops file path text into the PTY.
- **Pinned/favorited prompts** — star icon in library; pinned float to top of library and New Session dropdown.
- **Tray status dots** — show idle/thinking next to tray session entries (we already track activity state per session).
- **Templates remember System Prompt** — one field added to the template schema. (See settled position #6: user knows.)

## Gotchas and context

- **Ad-hoc signing** happens in `build/afterPack.js`, never via `electron-builder`'s `identity`. Required for node-pty on Apple Silicon. Don't "simplify" this.
- **DMG build races on hdiutil.** `dist:mac` runs arm64 then x64 sequentially. Do not parallelize.
- **Dev Electron rename**: `build/dev-rename-electron.js` runs as `postinstall` and rewrites `node_modules/electron/dist/Electron.app/Contents/Info.plist` so `npm start` shows "Clodex" in the menu bar. Regenerated after every `npm install`.
- **Statusline context %** comes from Claude's stdin JSON field `.context_window.used_percentage` — NOT `.context.percentage` (that's a made-up field I got wrong early on). The byte-count-estimate code was replaced with jq reading the real field.
- **Codex resume syntax** is `codex resume <UUID>` as a subcommand, not `codex --resume <id>` as a flag. Subcommand has to come AFTER all top-level flags (`--dangerously-bypass-approvals-and-sandbox`, `--enable codex_hooks`, etc.) because Codex uses clap.
- **JsonlWatcher seeks to EOF on first open.** Don't "simplify" by reverting to reading from byte 0 — that re-fires all historical `[cli:...]` intents on every Clodex restart.
- **`--dangerously-skip-permissions`** (Claude) bypasses the approval step that would trigger Cursor's IDE diff view. If the user wants in-IDE diffs, they need a Claude session spawned WITHOUT this flag. Clodex's MCP tie-in to Cursor currently only exposes `getDiagnostics` and `executeCode`; the diff-review UX requires the native Claude Code VS Code extension installed in Cursor.
- **`--dangerously-skip-permissions` is persisted in `sessions.json`** per-session. If we ever want to drop it by default, it needs a separate toggle — don't silently strip it.
- **Instruction / prompt files are 0600**. `/tmp/wb-wrap/{name}-instructions.md` (Codex), `/tmp/wb-wrap/{name}-append-prompt.md` (Claude). Don't downgrade perms.
- **UI-broadcast sender label is `user`** (was `_ui`). If changing, mirror in both `_handleIntent` call sites and the IPC log display.
- **Build artifact paths** after `npm run dist:mac`: `dist/Clodex-<ver>-arm64.dmg`, `dist/Clodex-<ver>.dmg` (x64 — no suffix), `dist/Clodex-<ver>-arm64-mac.zip`, `dist/Clodex-<ver>-mac.zip`. `gh release create v<ver> dist/*.dmg dist/*.zip` globs all four.
- **Update checker** polls `https://api.github.com/repos/avirtual/clodex/releases/latest` on startup + every 6h. Existing users see the red banner and a tray entry when a new tag is published.
- **node-pty spawn-helper exec bit (v0.6.2 fix).** npm extraction strips
  the exec bit from `node-pty/prebuilds/darwin-{arch}/spawn-helper`,
  leaving it at 0644. Every Clodex .dmg through v0.6.1 shipped broken —
  `posix_spawnp failed` on fresh installs (but worked for dev because
  `npm install` + local build retains perms). `build/afterPack.js` now
  `chmod 0755`s spawn-helper before the ad-hoc codesign step, for both
  arm64 and x64 bundles. Do not remove this — it's invisible in dev.
- **`npmRebuild: false` in package.json electron-builder config.**
  node-pty 1.x uses NAPI prebuilds which are ABI-stable across Node
  versions, so electron-builder's rebuild pass is unnecessary and
  actively fails on Python 3.12+ (distutils removed). Set alongside the
  spawn-helper fix in v0.6.2. Don't re-enable.
- **GUI launch PATH inheritance (v0.6.3 fix).** macOS apps launched via
  Dock/Finder/Launchpad inherit launchd's minimal PATH
  (`/usr/bin:/bin:/usr/sbin:/sbin`), NOT the user's shell PATH. `claude`
  (typically `~/.local/bin`) and `codex` (typically `/opt/homebrew/bin`)
  weren't resolvable, so agent spawns failed silently. `main.js` now
  runs `$SHELL -ilc 'printf __CLODEX_PATH__%s__CLODEX_PATH__ "$PATH"'`
  on startup in packaged builds and merges the result into
  `process.env.PATH` before any PTY spawn. Dev mode skips it
  (`app.isPackaged` gate) because npm start inherits the shell env
  already. Also: renderer now alerts on session creation failure
  instead of only console.error'ing — prevents the "nothing happens"
  silent-failure UX that hid the bug for so long.

## Multi-agent conventions that work

The user uses `reviewer` (a Codex session with a contrarian-review prompt) as a "second opinion" for design calls. The pattern is: explain your design to reviewer via DM → they fire back severities → narrow scope → ship the narrow fix → close the loop with reviewer. This IS the product's unique value, so lean into it. If you're about to make a non-trivial design call, consider asking if the user wants to loop in reviewer (or whatever agent is online).

Other ambient agents that have existed during recent sessions: `adam` (generic test peer), `crypto` (different workspace, used to validate cross-workspace DM routing).

## Communication style

- Terse over thorough. The user responds in fragments and expects you to pick up the thread.
- Don't over-explain settled decisions. If you catch yourself re-pitching something you've already agreed on, stop.
- **No emojis.** Not in code, not in release notes, not in responses.
- When the user says "go" after you propose a plan, execute immediately — don't ask sub-questions.
- When you need the user to run a command that requires their terminal (interactive login, etc.), suggest `! <command>` at the prompt.
