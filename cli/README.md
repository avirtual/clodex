# clodexctl

A text client — kubectl-for-Clodex — for the Clodex engine's `remote.js`
HTTP+SSE wire. Wire-only, forever: it never touches ipcMain or the engine's
local stores, so it works identically against localhost, a LAN peer, a Fargate
task, or a k8s pod. Plain Node ≥20, zero runtime dependencies (built-in
`fetch` + `node:*`).

Contexts, transports, the read/write verbs, `run` (command→result), `attach`
(a live terminal on any session), and `logs -f` (follow) are all here — the
whole client.

## A live terminal on a container in Fargate, from your laptop

Three commands take you from "a task is running somewhere in a customer's VPC"
to a real keyboard on the agent inside it — no ssh, no inbound ports, no VPN:

```sh
clodexctl ctx add cust --ssm-ecs my-cluster/clodex --token <wire-token>
clodexctl --ctx cust spawn worker --type claude --cwd /home/clodex/work
clodexctl --ctx cust attach worker
```

`attach` is ssh-for-agents: it streams the session's screen (best-effort
scrollback replay, then live output) and forwards your keystrokes, over
whatever transport the context uses (SSM, kubectl, IAP, Bastion, ssh, or a
direct URL). **Ctrl-\\** detaches. Type `run` to ask and wait; type `attach`
to *be there* — watch a build scroll, answer a permission dialog, drive a bash
shell. It reconnects itself if the tunnel hiccups (full re-replay on
reconnect). Caveats: the replay is best-effort recent scrollback, **not** exact
terminal state; `Ctrl-\` can't be typed through to the remote (it's the detach
escape); use `--read-only` to mirror without taking control (shoulder-surfing).

## Install

This is just a thin HTTP client with **zero dependencies** — there is nothing
to build, so running the file straight from a checkout is a first-class path,
not a fallback. Pick whichever fits your box:

1. **Zero-install (run it in place).** Works as-is from any checkout:

   ```
   node cli/bin/clodexctl.js sessions
   # optional one-line alias:
   alias clodexctl='node /path/to/clodex/cli/bin/clodexctl.js'
   ```

2. **User-prefix install (no root needed).** Lands the `clodexctl` bin under a
   prefix you own — good when the global npm prefix isn't writable:

   ```
   npm i -g --prefix ~/.local ./cli    # bin → ~/.local/bin/clodexctl
   # ensure it's on PATH:  export PATH="$HOME/.local/bin:$PATH"
   ```

3. **Global install** — *if your global prefix is writable*:

   ```
   npm i -g ./cli
   ```

The desktop app's packaged DMG does **not** include `cli/` — it is a
standalone package, installable on a box that has never seen Clodex.

## Contexts (the kubeconfig)

Stored in `~/.clodex/cli/contexts.json`, created `0600` (it holds tokens; a
loose mode warns on read). Every transport rides one mechanism — a `{port}`
tunnel spawned argv-direct — whether it's `ssh`, a typed cloud kind, or a raw
`--tunnel`:

```
clodexctl ctx add home --url http://127.0.0.1:7900 --token <T>
clodexctl ctx add work --ssh user@box --token <T>              # remotePort default 7900
clodexctl ctx add k8s  --token <T> --tunnel kubectl port-forward pod/clodex-0 {port}:7900
clodexctl ctx use home
clodexctl ctx list        # * marks the current
clodexctl ctx show home   # token redacted
clodexctl ctx import      # seed contexts from THIS machine's Clodex GUI stores
clodexctl ctx test        # open the transport + GET hello; relays child stderr verbatim
```

### `ctx import` — seed from the local GUI

"I shouldn't have to add my own laptop from my laptop." The desktop app already
knows every connection; `ctx import` reads its userData **read-only** and offers
context entries:

- the local engine itself → `local` (`http://127.0.0.1:<remotePort>` + the
  `remote.env` token; warns if the wire is off in Preferences),
- each peer in the GUI's peers list → an `ssh`/`url` context by label
  (disabled peers reported as skipped; a tokenless peer imports fine),
- each managed sandbox box → a `url` context to its wire port + the box's
  `auth.env` token (a box with no wire token is skipped with a reason).

```
clodexctl ctx import [--data-dir DIR] [--dry-run] [--force]
```

`--data-dir` overrides userData discovery (else `CLODEX_DATA_DIR`, else the
platform default for `Clodex`/`clodex`). Collisions **skip** unless `--force`;
`current` is never touched; `--dry-run` writes nothing. Tokens flow file→file
and are never printed — report lines say `(token set)` / `(no token)`. Imported
entries only ever carry `url`/`ssh` + token, never a tunnel argv.

- **`--url`** — direct. Speak fetch straight at it.
- **`--ssh HOST`** — the CLI shells out to the system `ssh` binary
  (`ssh -N -o BatchMode=yes … -L <free>:127.0.0.1:<remotePort> HOST`); your
  `~/.ssh/config`, keys, and jump hosts all apply. It is a built-in template of
  the tunnel mechanism.
- **`--tunnel argv… {port}…`** — the cloud generalization. `{port}` is
  substituted with a free local port; the argv is spawned directly (never a
  shell), waited on until the port accepts, then the wire is spoken through it,
  and the child's **process group** is reaped on exit. Covers
  `kubectl port-forward`, `aws ssm start-session`,
  `gcloud compute start-iap-tunnel`, `cloudflared access tcp`, … — no cloud
  SDKs in our code. The `--tunnel` flag is greedy: it must be **last**, since
  it consumes the rest of the command line as its argv.

#### Cloud transports — templates over the tunnel mechanism

A raw `--tunnel` argv is **code**, which is why `ctx import` never shares it. The
four typed cloud kinds are **data** — safe to `ctx import`, to commit to a shared
team contexts file, to paste in Slack — each a built-in `{port}`-tunnel template
around the operator's own vendor CLI (no AWS/GCP/Azure SDKs, ever; we spawn
`aws`/`kubectl`/`gcloud`/`az` argv-direct and relay their stderr):

| Flag | Stored kind | Expands to (the vendor CLI we spawn) |
|---|---|---|
| `--ssm TARGET [--region R] [--profile P]` | `ssm` | `aws … ssm start-session --target TARGET --document-name AWS-StartPortForwardingSession --parameters {…}` |
| `--ssm-ecs CLUSTER/FAMILY [--region R] [--profile P]` | `ssm` (`ecs`) | resolves the **running** task's SSM target at connect time (see below), then the same `aws ssm start-session` |
| `--kubectl POD_OR_SVC [--namespace NS] [--kube-context C]` | `kubectl` | `kubectl [--context C] [-n NS] port-forward POD_OR_SVC {port}:7900` |
| `--gcloud-iap INSTANCE [--zone Z] [--project P]` | `gcloud` | `gcloud compute start-iap-tunnel INSTANCE 7900 --local-host-port=localhost:{port} [--zone Z] [--project P]` |
| `--az-bastion NAME --az-resource-group G --az-target ID` | `az` | `az network bastion tunnel --name NAME --resource-group G --target-resource-id ID --resource-port 7900 --port {port}` |

`remotePort` is a top-level sibling (default `7900`), same as `--ssh`. `--ssm`
and `--ssm-ecs` are mutually exclusive; `az` requires all three of its fields.

**`--ssm-ecs` resolves at connect time.** Fargate task ids are ephemeral — a
stored `ecs:…` target goes stale on every redeploy — so a `--ssm-ecs
CLUSTER/FAMILY` context does two `aws ecs` reads when you open it (`list-tasks`
for the running task, `describe-tasks` for its container `runtimeId`), composes
the concrete `ecs:CLUSTER_<taskId>_<runtimeId>` target, and tunnels to that. No
running task → a clear connect error; `aws`'s own stderr is relayed verbatim.

> **Honesty caveat.** The `gcloud`/`az` templates follow the vendors' documented
> CLI syntax but have **not** been exercised against live GCP/Azure —
> `ctx test --verbose` relays the vendor CLI's own stderr, which is the diagnosis
> surface. The `ssm`/`kubectl` shapes are the same tunnel mechanism `--ssh` uses
> and are verifiable in shape the same way. Missing a vendor binary surfaces as
> the usual tunnel-failed error with an "is `<cli>` installed?" hint.

**When an SSM tunnel fails, the error names the world.** SSM's control plane
happily starts sessions to sick instances, so a bare timeout says nothing. On
any failed open of an `--ssm` context, clodexctl asks SSM about the instance
and appends a verdict: **no registration** ("terminated, stopped, or never had
the agent — if you recreated the box, `deploy ssm <name> --target i-NEW…`"),
**agent not pinging** ("last ping 43m ago — reboot it, or redeploy if it was
replaced"), or **Online yet unreachable** ("suspect the box itself: service
down, wrong port, or a wedged agent"). Best-effort — if the describe call
itself fails, the original error stands alone.

### One-shot / CI

No file needed: `clodexctl --url … --token … sessions`. Env sits between file
and flags (flags win): `CLODEX_URL` / `CLODEX_TOKEN`. `--ctx NAME` overrides
the current context. `--url` and `--ssh` are mutually exclusive per call.
(`--ssh` also works as a one-shot flag; `--tunnel` and the typed cloud kinds
are `ctx add`-only — they're not in the one-shot flag layer by design: a
persistent context is the product for a cloud node, and the one-shot layer
already has `--url` for the rare ad-hoc case.)

The token travels **only** as an `Authorization: Bearer` header from
in-process fetch — never in argv (ps-visible), never in a URL, never logged.

## Verbs

> **`clodexctl help <verb>` is the authoritative per-verb reference.** Help is
> contextual: `clodexctl` (or `--help`) prints a grouped index of every verb, and
> `clodexctl help <verb>` / `clodexctl <verb> --help` renders that verb's full
> usage, flags, examples, and gotchas — rendered from a single in-code registry
> that a test pins to the dispatch table (a verb can't ship without an entry).
> The tables below are the narrative tour; for the exact current flag set of any
> verb, ask `help`.

Read (all support `--json` — stable raw wire payload):

| Verb | Route |
|---|---|
| `info` | `GET /api/peer/hello` (also a connectivity test) |
| `sessions` | `GET /api/sessions` |
| `logs <name> [--tail N] [-f\|--follow]` | `GET /api/transcript/:name?limit=N` (+ `GET /api/events` when `-f`) |
| `query <name> <kind>` | `POST /api/query/:name` — kind ∈ `ctx report bust files filePeek fileDiff` (`--path`, `--detail`) |
| `args get <name>` | `GET /api/session-args/:name` |
| `skills <name>` | `GET /api/skill-catalog/:name` |

**`run` — the one verb.** For "make this session do something and show me the
result", reach for `run` — it looks up the session's type and picks the right
path for you:

| Verb | Route | Notes |
|---|---|---|
| `run <name> <text…> [--timeout N] [--quiet-ms N] [--raw] [--json]` | `GET /api/sessions` (type lookup) → send-wait **or** exec | **agent** (claude/codex) → send the text as a prompt, wait for the turn to end, print the reply; **bash** → run the command, print the terminal output. `--json` carries `mode:"agent"\|"pty"`. Always executes (no `--no-enter`) |

`run` adds one `GET /api/sessions` round-trip to learn the type — the engine's
session list is **authoritative**, so a bash session named like an agent (or the
reverse) can't misroute. An unknown name is the usual not-found (exit `5`), and
lists the running session names to help.

**`attach` — be there.** Where `run` asks and waits, `attach` opens a live
terminal:

| Verb | Route | Notes |
|---|---|---|
| `attach <name> [--read-only]` | `GET /api/attach/:name` + control + `POST /api/input`/`resize` | streams scrollback replay then live output; forwards keystrokes (acquires control, pushes your terminal geometry); **Ctrl-\\** detaches and is never forwarded. Needs a TTY. `--read-only` mirrors without control. Auto-reconnects with full re-replay + re-acquire |

`attach` is type-agnostic on purpose — a human at a keyboard is the right
consumer of a raw TTY for bash *and* agent sessions (no `run`-style guardrail).
It requires a real terminal on both stdin and stdout (exit `2` otherwise — use
`run`/`logs` for scripting). Replay is best-effort scrollback, **not** exact
terminal state (the client resets its screen and re-applies on every connect);
`Ctrl-\` is unavailable to the remote; and the geometry you attach with becomes
the session's (controller wins, matching the GUI's take-control). If the stream
goes silent for 60s or drops, it reconnects (1s/2s/4s, three tries) and
re-replays; exhausted → exit `3`. Keystrokes are forwarded as UTF-8 text (the
same channel the GUI's xterm and `exec` use) — arrow keys, ESC sequences, and
any ASCII control input work; raw non-UTF-8 byte streams are not guaranteed to
round-trip losslessly.

**`web` — the node's GUI in your browser.** Every deployed node runs the web
frontend on a loopback-only port (the installer enables it on wire-port+1 and
`deploy` saves it as the ctx's `webPort`). `web` opens a foreground tunnel to it
over the SAME transport the context already carries — no new credentials, no
published ports on the box — prints the URL, and pops your browser:

| Verb | Mechanism | Notes |
|---|---|---|
| `web [ctx] [--port N] [--no-open]` | reuses the ctx's tunnel to the node's web-GUI port (saved ctx `webPort`, else wire-port+1) | prints `http://127.0.0.1:PORT` prominently and **pops your browser** (`open`/`xdg-open`, best-effort — skipped under `--no-open` or a non-TTY stdout; the URL is always printed), then **holds in the foreground**; Ctrl-C exits `0`. `LOCAL` defaults to `8080` (first free of `8080..8090`); `--port` pins it. A **keep-alive probe** rides the tunnel (a cloud tunnel's data channel can die while the local child lives on): if the node stops answering, the hold ends with exit `3` and an honest message instead of serving a zombie tab. Same tunnel machinery as `port-forward` — a `url` (direct) context has no tunnel → exit `2` |

The browser-through-SSM recipe: `clodexctl deploy ssm mybox --target i-…`, then
`clodexctl web mybox` — the GUI for a node with **no ssh and no published ports**
opens in your browser, the tunnel riding the same SSM session the wire uses. The
node's web host binds `127.0.0.1` only (`CLODEX_WEB_HOST=127.0.0.1` in the unit
drop-in), so it is reachable *exclusively* through this authenticated tunnel.

**`port-forward` — reach any OTHER port on the node.** `web` is the shortcut for
the common case; `port-forward` is the general plumbing — a raw TCP tunnel to an
arbitrary remote port, over the SAME transport:

| Verb | Mechanism | Notes |
|---|---|---|
| `port-forward LOCAL:REMOTE [--probe-http]` | reuses the ctx's tunnel (`ssh -L` / `ssm start-session` / `kubectl port-forward` / `gcloud IAP` / `az bastion` / custom `{port}` argv) targeting `REMOTE` instead of the wire port | prints `forwarding 127.0.0.1:LOCAL -> <target>:REMOTE — Ctrl-C to stop`, then **holds in the foreground**; Ctrl-C exits `0`. `LOCAL` binds `127.0.0.1` only. `REMOTE` is a port number or `web` (the node's web-GUI port; the `web` verb above is the friendly shortcut). **Single-shot** — a dropped tunnel exits `3` with the child's stderr (no reconnect; the consumer retries). `--probe-http` adds the keep-alive probe when the remote speaks HTTP — any response (200/401/404) counts as alive; two missed probes end the hold with exit `3` instead of holding a dead pipe. A `url` (direct) context has no tunnel → exit `2`. Non-TTY OK |

Both generalize the tunnel machinery (`transport.js`) that every wire verb uses
to open the wire port: same `{port}`-substituted, process-group-reaped child,
but forwarding a port you name and held open in the foreground kubectl-style
rather than reaped after one request.

**`logs -f` — follow.** Print the tail, then stream new transcript entries as
each turn lands (subscribes to `/api/events`, refetches the delta on an activity
for your session). `--json` emits **NDJSON** (one object per new entry), so
`clodexctl logs bob -f --json | jq` is the point. Ctrl-C exits `0` — it's a
pager, not a failure — and a non-TTY stdout is fine (pipe it into `grep`). Same
60s staleness watchdog + bounded reconnect as `attach`; a reconnect re-snapshots
silently (no duplicate lines).

Write:

| Verb | Route | Notes |
|---|---|---|
| `spawn <name> --cwd DIR --type T [--model M] [--arg X …] [--fork]` | `POST /api/sessions` | `--model`/`--arg` ride `extraArgs` |
| `kill <name> [--force]` | `POST /api/kill/:name` | **HARD DELETE — no resume.** Confirms unless `--force` (required with `--json`) |
| `restart <name> [--fresh]` | `POST /api/restart-session/:name` | |
| `args set <name> [--arg X…] [--proxy URL] [--restart]` | `POST /api/session-args/:name` | |
| `restart-app [--force]` | `POST /api/restart` | relaunches the whole engine |

Plumbing (**prefer `run`** — these are the raw paths it routes over, kept for
scripting and explicit control):

| Verb | Route | Notes |
|---|---|---|
| `send <name> <text…> [--wait [--timeout N]]` | `POST /api/send` | **fire-and-forget** by default (scripting). `--wait` blocks until the agent's turn ends and prints the new entries (default 300s) — `run` on an agent **is** this path |
| `input <name> <text…> [--no-enter]` | `POST /api/input/:name` | raw keystrokes, **no wait**; acquires + releases control; sends Enter by default (`--no-enter` posts raw). The deliberate low-level channel — **no agent guardrail** |
| `exec <name> <cmd…> [--quiet-ms N] [--timeout N] [--raw] [--pty]` | `GET /api/attach/:name` + control + `POST /api/input/:name` | run one command in the PTY and print what the terminal produced; waits for quiet (default 750ms) or `--timeout` caps (default 30s); ANSI stripped unless `--raw`. On an **agent** it refuses without `--pty` — `run` on bash **is** this path |

**`exec` — exit status is about DELIVERY, not the remote command.** Screen bytes
carry no exit code, so `exec` exits `0` when the command was typed and the output
went quiet — it says nothing about whether the command itself succeeded. The
echoed command and re-printed prompt are part of the printed output (honest
terminal truth, not stripped). A timeout prints the partial output and exits `1`.
Pass `--` before a command containing dashes so they aren't parsed as flags.

**`exec` on an agent needs `--pty`.** Typing into a claude/codex session paints
its raw TUI screen (scary, and rarely what you want) — so `exec` on an agent
**warns and refuses** unless you pass `--pty`. Typing into an agent's TUI is
legitimate (answering a permission dialog, say), but it must be chosen, not
stumbled into. For "make the agent do something", use `run`. (`input` is the
explicit raw-keystroke channel and carries no such guardrail — that's its job.)

**`send --wait` — "idle", not "done".** `--wait` returns when the agent's *turn
ends* (it went idle after your message), which is not the same as the agent
declaring the work finished — a long task that parks mid-work still ends its
turn. The printed entries are the transcript rows newer than a pre-send snapshot,
from the first assistant entry on (your echoed message is excluded). The stronger
contract (task ids, completion events) is T38.

## Deploy a node

| Verb | Transport | Notes |
|---|---|---|
| `deploy <user@host> [--port N] [--repo URL] [--branch B] [--src DIR] [--name N] [--no-ctx] [--force] [--ssh-opt X …] [--claude-token-file FILE] [--dry-run]` | system `ssh` → `bash -s` | drives `peering/clodex-deploy.sh` on the box (installs the claude/codex CLIs too), streams `::step`/`::ok` progress (`--json` = NDJSON), verifies the wire through an ssh tunnel, then saves a `{ssh, remotePort}` context. `--claude-token-file` rides the ssh stdin into a `0600` unit drop-in |
| `deploy docker <name> [--port N] [--image I] [--tag T] [--env-file F] [--host ssh://u@box] [--volume V …] [--no-ctx] [--force] [--dry-run]` | system `docker run` | births a container node from the published image, verifies hello, saves a context (`{url}` local / `{ssh, remotePort}` remote) |
| `deploy ssm <name> --target i-INSTANCE [--region R] [--profile P] [--branch B] [--repo URL] [--port N] [--no-ctx] [--force] [--claude-token-file FILE] [--dry-run]` | system `aws` → SSM RunCommand | installs an **OS-flavor** node (dedicated `clodex` host user + systemd --user service) on an SSM-managed instance with **no ssh and no open ports**: one root `AWS-RunShellScript` running the pinned installer, polled to completion, then verified through the real SSM port-forward. Saves a typed `{ssm, token}` context. `--claude-token-file` is delivered over the encrypted wire post-verify (**never** via SSM params) |
| `deploy helm <name> [--namespace NS] [--kube-context C] [--chart PATH] [--port N] [--set k=v …] [--values F] [--no-ctx] [--force] [--claude-token-file FILE] [--dry-run]` | system `helm` + `kubectl` | a **KUBERNETES** node from the packaged chart (`cli/deploy/helm/clodex`): mints a wire token, `helm upgrade --install … --set-file secrets.wireToken=<0600 tempfile> --wait`, saves a typed `{kubectl: svc/<name>, token}` context, then verifies hello **through the real `kubectl port-forward`** with the token. Re-run = `helm upgrade` in place, **reusing** the release's existing token |

`deploy` is the CLI twin of the GUI's add-peer wizard. It runs the **same
idempotent installer** the GUI uses, so **re-running `deploy` on the same host is
the update path**. Deploy params ride the remote environment (`PORT`, `REPO_URL`,
`BRANCH`, `CLODEX_SRC`); the default repo is the public Clodex repo, default
branch `master`, default port `7900`.

- **ssh-reachable boxes only** (this flavor). Fargate nodes have no box to
  script — they stay recipe-based (see `docs/deployment-plan.md`); k8s nodes
  get `deploy helm` below (the manual chart install in
  `docs/recipes/kubernetes.md` remains the reviewable alternative).
- **No token is stored.** The node binds loopback and is reached over an ssh
  tunnel; the tunnel is the auth boundary (same posture as the GUI's peers).
- **The claude/codex CLIs are installed** (native installer → `~/.local/bin`,
  best-effort — a failed install never fails the deploy), and the unit's `PATH`
  carries `~/.local/bin` so a spawned agent session resolves them. A node that
  only runs bash sessions is fine without them.
- **`--claude-token-file FILE`** authenticates Claude on the box: it reads
  `CLAUDE_CODE_OAUTH_TOKEN` from a local file (a **raw token**, or a
  `CLAUDE_CODE_OAUTH_TOKEN=…` env-file line) and rides the **ssh stdin** (already
  the auth boundary, not logged) into a `0600` systemd drop-in
  (`clodex.service.d/claude-token.conf`). The token never appears in argv, `ps`,
  `--json`, or the deploy trail. Without it, `claude` installs but is
  unauthenticated (it prompts/fails at first use — honest).
- On success a context is saved (name defaults to the host's short name, or
  `--name N`); a name collision is **kept** unless `--force`. `--no-ctx` opts out.
  Deploy ends with `clodexctl --ctx <name> sessions`, not just an installed service.
- **Exit 42 from the script = needs root.** The script prints the exact `sudo`
  commands it couldn't run non-interactively; run them on the box, then re-run
  `deploy`. `--dry-run` prints what would run and does nothing.

The `cli/deploy/clodex-deploy.sh` shipped in the package is a **byte-for-byte
copy** of `peering/clodex-deploy.sh` (the source of truth); a test pins them
equal so drift fails the suite.

### `deploy docker <name>` — a container node

`deploy docker` births a node with **one `docker run`** of the published,
self-configuring image (`docker/web/Dockerfile` bakes `CLODEX_REMOTE_ENABLE=1`,
`CLODEX_REMOTE_HOST=0.0.0.0` and the headless `CMD`, so the wire comes up on
`7900` in-container with no toggle to reach). One `docker run` = one node.

```
clodexctl deploy docker mybox                 # local docker, image :latest
clodexctl deploy docker edge --host user@box  # docker on a remote box over ssh
clodexctl deploy docker ci --tag v3.5.2 --env-file ./auth.env
```

- **Not a GUI sandbox.** A CLI container is the *minimal* box — a plain peer
  named `clodexctl-<name>`, **not** a managed GUI sandbox (no compose, no
  registry row, no library binds). The desktop app won't list it as a sandbox;
  it's just a peer/context like any other deploy target.
- **`docker` is the operator's tool** (system binary, like `ssh`/`kubectl`) —
  spawned argv-direct, never through a shell, zero docker SDKs. Nonzero exit
  relays docker's own stderr; a missing `docker` binary is a server-side
  failure (exit `1`) with an "is docker installed?" hint.
- **Loopback publish is the trust boundary.** The wire publishes on
  `127.0.0.1:<port>:7900` — local host → only this machine reaches it; a remote
  `--host` → only that box's loopback, reached via the ssh tunnel the saved
  context opens.
- **`--host ssh://user@box`** (bare `user@box` is accepted and prefixed) sets
  `DOCKER_HOST` for the spawned `docker` — docker handles its own ssh transport.
  A non-standard ssh port for the *verify tunnel* belongs in `~/.ssh/config`.
- **Secrets ride only `--env-file`.** That file is passed straight to docker's
  own `--env-file` (by path — we never read or print it). The two keys the image
  understands: `CLAUDE_CODE_OAUTH_TOKEN` (the agent's auth) and, optionally,
  `CLODEX_REMOTE_TOKEN` (gates the wire). The verb works with **no** env-file at
  all (loopback + no token = localhost trust, same posture as the dev sandbox).
- **Verify + context.** After `run`, hello is polled until healthy (~60s;
  the pull already happened inside `run`). A saved `CLODEX_REMOTE_TOKEN` means
  the probe gets a **401 — that counts as success**: the node is up and
  token-gated, so the context is saved (transport only) and you add your token
  with `clodexctl ctx add`/edit. No token is ever stored (we never saw it).
  Local → `{url}`; remote → `{ssh, remotePort}`. Collision kept unless `--force`;
  `--no-ctx` opts out. A **version-pinned `--tag`** is the reproducible choice.
- **Lifecycle is the operator's docker.** Stop/remove with
  `docker stop clodexctl-<name>` / `docker rm clodexctl-<name>`; the
  `clodexctl-<name>-data` volume survives `rm` and carries the node's sessions.
  (`clodexctl` adds no container lifecycle verbs.)

### `deploy ssm <name> --target i-INSTANCE` — a node with no ssh, no open ports

The **OS flavor over AWS SSM RunCommand** — the *same* node the ssh flavor
installs (a dedicated `clodex` host user running the systemd --user service), not
a container. SSM has no clean stdin/stdout exec pipe (send-command is async,
output polled, 24 KB-capped), so the interactive git-clone-over-ssh path can't
ride it. But RunCommand runs as **root**, so the exit-42 "needs sudo" dance
inverts: one root wrapper installs the prereqs itself, mints the user, then runs
the pinned installer as that user and relays its `::` marker trail.

```
clodexctl deploy ssm mybox --target i-0123456789abcdef0 --region us-west-2 --profile prod
clodexctl deploy ssm mybox --target i-… --branch dev --dry-run   # print the argv + wrapper, run nothing
```

- **The sequence.** Mint a wire token locally → `describe-instance-information`
  preflight (registered + `Online`, or a pointed `EXIT.CONNECT` hint about the
  SSM agent + the `AmazonSSMManagedInstanceCore` role) → `send-command` (a root
  `AWS-RunShellScript`: prereqs incl. **node ≥ 20** → the pinned installer as the
  `clodex` user → the token drop-in → an on-box `curl` hello loop) →
  `get-command-invocation` poll (5 s cadence, **10 min budget**;
  `StandardOutputContent` is read partial each tick, so the marker trail
  **pseudo-streams** as it grows) → verify from your laptop **through the real
  SSM port-forward** with the token → save a typed
  `{ssm:{target,region,profile}, token}` context (`remotePort` when `--port` ≠
  7900). `Failed`/`Cancelled`/`TimedOut` each relay the invocation's output tail
  with a distinct message and exit `1` (`TimedOut` says "re-run to resume").
- **`aws` is the operator's tool** — spawned argv-direct (the same `execFn` seam
  the `--ssm` transport uses), never a shell, **zero AWS SDKs**. A missing `aws`
  binary is the "is aws installed?" hint. A newly-registered instance can be
  eventually-consistent, so `send-command` retries a bounded few times on
  `InvalidInstanceId` and the poll waits ~2 s before its first tick.
- **A first-class node, not a container.** The `clodex` user's home holds the
  clone and the systemd --user service, the wire bound on `127.0.0.1:<port>`
  **on the box** — it never leaves the instance's loopback. Re-running is the
  update path (the installer, `useradd`, and linger steps are all idempotent).
- **The installer is byte-for-byte the pinned `clodex-deploy.sh`** — the wrapper
  embeds it verbatim (a drift test gates it equal to `peering/clodex-deploy.sh`)
  and runs it under `sudo -iu clodex bash -s`, its full log parked at
  `/home/clodex/clodex-deploy.log` and surfaced as a `::log` marker.
- **Always token-gated.** A fresh `CLODEX_REMOTE_TOKEN` is minted every deploy.
  The installer itself is **tokenless** (the ssh flavor's tunnel-is-auth posture),
  so the wrapper injects the token *after* it runs, via a systemd --user drop-in
  (`~/.config/systemd/user/clodex.service.d/remote-token.conf`, mode `0600`) that
  the app reads through its native env precedence (`CLODEX_REMOTE_TOKEN` wins) —
  the installer bytes are never touched.
- **Token visibility (say it out loud).** That token rides inside the
  `send-command` parameters, so it is visible in the account's **SSM command
  history / CloudTrail** to anyone with `ssm:GetCommandInvocation`. This is an
  acceptable posture **only because the port never leaves loopback** — reaching
  the wire at all requires `ssm:StartSession` on the same account. To rotate the
  token, **re-run `deploy ssm`** (it mints a new one, rewrites the drop-in and
  restarts the service, then updates the context).
- **`--claude-token-file FILE` never rides SSM.** The Claude OAuth token is
  **not ours to rotate** (unlike the wire token), so it must **not** land in
  CloudTrail. It is delivered **after the verify** over the **encrypted wire**
  (the SSM port-forward): a throwaway bash session is spawned over the wire, the
  drop-in is typed in (the token rides a shell **variable assignment**, never a
  process argv), written `0600` to `clodex.service.d/claude-token.conf`, and the
  service restarted. The restart drops the wire (the delivery session dies with
  it); the engine comes back with `claude` authenticated. The token appears in
  **no** SSM parameter, argv, `--json`, or trail. Same file format as the ssh
  flavor (raw token or a `CLAUDE_CODE_OAUTH_TOKEN=…` line).
- **The claude/codex CLIs are installed** by the pinned installer (best-effort,
  `~/.local/bin`, on the unit `PATH`) — same as the ssh flavor.
- **Model credentials** belong on the **instance role** (Bedrock) or seeded
  manually on the box — the same guidance as the ssh flavor.
- **ssh-reachable boxes** should prefer plain `deploy <user@host>`; **`deploy ssm`
  is for instances you reach only through SSM**. A host literally named `ssm`
  still works via `deploy ssh ssm`.

### `deploy helm <name>` — a Kubernetes node in one command

Installs the **packaged chart** (`cli/deploy/helm/clodex` — a StatefulSet +
headless Service, no Ingress; the chart itself is the reviewable surface) as
helm release `<name>` and wires everything up: mint → install → context →
verify. `<name>` doubles as the helm release name **and** the ctx name, so it
must be DNS-1123 (lowercase letters/digits/hyphens, max 53 — no dots or
underscores; validated early with a clear message).

```
clodexctl deploy helm mynode                                   # current kubectl context, ns "clodex"
clodexctl deploy helm mynode --kube-context prod --namespace agents
clodexctl deploy helm mynode --claude-token-file ./token       # authenticate claude in the pod
clodexctl deploy helm mynode --set persistence.enabled=false --dry-run
```

- **The sequence.** Preflight (`helm`/`kubectl` resolve; the kube context is
  resolved and **echoed** — deploying to the wrong cluster silently is the
  scary failure; namespace created if absent) → wire token: **minted** fresh,
  or — when the release already exists (`helm status` ok) — **reused** from
  the release's `<name>-secrets` Secret, so a redeploy/upgrade never rotates
  the token under a live ctx entry → `helm upgrade --install <name> <chart>
  --set-file secrets.wireToken=<tempfile> --wait --timeout 5m` → save a typed
  `{kubectl: {target: svc/<name>, namespace, context}, token}` context →
  laptop-side hello **through the real `kubectl port-forward` transport** with
  the Bearer token (proves port-forward + token end-to-end; `--wait` had only
  proven the pod-internal readiness probe).
- **Token discipline.** Token **values never enter argv, logs, or errors** —
  only file **paths** do (`--set-file` reads client-side). The tempfiles are
  `0600` and removed in a `finally`. `--claude-token-file` takes the same file
  formats as the other flavors (raw token or a `CLAUDE_CODE_OAUTH_TOKEN=…`
  line) and rides `--set-file secrets.oauthToken=…` into the chart-managed
  Secret. Note helm also keeps release values in its own release Secret in the
  namespace (same RBAC); if that's unacceptable use the chart's
  operator-managed `secrets.existingSecret` mode via the manual recipe.
- **helm/kubectl are the operator's tools** — spawned argv-direct (the same
  `execFn` seam as `aws`), never a shell, zero k8s SDKs. A missing binary gets
  the "is helm installed?" hint.
- **Failure honesty.** A helm failure mid-`--wait` **leaves the release
  installed** in a partial state — the error says so and tells you to fix the
  cause and re-run (**the same command upgrades in place**; no auto-rollback).
  A verify failure after a green helm still keeps the saved context and points
  you at `clodexctl --ctx <name> ctx test --verbose`.
- **Local/docker-desktop shape today.** EKS identity (IRSA service accounts)
  rides the chart's `serviceAccount` values — pass them with `--set`/`--values`
  or use the manual install in `docs/recipes/kubernetes.md`. More nodes = more
  **releases** (one release, one pod, one PVC — agents are stateful PTYs, not
  replicas).
- **Re-runs don't `--reuse-values`.** `helm upgrade` is invoked with a full
  fresh value set, so prior `--set` / `--values` / `--port` choices fall back
  to chart defaults unless you **repeat them on every run**. Tokens are the
  deliberate exception: the wire token is re-read from the release Secret, and
  the claude oauth token is carried forward when `--claude-token-file` is
  absent (pass it again to rotate).
- Collision on the ctx name is **kept** unless `--force`; `--no-ctx` opts out.
  `--dry-run` prints the cluster/namespace/release/chart, the exact helm argv
  (placeholder token paths), and the ctx entry to be written. A host literally
  named `helm` still works via `deploy ssh helm`.

## Exit codes (contract)

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | server error (5xx, or an `ok:false` the server chose) |
| 2 | usage error — unknown verb, bad/missing args or flags |
| 3 | connect failure — couldn't reach the wire (DNS / refused / dead tunnel) |
| 4 | auth — 401/403 (missing/wrong token, or not the control holder) |
| 5 | not found — 404 (unknown session/route) |
