# Deploying the Clodex engine anywhere — the node contract

Status: DESIGN EXPLORATION (2026-07-21). Follows `docs/engine-as-substrate.md`
(the engine is the product; GUIs are lenses). This doc answers: **how does a
Clodex engine get born on a box we don't own a shell on** — a Fargate task, a
k8s pod, a random VPS — and end up controllable from a desktop Clodex?
Grounded in a full recon of the existing deploy machinery (2026-07-21); every
"exists" claim below has a file:line behind it.

## The thesis

Clodex should not grow per-cloud integrations ("Fargate support", "k8s
support"). It should define **one node contract** — image + env-var
configuration + credential seeding + registration handshake — and then each
deployment target is a thin, mostly-declarative *recipe* (a compose file, a
task definition, a manifest, an SSH script). The recipes are documentation
plus templates; the contract is the product.

The proof this works is already in the tree: `sandbox.js` is the node
contract instantiated for one target (local Docker). It resolves a published
image (`ghcr.io/avirtual/clodex:<version>`), generates a compose file,
injects config as env vars, mints a wire token (`crypto.randomBytes(32)`),
seeds credentials via an `env_file`, brings the node up, and registers it as
a peer at `http://127.0.0.1:<port>` — after which it is indistinguishable
from any other peer. Generalizing deployment = extracting that sequence from
its local-Docker casing.

## What exists today (recon summary)

Four deployment mechanisms, none of which transfer to Fargate/k8s as-is:

| Mechanism | Target | How it works | Why it doesn't generalize |
|---|---|---|---|
| Peer-deploy wizard (`peer-deploy.js`, `peering/clodex-deploy.sh` via `ssh-run.js`) | Linux/mac box with SSH | ssh in, git clone, npm install, systemd --user unit, poll `/api/peer/hello` | Needs SSH, sudo, git/node preinstalled, persistent disk. Fargate/k8s have none of these |
| Test-peer container (`docker/Dockerfile`, `docker/run.sh`) | Local Docker | Full systemd+sshd Ubuntu image, Clodex built at image-build time | Explicitly a throwaway test box (its own header says so); systemd-in-docker is anti-idiomatic everywhere else |
| Sandbox (`sandbox.js` + `docker/web/Dockerfile`) | Local Docker | Slim image, headless-main CMD, compose generated per-start, auth via env file, self-registers as peer | The right shape — but orchestration is hardcoded to local `docker compose` and loopback ports |
| Hand-built tunnels (`peer-tunnel.js`; gitignored launchd plist + k8s ingress in `deploy/`) | Operator's own boxes | `ssh -L` forwards, static ingress with injected Bearer token | Artisanal; controller-initiates or hand-configured only |

Two load-bearing facts from the recon:

- **Credentials have a non-interactive path already** (Claude side): the
  sandbox seeds `CLAUDE_CODE_OAUTH_TOKEN` (obtained once via
  `claude setup-token`) through a 0600 `auth.env` consumed as compose
  `env_file`. No `ANTHROPIC_API_KEY` path exists anywhere in the repo, and
  Codex still requires an interactive `codex login` against a persistent
  volume. So "agent OAuth can't be baked" (engine-as-substrate.md) is
  half-solved: Claude tokens travel as env; Codex is the open half.
- **Every reachability mechanism is controller-initiates.** SSH probe, SSH
  tunnel, static forwards — the desktop always dials the node. There is no
  code path for a node that can only make *outbound* connections. Fargate
  tasks and k8s pods can be given inbound routes (public IP + security
  group; Service/Ingress) but it's operational friction; outbound-only is
  the thing those environments guarantee for free.

## The node contract (four parts)

### 1. Image

`docker/web/Dockerfile` is already the canonical node image: node-pty built
against Node's ABI, `claude`/`codex` CLIs installed, non-root user,
`CMD ["node", "headless-main.js"]`, no Electron. It is already published per
release (`ghcr.io/avirtual/clodex:<version>`, consumed by `resolveImage` in
sandbox.js). Work needed:

- Pin the CLI versions at build (currently unpinned `npm i -g` — a node
  launched in six months gets whatever CLI ships that day; fine for the
  local sandbox, wrong for a fleet).
- Declare the image's **volume contract** explicitly in the Dockerfile:
  `/data` (CLODEX_DATA_DIR — sessions.json, the node's identity),
  `/home/clodex/.claude` and `/home/clodex/.codex` (agent auth). A node
  with all three on persistent storage survives restart with sessions
  resumable; a node with none is fully ephemeral and that must be a
  *stated* mode, not an accident.
- A `HEALTHCHECK` / documented liveness endpoint. `GET /api/peer/hello`
  already exists and is exactly a liveness+identity probe; bless it as the
  official one (k8s livenessProbe, ECS healthCheck, compose healthcheck all
  point at it).

### 2. Configuration = env vars (the contract surface)

Everything a node needs at birth already travels as env vars — this is why
the recipe model works, because task definitions, pod specs, and compose
files all speak env natively. The contract, consolidated:

| Var | Meaning | Today |
|---|---|---|
| `CLODEX_DATA_DIR` | userData root (sessions.json, pidfile) | exists (headless-main.js) |
| `CLODEX_REMOTE_ENABLE` / `CLODEX_REMOTE_HOST` / `CLODEX_REMOTE_TOKEN` | the wire: on, bind addr, auth | exists (remote-wiring.js) |
| `CLODEX_WEB_PORT` / `CLODEX_WEB_TOKEN` | optional browser lens | exists |
| `CLODEX_WORKSPACES` | which workspaces to restore | exists |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude agent auth | exists (consumed by CLI) |
| `CLODEX_NODE_NAME` | stable node identity for registration | **new** |
| `CLODEX_CONTROLLER_URL` / `CLODEX_CONTROLLER_TOKEN` | where to announce (dial-home) | **new** (see part 4) |

Deliverable: document this table as the official contract (it currently
lives scattered across three files), and treat additions as contract
changes, not implementation details.

### 3. Credential seeding

- **Claude — solved pattern, promote it**: operator runs `claude setup-token`
  once on the desktop, puts the token in the target's secret store (AWS
  Secrets Manager → task-def `secrets:`; k8s Secret → `envFrom`; compose
  `env_file`). The sandbox's `auth.env` is this pattern's local instance.
- **Codex — open problem**: `codex login` is interactive-only today.
  Options, in preference order: (a) check whether Codex supports an
  equivalent token/headless auth and use it; (b) treat `~/.codex` as a
  seedable blob — log in once locally, snapshot the volume, restore it into
  the node's volume (works today, ugly, tokens age); (c) ship nodes
  Claude-only until (a) exists. A node whose recipe says "Claude works out
  of the box, Codex needs a one-time interactive step" is honest and
  shippable.
- Never bake tokens into images; never inline them into generated
  compose/manifests (sandbox.js already gets this right with `env_file` —
  keep that property everywhere).
- **The node is a trust boundary** (contrarian finding, taken): an OAuth
  token in the node's environment is readable by any shell-capable agent
  running on that node. This is inherent to "agents with tools share a
  box with a credential", not a bug to fix here — but it must be stated
  in every recipe: don't run untrusted tasks on a node seeded with
  personal OAuth creds; prefer short-lived/revocable tokens where the
  provider offers them; treat per-node credential isolation as part of
  the multi-tenant story, not v1.
- **Exposure posture for recipes**: one bearer token currently grants the
  full read-write wire (spawn, input, kill, restart-app). Until the wire
  grows scoped tokens/roles, every recipe defaults to *non-public* access
  — tunnel, VPN, or security-group allowlist from the controller only.
  Publishing a node's wire on the open internet is not a documented mode.

### 4. Registration — the one genuinely new mechanism

How does the desktop learn "a node exists at URL X with token Y"? Two
models (previewed in engine-as-substrate.md; the recon flips their
priority):

**Orchestrate** (controller launches the node, so it already knows): this is
sandbox.js today, and it extends naturally to "controller calls the AWS/k8s
API". But it makes Clodex grow per-cloud launch code (SDKs, IAM, task-def
authoring) — exactly the per-cloud integration the thesis rejects. Keep it
for local Docker where it's already built; don't extend it.

**Announce** (node dials home at boot): the node, given
`CLODEX_CONTROLLER_URL` + `CLODEX_CONTROLLER_TOKEN` at launch, POSTs its
identity to the controller — `{name, url, wireToken, caps}` — and the
controller auto-adds it to the existing `peers` array (the same one SSH
peers and sandbox boxes already live in). This inverts the recon's
"controller-initiates everywhere" finding, and it's what makes the Fargate
answer honest: *anyone* with *any* launcher (console click, Terraform, CI
job, `aws ecs run-task`) can mint a node, because the node introduces
itself. Clodex ships zero cloud SDKs.

Announce v1 still assumes the node is *inbound-reachable* at the URL it
announces (Fargate public IP, k8s LoadBalancer/Ingress) — the controller
attaches over the existing peer wire exactly as today. The endpoint is
small: one authenticated route on the controller's `remote.js`
(`POST /api/peer/announce`, gated by a controller-side registration token),
one boot-time POST-with-retry in `headless-main.js`.

**Trust model — hardened after contrarian review (2026-07-21).** The
registration token admits a node to *candidacy*, not to the peer store.
An announce must never blindly mutate active peers (a hostile or merely
buggy node could name-collide onto a real peer, register garbage URLs at
volume, or point the controller's outbound requests+tokens somewhere
unintended). Rules for the v1 endpoint:

- Announce creates/refreshes a **pending-node record**, separate from
  active peers. Activation requires the controller to *verify* the claim:
  probe the announced URL's `GET /api/peer/hello` using the supplied wire
  token; only a passing probe promotes the record.
- **No overwrite by announce**: a name colliding with an existing active
  peer refreshes only if the URL+identity match; otherwise the announce
  parks as a conflict for the operator. Names are claims, not capture.
- Rate-limit the endpoint; expire pending records on TTL; expire active
  announced peers that stop answering hello (heartbeat is just the
  existing hello poll).
- Shared registration token is a **single-operator bootstrap** posture,
  stated as such: rotation revokes all announcers at once. Per-node
  minted tokens remain the multi-tenant upgrade path.
- Operator visibility: announced/pending/conflicted nodes appear in the
  peers UI distinctly — silent auto-add is exactly the poisoning surface.

**Announce v2 — reverse connection** (deferred, but this is the endgame for
outbound-only nodes): the node opens a persistent outbound
WebSocket/SSE channel to the controller and the peer wire is multiplexed
back over it — no inbound route to the node at all. This is the only model
that covers "k8s pod with no Service" and NAT'd home boxes, and it would
also retire the artisanal launchd-tunnel + ingress rig in `deploy/`. Real
protocol work; do not start here.

## Per-target recipes (thin by design)

Written recipes live in `docs/recipes/` — **aws-fargate.md** (task def +
SSM port-forward tunnel + Bedrock variant), **aws-ec2.md** (ssh flavor via
`clodexctl deploy` / SSM flavor for port-22-closed shops), **kubernetes.md**
(StatefulSet + `kubectl port-forward` tunnel, no Ingress by posture). Each
is copy-paste against the operator's own cloud CLI; Clodex ships zero cloud
SDKs. The remaining sketches below await demand:

Each is a template plus a short README section, not code:

- **Docker compose (remote box, no SSH-deploy)**: image + env + three
  volumes + healthcheck. Replaces the "clone and build on the box" model of
  `clodex-deploy.sh` for any box that has Docker — no git/node/sudo
  needed on the target anymore.
- **Fargate**: task definition JSON — image from GHCR, env from the
  contract table, tokens from Secrets Manager via `secrets:`, EFS volume
  for `/data` + auth dirs (or explicitly ephemeral), public IP or
  private+VPN, security group admitting the controller (or nothing
  inbound once v2 exists), healthCheck on `/api/peer/hello`. Announce does
  discovery — no ECS API calls from Clodex, which is the answer to "can
  Clodex control agents in Fargate": run this task def, the node appears
  in the sidebar.
- **k8s**: Deployment(replicas=1) + PVC + Secret + Service/Ingress +
  livenessProbe on hello. Same contract, manifest syntax.
- **SSH/systemd (existing)**: keep as the recipe for bare boxes without
  Docker; it becomes one recipe among peers rather than *the* deploy story.

## Build order (when building is authorized)

1. **Contract doc + image hardening** — env table official; pin CLI
   versions; declare volumes; HEALTHCHECK. No new mechanisms; makes the
   image usable by hand on any target immediately.
2. **Announce v1** — `POST /api/peer/announce` + boot-time dial-home +
   auto-add to peers. The one new engine mechanism; small, and it unlocks
   every launcher-agnostic story at once.
3. **Recipes** — compose, Fargate task def, k8s manifest, each validated by
   actually launching one (k8s and compose are locally testable; Fargate
   needs an AWS account pass).
4. **Codex headless auth** — investigate (a) above; land whichever of
   (a)/(b) is real.
5. **Reverse-connection v2** — only when an outbound-only use case is
   actually in hand.

## Open questions for Bogdan

1. **Ephemeral vs durable nodes**: is a Fargate node that loses its
   sessions on task restart acceptable as a stated mode (cattle), or is
   EFS/PVC-backed `/data` (pets) the only honest offering? Affects how
   hard recipes push persistent volumes.
2. **Announce trust posture**: single shared registration token per
   controller (simple, revocation = rotate) vs per-node pre-minted tokens
   (orchestrate-flavored, more machinery). Recommend starting shared.
3. **Controller reachability**: announce requires the *controller* to be
   reachable from the node (the inverse of today's problem). For a desktop
   Clodex behind NAT, that's the existing ingress/tunnel rig, or the
   controller runs headless on an already-reachable box. Is "your
   controller needs a URL" an acceptable prerequisite for cloud nodes?
4. Does the Fargate ask from your contact imply *they* run the controller
   too (their infra end-to-end), or their nodes reporting to *your/our*
   controller? Changes how much multi-tenant auth matters and how soon.
