# t36 — web view for cloud peers (web-tunnel must dial what peer records hold)

Branch `web-tunnel-cloud` off master `3f9b752` (v4.3.0), worktree
`/Users/bogdan/projects/tmux/wb-wrap-ui-hand`. Baseline 2703 passing, ESCAPES: 0.

## The bug (given, not re-derived)

Operator imported a kubectl peer from clodexctl. Sessions work (peer-tunnel
learned cloud kinds in t32). "Open the web page" does not: two ssh-only
chokepoints, `peer-wiring.js:248` and `web-tunnel.js:133`.

The header ruling at `web-tunnel.js:30-33` — "no Clodex peer record can express
those transports (sanitizePeers accepts url + sshHost and drops everything
else)" — was TRUE at t30/v4.2.0 and was falsified by t32/v4.3.0's
`PEER_CLOUD_KINDS`. **The ruling outlived its premise by one release.** Rewrite
the comment; do not leave the stale premise standing.

## Phase 1 — read, done. What I found.

### The precedent, `peer-tunnel.js` (mirror it)

- `CLOUD_KINDS` table at :49-59 — `{ argv, fields, required }` per kind. Owns
  the kind list; `web-tunnel` must IMPORT it, not restate it (t32's whole
  drift argument).
- `constructor` :101-107 normalizes `this.cloud = { kind, block }` by scanning
  `...opts` for the first kind key present.
- `argv(localPort)` :157-163 — `substitutePort(build(block, remotePort), port)`
  for cloud; `['ssh', ...this.args(port)]` for ssh. SYNCHRONOUS by construction.
- `_detached()` :170 — true for cloud only. `_killChild()` :172-184 —
  `process.kill(-child.pid, 'SIGTERM')` with a `child.kill('SIGTERM')` fallback,
  guarded on `pid > 0`. ssh keeps a plain `child.kill()` and a spawn with no
  `detached` key at all (pinned at `test/peer-tunnel.test.js:173`).
- ENOENT copy :223-225: `${cmdName}: command not found — is ${cmdName}
  installed and on PATH?`. web-tunnel currently has no such arm (ssh is always
  installed); a missing `kubectl` is the common cloud misconfig, so this arm
  should come across too.

### Downstream sshHost assumptions

- `renderer/lib/peer-web-view.js:31` `isSshPeer(tunnel)` gates the affordance;
  :91-102 renders a DISABLED button whose tip says "reached by <cloud>, not ssh
  — Clodex can only tunnel to a web UI over ssh". That sentence becomes FALSE
  when this ticket lands. Must change: cloud peers now get an enabled button.
  The remaining true refusal is a **url-only** peer.
- `web-tunnel.js` `WebTunnelManager.sync()` :279-287 prunes by `sshHost` only —
  a cloud peer's web tunnel would be pruned on the first sync (its `live` map
  never gets an entry, so `live.get(id) !== tun.sshHost` → both undefined?
  No: `live.get(id)` is `undefined` and `tun.sshHost` is `null` → `!==` → it
  CLOSES. Must be fixed or every cloud web tunnel dies on the next settings
  write.) **This is a second bug the ticket implies but doesn't name.**
- `WebTunnelManager.open()` :239 `if (!sshHost) return {ok:false,…}` and the
  staleness check :248 compares `sshHost` only.
- `peer-wiring.js:257` passes only `sshHost` + `remotePort`.

## Decisions taken (flag to clodex)

1. **az is IN.** It is import-only in the GUI dialog, but `peer-tunnel`'s
   `CLOUD_KINDS` already admits it (t32 step 1 chose that so step 4's import
   needed no second pass), and `peer-import.js` can produce an az peer whose
   SESSIONS work today. Shipping a web view that dials three of the four kinds
   would recreate exactly this ticket for az. Importing the shared table gives
   az for free; excluding it would take an explicit subtraction.
2. **Kind table is imported from `peer-tunnel`**, not re-declared. `peer-import`
   already does this (`peer-import.js:38`).
3. **Pinned port is preserved for cloud too** — the pin lives in
   `_spawnTunnel`, above the transport dispatch, so it is untouched by kind.
   Test it on the CLOUD path specifically (the ssh pin test already exists).

## Open question — kubectl liveness (answer in report, do not silently unify)

web-tunnel's up-detection is "the process is alive" and its derivation is
ssh-specific (`ssh -N` prints nothing on success). Two sub-questions:
(a) does a healthy `kubectl port-forward` write to stdout/stderr — yes,
    "Forwarding from 127.0.0.1:PORT -> PORT" on success;
(b) does that BREAK anything here? stderr is only tail-buffered for the
    `lastError` line on exit. So chatty-on-success matters for the *error
    message*, not for the up-detection. → verify and report precisely.

## Phase 2 — product code, DONE (not yet tested)

- `peer-tunnel.js`: export `sameCloud` alongside `CLOUD_KINDS` (comment says
  why: a second copy of the kind table is what produced this ticket).
- `web-tunnel.js`:
  - header rewritten — the stale ssh-only ruling replaced with the t36 story and
    the one refusal that survives (url-only).
  - constructor takes `...opts`, normalizes `this.cloud = { kind, block }`.
  - `status()` carries the block under its kind key (renderer needs it to name
    the transport).
  - new `argv(localPort)` / `_detached()` / `_killChild()` — mirrors peer-tunnel;
    `stop()` now calls `_killChild()`.
  - `_spawnOn` spawns `argv(port)` with `detached: true` for cloud only, ENOENT
    arm names the binary, exit message uses `cmdName` not the literal `ssh`.
  - **`destinationOf(rec)`** (new, exported) — one rule for "what is this record's
    forwardable destination", shared by `open()` and `sync()`. Without sharing,
    `sync()` would prune every cloud web tunnel on the next settings write
    (`live.get(id)` undefined vs `tun.sshHost` null). That was a REAL second bug.
  - `open({id, remotePort, ...rec})` — refuses only url-only; staleness compares
    `sameCloud` too.
  - `sync()` compares destinations, not sshHost.
- `peer-wiring.js`: `openPeerWeb` asks `destinationOf` and passes the cloud block
  through; the url-only refusal names the real reason. Section header updated.
- `renderer/lib/peer-web-view.js`: new `isForwardablePeer` (tunnel row present at
  all = Clodex dials it) replaces `isSshPeer` in the gate; `isSshPeer` kept
  exported (the deploy flow is genuinely ssh-only). New `transportPhrase` so the
  open/connecting tips say "over a kubectl port-forward" instead of "over ssh".
  The false sentence "Clodex can only tunnel to a web UI over ssh" is gone.

`peers-ui.js` needed NO change — it only renders the affordance's data.
Modules all load; `cli/` still a leaf (web-tunnel → cli/src/transport is
downward; peer-tunnel → web-tunnel is not a cycle).

### Kubectl liveness — answered

`ssh -N` prints nothing on success, which is why "live child = live forward" was
safe there. `kubectl port-forward` IS chatty on success ("Forwarding from
127.0.0.1:P -> P") — but it writes that to **stdout**, and this spawn is
`stdio: ['ignore','ignore','pipe']`: stdout ignored, stderr tail-buffered only
for the `lastError` line at exit. So the chatter neither reaches nor affects
up-detection. Nothing regresses; what is true is that "up" is now slightly LESS
informative for a chatty CLI than it could be (a real success token exists and
we don't read it). Left uniform DELIBERATELY, documented at the `_setState('up')`
comment — reading it would mean a per-kind success-pattern table, and the failure
it would catch (a child alive but not forwarding) is already covered by the
give-up cap. **Reported to clodex, not silently unified.**

## Phase 3 — tests. Existing ones that MUST be updated (all are the old ruling
being pinned, so each is a rename + new expectation, not a weakening):

- `test/web-tunnel.test.js:357` "open refuses … no ssh host" — asserts `/ssh/i`
  on an error that is now about url-only.
- `test/peer-web-open.test.js:197` — name says "SAYS ssh-only"; `/ssh/i` still
  matches by accident (the new text lists ssh among the dialable transports), so
  the ASSERTION must be tightened, not just the name.
- `test/peer-web-view.test.js:132,143,177` — the three ssh-only tip tests. 143
  and 177 (ssm/kubectl get a disabled button) now assert the OPPOSITE.

New tests to add: cloud argv for kubectl + ssm, pinned port across a CLOUD
respawn, process-group kill for cloud, ssh spawn still has no `detached` key,
`sync()` keeps a cloud tunnel, url-only refusal.

## Phase 3 — DONE. Suite green.

`TOTALS: 2714 pass, 0 fail, 2714 tests` / `ESCAPES: 0` (2703 → 2714, +11).
Read off `npm test` directly, not only from the subagent digest — the runner
paraphrased rather than quoting, which has been wrong before.

### Tests changed (each was pinning the OLD ruling; none weakened)

- `web-tunnel.test.js` "open refuses…" — renamed; the `/ssh/i` match became
  `/reached by URL/i`. **The old assertion would still have PASSED** on the new
  message (it lists ssh among the transports Clodex dials), i.e. it had stopped
  being evidence of anything. Same fix, same reason, in
  `peer-web-open.test.js:197`.
- `peer-web-view.test.js` — "an ssm peer gets the same ssh-only refusal" and
  "a kubectl peer's ssh-only tip" **now assert the opposite** (enabled button,
  all four kinds); "a URL-only peer" keeps its meaning with a truer match.
  Added `isForwardablePeer` coverage and a tip-per-transport test.

### Tests added (11)

web-tunnel: cloud argv == the CLI builder's output with the pinned port (all 4
kinds, and no surviving `{port}` token); pinned port across a CLOUD respawn;
process-group kill for cloud (all 4); ssh spawn has no `detached` key and is
killed plainly; ENOENT names the binary; cloud status carries the block and no
argv; `sync` KEEPS a cloud tunnel but drops a re-pointed one; cloud re-open
idempotent / replaced on a changed field.
peer-web-open: a cloud peer is not refused and its whole block reaches the
supervisor (4 kinds); an incomplete block is refused.
peer-web-view: cloud peers get an enabled button; tips name the real transport;
isForwardablePeer.

### Revert proofs (6, all BY MESSAGE, none a crash)

| revert | test that failed |
|---|---|
| `_detached() { return false; }` | "kubectl: the child must lead its own group" |
| cloud re-picks its port each spawn | "the pin survives the respawn" |
| `openPeerWeb` back to gating on `rec.sshHost` | "kubectl: opened rather than refused" |
| affordance gate back to `isSshPeer` | "ssm: a peer whose wire tunnel Clodex dials can also be web-tunnelled" |
| tips back to a hardcoded `'over ssh'` | "the open tip names kubectl" |
| `sync()` restored to its true original | "a cloud peer that is still present KEEPS its web tunnel" |

`npm run build:web` re-run (peer-web-view.js is in the bundle graph) —
`web-dist/index.html` is tracked and changed.

## Deviations / assumptions to flag

1. **`peer-tunnel.js` now exports `sameCloud`** (was module-private). Two lines,
   needed so the web supervisor compares cloud destinations by the same rule.
   The alternative — a second copy — is the exact defect this ticket fixes.
2. **`destinationOf` is new and exported from web-tunnel**, and `peer-wiring`
   calls it. Slightly beyond "pass the cloud block through": it exists because
   `open()` and `sync()` MUST agree, and because peer-wiring asking the
   kind-owning module beats a `rec.sshHost || rec.ssm || …` chain.
3. **`sync()` was a second, unnamed bug** — fixed here. Without it a cloud web
   tunnel is pruned by the next settings write.
4. **az is IN** (stated, per the spec's ask).
5. **ENOENT arm added** to web-tunnel (it had none; ssh is always installed).
   Copy is peer-tunnel's verbatim.
6. **Up-detection left uniform, deliberately**, with the reasoning written at
   the call site. See the kubectl-liveness section above.
