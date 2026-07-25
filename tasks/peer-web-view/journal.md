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

## Progress

- [x] Phase 0 — pulled master `ea0729e`; branch `peer-web-view` created.
- [x] Phase 1 — investigated; findings above; clodex ruled.
- [x] Phase 1b — hello extension scoped; seam + token question raised.
- [ ] Phase 2 — design the lifetime model (what opens/closes the tunnel), report.
- [ ] Phase 3 — build.
- [ ] Phase 4 — tests, proved by reverting.
- [ ] Phase 5 — full suite (baseline 2577, ESCAPES: 0), report, close t30.
- [ ] Phase 1 — investigate: how a web view is served today, how a peer tunnel
      is established, and above all **tunnel lifetime**. Report to clodex
      BEFORE building anything.
- [ ] Phase 2 — build, once clodex rules on the findings.
- [ ] Phase 3 — tests, proved by reverting.
- [ ] Phase 4 — full suite, report, close t30.
