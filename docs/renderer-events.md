# Renderer event push surface — the other half of the browser contract

The contract map for every event the main process pushes at a renderer.
`preload.js` invoke/send is the request half of `window.api` (196 endpoints);
THIS is the push half. A browser frontend must receive each of these over WS
exactly as the Electron renderer receives them over `ipcRenderer.on`.

**Authoritative receiver list**: the `ipcRenderer.on(channel, …)` calls in
`preload.js` (58 channels). This doc maps each to its emission point, its
payload shape (field NAMES, not full types), and the interception point a web
host subscribes to.

Both counts above are derived from `api-contract.js` row kinds and are pinned
by `test/renderer-events-figures.test.js` — they are the only two figures in
this doc another document quotes, so they are held by a test rather than by a
reader's goodwill. If that test fails, this sentence is what to update.

## The interception model (why Phase 2 forces no new seam work)

Every renderer-bound event reaches a window through **one seam that already
exists**: the `workspaceId → window` handle map that `SessionManager` owns
(`registerWindow` / `unregisterWindow`). Its handles are **opaque objects used
through exactly five methods** — `.webContents.send()`, `.isDestroyed()`,
`.isFocused()`, `.show()`, `.focus()` (session-manager.js header, "WINDOW BRIDGE
/ opaque-handle contract"). SessionManager never imports electron to reach them.

So a web host swaps BrowserWindows for **connection-backed handles implementing
those same five methods**, registers them in the same map, and passes the
Phase-1 WS-backed `handle`/`on` + opaque sender tokens. Every routed channel
then flows with **zero engine change**. Concretely, every channel below reaches
the renderer through one of four paths:

| Path | Mechanism | Web-host equivalent |
|---|---|---|
| **A. session-scoped** | `manager._sendToSession(name, ch, …)` — resolves the session's workspace window from the map (buffers `pty-data` when detached) | resolve name → the connection(s) on that workspace |
| **B. broadcast** | `manager._broadcast(ch, …)` — every live window in the map | every connection |
| **C. sender-token** | `e.sender.send(ch, …)` from inside an invoke/menu handler (the Phase-1 opaque token) | the connection that made the invoke |
| **D. desktop-shell-only** | native-menu / app-lifecycle `win.webContents.send(ch, …)` **outside** A–C | **not served** — the browser's menu is in-page DOM; designated, not routed |

`_sendToSession` and `_broadcast` are the two primary interception points; a web
host subscribes there. One in-engine session-scoped emit (`session-file-view`)
resolves a handle from the same map directly rather than via `_sendToSession`,
because it needs `.show()` + `.focus()` + `.send()` on one handle — still the
same map, still no new seam.

## A. Session-scoped channels (via `_sendToSession`)

Resolve the owning window from the session's workspace; a web host targets the
connection(s) attached to that workspace. `pty-data` is buffered into
`session.pendingOutput` (2MB cap) when no window is attached and replayed on
reattach — a web host needs the same replay-on-connect for a reloaded tab.

| Channel | Payload (positional args) | Emitter |
|---|---|---|
| `pty-data` | `name, data` (data = raw PTY chunk; base64 over WS) | session-manager (PTY onData) |
| `session-exit` | `name, exitCode` | session-manager (ptyProc.onExit) |
| `session-activity` | `name, state` (`working`/`idle`) | session-manager `_emitActivity` |
| `session-ctx` | `name, pct, tok, size, cost, modelName` | session-manager (ctx poll) |
| `session-proxy` | `name, payload` (status-bar telemetry snapshot; wire-overlay shape) | wirescope-proxy poller |
| `session-files` | `name, files` (fileTouches array) | session-manager |
| `session-file-view` | `name, filePath` — **direct handle** (`show`+`focus`+`send`), `[agent:file view]` | session-manager |
| `session-attention` | `name, attn` (needs-attention fact object, or null to clear) | session-manager `_setAttention` |
| `session-mention` | `name, mtype, from` (`dm`/…) | session-manager (dm/mention gate) |
| `session:context-action` | `msg` object `{action, name, …}` (`reattach`/`spawn` path) | session-manager |
| `session-peer-control` | `name, holder` (control-holder tag or null) | remote-wiring |

## B. Broadcast channels (via `_broadcast`)

Every live window; a web host fans to every connection.

| Channel | Payload | Emitter(s) |
|---|---|---|
| `ipc-message` | `msg` object, a union keyed by `.type` — `dm`/`notify`/`remind`/`exec`/`attention`/`file`/`spawn`/… — common fields `{type, from, to, body}`; some carry `{ts, kind}` | ~40 sites: session-manager (intent routing, DM fan-out, remind/exec/notify), remote-wiring (wire relay), wirescope-proxy |
| `pending-count` | `msg` object `{name, count}` (parked-DM badge) | session-manager |
| `peer-disabled` | `id, on, label` | ipc-handlers (`peer:setDisabled`) |
| `peer-state` | `id, status` (`{online, label, …}`) | peer-client `_emit` → peer-wiring `emit` |
| `peer-removed` | `id` | peer-client / peer-wiring |
| `peer-tunnel` | `id, status` | peer-wiring (TunnelManager onState) |
| `peer-activity` | `id, name, state` | peer-client |
| `peer-replay` | `id, name, info` | peer-client |
| `peer-data` | `id, name, data` (remote PTY bytes) | peer-client |
| `peer-resize` | `id, name, geom` (`{cols, rows}`) | peer-client |
| `peer-ui` | `id, name, evt` (`{kind, args}`) | peer-client |
| `peer-telemetry` | `id, name, tele` | peer-client |
| `peer-control` | `id, name, holder` | peer-client |
| `peer-exit` | `id, name, exitCode` | peer-client |

All `peer-*` (except `peer-disabled`/`peer-tunnel`) originate in
`peer-client.js` `this._emit(...)`; the PeerManager `emit` closure in
**peer-wiring.js** is the single funnel that routes them to `manager._broadcast`
(and fires the menu/ops-log side effects). That closure is the natural single
seam if a web host ever needs to intercept peer events before the fan-out — but
today it already ends in `_broadcast`, so no change is needed.

## C. Sender-token channels (Phase-1 opaque token)

Pushed from inside an invoke/menu handler via `e.sender.send(...)` — the same
opaque sender token Phase 1 established. A web host delivers to the connection
that made the call; no window map involved.

| Channel | Payload | Origin |
|---|---|---|
| `peer-deploy-line` | `sshHost, line` (streamed deploy progress) | ipc-handlers `peer:deploy` (`wc = e.sender`) |
| `session:context-action` | `msg` `{action, name}` (menu-click path — `rename`/`editArgs`/`restart`/`export`/`kill`/…) | ipc-handlers `session:context-menu` |
| `peer:context-action` | `msg` `{action, id, name}` | ipc-handlers `peer:context-menu` / `peer:header-menu` |

`session:context-action` has two producers — this menu-click path (sender token)
and the session-manager reattach/spawn path (§A). Both are legitimate; a web
host serves the menu path only if it renders these context menus server-side
(Phase 3 degrades native menus to in-page menus, so the menu-click path likely
becomes pure in-renderer and this channel is served only for the §A path).

## D. Desktop-shell-only channels (designated, NOT routed)

Emitted by native menus (app-menus.js `sendToFocused` / direct
`win.webContents.send`) or app lifecycle (main.js) — **outside** `_sendToSession`
/ `_broadcast`. These are a native-shell → renderer bridge. **The browser
frontend does not need them**: its menu bar is in-page DOM, so it opens the same
drawers/dialogs directly with no main→renderer round-trip. Designated
desktop-only per the "designate, don't force" ruling; a web host simply omits
them.

- **Menu → open a drawer/dialog** (app-menus.js): `request-open-new-dialog`,
  `request-open-preferences`, `request-open-peers-dialog`,
  `request-open-peer-session` (`id, name`), `request-open-agents-drawer`
  (`name`), `request-open-skills-drawer` (`name`), `request-open-exec-drawer`
  (`name`), `request-open-inbox-drawer`, `request-open-prompts-drawer`,
  `request-open-templates-drawer`, `request-open-ipc-log`,
  `request-rename-workspace`, `request-switch-session` (`name`).
- **`set-theme`** (`name`) — app-menus theme submenu (the browser sets its own
  theme in-page).
- **`zoom-nudge`** — Electron `zoomFactor` refit (app-menus + main.js
  `did-finish-load`); the browser uses native zoom, no nudge.
- **`update-available`** (`info`) — main.js desktop update banner; the container
  image has its own update story (out of scope, Phase 4).

## Bottom line

No seam work is forced by this phase. Categories A/B route through the two
existing engine interception points (which reach windows through the injected
opaque-handle map); C rides the Phase-1 sender token; D is intentionally
desktop-only. Phase 3's web host provides connection-backed handles for the
five-method contract plus WS-backed `handle`/`on` + sender tokens, and the whole
A/B/C surface flows unchanged. The one place to watch is `pty-data` replay: a
browser tab reconnecting must get the same `pendingOutput` replay a reattaching
Electron window gets.
