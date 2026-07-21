# Clodex as a control plane — headless nodes as command-addressable agent runtimes

Status: FRAMING (Bogdan, 2026-07-21). Not a build spec — a captured direction.
The substrate is proven; two design questions gate a build. Author: clodex.

## The idea

Reframe Clodex from "a desktop app that wraps local CLI agents, with optional
peering to other Clodexes" to **a control plane over a fleet of headless agent
runtimes you launch elsewhere and command remotely.**

Bogdan's framing (2026-07-21, verbatim shape): *"headless clodex is just a
smart wrapper around sessions and we can invent a method to send commands (we
can already send messages to agents inside clodex, from outside). And
occasionally we can peer to look at them (or we don't even have to, if they
export web access), but the important part is the agents can be there, waiting
for commands."*

The key inversion vs. today's peering: **command-in is the primary axis;
observability (peer-attach / web) is an optional, swappable accessory.** That
collapses the hard part of the earlier "automate peer deployment" framing —
you don't need the full bidirectional tunnel-and-attach machinery as the core.
You need a durable runtime, a command ingress, and a command→result contract.

This is explicitly NOT what Clodex was built for. It is a way to *use* what
Clodex already is (agent lifecycle + inter-agent message transport) as a
generic "agents somewhere, addressable by command" substrate.

## Ground truth — what already exists (verified 2026-07-21, Explore sweep)

Three-layer model. Two of the three layers are already built and proven.

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

### Layer 3 — observability (EXISTS, and is OPTIONAL by design)
- Peer-attach (`peer-client.js` / `peer-tunnel.js` / SSE in `remote.js`) OR
  web export (`CLODEX_WEB_PORT` → `web-host.js`). Interchangeable. Bogdan's
  insight: this is a swappable accessory, not load-bearing. The runtime is the
  product; how you *watch* it is incidental.

## The genuinely-unsolved piece: the command→result contract

"Agents there, waiting for commands" is done. "Commander sends a command and
later gets the *result*" is NOT cleanly designed:

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

Recommendation lean: **async-with-completion** is the contract worth designing;
everything else is wiring that exists. This is the one piece that is a genuine
design task, not an extraction.

## The other open question: per-node auth + registration

Off-loopback, `CLODEX_REMOTE_TOKEN` becomes load-bearing. For *others* (not
just the original operator), one shared secret is insufficient — you need
**per-node tokens minted at launch**. Two registration models:

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
fail-closed off-loopback) this direction depends on. This doc adds only the
*minting/registration* layer on top of that.

## What this is and isn't (feasibility)

- Substrate: ~90% built (Layers 1+2+3 all exist and are proven).
- Missing 10%, both genuine design (not extraction):
  1. command→result contract (async-with-completion).
  2. per-node token minting + a registration model (orchestrate for v1).
- Prerequisite already in flight: `docs/remote-auth-plan.md` (the token gate).
- Unsolved operational detail from the container map: agent OAuth
  (`claude`/`codex` creds) can't be baked — must be established inside the
  running node (Keychain doesn't transfer). Per-node credential seeding is its
  own sub-problem for any "others run this" story.

## Suggested first deliverable (when this goes from FRAMING to BUILD)

A demoable "launch → agent appears → command it → get a result" loop without
touching the peering protocol:

1. Standalone published container image (decouple `docker/web/Dockerfile` from
   compose).
2. A launch script: start the node, mint a per-node token, emit `{url, token}`.
3. A scripted `peer:add-by-url` path (the direct-URL peer already exists per
   `docker/web/README.md`; this scripts it instead of GUI-clicking).
4. A prototype of the command→result contract (async id + done-signal poll),
   validated against one headless node before any protocol change.

Explicitly deferred to a later pass: the announce/rendezvous registry, public
multi-tenant auth hardening, credential-seeding automation.

## Status / next

FRAMING captured so it survives compaction and can be reacted to cold by
Bogdan / wirescope. NOT a build authorization. The two design questions
(command→result contract; per-node minting + registration) are the decision
points; resolve those and the build is small because the substrate is done.
