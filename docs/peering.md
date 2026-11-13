# Peering

One Clodex (the **consumer**) attaches to sessions on another Clodex (the
**owner** / "box") over loopback HTTP+SSE carried through an SSH tunnel or
tailnet. The same server also serves the phone web UI. Companion to
[architecture.md](architecture.md); DM federation semantics live in
[messaging.md](messaging.md) §4.

Reading guide for a change: **owner endpoints** → remote.js + the callbacks
built in remote-wiring.js · **consumer protocol** → peer-client.js ·
**tunnels** → tunnel-supervisor.js (one forward) + peer-tunnel.js (the set) ·
**settings reconciliation** → peer-wiring.js ·
**all UI** → renderer/peers-ui.js · **deploy** → peer-deploy.js + ssh-run.js.

## 1. Trust model (SETTLED)

- The server binds **127.0.0.1** unless `CLODEX_REMOTE_HOST` says otherwise;
  with no token, loopback trust is limited to requests whose Host, and Origin
  when one is sent, are loopback (`originRefusal` in auth-token.js, 403
  otherwise), so a web page in the operator's browser cannot drive the host,
  unless `CLODEX_REMOTE_INSECURE=1`, which lifts the token and the loopback-only Host
  requirement but still requires a loopback or IP-literal Host, so a DNS-rebound
  hostname is refused (a LAN hostname needs the token);
  a browser Origin, when sent, must match the Host with or without a token
  (`originMismatch`), so a page on another loopback port cannot ride the
  `SameSite=Strict` cookie; a forwarded port (ssh tunnel, tailnet share) still
  needs the token. A reverse proxy in front must pass the browser's Host
  through (`proxy_set_header Host $http_host;` in nginx), or every browser request
  fails `originMismatch` with 403.
  `_authGate` fronts the whole peer surface with the shared secret
  `CLODEX_REMOTE_TOKEN` (401 when one is set and the caller lacks it) and
  refuses a non-loopback bind with no token (503) unless
  `CLODEX_REMOTE_INSECURE=1`. Every endpoint that reads a JSON body answers
  415 unless the body is `application/json`.
- **Only input and resize are token-gated** (single-holder control token) —
  that stops a read-only viewer typing by accident, not an attacker.
  Control *acquisition* is un-gated, last-wins ("both laptops are the same
  operator"); a token gate on restart/create would be theater since acquire
  itself is open.
- Identity comes from response content (`app:'clodex'` + host in hello),
  never from the port.

## 2. Owner side (remote.js `RemoteServer`)

Plain Node http+SSE, zero deps. Clodex behavior is injected as callbacks
(built in remote-wiring.js `syncRemoteServer`); an absent callback 501s its
endpoint and drops the matching capability from hello. The transcript on
disk is the source of truth — SSE signals "changed", clients refetch.

Endpoints: phone page (`/`), `GET /api/sessions|events`
(global SSE), `GET /api/resources` (the node's resource/verb document —
`{ok, version, resources}`, now `version: 5`, filtered to what this node's
injected callbacks actually serve; advertised as the `resources` cap, which is
unconditional),
`GET /api/sessions/:name` (one session, `{ok, session}`; 404 unknown or dead; every
session row carries `io: 'stream'|'pty'`),
`GET /api/sessions/:name/transcript?limit&since&after` — `limit` 1..500 (default 100, clamped), `since` a `seq` floor (int ≥ 0), `after` an ISO-8601 instant (rows with a `ts` before it drop, rows without `ts` stay; a malformed value is `400 {ok:false, error:'bad after (expected an ISO-8601 instant)'}`); answers `{ok, messages, cursor, complete}` where `messages` are `{role, text, ts, seq, interim?, images?, client?}` (the last `limit` after the filters), `cursor` the `seq` of the last user message; a live seat serves its current CLI transcript; a sleeping assistant serves the concatenation of every recorded awake period's transcript (its `retiredSessionIds` then its `sessionIds`, oldest first, `seq` renumbered — the record keeps the last 20 ids in `sessionIds` and retires older ones to `retiredSessionIds`; a non-Claude assistant has no transcript handling yet and serves an empty history), so a `202 {queued}` reply is fetchable after the seat sleeps without holding SSE; `seq` restarts when a seat wakes (one CLI file per awake period) — `after=<iso>` is the cursor that spans sleeps (a user message with attached images carries `images: [{n, mediaType, data}|{n, mediaType, bytes}]`, thumbnailed to 256px on a desktop host, advertised as the unconditional `transcript-images` cap),
and `GET /api/sessions?workspace=<name or id>` (the list narrowed to one
workspace; an unknown value is an empty list), `GET /api/workspaces` (this
node's workspaces — `{id, name, open, lastFocusedAt}`, no window geometry),
`GET /api/peers` + `/api/peers/:id` (this node's peers, composed with their
tunnel and webTunnel status as the GUI's own list is — the list rows drop the
per-peer `sessions` array and the single get keeps it), `GET /api/teams` +
`/api/teams/:name` (this node's teams — the list is `{name}` rows, the single
get is the manifest plus live `activity`), `GET /api/tickets` +
`/api/tickets/:id` (every team's board, each row tagged with its `team`;
`?team=NAME` and `?state=open|done|cancelled|all` narrow it, default `all`, any
other state is a 400 — a ticket id is unique per team, so a bare id that exists
on two boards answers 400 `{error:'ambiguous ticket id', candidates}` and
`?team=` picks one), `GET /api/sandboxes` + `/api/sandboxes/:id` (this node's
containers — the list is `{id, label}`, the single get adds `state`, `ref`,
`sha` and `ports`; a node running inside a sandbox box has no sandbox manager,
so both 501 and the resource is absent from `/api/resources`), `GET /api/agents` +
`/api/agents/:name` (the subagent library — the list is the per-agent metadata,
the single get is `{name, content}`), `GET /api/worktrees?repo=` (the git
worktrees of the repo containing an ABSOLUTE `repo` path — 200
`{ok:true, repo, worktrees:[{path, branch, head, isMain, detached, locked,
prunable}]}`; a missing or relative `repo` is a 400
`{error:'repo must be an absolute path'}`, a path in no git repo a 404, and a
node wiring no worktree callback 501s with the resource absent from
`/api/resources`; the returned `repo` is git's TOPLEVEL for the path asked
about, not the path itself, so a request naming a subdirectory answers with the
anchor its worktree paths share),
`GET /api/peer/hello` (identity + caps + `dmOrigins` +
`srcDir` + `webHost` + `wirescope`), `GET /api/sessions/:name/attach` (per-session SSE: b64 scrollback replay
+ telemetry seed), `POST /api/sessions/:name/control|input|resize` (input+resize
token-gated; out-of-range resize is a 400), `POST /api/sessions/:name/query` (pull-on-demand
popover data; kind whitelist lives in the injected callback — `files` answers
`{ok, cwd, files, filed}` where `filed[]` is the seat's spilled intent bodies,
handoffs and inbound message spills, newest first, capped at 50 independently of
`files`, each `{path, kind, head, bytes, ts}` with `path` byte-identical to the
transcript literal (entries seeded from disk after a restart carry kind
`intent` for every spill-dir file, a handoff being indistinguishable there); `filePeek` takes `{path, offset?, length?}` in bytes,
clamps `length` to `PEEK_MAX_BYTES`, echoes the range it returned with the cut
pulled back to a UTF-8 boundary, and fails with `{ok:false, code, error}` —
`outside` 403, `not-found` 404, `gone` 410 (listed in `filed` but since
removed), `not-a-file` 400 (dir, device, or a symlink — refused over this
server only), `unreadable` 500 — confinement decides `outside` before
existence is consulted, so a missing path outside the roots is `outside`, never
`not-found`; `filePeek` and `fileDiff` over
this server read only the seat's resolved cwd, `<REGISTRY_DIR>/spill/<seat>/`,
`<REGISTRY_DIR>/messages/<seat>/` and the project's
`<REGISTRY_DIR>/projects/<leaf>-<hash>/tasks/`, checked on the real path so a
symlink inside cwd cannot escape; the `filed` cap string advertises all of
this),
`POST /api/sessions/:name/dm` (operator message — the session is named by the
PATH; a `name` key in the body is ignored; body `{text, images?}` with
`images: [{mediaType, data}]`, at most 5, `image/png|jpeg|gif|webp`, base64
`data` of at most 5 MB decoded each, checked by `validateSeatImages` in
seat-images.js — a bad array is a 400 with its error string, and an empty `text`
is allowed when images are present; this route's body cap is `DM_MAX_BODY`
(five 5 MB images in base64 plus 64 KB; 413 above it, delivered as a connection
reset once the body is cut off, so encode without escaping `/` — Swift's
`.withoutEscapingSlashes` — or five near-5 MB images overrun it) where every other
route stays at 64 KB; a stream seat gets the images inline, a pty seat gets each one
written to `<REGISTRY_DIR>/messages/<seat>/img-<ms>-<n>.<ext>` (the messages
spelling is a link into `sessions/<seat>/messages/`, so a client that resolves
the path sees the latter) and one `Image: <path>` line per file appended to
the delivered text — the claude CLI folds that line into an `[Image #n]`
attachment marker in front of the text in the transcript it writes, so a
client confirming delivery by transcript must match the text, not the path
line; advertised as
the unconditional `images` cap; a delivery that fails on the box is a 500
`{ok:false, error}`, and only a missing seat is a 404; optional `ref` (≤128 chars of `[A-Za-z0-9._:-]`, else `400 {ok:false, error:'bad ref'}`) echoed top-level on the answer and returned in `turn.refs`; every `ok` answer carries a top-level `ts` (ISO, the node's clock, stamped before delivery), which `clodexctl exec` on a sleeper uses as its `after=` floor (a node older than 5.157.0 sends no `ts`, so the CLI falls back to its own clock and a skewed node may still drop the reply — loudly, as a non-zero exit); body `await: <ms>`
(capped at 60000) holds the reply for the turn: `200 {ok, turn}` with the turn
below, or `202 {ok, queued: true}` on timeout or seat death, or at once for a pty seat, whose turns the box cannot observe; a dm to a sleeping
assistant wakes it first, a refused wake forwards its `code`, 503 by default),
assistant-class seats under the `assistant` hello cap (sleep + wake wired):
`GET /api/sessions?state=asleep|all` (asleep lists only sleepers, all appends
them to the live rows, anything else is a 400) and `GET /api/sessions/:name`
answer a sleeper row from its record (`class: 'assistant', state: 'asleep',
activity: 'asleep', asleepAt, sleepReason, template, sleep, cost, wakes, memory`, a
null `activityTs` and null stats); a live assistant row adds `class: 'assistant',
state: 'awake'|'sleeping'` (sleeping = still closing after sleep), `template, sleep, cost, wakes, memory` (`memory: {profile: <bytes|0>, profileUpdatedAt}`); `POST /api/sessions/:name/sleep`
(200 asleep, 202 sleeping when mid-turn, 409 not an assistant / not awake),
`POST /api/sessions/:name/wake` (200 awake, 409, `code` forwarded; at the template's `sleep.maxAwake` with no idle sibling to evict, `503 {ok:false, code:503, error:'at capacity', retryAfterMs:30000}`),
`GET /api/sessions/:name/memory` (`{ok, name, units, brief}`; 404 unknown, 409
not an assistant); `GET|PUT|PATCH|DELETE /api/sessions/:name/memory/profile` (the seat's
profile document, docs/messaging.md §5 Profile: GET `{ok, name, profile, yaml, bytes, updatedAt}`,
`Accept: text/yaml` → the YAML or 204; PUT/PATCH JSON `{game?, notes?}` or `text/yaml`, `?merge=0|1` (default 1, merge by key, for PUT and PATCH alike; the seat's own notes are capped at 2048 bytes so `game:` can always grow);
DELETE `{ok, existed}`; 404 unknown, 400 not an assistant / invalid / over 4096 bytes); `PUT /api/sessions/:name/client-token` with `{token: string|null}`
sets the seat's game client token (`[\x21-\x7e]{16,512}`, written 0600 to
`sessions/<name>/client-token`; 200 `{ok, set:true}`), clears it on null or `''`
(200 `{ok, set:false}`), 404 for an unknown seat, 400 `bad client token`; a create
body's `client.token` sets it the same way after the spawn, answering `clientToken: true` (a bad one is a 400 and
nothing spawns; a team-lead create refuses any token with a 400; a write that fails after
the spawn answers ok with `clientToken: false` and `warnings: ['client token not stored']`, so set it again with this
PUT); the token file is read-denied inside the credential sandbox and is injected only into exec children's env, as `CLODEX_CLIENT_TOKEN`, never
an answer, the record or the CLI env; a seat without protectCredentials can read any seat's token file; SSE `proposal` `{name, cmd, id, payload}` when
the seat runs an exec def marked `proposal` (the player confirms it in the game;
nothing runs on the box; the event is best-effort, dropped when no client is connected, and
`turn.proposals` is the durable record); SSE `turn` `{name, text, intents, refs, proposals, costUsd, durationMs,
isError, ts}` after each assistant turn (`text` is the prose of the CLI's final
result, `intents` the `{type, sub?, cmd?}` heads, never bodies, `refs` every dm `ref` written since the previous turn, always a list, `proposals` every `{cmd, id, payload}` proposed since the previous turn, always a list); a dm to a sleeper whose `sleep.wakeOn` is a list without `'message'` is a `409` and wakes nothing; a reminder firing on a sleeper whose `sleep.wakeOn` lists `'reminder'` wakes it and the reply arrives as an unsolicited `turn`; create
`{name, template, cwd?}` spawns from a library template name only; DELETE on
an assistant destroys it (record, seat dir with memory and brief, the CLI
transcripts for both its live `sessionIds` and its `retiredSessionIds`, `pending/<name>`; answers
`{destroyed, transcripts}` with the count actually unlinked, plus `untracked: <n>` for the ids of a
non-Claude assistant, whose transcripts are not handled yet), `POST /api/restart` (app relaunch —
response written before the restart fires), `POST /api/sessions`,
`DELETE /api/sessions/:name`, `POST /api/sessions/:name/restart` (remote
create, destroy (same as Delete Session…; a worktree that cannot be removed answers `worktreeRemoved: false, kept: true, path, error`) and restart — all under the `create` cap, shipped together),
`GET /api/sessions/:name/args` + `PATCH /api/sessions/:name/args` (Edit Session
over the wire: read editable args + the box's dialog catalogs, apply an edited
patch with kill+respawn on `restart:true`) and `GET /api/sessions/:name/skills` +
`PATCH /api/sessions/:name/skills` (Edit Skills over the wire: read the box's skill
catalog, persist the disabled/inject sets — a separate `POST /api/sessions/:name/restart`
applies) — all four under the `args` cap, shipped together — and `POST /api/dm` (optional `ref`, echoed in the response, deduped 10 min per origin+from; a malformed one is a 400; optional `task` envelope `{kind:'done', id:'tN'}` closes that ticket on the board and is answered in the response's `task.reply`, anything else is a 400) +
`/api/dm/claim` (federation, `dm` cap; a claimed record carries `ref` and `task` when the enqueued one did) and `POST /api/peer/roster` (hub-relay
federation, `relay` cap — the hub pushes this spoke the roster of agents on its
OTHER relay-enabled peers; see messaging.md §4a) and the operator inbox —
`GET /api/inbox?limit=&before=` (newest-first page + `unread`; limit clamped
1..200, default 50), `GET /api/inbox/unread`, `POST /api/inbox/read/:id`
(idempotent, 404 unknown), `POST /api/inbox/read-all` (`marked`),
`POST /api/inbox/remove/:id` (404 unknown) — all five under the `inbox` cap,
which is present only when the notifications store is injected.
Under the `requests` cap (present only when the store, `openRequests` and
`replyNote` are all wired) the inbox gains three additive pieces: `GET
/api/inbox` adds `requests` (open permission dialogs `{name, workspaceId, ts,
message, pending}`, oldest first), `open`, `at` and `blindSeats`, and each note
gains `kind` (`'shout'|'other'`) and `replyable`; `GET /api/inbox/unread` adds
`open`; `POST /api/inbox/reply/:id` body `{text, client?}` answers a shout via
`manager.replyToNote` with the same client-tag spoof check as the dm route —
200 `{ok, id, repliedAt}`, 400 `empty`/`too-long`/`not-replyable`, 404
`unknown`, 409 `gone`/`unavailable`/`delivery`. A named `attention` SSE event
`{name, workspaceId, kind, ts}` fires on every dialog set and clear (`kind`
and `ts` null on clear); it is a trigger to re-read `/api/inbox/unread`.

Inbox changes push an `inbox` SSE event on `/api/events`:
`{kind:'added'|'read'|'read-all'|'removed'|'replied', id?, unread, note?}` (`added`
carries the full note). It is emitted from the STORE's `onChange`, not from the
routes, so a desktop-side mark-read moves the phone's badge and vice versa.
A peer entry marked `inbox: 'claim'` (set by the sandbox on its OWN box, and on
nothing else — a laptop peer's inbox belongs to its own operator) has its notes
COPIED onto the local inbox as `<seat>@<origin>` on that `added` event and on
every hello, then marked READ on the box — the note stays where the seat raised
it, so the box UI still shows the operator what they were told, while the badge
that nags is the desktop's alone. The read-mark is also what makes the claim
idempotent: only notes with `readAt == null` are claimed, so the next doorbell
or hello over the same page re-delivers nothing. Only a note the desktop stored
(`note.stored`, set by `_deliverClaimedInbox`) is read-marked; one whose store
threw stays unread and is retried, and a note re-delivered after a crash between
store and read-mark is deduped by its `<origin>:<id>` `sourceId`.

**The node itself** is a target with no resource row to advertise it.
`POST /api/restart` relaunches the ENGINE — the whole Clodex app on that
box, not a session — and is what `clodexctl restart node` spells; the response
is written before the restart fires, so a caller gets its 200 and then the
socket dies, which is success, not a transport fault. It is destructive to
every live seat on the box, so the CLI gates it behind `--force` in
`-o json|yaml`/non-interactive mode. The per-session cousin,
`POST /api/sessions/:name/restart`, restarts one seat and rides the `create`
cap instead; it wakes a sleeping assistant, and an assistant at its awake cap
answers 503 with `retryAfterMs`.

`version` in the resources document is a DOCUMENT revision, bumped when routes
move under existing rows — it went to `2` for the route moves that
shipped under `1`. It is deliberately NOT a compatibility gate: clodexctl asks
whether the resource and verb it wants are present in `resources`, never what
the number says, so an older node's `version: 1` document is accepted as long
as it carries the row.

Fan-out from the session manager (cheap no-ops when unattached):
`pushOutput` (4MB backpressure → destroy the stream — a half-open tunnel
renders stale-as-live), `pushTelemetry` (partial `{proxy}`/`{ctx}`/`{files}`
frames, client merges), `pushUiEvent` (small `{kind,args}` trigger, never
content — the viewer pulls via query; `file open` is never mirrored),
`notifyResize` (80ms trailing debounce + dedup), `notifyExit`,
`notifyActivity`/`notifyProgress` (bodyless `{name}` nudge per main-line request,
so the phone refetches interim text mid-turn)/`notifySessions`/`notifyDmMail`.

Notable callback semantics (remote-wiring.js): `createSession` routes the
live `manager.create()` (persists like `[agent:spawn]`); `restartSession`
routes the shared engine.js helper; `deliverDm` runs the same `_gatedDeliver`
cost-gate as local mail; `resizePty` tags `manager.resize(..,'peer-control')`
so the ops log can arbitrate perturbation reports; `onControlChange` chips
the owner's tab — control is never silent. Bash sessions are IPC-private
but **peer-visible** (attach/control/create work; DM and query don't).

- A `POST /api/sessions` body of `{ name, team }` takes a different arm: the
  receiving host looks `team` up in its OWN team manifest and spawns that team's
  lead through the local spawn handler, so template, prompts, exec grants and
  intents all come from the host's disk. Nothing else in the body is read (no
  `cwd`, `extraArgs`, `env`, `intents`, `execCommands`), and a `name` other than
  the manifest's lead is refused.
- A body of `{ name, template }` spawns from a library template through the same
  handler. The shipped one for game assistants is `clodex-assistant`; an
  assistant template with `sleep.maxAwake` first makes room like a wake does,
  else answers `503 {ok:false, code:503, error:'at capacity', retryAfterMs:30000}`.
- `CLODEX_REMOTE_CREATE=template` on the host refuses every create that names no
  template: `403 {ok:false, code:403, error:'create: this host accepts template creates only'}`.
  It also accepts only templates of `class: 'assistant'`, else
  `403 {ok:false, code:403, error:'create: this host accepts assistant templates only'}`,
  ignores the caller's `cwd` (the template's wins), and refuses seat import at
  begin and at commit with `403 {ok:false, code:403, error:'import: this host accepts template creates only'}`.
  Unset, or any other value, keeps bare and team creates.

## 3. Consumer side (peer-client.js)

**Unreachable is normal** (laptops sleep) — offline is calm, never an error.

`PeerConnection`: hello loop every 15s (`HELLO_INTERVAL_MS`). On wake:
refresh sessions, open the events feed, re-establish wanted attachments.
`identityChanged` (version/platform/srcDir/caps compare) forces a
`peer-state` emit even without an offline dip — an in-place update restarts
the box faster than the 15s cadence can observe, and the renderer would
otherwise keep a stale version forever. DM claims ride every hello tick
plus the `dm-mail` doorbell. `/api/events` also carries `filed {name}`, fired by
every writer that files a spill for that seat (wire-tee intent spill, context
handoff, inbound message spill): a payload-free refetch signal for `files`.

`needsUpgrade` is the dialect flag on `status()`: true when the far side is
online but too old to serve the sessions subresource wire. It is computed by
one `GET /api/resources` per hello IDENTITY, not per tick — `identityChanged`
already re-fires on every version or caps move, which is every way the far
side's dialect can change under a live connection. A hello with no `resources`
cap is classified true without the round trip. While it is true `_openAttach`
refuses to open the SSE at all: every attach on such a node 404s, and the
backoff would hammer it forever — so clearing the flag is what re-opens every
wanted attachment, since the probe is async and the hello's own re-open loop
runs while the flag is still true. The renderer shows `needs upgrade` in the
peer header and offers the existing Update Clodex button.

**Split HTTP agent pools are load-bearing** (SETTLED, fixed a live bug):
short requests use a keepAlive pool (8 sockets); SSE streams use an
un-pooled agent. One shared pool let a few attaches pin every socket and
starve control/input — dropped keystrokes and minutes-late stale acquires.

Attach streams reconnect with 1s→20s doubling backoff; **replay is
best-effort scrollback, not terminal state** — clients reset before
applying and re-replay (never resume) on reconnect.

**A wterm want is owned by a WINDOW and dies with it.** Each `_wterms` entry
carries an `owners` set of workspace ids (recorded from the IPC sender, strict —
an unresolvable sender is refused on BOTH doors, never defaulted: an open filed
under a placeholder could never be dropped, and an anonymous close can neither
be swallowed nor honoured without harming one case or the other); the stream is
torn down only when that set empties, so one window hiding a seat cannot detach
another window watching it. Both edges where a renderer stops existing drop the
window's wants — `did-start-navigation` (reload) and the window's `closed`
handler — because the renderer's own release edge runs off renderer state and
cannot survive either. Those drops tear down locally and send no close POST:
the owner sheds on the socket close, and a POST in flight would drop every
watcher of the seat, including a re-opened one.

`PeerManager.sync` reconciles from settings: a URL, label, token, inbox or
destination change = stop+restart that connection; removal emits
`peer-removed`. **`peer-removed` fires even on these edits** (attachments died
with the old connection — the UI must shed its tabs; the new connection
re-announces). The one exception is a managed (ssh/cloud) peer whose tunnel
respawns: only its local tunnel url moves while its destination key
(`resolvePeerUrls`' `dest`: sshHost or cloud block, plus remotePort) is
unchanged, so the connection is re-pointed and keeps its tabs, wterms and
control claims. Editing the target box changes `dest` and restarts.

`TunnelManager` (peer-tunnel.js) holds one `SupervisedTunnel`
(tunnel-supervisor.js) per ssh-configured peer — the supervisor carries the
forward, the manager decides which forwards should exist. While a tunnel is
down the peer keeps a dead-placeholder URL
(`http://127.0.0.1:1`) so the connection object and sidebar presence stay
alive-but-offline.

**Suite claims (the runner side of §2e).** peer-wiring.js gives every
`PeerConnection` a `suite-claimer.js` claimer (`suiteClaimerFor`). It rings on
every hello tick and on a `suite-mail` doorbell naming this node's label (its
own arm in `_openEvents`, not tied to dm claims or `identityChanged`). A ring
claims only when the peer row's label has a run grant (`runGrant(...).serve`),
the hello carries `suite-pull` and this node's engine exists; the engine is
reached through remote-wiring's lazy `getSuiteEngine`, so runner mode works
with remote access off. Each claim sends the claimer's `session`, minted once
per connection. Only the claim fetch is serialised: claimed calls run
concurrently, at most 4 at a time (`CLAIMER_CONCURRENCY`), and a `DELETE`
(cancel) bypasses that bound, so it never waits behind a long poll. A call
with a blob fetches it first (`suiteDeskBlob`, a raw GET capped at 4 MiB plus
64 KiB). A call whose deadline (receipt time plus `ttlMs`) has passed is not
executed. Everything else goes through `suiteDispatch` against the current
engine, so a call outside the suite verb table is answered 404, and the answer
is posted with `suiteDeskReply`. A reply the desk refuses is logged and
dropped; the lead's own retry reissues the request.

- While the schedule is closed (`admit` false) a `POST /api/suite/jobs` is
  answered 503 `offer closed`; poll, output and cancel for existing jobs are
  still served.
- When the grant is withdrawn (offer off, scope back to discovery, or the
  peer unticked), the next ring cancels every job this claimer submitted and
  claims stop.
- The announce to a peer says scope `run` only while the hello carries
  `suite-pull` and the engine exists.
- `offer:get` carries `claims`, one row per ticked peer under a run offer:
  `claiming` with `lastClaim`, `not-connected` or `runner-off`. Preferences ▸ Test boxes ▸
  Offer test boxes shows them as status lines.

### 2a. Web view + the wirescope forward (t30b, t443)

Two hello fields advertise loopback services a consumer may FORWARD to, both
validate-or-null and both refusing rather than guessing (t30a): `webHost`
(`{port, tokenGated}` — the browser frontend; `tokenGated` says a token is
required and never what it is) and `wirescope` (`{port}` — the box's own wire
dashboard, gated on `WirescopeSupervisor.localReach()` so a box with the proxy
off or `CLODEX_WIRESCOPE=off` advertises nothing). A peer too old to send
either degrades to "no forward" — never to a default port.

`openPeerWeb` (peer-wiring.js) raises **two** forwards through the same
`web-tunnel.js` policy (pinned local port, TCP-accept probe, give-up cap):
the web view, and a companion one to the box's wirescope. The web view opens
in its own sandboxed Clodex window (`openRemoteWindow`, key `peer:<id>`), and
closing that window closes the tunnel. An open window is recorded in
ui-settings `peerWebOpen` with its last bounds, and reopens once per boot on
the peer's first online `peer-state`; a quit does not count as closing it.

The companion exists because the page is served BY the box, so its dashboard
links are built against the box's loopback wirescope. Unforwarded, the
operator's browser resolves them against ITSELF — where a local wirescope is
usually listening on the same default 7800 — and shows them their own dashboard
under a foreign session id. Confidently wrong, not visibly broken.

Rules, in order of what breaks if they go:

- **Subordinate.** It is raised with the web view and torn down with it, and it
  may never be the reason the web view fails: no wirescope on the box is a
  normal quiet case (the frontend opens with no dashboard link), and every call
  into it is wrapped.
- **Torn down on the web view's TERMINAL states too**, not only on
  `closePeerWeb`. A web tunnel that reaches `gave-up` has no caller behind it and
  the affordance renders `action: 'open'` at that state — so there is no close
  button left, and a companion that ignored it would keep republishing the box's
  unauthenticated wirescope on this machine's loopback for the life of the
  process. `down` is deliberately not terminal: it is one respawn from `up`, both
  ports are pinned, and only a fresh ↗ click re-raises the companion, so tearing
  it down on a blip would cost the link permanently.
- **Separate supervisor** from the web view's. The web manager's state is
  broadcast on `peer-web-tunnel`, which the renderer reads as the ↗ button's
  phase; a second tunnel emitting there under the same peer id would drive the
  button from the wrong forward.
- **Raised first**, because the browser pop reads its pinned local port when it
  composes the page URL, and a port picked after the pop is one the tab never
  learns.
- **Not raised for a token-gated box.** No pop means no URL is composed, so the
  forward would have no consumer — and t30b's decision stays where it is rather
  than being re-derived.

The local port reaches the page as `?wirescope=<port>`, the only channel into a
tab the box served. A PORT, not a base: `api-shim.js` composes `127.0.0.1:<port>`
from it, so a crafted value cannot re-point dashboard links at another origin.
That local base **wins over** the welcome frame's `wirescopePublicBase` — the
box's own idea of where it is publicly reachable is by construction not
reachable from a viewer on the far side of a tunnel.

`wirescopeBase()` is the SINGLE reader of that welcome field, and the base it
returns feeds BOTH t442's reachability gate (`unreachableProxyUrl`, which
suppresses a dashboard link with no base to rewrite to) and the rewrite itself.
That is not tidiness: if the gate read the raw welcome field while the rewrite
read the forward, a live forward would still be judged unreachable and
suppressed — the two tickets would cancel out, silently, in the one state they
were both built for. A source-level test in `test/api-shim.test.js` pins the
single-reader rule.

### 2b. Seat import (owner side, M-A2)

Move-to-peer's destination half. The moving box is the CLIENT; this box stages
what arrives under `<REGISTRY_DIR>/import/<id>/` (seat-import.js, M-A1) and then
spawns the shipped record as the SAME seat. Cap `import`, advertised only when
remote-wiring injected BOTH a `seatImport` and an `importCreate`; without either
every route below answers 501 `{ok:false,error:'import not supported'}`, so a
half-wired box never stages bytes it could not then commit. All four sit behind
`_authGate` like every other route — the file route included, which is the one a
wiring mistake would most plausibly leave open.

- `POST /api/import/begin` `{name, record}` → `{ok, id, dropped}`. Refuses
  before any staging dir exists when the name is live or persisted here
  (`importCreate.check`), as well as on seat-import's own dir collisions, and
  when `record.cwd` cannot be a folder on THIS box: its parent must exist and be
  a directory (the leaf may be absent — `importCreate`'s `ensureDir` makes it),
  the path itself must not be a file, and it must not fall inside this box's
  `REGISTRY_DIR`, `~/.claude` or userData (`refuseUnder`, passed in by
  remote-wiring so the module stays pure). Each refusal is a sentence the far
  OPERATOR reads in the move dialog and names this box by `hostLabel`. A wrong
  far path therefore costs nothing: the source has not quiesced yet, no staging
  dir was opened, and nothing is left behind to clean up on a retry.
- `PUT /api/import/<id>/file/<relPath...>` — RAW body, not JSON. Per-request cap
  `IMPORT_CHUNK_MAX` = 4 MiB (413 past it); `offset` from
  `Content-Range: bytes <start>-<end>/*`, absent header = 0. `<id>` must match
  `^[0-9a-f]{16}$` at the route as well as in the module. Reply `{ok, size}`.
- `POST /api/import/<id>/commit` — installs, then calls the injected
  `importCreate`, which seeds the shipped `createdAt` into persistence before the
  far `create()`. Reply `{ok, name, pid, cwd, sessionId, installed, dropped}`. If the
  install succeeded and the create did not: 500 `{ok:false, error, installed}`
  and the files STAY on disk — the transcript is the expensive thing, and the
  client can retry the spawn alone through `POST /api/sessions` with `resumeId`.
- `DELETE /api/import/<id>` — abort; the staging dir goes.

Trust posture is the remote-create posture, unchanged: the peer token is the
auth, `execCommands` is forced `[]`, intents go through
`withoutPrivilegedIntentsFor`, env through `sanitizeFlat`. The ACCOUNT is mapped
by LABEL, never by path — `record.accountLabel` is looked up in this box's
accounts and `env.CLAUDE_CONFIG_DIR` is rewritten to the far dir on a hit; a miss
deletes the key (far default account) and reports `account:<label>` in `dropped`.
A source-box config path never reaches `create()`. Transcript bytes are opaque:
staged, hashed, installed, never parsed. Logs carry sizes and names only.

Consumer half: `PeerConnection.importSeat({name, record, files, onProgress})`
drives begin → chunked PUTs → commit and aborts on any failure, streaming a file
from disk in 4 MiB reads rather than loading a transcript whole. It is a wrapper
over `importBegin({name, record}) → {ok, id}` and `importShip({id, files,
onProgress})`, split so a caller can ask begin to JUDGE the record before it
pays for anything — `moveToPeer` probes with `importBegin` before it quiesces,
and `importAbort(id)` reaps the staging that probe opened on the arms that never
ship. `_requestRaw` is `_request`'s sibling for the non-JSON leg (same auth
headers). `canImport` rides `status()` next to `needsUpgrade`. A commit whose
reply is lost (`importShip` → `{unreached:true}`, no DELETE) is settled by
the commit itself: a `GET /api/sessions/<name>` probe (`sessionGet`) that finds
the seat is a cheap landed shortcut, but a 404 there proves nothing (the box
answers from its live map, before a still-running create registers the seat).
Otherwise `moveToPeer` re-POSTs the commit on the same staging id
(`importShip({id, files: [], retry: true})`, which never DELETEs). The box keeps
one in-flight promise per staging (`_handleImportCommit`), so a re-POST during
the first commit's create answers that create's result, and one after it answers
`unknown staging`. `ok` takes the success arm; any reached refusal (unknown
staging or other) and an unreached re-send both archive the local copy as
`unknown` without a respawn. A local respawn happens only for a refusal the box
returned to the ORIGINAL commit.

### 2c. Suite jobs (owner side: runner mode)

A node started with `CLODEX_SUITE_RUNNER=1` is a test runner: remote-wiring
builds one `suite-runner.js` engine (`suiteRunnerOptions`: work root
`CLODEX_SUITE_WORK`, default `/var/lib/clodex-suite` on Linux and
`<Clodex home>/suite-work` on macOS; `CLODEX_SUITE_ISOLATION=none`
for a loopback throwaway box; `CLODEX_SUITE_PACK_MAX_MB`, default 1 GiB) and injects it as
`suiteRunner`. Without it every `/api/suite/*` route answers 501 and hello
carries no `suite` cap.

The same choice is stored as the ui-setting `suiteRunner`
(`{ enabled, isolation: 'user'|'none', work: <absolute path>|null, boxImage? }`, default
`null` = off; `sanitizeSuiteRunner` in stores.js loads an invalid or absent
record as off). `boxImage` is optional: an image id `sha256:<64 lowercase hex>`
for box jobs; a tag or any other string invalidates the record, and null or
absent is stored as no key. Preferences ▸ Test boxes ▸ Test runner edits it through the
`suiteRunner:get` / `suiteRunner:set` IPC, registered under the
`enableTestBoxes` seam on both hosts, so the browser view of a headless node
(operator token) can make it a runner; `settings:set` drops the key, and no intent, clodexctl
command or remote route writes it. Each env var, when set, wins over its field:
`CLODEX_SUITE_RUNNER=1` forces on (any other value forces nothing),
`CLODEX_SUITE_ISOLATION` forces isolation, `CLODEX_SUITE_WORK` forces the work
root, `CLODEX_SUITE_BOX_IMAGE` forces the box image (a value that is not an
image id forces it to none); `suiteRunnerOptions` returns the forced fields as `forced`,
the image as `boxImage` (null when unset) and the UI
shows them as "set by environment". A save applies without a restart
(`reloadSuiteRunner` closes the old engine and rebuilds the remote server, so
hello caps follow) and is refused while a job is live (`busy()`).

The job's PATH is a fixed list (`jobPath`), never the node's own:
`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, with
`/opt/homebrew/bin:/opt/homebrew/sbin` ahead of it on macOS arm64. Its `LANG`
(`jobLang`) is `C.UTF-8` on Linux and `en_US.UTF-8` on macOS, which has no
`C.UTF-8`. That locale is the `lang` stamped in the runner's `env` (`envIdentity`).
The job env sets `GIT_CEILING_DIRECTORIES` to the job dir, in both isolation
modes, so git inside a job finds the job tree but no repository above the job
dir; a submit cannot override it. A work root inside a git work tree or a `.git`
dir is refused at start: runner mode stays off with a reason naming the
enclosing repository's top level.

When runner mode is asked for (setting or env) but the runner cannot be built (most often
an uncreatable work root), runner mode stays off and `startSuiteRunner` logs one
`suite-runner` error naming the cause, the work root and `CLODEX_SUITE_WORK`.
The same text is the `reason` field of the 501 every `/api/suite/*` route
answers, so `GET /api/suite/info` shows it without the log.

- `GET /api/suite/info` → `{ok, bootId, env, isolation, limits:{packMaxBytes, chunkMax, queueMax}, queue}`.
- `POST /api/suite/jobs` (JSON, ≤ 256 KiB) → `{ok, id, state:'awaiting-pack', have}` or `{ok, id, state:'queued', position}`; idempotent on `id`, a different `treeHash` under the same id is 409.
- `PUT /api/suite/jobs/<id>/pack` raw chunk ≤ 4 MiB with `Content-Range: bytes a-b/*` → `{ok, size}`; an offset that is not the current size → 409 `{have}`.
- `POST /api/suite/jobs/<id>/commit` `{bytes, sha256}` → `{ok, state:'queued'}`; 400 on a size or hash mismatch; 409 `{incomplete:true}` when objects are missing.
- `GET /api/suite/jobs?ids=a,b&wait=<ms≤25000>` → `{ok, bootId, jobs:[…]}`, early on any state change; the poll is the job's lease.
- `GET /api/suite/jobs/<id>/output?stream=stdout|stderr&offset=&length=` → `{ok, total, offset, text}`.
- `DELETE /api/suite/jobs/<id>` → `{ok}`, idempotent.

A runner error answers with the status the engine names (`{ok:false, status, error, …}`).

**Box jobs.** An enabled runner's `startSuiteRunner` gives the engine a second
adapter, `boxIsolation` in suite-box.js, whose default image is the box image
(`boxImage` above, from Preferences ▸ Test boxes ▸ Test runner ▸ Box image, or
`CLODEX_SUITE_BOX_IMAGE`). Without one the adapter is `labelsOnly`: it serves
only jobs that name their image (below), and a job naming none is treated as
on a runner with no box; native jobs
are unchanged. A submit asks for it with `isolation: 'container'` (any other
value is 400 `bad isolation`); the lead sends it only for `gate:shadow` runs of a
team whose team.json has `testRunner.box: true`. Each exec of a box job is a
fresh `docker run -i --rm --init --pull never` of the image as the engine's
uid:gid, the job tree bind-mounted at `/job/tree`, labelled `clodex.suite=1`,
`clodex.suite.runner=<runnerKey>` (`runnerKeyOf` the runner state dir) and
`clodex.suite.job=<id>`. The engine never writes or closes the CLI's stdin: when
the CLI dies its stdin closes and the container's wrapper (`DEADMAN`) kills it.
A box job's tree is detached from the mirror (`detachTree`) before it runs.

- `info.box` is `null` without a default image, even on a runner that serves
  named jobs, and then no Docker call answers it; `{state:'ready', env}` when Docker
  answers and the image is present, `env` being the box identity
  (`isolation:'container'`, `platform:'linux'`, the image's arch, the daemon's
  CPU count, `box:{imageId, definitionHash:null, rev:null}`, `host`, its own `envKey`); otherwise
  `{state:'unavailable', why}`: a tag instead of an id, `docker` not on PATH,
  the daemon not reachable, the image absent, an OS or arch mismatch, an engine
  running as uid 0, a comma in the work root, or `cleanup not confirmed: <why>`.
  The probe is cached 30 s.
- A box submit naming no image is 409 `this runner has no box image configured`
  without a default image, and 503 `box unavailable: <why>` when `info.box` is not ready.
- Every box job end clears containers by its job label (up to three
  `docker ps` / `docker rm -f` rounds; a failed `ps` is never read as empty),
  then removes the job dir; cancel, timeout and lease expiry first SIGKILL the
  CLI's process group. At start the engine clears its runner label before any
  job runs; without a default image it does so only when a box job was
  interrupted or a hold is on file, so a runner with no box image and no box
  job behind it makes no Docker call at start.
- A cleanup Docker does not confirm enters the box hold, written to
  `box-hold.json` in the runner state dir as `{why, dirs}`: the dirs are kept,
  box jobs stay queued, box submits are 503 and native jobs run. A tick with no
  box job active retries the runner-label sweep; once it is confirmed the held
  dirs are removed and the file is dropped. After a restart with the image
  removed, the interrupted box jobs' dirs are held the same way until that
  sweep is confirmed, a queued box job naming no image ends `box-unavailable`,
  and a queued named one stays queued.
- A CLI exit of 125 on a box job (Docker's own failure) ends it `box-failed`.
- Removing every suite container on the machine by hand:
  `docker rm -f $(docker ps -aq --filter label=clodex.suite=1)`.

**A job names its image.** One runner can hold a box image per team. A team
with `testRunner.box: true` and a box definition (`[agent:team box set]`)
sends, beside `isolation: 'container'`, `box: {definitionHash, rev,
definition}`: the sha256 of its Dockerfile text (the hash `[agent:team box
show]` prints), its rev, and the text, which this runner does not read. A team
with `box: true` and no definition, or a lead on an older version, sends no
`box` key and runs in `boxImage` as before.

- The runner finds the image by the Docker label `clodex.box=<definitionHash>`,
  with `docker image ls -a -q --no-trunc --filter label=clodex.box=<hash>` and
  then `docker image inspect <ids>` (its JSON, no `--format` template: the
  containerd image store has no `Parent` key) on the ids it listed; it never reads labels any
  other way. `-a` is there because an image built with a label and no tag is
  dangling, and `image ls` without `-a` does not list it. Images whose OS/arch
  is not the daemon's are dropped before choosing, and so is any listed image
  that is the `Parent` of another listed one (an intermediate layer of a legacy
  build whose Dockerfile carries the label itself). The look is fresh on every
  submit, never cached.
- Exactly one image left: the job is accepted and stamped `box:{imageId,
  definitionHash, rev}`, and every `docker run` of the job uses that stamped
  id, even if another image gets the label while the job queues.
- A named job does not use `boxImage` and never falls back to it: it runs
  while `boxImage` names an image that is gone or is not set at all. A runner
  with no `boxImage` touches Docker only for a named submit (`info`, `image
  ls`, `image inspect`) and for the jobs it accepts. The lead does not consult
  `info.box` before a named submit, so its `null` there refuses nothing; an
  older lead sends `box: true` and reads `null` as `runner has no box: not
  configured`, as before.
- Refusals, all before anything runs: no matching image is 409 `no image for
  box <hash12> on this runner` (`code: 'no-image'`); two or more distinct
  matching ids is 409 `more than one image carries box <hash12> on this
  runner: <ids>` (`code: 'ambiguous-image'`) — remove or relabel one; Docker
  down or the cleanup hold is 503 `box unavailable: <why>` (`code:
  'box-unavailable'`); a malformed `box` is 400.
- An image removed after the job was accepted makes `docker run --pull never`
  exit 125: the job ends `box-failed` and the next job runs.
- The lead checks the done stamp: a `definitionHash` other than the one it
  sent, or none (a runner that ignores `box` and runs its `boxImage`), reads
  `box mismatch: asked box <hash12>, runner ran image <id12>`. Compare rows
  carry `remoteEnv.definitionHash`.
- Building an image: run the line `[agent:team box show]` prints, `docker build
  -t clodex-box:<hash12> --label clodex.box=<hash> … - < Dockerfile`. An image
  that already exists is labelled without a rebuild: `echo 'FROM sha256:<id>' |
  docker build -t clodex-box:<hash12> --label clodex.box=<hash> -`. The tag
  keeps the image from being pruned as dangling. Labelling gives a new image
  id, so the envKey, and with it the agreement tally on that runner, starts
  over once.
- Rebuilding the same definition moves the tag to the new image, and the old
  one stays, untagged but still labelled: the hash then matches two images and
  is refused until `docker image prune` (or `docker image rm <old id>`)
  removes the old one.
- The label is the operator's assertion that the image serves that
  definition, not provenance: nothing checks that the image was built from the
  team's Dockerfile. The stamp records the actual image id each job ran in.

**The suite token.** `CLODEX_SUITE_TOKEN` is a second credential checked by
`_authGate` only after the operator token fails. A request it admits is marked
`req.suiteScoped`; `_route` refuses everything except `GET /api/peer/hello` and
`/api/suite/*` with 403 `{error:'this token is scoped to suite jobs'}`, after the
base-path strip and before the first route match. A scoped hello is exactly
`{ok, app, host, version, bootId, caps:['suite'], scope:'suite'}`; no cookie is
set for it. The operator token is accepted on the suite routes too. The
fail-closed non-loopback rule stays keyed on the operator token, with one
opening: a runner can run on the suite token alone. On a non-loopback bind with
no `CLODEX_REMOTE_TOKEN`, a request carrying the suite token is admitted as
`req.suiteScoped` (Origin compared as for a token-gated bind), so hello and
`/api/suite/*` work and every other route is the scoped 403; a request without
it gets the same 503 as before. With both tokens set nothing changes.

**Lead side.** The runner is an ordinary peer row whose `token` is the suite
token. A hello with `scope:'suite'` skips the dialect probe, the session list,
the event stream, attachments, DM claims and the roster push. Suite calls go
through `PeerConnection.suiteAsk` / `suitePut` on their own keep-alive pool
(`_suiteAgent`, two sockets), so a 25 s long-poll never pins the request pool
the hello loop uses. `suite-client.js` (`reachable`, `run`, `cancel`) drives one
job: snapshot, submit, chunked upload with resume from `have`, commit, poll,
output; it returns `{res, unknown, record}` and writes the `where:'remote'`
records of `logs/suite-runs.jsonl`. A timeout, an unreachable runner, a lost
job or a result for another job or tree is `unknown`, never a pass.

### 2d. Box offers (owner side)

A node may offer test boxes to named peers (`boxOffer` ui-setting, or env
`CLODEX_BOX_OFFER`, which wins when set; box-offer.js validates both). While the
env var is set the stored setting is not read or checked at all. The record's
`scope` is `discovery` (the default: peers are shown the offer, nothing is built
or run) or `run` (see **Run scope**). remote-wiring injects `offerFor`,
`receiveOffers` and `listOffers` (`offerCallbacks`); without them hello has no
`offers` cap, both routes answer 501 and `offers` is absent from
`/api/resources`.

- **Hello.** Cap `offers` means this node reads `?origin=<name>` on
  `GET /api/peer/hello` and serves `POST /api/peer/offers`. When the origin is a
  valid node name listed in the offer's `peers` and the offer is enabled, hello
  carries `offers: { own }`; otherwise the key is absent. `own` is exactly
  `{scope:'discovery', boxes, open, kinds:['container'], facts:{os, arch, cpus,
  memMb, runtime}}`; `runtime` is `null` when no container runtime answers (or
  the node has no sandbox manager), else `{platforms:[…]}`. Facts are probed
  when the entry is built, never stored; no host name, version or schedule
  times cross the wire.
- **Dialers.** Every operator hello (not a suite-scoped one) whose `origin` is a
  valid node name is noted by `noteDialer` (offer-directory.js
  `createDialerLog`): name and last-seen time only, in memory, at most 64 names,
  the least recently seen dropped first. No token or address is kept.
- **`POST /api/peer/offers`** (a dialer's announce): body
  `{v:1, from:<dialer label>, own:<entry>|null}`. `own` is sanitised by
  `sanitizeWireOffers`; an entry with an unknown key, a missing fact or a scope
  other than `discovery` or `run` is a 400 and nothing is stored. A `null` own removes that
  dialer's row. Any `relayed` field is ignored. Reply `{ok:true}`, or 503
  `{ok:false, error:'offers directory full'}` when the directory refused a new
  row.
- **The dialer's half** (peer-client.js `_syncOffers`, wired by peer-wiring.js
  `offerPeerCallbacks`). A hello carries `?origin=<SELF_LABEL>` when the node has a
  self label (none without one), the name
  this node also sends as a DM `origin` and a roster `via`. After a non-scoped
  hello whose caps include `offers`, the dialer stores the reply's `offers.own`
  as a `hello` row keyed by the peer id (an absent field clears that row), then
  POSTs its own entry for that peer, or `own:null` when it has none. The entry
  says `scope:'run'` only for a `run` record and a peer whose hello caps include
  `suite-pull`; otherwise it says `discovery`, and hello's `own` always does. A repeat
  `null` after an acknowledged `null` is not sent. It rides the hello tick, so
  the dialed node's `announce` row stays fresh while the link lives and expires
  by the TTL when it goes quiet. A far side without the cap gets no POST; a
  suite-scoped hello returns before any of this. `offers` is not part of
  `identityChanged`, so an offer change never re-runs the dialect probe.
- **Which name is matched.** The offer's `peers` holds this operator's names.
  Dialed side: the dialer's self-asserted `origin` (its `SELF_LABEL`). Dialer
  side: the label of the peer row being dialed.
- **`GET /api/offers`** → `{ok, own, offers}`: `own` is this node's entry
  without the peer filter (or `null`), `offers` the directory rows
  `{route, provenance, name, offer, at}` (offer-directory.js, in memory, 60 s
  TTL). `route` is an opaque handle, `provenance` is `announce` (a dialer's
  POST) or `hello` (a peer this node dials). Two routes to one installation
  stay two rows; box counts are never summed.
- **Not an access boundary.** The per-peer list decides who is shown the
  offer. A dialer's `origin` and `from` are self-asserted, so the list is a
  display filter, not authorisation. Both routes ride the operator token; a
  suite-scoped token gets the scoped 403 on both and its hello never carries
  `offers`.
- **Run scope.** `runGrant(offer, peerName, now)` (box-offer.js) answers
  `{admit, serve}` for one peer row label: `serve` is true for a valid, enabled
  `run` record that lists the peer; `admit` (new jobs) also needs the schedule
  open (`scheduleOpen`). A closed schedule keeps `serve`, so jobs that already
  exist are still serviced; disabling the offer or unticking the peer clears
  both. A stored `discovery` record loads as `discovery` and grants nothing.
  Nothing calls `runGrant` yet; suite-runner.js, suite-client.js and remote.js's
  suite routes never read the offer.
- **Setting the offer.** Preferences ▸ Test boxes ▸ Offer test boxes (both hosts, `enableTestBoxes`): on/off,
  box count, availability `always` or `schedule` with up to 8 windows, and a
  checklist of names: this node's configured peers by label, then the nodes
  that have dialed in (see **Dialers**, labelled "dials this machine, seen 2m
  ago"), then any stored ticked name that is neither, so a restart does not hide
  it. A text field adds a name by hand (node-name grammar; a duplicate is
  ignored). A node that dials this machine is named by its own label: its
  hostname unless it set `CLODEX_LABEL`. The block shows this machine's label,
  the name a node it dials will see. "Ticked peers may" chooses the scope:
  "see this offer" (`discovery`: the list is not an access control and nothing
  runs here because of it) or "see it and run their teams' test jobs on this
  machine" (`run`). Under `run` a line states the test runner's isolation in
  force, or why nothing runs yet (runner off, or waiting for phone access), and Apply on an enabled `run` offer
  first asks for confirmation listing every ticked peer. A read-only line shows the facts this machine
  would announce. It saves through IPC `offer:set(record, confirm)`, which runs
  `sanitizeBoxOffer` and refuses an invalid record (the stored one is kept),
  refuses an enabled `run` record unless `confirm.peers` names exactly the record's peers
  (`runConfirmed`), and
  refuses with the reason while `CLODEX_BOX_OFFER` is set; its reply's facts are
  the cached ones (`getOfferFacts`), never a fresh probe. `offer:get` returns
  `{self, stored, effective, forced, warning, facts, peers, runner}`; `runner` is
  `{status, isolation}` from the test runner state, or `null`; `self` is this
  node's label and `peers` is `[{name, from:'peer'}]` for configured labels
  followed by `[{name, from:'dialed', seenAt}]` for dialers not configured;
  `warning` is
  `stored offer invalid, treated as off` when the file holds a record the
  sanitiser rejects. No intent, clodexctl verb or wire route writes the offer,
  and `settings:set` drops a `boxOffer` key. A saved change reaches each peer at
  its next hello; there is no extra timer.
- **Seeing offers.** `clodexctl get offers` reads `GET /api/offers` and prints
  `SOURCE PEER BOXES OPEN OS/ARCH CPUS MEMORY RUNTIME`: this node's own offer as
  `self`, then one row per directory entry with its provenance (`hello` or
  `announce`). The peer ⓘ popover shows one `Boxes` line when the `hello` row
  for that peer's label carries an offer (`offer:directory`), and none
  otherwise. The popover and Preferences re-read on the `offers-changed` broadcast, sent by `offer:set`
  and by either ingest when the directory listing changed.

### 2e. Suite desk (owner side: the lead's queue for a runner that dials in)

The pull wire runs the §2c requests in reverse: the lead queues each one as a
*call* on `suite-desk.js`, a runner that dials the lead claims it, runs it
locally and posts the answer back. engine.js builds one desk and remote-wiring
injects it as `suiteDesk`; with it, the non-scoped hello carries the cap
`suite-pull`. Nothing queues calls yet: team routing comes in a later slice.
The runner's side is the claimer (§3, "Suite claims").

- `desk.conn(origin)` offers `suiteAsk(method, path, payload, timeout)` and
  `suitePut(path, buffer, headers, timeout)`, resolving `{status, body, error}`
  like `PeerConnection`. An origin that is not attached answers 503 at once.
  A call's timeout is floored at 20 s; `suitePut` defaults to 120 s, as on the
  push wire. On expiry a call resolves status 0.
- Caps (`DESK_LIMITS`): 32 unsettled calls per origin (pending plus claimed and
  not replied), 128 in all, 32 MiB of held chunk bytes per origin; past a cap
  the call answers 429. A JSON body over 256 KiB or a chunk over 4 MiB is 413.
  A buffer is released when its call is replied to, expires or is failed. The
  desk tracks at most 256 origins; a claim from a new origin evicts the oldest
  detached one holding no calls, or is 429 when there is none.
- **Attachment.** Each claim carries the claimer's `session` id
  (`[A-Za-z0-9_-]{8,128}`, minted once per runner instance). An origin is
  attached for `presenceMs` (45 s, provisional) after its last claim. A claim
  from another session while the current one is attached is 409. A new session
  replacing a lapsed one fails every pending and claimed call of that origin
  with 404 `{reason:'runner-restart'}`. suite-client resubmits on it for pack,
  commit and poll; a replaced submit, info or output read ends `unknown`.
- A call is delivered once. A second claim never returns a call an earlier
  claim took.

Routes take the operator token. They sit outside `/api/suite/`, so a
suite-scoped token gets the scoped 403 on all three. Without a desk they
answer 501.

- `POST /api/suite-desk/claim` `{v:1, origin, session}` → `{ok, v:1, calls:[…]}`;
  marks `origin` attached. A call is `{id, claim, ttlMs, method, path, headers,
  body, blob}`; `blob` is `{bytes}` for a chunk, else null. A batch stops once
  bodies pass 512 KiB, always holding at least one call. Bad JSON, origin,
  session or `v` is 400.
- `GET /api/suite-desk/calls/<id>/blob?claim=<token>` → the chunk as raw
  `application/octet-stream`.
- `POST /api/suite-desk/calls/<id>/reply` `{v:1, claim, status, body}` (≤ 2 MiB)
  → `{ok}`. `status` must be an integer 100–599 and `body` a plain object;
  otherwise the call resolves 502 and the route answers 400.
- On blob and reply: unknown id 404, wrong claim token 409, expired or already
  settled 410.
- SSE `suite-mail` `{origin}` on `/api/events` (`notifySuiteMail`) rings when a
  call is queued. It is a doorbell only, separate from `dm-mail`.

## 4. Settings reconciliation (peer-wiring.js)

`syncPeerManager` lazily constructs both managers, then reconciles from
`uiSettings.peers`. **Disabled peers are excluded from both syncs** —
paused, not removed: tunnel and connection tear down (hello stops), but the
record and its persisted attachments/claims stay for re-enable. The prune
loop drops persisted `peerAttached`/`peerVisible`/`peerControlled` only for
ids that left settings entirely. Online/offline is logged on transitions
only (peer-state fires in bursts).

Persisted map writers: `peerAttached` on attach, forgotten on explicit
detach — **peer-exit and the disable soft-shed deliberately don't forget**,
so attachments survive a box restart or a pause. `peerControlled` on
successful acquire only (a failed take never persists), forgotten on
release/detach/stale-claim drop. `peerVisible` via Apply (full replace) and
row-hide/create (`peer:visibleRemove`/`peer:visibleAdd`, merged in main against
the saved map); every write broadcasts `peer-visible`.

## 5. Control model

Single-holder server-minted token, last-wins. Two acquisition paths:
explicit Take (bar/menu) and **type-to-take** (peer-input-queue.js
`PendingInput`: first keystroke kicks an async acquire; keystrokes during
it buffer whole-chunk, 4KB cap, keep-or-drop — a spliced keystroke stream
is worse than a bounded-intact one). Auto-release when the last attacher
leaves or the PTY exits. **Resize authority rides control**: the
controlling viewer pushes geometry on explicit fit; the owner echoes an
idempotent resize-in-place (no feedback loop); read-only viewers letterbox
at owner geometry. Every reattach replay resets to read-only; a persisted
control claim re-takes on `onPeerReplay` (covers app AND box restarts);
losing to another holder sheds the stale claim without a retry loop.

## 6. Renderer (renderer/peers-ui.js)

Self-contained island; peer terminals live in the core sessions Map keyed
`name@peerId` (`@` can't occur in local names). Highlights:

- Header per peer: fold caret, online dot, state text, version-severity name
  tint (only when the peer is behind us), hidden-row count while collapsed,
  icon strip — ＋ new session (create cap), ↻ restart Clodex, ◎ visibility
  popover (works offline), ⓘ identity popover (version/platform/caps/age +
  Update + Pause). Right-click menu: new session, restart, rebuild (boxes),
  update, Pause. Pause is enabled offline too — the ⓘ button that used to be
  the only entry point renders solely when `online && version`.
- **Fold state**: `view.expandedPeers` in the WORKSPACE record, via
  `workspace:setView` — so it is per-workspace, and the merge in
  `workspaces.setView` keeps it clear of the sidebar view keys renderer.js
  owns. It lists the EXPANDED peers: absence reads as collapsed, so a new
  workspace (and a newly seen peer in an old one) starts folded. Ids of peers
  that no longer exist are not pruned. Note the local sidebar's
  `collapsedGroups` is deliberately session-lived and NOT persisted.
- **Restore sweep**: `peerRestorePending` is one-shot per name — seeded at
  startup from persisted `peerAttached` (and re-seeded on re-enable),
  consumed as sessions arrive, expired names forgotten after a settle
  delay. Per-name consume prevents an attached-then-closed tab from
  resurrecting on a connection blip.
- **Visibility**: no map entry = show all; attached-always-wins at render,
  except the eye popover's Apply explicitly detaches excluded open tabs.
  X / Cmd+W on a peer tab = detach + hide from list.
- **Disable/pause**: the initiator marks `disabledPeers` before invoking
  `peer:setDisabled`; main broadcasts `peer-disabled` before re-running the
  syncs, so every window discriminates the resulting `peer-removed` as a
  soft shed (`removeSession(key, {keepPersisted:true})` — no durable
  detach). Re-enable re-seeds the restore sweep from durable truth.
- **`PEER_UI_KINDS`** mirroring: owner-initiated UI events (`fileView`
  today) render immediately only when that peer tab is active; otherwise a
  click-to-open toast — the intrusiveness gate that stops a remote agent
  slamming a modal over your work.
- Back-exports to core — the `initPeersUi` return, which is the list:
  `typeToTakeControl`, `renderPeerBar`, `forgetControlMirror`,
  `openPeerSession`, `openPeerSessionDialog`, `closePeerSessionDialog`,
  `peerDisplayHost`, `peerHideFromList`,
  `ensurePeerSessionVisible`, `openPeerArgs`.

## 7. Deploy wizard (peer-deploy.js + ssh-run.js)

`sshRun`: one-shot `ssh … bash -s`, key-auth only (BatchMode), TOFU host
keys, exit 255 = ssh-layer failure. `probePeer` classifies a host without a
tunnel (ssh-fail / no-listener / not-clodex / hello-ok). `clodex-deploy.sh`
is an idempotent one-shot — **re-running it IS the update path** (apt deps
checked including t64 aliases, clone-or-reset, build, systemd --user unit,
verify-by-hello). It never prompts for sudo: exit 42 + the exact commands
to run. `resolveDeployFolder` is the one precedence rule: live
self-reported `srcDir` (hello) > persisted guess > script default — a
stale persisted folder must never shadow live truth. Failed deploys can
spin up an ad-hoc local fix agent briefed with the log.

## 8. Headless nodes (peering/)

The headless engine (`node headless-main.js`, no Electron or Xvfb) as a systemd `--user` unit (`Restart=always`,
`TimeoutStopSec=15` to release the single-instance lock). The seed script
handles bulk session add/remove via service restart; day-to-day
create/kill/restart now ride the `create` cap over the wire.

"Fix with an agent…" on a failed deploy mints an ad-hoc claude seat
(`peer:deployFix`) that becomes the active tab. Its cwd is
`~/.clodex/fix/<sanitized-host>/` (`clodex-paths.js` `fixDirFor`, 0700) rather
than the operator's home, so its notes land somewhere Clodex owns; the session
record carries `fixFor: <host>`, which puts a muted `fix` chip on the sidebar
row naming the box it ssh-es into. Its briefing pins the outcome note's first
line: `DEPLOY OK <host>` or `DEPLOY FAILED <host>`. A `DEPLOY OK` note from a
`fixFor` seat archives it (never kills it — the transcript stays resumable) and
its sidebar row stays visible as an archived row rather than disappearing;
anything else leaves it running.

## Invariants (do not break)

- 127.0.0.1 default bind + tunnel-is-auth, `_authGate` on the whole surface;
  only input/resize control-token-gated.
- Replay = best-effort scrollback; reset before apply; re-replay on
  reconnect.
- Split request/SSE socket pools (regression test pins this).
- `peer-removed` fires on URL/label/token/inbox/destination edits too — consumers must shed tabs; only a managed peer's tunnel respawn to an unchanged destination re-points instead.
- Disabled ≠ removed: syncs exclude, prune keeps, sheds are soft.
- A forwardable port is ADVERTISED or absent, never guessed — and the wirescope
  forward is subordinate to the web view it decorates: it may cost the dashboard
  link and nothing else.
- An imported seat is a RESTORE (mint=false) of the shipped record — never a
  mint over the shipped promptcache.
- The shipped `createdAt` is in persistence BEFORE the far `create()` — the
  pending-drain hook bakes it, and mail that rode with the seat dies otherwise.
- Restore sweep is one-shot per name.
- Control auto-releases on last-detach; re-take rides replay, not a loop.
- A wterm want is owned by a window and dies with it (both edges: navigation
  and window close); an unresolvable sender is refused on open AND close, never
  defaulted — the dying window's wants go with its `closed` hook instead.
- `resolveDeployFolder` precedence: live srcDir > persisted > default.
- The wire is one-directional; box→consumer traffic is outbox+claim only.
- Hub-relay (messaging.md §4a): spokes never dial each other; a spoke→spoke DM
  is relayed through the hub, reusing the outbox+claim legs. Opt-in per peer
  (`relayAllowed`, default OFF, symmetric both-ends gate); distinct `relay` cap;
  `from`'s local part is sacred, but the hub restamps its origin suffix to its
  own label for the source spoke on the terminal leg; that leg also strips relay
  fields (loop-prevention) and `RELAY_MAX_HOPS=1` is the belt.
- A peer is addressed by its origin (label, else host, else id — the first that
  is a valid node name), and the hub's own label is its `CLODEX_LABEL` or its
  hostname made wire-safe.
- A ticket assigned over the wire is still owned by the board that filed it;
  no board state crosses.
- A task envelope closes a ticket only when the board's recorded assignee
  equals the dialing sender; the body is never trusted for identity. On the
  claim path a record is honoured only when it carries the box's outbox
  signature, which only the box's own Clodex can produce, so a file dropped
  into the outbox by a seat is skipped.
- The signing key is `<registry>/peer-outbox/outbox-key` (32 bytes, 0600,
  created on first enqueue, read once per process). A credential-sandboxed
  seat is denied reading it; an unsandboxed seat on the box can read it — the
  same limit as the rest of the run-dir trust model. A key deleted and
  recreated invalidates records still queued under the old one; the consumer
  claims every ~15 s, so the loss is bounded to that window. A record the
  claim would drop is refused at enqueue, so its sender is told, and every
  skipped file is logged on the box with its reason.
- A box offer is discovery only and its per-peer list is a display filter, not
  an access boundary (a dialer's name is self-asserted). Suite code never reads
  `boxOffer` or the offers directory (`test/remote-offers.test.js`).
