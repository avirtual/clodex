# t30 — peer web view via clodexctl tunnel

Dispatched by clodex in msg-93431-13 (00:55), as a one-liner rather than a full
ticket — the backlog entry lives in clodex's context, not in the repo. Grepped
`tasks/`, `docs/`, `.claude/` for a written spec: **none exists** (the `t303`
hits in `.claude/memory-archive-2026-07-22.md` are an unrelated review).

## The spec, verbatim and complete

> Next: **t30** (peer web view via clodexctl tunnel) is yours, backlog no
> longer — start when you pick this up. It is investigation-first and the real
> question is **tunnel lifetime, not wiring**. Branch off master AFTER I merge
> this; I will have pushed by then, so pull first.

That is everything I was given. Two things are load-bearing in it:

1. **Investigation-first.** Same shape as t29 — establish what is actually true
   and report before building. t29's lesson is directly relevant: the ticket's
   premise about the mechanism was wrong, and finding that out was the work.
2. **The real question is tunnel LIFETIME.** clodex has pre-named where he
   expects the difficulty. Not "can we wire a peer's web view through the
   tunnel" but "how long does that tunnel live, and what happens to the view
   when it does not". Investigation must answer lifetime first; wiring is the
   part he is explicitly saying is not the problem.

## Branch base — NOT yet available at pickup

- `origin/master` is still at `e5b577d` (v4.1.0).
- Local `master` is at `ea0729e` "Merge test-masking: …" — clodex merged t29
  locally but **has not pushed yet**.
- Instruction is explicit: branch off master AFTER the merge is pushed, and
  **pull first**. So: `git fetch && git pull` on master, confirm origin carries
  the merge, THEN branch. Do not branch off the local merge commit.
- Investigation needs no branch; reading can start immediately.

## Surface to read (not yet read — orientation only)

- `docs/peering.md` — the subsystem flow doc. CLAUDE.md says read the matching
  one BEFORE changing a subsystem.
- `peer-tunnel.js` (TunnelManager), `peer-manager`/`peer-wiring.js`,
  `peer-client.js`, `peer-deploy.js`.
- `cli/` — clodexctl (`cli/src`, `cli/bin`, `cli/README.md`), plus
  `cli/deploy/` for how tunnels are stood up in the deployed flavors.
- The web frontend side: `web-host.js`, `renderer/web/`, and how a LOCAL web
  view is served today — the peer case presumably reuses it.
- Tests: `test/peer-tunnel.test.js`, `test/peer.test.js`,
  `test/peer-manager-sync.test.js`, `test/peer-client-*.test.js`,
  `test/relay-protocol.test.js`.

## Constraints (standing, carried)

- Do not push. Do not touch master. Do not commit on master.
- `.claude/CLAUDE.md` and `.claude/memory.md` are never edited.
- `hostApi` frozen at `"1"`.
- `git reset -q node_modules` before staging; explicit path lists, never
  `git add -A`.
- Suite runs via `npm test --silent -- --reporter=dot` through the t29 wrapper
  (or the `clodex-test-green` skill, whose agent definition now routes through
  it). **A green run requires `ESCAPES: 0` as well as zero failures.**
  Baseline after t29: **2577**.
- `npm run build:web` if bundled sources change.
- Prove tests by reverting and watching them fail BY MESSAGE.
- t29 trigger, new: **an exit-code assertion in a wrapper test almost always
  rides the wrapped tool's behaviour** — anchor on what only our code produces.
- t28 trigger: **`git checkout --` is not undo.** Commit before proving by
  reverting.

## Phase 1 — findings (no branch yet; reading only)

### (A) There are TWO servers, and peering carries the wrong one

- **`remote.js` RemoteServer**, wire port **7900**. The peering protocol
  (attach/control/input/dm/…) AND a **phone web UI** at `/`. This is what
  Clodex's own `TunnelManager` forwards, and the only thing it forwards.
- **`web-host.js`**, `webPort` **7810** (clodexctl assumes wire+1). The FULL
  browser frontend — the real renderer bundle over WebSocket, driving the same
  `registerIpcHandlers` map. Started **only by `headless-main.js` when
  `CLODEX_WEB_PORT` is set**; Electron never loads it.

So "peer web view" is the **web-host** surface, and Clodex's peering stack has
no path to it at all: `Tunnel.args()` (peer-tunnel.js:88) forwards exactly one
port, `remotePort` (default 7900). The phone UI on the wire port is a different,
smaller thing — not what t30 is about.

### (B) TUNNEL LIFETIME — the two models are opposites, by explicit design

| | `TunnelManager` (peer-tunnel.js) | `clodexctl web` / `port-forward` |
|---|---|---|
| shape | supervised daemon | **foreground hold** |
| death | **auto-restart**, 1s→60s capped backoff | **single-shot, NO reconnect** |
| posture | calm (laptops sleep) | honest error, exit CONNECT |
| stop | `stop()` / settings sync | Ctrl-C / SIGTERM / SIGHUP → exit 0 |
| transport | **ssh only** (`-L`, needs `sshHost`) | ssh/ssm/kubectl/gcloud/az/custom |
| local port | **fresh on EVERY (re)start** | pinned (`--port`) or 8080–8090 |

port-forward.js:8-12 states the no-reconnect choice deliberately: *"a dropped
tunnel ends the session with a clear error rather than silently masking a dead
node (attach reconnects because a human is mid-keystroke; a port-forward's
consumer reconnects itself)."* That last clause is the whole problem — **a
browser tab is a consumer that does NOT reconnect itself.**

### (C) The sharp edge: the local port changes on every tunnel restart

`Tunnel._spawnTunnel` calls `pickFreePort` and assigns a NEW `this.localPort`
every time (peer-tunnel.js:99-102). `peer-client.js` copes because it re-reads
`urlFor(id)` through `onState`. **A browser tab, iframe or webview cannot** — it
holds a URL string. After one wifi blip the view points at a port that is closed,
or worse, has been reused by something else. Any design that hands a raw
`http://127.0.0.1:PORT` to a browser and walks away is broken by the supervisor
that is supposed to keep it alive. This is the lifetime question clodex named,
and it has a concrete mechanism behind it.

Also: while a tunnel is down the peer keeps the dead-placeholder URL
`http://127.0.0.1:1` (docs/peering.md §3) — a view must not render that.

### (D) Clodex has NO embedded-browser surface today

Grepped `renderer/` + `main.js` for `webview` / `BrowserView` /
`WebContentsView` / `<iframe>`: **zero hits.** So t30 is either
(a) pop the system browser at a tunnel URL, or (b) introduce the **first**
embedded browser surface in the app. (b) is not a wiring detail: the app runs
`contextIsolation: false` + `nodeIntegration: true` (CLAUDE.md calls this out
and says "revisit if the threat model changes"), so hosting remote-origin
content in-window is a threat-model decision, not an implementation one.
**Flagging, not choosing** — that is clodex's call.

### Open question I could not settle by reading

Whether t30 means *"Clodex opens a peer's web GUI"* (consumer-side feature) or
*"clodexctl grows a supervised/background mode"* (CLI feature). The two share
the lifetime problem but almost nothing else. Asked clodex before building.

## clodex's rulings (msg-93431-16)

- **(C) decisive.** "Do not build anything that hands out a raw port string and
  walks away." The URL must be stable across restarts OR the consumer must be
  re-resolvable.
- **It is the Clodex side** — consumer-side feature in peers-ui, NOT a new
  clodexctl mode. "clodexctl's foreground single-shot is correctly designed for
  its actual consumers; do not bend it to serve a browser tab."
- **(A) — the ticket was wrong.** "I said 'everything needed exists.' It does
  not… That is the real work in this ticket, and it is more than wiring. Treat
  my ticket's cost estimate as void."
- **(D) out of scope. EXTERNAL BROWSER ONLY.** No embedded surface.
- **The peer should advertise its `webPort`** — "a consumer guessing wire+1 is a
  consumer reconstructing what the producer already knows." If extending hello
  is more invasive than it looks, report before doing it.
- **Second port vs separate tunnel: my call**, against (C)'s restart behaviour.
- **Never render the placeholder** `http://127.0.0.1:1` — show "connecting".
- **The tunnel must not outlive its reason to exist.** Decide what closes it and
  say so explicitly. "A forgotten tunnel to a remote box is a quiet hole."

## Phase 1b — the hello extension: NOT invasive, but it needs a seam

Branch `peer-web-view` created off master `ea0729e` (pulled).

**Hello is trivially extensible.** `remote.js:451-464` is a plain object literal;
`srcDir` (:459) is the exact precedent — a self-reported, nullable field added
later, with old viewers ignoring it. Consumer side: `peer-client.js:122-126`
`identityChanged` compares version/platform/srcDir/caps, so **adding `webPort`
there makes a web-host appearing or moving emit `peer-state` immediately**
rather than waiting on the 15s cadence. That is the right hook and it already
exists.

**The non-trivial part is where the value comes from.** `RemoteServer` takes
`srcDir`/`version` as constructor VALUES (remote.js:62-68, wired at
remote-wiring.js:425-431). But the web host is:
- started **only by `headless-main.js`** (:194-211) from `CLODEX_WEB_PORT`,
- constructed **after** the engine, so the engine cannot be handed the value at
  construction time,
- **absent entirely** on desktop Electron — which must report null, not a guess.

`engine.js:88` `createEngine({ userDataPath, seams, log })` is the established
answer: every host-specific capability is an optional seam with a default. So a
`seams.webInfo` getter (headless returns `{port, token?}`, Electron omits it →
null) fits the existing pattern without inventing one. Reporting this shape to
clodex rather than assuming it, since it touches the engine seam list.

**A complication clodex will want to rule on: the web host can require a token.**
`CLODEX_WEB_TOKEN` gates every route + the WS upgrade (`headless-main.js:207`,
`web-host.js:104/383/391`), read from `?token=`, `Authorization: Bearer`, or a
cookie (`auth-token.js:19-23`). So on a token-gated box, a tunnel alone does not
open the GUI — the URL needs `?token=`. That means the consumer either receives
the token over hello (**putting a secret in an unauthenticated identity
endpoint** — I will NOT do this without an explicit ruling) or the operator
pastes it. Advertising the PORT is safe; advertising the TOKEN is a different
decision. Flagging, not choosing.

## clodex's rulings (msg-93431-18)

- **(1) approved — advertise the PORT only.** (2) refused outright; (3) "stays
  available and unbuilt". **Do not fetch the token over any channel here.**
- **My "unauthenticated hello" was wrong** — corrected by clodex and verified:
  `_authGate` (remote.js:360) runs before ALL routing including hello, so with
  `CLODEX_REMOTE_TOKEN` set, hello requires it. What is true is narrower: on a
  loopback bind with no token, the gate passes everything. Hello is open *in
  exactly the configuration where it is reachable only through a tunnel* — the
  design, not a gap. Both branches argue against (2), so it is refused harder
  than I argued for.
- **`seams.webInfo` approved.** Keep it to what the consumer needs.
- **The token-gated signal must be REAL, not guessed.** "If you cannot cheaply
  know… prefer a URL that 401s with a clear explanation over a
  confident-but-wrong claim. Do not invent a gated/ungated signal."
- **Carry into the design:** `identityChanged` is the re-resolution hook. "Build
  the consumer so the current URL is always read through that path, never cached
  at open time — the (C) failure is a consumer holding a string across a respawn."

### The gated signal IS cheaply knowable — no guess needed

`web-host.js:104` builds `gate = makeTokenGate(token)` and `auth-token.js`
exposes `gate.configured`. `createWebHost` already returns an object
(`web-host.js:427`), so it can return `tokenGated: gate.configured` alongside
`port`. That is the host reporting a **fact about itself**, and it is not a
secret — knowing that a token is required reveals nothing about the token. So
`seams.webInfo` → `{ port, tokenGated }`, and the UI claim is derived, never
invented. clodex's 401 fallback is not needed.

## Phase 2 — the lifetime model

### The constraint an external browser imposes

clodex's (C) ruling allows two escapes: a **stable** URL, or a **re-resolvable**
consumer. For an external browser tab **only "stable" is available** — Clodex
cannot re-point a tab it does not own. That single fact drives the whole design.

### Decision: a SEPARATE, on-demand tunnel with a PINNED local port

Rejected — a second `-L` on the existing peer tunnel:
1. it would inherit `TunnelManager`'s re-pick-port-on-respawn, which is the (C)
   bug itself; and
2. it would open a web tunnel for **every** ssh peer whether or not anyone asked
   to look — a tunnel with no reason to exist, which clodex forbade.

So: a distinct supervisor, one per peer that has been explicitly opened.

- **Local port is picked ONCE and pinned** for the life of that web tunnel, and
  re-bound to the SAME port on every respawn. This is the deliberate inversion
  of `Tunnel._spawnTunnel`'s fresh-port behaviour, and the reason is written into
  the code: our consumer cannot re-resolve.
- `ExitOnForwardFailure=yes` (already in `SSH_BASE_ARGS`) makes a taken pin an
  honest failure + backoff, not a silent bind elsewhere.
- **The browser is popped exactly once**, on the first successful up. Respawns
  do NOT re-pop — the pinned port means the existing tab works again on reload.

### What CLOSES it (clodex asked for this explicitly)

The peer tunnel retries forever because Clodex needs the peer connection
continuously. A web tunnel exists because a human asked to look at a GUI, and a
human's attention is bounded. So it closes on:

1. **Explicit close** — the affordance that opened it toggles closed.
2. **Peer removed or disabled** — same rule as `TunnelManager.sync`.
3. **App shutdown** — a `stopAll()` on the same path as the peer tunnels.
4. **Give-up cap** — if it cannot establish for a bounded window, it stops and
   surfaces that, instead of retrying at a dead box forever. This is the direct
   answer to "a forgotten tunnel to a remote box is a quiet hole": every other
   trigger depends on someone doing something, and this one does not.

### Never rendering the placeholder

`http://127.0.0.1:1` is `TunnelManager`'s dead-peer sentinel and is never a web
URL. The web affordance reads its own tunnel's state (`down`/`up`) and shows
"connecting…" until up; **no URL exists in the UI until there is a live one.**

### Re-resolution, per clodex's carry-in

The pin makes the URL stable, but two things still move: whether the peer HAS a
web host, and which remote `webPort` it uses. Both ride hello, and
`identityChanged` already forces a `peer-state` emit when `webPort` changes. So
the affordance is rendered from **live peer state**, never from a snapshot taken
when the popover opened — and a remote `webPort` change restarts the tunnel
rather than silently forwarding to a stale port.

## Progress

- [x] Phase 0 — pulled master `ea0729e`; branch `peer-web-view` created.
- [x] Phase 1 — investigated; findings above; clodex ruled.
- [x] Phase 1b — hello extension scoped; seam + token question raised.
- [ ] Phase 2 — design the lifetime model (what opens/closes the tunnel), report.
- [x] Phase 3 — t30a BUILT, committed `2542a30`.
- [ ] Phase 4 — tests, proved by reverting.
- [ ] Phase 5 — full suite (baseline 2577, ESCAPES: 0), report, close t30a.

## SPLIT — clodex ruled two tickets (msg-93431-20)

Design approved as written. `ExitOnForwardFailure=yes` verified at
peer-tunnel.js:32. Give-up cap called "the best part of the model". Rejecting
the second `-L` correct on both counts, the second the stronger.

**t30a (THIS branch) — plumbing, engine-side, NO UI, NO tunnel.** Ends with a
peer's web host being *discoverable*: correct on headless, null on Electron, and
a `webPort` change emitting `peer-state`. "Fully testable with no tunnel and no
affordance."

**t30b (NOT started, do not begin until clodex merges t30a)** — the pinned-port
supervisor, the four closes including the give-up cap, and the peers-ui
affordance rendering from live state.

Reasons given: the seam and hello field are the load-bearing, hard-to-change
parts and a seam shape is far cheaper to fix before a supervisor sits on it;
and the split yields a green suite before the risky half starts.

## t30a — what was built (commit `2542a30`)

- **`web-host.js`** — `createWebHost` return gains
  `info: { port, tokenGated: gate.configured }`. The port actually listened on,
  not a guess. `tokenGated` = a token is REQUIRED, never its value.
- **`engine.js:113`** — `const getWebInfo = seams.webInfo || (() => null);`
  Getter, not value (web host starts after `createEngine` returns; absent under
  Electron). Passed into `createRemoteWiring` as `getWebInfo`.
- **`remote-wiring.js`** — destructures `getWebInfo`, passes
  `getWebInfo: typeof getWebInfo === 'function' ? getWebInfo : () => null` into
  the `RemoteServer` ctor.
- **`remote.js`** — ctor takes `getWebInfo`; `_webHost()` normalizes to
  `{port, tokenGated}` or null (port-range checked, **try/catch → null**:
  identity is load-bearing, a web view is not worth breaking hello for);
  hello gains `webHost: this._webHost()`.
- **`headless-main.js`** — `webInfo: () => (webHost ? webHost.info : null)` in
  the seams block, a closure over the `let webHost` declared BELOW it. No setter
  needed. Null when `CLODEX_WEB_PORT` unset or the host failed to start.
- **`peer-client.js`** — module-level `webHostKey(w)`; hello `next` gains a
  normalized `webHost`; `identityChanged` compares `webHostKey(prev)` vs
  `webHostKey(next)`; `status()` exposes `webHost` so the renderer reads LIVE
  state, never a popover-open snapshot.

Affected tests green: 134/134, ESCAPES: 0 (`free-identifier-leaks`, `peer`,
`peer-manager-sync`, `remote-auth`, `electron-boundary`).

## Phase 4 plan (NOT started)

Tests to write, then prove EACH by reverting (safe — fix is committed):
1. hello carries `webHost` when the seam reports a host; **null when it does
   not** (the Electron case).
2. `_webHost()` rejects a malformed/out-of-range port → null, and a THROWING
   seam → null with hello still 200 (the degrade-not-break property).
3. `tokenGated` reflects `gate.configured` — and the token value appears
   NOWHERE in the hello body. This is the security assertion; write it so it
   fails if anyone ever adds the token.
4. `identityChanged` fires on webHost appear / vanish / port-move — the
   re-resolution hook t30b depends on.
5. `status()` exposes `webHost` (t30b reads live state through it).
Note: `remote-wiring.js` + `engine.js` are BOTH in the leak-scanner's
SCANNED_MODULES, so the new seam name is already gated in both directions.
- [ ] Phase 1 — investigate: how a web view is served today, how a peer tunnel
      is established, and above all **tunnel lifetime**. Report to clodex
      BEFORE building anything.
- [ ] Phase 2 — build, once clodex rules on the findings.
- [ ] Phase 3 — tests, proved by reverting.
- [ ] Phase 4 — full suite, report, close t30.

## Phase 4 — tests written and PROVEN (commits `dfabbda`, `af76bda`)

Two new files, 23 tests, all proved by reverting (HEAD held the fix, so
`git checkout --` was safe — the t28 trigger).

**`test/peer-web-host.test.js`** (18) — the wire contract, over real HTTP.
Producer: hello carries `webHost` when the seam reports one; **present-and-null**
when it does not (Electron), so "no web host" and "too old to say" are one case;
malformed/out-of-range/non-integer/string ports refused (65535 explicitly NOT
swept up); a **throwing** seam → null with hello still 200 and identity intact;
`tokenGated` only ever a literal-true boolean. Consumer: `status().webHost`,
normalization against a RAW hello, `identityChanged` on appear/move/vanish/gate,
and **no** re-emit from a steady host (the key-comparison property).

**`test/engine-web-info-seam.test.js`** (5) — the seam shape. Engine's default
and its read-through behaviour driven through the REAL path (engine →
`syncRemoteServer` → captured `RemoteServer` options, `CLODEX_REMOTE_ENABLE=1`,
RemoteServer patched so no socket binds); `remote-wiring`'s non-callable guard;
and headless-main's closure pinned **as source** — it boots a real host so it
can't be required, and the regression that matters is textual (`webInfo: webHost`
captures the null it holds at that point, forever).

### The security assertion

Stands a REAL token-gated `createWebHost` up and searches the **raw hello bytes**
for the token, then pins `webHost`'s key set to exactly `['port','tokenGated']`.
So it fails if anyone adds the token under any name, and fails again if a future
field tries to smuggle it past the string search. Proved: mutating the hello to
ship `token:` turns it red.

### Two defects the tests found

1. **`web-host.info.port` echoed the REQUESTED port**, so a host constructed with
   `port: 0` (every ephemeral bind, and every test) advertised **port 0** — a port
   nothing serves, which is exactly the class of lie this ticket exists to kill.
   Now a **getter** reading `server.address().port`: null before listen and after
   close, rather than claiming a dead port.
2. **My own consumer-normalization test proved nothing.** It drove a real
   `RemoteServer`, which normalizes first — the malformed values never reached the
   consumer. Reverting peer-client's guard left it GREEN. Rewritten against a raw
   http hello emitting bodies no producer of ours would send. **Carried trigger
   confirmed again: an impossible fixture passes for the wrong reason** — and the
   tell here was specific, *a test whose fixture must pass through a second guard
   before reaching the one under test*.

### Proof matrix (12 mutations, each failing BY MESSAGE, never by crash)

drop the hello field → 14 · skip port validation → 1 · remove the try/catch → 1 ·
coerce `tokenGated` → 1 · **ship the token → 3 incl. the security one** ·
drop `status().webHost` → 8 · stop normalizing → 2 · absent-reads-as-undefined → 2 ·
pass extra keys through → 1 · ignore webHost in `identityChanged` → 4 ·
snapshot the seam → 1 · drop the non-callable guard → 1 · echo the requested
port → 2 · headless captures by value → 1.

## Phase 5 — RESULT

**Suite green: 2600/2600, `ESCAPES: 0`** (baseline 2577 + 23). Branch
`peer-web-view`, four code/test commits on top of master `ea0729e`. Nothing
pushed, master untouched.

- [x] Phase 4 — tests, proved by reverting.
- [x] Phase 5 — full suite, reported. t30a awaiting clodex's merge.

## t30b — NOT started (blocked on the merge)

Carry-in for the tunnel half, beyond the design already recorded above:
clodex's correction (msg-93431-22) — investigate whether the supervisor can drive
`cli/src/transport.js` as a LIBRARY (ssh + SSM + kubectl + gcloud IAP + az
bastion) rather than reimplementing `TunnelManager`'s ssh-only spawning. `cli/` is
standalone-by-construction (node:* + siblings only), so app→cli may be fine where
cli→app would not be; check that the direction actually holds and report. Not
reversed: the supervision, the pinned port and the four closes stay Clodex-side.
If reuse is ugly, say so and ship ssh-only with the limitation stated.

# t30b — phase 1: the transport investigation (INVESTIGATION ONLY, nothing built)

Branch `peer-web-tunnel` off master `c32de90` (t30a merged). Question from
clodex: can the web-tunnel supervisor drive `cli/src/transport.js` as a library
— ssh, SSM, kubectl, gcloud IAP, az bastion — instead of reimplementing
`TunnelManager`'s ssh-only spawning? Verify the direction constraint against
the ACTUAL gates, not the prose.

## (A) The standalone rule is PROSE ONLY — no gate enforces it

Asserted in `cli/src/transport.js:12` ("Standalone by construction: node:* only,
never require()s an app file"), `cli/src/import.js:5`, and `cli/README.md:7`.

Verified true in fact: transport.js requires only `net`, `child_process`, `util`
and `./errors`; errors.js requires **nothing**. So the reuse closure is exactly
two files, both leaves.

But **no test checks it**, in either direction. `pot-cli-closure.test.js` pins a
different closure (pot-cli's materialized files); `plugin-loader.test.js` pins
`build.files` for `plugins/`. Nothing scans `cli/` for app imports and nothing
scans app files for cli imports. The 26 `cli/test/*.test.js` files ARE in the
root suite's discovery (158 files total, 26 under `cli/`), so a cli regression
is caught — but not a direction violation.

## (B) app→cli would work in dev and CRASH in the packaged DMG

`build.files` is an **allowlist**: `"*.js"` matches root files only (not
subdirs), plus named subdirs — `wire/`, `renderer/`, `plugins/`, `resources/`,
two `scripts/` files. **`cli/` is not in it.**

Verified against the real artifact rather than the config: `npx asar list` on
`dist/mac-arm64/Clodex.app/Contents/Resources/app.asar`, grepping `^/cli`,
returns exactly ONE entry — `/cli-hooks.js`, the app's own root file. The `cli/`
directory is absent.

So `require('./cli/src/transport')` from app code resolves fine from a checkout
and throws MODULE_NOT_FOUND in the shipped DMG. **Silent in dev, fatal in
release** — and `npm start` is the dev path, so nothing local would ever catch
it. `scripts/electron-smoke.js` requires `wire/` files, not cli.

Fixable in one line (`"cli/**/*"` in `build.files`), but that contradicts
`cli/README.md:62` — "The desktop app's packaged DMG does **not** include
`cli/` — it is a standalone package" — which is a deliberate shipping position,
not an accident.

## (C) DECISIVE: no Clodex peer can express a cloud transport, so there is
## nothing for multi-transport to reach

`openTransport(ctx)` dispatches on `ctx.ssh` / `ctx.ssm` / `ctx.kubectl` /
`ctx.gcloud` / `ctx.az` / `ctx.tunnel` / `ctx.url`. A Clodex **peer record** can
carry none of the middle five:

- `sanitizePeers` (stores.js:227) constructs each entry key by key and accepts
  exactly `url` (http/https) and `sshHost` (charset-checked). Everything else is
  dropped by reconstruction.
- `classifyPeerDest` (peer-deploy.js:253) returns exactly `ssh` / `url` /
  `empty` / `error`.
- `resolvePeerUrls` (peer-wiring.js:164) branches exactly `sshHost` → tunnel
  URL, else `p.url`.

So importing transport.js buys multi-transport *capability* against data that
cannot exist. The peers sidebar today holds three things, and none of them is a
cloud-transport box: local sandbox containers (already have the ↗ arrow via
`sandboxStatus().ports.web`), ssh peers, and direct-url peers.

**This reframes clodex's concern.** His worry was that ruling "Clodex side"
silently excluded k8s and Fargate. The exclusion is real but it is **already
there, one layer down and independent of this ticket**: a Fargate task or a k8s
pod cannot be a Clodex peer *at all* right now — that is precisely why clodexctl
exists for them. The web view cannot exclude a peer type that cannot be added.

Multi-transport peering is its own ticket, and a bigger one: peer schema +
sanitizePeers + classifyPeerDest + the peers dialog + peer-wiring resolution.
Its payoff is far larger than a web view — it would make the **peer connection
itself** multi-transport, and the web view would then follow for free, because
the supervisor would be reading the same ctx.

## (D) Would the reuse actually fit, mechanically? Yes — worth recording

`openTransport` is single-shot (open → wait for port → `{baseUrl, localPort,
close, waitExit}`) with no supervision, backoff or respawn. Our design needs
those. But two of its seams fit our model exactly:

- **`localPort` (transport.js:252)** pins the local end instead of picking free
  — this IS our pinned port, already implemented, with the same
  `ExitOnForwardFailure` honest-failure reasoning in its comment.
- **`waitExit()`** resolves when the child dies — the respawn trigger.

So a Clodex-side supervisor could wrap it: open with the pinned port, await
`waitExit`, back off, reopen. Supervision stays ours (clodex's ruling intact)
and the one-shot open is borrowed. The fit is clean; the blockers are (B) and
(C), not the shape.

## RECOMMENDATION → ssh-only now, multi-transport as its own peering ticket

Not "reuse is ugly" — reuse is mechanically clean. Ship ssh-only because the
multi-transport benefit is **currently unreachable**: no peer record can carry a
cloud transport, so the import would add a packaging hazard (B) for capability
nothing can use (C). Reuse becomes correct the moment peer records gain cloud
transports, and that ticket should carry the `build.files` change and the
README update as part of its own cost.

Awaiting clodex's ruling before building.

## RULINGS on phase 1 (msg-93431-29)

clodex verified (C) himself at stores.js:236-238 (`if (!url && !sshHost) continue;`)
and **withdrew** his transport correction: the premise was wrong, the peer schema
excluded k8s/Fargate long before this ticket.

1. **Ship ssh-only**, limitation stated in the UI. Build the supervisor per the
   approved design.
2. The direction gate is its own ticket — **clodex files it, not me**. Same for
   the peer-schema work, which he ranks above this ticket.

# SPUN-OUT TICKET #1 (clodex files) — a gate on the cli/ ↔ app direction

Written up here so a fresh spawn can file and build it without re-deriving the
finding.

**The invariant.** `cli/` is standalone by construction: `node:*` + its own
siblings, never an app file. Asserted in prose at `cli/src/transport.js:12`,
`cli/src/import.js:5`, `cli/README.md:7`. **No test enforces it, in either
direction.** `pot-cli-closure.test.js` pins a different closure (pot-cli's
materialized files); `plugin-loader.test.js` pins `build.files` for `plugins/`.

**Why it is worth more than tidiness — the DMG asymmetry.** The two directions
fail differently and the app→cli one is the dangerous half:

- **cli → app** breaks clodexctl's standalone install (a box that has never seen
  Clodex). Loud and local: `cli/test/load-smoke.test.js` requires every
  `cli/src/*.js` in-process, so an app import that fails to resolve surfaces
  there. Partially covered by luck, not design — an app file that *does* resolve
  from a checkout would pass load-smoke and still break the published package.
- **app → cli** is the silent one. `build.files` is an **allowlist**: `"*.js"`
  matches root files ONLY (not subdirs), plus the named subdirs `wire/`,
  `renderer/`, `plugins/`, `resources/` and two `scripts/` files. `cli/` is not
  among them. So `require('./cli/src/transport')` resolves fine from a checkout,
  passes the whole suite, passes `npm start`, and throws MODULE_NOT_FOUND in the
  shipped DMG. Green in dev, fatal in release.

**The check that catches it, and the one that does not.** Reading
`package.json`'s `build.files` is NOT sufficient — it tells you the config, not
the artifact. The real check is `npx asar list` on the built app:

```
npx asar list dist/mac-arm64/Clodex.app/Contents/Resources/app.asar | grep '^/cli'
```

which today returns exactly ONE line — `/cli-hooks.js`, the app's own root file
(the `^/cli` prefix matches it; do not mistake that for the directory). The
`cli/` directory is absent. `scripts/electron-smoke.js` does not cover this: it
requires `wire/` files, not cli.

**Shape of the fix.** A static test scanning both directions, in the spirit of
`free-identifier-leaks.test.js`: every `require('…')` in `cli/**/*.js` must be a
`node:`/bare builtin or a `./`-sibling inside `cli/`; every `require()` in root
app files must not reach into `cli/`. Static source scan, no build needed — the
asar check is the *reasoning* for why the gate matters, not the gate itself
(a test must not depend on a built DMG).

**Note if the direction is ever deliberately opened.** Adding `"cli/**/*"` to
`build.files` is a one-line change, but it contradicts `cli/README.md:62` — "The
desktop app's packaged DMG does **not** include `cli/` — it is a standalone
package" — which is a deliberate shipping position. Opening the direction means
changing that position and the README together, not just the glob.

# SPUN-OUT TICKET #2 (clodex files, ranked ABOVE this one) — multi-transport peers

A Fargate task or a k8s pod cannot be a Clodex peer at all today. Three places
enforce it, all by construction rather than by validation-with-holes:
`sanitizePeers` (stores.js:227) rebuilds each entry key by key, accepting only
`url` + `sshHost`; `classifyPeerDest` (peer-deploy.js:253) returns exactly
`ssh`/`url`/`empty`/`error`; `resolvePeerUrls` (peer-wiring.js:164) branches
`sshHost` → tunnel URL, else `p.url`. Surface: peer schema + sanitizePeers +
classifyPeerDest + the peers dialog + peer-wiring resolution.

Ranked above the web view because it makes the **peer connection itself**
multi-transport — the web view then follows for free, since the supervisor would
read the same ctx. `cli/src/transport.js` is the reference implementation and
`openTransport`'s `localPort` + `waitExit` seams already fit a supervisor.

## Downstream option of ticket #2 (NOT an alternative to it) — a tunnel plugin

Bogdan floated transports as a plugin point, so a new transport ships without a
Clodex release. clodex checked the mechanism: engine halves are `require`d into
the main process (engine.js:1793) with full Node, so it is mechanically
possible. **Blocked by the same finding (C):** a plugin could not express a
cloud transport the peer schema cannot persist. So it lands *after* ticket #2,
as an extension of it — recording it here so the ordering isn't rediscovered.

## Phase 2 — BUILD (ssh-only, ruled). Starts here.

Approved design is above ("What CLOSES it", "Never rendering the placeholder",
"Re-resolution"). Concrete surface, to be confirmed against the code:

- **New `web-tunnel.js`** — the supervisor, modelled on `peer-tunnel.js` but
  with the deliberate inversions: local port **picked once and pinned** (reason
  written into the code — our consumer is a browser tab that cannot be
  re-pointed), browser popped **exactly once** on first up, and a **give-up cap**
  instead of peer-tunnel's forever-retry.
- **Four closes**: explicit toggle · peer removed/disabled · app shutdown
  (`stopAll()` on the peer-tunnel path) · give-up cap.
- **Wiring**: engine + `peer-wiring.js` (sync alongside TunnelManager), IPC
  handlers, preload.
- **`renderer/peers-ui.js`** — the affordance, reusing the sandbox ↗ arrow's UX
  and toast vocabulary (`openBoxWeb`, peers-ui.js:105). Rendered from **live**
  `status().webHost` (t30a), never a popover-open snapshot. No URL shown until
  one is live; `http://127.0.0.1:1` never rendered.
- **`tokenGated: true` → say the box requires a token**, do not hand over a URL
  that will 401 (clodex made this a ticket requirement).
- **ssh-only limitation stated in the UI** (ruling 1).

Baseline for the suite: **2600, ESCAPES: 0**.

## Phase 2a — surface CONFIRMED against the code (read, nothing written yet)

Read: `peer-tunnel.js` (whole), `peer-wiring.js` (whole), `engine.js:1540-1590` +
`1815-1865`, `ipc-handlers.js:1226-1245`, `preload.js`, `api-contract.js`,
`renderer/peers-ui.js:1-260`. The planned surface holds; concrete call sites:

- **`web-tunnel.js` (new, electron-free, `spawnFn` injectable)** — `WebTunnel`
  + `WebTunnelManager`, modelled on peer-tunnel.js with three inversions:
  `localPort` picked ONCE in `start()` and reused by every respawn (peer-tunnel
  re-picks inside `_spawnTunnel`, peer-tunnel.js:99-102 — the (C) bug);
  `onOpen(url)` fired exactly once on first up (supervisor owns the `_popped`
  flag so the electron call stays in the wiring); a **give-up cap** replacing
  `_scheduleRestart`'s forever-retry, landing in a terminal `gave-up` state that
  keeps `lastError`. `url()` returns non-null only while `state === 'up'`, so
  the placeholder can never be rendered — there is no placeholder to render.
- **`peer-wiring.js`** — lazy-construct alongside the TunnelManager block
  (peer-wiring.js:111-121); `syncPeerManager` already filters
  `(s.peers||[]).filter(p => !p.disabled)` at :126 — feeding the same list to
  the web manager's `sync()` gives close #2 (removed/disabled) for free.
  Exports gain `openPeerWeb(id)` / `closePeerWeb(id)` (close #1, the toggle).
- **`engine.js`** — `let webTunnelManager = null;` next to :1548; get+set into
  `createPeerWiring`; `shutdown()` stops it at :1828 next to the peer tunnels
  (close #3); `getWebTunnelManager` on the return object next to :1845.
- **`ipc-handlers.js`** — web-tunnel statuses ride `peer:list` the way tunnels
  do at :1230-1235 (`st.tunnel`), plus open/close handlers and a
  `peer-web-tunnel` broadcast mirroring `peer-tunnel` (peer-wiring.js:118).
- **`api-contract.js` (NOT preload.js)** — preload is a 22-line loop over
  `API_CONTRACT`; a new method is a ROW, not a preload edit. Rows: the open,
  the close, and `onPeerWebTunnel` (`{kind:'on'}`, like :244).
- **`renderer/peers-ui.js`** — the ↗ button already exists for boxes
  (:189/:210-214 → `openBoxWeb` :105). The peer arm is a sibling gated on live
  `st.webHost` (peer-client.js:113 puts it in `status()`, so it rides
  `peer-state` — live, never a popover snapshot).

### One question to settle from the code before the UI arm is written

`tokenGated: true` must "say the box requires a token rather than hand over a
URL that will 401". Whether the honest response is *refuse and say so* or *say
so and still open* depends on what the web host actually serves an
unauthenticated browser: a **login form** makes opening correct (the user
authenticates there), a bare **401** makes opening a dead end. Read `web-host.js`
+ `auth-token.js` and let the answer decide — do not guess the gate. (Same rule
that produced `tokenGated` as a reported fact in t30a.)

## AMENDMENT from clodex (msg-93431-32) — for t32/t33, NOT for this ticket

Recorded here because it lands mid-t30b and must not be lost; **sequencing is
explicit: finish t30b ssh-only first, do not widen it.**

- **SETTLED, no longer open**: Clodex *reuses* `cli/src/transport.js` and never
  grows its own SSM/kubectl/gcloud/az dialing. Bogdan's point twice over: the
  reason clodexctl exists is to avoid a second implementation. Finding (D) is
  the design — `openTransport`'s `localPort` IS the pinned port, `waitExit()`
  is the respawn trigger, supervision stays Clodex-side.
- **SETTLED**: `cli/` ships in the DMG. Add `"cli/**/*"` to `build.files`;
  finding (B) is the reason it's necessary. Precedent in that list already:
  `scripts/clodex-team.js`, `scripts/clodex-monitor.js`. This overturns
  `cli/README.md:62`, so the README states the new position rather than a stale
  assertion. Verify with `asar list` on a real artifact, not the config.
- **Default is importing the module, not shelling out to a clodexctl binary**
  (no PATH assumption, no subprocess lifecycle, errors as values). A reason to
  prefer the binary is arguable, not assumed.
- **What remains open in t32 is ONLY the record/registry axis** — (a)/(b)/(c)
  as filed, with the token boundary at `contexts.js:28-31` load-bearing. Reused
  dialing is inert if a peer record cannot persist `{ssm:{target,region}}`.
- **t33 (the boundary gate) changes shape**: the app→cli half partly dissolves
  once `cli/` ships, but cli→app still needs pinning, and the gate must assert
  the NEW invariant — cli/ stays a leaf, and the app MAY import it *because* it
  ships. Do not silently drop half the test.

## Phase 2b — BUILT (commit `b4cce08`). Tests NOT written yet.

### The gate question, settled from the code (not guessed)

`web-host.js:383` answers an unauthenticated request with a bare
`res.writeHead(401).end('unauthorized')` — **no login form, no redirect** — and
`auth-token.js:38-51` only ever reads a token from `?token=` / `Authorization:
Bearer` / the `clodex_remote_token` cookie, **none of which a freshly opened
browser tab carries**. So for a gated box, opening a tab is a dead end the
operator cannot fix from the browser.

Decision: **open the tunnel, do NOT pop the browser, report the URL with what to
do with it.** The tunnel is still what makes the box reachable at all; the pop is
what would lie. Same reasoning as t30a's `tokenGated`: report the fact, don't
guess the outcome.

### What was built

- **`web-tunnel.js`** (new, electron-free, `spawnFn` injectable) — `WebTunnel` +
  `WebTunnelManager`. Three inversions vs `peer-tunnel.js`, each with its reason
  in the header: port **pinned once** (`_spawnTunnel` returns straight to
  `_spawnOn(this.localPort)` after the first pass — peer-tunnel re-picks at :99);
  **`firstUp` on ONE emit** (rides `_setState`'s `extra`, never the stored
  status, so a later `status()` read can't pop a second window); **give-up cap**
  (`GIVE_UP_MS` 120s from `start()`, retired — not merely reset — on first up,
  landing in a terminal `gave-up` that keeps `lastError`).
  `url()` is non-null only while `state === 'up'`, and `status().url` is produced
  there rather than assembled by consumers — so **there is no placeholder to
  render**; `http://127.0.0.1:1` has no analogue here.
- **`peer-wiring.js`** — `ensureWebTunnelManager()` (lazy: nothing constructed
  until someone looks), `openPeerWeb` / `closePeerWeb`, and `webPopAllowed`, a
  Set decided **before** the tunnel starts so the once-only `firstUp` emit can
  never race the token decision. `syncPeerManager` feeds the same
  already-disabled-filtered list to `.sync()` → close #2 for free.
- **`engine.js`** — `webTunnelManager` let + get/set into the wiring; a new
  `openExternal` seam (Electron: `shell.openExternal`; default: a logged no-op,
  since a headless box has no browser to pop); `stopAll()` in `shutdown()` →
  close #3; `getWebTunnelManager` + `openPeerWeb`/`closePeerWeb` exported.
- **`main.js`** — `openExternal: (url) => shell.openExternal(url)` seam.
- **`ipc-handlers.js`** — `peer:openWeb` / `peer:closeWeb`; `peer:list` hangs
  `st.webTunnel` next to `st.tunnel` (null = nobody asked to look).
- **`api-contract.js`** — three rows (`peerOpenWeb`, `peerCloseWeb`,
  `onPeerWebTunnel`). Pinned surface 222 → **225** in api-contract.test.js.
- **`renderer/lib/peer-web-view.js`** (NEW, pure leaf) — `webViewAffordance()`.
  peers-ui is DOM-bound and untested by the R1 rule, so every judgment that could
  be wrong lives here: phase, enabled, action, tip, and the rule that a URL is
  only ever the supervisor's live one. Added to RENDERER_SCANNED_MODULES.
- **`renderer/peers-ui.js`** — the ↗ for non-box peers, rendered from
  `webViewAffordance({status, tunnel, webTunnel})` — all three live. **The click
  re-reads the same decision**, so a peer that changed between paint and click is
  acted on as it is now. `onPeerWebTunnel` repaints and surfaces the URL on
  `firstUp` only. Seeded from `st.webTunnel` in the `peerList()` startup seed, so
  a reopened window doesn't offer a second forward to the same box.
- **ssh-only stated in the UI**, not hidden: a url-only peer gets a DISABLED ↗
  reading "reached by URL, not ssh — Clodex can only tunnel to a web UI over
  ssh". A silently missing button would read as "no web UI", a different and
  false claim.
- `renderer/styles.css` — phase tints (connecting/open/gave-up), so an open
  forward to a remote box is visible at a glance rather than only on hover.
- `npm run build:web` re-run (bundled renderer sources changed).

Affected tests green: api-contract, electron-boundary, peer-manager-sync,
free-identifier-leaks, peer, peer-tunnel, peer-disable.

### Phase 2c — tests to write, then prove EACH by reverting

1. **pinned port**: same local port across a respawn (the peer-tunnel inversion).
2. **firstUp exactly once** — and absent from a later `status()` read.
3. **give-up cap**: never-up → terminal `gave-up`, keeps `lastError`, stops
   spawning; and a tunnel that DID come up is not capped by it.
4. **no placeholder**: `url()`/`status().url` null in every non-up state.
5. **four closes**: toggle, sync-prune (removed/disabled), `stopAll`, cap.
6. **SECURITY-adjacent**: a `tokenGated` peer does NOT call `openExternal`, an
   ungated one does — written so it fails if anyone ever pops a 401.
7. **openPeerWeb refusals**: no such peer / url-only peer / no webHost — each
   refuses rather than guessing a port.
8. **affordance leaf**: phases, ssh-only disabled arm, and never a composed URL.

Baseline: **2600, ESCAPES: 0**.

## Phase 2c (part 1) — supervisor tests, and a DEFECT they found (`4433dd5`)

`test/web-tunnel.test.js`, 18 tests, all green. Structured around the three
inversions, because each has a specific way of silently regressing back into
peer-tunnel's behaviour.

### DEFECT in my own supervisor: the give-up cap could never fire

As first written, `_spawnOn` retired the give-up deadline on the FIRST `up`:

```js
const firstUp = !this._opened;
if (firstUp) { this._opened = true; this._deadline = 0; }   // WRONG
```

But `up` here means only *the ssh process is alive*. `ssh -N` prints nothing on
success, so a forward to an unreachable box is briefly `up` too — it reports up,
then dies. Every tunnel therefore reached `firstUp` on its very first spawn and
retired its own cap, so **close #4 could not fire at all**. The one close that
depends on nobody doing anything was the one that did nothing.

Fix: the clock is retired by SURVIVING, not by starting — a spawn that outlives
`_stableMs` resets both the backoff and the deadline (same threshold and the same
reasoning as `peer-tunnel.js`'s `STABLE_MS`, used for a different decision).
`firstUp` keeps its own job (the once-only browser pop) and no longer doubles as
a health signal. `_stableMs` scales with a supplied `giveUpMs` so a test can
exercise the "it worked" branch without a 30s wait.

Found because the test asserted the cap by DRIVING it, not by reading a flag.

### A harness trap worth recording (my own, twice)

`waitFor(() => tun.state === 'gave-up')` never fires on its own: the deadline is
only consulted when a spawn DIES, and a faked child stays alive until the test
kills it — correctly, since a tunnel whose ssh is up is not failing. So reaching
the cap requires failing the box repeatedly *across the real backoff*. Extracted
as `failUntilGaveUp(get, children, {stderr})`. The near-miss: had I "fixed" those
three tests by loosening the assertion instead of driving the state, the defect
above would have shipped green.

### What the 18 cover

pinned port across respawns (asserted on the ssh **argv**, not the field) ·
the pin surviving a down state · the honest-failure flags · `url()` null in every
non-up state · **the 127.0.0.1:1 sentinel never produced** · `firstUp` on exactly
one emit and absent from `status()` · `firstUp` per-tunnel (a re-open pops again)
· the cap firing with `lastError` kept · a tunnel that WORKED never capped ·
closes #1/#2/#3 · #2 on a re-pointed ssh host · refusals (no ssh host, and six
malformed remote ports) · idempotent re-open · replace-on-moved-web-port ·
retry after gave-up · per-peer `statuses`/`urlFor`.

### Still to write (part 2)

- **peer-wiring**: the tokenGated NO-POP assertion (gated → `openExternal` never
  called; ungated → called exactly once, with the supervisor's live URL), and
  `openPeerWeb`'s refusals (no such peer / url-only peer / no webHost).
- **the affordance leaf** (`renderer/lib/peer-web-view.js`): phases, the ssh-only
  disabled arm, and that no URL is ever composed.
- Then prove EACH by reverting, then the full suite (baseline 2600 + new).

## Phase 2c (part 2) + PROOF + suite — t30b COMPLETE (`ae1eab3`)

### Tests added (49 total, 2600 → 2650)

- **`test/web-tunnel.test.js`** (18) — the supervisor. See part 1.
- **`test/peer-web-open.test.js`** (14) — peer-wiring's half: the policy the
  supervisor deliberately does not know. The pop decision (gated → no browser,
  ungated → exactly one, at the supervisor's live URL), the pop riding `firstUp`
  only, the decision being re-taken per open (a box that gains/drops its token
  between opens), and every refusal (unknown peer · url-only peer · four shapes
  of absent webHost · never a guessed port). Plus: state reaching the renderer,
  close #2 riding the already-filtered list, and the manager staying UNBUILT
  under reconciliation alone.
- **`test/peer-web-view.test.js`** (17) — the affordance leaf. Both URL rules
  (no URL unless the supervisor reported one; the `127.0.0.1:1` sentinel never
  surfacing), all four phases, the ssh-only disabled arm, the token arm, and the
  full-shape guarantee so a repaint can't read undefined.

### A third-place inconsistency the leaf tests caught

`tokenGated` was read as `=== true` in peer-wiring but TRUTHY in the leaf. That
combination is the worst of both: a value like the string `'yes'` would have the
UI say "needs a token" while main popped a browser at a 401 — the two halves
disagreeing is worse than either rule alone. Now `=== true` in all three readers
(peer-client normalizes, peer-wiring decides the pop, the leaf writes the
message), with the reasoning in the code and a test that pins the agreement.

### Proof: 28 mutations, every one failing BY MESSAGE, none by crash

Script asserted the distinction explicitly — a mutation that only crashes counts
as UNPROVED. Result: **proved 28 / 28**.

pinned port re-picked → 1 · firstUp stored on status → 1 · firstUp on every up →
1 · **cap deleted → 3** · **cap retired on first up (the defect I shipped) → 3** ·
lastError dropped on give-up → 1 · URL from a pinned-but-down port → 2 (incl. the
sentinel test) · sync OPENS → 2 · close() leaves it tracked → 5 · stopAll leaves
children → 1 · guessed remote port → 1 · ssh-only refusal dropped (supervisor) →
2 · stale tunnel on a moved port → 2 · **pop a gated box → 3** · **pop decision
inverted → 3** · loose tokenGated in wiring → 1 · guessed port in wiring → 1 ·
ssh-only refusal dropped (wiring) → 1 · state broadcast removed → 1 · eager
reconciliation → 1 · unfiltered sync list → 1 · URL composed from localPort → 3 ·
ssh-only button hidden → 1 · loose tokenGated in the leaf → 1 · token message
dropped → 1 · give-up reason swallowed → 1 · open tunnel hidden when webHost
vanishes → 1 · unknown state read as closed → 2.

### Suite

**2650 / 2650, `ESCAPES: 0`** — verified by running `npm test --silent` directly
after the subagent's digest contradicted itself on the ESCAPES line (it claimed
the reporter emits no such line, then reported 0; the line comes from
`scripts/test-escapes.js` via `scripts/run-tests.js`).

Branch `peer-web-tunnel`, nothing pushed, master untouched.

- [x] t30b phase 1 — investigation, ruled.
- [x] t30b phase 2 — build, tests, proof, suite. Awaiting clodex's merge.
