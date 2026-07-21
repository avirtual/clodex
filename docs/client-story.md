# The client story — `clodex` as kubectl for agent daemons

Status: DESIGN EXPLORATION (2026-07-21). Companion to
`docs/deployment-plan.md` (how a node gets born anywhere) and
`docs/engine-as-substrate.md` (the engine is the product; GUIs are lenses).
This doc is the other half of the same story: **how anyone — human or
program — talks to a node once it exists.** Not build-authorized.

## The parallel, taken seriously

Kubernetes is: an API server holding the state; `kubectl` as the universal
text client; dashboards as optional GUI clients; a kubeconfig file (contexts
= server URL + credential) telling every client where to point.

Clodex is already structurally this — not by analogy, by inspection:

| k8s | Clodex | Status |
|---|---|---|
| API server | the engine + `remote.js` wire | exists |
| GUI dashboards | Electron GUI, web GUI (`web-host.js`) | exist (two of them) |
| kubeconfig contexts | the `peers` array (`{url, token}` entries) | exists, GUI-internal |
| `kubectl` | — | **missing** |
| declarative workload specs | templates / session-args | exists, GUI-internal |

Of the three client classes, the text client is the *cheapest* to build —
it has no rendering problem. It is argument parsing over HTTP+SSE calls that
already exist and are already proven complete enough to drive a full GUI
(the web frontend runs on the same class of transport).

## Why this is the value unlock, not a convenience

The deployment plan makes daemons cheap to create. But a daemon you can
only control by clicking is a desktop app with extra steps. A daemon with a
CLI is **infrastructure**: scriptable from CI, cron, other tools, and —
crucially — from other agents.

Clodex's core differentiator (per engine-as-substrate.md) is the **living
session**: `claude -p` is spawn→answer→die; a Clodex-held session is a PTY
kept alive, addressable for its whole life, instructable and correctable
mid-flight, wakeable by events. The CLI is what makes that reachable from
anything that can run a command:

```
clodex ctx list                                   # known engines (contexts)
clodex --ctx prod sessions                        # what's running there
clodex spawn builder --cwd /work --type claude    # birth a living session
clodex send builder "fix the failing tests"       # instruct it
clodex send builder "stop, wrong branch" 	  # correct it mid-flight
clodex attach builder                             # watch / interact (SSE → terminal)
clodex logs builder --since 10m                   # transcript slice
clodex kill builder
```

Deploy-anywhere and the CLI are two halves of one story: *trivial to put a
node anywhere; trivial to talk to it from anywhere.*

## Design rules

1. **Wire-only, forever.** The CLI speaks exclusively to the `remote.js`
   HTTP+SSE surface. Never ipcMain, never local file access to the engine's
   stores, no "if local, cheat" path. This keeps the wire honest as the
   complete client contract (the gap-audit's verdict), and it means the CLI
   works identically against localhost, a LAN peer, a Fargate task, and a
   k8s pod — location-transparency is the whole point.
2. **The CLI is the demand signal for wire convergence.** The gap-audit
   (`docs/ipcmain-vs-wire-gap.md` §4) enumerates ~14 capability blocs the
   wire lacks (teams, SCM, library CRUD, archive/unarchive, …). We do NOT
   port them speculatively. Each CLI verb someone actually needs pulls its
   wire route into existence; coverage grows by demand. First candidates
   are already visible: `archive` (wire kill is hard-delete only —
   semantically wrong for a CLI that manages long-lived sessions) and
   session labels.
3. **Standalone binary-ish.** Plain Node, no Electron, no node-pty —
   installable via `npm i -g clodexctl` on boxes that have never seen the
   desktop app. (Packaging decision: Decisions §6.)
4. **Human-readable by default, `--json` everywhere.** Every read verb has
   a stable JSON mode so the CLI is simultaneously the human tool and the
   machine API binding. (This is kubectl's `-o json` lesson.)
5. **Exit codes are contract.** 0 ok / nonzero distinguishable failures —
   CI lives on this.

## Contexts — the kubeconfig

`~/.clodex/cli/contexts.json` (CLI-owned, not the GUI's peers array):

```json
{
  "current": "home",
  "contexts": {
    "home":  { "url": "http://127.0.0.1:7900", "token": "…" },
    "prod":  { "url": "https://node.example.com:7900", "token": "…" },
    "work":  { "ssh": "user@work-box", "remotePort": 7900, "token": "…" }
  }
}
```

### Transports — how bytes reach the wire

The protocol is always the same HTTP+SSE wire; what varies per context is
how a route to it is obtained. Three transport kinds, one mechanism:

1. **Direct** — `url` + `token`. Public IP, LAN peer, ingress, localhost.
2. **SSH tunnel** (Bogdan requirement, 2026-07-21) — `ssh` host instead of
   a URL. The CLI shells out to the system's **ssh client** (the plain
   `ssh` binary — no SSH library, no protocol implementation of our own;
   the user's existing `~/.ssh/config`, keys, and jump-host setup all
   apply) to open `ssh -N -L <ephemeral>:127.0.0.1:<remotePort>`, then
   speaks the wire through the tunnel. The supervision pattern already
   exists in-tree (`peer-tunnel.js`: free-port probe, capped backoff,
   `BatchMode=yes` key-auth).
3. **Tunnel command** (the cloud generalization) — SSH is one instance of
   a general shape: *every cloud has a blessed, identity-authenticated
   "give me a local port to a private thing" command*, and the CLI should
   consume the shape, not the clouds:

   ```json
   "k8s-prod": {
     "tunnel": ["kubectl", "port-forward", "-n", "agents",
                "pod/clodex-0", "{port}:7900"],
     "token": "…"
   },
   "fargate": {
     "tunnel": ["aws", "ssm", "start-session",
                "--target", "ecs:cluster_task_container",
                "--document-name", "AWS-StartPortForwardingSession",
                "--parameters", "portNumber=7900,localPortNumber={port}"],
     "token": "…"
   }
   ```

   The CLI substitutes a free local port for `{port}`, runs the command,
   waits for the port to accept, speaks the wire, and reaps the child on
   exit. This covers `kubectl port-forward` (RBAC-authed through the k8s
   API server), AWS SSM / ECS Exec port-forwarding (IAM-authed via the
   SSM agent — works on Fargate, where there is **no SSH daemon at all**),
   `gcloud compute start-iap-tunnel`, `cloudflared access tcp`, and
   whatever comes next — with **zero cloud SDKs in our code**. Auth to the
   cloud is the operator's own cloud CLI's problem, exactly where it
   belongs (this is kubectl's exec-credential-plugin lesson applied to
   transport). The `ssh` kind above is just a built-in template of this
   mechanism.

For one-shot verbs the tunnel opens and closes around the call; for
`attach`/`--follow` it lives as long as the stream.

**Support boundary** (contrarian finding 5 — the honest cost of
cloud-agnosticism): tunnel commands fail in cloud-specific ways (auth
prompts wanting a browser, stale sessions, divergent stderr, background
forks). Clodex's contract is strictly: substitute `{port}`, spawn the argv
**directly (no shell)**, wait bounded for the port to accept, and on
failure/teardown **kill the child's process group** and surface its
stderr verbatim in the error. Nothing more. Cloud-specific examples ship
as *tested recipes in docs*, never as "supported clouds" — when a tunnel
command misbehaves, the diagnosis surface is the cloud CLI's own output,
which we relay, not absorb. `clodexctl ctx test [--verbose]` exists to
exercise exactly this path (spawn tunnel → hello → report) so failures
are debugged deliberately rather than inside some other verb. **Beyond tunnels**,
the endgame for cloud fleets is the reverse-connection relay
(deployment-plan.md, announce v2): nodes connect *outbound* to a relay
the CLI also connects to — the Tailscale/cloudflared model — and no
inbound route or tunnel command is needed anywhere. Tunnel commands are
the v1 that makes cloud nodes reachable *today* with the operator's
existing credentials; the relay is the v2 that makes reachability
disappear as a concept.

- `clodex ctx add prod --url … --token …` / `ctx use` / `ctx list`.
- Env overrides for CI: `CLODEX_URL` / `CLODEX_TOKEN` beat the file;
  `--ctx` beats `current`.
- Relationship to the GUI's peers array: deliberately **separate** in v1.
  The peers array is one client's (the desktop's) context file; the CLI is
  another client and owns its own. Announce-v1 registration
  (deployment-plan.md) updates **only the controller's** peer store — a
  booting cloud node cannot write into CLI users' local contexts files,
  and pretending otherwise was a locality handwave (contrarian finding 4).
  The CLI-side bridge is explicit and pull-shaped:
  `clodexctl ctx import --from <context>` reads the controller's peer
  list over the wire and offers rows to add — with the rule that imported
  entries may carry `url`+`token` only, **never `tunnel` argv** (an
  executable command sourced from a remote store is a code-execution
  surface; tunnel contexts are always authored locally by the operator —
  contrarian finding 6). Needs a peers-read wire route when demand pulls.
  The LOCAL flavor ships first (T36b): plain `clodexctl ctx import` reads
  this machine's own userData — the engine's remotePort + remote.env token
  (context `local`), the peers array (ssh/url + per-peer token, by label),
  and each sandbox profile's wirePort + auth.env token — so an operator
  never hand-adds their own laptop. Read-only on GUI files; same
  never-tunnel-argv rule (an sshHost string is data — the CLI's fixed ssh
  template builds the argv; argv-shaped store fields are refused even from
  a local store).
  - Typed cloud transports (T36g: `ssm`/`kubectl`/`gcloud`/`az`) extend that
    same data-vs-code line. Each is a stored OBJECT of vendor-CLI parameters
    (target, region, namespace, …) that the CLI's fixed template turns into an
    argv — so like an `ssh` host string, it is DATA: importable, shareable,
    safe in a team contexts file. A raw `--tunnel` argv stays CODE (never
    imported/shared). The invariant is unchanged, only widened: the store holds
    parameters we template, never a command we execute verbatim from a foreign
    source.
- Single-node shortcut, kubectl-style: `clodex --url … --token …` with no
  context file at all. This softens the deployment plan's registration
  requirement — for one node you need no announce machinery whatsoever.

## Verb set v1 (each maps to an existing route)

| Verb | Wire route | Notes |
|---|---|---|
| `ctx add/use/list/rm` | — (local file) | |
| `info` | `GET /api/peer/hello` | identity + caps + version; doubles as connectivity test |
| `sessions` | `GET /api/sessions` | |
| `spawn <name>` | `POST /api/sessions` | flags mirror session-args (cwd, type, model…) |
| `kill <name>` | `POST /api/kill/:name` | wire semantics = hard delete; say so loudly |
| `restart <name>` | `POST /api/restart-session/:name` | |
| `send <name> <text>` | `POST /api/send` | fire-and-forget in v1 |
| `input <name>` | `POST /api/input/:name` (+ control acquire) | raw keystrokes; `attach` usually better |
| `attach <name>` | `GET /api/attach/:name` SSE + input/control/resize | the interactive verb: raw-mode terminal, replay frame, resize passthrough, detach key |
| `logs <name>` | `GET /api/transcript/:name` | `--since/--tail`; `--follow` via attach's output frames |
| `args get/set <name>` | `GET/POST /api/session-args/:name` | |
| `skills <name>` | `/api/skill-catalog`, `/api/session-skills` | |
| `query <name> <kind>` | `POST /api/query/:name` | ctx/report/bust/files — the telemetry reads |
| `restart-app` | `POST /api/restart` | whole-engine relaunch (exit-64 path) |

Everything above exists on the wire today; v1 is pure client work, zero
engine changes. (`attach` is the only nontrivial one — SSE stream + raw
tty + control acquisition; the web GUI already proves the protocol does it.)

## The one engine change v1 pulls on: command→result

`send` is fire-and-forget; interactively that's fine (a human follows with
`attach`). For scripting it's the missing half — engine-as-substrate.md
Gap 1, now load-bearing:

```
clodex send builder "run the suite, report failures" --wait --timeout 30m
```

Async-with-completion, minimal shape:

- `POST /api/task/:name {text}` → returns `{taskId}` immediately (own
  surface, not bolted onto `/api/send` — Decisions §2, §8).
- Terminal-state signal: the engine already scans transcripts for intents
  (jsonl-watcher); a completion convention — the agent emits a done marker,
  or the engine detects turn-idle — flips the task record to
  `{state: done|failed, summary}`. (The AB3 harness's DONE-taskN marker was
  a hand-rolled version of exactly this.) The agent-side vocabulary is
  shared with the team-ticket `done` signal; the stores stay separate —
  see Decisions §8.
- `GET /api/task/:id` poll + an SSE `task` frame on `/api/events`;
  `--wait` = subscribe-or-poll until terminal, exit code mirrors state.

This is the only protocol design of substance in the client story. It is
deliberately *last* in v1 — every other verb ships without it.

## What this deliberately is not

- **Not a REPL/shell** — plain argv verbs; composition belongs to the
  user's shell and scripts.
- **Not an SDK** (yet) — `--json` output IS the machine binding; a
  library wrapper can be extracted later if something pulls.
- **Not a config-management tool** — templates/library CRUD stay GUI-side
  until demand pulls them onto the wire (rule 2).
- **Not an auth system** — bearer token per context, exactly the wire's
  existing model. Multi-user RBAC is out of scope until "others run
  controllers" is real (deployment-plan.md open question 4).

## Build order (when authorized)

1. Skeleton + contexts + read verbs (`info`, `sessions`, `logs`, `query`) —
   a useful monitoring tool in a day-scale effort, zero engine changes.
2. Write verbs (`spawn`, `send`, `kill`, `restart`, `args`).
3. `attach` (SSE + raw tty + control).
4. Command→result (`--wait`) — the one engine-side design, unified with
   the ticket protocol's completion semantics.
5. Demand-driven wire gaps as they surface (`archive` first, likely).

## Decisions taken (Bogdan, 2026-07-21)

1. **Name**: `clodexctl` (settled — see §7). Not bare `clodex`, which
   stays the product name.
2. **Command→result gets its own surface** (`/api/task`-shaped, not bolted
   onto `/api/send`): Bogdan's hunch is that the engine story may grow
   *larger* than the visual Clodex — so the automation surface deserves
   full, first-class design room rather than riding an existing route.
   Whether its completion semantics unify with the team-ticket `done`
   machinery remains a design question inside that surface.
3. **SSH transport is in scope for the client** (see Contexts above) — the
   CLI must reach engines that are only ssh-accessible.
4. **The phone rig stays as-is** — it is the operator's convenience path to
   THIS desktop Clodex (the `remote.js` viewer through the hand-built
   ingress; note the phone IS served by remote.js — what the laptop
   doesn't run is the `web-host.js` lens). Long-term it is likely replaced
   by serving the web GUI remotely, and perhaps eventually by a real
   mobile lens; no work on it now, and the CLI does not need to subsume it.
5. **Attach is full read-write in its first release** — "think kubectl":
   the CLI is a first-class control client, not a viewer. Control
   acquisition + input + resize ship in the first attach. Roles/permissions
   (a read-only *role*, per-verb authz) are a later, real feature on the
   auth surface — not a scope cut disguised as one. Milestone naming, to
   kill a "v1" ambiguity contrarian caught: **T36 = clodexctl core**
   (contexts, transports, read+write verbs — no attach, no `--wait`);
   **T37 = attach**; **T38 = `/api/task` + `--wait`**. "v1" in this doc
   means the T36+T37+T38 arc, not the first task.
   Amendment (T36c, operator demand): the turn-idle flavor of `--wait`
   ships early — it rides the events feed's `turnEnd` activity frame (the
   once-per-turn signal the web GUI already trusts) and prints the
   transcript delta. Documented honestly as "the agent went idle", never
   "declared done". T38's formal task contract arrives on top; `--wait`
   remains the weak/simple mode beside task ids. T36c also adds `exec`
   (one-shot PTY command with collected screen output — kubectl-exec for
   nodes whose only shell is a bash session) and fixes `input` to send
   Enter by default.
6. **Packaging** (lead's call, delegated): **source lives in this repo
   under `cli/`, published as its own npm package** (`clodexctl`, own
   minimal package.json, zero-to-minimal deps, plain Node ≥20). The main
   repo's package can never be the install vehicle — it drags Electron and
   node-pty, absurd for a thin HTTP client on a CI box. In-repo source
   keeps the CLI on the same release train (release.sh bumps both) and
   next to the wire contract it binds to; own-package publish makes
   `npm i -g clodexctl` work on a bare box in seconds. If the engine story
   outgrows the desktop app (Bogdan's stated hunch), the directory can be
   promoted to its own repo later without breaking installs — the package
   name is the stable interface.

7. **Name: `clodexctl`** (Bogdan, 2026-07-21) — a bit long, but you're
   not wondering what it means.
8. **Command→result: parallel track, shared completion vocabulary**
   (lead's call, delegated). `/api/task` is a session-scoped, RPC-shaped
   record — `POST /api/task/:name {text}` → `{taskId}`; terminal state +
   summary readable via `GET /api/task/:id` and an SSE `task` frame. It
   does NOT reuse the team-ticket store: tickets are team-workflow objects
   (ownership, reassignment, watchdog, lead/assignee direction rules) and
   welding the two would drag team semantics into a surface a bare
   teamless cloud node must serve. What IS unified is the **agent-side
   completion signal**: one intent vocabulary for "this work reached a
   terminal state", consumed by whichever tracker cares (ticket store on a
   team seat, task record on a wire task) — one convention for agents to
   learn, two independent consumers. Fallback for agents that never
   signal: turn-idle detection (weaker, marked `assumed-done`), plus the
   caller's `--timeout`. **Gate on T38** (contrarian finding 8, taken):
   before either consumer ships against the shared vocabulary, the
   completion event gets one formal definition — id it binds to, state
   enum, summary field, who may emit, duplicate/idempotency handling,
   assumed-done semantics — so the two stores cannot interpret the same
   agent utterance differently. That definition is the first section of
   T38's spec, not an afterthought.

## Open questions (remaining)

None blocking. Everything below the build line is decided; remaining
choices (exact `/api/task` field shapes, intent spelling of the completion
signal) are implementation-time detail inside their own design.
