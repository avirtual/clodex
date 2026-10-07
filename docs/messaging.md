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
  only dm / who / resend / name work; every other intent is agent-only and
  short-circuits.

Agent paths converge on `_extractIntents` → `parseIntent` (per line) → `_handleIntent`;
bash's `_scanPtyOutput` calls `parseIntent` → `_handleIntent` per line (no bodies).

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

**Clear continuation** (the plain-`/clear` arm; a claude seat with a pending
prompt delta cold-respawns instead — docs/sessions.md, `_promptDeltaPending`).
`[agent:context clear] <body>` stores the body on `session._postClearContinuation`
and arms `_armPostClearValve` (same 5-min timeout as compact's); the `/clear`
itself injects immediately, and a BODYLESS clear stores nothing. The continuation
fires from the sessionId-CHANGE edge in `create()`'s `onSessionId` — `/clear`
mints a new conversation id and repoints the transcript symlink, `/compact` is
in-place and keeps the id, so a changed id is the only reliable "the clear
landed" signal (a timer would inject into whatever conversation was in front of
the model). The valve exists because a clear that never lands would otherwise
leave the body armed for the NEXT id change, which could be an operator's manual
`/clear` minutes later. A second clear while one is armed drops with a warn +
`ipc-message`, mirroring compact. Applies to codex too: a codex `/clear`
produces the same edge (verified against the real CLI), though the new rollout
is minted lazily, so the edge can arrive well after the keystroke.

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
- `scratch <begin|end|cancel|mark|rewind>` (Claude seats only) — a closed
  alternation, so a typo'd sub-verb is not an intent at all: `end` and `rewind`
  CUT the transcript, and a half-parsed one is not a safe failure. `begin` is
  bare; `mark <label>` is bare and REQUIRES a label; `cancel [<label>]` and
  `rewind [<label>]` take an optional one; `end` and `rewind` take a greedy body
  and an optional `replay` modifier (`[agent:scratch end replay]`,
  `[agent:scratch rewind <label> replay]`). A label is `[A-Za-z0-9._-]`, 1–32
  chars (`SCRATCH_LABEL_RE`, intent-catalog.js), and never `replay`: on
  `rewind` the word is a modifier, so `[agent:scratch rewind replay]` is a bare
  rewind WITH replay, not a rewind to a mark called replay.
  The cut itself, named marks and the survival rule are sessions.md §3a; what
  belongs here is that all five are ordinary gateable intents whose bounces ride
  `_injectText`, parkable, each naming the mark AND the verb that was used
  (`end refused:` for `end`, `rewind refused:` for `rewind`, `mark refused:`
  for `mark`) — the same condition bounces under whichever verb hit it:
  - `begin` off a turn boundary: *it must be the last line of a reply (your reply
    went on to call tools). Emit it alone and stop; the episode opens when Clodex
    acks it. Not marked.*
  - a second `begin`: the mark is **replaced**, not stacked, and the ack says so —
    what was read under the earlier mark becomes ordinary history and is not cut.
    The re-open ack still opens with the same `ACK_PREFIX` line the validator
    searches for; a differently-worded first line would make every re-opened
    episode refuse `ack-missing`.
  - bodyless `end`: *the summary body is empty — an empty summary is a rewind that
    loses the work. Re-emit `[agent:scratch end]` with the briefing (what you now
    know, what you did), closed by `[agent:end]`. Nothing was cut; the mark is
    still open.*
  - `end` with no mark: *no episode is open — nothing was cut.*
  - `end` after a clear/reload: *the conversation was cleared/reloaded after the
    mark — the mark is gone and nothing can be cut. Your summary is in your own
    turn above; carry on from it.*
  - `end` with arrivals: *N messages arrived during the episode and would be cut
    with it* — each named with its sender and time. The escape is the modifier,
    not a flag on the refusal: re-emitting as `[agent:scratch end replay]` cuts
    AND re-delivers each arrival in order after the summary, each under
    `Replayed from scratch episode <mark> (arrived HH:MM; you saw it inside the
    episode and your summary says what you did about it — do not re-answer unless
    it says otherwise):` followed by the content verbatim from the transcript.
    `[agent:scratch cancel]` drops the most recent mark and cuts nothing. The replay follows the summary and
    only if the summary landed; an arrival with no episode behind it is the
    double-action hazard the explicit modifier exists to prevent.
  - a second `end` while one is parked for the turn boundary: *end already
    pending for mark X — waiting for your reply to finish* — and the FIRST body
    is the one that will be cut with, not the second.
  - `rewind <label>` with no such mark: *rewind refused: no mark named "<label>"
    is set — marks set: a, b (most recent first). Nothing was cut.* — the list is
    the open labels, youngest first, so a case slip self-corrects.
  - `rewind` (bare or labelled) with no mark at all: *rewind refused: no mark is
    set — set one with [agent:scratch mark <label>] as the last line of a reply.
    Nothing was cut.* `cancel <label>` bounces the same two lines under `cancel
    refused:`.
  - `mark <label>` at a point another label already marks: *mark refused:
    "<other>" already marks this exact point — one label per point. Not marked.*
    (`begin` at that point is allowed — the anonymous episode is a different
    store.) `mark` with a label already in use MOVES it, and the ack says so on
    its second line: *Label <label> re-set: the earlier point is dropped; what
    you read since it is ordinary history and will NOT be cut.*
  - `rewind` with an EMPTY body is NOT a bounce: it cuts and the briefing
    records a negative result (sessions.md §3a, "Named marks"); only `end`
    refuses an empty body.
  - `end` during a Move or Rename of the seat: refused while the name is held,
    the mark left open.
  - a Codex seat: *Claude seats only — a Codex transcript has a different shape
    and no rewind has been proven for it.*
  - **Clone path.** `begin` WITH a body (`[agent:scratch begin] <brief>`, closed
    by `[agent:end]`; greedy only when the head line carries text) does not cut:
    `_scratchCloneBegin` (`scratch-clone.js`) forks a clone seat named
    `<parent>-scratch-<4 hex>` with `--resume <parent sid> --fork-session
    --session-id <new uuid>` and the create() arguments the parent's own respawn
    builds from its record (`_scratchRespawn`), with agents and skills as the parent's effective (`sessions:`-scoped) sets. create() bakes the prompt as the parent's (role line, lead grammar, spill-example count from the parent's name and record), and the wire resolves the clone's spill stubs under `spill/<parent>/` seeded with the parent's live shown set re-keyed to the clone sid, so `system` and the expanded history match the parent's bytes and the clone reads its cache. The parent's strip level (the
    poller's last assertion for the parent sid, else the proxy's configured level, else the record's `stripLevel` clamped to `max_level`; an explicit 0 is mirrored) is
    POSTed for the new sid BEFORE create(): without it the clone's first request
    goes out unstripped and pays a full cache write. The brief is the clone's
    first user turn. The clone's `[agent:scratch end] <summary>` reaches the
    parent as one message from `scratch` (`[scratch] clone summary:`); every
    other clone intent is refused with one line. The parent's
    `[agent:scratch cancel]` kills the clone (`[scratch] clone cancelled, no
    summary`). Refused: Codex seats, a second clone while one lives, an
    empty brief, a brief left unclosed, and any begin from a clone.
  - **Clone mute list** (`session.clone`, never persisted, not restorable):
    `_notifyComposition` and `_maybeInjectComposition` (no roster, no
    spawned/retired notice), `_teamLiveSeats` and `who` (never listed),
    `_deliverMessage`, `_deliverPassive` and `_injectTextPassive` (nothing from
    reminder, memory, team, reboot or the ticket loop), `_gatedDeliver` and the
    `dm` case (*not addressable*), and `_maybeAutoCompact` plus the poller's
    strip level, which reads the parent's record. Retire is quiet: no cost
    stamp, the record dropped, the clone sid's strip override and spawner hint
    cleared. The clone has a sidebar row in the parent's window badged "clone" (a background `reattach` from `_scratchCloneSpawn`); the mute list is unchanged; the row is read-only for the operator (no rename, no move, no delete), and its one action, Cancel clone, is the parent's `[agent:scratch cancel]`.
  - **Clone ceiling:** `SCRATCH_CLONE_CEILING_MS` (45 min). On expiry the clone
    is killed and the parent hears *[scratch] clone <name> ended without a
    summary (45m ceiling)*. A clone that exits on its own sends *exited without a
    summary*; a parent that exits or is killed takes its clone with it.
- **Multi-line bodies** are captured in `_extractIntents`, not the scanner: a body (dm, memory
  remember, remind, shout, task verbs) runs to the next column-1 real intent or a bare `[agent:end]`;
  left open with lines after the head, only the head line applies, the rest is prose and the seat is told;
  review-done, scratch end/rewind and context clear/compact/reload are refused outright (an open head with nothing after it still applies).
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
  It exists so operator-facing prose can FOLLOW a body (without it, an open
  body is handled as the Multi-line bodies bullet says) and
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

**Build** — `_buildDeliveryText`: `[agent:from <senderTag>]` prefix + body (an operator dm whose POST named a `client` reads `[agent:from user] (via <client>) body`; only `user`'s tag rides inline, every other sender's tag labels the spill pointer alone), and
on a dm whose reply would DROP, the marker `(no reply path)`. Polarity is
inverted against the old reply trailer: an answerable dm costs zero bytes, and
the marker is emitted only when the reply path is missing on one end — the
RECEIVER's `dm` intent is off (fresh persistence read), or the SENDER is not
dm-reachable NOW (`_isDmReachable`: a live local agent session, or a federated
`name@origin` that is online or known via `_knownDmOrigins`, the outbox or a relay), as with a `nc -U` wake script's `from:"t1-wake"`
that no session answers. It is parenthesized and non-column-1 so it can never
self-fire. Non-dm mtypes and `SYSTEM_SENDERS` (`team`, `reminder`, `user`, …)
get nothing at all: nobody answers them, so a fault marker would be noise —
and that check precedes reachability, which goes true by accident the moment a
seat is named `team`. Coupled to `_deliverMessage`'s drop-if-absent — widen
`_isDmReachable` if local dm parking ever covers absent targets. Bodies over
`MSG_SPILL_THRESHOLD` (500B), and a Claude PTY delivery of 4 or more delivered lines (image lines included; docs/notes/session-manager-stream.md `## _buildDeliveryText`), spill to `~/.clodex/messages/` — Claude gets
`@<path> ` (trailing space closes autocomplete; the file auto-attaches),
Codex gets a read-with-Read pointer. That hand-off copy is swept after
`MSG_MAX_AGE` (30 min); `spillToFile` also writes a durable copy, same
basename, to `~/.clodex/spill/<seat>/messages/`, which is never swept. The ring
records the transcript-literal `messages/<seat>/` path; `list()`, `filePeek` and
`resolveDisplayedPath` fall back to the durable copy (`durableMessageCopyOf`). A non-system sender's body line that starts with `[agent:from` is quoted with `> ` before either branch, spilled file included, so a peer cannot forge a sender line; the ticket-loop defuses the hand/reviewer spans inside its own notices the same way.

**Inject** — `_injectText` has two layers:
1. *Turn batching*: `_injectHoldReason` (compact window / permission dialog /
   thinking) queues injects and flushes them as one joined turn on release;
   `INJECT_HOLD_TIMEOUT` (5min) is the force-flush valve. `bypassHold` skips
   this layer (compact continuations, slash commands).
2. *Byte atomicity*: the per-session `InjectQueue` (inject-queue.js)
   serializes Ctrl-U → text → settle → Enter as one atomic unit. Ctrl-U MUST
   be its own write with a ~30ms settle gap — sent in the same chunk as the
   text it lands as a literal character (this was the historical
   mid-draft truncation bug). The text write first drops the invisible characters Claude Code 2.1.286 would strip and hold for a second Enter (review-gate.js ports its rule: controls and default-ignorables such as zero-width spaces, soft hyphens, directional marks outside right-to-left lines and all other bidi controls and stray tag or variation characters, but not the joiners and selectors the CLI keeps inside emoji or joining scripts); Codex seats are written as-is. The text write then defangs the CLI's teammate-message tag (review-gate.js `defangTeammateTag`): a U+2011 hyphen in `<teammate‑message` and `</teammate‑message>`, every route, fenced blocks included, so no delivered body can be rewritten into a subagent result. The quiet-gate defers firing while the
   operator typed within `INJECT_QUIET_MS` (2s), capped at
   `INJECT_QUIET_MAXWAIT` (5min, logged as splice risk). The bracketed-paste write lets Claude Code wrap a large delivery as untrusted pasted text; the PREAMBLE's peer-messages paragraph in ipc-prompt.js tells seats the sender line sets the trust (tasks/opus-5-5-prompting-survey/REPORT.md item 2). A multi-line text to a Claude seat also waits for mode 2004 (`pasteMaxWaitMs` = `INJECT_PASTE_MAXWAIT`, 10s), since a raw multi-line write is held unsent in the composer; at the cap a diverted delivery is re-parked and any other is written bracketed anyway.

**Park-at-fire divert** — injects marked `parkable` re-check
`_parkDivertFor` at the moment of writing: if the operator has a draft open,
the delivery parks instead of splicing into the draft. Opt-in at conversational
call sites only; self-intents are never parkable.

Two independent readings of "a draft is open", because the two kinds of draft
reach Clodex by different routes and neither predicate can see the other's:

- **Typed** — `isDraftOpen`, stateful across PTY chunks including bracketed
  paste, fed by `isHumanPtyInput` inside `SessionManager.write()`. Held until
  he submits or clears.
- **Dictated** — `_voiceDraftOpen`, an expiring stamp
  (`INJECT_VOICE_DRAFT_STALE_MS`) refreshed by the renderer while a non-empty
  composer sits under a recently-lit recorder. Dictated words never pass
  through `write()`, so no typed stamp ever moves for them and the typed
  predicate reads such a seat as idle. Distinct from the `speaking` gate in
  inject-queue.js, which defers only while the recorder is LIT: the indicator
  goes dark when he stops talking, and the exposure is the reading that follows.

  The composer read is MULTI-ROW: the CLI hard-paints continuation rows
  (`isWrapped` is false on them, measured) with a two-space indent, so a long
  dictated draft — the case the protection exists for — puts the cursor on a row
  carrying no marker. The watcher scans upward from the cursor, bounded by the
  screen height, for the composer head.

  It EXPIRES rather than waiting for a release event, because dictation has no
  submit Clodex can observe. Every way the report can stop — submitted, cleared,
  seat switched, window closed, screen unreadable — releases it, and the park
  cap bounds it again from a timer that reads no voice signal. The renderer's
  composer read is positive (`draftFromRows` in `renderer/voice-mirror.js`) and never
  `!composerIsEmpty`: an unreadable row, a scan that falls off the top, and a
  head that is never found all decline, because an unreadable screen must not
  park deliveries nothing can then release.

The idle and boot-ready pending drains consult `_anyDraftOpen` — BOTH
predicates — rather than `isDraftOpen` alone. Guarding on the typed one let a
dictated draft through, `drainPending` claimed the directory destructively, and
the divert re-parked the joined text as one ACTIVE entry: no message lost, but a
`.passive.` park came back active, and a passive park never earns a turn.

Any unit written into a fresh seat within `INJECT_BOOT_MAXWAIT` of the readiness edge that produces no turn within
`BOOT_NUDGE_MS` (4s) gets ONE `\r` written to the pty, once the CLI has drawn the unit into its composer (its first 32
visible characters, or the `[Pasted text #N]` placeholder, appear in pty output after the write), the seat has then been
quiet `BOOT_NUDGE_QUIET_MS` (1s), and no draft is open. A `--resume` loading a large transcript is silent while its input
loop is not reading stdin, then reads everything buffered as ONE paste, so an Enter sent during the silence lands as content
(measured: 61 MB resume, first `\x1b[?2004h` at +0.18s, loop reading at ~+20s, both Enters eaten by the "Removed 1 invisible
character · review and press Enter" gate). Neither silence nor a boot render tail is the echo: no echo yet, further output, or an open draft re-arm
the nudge for `BOOT_NUDGE_QUIET_MS`. It is cleared by the turn edge and by kill, gives up `BOOT_NUDGE_MAXWAIT_MS` (120s) after the write, and logs `boot-drain nudge for <seat>` when it fires. The boot replay pass waits for the
inject queue to empty (capped at `INJECT_BOOT_MAXWAIT` past the edge), so a spawn-path spec is stamped before the pass looks for its stamp.

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
  An `urgent` re-send of the same body from the same sender claims any parked
  copy for that target first (content key = sha256 of sender + body), so the
  target never reads it twice.
- Drains: `run/<name>/pending.sh` (UserPromptSubmit and PostToolUse hooks) delivers
  parked mail with the target's own next turn or tool boundary; the busy/draft park arms a non-destructive
  5min cap (`_armParkCap`) that drains through the inject queue. Cost/dialog
  hold-parks do NOT arm the cap — they wait for the target's next turn or an
  explicit resend. A unit whose text is already claimed when the seat dies or
  is marked `_recycling` (`_quiesceInjects`, before a scratch cut kills the
  pty) is re-parked through the queue's `onUndelivered` with the seat's `born`,
  so these drains deliver it to the respawned process. On that seat the
  boot-ready drain (`_bootReadySeen` edge + `BOOT_DRAIN_SETTLE_MS`) and the
  briefing (`_injectAfterBoot`: transcript symlink + `RELOAD_CONTINUATION_DELAY`)
  share one queue, so enqueue order decides: at the defaults (750 ms and
  2500 ms) the drain enqueues first unless the symlink lands more than ≈1.75 s
  before the mode-2004 edge, so the re-parked delivery normally precedes the
  briefing.
- **Operator flush** (`countPending` + `flushPending` / `_flushParkedNow`) — a
  parked-DM count badge (`✉N`) on the sidebar session row, fed by a 1s
  `pending-count` poll (deltas only) over live Claude sessions plus a seed from
  the reattach snapshot. Clicking it drains that session's queue NOW: the same
  atomic claim as the cap (tag `flush.<pid>`), injected NON-parkable (so a
  flushed message can't re-park — the recursion a `parkable` resend could hit).
  It's the operator's true "deliver now" override, sidestepping the sender-
  notice cost entirely (the operator has no turn cost). Guards: refuses any
  `_injectHoldReason` target (dialog-blocked, busy, compact-window) WITHOUT draining (draining would move zero-loss durable
  files into the volatile in-memory queue behind the hold). **Operator-only**
  via the `session:flushPending` ipcMain.handle — there is deliberately no
  agent-facing flush verb (agents keep `[agent:resend]` for id'd cost-holds).

## 4. DM federation (`name@origin`)

The tunnel is one-way — the consumer dials the box, never the reverse — so
the two directions use different transports (full wire detail in
[peering.md](peering.md)):

An `@origin` matches a peer's configured label, its id, or the host label it
announced in hello — in that order, case-insensitively, through the one
`findPeerByOrigin` resolver every site calls.

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
  origin string) so a reply to that `[agent:from]` address routes back through
  our own config.
- `SELF_LABEL` = `CLODEX_LABEL` if set and it clears peer-outbox's
  `validOrigin` gate, else the hostname minus `.local` (the fallback also
  covers a blank or rejected value, which logs one warning). It is the origin
  we present when we DIAL: the dialed box tags our agents `name@<our label>`,
  records that origin, keys our reply outbox by it, and its agents reply to
  that address. It is also the hello `host` it displays for us. On the dialing
  side the suffix is our own configured label for that peer instead, per the
  bullet above. Two instances on one box that both dial the same peer would
  otherwise present one hostname origin and be conflated there — see
  `docs/recipes/two-instances.md`.
- `[agent:who]` appends federated addresses for online dm-cap peers. It also
  lists ALL local agent sessions regardless of workspace (not just the
  sender's) — parity with that cross-workspace federated listing, and every
  listed name is a valid dm handle since the session map is globally keyed.
- Accepted asymmetries: a park on the mailbox leg sends the remote sender
  no notice; the claim endpoint is origin-unauthenticated (tunnel-trust,
  same posture as control acquisition).
- **`[agent:shout]` from a box seat** rides the same pull: the note
  lands in the BOX's inbox, and the desktop claims it onto its own inbox as
  `<seat>@<origin>` (toast and badge included), removing it from the box —
  see [peering.md](peering.md) for the `inbox: 'claim'` mark that gates it.
- **Deploy-fix self-archive**: a note whose first line starts `DEPLOY OK `,
  raised by a session carrying `fixFor`, archives that session after the note is
  delivered — nothing else triggers it.

## 4a. Hub-relay federation (spoke ↔ hub ↔ spoke)

Spokes never dial each other — only the hub holds a tunnel to each. So a
spoke→spoke DM is **relayed through the hub**, reusing the two federation legs
above wholesale. Wire-format single source of truth: **relay-protocol.js**
(`RELAY_ENVELOPE_V`, `RELAY_MAX_HOPS`, the envelope/roster helpers); the
per-peer opt-in is the `relayAllowed` setting; the build capability is the
distinct `relay` cap.

- **Discovery (roster push).** The hub computes, per allowed spoke X, the
  agents X may reach on its OTHER allowed peers (`computeRosterFor`:
  split-horizon — never X's own — plus the **symmetric** `relayAllowed(X) &&
  relayAllowed(Y)` gate) **and its own local agents**, under the hub's
  `SELF_LABEL`. The local rows ride the symmetric gate alone — the
  both-endpoints gate is about a third party Y and the hub is not one — and the
  claude/codex type filter keeps bash sessions private. It **pushes** the result
  to X via `POST /api/peer/roster`
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
through the normal message path (spills if large or, on a Claude terminal seat, at 4 delivered lines).

Fresh sessions get a **boot digest** (`composeDigest`, 8KB budget, half of it for
bodies), newest first throughout: up to `OPERATOR_PIN_CAP` operator-pinned units in
full, then recent units in full (bodies up to `RECENT_BODY_CAP`; agent `pinned` only
breaks recency ties), then the rest as an index, via the
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
session's persisted allowlist. A fourth `opts` argument's `teamLead` flag adds
the `[agent:team …]` grammar rows, which create() sets only for the seat its
team names as lead. Double byte-pin (`buildIpcPrompt(null)` AND
`buildIpcPrompt(<all gateable>)` both `=== IPC_PROMPT`) keeps the pieces from
drifting from the literal. It reaches the CLI via `--append-system-prompt-file`
(Claude) / `model_instructions_file` (Codex); the agent's NAME arrives separately
via SessionStart `additionalContext`. SETTLED: the transcript symlink is the
hook's job; the prompt rides the append file.
The PREAMBLE's transport sentence names the `sub` intent for a seat's own
subagents and `dm` for clodex agents; the `sub` grammar line renders only for a
seat whose allowlist admits `sub`.

Allowlist shape: an absent `intents` is the living default (every ordinary
intent on, privileged off); an explicit array is a frozen subset; `'*'` inside
an array is the living default carried beside privileged or plugin grants and
grants none of them itself; `['*']` is equivalent to absent. `persistence._load`
rewrites a pre-`sub` array holding every ordinary intent plus a grant to the
`'*'` form once. An explicit array a template saved before `sub` existed
therefore does not admit `sub`; the disabled bounce names the explicit list,
and the fix is `[agent:team template-save <stem>]` with `sub` added, or Edit
Session › Intents.

## 7. Hook drains (cli-hooks.js, per Claude session)

Generated under the registry dir, cleaned up on exit; **generated bytes are
test-pinned** (template interiors are byte-sensitive — see architecture.md):

Scripts live under the per-agent `~/.clodex/run/<name>/` dir with unsuffixed
names (clodex-paths grammar); the parked-DM DATA stays in the shared
`~/.clodex/pending/<name>/` (only `pending.sh` relocated).

| Hook | Script | Behavior |
|---|---|---|
| SessionStart | `run/<name>/hook.sh` | repoints transcript symlink (atomic); emits memory digest on startup/clear/compact |
| Notification, PreCompact | `run/<name>/attn.sh` | appends raw hook JSON to `run/<name>/attn.jsonl` (attention state) |
| UserPromptSubmit | `run/<name>/ipcdelta.sh` | emits the IPC-prompt delta from `promptcache/<name>/delta.md`, then advances the baseline |
| UserPromptSubmit | `run/<name>/acks.sh` | read+truncate memory + task acks (lossy-tolerant): a ticket verb's success confirmation written here is lost if the seat dies before its next turn, which is acceptable because the ticket record and `[agent:task list]` stay the truth |
| UserPromptSubmit | `run/<name>/pending.sh` | atomic rename-claim drain of parked DMs from `pending/<name>/` (zero-loss), and spools one `delivered.jsonl` line per handed-over entry (`{ts, ev, file, head}`), tailed by the seat's ctxWatcher into an `ipc-message` `kind:'delivered'` row |
| UserPromptSubmit | `run/<name>/selection.sh`, `run/<name>/notices.sh` | claim-by-rename drains of copied selections and of `notices/<name>/queue.jsonl` (deferred notices) |
| UserPromptSubmit | `run/<name>/ctxwarn.sh` | read-only context warning; recurs every submit while over threshold |
| UserPromptSubmit | `run/<name>/poll-guard.sh` | clears `run/<name>/poll-state` — a new turn resets the repeat counter, so an operator's own reply can never be what trips the PreToolUse deny |
| PreToolUse (`matcher: Bash`) | `run/<name>/bash-live.sh` | an OBSERVER for the live console: records the call under `run/<name>/bash-live/`, then exits 0 having printed NOTHING. A PreToolUse that emits `updatedInput` or exits 2 alters or blocks the Bash call, so silence is the safety property, not a style choice. Bails on `[ -e .watching ]` BEFORE reading stdin: unlike `bash-console.sh` it spawns an interpreter, so it earns that cost only while a pane is reading — `bash-live.js` writes the sentinel as it reads and removes it when the SEAT is reaped, which is per-seat rather than per-watch precisely because a tab sits watchless between calls |
| PreToolUse (`matcher: Bash`, after the observer) | `run/<name>/bash-guard.sh` | the one PreToolUse hook allowed to SPEAK: on a seat whose env carries `CLODEX_TICKET` (set only by `_spawnTicketSeat`, never by the reviewer path or by a template), a `git add` with `-A`/`--all`/`--no-ignore-removal`/`-u`/`--update`/`.`/`:/`/`*` or a `git commit` with `-a` returns `permissionDecision: deny` naming the ticket, and every other command passes. The command is tokenized with real quote handling and split on `;`, `&&`, `|` AND newlines, so `git status\ngit add -A` — the default shape a hand writes — is examined per command rather than collapsing into one whose subcommand is `status`; a backslash-newline stays a continuation. Registered AFTER `bash-live.sh` so a denied call is still in the live console that explains the deny. Gated on `[ -n "$CLODEX_TICKET" ]` before reading stdin, so a lead or a bash tab pays nothing and can never be denied; fail-OPEN on an unparseable payload, since a hook in front of every Bash call that denied on garbage would wedge the seat |
| PreToolUse (`matcher: Bash`, after the guard), SubagentStart | `run/<name>/hook-ident.sh` | stamps `CLODEX_HOOK_IDENT=@<nonce>` onto every `clodex` segment, never inside a heredoc body; a looped segment is main only on its first run (the stamp itself in `run/<name>/ident/<nonce>`) through `updatedInput` (§7b); silent for any other command. On SubagentStart, one `additionalContext` line naming the `clodex` verb, plus the `[parent <nonce>]` trust line (§7b) |
| PreToolUse (`matcher: ''`, all tools, registered after the Bash block) | `run/<name>/poll-guard.sh` | counts CONSECUTIVE identical Bash commands in `poll-state` and returns `permissionDecision: deny` on the third, naming the ticket (or, on a seat without `CLODEX_TICKET`, the seat) and the first 60 chars of the command; any non-Bash tool resets the count, so it fires only on a genuine poll loop. Runs on every Claude seat, not only ticket hands, and exits silently on a payload carrying `agent_id` — a subagent's own calls are exempt |
| PostToolUse (`matcher: ''`) | `run/<name>/pending.sh` | the same parked-DM drain at every main-agent tool boundary (a subagent's call, which carries `agent_id`, is skipped), and spools one `delivered.jsonl` line per handed-over entry (`{ts, ev, file, head}`), tailed by the seat's ctxWatcher into an `ipc-message` `kind:'delivered'` row |
| PostToolUse (`matcher: ''`, after pending.sh), SubagentStop | `run/<name>/subq.sh` | in a subagent (`agent_id`): rename-claims `run/<name>/subq/<agent_id>` and returns it as one `additionalContext` note `[parent <nonce>] <body>` under the firing event's name. On the parent's `Agent` result: writes `subq/names/<name>` = the agent id. On the parent's `TaskStop`, and on SubagentStop: parks a still-queued note into `pending/<name>/` as `[agent:sub] undelivered to <id> (…)` and removes the nonce and name files. Each delivery, undelivered park and missing nonce appends one `subq/receipts.jsonl` line |
| PostToolUse (`matcher: Bash`) | `run/<name>/bash-console.sh` | spools the raw hook JSON as ONE FILE PER RECORD under `run/<name>/bash-console/`, claimed by atomic rename (Bash hooks fire concurrently; a shared append loses records). The `<epoch-ns>-<pid>.json` name falls back to whole seconds where `date` has no `%N`, and its `.tmp` sweep is `kill -0`-guarded — an unguarded one deletes a live writer's spool |
| PostToolUse (`matcher: Bash`) | `run/<name>/poll-guard.sh` | on a call with `run_in_background: true`, injects "Result arrives as a notification: do not poll for it. End your turn now unless you have unrelated work.". A foreground Bash call gets nothing — the guard speaks only where there is something to wait FOR |
| PostToolUse (`matcher: Agent\|Task`) | `run/<name>/poll-guard.sh` | the same injection after a subagent spawn, which is the other shape whose result arrives as input rather than a return value |
| PostToolUseFailure (`matcher: Bash`) | `run/<name>/bash-console.sh` | the same spool write — a FAILING Bash call fires only this event, with no `tool_response` and the exit code inside a top-level `error` |
| PreToolUse (`matcher: ''`, stream seats only) | `run/<name>/tool-boundary.sh` | appends `{"hook_event_name":"PreToolUse","ts":…}` to `attn.jsonl` and prints nothing; `_routeAttnEntry` turns it into a tool-boundary drain of the stream seat's outbox |

## 7a. Stream seats (`io: 'stream'`)

A stream seat has no PTY to inject into, so everything that would be injected goes
into ONE in-memory outbox per seat (`s.outbox`, items `{text, images, origin}`):
what the operator types (`seatSend`, origin `operator`) and everything Clodex
delivers — dms (spilled over 500 bytes exactly as for a PTY seat; the 4-line gate is terminal-only), ticket
deliveries, reminders, exec results, continuations (`_deliverMessage` /
`_injectText`, origin `system`). An idle seat takes the item at once as its own
stdin message.

- **Hints:** a composer send arms contextual and selection hints like a PTY
  Enter (`_armSubmit`: final draft arm, submit, selection submit), and the
  composer's typing pause pre-arms through `seat:draft` (`seatDraft`). While
  the arm holds (`holding`, or a final rank still landing, capped at
  `STREAM_ARM_WAIT_MS`), an idle seat parks new items in the outbox instead of
  writing stdin, bounded by the hint hold cap.

- **Ordering:** operator items go to the head of the outbox, behind earlier
  operator items; system items append. That is the operator's only privilege —
  there is no send-now and no steer.
- **Drain 1, turn end:** the `result` event sends the WHOLE outbox as one stdin
  message, joined by a blank line.
- **Drain 2, tool boundary:** `tool-boundary.sh` (PreToolUse) writes an attn
  line; `_onStreamToolBoundary` sends only the SYSTEM items as one message,
  leaving operator items for `result` and the seat busy. At most one such drain
  per `STREAM_TOOL_DRAIN_MIN_MS` (2s) per seat.
- The UserPromptSubmit drains (§7) still fire under `-p` and are not copied into
  the outbox. Passive notices and held (cold-seat) dms still park to
  `pending/<name>/`; the idle edge drains active parks into the outbox.
- The composer shows queued items as dimmed `.seat-outbox-row`s, fed by
  `transcript:pull` (`outbox`) and refreshed on `transcript-changed`.

## 7b. Subagent channel (intent-socket.js)

A subagent's text never reaches the intent scanner (§1), so Claude and Codex
seats get a request/response channel whose reply is the caller's own tool result.

- **Socket:** `run/<name>/intent.sock` (kind `intentSocket`), mode 0600, bound by
  `_startIntentSocket` after the seat is registered, closed in `_cleanup`, and
  unlinked with `run/<name>/` on every exit path (`dropRunDir`).
- **Env:** `CLODEX_SEAT`, `CLODEX_INTENT_SOCK`, `CLODEX_INTENT_CRED` (32 random
  bytes, hex; held in memory as the non-enumerable `session.intentCred` and in
  the CLI env only). No KEY/SECRET/TOKEN in the names, so Codex's default shell
  env excludes keep them. `PATH` gets `~/.clodex/bin` prepended, where
  `materializeSeatVerb` stamps `cli/bin/clodex.js` as an executable `clodex`.
- **Wire:** one JSON line `{cred, intent, agentId?, ident?}` or `{cred, tool, args}` in, one JSON line
  `{ok, status, reply}` or `{ok:false, status?, error}` out. `status` is `ok`, `error`
  (first reply line `[agent:<verb>] error: …`) or `refused` (a subagent refusal, or a
  line the plugin's `classifyReply` calls refused — a plugin's refused classes (the browser pane's
  denylist and ⚠ gate, for instance)). Wrong cred → `unauthorized`; over 64KB
  → `request too large`; a ninth concurrent connection → `busy`; 10 s → `timeout`.
  One intent per request, parsed by `_extractIntents` (same body rules as PTY text).
  `{cred, tool, args}` is a tool call by catalog name (`run/<seat>/mcp-tools.json`),
  always handled as a subagent request whatever identity fields it carries: the seat's
  live grant for the owning verb is checked, then the plugin's `toIntent` maps `args`
  to one intent of that verb, then the same refusal/dispatch path as an intent. New
  answers: `{ok:false, status:'invalid', error}` (the mapper rejected the arguments),
  `unknown tool: "<name>"` (unregistered or not granted — one text),
  `tool <name> emitted a foreign intent` (plugin bug).
- **Reply capture:** `_handleIntent(name, intent, {replyTo, fromLabel})` runs the
  unchanged handler inside an AsyncLocalStorage scope; `_injectText` to the
  sender seat goes to `replyTo` instead of the PTY until the response is sent;
  the plugin handle carries `from` = that label.
  Anything later (a dm's answer, an exec run's result) takes its normal path to
  the seat's main conversation, and a call with no captured acknowledgement
  answers `sent to <target>; a reply arrives in the seat's main conversation`.
- **Identity (Claude):** the PreToolUse Bash hook `run/<name>/hook-ident.sh` prefixes every
  `clodex` segment of the command with `CLODEX_HOOK_IDENT=@<nonce>` through `updatedInput`
  (a pre-existing `CLODEX_HOOK_IDENT=` in the segment is removed). The shell wrapper exits
  before starting the interpreter unless `clodex` appears after the input's `"command"` key, or the input is `SubagentStart`
  (`transcript_path` and `cwd` come first and may contain `.clodex`).
  The stamp also reaches a `clodex` behind `if then else elif do while until !` and `time`
  (stamped after those), and behind `command exec env builtin nohup`, `timeout [flags] <duration>`
  and `nice [-n <n> | -n<n> | -<n>]` (stamped before them, so the assignment reaches `clodex`'s env).
  A `clodex` that is an argument (`echo clodex`, `which clodex`) is not stamped. Each stamped
  segment gets a fresh 16-hex nonce, and the stamp itself goes to `run/<name>/ident/<nonce>` (0600),
  never onto the command line: `main.<nonce>.<hmac16>` with no `agent_id` in the hook input, else
  `sub.<agent_id>.<agent_type>.<nonce>.<hmac16>`; the HMAC-SHA256 is keyed by the seat credential
  (env, else `run/<name>/intent.cred`, 0600) over `kind + agent_id + session_id + nonce`. The verb
  reads the file named by `@<nonce>` and unlinks it. The socket treats a Claude caller as the main
  agent only when `ident` verifies as `main` for the seat's current `sessionId` and its nonce has
  not been seen (512 nonces, 10 min); anything else — no stamp, a forged, old-shape or replayed
  one, or no `sessionId` yet — is a subagent, and a replay logs a warn. The stamp is single-use
  and file-backed: copying a `CLODEX_HOOK_IDENT` value from `time`, `set -x`, `ps` or any other
  output does nothing. A heredoc body (`<<WORD`, `<<-WORD`, quoted delimiters) is text, never
  stamped. One stamped segment the shell runs more than once (a `for`/`while` loop body, a shell
  function) is main only on its first run: every later run finds the file consumed and drops to
  subagent with the "stamp missing" line. A stamped call first sweeps `ident/` files older than
  `IDENT_SEEN_MS` (10 min), which could never verify as fresh.
- **Identity (Codex):** the seat is Codex by `session.agentType` (a clone has no persistence
  entry); `agentId` from `CODEX_THREAD_ID`; equal to the seat's `sessionId`
  or its uuid tail (uuid-shaped ids only) is the main thread; a call with no `agentId`, or a seat
  with no `sessionId` yet, is a subagent. Codex identity is asserted by the caller's environment,
  not proven: there is no HMAC on the Codex path, so a subagent that learns the rollout uuid can
  pass as main; the Claude stamp (`hook-ident.sh`) is the proven one.
- **Subagent filter:** a subagent call is refused unless the intent's plugin row declares a `subagent` policy that allows it (`subagentAllows`, intent-registry.js); the browser policy lives in plugins/browser-pane/subagent.js. Everything else answers `not available to a subagent: <verb> — return and let the seat's main agent do it`: a subagent has no inbox, so a dm from it could never receive a reply (Claude Code's SendMessage carries subagent↔parent traffic), and an exec result would arrive as input it never sees.
- **Verb:** `clodex '<intent>' [more words…]` (args joined with spaces into one line) or `clodex -` (stdin, for a multi-line body). Forwards
  `CLODEX_AGENT_ID`, else `CODEX_THREAD_ID`, as `agentId` (Claude exports no
  agent-id env var as of 2.1.289), and `CLODEX_HOOK_IDENT` as `ident` (an `@<nonce>` value resolved
  through `ident/<nonce>` beside the socket; a missing or empty file sends none, with stderr
  `clodex: identity stamp missing (hook not installed?)`). stdout carries
  the intent's reply; the verb's own lines (refusals, unauthorized, no socket, timeout)
  go to stderr as `clodex: <reason>`. Exit 0 ok, 1 error (the reply, or stderr `clodex: …`),
  2 usage, 3 refused (stderr `clodex: …`), 4 no socket, 5 timeout. The client waits up to 500 s,
  30 s past the registry's 470 s plugin-wait cap, so a plugin's longest wait answers
  inline and the server always times out first; `clodex --help` lists the seat's MCP
  tools from `run/<seat>/mcp-tools.json`.
- **SubagentStart:** the same `hook-ident.sh` answers `SubagentStart` with one
  `additionalContext` line composed from the seat's `run/<name>/mcp-tools.json` briefs (one sentence per granted plugin that declares a tool), followed by the parent trust line. A seat with no such plugin gets only the trust line.
- **Parent → subagent (`sub`):** SubagentStart mints a 16-hex nonce into `run/<name>/subq/<agent_id>.nonce` (0600; an existing one is reused) and the trust line names it: notes starting `[parent <nonce>]` after a tool call come from the spawning agent. `subq.sh` drains `subq/<agent_id>` at the subagent's next PostToolUse. Hook inputs carry only the `agent_id`, so a name resolves only after the parent's `Agent` tool has returned, through `subq/names/<name>`. That name map is written by the parent's `Agent`-tool PostToolUse (id from `tool_response.agentId` or `agent_id`, shaped `a<name>-<16 hex>` on CLI ≥ 2.1.29x, bare `a<16 hex>` on older builds); a sub-subagent spawned by a subagent is not name-mapped. A killed subagent fires no SubagentStop, so the parent's `TaskStop` hook parks its queued note for the seat. A note queued after the subagent's last tool call is parked by SubagentStop. The seat's `[agent:sub <target>]` (session-manager `_handleIntent`) resolves the target with subq.js `resolveSubagent` — an id with a `.nonce`, or `names/<target>` pointing at one — appends the body to `subq/<agent_id>` (0600), and otherwise bounces `NOT delivered: no running subagent`. Every conversation replacement — `_coldRespawn` and the session-id edge a warm `/clear` produces in `onSessionId` — calls subq.js `clearSubq` on `subq/`, since the killed subagents fire no SubagentStop. The queue is one append-mode file claimed by rename, so a note written in the microsecond window between the hook's rename and its read can be lost without a receipt; a per-note directory claim is the known fix.
- **MCP (Claude):** `run/<name>/mcp.json` names `cli/bin/clodex-mcp.js` under the hooks' interpreter; pushed as `--mcp-config` unless the seat's extra args carry their own `--mcp-config`/`--strict-mcp-config` (then a `MCP:` system row says the tool is unavailable); with the claude_design strip fallback it rides `--strict-mcp-config --mcp-config` and is the only server. Next to it, `mcp-tools.json` is the seat's tool catalog, written from its grants at spawn and rewritten on every grant change (content `rev`; unchanged content is not rewritten). `clodex-mcp` reads `mcp-tools.json` for `tools/list`, forwards `tools/call` as `{cred, tool, args}`, and sends `notifications/tools/list_changed` within 2 s of a `rev` change once the client has initialised.
- **Client hang-up:** a caller that disconnects before the reply (its tool timeout)
  closes the reply sink, so a late plugin reply falls back to the seat's PTY.
- **Deferred:** the SubagentStop late-reply handoff.

## Invariants (do not break)

- Column-1 anchoring: the scanner sees one trimmed line at a time; anything
  that batches or reflows text before scanning must preserve line identity.
- Claimed federated DMs never pass through `_handleIntent` (loop guard).
- Ctrl-U is its own PTY write with a settle gap, never prefixed to the text.
- The no-reply marker must stay parenthesized/non-column-1.
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
