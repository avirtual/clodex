# Peering

One Clodex (the **consumer**) attaches to sessions on another Clodex (the
**owner** / "box") over loopback HTTP+SSE carried through an SSH tunnel or
tailnet. The same server also serves the phone web UI. Companion to
[architecture.md](architecture.md); DM federation semantics live in
[messaging.md](messaging.md) §4.

Reading guide for a change: **owner endpoints** → remote.js + the callbacks
built in remote-wiring.js · **consumer protocol** → peer-client.js ·
**tunnels** → peer-tunnel.js · **settings reconciliation** → peer-wiring.js ·
**all UI** → renderer/peers-ui.js · **deploy** → peer-deploy.js + ssh-run.js.

## 1. Trust model (SETTLED)

- The server binds **127.0.0.1 only**; the tunnel/tailnet IS the auth
  boundary. v1 has no auth surface — tightening later means a shared secret
  on the whole peer surface, not per-endpoint gates.
- **Only input and resize are token-gated** (single-holder control token) —
  that stops a read-only viewer typing by accident, not an attacker.
  Control *acquisition* is un-gated, last-wins ("both laptops are the same
  operator"); a token gate on restart/create would be theater since acquire
  itself is open.
- Identity comes from response content (`app:'clodex'` + host in hello),
  never from the port.

## 2. Owner side (remote.js `RemoteServer`)

Plain Node http+SSE, zero deps. Clodex behavior is injected as callbacks
(built in remote-wiring.js `syncRemoteServer`); an absent callback 501s its
endpoint and drops the matching capability from hello. The transcript on
disk is the source of truth — SSE signals "changed", clients refetch.

Endpoints: phone page (`/`), `GET /api/sessions|transcript/:name|events`
(global SSE), `GET /api/peer/hello` (identity + caps + `dmOrigins` +
`srcDir`), `GET /api/attach/:name` (per-session SSE: b64 scrollback replay
+ telemetry seed), `POST /api/control|input|resize/:name` (input+resize
token-gated; resize clamped), `POST /api/query/:name` (pull-on-demand
popover data; kind whitelist lives in the injected callback),
`POST /api/send` (operator message), `POST /api/restart` (app relaunch —
response written before the restart fires), `POST /api/sessions`,
`/api/kill/:name`, `/api/restart-session/:name` (remote create/kill/restart
— all under the `create` cap, shipped together),
`GET /api/session-args/:name` + `POST /api/session-args/:name` (Edit Session
over the wire: read editable args + the box's dialog catalogs, apply an edited
patch with kill+respawn on `restart:true`) and `GET /api/skill-catalog/:name` +
`POST /api/session-skills/:name` (Edit Skills over the wire: read the box's skill
catalog, persist the disabled/inject sets — a separate `/api/restart-session`
applies) — all four under the `args` cap, shipped together — and `POST /api/dm` +
`/api/dm/claim` (federation, `dm` cap).

Fan-out from the session manager (cheap no-ops when unattached):
`pushOutput` (4MB backpressure → destroy the stream — a half-open tunnel
renders stale-as-live), `pushTelemetry` (partial `{proxy}`/`{ctx}`/`{files}`
frames, client merges), `pushUiEvent` (small `{kind,args}` trigger, never
content — the viewer pulls via query; `file open` is never mirrored),
`notifyResize` (80ms trailing debounce + dedup), `notifyExit`,
`notifyActivity`/`notifySessions`/`notifyDmMail`.

Notable callback semantics (remote-wiring.js): `createSession` routes the
live `manager.create()` (persists like `[agent:spawn]`); `restartSession`
routes the shared main.js helper; `deliverDm` runs the same `_gatedDeliver`
cost-gate as local mail; `resizePty` tags `manager.resize(..,'peer-control')`
so the ops log can arbitrate perturbation reports; `onControlChange` chips
the owner's tab — control is never silent. Bash sessions are IPC-private
but **peer-visible** (attach/control/create work; DM and query don't).

## 3. Consumer side (peer-client.js)

**Unreachable is normal** (laptops sleep) — offline is calm, never an error.

`PeerConnection`: hello loop every 15s (`HELLO_INTERVAL_MS`). On wake:
refresh sessions, open the events feed, re-establish wanted attachments.
`identityChanged` (version/platform/srcDir/caps compare) forces a
`peer-state` emit even without an offline dip — an in-place update restarts
the box faster than the 15s cadence can observe, and the renderer would
otherwise keep a stale version forever. DM claims ride every hello tick
plus the `dm-mail` doorbell.

**Split HTTP agent pools are load-bearing** (SETTLED, fixed a live bug):
short requests use a keepAlive pool (8 sockets); SSE streams use an
un-pooled agent. One shared pool let a few attaches pin every socket and
starve control/input — dropped keystrokes and minutes-late stale acquires.

Attach streams reconnect with 1s→20s doubling backoff; **replay is
best-effort scrollback, not terminal state** — clients reset before
applying and re-replay (never resume) on reconnect.

`PeerManager.sync` reconciles from settings: URL or label change =
stop+restart that connection; removal emits `peer-removed`. **`peer-removed`
fires even on URL/label edits** (attachments died with the old connection —
the UI must shed its tabs; the new connection re-announces).

`TunnelManager` (peer-tunnel.js) supervises `ssh -N -L` per ssh-configured
peer; while a tunnel is down the peer keeps a dead-placeholder URL
(`http://127.0.0.1:1`) so the connection object and sidebar presence stay
alive-but-offline.

## 4. Settings reconciliation (peer-wiring.js)

`syncPeerManager` lazily constructs both managers, then reconciles from
`uiSettings.peers`. **Disabled peers are excluded from both syncs** —
paused, not removed: tunnel and connection tear down (hello stops), but the
record and its persisted attachments/claims stay for re-enable. The prune
loop drops persisted `peerAttached`/`peerVisible`/`peerControlled` only for
ids that left settings entirely. Online/offline is logged on transitions
only (peer-state fires in bursts).

Persisted map writers: `peerAttached` on attach, forgotten on explicit
detach — **peer-exit and the disable soft-shed deliberately don't forget**,
so attachments survive a box restart or a pause. `peerControlled` on
successful acquire only (a failed take never persists), forgotten on
release/detach/stale-claim drop. `peerVisible` via the eye popover's Apply.

## 5. Control model

Single-holder server-minted token, last-wins. Two acquisition paths:
explicit Take (bar/menu) and **type-to-take** (peer-input-queue.js
`PendingInput`: first keystroke kicks an async acquire; keystrokes during
it buffer whole-chunk, 4KB cap, keep-or-drop — a spliced keystroke stream
is worse than a bounded-intact one). Auto-release when the last attacher
leaves or the PTY exits. **Resize authority rides control**: the
controlling viewer pushes geometry on explicit fit; the owner echoes an
idempotent resize-in-place (no feedback loop); read-only viewers letterbox
at owner geometry. Every reattach replay resets to read-only; a persisted
control claim re-takes on `onPeerReplay` (covers app AND box restarts);
losing to another holder sheds the stale claim without a retry loop.

## 6. Renderer (renderer/peers-ui.js)

Self-contained island; peer terminals live in the core sessions Map keyed
`name@peerId` (`@` can't occur in local names). Highlights:

- Header per peer: online dot, state text, version-severity name tint
  (only when the peer is behind us), icon strip — ＋ new session (create
  cap), ↻ restart Clodex, ◎ visibility popover (works offline), ⓘ identity
  popover (version/platform/caps/age + Update + Disable).
- **Restore sweep**: `peerRestorePending` is one-shot per name — seeded at
  startup from persisted `peerAttached` (and re-seeded on re-enable),
  consumed as sessions arrive, expired names forgotten after a settle
  delay. Per-name consume prevents an attached-then-closed tab from
  resurrecting on a connection blip.
- **Visibility**: no map entry = show all; attached-always-wins at render,
  except the eye popover's Apply explicitly detaches excluded open tabs.
  X / Cmd+W on a peer tab = detach + hide from list.
- **Disable/pause**: the initiator marks `disabledPeers` before invoking
  `peer:setDisabled`; main broadcasts `peer-disabled` before re-running the
  syncs, so every window discriminates the resulting `peer-removed` as a
  soft shed (`removeSession(key, {keepPersisted:true})` — no durable
  detach). Re-enable re-seeds the restore sweep from durable truth.
- **`PEER_UI_KINDS`** mirroring: owner-initiated UI events (`fileView`
  today) render immediately only when that peer tab is active; otherwise a
  click-to-open toast — the intrusiveness gate that stops a remote agent
  slamming a modal over your work.
- Six back-exports to core: `typeToTakeControl`, `renderPeerBar`,
  `forgetControlMirror`, `openPeerSession`, `peerDisplayHost`,
  `peerHideFromList`.

## 7. Deploy wizard (peer-deploy.js + ssh-run.js)

`sshRun`: one-shot `ssh … bash -s`, key-auth only (BatchMode), TOFU host
keys, exit 255 = ssh-layer failure. `probePeer` classifies a host without a
tunnel (ssh-fail / no-listener / not-clodex / hello-ok). `clodex-deploy.sh`
is an idempotent one-shot — **re-running it IS the update path** (apt deps
checked including t64 aliases, clone-or-reset, build, systemd --user unit,
verify-by-hello). It never prompts for sudo: exit 42 + the exact commands
to run. `resolveDeployFolder` is the one precedence rule: live
self-reported `srcDir` (hello) > persisted guess > script default — a
stale persisted folder must never shadow live truth. Failed deploys can
spin up an ad-hoc local fix agent briefed with the log.

## 8. Headless nodes (peering/)

Stock Clodex under Xvfb as a systemd `--user` unit (`Restart=always`,
`TimeoutStopSec=15` to release the single-instance lock). The seed script
handles bulk session add/remove via service restart; day-to-day
create/kill/restart now ride the `create` cap over the wire.

## Invariants (do not break)

- 127.0.0.1 bind + tunnel-is-auth; only input/resize token-gated.
- Replay = best-effort scrollback; reset before apply; re-replay on
  reconnect.
- Split request/SSE socket pools (regression test pins this).
- `peer-removed` fires on URL/label edits too — consumers must shed tabs.
- Disabled ≠ removed: syncs exclude, prune keeps, sheds are soft.
- Restore sweep is one-shot per name.
- Control auto-releases on last-detach; re-take rides replay, not a loop.
- `resolveDeployFolder` precedence: live srcDir > persisted > default.
- The wire is one-directional; box→consumer traffic is outbox+claim only.
