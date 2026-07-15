# Sandbox peers — one-button Docker sandbox from the desktop app

Goal: a desktop user clicks one button and gets the web-frontend container
running as a local peer; New Session then offers "on this Mac" vs "in the
sandbox" placement. Agents placed in the sandbox are containerized (their
Bash tool, file writes, and network live inside Docker) while keeping full
Clodex features through the existing peering surface.

Status: spec ruled 2026-07-15. Decisions that were open are now closed:

- **ONE sandbox in v1.** Multi-sandbox = port allocation per instance
  (7820+ per queued arc) — deferred until someone needs it.
- **Sandbox sessions appear in the sidebar's peer section**, exactly like
  any other peer's sessions. No special-cased "sandbox" UI region; the
  sandbox IS a peer (id `sandbox`), just one the app manages the lifecycle
  of.
- **No SSH for local container peers** (Bogdan, 07-15): compose publishes
  the container's peer wire to loopback and the peer entry is a direct
  `http://127.0.0.1:<port>` url. No sshd in the image, no tunnel UI.
- **Loopback publish is the v1 trust boundary** for all three ports (web,
  wirescope, peer wire) — same stance as docker/web/compose.yaml documents.

## Ground truth (explorer-verified, do not re-derive)

- The container side is DONE: docker/web/{Dockerfile,compose.yaml} already
  runs engine + web frontend + wirescope + peer wire. `CLODEX_REMOTE_ENABLE=1`
  + `CLODEX_REMOTE_HOST=0.0.0.0` bring the peer wire up at first boot
  (remote-wiring.js:60); `hostname: sandbox` pins SELF_LABEL (DM routing
  breaks without a stable hostname — learned live, 34dbe31).
- Create-on-peer EXISTS end-to-end: caps `create` remote.js:374,
  `POST /api/sessions {name,type,cwd}` remote.js:534, owner side
  remote-wiring.js:145 (manager.create with nulls for rich params),
  `peerCreateSession` ipc-handlers.js:872 + api-contract.js:146, peers-ui
  dialog gated on peerCanCreate.
- New Session funnels through ONE call site: `doCreate` renderer.js:1123.
- Peer entries are `{id,label,url|sshHost,remotePort,deployFolder,disabled,
  relayAllowed}` — no token field; added via plain `setSettings({peers})`.
- NO docker shell-out exists anywhere in app code yet; NO credential env
  path exists (CLAUDE_CODE_OAUTH_TOKEN appears nowhere).
- `claude setup-token` (host CLI, needs subscription) mints a long-lived
  OAuth token accepted via the CLAUDE_CODE_OAUTH_TOKEN env var — the auth
  answer for "same Claude auth as the host".

## Milestones

Each is a separate review+commit. Hand implements, clodex reviews/commits.

### M0 — publish the image to GHCR (operator/clodex task, not hand's)

DMG users have no repo checkout to `docker compose build` from. Publish
multi-arch (arm64 + amd64) to `ghcr.io/avirtual/clodex:<version>` via
`docker buildx`. Deliverable: `scripts/publish-image.sh <version>`
(preflights: gh authed, buildx present; builds from docker/web/Dockerfile
with repo-root context; pushes version tag + `latest`). Runs on the mac,
credentials via `gh auth token | docker login ghcr.io`. NOT in release.sh
v1 — run manually after a release until it proves stable.

### M1 — sandbox.js lifecycle module

New root module (electron-free, deps-injected like session-manager; ADD to
free-identifier-leak SCANNED_MODULES). Owns:

- **Detection**: `docker info` (spawn, timeout) → {present, running}.
  Distinguish "not installed" from "daemon not running" — the dialog copy
  differs (install Docker Desktop vs start it).
- **Config** (persisted in ui-settings under `sandbox`): workDir (host
  folder to bind-mount at /home/clodex/work; null = named volume),
  webPort/wirescopePort/wirePort (defaults 7810/7811/7820, collision-bumped
  at generation time by probing listeners), autoStart (bool), image
  override (null = default resolution).
- **Image resolution**: packaged app → `ghcr.io/avirtual/clodex:<appVersion>`;
  dev (`!isPackaged`) → `build:` from the repo checkout (compose build
  context, exactly today's docker/web/compose.yaml). This keeps the dev
  loop free of GHCR.
- **Compose generation**: write `<userData>/sandbox/compose.yaml` from the
  config. Content mirrors docker/web/compose.yaml (hostname sandbox, three
  loopback publishes, named vols data/dot/claude-auth, init, restart:always,
  healthcheck) with ports/volumes/image swapped in. Regenerated on every
  Start (config is authoritative, the file is derived output). The auth
  env_file line (M3) references a SEPARATE file, secrets never in compose
  bytes.
- **Lifecycle**: `up()` (compose up -d), `down()`, `status()` (compose ps
  --format json → running/exited/absent), `logsTail(n)`. All spawn-based,
  async, surfacing stderr on failure (peers-ui deploy toasts are the
  model).
- **Peer registration**: on first successful up, add peer
  `{id:'sandbox', label:'sandbox', url:'http://127.0.0.1:<wirePort>'}` via
  the settings write path (peer-wiring reconciles; 78f65bd guarantees the
  offline row shows immediately). Idempotent — update url if the port
  moved, never duplicate. Down does NOT remove the peer (it just goes
  offline; the row is the affordance to start it again later).

Tests: pure parts (compose generation bytes given a config, port bump
logic, image resolution) — spawn/docker mocked.

### M2 — setup dialog + menu entry

"Sandbox…" entry (File menu + a button in the Peers setup dialog). Dialog
shows: docker detection state, sandbox status (running/stopped/never
created), Start/Stop button, work-folder picker (native on desktop;
text field on web), port fields (prefilled, editable while stopped),
auto-start-with-app checkbox (honored in main.js whenReady after peer
wiring), Open-in-browser link (http://localhost:<webPort>) when running.
Status polls while the dialog is open (compose ps every 3s), not globally
— the peer row's online/offline dot is the global indicator.

### M3 — New Session placement selector

A "Run in" selector (Host / Sandbox) at the top of the New Session dialog,
shown only when the sandbox peer exists. Sandbox placement branches
`doCreate` (renderer.js:1123) to `peerCreateSession('sandbox', name, type,
cwd)`. The rich fields (skills/prompts/tools/proxy/intents) do NOT cross
the create-on-peer wire yet — grey them with a "not yet available in
sandbox sessions" hint when Sandbox is selected. cwd defaults to
/home/clodex/work for sandbox placement. (M5 extends the wire op with the
full param set and un-greys.)

### M4 — auth seeding (same Claude auth as host)

Paste field in the Sandbox dialog: "Claude auth token" with a hint to run
`claude setup-token` in a terminal. Stored at
`<userData>/sandbox/auth.env` (mode 0600, `CLAUDE_CODE_OAUTH_TOKEN=…`),
referenced from the generated compose via `env_file`. NEVER written into
compose.yaml bytes or logged. Clearing the field deletes the file.
Fallback documented in the dialog: leave empty and log in interactively
inside a sandbox bash session (`claude login` — works today, persists in
the claude-auth volume).

### M5 — full-param wire create (ACTIVE, spec ruled 2026-07-16)

Goal: a sandbox-placed New Session is configured exactly like a host one —
skills/prompts/tools/intents/proxy/extraArgs — instead of the M3 bare
name/type/cwd. The wire op stays GENERIC (any peer with the cap), the
sandbox is just its first consumer.

**Ground truth (verified 07-16, do not re-derive):**

- `manager.create()` takes the full 18-param set (session-manager.js:610);
  the wire create (remote-wiring.js:163) currently nulls everything past
  cwd. `POST /api/sessions` body is `{name,type,cwd}` (remote.js:597).
- The wire EDIT path already solved most of M5's problems:
  `setSessionArgs` carries {extraArgs, proxy, systemPrompt, agents,
  denyBuiltins, disabledTools, disabledSkills, injectSkills,
  systemPromptFile, appendPromptFiles} with `withoutExecGrants` as the
  server-side backstop (exec grants are LOCAL-ONLY, settled), and
  `getSessionArgs` returns the BOX's catalogs so the viewer's checklists
  render box-truth, never its own libraries.
- intents + execCommands are spawn-frozen (they materialize into the IPC
  prompt / grant set at create; edit can't add them later) — so create is
  the only wire op where intents can ever cross.
- Capability mechanism exists: hello `caps` array ('create' covers
  create/kill/restart; 'args' covers the edit pairs).

**Decided:**

1. **Param shape**: `POST /api/sessions` body grows the setArgs patch keys
   VERBATIM (same names, same semantics) plus create-only fields:
   `{name, type, cwd, extraArgs, resumeId, fork, proxy, agents,
   denyBuiltins, disabledTools, disabledSkills, injectSkills, stripLevel,
   systemPromptFile, appendPromptFiles, intents}`. All optional — the old
   M3 body stays valid, so the HTTP change is purely additive.
   systemPromptBody stays null (F2: legacy inline body never authored at
   create). Owner side maps onto the existing `manager.create()` params.
2. **Exec grants NEVER cross** — `withoutExecGrants` applied inbound,
   renderer never sends them (mirror of the edit path, belt-and-
   suspenders). Known consequence: sandbox sessions can't receive exec
   grants over the wire at all (the headless box has no local dialog);
   acceptable for v1 — exec-in-container is contained anyway, revisit only
   on operator ask.
3. **Vetting taxonomy** (server side, remote-wiring createSession):
   restrictive fields (denyBuiltins/disabledTools/disabledSkills/intents)
   pass through — they only shrink capability. Referential fields
   (agents/injectSkills/systemPromptFile/appendPromptFiles) resolve against
   the BOX's libraries; unknown names ride a non-fatal `warnings[]` in the
   ack (35be4c4-style warn-don't-block), never a hard fail. NOTE (hand,
   07-16): the wire ack currently DROPS create()'s warnings — createSession
   returns only {name,type,pid}. M5 must forward `out.warnings` in the ack
   and surface them client-side through doCreate's existing toast path;
   that plumbing is part of this milestone, not pre-existing. extraArgs/
   proxy pass through (precedent: the edit wire already carries both;
   trust is the tunnel).
4. **Cap, not version bump**: hello caps gains `create2` when the box
   accepts the full body. The viewer un-greys the M3 fields only when the
   placement peer advertises `create2`; older peers keep the greyed M3
   behavior. No protocol version change needed — additive body + cap gate.
5. **Catalog truth**: when placement=Sandbox the dialog's checklists must
   render the SANDBOX's catalogs (box-truth rule, same as the Edit dialog).
   New `GET /api/catalogs` (rides the 'create' cap): a SUPERSET of
   getSessionArgs' catalogs block — that block has NO skills key (the edit
   dialog's skill checklist rides the separate session-scoped
   getSkillCatalog, which needs a roster; pre-create there is none). Shape:
   `{agents, prompts, skills: skillLib.list(), claudeTools, proxyUrl,
   proxyEnabled}`. Dialog fetches on placement flip to Sandbox, re-renders
   checklists from it; flipping back restores host catalogs. New renderer
   IPC channel (peerCatalogs) → api-contract pin 177→178.
6. **stripLevel** (hand-verified 07-16): NOT a manager.create() param —
   locally it's seeded post-create in ipc-handlers.js:94-95
   (persistence.setStripLevel, with an agentDefaults.getStrip fallback);
   the engine path has no create-time seeding (it only re-asserts a
   persisted level on restart/apply). Wire createSession replicates the
   post-create seed (~2 lines, persistence is in engine scope) honoring the
   EXPLICIT wire stripLevel only — no agentDefaults fallback; the client
   is authoritative for a wire create, the box's local defaults must not
   leak in.
7. **Empty-library fix — ro library sub-mounts** (hand-scoped 07-16,
   Bogdan-ruled 07-16: broad mount, skills+agents+library/): all four
   libraries are shared
   `~/.clodex` subdirs, LIVE-read (stores.js keeps no in-memory Map; every
   accessor re-reads disk): skills=`skills/*.md`, agents=`agents/*.md`,
   prompts=`library/prompts/{system,append}/*.md`, exec=
   `library/exec/*.json`. So read-only bind sub-mounts give box catalogs ==
   host catalogs AND host edits propagate mid-run — strictly better than
   copy-at-Start. TRAP: the container's whole `/home/clodex/.clodex` is the
   named volume `clodex-dot` (sandbox.js:142) which the box WRITES (run/,
   messages/, pending/, registry) — do NOT replace it; layer ro binds ON
   TOP for the library dirs only. Scope: **skills + agents + library/**
   (library/ covers prompts; exec/ rides along but is dead weight —
   exec grants never cross per Decision 2, so its presence is harmless;
   omit-exec would mean two narrower prompt binds instead). This makes
   Decision 3's referential warnings a rare path (names always resolve),
   but the plumbing stays — required for the unknown-name case.

Un-grey plan: `richFieldsGreyed(placement)` (pure leaf, placement.js) gains
a `hasCreate2` boolean param — cap lookup stays in renderer.js
(`peerStatuses.get(id).caps.includes('create2')`, exact precedent:
peerSupportsArgs/peerSupportsCreate) so the leaf stays dependency-free.
doCreate's sandbox branch collects the full cfg and posts the additive
body only when create2.

Sequencing (each its own review+commit):
1. sandbox.js ro library sub-mounts — independent of the wire work, lands
   first, de-risks the rest.
2. Server+wiring: full-body createSession (param mapping, withoutExecGrants,
   warnings-forwarding ack, stripLevel seed) + GET /api/catalogs.
3. peer-client/ipc: full body through peerCreateSession, `create2` cap,
   peerCatalogs channel (pin 177→178).
4. Renderer: cap-aware un-grey, catalog swap on placement flip, full-cfg
   post, warning toasts from the wire ack.

Protocol tests pin the additive-body compatibility: old client → new
server (bare body still works) and cap-gating (client never sends rich
fields to a non-create2 server — an old server drops unknown keys
silently, which would spawn an unconfigured session; the cap gate, not
graceful-ignore, is load-bearing).

## Non-goals (v1)

- Multi-sandbox instances; LAN-exposed sandbox (token story first);
  auto-publishing images from release.sh; migrating existing host sessions
  into the sandbox; Codex auth seeding (Claude first, Codex once asked).
