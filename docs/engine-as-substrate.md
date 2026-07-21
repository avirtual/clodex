# The Clodex engine is the product; GUIs are lenses onto it

Status: FRAMING (Bogdan, 2026-07-21). Not a build spec — a description of what
Clodex already became, and the one residual question it raises. Author: clodex.

## What Clodex actually is

At its core Clodex is an **engine** that wraps multiple CLIs, makes them
interactive, and makes them *reactive* in an event-driven way — passing events
to the CLIs it wraps and letting agents communicate and react. It does a
million other things, but that is the load-bearing core: CLI lifecycle +
event-driven communication.

Everything else is a *client* of that engine. This is not a proposed reframe —
it is what the codebase already demonstrates, arrived at organically:

- peering → peering to a **headless** Clodex → stripping the default Electron →
  the engine (`engine.js`) cleanly separated from the GUI, provable by
  `headless-main.js` running the full engine with zero Electron.
- **Two GUIs already exist** — Electron (`main.js` + renderer, via ipcMain) and
  web (`web-host.js`, via the `remote.js` HTTP+SSE wire). They connect to the
  same engine. You cannot have two clients of a thing unless the thing is a
  server. The second GUI is the existence proof that the engine-as-substrate
  model is already true, not aspirational.

So: on a Mac there is **one Clodex engine running**; Electron is not "the app,"
it is a local viewer + configuration surface attached to that engine. It
happens to be co-located and privileged (ipcMain, a fast local transport)
rather than remote (the wire) — but that is an implementation optimization, not
an architectural boundary. The web GUI, which is a browser and *cannot* use
ipcMain, proves the wire alone is a complete-enough contract to drive a full
GUI.

### The engine's surface is larger than any GUI's

A GUI is a lens onto a **subset** of the engine's capability, never a mirror of
all of it. The surface has two kinds of capability:

- **Surfaced** — inherently visual, a GUI is a lens onto them: attach to a
  session, see output, capture the screen, type a command, configure.
- **Back-channel** — inherently background, some GUI-visible and many not, some
  that never should be: agent-to-agent messaging, event reactions, scheduled/
  triggered behaviour, intent-scanning out of transcripts, peer relays, skills.
  Several already exist and run headless today.

This makes "is a GUI complete?" a non-question — GUIs are *supposed* to be
partial projections. The real design object is **the engine's protocol
surface**, of which every GUI is a partial lens and every back-channel is a
first-class citizen. The server can grow back-channels and protocols for
background behaviour independent of whether any window ever shows them.

### The one primitive under it all

Reduced to essence, a client does two things to a session, and a session is
addressable regardless of where its engine runs (local, peer laptop, remote
box, sandbox, docker):

- **read** it — capture screen / transcript / output.
- **write** it — type / control / send input.

"Send a command to a peer" is just those verbs over the wire instead of over
ipcMain. The peering wire (`/api/attach`, `/api/transcript`, `/api/input`,
`/api/control`) is already the act-on-session protocol; it simply hasn't been
*named* as the universal session-access contract yet.

### The residual question (a gap-audit, not a design decision)

The two client classes — co-located/privileged (ipcMain, ~165 `window.api`
endpoints) and remote (the `remote.js` wire) — raise exactly one open question,
and the second GUI has already half-answered it: **is the wire expressive
enough to be the sole path**, making the Electron ipcMain route just a
local-transport optimization of the same contract? Or does ipcMain still hold
capabilities the wire cannot express? The web GUI proves the wire is a real,
complete-enough client contract; what's unknown is the *gap* between the two
surfaces. That is a mechanical audit (map ipcMain's endpoints against the
wire's expressiveness), not an architectural fork — worth running cheaply
before any convergence work, and worth doing only if unifying the two
transports into one contract is a goal.

## Ground truth — the substrate that makes this already-true (verified 2026-07-21, Explore sweep)

The layers below are facts about the current tree, not a build plan. They are
what lets the engine be a locatable, multi-client server today.

### Layer 1 — durable agent runtime (EXISTS)
- `headless-main.js` — plain-Node entry point, **zero Electron** (verified: no
  `require('electron')` in `engine.js`). No BrowserWindow/tray/menus. Restores
  sessions per `CLODEX_WORKSPACES`, SIGTERM/SIGINT clean shutdown, pidfile
  single-instance lock, exit-code 64 for supervisor-driven restart. This IS
  "the agents can be there, waiting."
- `docker/web/Dockerfile` — `node:22-slim`, rebuilds `node-pty` against Node's
  ABI (not Electron's — the critical distinction), installs `claude`/`codex`
  CLIs, non-root user, `CMD ["node", "headless-main.js"]`. No Electron/Xvfb/
  systemd/SSH. Already the container shape a Fargate/ECS task would run.

### Layer 2 — command ingress (EXISTS, at two layers)
- **Local (process-to-process):** external processes write the
  `~/.clodex/messages/` drop + agent socket — the `[agent:dm]` transport,
  already used agent-to-agent.
- **Remote (HTTP):** `remote.js` `RemoteServer` already exposes the command
  surface: `/api/send`, `/api/dm`, `/api/query/:name`, `/api/input/:name`,
  `/api/control/:name`, plus session create/kill/restart. Token-gate-able,
  widen-able off loopback via `CLODEX_REMOTE_HOST=0.0.0.0` +
  `CLODEX_REMOTE_TOKEN`. "Invent a method to send commands" is largely
  "designate the method that already exists as the product surface."

### Layer 3 — the lenses (EXIST, and are partial by design)
- Peer-attach (`peer-client.js` / `peer-tunnel.js` / SSE in `remote.js`) OR
  web export (`CLODEX_WEB_PORT` → `web-host.js`) OR the Electron GUI. Each is a
  lens onto the engine's surfaced capability; none sees the whole. Which lens
  you use is a client choice, not an engine property. The engine is the thing
  that makes everything move; how you watch it is incidental and swappable.

## Where the protocol surface is still thin (not gates — just honest gaps)

The engine-as-server model is already true; these are places the protocol
surface is *incomplete*, worth naming so they can be filled if a use case ever
pulls on them. Neither is a precondition for the model being real today.

### Gap 1 — the command→result contract

Reading and writing a session exist. "Write a command and later get its
*result* back over the wire" is NOT cleanly designed:

- `/api/send` and `/api/dm` are **fire-and-forget** — the message goes in, but
  the agent's answer today comes back only by *watching* (transcript poll or
  SSE attach). Fine when a human is looking at a dashboard; awkward for an
  automated caller that wants "run this, tell me when done, here's the result."
- `/api/query/:name` is the closest request→response-shaped primitive — TODO:
  confirm whether it blocks for a result or merely injects. (Not yet verified;
  do not assume.)

The design fork:

1. **Synchronous** — caller waits, command returns its result inline. Simple
   to consume; bad for long-running agent work (HTTP timeouts, head-of-line).
2. **Async with completion signal** — command returns an id immediately; the
   agent fires a completion (webhook / poll-able status / done-marker) when it
   reaches a terminal state. More powerful, matches how real agent work runs.
   NOTE: the `DONE-taskN` marker pattern used in the AB3 harness is already a
   hand-rolled version of exactly this — a filesystem completion signal a
   watcher polls. That pattern generalizes into the contract.

Recommendation lean: **async-with-completion** is the contract worth designing
if an automated (non-watching) client ever needs results; everything else is
wiring that exists.

### Gap 2 — per-client / per-node auth when the wire leaves loopback

Off-loopback, `CLODEX_REMOTE_TOKEN` becomes load-bearing. If engines are ever
run *by others* (not just the original operator), one shared secret is
insufficient — you need **per-node tokens minted at launch**. Two registration
models, if that ever matters:

1. **Orchestrate (dashboard-initiated):** the control plane launches the node
   (cloud API), learns its address, mints/holds its token, auto-adds it as a
   direct-URL peer. Simpler trust story (you trust what you launched); reuses
   the existing direct-URL peer path. **Recommended for v1.**
2. **Announce (node-initiated):** the node self-registers into a rendezvous
   registry (S3/DynamoDB/small endpoint) on boot; the dashboard polls and
   auto-adds. More scalable/decoupled; bigger security surface (any box can
   claim to be a peer). Defer to v2.

The auth *mechanism* itself is NOT new work — `docs/remote-auth-plan.md`
already specifies the token gate (`auth-token.js`, `timingSafeEqual`,
fail-closed off-loopback). Any registration/minting layer sits on top of that.
Operational detail from the container map: agent OAuth (`claude`/`codex` creds)
can't be baked — must be established inside the running node (Keychain doesn't
transfer). Per-node credential seeding is its own sub-problem for any "others
run this" story.

## What this doc is

A true description of the architecture Clodex organically became: **the engine
is the product; it already serves N clients (Electron, web, peers, agents-via-
messages); a session anywhere is one addressable object; every GUI is a partial
lens; back-channels are first-class.** Not a build authorization and not a new
direction — a name for what exists.

The two thin spots in the protocol surface (command→result; per-client auth
off-loopback) are honest gaps, fillable when a use case pulls on them, not
preconditions for the model being real. The one worth answering cheaply *if*
transport unification is ever a goal is the ipcMain-vs-wire gap-audit — a
mechanical mapping, not an architectural decision, and half-answered already by
the web GUI proving the wire is a complete client contract.

Captured so it survives compaction and can be reacted to cold by Bogdan /
wirescope.
