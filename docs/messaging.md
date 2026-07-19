# Messaging & intents

How agent output becomes actions, and how messages reach an agent's prompt.
Companion to [architecture.md](architecture.md) (module map); see also
[sessions.md](sessions.md) for spawn/lifecycle and [peering.md](peering.md)
for the wire the federation legs ride on.

Reading guide for a change: **scanning/grammar** → intent-scanner.js ·
**routing** → `SessionManager._handleIntent` · **delivery/injection** →
`_gatedDeliver`/`_deliverMessage`/inject-queue.js · **parking/resend** →
pending-store.js · **federation** → `_routeFederatedDm` + peer-outbox.js ·
**protocol text** → ipc-prompt.js (sole source of truth).

## 1. Where intents come from (three mutually exclusive sources)

Per-session `intentSource`, decided in `SessionManager.create`:

- **wire** — a Claude session that registered with the in-process wire tee
  (and `WIRE_INTENTS_LIVE`). Intents ride wire `turn.completed`: the
  `_ensureWire` listener runs `_extractIntents(text)`, claims each occurrence
  through `_intentDeduper.claim(agent, shadowIntentKey(...), 'wire')`, then
  dispatches `_handleIntent` via `setImmediate`. A `TranscriptSentinel` keeps the
  transcript-only jobs alive (symlink identity, compact rendezvous, recovery
  replay if the tee fails).
- **jsonl** (legacy path) — Codex, wire-failed Claude, or
  `CLODEX_WIRE_INTENTS=0`. `JsonlWatcher` tails the
  `~/.clodex/run/{name}/transcript.jsonl` symlink, buffers assistant text by
  requestId, flushes on new requestId /
  non-assistant entry / 1s silence → `_scanJsonlText`.
- **bash PTY** — bash sessions are private (no registry, socket, or watcher);
  `_scanPtyOutput` line-buffers raw PTY stdout. bash has no `agentType`, so
  only dm / who / resend work; context, memory, spawn, and file intents are
  agent-only and short-circuit.

All paths converge on `_extractIntents` → `parseIntent` (per line) →
`_handleIntent`.

**Source-aware dedupe** (`IntentDeduper.claim(agent, key, source)`, returns
`{ok, reason}`). The deduper exists for ONE overlap: tee-failure recovery replays
the handover turn's tail through `onText` *after* the wire already dispatched it.
So the rule is source-shaped, not claim-once: reject when a non-expired prior
came from the OTHER source (cross-path, both directions) or recovery-after-
recovery (the replay tail repeats each poll); **allow wire-after-wire** — distinct
wire turns are distinct emissions (one `turn.completed` per reqId), and collapsing
them would eat a deliberate retry (the compact-retry bug). Because wire-after-wire
is allowed, each dispatch loop ALSO carries a per-turn `Set(shadowIntentKey)` to
drop intra-turn duplicate intents — that Set is load-bearing, not a nicety. Every
drop (cross-path, replay repeat, intra-turn) logs `log.warn('intent', …)` + a
shadow record; silence here is what hid the original 3-attempt compact failure.

**Compact latch** (wire-owned Claude only). `[agent:context compact]` does NOT
inject `/compact` inline — Claude Code silently discards slash commands while the
CLI is busy. Instead `_handleContextIntent` sets `session._compactPending =
{cmd, continuation}` and arms the in-flight valve; the wire `turn.completed`
handler runs `_maybeFireCompactLatch` on a TERMINAL main-line stop
(`t.stop.is_turn`) when both inject queues are empty (`canFireCompact` — CLI
genuinely parked). The fire-check is scheduled via `setImmediate` AFTER the
dispatch loop, so a latch set synchronously by the same turn's intent is already
visible (FIFO ordering) and the normal case fires on the very next receipt. The
in-flight guard treats a set latch as in-flight (a second compact drops+logs);
the 5-min valve clears `_compactPending` too, so a latch that never fires can't
wedge. **Non-wire sessions (codex, jsonl-fallback Claude) keep the immediate
inject** — no wire terminal-stop receipt exists to fire a latch off, so a mid-turn
compact there can still be dropped by the CLI (documented degradation).

## 2. Grammar (intent-scanner.js — pure, electron-free)

- `cleanLine` strips ANSI, then a leading run of decorator chars
  (bullets, box glyphs, whitespace). Column-1 enforcement is the *caller's*
  job (one line at a time); all regexes are `^`-anchored, so inline or
  backticked mentions never fire.
- `\[agent:…]` is the escape — parsed as `{type:'escape'}`, treated as
  literal text everywhere, and never terminates a multi-line body.
- Intents: `dm` (`target`, optional `urgent`, body), `resend <id>`, `who`,
  `name`, `context <sub>`, `memory <sub>`, `file <view|open> <path>`,
  `spawn name:X cwd:Y` (optional `template:Z` — matched by name, supplies
  type/config; see sessions.md §5).
- **Multi-line bodies** are captured in `_extractIntents`, not the scanner:
  a body runs from the intent line to the next column-1 real intent or end
  of turn (applies to dm, memory remember, remind, notify-user, context
  compact/reload).
- **Fenced code blocks are quotes** (`fencedLines`, pure leaf in the
  scanner): a line inside a ```/~~~ fence is literal text at every level of
  `_extractIntents` — no intent parse, no body boundary, no near-miss
  bounce. Line-anchored fences only (inline backticks were already safe —
  mid-line never fires); closer must match the opener's char and length,
  unclosed fences run to end of turn. The PTY scan path (`_scanPtyOutput`,
  bash panes) is deliberately fence-BLIND: fence state over an unbounded
  terminal stream would let one `cat`ed markdown file disable intent
  scanning for the pane's life.
- `[agent:end]` (bare-only) is the explicit body TERMINATOR: it closes an
  open capture via the generic any-intent boundary and is itself discarded —
  `_extractIntents` never emits it, `_handleIntent` early-returns defensively.
  It exists so operator-facing prose can FOLLOW a body (without it, trailing
  text is swallowed into the message — fired live on a memory-remember) and
  so prose can interleave between several bodied intents in one turn.
- `shadowIntentKey` gives each occurrence a stable identity for the dedupe
  ledger; `urgent` is folded into the key so an urgent retry isn't swallowed
  as a duplicate of the original.
- **Near-miss bounce**: a top-level line that cleans to `[agent:…` but parses
  to nothing (typo'd verb, malformed args) synthesizes ONE `unknown` intent
  per batch (`looksLikeIntent`, counter for the rest), which `_handleIntent`
  bounces back naming the line and the valid verbs — before the intent gate,
  agent sessions only. Near-misses inside a captured body stay body text, so
  quoting examples in a dm is safe. Same family: a dm whose target is neither
  a local agent, a `name@peer` route, nor a socket peer bounces
  (`NOT delivered: no agent named …`), as does a dm to a bash session and an
  unknown `context` sub — all were previously silent drops.

## 3. Local DM delivery

The pipeline for a message addressed to a local agent, in order:

**Gate** — `_gatedDeliver(target, senderTag, body, urgent)` (shared by local
dm, the wire `/api/dm` entry, and claimed federated mail) consults
`shouldHoldDm` (proxy-util.js): a permission dialog holds unconditionally
(`noUrgent`); `urgent`, thinking, recent activity (`DM_HOLD_IDLE_MS`), or a
warm cache deliver immediately; otherwise it holds (cold-cache — waking a
cold session re-bills its whole context). Held Claude targets get the message
**parked** (`_parkHeldDelivery`); Codex/dead targets get a plain bounce
(Codex has no drain hook, so it can't be a park target).

**Build** — `_buildDeliveryText`: `[agent:from <senderTag>]` prefix + body +
reply trailer `(reply: start a line with [agent:dm <sender>])`. The trailer
is parenthesized and non-column-1 so it can never self-fire; it's emitted ONLY
when the advertised reply path exists on both ends — the RECEIVER's `dm` intent
is enabled (fresh persistence read) AND the SENDER is dm-reachable NOW
(`_isDmReachable`: a live local agent session, or an online federated peer
`name@origin`). This subsumes the old `user`/`reminder` special-cases (neither
is a reachable agent) and drops the trailer for external senders like a `nc -U`
wake script's `from:"t1-wake"` that no session answers. Coupled to
`_deliverMessage`'s drop-if-absent — widen `_isDmReachable` if local dm parking
ever covers absent targets. Bodies over
`MSG_SPILL_THRESHOLD` (500B) spill to `~/.clodex/messages/` — Claude gets
`@<path> ` (trailing space closes autocomplete; the file auto-attaches),
Codex gets a read-with-Read pointer.

**Inject** — `_injectText` has two layers:
1. *Turn batching*: `_injectHoldReason` (compact window / permission dialog /
   thinking) queues injects and flushes them as one joined turn on release;
   `INJECT_HOLD_TIMEOUT` (5min) is the force-flush valve. `bypassHold` skips
   this layer (compact continuations, slash commands).
2. *Byte atomicity*: the per-session `InjectQueue` (inject-queue.js)
   serializes Ctrl-U → text → settle → Enter as one atomic unit. Ctrl-U MUST
   be its own write with a ~30ms settle gap — sent in the same chunk as the
   text it lands as a literal character (this was the historical
   mid-draft truncation bug). The quiet-gate defers firing while the
   operator typed within `INJECT_QUIET_MS` (2s), capped at
   `INJECT_QUIET_MAXWAIT` (5min, logged as splice risk).

**Park-at-fire divert** — injects marked `parkable` re-check
`_parkDivertFor` at the moment of writing: if the operator has a draft open
(`isDraftOpen`, stateful across PTY chunks including bracketed paste), the
delivery parks instead of splicing into the draft. Opt-in at conversational
call sites only; self-intents are never parkable.

### Parking & resend (pending-store.js)

- One directory per agent under the pending root; one file per message.
  Publish is tmp + atomic rename; drain is an atomic whole-directory
  rename-claim (hook drain and cap-fire drain use distinct claim tags, so
  they're mutually exclusive). Zero-loss by construction.
- Parked files: `<seq>.json` or `<seq>.<id>.json` — the id segment is
  matched *structurally* (4 vs 3 segments), never by suffix, so a
  counter-shaped seq can't be claimed as an id.
- **Three park types, all land in this store** (the distinction is *why* a DM
  parked, and whether the sender is told):
  1. **Cost/dialog hold-park** (`_parkHeldDelivery`, from `_gatedDeliver`) —
     the target is idle-and-cold (`DM_HOLD_IDLE_MS`, 30min) or dialog-blocked.
     The SENDER is notified (bounce/notice with a resend id). Does NOT arm the
     cap — waits for the target's own next turn or an explicit resend.
  2. **Busy/draft park** (`_maybeParkDelivery` + the fire-time divert in
     `_parkDivertFor`) — the target is mid-turn (`thinking`) or has an open
     draft / recent keystroke in its pane at the delivery instant. This is
     draft-splice protection, not a cost hold; the SENDER is NOT told (the DM
     was accepted, not refused). Arms the 5min cap, so it self-drains even if
     the target never takes a turn.
  3. **Passive park** (`_deliverPassive`, socket envelope `delivery:'passive'`)
     — ride-along notifications (clodex-monitor status ticks; see
     docs/exec-tools.md). Marked in the filename (`<seq>.passive.json` — the
     7-char literal can't collide with 5/10-char minted resend ids). Drained by
     the organic carriers only: the hooks, or any whole-dir claim that was
     happening anyway. The turn-GENERATING idle-edge drain gates on
     `hasActivePending` — a passive-only store never earns a turn; a mixed
     store drains fully (the active justifies the turn, passives ride along).
     Never arms the cap, takes no resend id, no session-mention badge. Claude
     targets only; Codex and absent-park-failure fall back to a normal wake
     (degraded to noisy, never dropped).
- **Resend**: cost/cold-hold parks mint a 5-char base36 id (unique across
  all pending dirs) and the bounce notice teaches `[agent:resend <id>]`.
  Resend claims by single-file rename (ENOENT = already delivered = success)
  and bypasses the cost gate; a dialog hold re-parks under the same id. Resend
  re-delivers with `parkable` + the SAME id, so if a draft is open in the
  target pane at fire time the divert re-parks under that id (the handle
  survives — a later resend still resolves it) instead of splicing.
  SETTLED: resend is protocol-invisible — not in IPC_PROMPT; only the park
  notice hands out the incantation (ids only exist at park time).
- Drains: `run/<name>/pending.sh` (UserPromptSubmit hook) delivers parked mail
  with the target's own next turn; the busy/draft park arms a non-destructive
  5min cap (`_armParkCap`) that drains through the inject queue. Cost/dialog
  hold-parks do NOT arm the cap — they wait for the target's next turn or an
  explicit resend.
- **Operator flush** (`countPending` + `flushPending` / `_flushParkedNow`) — a
  parked-DM count badge (`✉N`) on the sidebar session row, fed by a 1s
  `pending-count` poll (deltas only) over live Claude sessions plus a seed from
  the reattach snapshot. Clicking it drains that session's queue NOW: the same
  atomic claim as the cap (tag `flush.<pid>`), injected NON-parkable (so a
  flushed message can't re-park — the recursion a `parkable` resend could hit).
  It's the operator's true "deliver now" override, sidestepping the sender-
  notice cost entirely (the operator has no turn cost). Guards: refuses a
  dialog-blocked target WITHOUT draining (draining would move zero-loss durable
  files into the volatile in-memory queue behind the dialog). **Operator-only**
  via the `session:flushPending` ipcMain.handle — there is deliberately no
  agent-facing flush verb (agents keep `[agent:resend]` for id'd cost-holds).
- Parked deliveries are deleted only on explicit user-kill (`_cleanup` gates
  the rmrf on `_userKilled`); restarts and quits keep them.

## 4. DM federation (`name@peerlabel`)

The tunnel is one-way — the consumer dials the box, never the reverse — so
the two directions use different transports (full wire detail in
[peering.md](peering.md)):

- **Consumer → box**: `_routeFederatedDm` matches `@origin` against a
  configured online peer advertising the `dm` cap and POSTs `/api/dm`; the
  delivery verdict (delivered / parked / error) rides back in the
  synchronous HTTP response. Box-side `deliverDm` (remote-wiring.js) records
  the origin, tags the sender `from@origin`, and runs the same
  `_gatedDeliver` as local mail.
- **Box → consumer**: no dial-back, so replies go to a per-origin **outbox**
  (peer-outbox.js: tmp+rename publish, atomic whole-dir claim, `validOrigin`
  path-traversal guard). Delivery is pull: the box advertises pending
  origins in hello (`dmOrigins`) and rings a `dm-mail` SSE doorbell on the
  existing events feed; the consumer claims via `/api/dm/claim` on either
  signal (racing claims are safe — the rename-claim is atomic, the loser
  reads empty).
- **Loop guard**: claimed mail is delivered through `_gatedDeliver`
  directly — NEVER `_handleIntent` — so a federated dm can't re-route.
  The sender tag uses OUR configured label for that peer (not the box's
  origin string) so the reply trailer routes back through our own config.
- `SELF_LABEL` = hostname minus `.local`. `[agent:who]` appends federated
  addresses for online dm-cap peers. It also lists ALL local agent sessions
  regardless of workspace (not just the sender's) — parity with that
  cross-workspace federated listing, and every listed name is a valid dm
  handle since the session map is globally keyed.
- Accepted asymmetries: a park on the mailbox leg sends the remote sender
  no notice; the claim endpoint is origin-unauthenticated (tunnel-trust,
  same posture as control acquisition).

## 4a. Hub-relay federation (spoke ↔ hub ↔ spoke)

Spokes never dial each other — only the hub holds a tunnel to each. So a
spoke→spoke DM is **relayed through the hub**, reusing the two federation legs
above wholesale. Wire-format single source of truth: **relay-protocol.js**
(`RELAY_ENVELOPE_V`, `RELAY_MAX_HOPS`, the envelope/roster helpers); the
per-peer opt-in is the `relayAllowed` setting; the build capability is the
distinct `relay` cap.

- **Discovery (roster push).** The hub computes, per allowed spoke X, the
  agents on its OTHER allowed peers X may reach (`computeRosterFor`:
  split-horizon — never X's own — plus the **symmetric** `relayAllowed(X) &&
  relayAllowed(Y)` gate), and **pushes** it to X via `POST /api/peer/roster`
  (served by the spoke, called by the hub each hello tick — but only to a spoke
  advertising the `relay` cap, never 501-spamming an old box). Payload
  `{rv, via, roster:[{name,origin,type}]}`; `via` is the hub's label. The spoke
  caches it as its **via-table** (`_relayRosters`, keyed by `via`), TTL'd by
  liveness (`RELAY_ROSTER_TTL_MS` — no refresh ⇒ hub leg dropped ⇒ reaped).
  `[agent:who]` merges these as bare `name@origin` annotated `(via hub)`.
- **Relay-out (spoke → hub), `_routeFederatedDm` leg 2.5.** After the direct
  legs miss, `_relayViaForOrigin(origin)` consults the via-table; a hit enqueues
  to the spoke's OWN outbox under `origin=<via>` with a **relay envelope**
  (`buildRelayEnvelope`: adds `finalTarget` + `hops=RELAY_MAX_HOPS`, `from`
  qualified with the spoke's `SELF_LABEL`). Reuses the box→consumer outbox leg
  entirely — no new spoke→hub transport.
- **Relay hop (the hub), `_deliverClaimedDms` → `_relayClaimedDm`.** A claimed
  message carrying a `finalTarget` isn't for a local agent — the hub relays it
  onward via a plain direct `conn.dm` (the terminal leg). This is the **one
  deliberate, bounded exception** to the loop guard: it still NEVER passes through
  `_handleIntent` (stays on the claimed-delivery side), and the **hop-count is the
  belt** — `hopRule` drops at `hops<=0`, so a re-relay that loops back dies. The
  **access gate is re-checked here** (`relayAllowed` both ends); a refusal (only
  reachable via a hand-typed off-mesh address, since discovery already hides
  non-allowed peers) bounces explicitly to the sender (`_bounceRelaySender`). The
  bounce is tagged from the **reserved synthetic sender `relay`** (`relay@<hub>` on
  the sender's spoke): a reply to it dies cleanly at the hub (no local agent
  `relay`), so don't spawn a real agent named `relay` on a hub — it's reserved.
- **The terminal-leg strip is a FEATURE, not a consequence.** `buildTerminalDm`
  (and `conn.dm`'s fixed shape) carry ONLY `{to,from,origin,body,urgent}` — the
  relay fields (`finalTarget`, `hops`, `rv`) are stripped. If the destination
  agent is offline the dest box sees an ordinary direct DM to a missing local
  name → normal park/bounce, with no `finalTarget` to chase and no way to
  re-relay. Do NOT propagate `finalTarget` onto the terminal leg — that reopens
  the loop the strip + `hops<=0` guard together close.
- **`from`'s local part is sacred; its origin suffix is the hub's to normalize.**
  The sender's agent name is never rewritten, and `from` is never replaced with a
  hop's identity (that would point replies at the hub). It's the load-bearing
  field for the reverse reply path: the destination tags the recipient's sender
  with it, and the reply re-enters the relay in reverse (dest's via-table → hub →
  origin). But the originating spoke stamps the suffix with its OWN selfLabel
  (hostname-ish, `agent@clodex-docker`), and the only origin namespace the
  destination can route a reply through is the hub's configured label for that
  spoke — what the roster advertises (`agent@docker`). So `_relayClaimedDm`
  rewrites the suffix to the hub's label on the terminal leg; shipping the
  selfLabel through unchanged hands the recipient an unroutable reply address
  whenever the two labels diverge (live failure: infra dm'd `docker@docker`, the
  ack arrived stamped `docker@clodex-docker`). Because the terminal leg carries a
  qualified `from`, the box's `/api/dm` accepts it (`isQualifiedSender`) and
  `deliverDm` uses it as the senderTag directly rather than re-qualifying with
  the hub's origin.
- **Receipts — best-effort (v1), one deliberate exception to leg-2 silence.**
  There's no true end-to-end verdict across the two async legs (that's a v2
  receipt propagation). The relay-out DOES, unlike a normal silent outbox
  enqueue, inject a sender-side `relayed via <via> → <target>` ack — a relayed
  path is longer and less obvious than a direct outbox reply, so silence there
  reads as a black hole. Sender-side only; the far end sends no receipt.

## 5. Memory (memory-store.js)

Per-agent markdown units (frontmatter: id/scope/learned_at/pinned + body).
Intents: list / remember (`scope=`, `pinned=` prefixes) / recall (exact id,
then substring) / pin / unpin / forget. Mutation acks ride the silent
`run/<name>/acks` drain for Claude (Codex: immediate inject); recall delivers
through the normal message path (spills if large).

Fresh sessions get a **boot digest** (`composeDigest`, 8KB budget): pinned
units in full (oldest first) + the rest as an index (newest first), via the
SessionStart hook's `additionalContext` for born conversations; resumed
pre-feature sessions get a one-time append rescue (`_maybeDeliverDigest`,
ledger-gated).

## 6. Protocol text (ipc-prompt.js)

`IPC_PROMPT` is the sole source of truth for the agent-facing protocol — the
canonical, all-enabled literal. `buildIpcPrompt(intentsList)` assembles the
per-seat variant from its pieces (PREAMBLE + prompt-ordered `GRAMMAR_LINES` +
gated MEMORY + TRAILER), dropping the grammar lines (and the MEMORY section) for
intents a seat may not emit; which intents those are comes from intent-catalog's
`intentEnabled`. Both create() arms call `buildIpcPrompt(intents)` off the
session's persisted allowlist. Double byte-pin (`buildIpcPrompt(null)` AND
`buildIpcPrompt(<all gateable>)` both `=== IPC_PROMPT`) keeps the pieces from
drifting from the literal. It reaches the CLI via `--append-system-prompt-file`
(Claude) / `model_instructions_file` (Codex); the agent's NAME arrives separately
via SessionStart `additionalContext`. SETTLED: the transcript symlink is the
hook's job; the prompt rides the append file.

## 7. Hook drains (cli-hooks.js, per Claude session)

Generated under the registry dir, cleaned up on exit; **generated bytes are
test-pinned** (template interiors are byte-sensitive — see architecture.md):

Scripts live under the per-agent `~/.clodex/run/<name>/` dir with unsuffixed
names (clodex-paths grammar); the parked-DM DATA stays in the shared
`~/.clodex/pending/<name>/` (only `pending.sh` relocated).

| Hook | Script | Behavior |
|---|---|---|
| SessionStart | `run/<name>/hook.sh` | repoints transcript symlink (atomic); emits memory digest on startup/clear |
| Notification | `run/<name>/attn.sh` | appends raw hook JSON to `run/<name>/attn.jsonl` (attention state) |
| UserPromptSubmit | `run/<name>/acks.sh` | read+truncate memory acks (lossy-tolerant) |
| UserPromptSubmit | `run/<name>/pending.sh` | atomic rename-claim drain of parked DMs from `pending/<name>/` (zero-loss) |
| UserPromptSubmit | `run/<name>/ctxwarn.sh` | read-only context warning; recurs every submit while over threshold |

## Invariants (do not break)

- Column-1 anchoring: the scanner sees one trimmed line at a time; anything
  that batches or reflows text before scanning must preserve line identity.
- Claimed federated DMs never pass through `_handleIntent` (loop guard).
- Ctrl-U is its own PTY write with a settle gap, never prefixed to the text.
- The reply trailer must stay parenthesized/non-column-1.
- Park ids are matched structurally, never by suffix; uniqueness is
  cross-directory.
- Parked mail survives everything except explicit user-kill.
- `_sendToSession` before `_cleanup` in the exit path (window resolution
  depends on the session still being in the map).
- IPC_PROMPT prefix-cache posture (REVISED — was "stays static"): an UNGATED
  seat's blob is byte-identical across agents, so they share the provider prefix
  cache. A GATED seat's `buildIpcPrompt(intents)` deliberately forks its own
  prefix — the accepted cost of documenting only the intents it may emit. The
  gate must be a session-config divergence, never per-turn interpolation (that
  would fork every agent's cache and buy nothing).
