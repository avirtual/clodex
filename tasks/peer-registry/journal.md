# t32 — the record/registry axis (INVESTIGATE + PROPOSE, do not build)

Branch `t32-peer-registry`, off master `8ae1343`. **Do not commit on master**
(I did once this session; the commit was moved to `t30b-postmerge-notes`).
Do not push.

## The dispatch, as narrowed

From clodex (msg-93431-32 amendment, msg-93431-36 dispatch, msg-93431-38
carry-in):

- **SETTLED, not open**: Clodex *reuses* `cli/src/transport.js`; it does not
  grow its own SSM/kubectl/gcloud/az dialing. `openTransport`'s `localPort` IS
  the pinned port, `waitExit()` is the respawn trigger, supervision stays
  Clodex-side.
- **SETTLED**: `cli/` ships in the DMG (`"cli/**/*"` in `build.files`, README
  position updated, verified with `asar list` on a real artifact — the config
  is not the check).
- **SETTLED**: prefer importing the module over shelling out to a binary.
- **OPEN — the whole ticket**: the record/registry axis, (a)/(b)/(c) as filed,
  with `contexts.js:28-31` (the token file's chmod check) load-bearing.
  Reused dialing is inert if a peer record cannot persist `{ssm:{target,region}}`
  to dial with.
- **Disqualifier, explicit**: any shape that widens who can read a token.

## Blocking-ish gap: the filed (a)/(b)/(c) text is not in the repo

`tasks/peer-web-view/journal.md:702` references "(a)/(b)/(c) as filed" but the
t32 ticket itself was filed by clodex and is not on disk anywhere I can find
(`tasks/`, `.claude/memory.md`, the archives). Asked clodex to paste it rather
than invent three options and propose against labels that don't match his.
Continuing the code investigation meanwhile — the facts don't depend on the
labels.

## Facts established so far (reading only)

### The two registries, and what each can express

| | Clodex peers | clodexctl contexts |
|---|---|---|
| file | `ui-settings.json` (`peers[]`) in `app.getPath('userData')` | `~/.clodex/cli/contexts.json` |
| owner | GUI | CLI, "deliberately separate from the GUI's peers array" (contexts.js:2) |
| transports | `url` \| `sshHost` **only** (stores.js:234-237) | `url`\|`ssh`\|`tunnel`\|`ssm`\|`kubectl`\|`gcloud`\|`az` (contexts.js:55) |
| shape | flat scalars | cloud kinds are **typed objects**, validated per-kind (contexts.js:76-102) |
| token | `peers[].token`, presence-encoded, cap 256 (stores.js:265+) | `entry.token`, same file as the transport |
| mode | 0600 via `atomicWriteFileSync`'s `openSync(tmp,'w',0o600)` (fs-util.js:28) | 0600 on write **and chmod-checked + warned on read** (contexts.js:28-31) |

Both files already hold tokens at 0600. The asymmetry is on **read**: the CLI
warns when its token file is group/world-readable; `ui-settings.json` has no
such check. (`env-scopes` at stores.js:1646-1647 *does* chmod after rename,
so the codebase already has the stronger pattern in one place.)

### Why the Clodex side cannot express a cloud transport (finding (C), re-verified)

Three places, all by construction rather than validation-with-holes:

- `sanitizePeers` (stores.js:227) rebuilds each entry key by key; `url` must
  match `^https?://`, `sshHost` must match `^[a-zA-Z0-9._@-]{1,128}$`, and
  **`if (!url && !sshHost) continue;`** drops anything else entirely.
- `classifyPeerDest` (peer-deploy.js:253) returns exactly
  `ssh`/`url`/`empty`/`error` — a single text field, deliberately, because
  "a dropdown would tax the common ssh path".
- `resolvePeerUrls` (peer-wiring.js:164) branches `sshHost` → tunnel URL,
  else `p.url`.

## The options, verbatim (clodex, msg-93431-40)

  (a) Peers adopt the CLI's schema, one registry, one validator.
  (b) Peers stay separate but gain an import path from the contexts file.
  (c) Peers grow parallel kinds, two registries stay independent.

"Argue for one; state the costs of the others rather than dismissing them."

### Revised disqualifier (clodex accepted the correction)

Not the write mode — `ui-settings.json` is already 0600 via
`atomicWriteFileSync` (fs-util.js:28). The disqualifier is any shape that
**widens who can read a token** OR **drops the read-side warning where one
exists today** (`contexts.js:28-31`). The `env-scopes` post-rename chmod
(stores.js:1646-1647) folds into whichever shape wins.

## RULING — the DATA/CODE partition is authoritative for Clodex too

`cli/src/help.js:226`, verbatim:

> The typed cloud kinds (ssm/ssm-ecs/kubectl/gcloud-iap/az) are **DATA** — safe
> to `ctx import` or commit to a shared team file; a raw `--tunnel` argv is
> **code** and is never shared by import.

Enforced, not merely documented: `import.js`'s NEVER-TUNNEL INVARIANT header
plus `safeTransport()` (import.js:99) — a transport value must be a non-empty
**plain string**, so array/object shapes are refused rather than imported.

clodex ruled (msg-93431-43): peer records may express the five DATA kinds; a
`tunnel` argv must **never** become a peer-record field. "A GUI store that
persists an executable argv, syncable and editable through a dialog, is a
materially worse object than the same string in a CLI context file."

**So the ticket is five cloud kinds + the two we have, not seven.**

## Phase 2 findings

### What a record must hand `openTransport` — no adapter needed

`openTransport(ctx, {spawnFn, execFn, deadlineMs, localPort})`
(transport.js:252) reads exactly `url · remotePort · ssh · ssm{target|ecs,
region,profile} · kubectl · gcloud · az · tunnel`. A peer record is the
contexts entry shape minus `token`/`name`, if fields are named identically.

### The `ssm.ecs` async cost — COSTED, and it is real but confined

`resolveEcsTarget` (transport.js:118) is two sequential `aws` CLI calls
(`ecs list-tasks` → `ecs describe-tasks`) before an argv can even be built.
Today's `Tunnel._spawnTunnel` (peer-tunnel.js:96) is synchronous:
`pickFreePort(cb)` → `this._spawn(...)` → `_setState('up')`, with
`_scheduleRestart()` the only exit. Inserting an await means:

- a **new failure mode between "wanted" and "spawned"** — the aws call can hang
  or fail, and neither `up` nor `down` describes it;
- `stop()` (peer-tunnel.js:70) currently kills a child that is guaranteed to
  exist by then; with an await it must also cancel an in-flight resolve, or a
  stopped tunnel spawns one call later;
- every retry re-pays two aws round-trips, so the existing backoff is now
  backing off a *much* more expensive operation.

This is exactly the "cheap liveness signal" hazard from t30b in a new dress,
so it wants its own care. **Conclusion: `ssm.target` needs none of this** —
it is a pure argv build (`ssmArgv`, no await). `ssm.ecs` is the only kind that
forces the supervisor async. That is a strong argument for shipping
`ssm.target` first and `ssm.ecs` as a follow-up, and it is orthogonal to
(a)/(b)/(c).

### The UI cost — where the 92 actually live

92 `sshHost` occurrences in nine non-test app files. But they are NOT 92 places
that a new kind must touch. Breaking down the big two:

- `renderer/renderer.js` (27): ~20 are the **deploy/Test-&-Set-Up path**
  (`peerProbe`, `peerDeploy`, `deployLineHandlers` keyed BY sshHost,
  `peerDeployFix`) — ssh-specific by nature. You cannot `scp` an installer over
  an SSM port-forward, so a cloud-kind peer simply has no deploy wizard.
- `ipc-handlers.js` (16): same story — the probe/deploy IPC surface.

So the schema-touching sites are few (`sanitizePeers`, `resolvePeerUrls`,
`TunnelManager.sync`, the dest field) and the deploy path is a **separate
feature that cloud kinds don't get**. The honest cost of (a)/(c) is therefore
not "rewrite 92 sites" — it is "the peers dialog's ONE text field
(`classifyPeerDest`, designed so a dropdown wouldn't tax the common ssh path)
must grow a way to enter typed multi-field objects like
`az{bastion,resourceGroup,target}`, and the deploy wizard must degrade
honestly for kinds it cannot serve."

### `sanitizePeers` CAN host a typed object without losing its property

The property is drop-by-reconstruction: the entry is rebuilt key by key, so
unknown keys vanish. A typed kind preserves it by nesting the same discipline —
a per-kind rebuild (`{target, region, profile}`, each string-checked) rather
than passing an object through. `sanitizeBoxes` (stores.js:316) already does
exactly this ("Junk/extra keys are dropped by reconstruction (same stance as
sanitizePeers)"), so the precedent is in the same file. The CLI's
`validateEntry`/`validateSsm` are the field rules, and they are pure functions
in a module that now SHIPS — so the validator can be imported rather than
retyped.

`ctxAdd` (verbs.js:568) is the precedent for building typed kinds from flat
input: each kind is one flag family, spread into an object, then
`validateEntry`. A GUI form is the same construction from named inputs.

## RECOMMENDATION → (c), with the CLI's validator IMPORTED

**(c) peers grow parallel kinds, two registries stay independent — but the
"two validators" cost that normally sinks (c) is already paid off by the
settled reuse ruling.** `cli/` ships, so `validateEntry`/`validateSsm` are
importable pure functions. The result is **one validator, two registries** —
which is the merit (a) was reaching for, without (a)'s cost.

### Why (b) is not an alternative to the question

(b) presupposes an answer rather than giving one. An import path can only carry
what the destination can persist; if peer records still hold `url|sshHost`
only, importing a context's `ssm` entry drops it on the floor. So (b) is a
**population mechanism layered on top of (c)**, not a competitor to it — the
same relation the tunnel-plugin has to multi-transport peering (journal
`peer-web-view.md:607`). Worth building, second. Note the seam already exists
in the other direction: `import.js` reads `ui-settings.json` → contexts. (b) is
its mirror, and mirroring it is cheap.

### Why not (a), stated as cost rather than dismissal

(a) is genuinely more elegant and I want the reasons it loses to be concrete:

1. **The identity models don't match.** Peers are keyed by UUID `id` with a
   separate `label` (renderer.js:4648); contexts are keyed by **name** with a
   `current` pointer. `current` is meaningless in the GUI. Worse,
   `peerAttached` / `peerVisible` / `peerControlled` (stores.js:158-171) are
   all keyed by peer **id** — unifying the registry means migrating three more
   maps off the id they're keyed on, or keeping ids in a "unified" store that
   the CLI ignores.
2. **Ownership inverts.** `contexts.js:2` says the file is CLI-owned
   "deliberately separate from the GUI's peers array". (a) makes the GUI a
   writer of the CLI's token file — which does not widen *who can read* a
   token, so it clears the disqualifier, but it does mean a GUI settings-save
   bug can now corrupt the CLI's registry.
3. **It doesn't remove the UI problem, it just relocates it.** The typed-object
   entry surface has to be built either way; (a) adds a migration on top.

### What ships FIRST (clodex's scope steer)

Deliberately not "all five kinds and a redesigned dialog":

1. **`ssm.target` end-to-end.** Pure argv build, no async resolve, so the
   supervisor stays synchronous and untouched in its retry loop. Record gains a
   validated `ssm` object; `TunnelManager.sync` gains a second reason to build
   a tunnel; `resolvePeerUrls` is unchanged (it already asks the manager for a
   URL). Entry surface: the existing single dest field can accept an instance
   id shape, or one disclosure row — decide when building, not now.
2. **The remaining pure-argv kinds** (`kubectl`, `gcloud`, `az`) — same shape,
   each is an argv builder already written in `transport.js`. Marginal cost per
   kind after #1 is small.
3. **`ssm.ecs` last**, because it is the only one that forces
   `_spawnTunnel` async and therefore touches the loop keeping every peer
   connection alive (costed above).
4. **(b), the contexts→peers import**, once records can hold the kinds.

Deploy/Test-&-Set-Up stays ssh-only throughout and must **say so** for a cloud
kind rather than offering a wizard it cannot run — same ruling as t30b's
ssh-only limitation being stated in the UI, for the same reason.

## RULINGS (msg-93431-45) — (c) accepted, build step 1 only

- Recommendation **(c) accepted**. Ship order approved as written: `ssm.target`
  end-to-end FIRST, then kubectl/gcloud/az, `ssm.ecs` last, (b) import after.
  **Do not run ahead into the other kinds in this pass** — clodex wants the
  first kind reviewed end-to-end before three more ride on its shape.
- **Own worktree**: `/Users/bogdan/projects/tmux/wb-wrap-ui-hand`, branch
  `t32-peer-registry`, `node_modules` symlinked to the main tree. Separate HEAD;
  the shared-HEAD collision class is gone. clodex keeps the main tree on master.
  Git refuses to check out a branch live in another worktree — read master with
  `git show master:path`.
- Master merged: `7ab039a` (brings the v4.2.0 release commit `09348ff`).
- **CORRECTION from clodex**: `contexts.js:148-150` exports only
  `cliDir, contextsPath, load, save, validateEntry, resolve`. **`validateSsm`,
  `validateAz`, `validateObjKind` are PRIVATE.** Prefer entering through
  `validateEntry`; widening `cli/`'s public surface to serve a second consumer
  "is how a leaf stops being a leaf". If a per-kind export is unavoidable, say
  so and why — it is a boundary decision.
- **Highest-risk detail, from clodex's own verification**: `sanitizeSandbox`
  (stores.js:319-321) carries the warning I under-quoted — "this store is a
  **WHITELIST** — any key NOT reconstructed here is silently dropped on every
  write", with `mounts` named as a sub-key that shipped without its line and
  vanished on every round-trip. **Every cloud-kind field must appear in the
  reconstruction or it silently will not persist.**

### `validateEntry` DOES serve as the entry point — no export widening needed

`validateEntry({ ssm: {...} })` validates the ssm arm via the private
`validateSsm` and enforces the one-transport rule. A peer record's transport
block can be handed to it as a synthetic single-kind entry. No `cli/` export
change. (Confirmed by reading contexts.js:56-72; to be pinned by a test.)

### PREREQUISITE discovered — `cli/` is NOT actually in `build.files` yet

`package.json` `build.files` today: `*.js`, two `scripts/` files, `wire/**/*`,
`renderer/**/*`, `plugins/**/*`, `resources/**/*`, two tray icons,
`node_modules/**/*`. **No `cli/`.** And `cli/README.md:61-62` still asserts the
old position ("The desktop app's packaged DMG does **not** include `cli/`").

clodex ruled both settled in the t32 amendment, but neither was ever
implemented. Step 1 imports `cli/src/transport.js` into the main process, so
without the packaging change step 1 is **green in dev and MODULE_NOT_FOUND in
the shipped DMG** — finding (B) exactly. Therefore the `build.files` line and
the README correction are IN step 1's necessary scope, not separate work.
Verification is `npx asar list` on a real built artifact, not the config.

## Step 1 plan — `ssm.target` end-to-end

1. **`package.json`**: add `"cli/**/*"` to `build.files`. **`cli/README.md`**:
   replace the stale assertion with the new position + why.
2. **`stores.js` `sanitizePeers`**: new `sanitizePeerSsm(raw)` — per-kind
   rebuild (`target` required non-empty string; `region`/`profile` optional
   strings), returning null otherwise. `ssm.ecs` NOT accepted in this pass
   (step 3). Admission test becomes `if (!url && !sshHost && !ssm) continue;`.
   Every field in the reconstruction (the whitelist warning).
3. **`peer-tunnel.js`**: `Tunnel` gains an ssm arm — argv from `ssmArgv` +
   `substitutePort`, imported from `cli/src/transport.js`; ssh path unchanged.
   `_spawnTunnel` STAYS SYNCHRONOUS (ssm.target needs no await).
   `TunnelManager.sync` builds a tunnel for an ssm peer and restarts on change.
4. **`peer-wiring.js` `resolvePeerUrls`**: the tunneled branch keys off "has a
   managed tunnel", not `sshHost` specifically.
5. **Renderer**: dest entry for an ssm target + the deploy wizard degrading
   honestly (ssh-only, SAID not hidden — the t30b rule).
6. Tests, each proven by reverting and failing BY MESSAGE.

## Step 0 LANDED (master `475d799`) — packaging + a latent harness race

Two commits, merged by clodex ahead of ssm.target because the race was latent
**on master**: `5c9f387` (packaging) and `c89342e` (harness fix).

- **Packaging**: `"cli/**/*"` in `build.files`; `cli/README.md` states the new
  position AND why. Verified on a REAL artifact, not the config: the shipped
  v4.2.0 DMG had `grep -c '^/cli/'` = **0** (only `/cli-hooks.js`, the
  trailing-slash false positive); a build from this worktree gives **64**,
  including `src/transport.js` + `src/contexts.js`.
- `test/cli-packaging.test.js` (2): pins the glob, and pins the README against
  silent reversion. Header says plainly the test is NOT the real check.

### NAMED TRIGGER — the harness can manufacture the condition the fix depends on

`web-tunnel.test.js`'s `failUntilGaveUp` kills each child from a polling loop,
so **the child's apparent lifetime IS the poll latency**. The supervisor retires
its give-up clock when a spawn survives `_stableMs = floor(giveUpMs/2)`; at
`giveUpMs` 40-50 that was 20-25ms against a 25ms poll — zero margin. A slipped
timer made the child read as "genuinely worked", the clock retired, the cap
could never fire, and the loop spun to its 6s timeout.

In clodex's words, which is the durable framing:

> In t30b the **product** retired its cap on a signal that proved nothing; here
> the **harness** handed the product a signal that looked like survival but was
> scheduler latency. **Fixing a cheap-liveness bug in the code while leaving the
> harness able to manufacture the exact condition the fix now depends on** —
> that generalizes well past this file.

Two method notes worth keeping:

- **It passed 5/5 alone, which is exactly why it slipped through** in t30b. A
  flake that clears a short local loop is the hardest to catch and the easiest
  to rationalize as environment.
- **The clean deterministic reproduction (poll 30ms > stable 25ms) PASSED.**
  Rather than tell a tidy threshold story, measured a rate: **2/25 failures
  before, 0/25 after**. A probabilistic race described as probabilistic — most
  ways to be wrong here involve a confident mechanism that is false.

Contract now written at the helper: `POLL_MS << _stableMs == floor(giveUpMs/2)`,
call sites at `giveUpMs >= 400`, plus the note that shrinking `giveUpMs` buys no
speed because the cap is reached via `BACKOFF_MIN_MS` (1s), not the deadline.

### Why the whole prefix was mergeable early

`git diff master..branch` was packaging config, README, journal and tests —
**zero product code**. clodex: "that's what made the whole prefix mergeable
without touching your in-flight ssm work. Keep that separation." Worth holding
to for the rest of t32.

## Step 1 IN PROGRESS — `ssm.target` end-to-end

### Done (product code, uncommitted)

- **`stores.js`**: `sanitizePeerSsm(raw)` — per-kind rebuild (`target` required
  non-empty string, cap 256; `region`/`profile` optional, OMITTED not null so
  `ssmArgv`'s presence test works). `ecs` present → returns null WHOLE (step 3).
  Final say goes to `validateEntry({ ssm })` — the CLI's PUBLIC door; the
  private `validateSsm` is never touched, so a future export-widening is not
  something this code invites. Admission is now
  `if (!url && !sshHost && !ssm) continue;` and the entry carries
  `...(ssm ? { ssm } : {})` (presence-encoded, like disabled/relayAllowed).
  Label fallback gained `|| ssm.target` for a peer with neither url nor host.
- **`peer-tunnel.js`**: `Tunnel` takes `ssm`; new `argv(localPort)` returns the
  FULL argv incl. command word — `substitutePort(ssmArgv(...))` for ssm, the
  original `['ssh', ...this.args(port)]` otherwise. `args()` kept verbatim so the
  ssh shape and its tests are untouched. `_spawnTunnel` STAYS SYNCHRONOUS.
  ssm children spawn `detached: true` and are killed by process GROUP
  (`_killChild`, `pid > 0` guard) — aws forks a session-manager-plugin helper a
  plain kill orphans; ssh keeps its original non-detached spawn exactly.
  ENOENT now names the binary. `TunnelManager.sync` admits ssm peers and
  restarts on ANY destination change via `sameSsm` (region/profile count —
  a different region is a different box).
- **`peer-wiring.js` `resolvePeerUrls`**: branch is `p.sshHost || p.ssm` with a
  comment saying WHY (both land on a TunnelManager-owned local port; testing
  sshHost would have left cloud peers with `url: undefined`).

### Next (this pass)

4. Renderer entry surface + honest degradation. **Open question to settle by
   reading, not guessing**: `peer-deploy.js` (scp's an installer) and
   `web-tunnel.js` (the t30b peer web view) are both genuinely ssh-only — you
   cannot scp over an SSM port-forward. Those must SAY ssh-only for an ssm peer,
   not silently hide the affordance (the t30b rule).
5. Tests: stores round-trip through `set()`/`get()` (the WHITELIST pin), the
   `validateEntry`-is-the-only-door pin, tunnel argv + group-kill, sync restart
   on region change, `resolvePeerUrls` for an ssm peer. Each proven by reverting
   and failing BY MESSAGE.

### Phase 2 done — renderer surface + honest degradation (still uncommitted)

- **`peer-deploy.js` `classifyPeerDest`**: new `{ kind: 'ssm', ssm: { target } }`
  on an `ssm:TARGET` prefix. A PREFIX, not a sniff — a bare `i-0abc…` is
  indistinguishable from an ssh alias and guessing would dial the wrong
  mechanism silently. A `/` in the target (an ECS CLUSTER/FAMILY spec) is a
  targeted ERROR naming the CLI as the thing that does support it, rather than
  accepting a destination that could never dial (step 3).
- **`renderer.js`**: dest pre-fill `ssm:<target>`; placeholder names the third
  form; badge says `→ AWS SSM tunnel (needs the aws CLI locally)` — naming the
  vendor CLI because "you need aws on YOUR machine" is the misconfig this
  invites. `collectPeers` saves `peer.ssm`. **region/profile are stashed on the
  row (`row._ssmExtra`) and carried back on save** — without that, opening the
  dialog and pressing Save would erase a hand-configured region: the same
  silent-loss class as the store's whitelist hazard, one layer up.
- **Test & Set Up** for an ssm dest: SAYS ssh-only and WHY (install runs a shell
  and copies files over ssh; a port-forward carries neither), names what the
  operator must do instead, and still validates the port so a bad one is caught
  here rather than at Save.
- **`renderer/lib/peer-web-view.js`**: the ssh-only tip now distinguishes
  `an AWS SSM tunnel` from `URL`. Same answer (no button), different TRUE
  reason — telling an ssm operator their box "is reached by URL" would send
  them looking for a URL that does not exist. `isSshPeer` deliberately still
  tests `sshHost`, not "has a tunnel": an ssm peer HAS a wire tunnel but the web
  view needs a SECOND forward and only the ssh template can open one.

### FLAGGED, deliberately NOT changed — the header-menu "Update Clodex on …" item

`deployTargetFor` (ipc-handlers.js:1748) returns null without an `sshHost`, so
the menu item is HIDDEN for an ssm peer — and has always been hidden for a
url peer. That is a hide, not a say, so it sits against the t30b rule. I did not
change it: making it visible-but-disabled changes behaviour for URL peers too,
which is a pre-t32 settled surface and clodex's call, not mine. Raised in the
report instead.

## Step 1 LANDED (master `129fe94`) + a NAMED TRIGGER

`ff7eb30` (product + web bundle) and `3e2f958` (tests + journal), merged by
clodex at 2667/2667, ESCAPES: 0.

### NAMED TRIGGER — a rebuilt record silently drops what it doesn't name

Twice in one ticket, same shape at two different layers:

1. **The store.** `sanitizePeers`/`sanitizeSandbox` reconstruct field by field,
   so a sub-key with no line is dropped on EVERY write. `mounts` shipped that
   way and vanished on every round-trip.
2. **The dialog.** `region`/`profile` are settings-file-only overrides with no
   input of their own — so opening the Peers dialog and pressing Save would have
   rebuilt the peer from the inputs it *has* and erased them. The store's own
   tests cannot see this; it happens one layer up.

In general form, which is the durable part:

> **Any layer that rebuilds a record from named fields will silently drop what it
> doesn't name — and dialogs do this as surely as stores.**

So for every NEW field in steps 2-3: check the dialog round-trip as a matter of
course, not as a discovery. A field with no input of its own is the dangerous
case, because nothing on screen hints that it is being carried.

### Test-shape note — `settleOr` vs `waitFor` (clodex's ruling, applied)

The `sameSsm`-ignores-region case originally surfaced as a `waitFor` TIMEOUT:
honest, but it fails the same way a genuinely hung test does and says nothing
about what was expected. Replaced with `settleOr` (bounded wait that never
rejects) + a direct `assert.equal(calls.length, 2, …)`. clodex: *"Match the
file's existing shape where that shape is good, not where it's merely
established."* `waitFor` stays correct for reaching a mere PRECONDITION, where a
timeout genuinely is the story.

### Deferred by clodex, not by me — `deployTargetFor`

The header-menu "Update Clodex on …" item stays hidden for ssm AND url peers.
Put to Bogdan; clodex's leaning is *show it disabled with a reason for both
kinds*. Do not fix it inside step 2.

## Step 2 plan — kubectl / gcloud / az

Expected to be the cheap step: all three are pure argv builds with no async, the
same shape `ssm.target` proved. **If any one of them needs something
`ssm.target` did not, STOP and tell clodex before absorbing it.**

Per kind, the same five seams: `sanitizePeerKind` in stores.js (every field a
line) · a `Tunnel` arm via the CLI's builder · `TunnelManager.sync` +
destination equality · `classifyPeerDest` prefix · dialog round-trip incl.
fields with no input. Field lists come from cli/src/transport.js:
`kubectlArgv({ target, namespace, context })`, `gcloudArgv({ instance, zone,
project })`, `azArgv({ bastion, resourceGroup, target })` — az needs all three.

## Step 2 IN PROGRESS — kubectl + gcloud generalized; az BLOCKED on the UI

### Main-process layers done (uncommitted)

Generalized rather than triplicated, per clodex: **two tables, one row per kind.**

- **`stores.js`**: `PEER_CLOUD_KINDS` — `{ required, optional, reject }` per kind.
  `sanitizePeerCloud(kind, raw)` rebuilds from the TABLE, so the whitelist is a
  DECLARATION, not a hand-written reconstruction per kind. That is the direct
  answer to the named trigger: adding a field is one row, and there is no second
  site to forget. `sanitizePeers` admits **at most one** cloud block — two would
  leave every downstream reader picking a winner independently, which is how two
  halves of the app dial different boxes.
- **`peer-tunnel.js`**: `CLOUD_KINDS` — `{ argv, fields }` per kind. `Tunnel`
  takes the block under its own kind key (the peer record's shape, so a settings
  entry can be handed in with no translation to get wrong) and normalizes to
  `this.cloud = { kind, block }`. `sameCloud` compares kind + every field off
  the table. `_detached()` is now `!!this.cloud` — kubectl and gcloud fork
  helpers exactly as aws does. `_spawnTunnel` STILL SYNCHRONOUS.
- **`peer-wiring.js`**: new exported `hasCloudTransport(peer)` — asked of the
  module that owns the kind list, so there is no `p.ssm || p.kubectl || …` chain
  to forget a kind in. Note it deliberately does NOT ask the manager "do you have
  a tunnel for this id": the manager answers null while a tunnel is merely DOWN,
  which is exactly when the placeholder URL must keep the peer alive.

### BLOCKED — az does not fit the single destination field

kubectl and gcloud are `ssm.target`'s shape exactly (one identifying field +
two optional selectors). **az is not**: `azArgv({ bastion, resourceGroup,
target })` needs THREE required values, and its `target` is a full Azure
resource id — `/subscriptions/…/resourceGroups/…/providers/…/virtualMachines/x`
— which is slash-bearing and long.

The peers dialog has ONE smart destination input. Three required values cannot
be typed into it without inventing a composite syntax
(`az:BASTION/GROUP/TARGET`), and the target's own slashes make that ambiguous to
parse. Options, none of which is a hand's call:

  (a) three extra inputs on the peer row, shown only for an az destination;
  (b) a composite syntax with a non-slash separator;
  (c) az via `ctx import` from the CLI's contexts file only — i.e. step 4's
      import path, not a typed destination at all.

Store + tunnel + wiring would take az with one row each. **Only the entry
surface blocks.** Stopped and asked rather than inventing a syntax the operator
would have to learn from source.

### Ruling taken — (c) az by import, WITH clodex's refinement

az rows ARE in both tables (store + tunnel), tested, but **unreachable by typing**:
`classifyPeerDest` has no az prefix. Stated in the commit, not left to be
discovered. Step 4's import then needs no second pass through the store.

**(a) three revealed inputs stays the FUTURE answer, not a rejected one** — if
anyone ever wants to type az destinations, that is the shape. **(b) a composite
string is dead**: syntax the operator can only learn from source. Recorded so
neither is re-litigated from scratch.

### Renderer, generalized (uncommitted)

- **`PEER_CLOUD_UI`** in renderer.js — `{ name, cli, field, prefix }` per kind,
  the UI mirror of the two main-process tables. Drives the badge, the ssh-only
  copy and the dest pre-fill, so a kind is one row here too. Badge names the
  VENDOR CLI (`needs the kubectl CLI locally`) because that is the misconfig a
  cloud destination invites.
- **Prefixes**: `k8s:svc/name` (kubectl's own spelling verbatim — a slash is
  EXPECTED here, unlike ssm's, where it means ECS), `gcp:INSTANCE` (bare name;
  gcloud takes zone/project as separate flags).
- **`row._cloudExtra`** replaces `_ssmExtra`, carrying every field with no input
  of its own — and only when the KIND is unchanged, or retyping a destination as
  a different cloud would graft the old kind's selectors onto the new block.

### The az round-trip trap — found by applying the named trigger, not by luck

An az peer's dest input is BLANK (nothing can render it), so `classifyPeerDest`
returns `empty` and `collectPeers` would have **skipped the row entirely**:
opening the Peers dialog and pressing Save would have silently deleted every
imported az peer. Blank-because-unshowable is not blank-because-deleted.

Fixed by rewriting such a row as an `unshowable` dest that flows through the ONE
save path (port, folder, token handling included) rather than duplicating it —
a second path would be a second place for the token logic to drift.

This is exactly the trigger clodex named, third instance: a layer rebuilding a
record from named fields drops what it can't name. Worth noting that the FIX for
"az isn't typable" is what created it.

## Step 4 — contexts→peers import. POSITIONS SETTLED BEFORE BUILDING

clodex asked for two decisions argued rather than defaulted. Both below, with
the facts they rest on re-read this pass (not carried from memory).

### Q1 — import is a COPY. No link, and no provenance field either.

**Decision: an imported peer keeps NO relationship to its context entry.** Not
a `fromContext` name, not a back-reference, nothing. Reasons, strongest first:

1. **A stored context name is a pointer that can go stale and lie.**
   `ctx rm prod && ctx add prod --url …` leaves a peer claiming a lineage that
   now points at a different box. A copy claims nothing, so it cannot be wrong.
2. **Any link field would have to mean something behaviourally, and every
   meaning is bad.** *Re-sync on change*: nothing watches contexts.json, and if
   it did, the GUI would be writing on the CLI's schedule — inverting the
   ownership `contexts.js:2` states ("CLI-owned, deliberately separate from the
   GUI's peers array"). *Don't re-import this one*: that is dedupe, and dedupe
   belongs on the DESTINATION (below), which stays true after the operator
   renames the peer. *Provenance only*: a field with no behaviour that still
   costs a whitelist line in `sanitizePeers` AND a dialog carry-back
   (`_cloudExtra`-style) — the named trigger's price, paid for a tooltip.
3. **The mirror already works this way.** `import.js` (peers→contexts) writes
   url/ssh + token and no back-reference to the peer id. Symmetry is free and
   that shape has already been reviewed.

Consequences, stated rather than implied:

- **A later context edit does NOT reach the imported peer.** The import UI must
  say this — a one-time copy that looks like a subscription is the surprise.
- **Re-import is a collision, resolved by DESTINATION, not by name.** A
  candidate is "already present" when an existing peer has the same transport
  (same url, or same sshHost, or same cloud kind with every field equal). The
  label is operator-editable free text and the id is a UUID, so the destination
  is the only stable identity a copy retains.
- **Label collisions are cosmetic and are kept, not de-conflicted.** Peers are
  keyed by UUID; unlike sessions there is no global name namespace. Two peers
  named `prod` pointing at different boxes is a thing the operator did.

### Q2 — the TOKEN. Copy it, main-process only, and level up the destination.

The facts, re-verified this pass:

| | contexts.json | ui-settings.json |
|---|---|---|
| write | `writeFileSync(…, {mode:0600})` **in place**, then explicit `chmodSync` (contexts.js:45-48 — needed *because* an existing file keeps its old mode) | `atomicWriteFileSync`: tmp `openSync(…,'w',0o600)` → **rename over the target** (fs-util.js:28,35) |
| resulting mode | 0600, asserted | 0600 **by construction** — rename replaces the inode, so a previously-loose file cannot leak its mode forward |
| read | mode checked, warns on `& 0o077` (contexts.js:28-31) | **no check** |

**So the write side is not the asymmetry — if anything the destination is the
stronger of the two** (rename-replace can't inherit a loose mode; the CLI needs
an explicit chmod precisely because it can). `openSync`'s mode is umask-masked,
and a umask can only REMOVE bits, so 0600 is a ceiling, never a floor breach.

**Does the copy widen who can read a token? No.** Same user, same machine, both
0600, both under a directory the user owns. The set of principals is unchanged:
the owning user and root. The disqualifier is cleared on its own terms.

**The two real deltas, stated rather than waved past:**

1. **The destination has no read-side warning.** A ui-settings.json that is
   somehow 0644 (restored from a backup, copied off another machine, a
   `chmod -R`) heals itself on the next settings write but is silent until then.
   contexts.json would have warned. So while the import doesn't *drop* an
   existing warning, it is what makes "this file holds tokens and nobody checks
   its mode" load-bearing.
2. **A secret in two files is a secret with two chances to leak** — backups,
   sync tools, a support bundle. Not a widening of who *can* read; a widening of
   where it lives.

**Ruling on (1): close it rather than argue around it.** Add the contexts.js
read-side check to ui-settings.json — warn once per process on `& 0o077`. This
is NARROWING, it is the pattern the codebase already has twice (contexts.js:29,
stores.js env-scopes post-rename chmod), and it means the copy lands somewhere
with equal detection, not merely equal permissions. **FLAGGED as a scope
judgment: it is a store-wide change, not a peers change. Kept in its own commit
so clodex can drop it with one revert if he wants it separate.**

**Ruling on (2): the copy is the SAFER of the available options.** The
alternative — import the peer without its token and let the operator supply it
— sounds conservative and is not. It leaves the peer imported-but-dead, and it
sends the operator to `cat ~/.clodex/cli/contexts.json`, putting the secret on a
terminal, in a scrollback, and possibly in shell history. **Declining to copy
does not avoid the copy; it routes it through a worse channel.**

**Ruling on the RENDERER, which is the part that could actually widen it:**
the token value MUST NOT cross into the renderer. `getSettings` today strips
peer tokens to a `hasToken` boolean — the renderer has never held a stored token
value, only one the operator just typed. So:

- **Import APPLIES in the main process**, not by injecting rows into the Peers
  dialog. Dialog-injection was the tempting shape (it reuses `collectPeers`'
  one save path) but it would have to carry the imported token through the
  renderer to survive, which is a genuine first-time widening and exactly the
  thing the disqualifier names.
- The renderer sees `{ name, kind, target, tokenState: 'set'|'none', action,
  reason }` — `import.js:206`'s discipline verbatim: **token state, never a
  value.**

### Step 4 build plan

1. **`peer-import.js`** — electron-free, pure. Contexts store + current peers →
   candidates. Refusals each with a reason: `tunnel` (**the never-tunnel
   invariant in the OTHER direction** — a raw argv is CODE and must never become
   a peer field), `ssm.ecs` (message names clodexctl for families and says a
   concrete target is required — clodex's likely-permanent answer, in the error
   text), an ssh string outside the peer charset, a url that isn't `^https?://`.
2. **A candidate must not claim what the store will drop.** `sanitizePeers` is
   private (`stores.js` exports only `initStores`), so the apply path **reads
   back** what the store kept and reports from that, rather than from what the
   preview hoped. Drift shows up as a candidate that previewed `add` and is
   reported not-added — and that is a test.
3. **IPC**: preview + apply, both main-side, tokens never returned.
4. **Renderer**: an "Import from clodexctl…" affordance on the Peers dialog;
   preview list, confirm, apply, reopen the dialog fresh.
5. **az arrives here** — it is the only kind with no route in, and after this it
   needs no second pass through the store (step 2 put its row in deliberately).

### Step 4 phase 2 — main-side done (uncommitted)

- **`peer-import.js`** (new, electron-free). `classifyEntry` refuses `tunnel`
  (never-tunnel, the OTHER direction), `ssm.ecs` (names clodexctl for families
  and says a peer needs a concrete target — clodex's likely-permanent answer put
  in the error text where an operator meets it), an ssh outside the peer charset,
  a non-http url. Cloud kinds are read off `peer-tunnel.js`'s `CLOUD_KINDS`
  rather than re-listed — the field list keeps ONE home. `sameDestination`
  compares url/sshHost/every cloud field; **candidates dedupe against each other
  as well as against existing peers**, or two contexts naming one box would make
  a duplicate in a single pass that no later run could tell apart.
- **`ipc-handlers.js`**: `peer:importPreview` strips `peer` (it holds the token)
  and returns `tokenState` only; `peer:importApply` takes NAMES, re-collects from
  the current store + current peers, writes through `uiSettings.set`, and reports
  from the **read-back** (`kept` = ids present after the write) rather than from
  what the preview hoped. sanitizePeers is private, so its rules and this
  module's are two copies of one contract — the read-back is what makes a
  divergence surface as an honest "not imported".
- **`api-contract.js`**: two rows.

Next: the renderer affordance, then the ui-settings read-mode warn as its own
commit, then tests.

### Step 4 phase 3 — renderer + the mode warn (uncommitted)

- **`renderer/index.html` + `styles.css`**: an "Import from clodexctl…" button
  beside Add Peer, and one full-width preview panel (`#peers-import-box`) in the
  same muted chrome as the per-row status panel.
- **`renderer/renderer.js`**: `openPeersImport` → `peerImportPreview`, a checkbox
  per importable context (name · kind · target · token set/none) and skips shown
  WITH their reason verbatim; Import → `peerImportApply(names)` → `closePeersImport`
  + `openPeersDialog()` so the new peers render through the ORDINARY path (and
  stale dialog rows can't clobber a fresh import on a following Save). The
  one-time-copy sentence is on screen, and the loader's warnings (the CLI's 0600
  check) are DISPLAYED, not swallowed. `rejected` names from the read-back are
  reported as a warning rather than folded into a success count.
  `openPeersDialog` clears any stale preview on open.
- **`stores.js`** (SEPARATE COMMIT, trimmable): `warnUiSettingsMode()` in
  `uiSettings._load` — `mode & 0o077` → one `console.warn`, mirroring
  contexts.js:28-31. Checked once per PROCESS, not once per warning: `_load`
  runs on every settings read and a statSync each time would be a syscall per
  read for a file that is 0600 in every normal case. This is the asymmetry the
  token argument turned up — the destination had no read-side check — closed
  rather than argued around.
