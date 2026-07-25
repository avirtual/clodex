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
