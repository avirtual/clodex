# t72 — conversation cache busts: why they are 85% of cache spend

Branch off master (`2c2fb99` at time of writing — re-check, t94 may have merged).
**MEASUREMENT ONLY. No product change.** Deliverable is a characterization with
numbers plus a recommendation, and "inherent, nothing to do" is a complete
successful answer.

Full spec: `/Users/bogdan/.clodex/messages/clodex-hand/msg-55910-68.txt`
(clodex first sent this as t95, then cancelled t95 as a duplicate of t72 and
carried the spec over. Work it as t72; the t95 text is the detailed version.)

## The claim under investigation

From warmth.json `bust_class` attribution over 1333 requests in one seat:

    conversation   60 busts   1,991,047 cache-creation tokens
    preamble       13            341,560
    tools           3            222,367
    lapse           2            128,282
    system          1             31,506
    none         1257

~85% of cache spend, ~63x the combined prize of t68/t69/t70.

## What to establish, in order (from the spec)

1. **What does wirescope classify as `conversation`** — read warmth.py's
   classifier and state the PRECISE rule. Do not infer it from the name.
   Everything downstream depends on this.
2. **Inherent or avoidable?** The whole question. t60 found all 39 preamble
   busts were compacts — inherent, correctly excluded. Same rigour here.
   Report the split explicitly; never present inherent cost as savings.
3. **For any avoidable subset:** first divergence, and is it Clodex-controlled?
   `report.py`'s `bust_series` already byte-diffs adjacent turns and returns
   label/old/new/char_offset — use it, do not rebuild it.
4. **Pattern by seat or workload?** If one pathological session dominates, the
   fix is a usage change, and saying so is a complete answer.
5. **Is 85% even right?** Never re-derived. If it is wrong, THAT is the
   finding — stop there and say so.

## Standing method (bit us repeatedly this week)

- Read captured bodies off disk; do not reason from code intent. Two code
  comments and one of clodex's priors measured false this week.
- **Watch for the instrument lying.** Before trusting any number, establish
  what it would look like if the mechanism being measured were ABSENT. A
  measurement that reads the same either way is not a measurement.
  (Precedents: grep silently refusing a binary file; a stat reporting `Bin`
  for text; a test count from the wrong tree.)
- If scaffolding gets built, say explicitly whether it should ship or was
  scratch.

## Constraints

Branch off master, do not touch master, do not push, do not edit
`.claude/CLAUDE.md` or `.claude/memory.md`. Full report goes in the
`[agent:task done t72]` close body, not a dm.

## Phase A — locate the data and the classifier

(next)

Branch `t72-conversation-cache-busts` off master `3873854` (t94 merged; clodex
confirmed 3044/3044 on master, both t94 deviations accepted).

## Phase A — located the data and the classifier (DONE)

Wirescope = `/Users/bogdan/projects/proxy-lab` (proxylab). Live instance is the
port-7800 proxy (pid 60378), whose env points at
`~/Library/Application Support/clodex/wirescope/`:

- `logs/<session_id>/<seq>-<agent>-<role>-<model>-<ts>.warmth.json` — 37,591
  per-request records across 581 session dirs, all parseable. Each carries
  `bust_class`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `ts`,
  `n_messages_hashed`, `ping`, `warm_on_arrival`, `cold_resume`, `segments`.
- `warmth.sqlite` — the aggregate `session_bust` table (one row per session,
  per-class counters).

The repo-root `/Users/bogdan/projects/proxy-lab/warmth.sqlite` and `logs_main/`
are a DIFFERENT, older store (defaults, not what the live proxy writes). Do not
mix them.

### Q1 — the precise `conversation` rule (read, not inferred)

`warmth.py:272-323` `_classify_bust`, gated first on the receipt:

    window = read + created + inp
    window <= 0                      -> None
    created/window < 0.15            -> None   (tail-append, not a real bust)
    prior is None                    -> None   (first turn = initial cold start)

then most-upstream-divergence-wins against the prior session_head:

    tools hash differs               -> tools
    sys OR sysfull hash differs      -> system
    msg0 hash differs                -> preamble
    cur_msgs <= prior_msgs * 0.5     -> compact
    lapsed (idle > TTL)              -> lapse
    otherwise                        -> conversation

So `conversation` is a RESIDUAL class, not a positive detection: it means the
static prefix (tools + full system[] + messages[0]) was byte-identical, the
message array did NOT sharply contract, the cache had NOT lapsed, and yet the
receipt says >=15% of the priced window was re-written. Fault is tagged `self`
(`_BUST_FAULT`, warmth.py:262) on the assumption that an L2 transform edited a
settled prior turn. That assumed cause is exactly what t72 must verify — the
classifier does not observe it, it infers it by elimination.

Note `n_messages_hashed` is the count fed to `cur_msgs`, and the compact test
needs `p_msgs` truthy — a missing/zero prior count skips the compact branch and
falls through toward `conversation`. Flagged for Phase B.

## Phase B — re-derive the 85% (IN PROGRESS — the claim does NOT reproduce)

Whole-corpus scan of all 37,591 warmth.json (scratchpad/scan72.py):

    class          busts    cache_creation_tokens
    None           36020            80,602,572
    conversation     937            28,788,050
    lapse            240            22,847,452
    preamble         294             8,444,857
    tools             60             4,709,499
    system            40             3,196,575

    conversation share of BUST-classified creation tokens: 42.3%
    conversation share of ALL creation tokens:             19.4%

Neither is 85%. `compact` never appears in the corpus at all (0 rows) — the
compact branch may be unreachable in practice; must be checked before treating
"not a compact" as meaningful.

The ticket's table (1333 requests, conv 60 / 1,991,047) matches no current
source exactly. Closest single session is
`cb03f1c8-5287-4f56-9ba9-1f66d37b029a`: 1343 requests, conv 54 / 2,435,484,
pre 13 / 245,972, tools 1, lapse 11, none 1264. Same order of magnitude and a
near-identical request count, but conversation went 60 -> 54, which CANNOT be
the same session measured later (counters only grow). So either t69 measured a
different scope, or a different instrument.

Second instrument, `session_bust` in warmth.sqlite, disagrees with the files by
~3x: totals tools 34 / system 8 / preamble 130 / conversation 281 / compact 0 /
lapse 88 over only 68 session rows (vs 581 log dirs). Prime suspect: the DB
advance is gated `is_main` (receipts.py:85-87 — subagents share the parent's
session_id and would clobber the head), while the .warmth.json file is written
per request. If so, ~2/3 of the file-level `conversation` rows are SUBAGENT
lines, not main-line busts, and the file-level number is not the one to quote.
Top DB session by conversation is `d183bf3e-...` = clodex-hand's OWN session.

TWO INSTRUMENTS DISAGREE. Nothing downstream is trustworthy until this is
reconciled. Next: read writer.py/receipts.py to establish exactly which requests
get a bust_class in the FILE vs a counter increment in the DB, then re-derive
under a single stated scope.

## Phase C — inherent vs avoidable

(blocked on Phase B reconciliation)

### Instrument provenance (from clodex, msg-55910-75)

Live proxy pid 60378 runs the VENDOR copy
`/Users/bogdan/projects/tmux/wb-wrap-ui/vendor/wirescope`, sha1 414b2095be,
776 lines — the copy my line numbers cite. A second, different warmth.py
(c02322c8fe, 793 lines) exists in `/Applications/Clodex.app`; line numbers do
not transfer. Vendor files written Jul 25 02:19, proxy started 02:23 — loaded
current code. Corpus and source agree.

### Finding 2 root cause — SETTLED, and it is NOT the is_main gate

The `session_bust` DB table is swept on RETENTION, not gated differently from
the files. `pinger.py:430-432`:

    DELETE FROM session_bust WHERE COALESCE(last_ts,0) < now - WARMTH_PURGE_SLACK

with `_WARMTH_PURGE_SLACK = 7*86400` (pinger.py:287). Evidence: every session
in the DB is also in the files with IDENTICAL per-class counts (checked 68/68 —
e.g. d183bf3e 62/54/4, 944e9ae2 48/14/15, a68b0455 17/42/5 all match exactly),
and 0 sessions are in the DB but missing from the files. The 57 file-only
sessions are all older than the 7-day window (cb03f1c8 last active 07-21,
79 busts, purged). So the two instruments DO agree per session; the DB is
simply a 7-day rolling window over the same events.

The is_main hypothesis is therefore WRONG and I am recording it as such. It was
plausible and the 3x arithmetic fit, which is exactly the coincidence clodex
warned against settling on. `is_main` does gate the head advance
(warmth.py:675), so subagent turns get `bust_class: null` in the FILE too —
they are never counted as busts in either instrument.

=> Correct scope for any quoted number: THE FILES, all 37,591, which are the
   complete record. The DB is a 7-day view and must never be quoted as a total.

### Finding 3 — `compact` IS UNREACHABLE BY CONSTRUCTION (confirmed from bodies)

Two independent routes agree.

1. Classifier output: `compact` appears 0 times in 37,591 records.
2. Bodies on disk: I found every adjacent request pair whose
   `n_messages_hashed` contracted to <=50% of the prior (the exact
   BUST_COMPACT_MSG_RATIO condition) — 1036 real contractions, including
   323->59, 349->4, 158->7. For all 1036 I loaded both `.request.json` bodies
   (the real body is nested under the `body` key — my first pass read the
   envelope and got 0 messages, which is why it reported 0/0; fixed) and
   hashed `messages[0]`:

       contractions with both bodies on disk : 1036
       messages[0] CHANGED                   : 1036   (100%)
       messages[0] IDENTICAL                 :    0
       system[] changed                      : 1008
       tools[]  changed                      :  673

   messages[0] changes on EVERY compact, necessarily: a compact collapses the
   thread to a summary, so the first message afterwards IS the summary and
   cannot equal the prior first message. `_classify_bust` tests msg0 (preamble)
   at position 3 and the contraction (compact) only at position 4, so the
   preamble branch always fires first. The `compact` branch cannot execute.

   Class actually assigned to those 1036 contracting requests:
       None 781 · preamble 238 · tools 6 · lapse 4 · conversation 4 · system 3
   (781 fell below the 0.15 write-frac gate — not classified as busts at all.)

CONSEQUENCE FOR t60: this CORROBORATES it rather than upsetting it. t60 found
all 39 preamble busts were compacts; that is exactly where compacts are
routed. The taxonomy mislabels them, but t60's inherent-cost conclusion holds.

CONSEQUENCE FOR t72: it does NOT deflate `conversation`. Only 4 of 1036
contractions were classified `conversation` (30,876 tokens of 28.8M, ~0.1%).
Compacts are landing in `preamble`, not in `conversation`. So the residual is
NOT explained by miscounted compacts — the question of what `conversation`
actually is remains fully open.

CAVEAT, stated rather than glossed: my adjacency is file order within a session
dir (includes subagent lines), while the classifier compares against the last
MAIN-line head; and I hashed the raw logged body where the classifier uses
`_canon_message` with cache_control stripped. That explains why a handful of
rows classified `conversation`/`lapse` despite a changed msg0 by my hash. It
does not affect the 1036/1036 result, which is about the bodies themselves.

## Phase C — what `conversation` actually is (NEXT)

Compacts are ruled out as the explanation. Remaining candidates for the 937:
an L2 transform genuinely flapping (the `self` assumption), or a prior-head
comparison artifact. Next: pull the byte-level first divergence for a sample of
real conversation busts via report.py's `bust_series`, per the ticket.

### Upstream ownership (from clodex, msg-55910-77) — RECORD FOR THE FOLLOW-UP

`vendor/wirescope/proxylab/warmth.py` is byte-identical to
`/Users/bogdan/projects/proxy-lab/proxylab/warmth.py`, and proxy-lab is a
SEPARATE git repo (head 63a541b). The classifier defect is UPSTREAM code. Any
remedy goes to proxy-lab and is re-vendored — not patched in the Clodex tree
(t19 settled that wirescope stays vendored). Not to be acted on in t72.

Also per clodex: the branch-order proof is structural, not just empirical —
`preamble` returns at warmth.py:315, `compact` at :322. And the comment at
:316-318 claims compact is "checked FIRST — more specific than a coincident
idle lapse". True only against `lapse`; the upstream preamble test defeats it.
The comment documents an ordering the code does not have — same shape as the
t94 comment, and the next reader will trust it exactly as we did.

## Phase C — what `conversation` actually is (DONE)

Used `report.py`'s existing `bust_series` (NOT rebuilt), pointed at the live
LOG_DIR, matched its transitions to the file record by stem. Match rate was
exact on every session probed (63/63, 62/62, 54/54, 53/53, 48/48, 48/48), so
the join is sound. Ran all 159 sessions carrying conversation busts = all 937.

Split by `locus.appended` — the field that says whether the first divergence is
merely a NEW tail message (normal growth) or a byte-change in an ALREADY-SETTLED
message:

    CATEGORY                                          busts   write_tokens
    IN-PLACE EDIT of a settled turn                     675     25,533,493  (88.7%)
    APPENDED (pure tail growth, nothing edited)         262      3,254,557  (11.3%)
    TOTAL                                               937     28,788,050

`bust_series`'s own independent classifier on those same 937 transitions:
lapse 262 · conversation 604 · tools 68 · preamble 3. Its 262 `lapse` rows are
EXACTLY the 262 appended rows — two independent code paths agreeing on the same
partition. That is the cross-check that makes this trustworthy.

INTERPRETATION:

- The 262 appended / lapse busts are INHERENT. Nothing upstream was edited; the
  cache went cold between turns and the prefix was re-sent. warmth's classifier
  calls them `conversation` (fault `self` = our bug) only because its `lapsed`
  flag was false at that moment while the receipt showed a big write.
  MISATTRIBUTED — they are environment cost, not a defect.
- 68 rows have a `tools[]` first divergence (e.g. "tools[] changed (1->5
  tools)") that warmth called `conversation`. A second misattribution, in the
  other direction: warmth's tools check uses the cumulative first-marker
  segment hash, bust_series diffs tools[] directly.
- The remaining ~604 ARE genuine in-place edits of settled turns, by role:
  user 352 · assistant 173 · system-in-messages 82. For these the `self` tag
  is CORRECT — something really is rewriting history mid-thread.

So `conversation` is ~2/3 genuine and ~1/3 misattributed. The `self` assumption
holds for the bulk but not for all of it, and the honest headline is the
in-place-edit subset, not the raw 937.

## Phase D — WHO is doing the editing (NEXT)

The crux, and the only part that could be actionable. For a sample of the ~604
genuine in-place edits, read both bodies and diff the changed message to
identify the editor: one of OUR L2 transforms (fold / thinking-strip /
edit-ack / task-reminder strip — Clodex-controlled) vs the CLI itself
(not ours). `old`/`new` came back None in the first pass because
`_first_divergence` falls to the generic branch when content is not
list-vs-list; read the bodies directly instead. Bodies are nested under the
`body` key of `.request.json`.

Then Q4 (pattern by seat/workload) and the final inherent/avoidable split.

SCAFFOLDING NOTE: everything in scratchpad/ (scan72.py, phaseC.py, phaseC2.py)
is SCRATCH — measurement only, not to ship.

## Phase D — WHO edits the settled turns (DONE)

607 of the ~604+ in-place message-edit cases had both bodies on disk. Grouped by
SEMANTIC cause (comparing content ignoring str-vs-[{type:text}] representation):

    CAUSE                                                       n   write_tokens
    user:   PURE REPRESENTATION FLAP (identical content)      302     11,958,605  47.6%
    assistant: THINKING BLOCKS STRIPPED                       168      7,630,724  30.4%
    system: PURE REPRESENTATION FLAP (identical content)       81      1,523,000   6.1%
    ~31 assorted REAL TEXT CHANGES (1 each)                    31      ~3.9M       ~15%
    TOTAL                                                     607     25,133,911

So ~84% of the genuine-edit cost changes NO CONTENT AT ALL. It is container
shape and thinking-block presence.

### The mechanism (read from source + bodies, not inferred)

CAPTURE IS POST-TRANSFORM. `server.py:1169` sets `record["body"] = obj`, a
REFERENCE; the L2 transform chain (server.py ~1300-1420) mutates `obj` in
place; the file is enqueued afterwards at `server.py:1638`. So the captured
bytes are what the backend saw, and these edits are OURS, not the CLI's.

The representation flap is the CACHE MARKER MOVING. Cross-tabulating flap
direction against `cache_control` presence on the affected message:

    blocks->str | cache_control before=True  after=False   289
    str->blocks | cache_control before=False after=True     94
    str->blocks | cache_control before=False after=False     2

383 of 385 flaps are exactly a marker arriving or leaving. Mechanism at
transforms.py:2714 / 2906 / 3196 / 3581 — all four marker-placement sites do:

    if needs_convert:
        tgt["content"] = [{"type": "text", "text": c}]
    tgt["content"][-1]["cache_control"] = ...

A string-content message must be converted to a text block to CARRY a marker.
When the marker later moves to a different message, the previous host reverts to
a bare string. Both the conversion and the reversion are byte-changes to a
SETTLED turn, upstream of the cache head — so each one busts the prefix.

Transform keys present on the busting requests: env_relocate 607, system_strip
589, ws_spawner_hint 565, fold_read_edits 123, strip_compact_cache 8.

### Attribution

- ~84% of genuine in-place-edit cost (~21.1M tokens: 11.96M + 7.63M + 1.52M) is
  CLODEX/WIRESCOPE-CONTROLLED and content-neutral. The bytes did not need to
  change; only our marker placement and thinking-strip did.
- The thinking-strip (168 cases, 7.63M) is a deliberate transform — whether it
  PAYS is a separate question (it removes tokens from future turns but re-writes
  the prefix now). Not settled here; flagged.
- ~31 real text changes remain genuinely mixed. Sampled examples are our own
  `_strip_task_reminders` removing `<system-reminder>` blocks carrying
  `[agent:from ...]` deliveries — also ours, also a settled-turn edit.

### Instrument limitation (for the permanent record)

`_first_divergence` returns `old`/`new` as None whenever a message's content is
not list-vs-list (report.py:1148-1149, the generic fallback branch). Since the
flap is PRECISELY a str-vs-list change, `bust_series` reports the locus but
never the payload for the single most common bust cause in the corpus. Anyone
reaching for `bust_series` on non-list content must read the bodies directly.
Third instrument today to quietly return less than it appeared to.

## BOUNDARY OBSERVED

Per clodex: identify the editor, STOP. No fix in this ticket. The remedy is
upstream (proxy-lab, separate repo, head 63a541b) and re-vendored.

## Q4 — pattern by seat or workload? NO. (DONE)

Not a pathological-session story, so the "usage change" answer is NOT available:

- 159 sessions carry conversation busts. Top session = 5.6% of conversation
  tokens; top 10 = 62.6%; top 20 = 79.7%. A long tail, not a spike.
- 149 distinct seats (instance ids stripped). Top seat = 11.7% of conv tokens.
- Rate per 1000 requests is broadly FLAT across seats: clodex-hand 12.0-26.4,
  clodex-* 32-42, clodex-team 43-58, wirescope 41-46. The heaviest seat by
  volume (5567 requests) has the LOWEST rate (12.0/1k).

It tracks long sessions generally, not one workload. Consistent with a
mechanism that fires whenever a marker moves — i.e. structural, everywhere.

## FINAL PARTITION — all 937, zero unresolved

    BUCKET                                                        n      tokens   share
    AVOIDABLE: pure representation flap (marker move, no change) 383  13,481,605  46.8%
    OPEN:      thinking blocks stripped (net value UNMEASURED)   168   7,630,724  26.5%
    AVOIDABLE: real text edit of settled turn (reminder strip)    56   4,021,582  14.0%
    INHERENT:  cache lapse, pure tail growth (bust_series: lapse)262   3,254,557  11.3%
    MISFILED:  tools[] change, not a conversation edit            68     399,582   1.4%

    ROLLUP      AVOIDABLE  439   17,503,187   60.8% of conversation tokens
                OPEN       168    7,630,724   26.5%
                INHERENT   262    3,254,557   11.3%
                MISFILED    68      399,582    1.4%
                UNRESOLVED   0            0    0.0%

AVOIDABLE = 11.78% of ALL cache-creation tokens in the corpus (148,589,005).

Every one of the 937 resolved to a bucket from disk. No residue.

## SCAFFOLDING

scratchpad/{scan72,phaseC,phaseC2,phaseD,phaseD2,phaseD3,phaseE,phaseE2,final}.py
are SCRATCH. Measurement only; nothing to ship. No product code touched, no
tests added, suite untouched and unaffected.
