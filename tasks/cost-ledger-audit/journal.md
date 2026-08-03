# t149 — cost-ledger audit (investigate only)

Seat: clodex-hand. Read-only throughout: no product code edited, no test suite
run, nothing written under `~/Library/Application Support/Clodex/`, `~/.clodex/`
or `~/.claude/projects/`. Only this file was created.

---

## Q1 — why `sessionIds` holds one element

**Root cause: a kill()+create() restart destroys the history array, and no
restart path preserves it.**

Chain, with evidence:

1. `stores.js:348-358` `setSessionId` is the ONLY writer. It appends **only when
   `entry.sessionId !== sessionId`** (line 351). Correct as written.
2. `session-manager.js:1374` — `kill()` calls `getPersistence().remove(name)`,
   which drops the whole record (`stores.js:345-347`).
3. `session-manager.js:1048-1052` — `create()` rebuilds the record from spawn
   args only: `sessionId: resumeId || null`. **`sessionIds` is never written by
   `create()`**, so the rebuilt record has no history field at all.
4. `session-manager.js:1572-1582` — `_preserveAcrossRestart` re-seeds only the
   fields its caller names. All three call sites omit `sessionIds`:
   - `engine.js:1061` → `['ephemeral','reviewFor','createdAt'](+'rosterSentAt')`
   - `engine.js:1151` → `['rosterSentAt','ephemeral','reviewFor','createdAt']`
   - `session-manager.js:3833` (`[agent:context reload]`) → `['createdAt']`

So every in-place restart — `engine.restartSession`, `applySessionArgs`, and the
`context reload` intent — resets the array to absent. It then regrows only from
the next id CHANGE.

Secondary reason the array stays empty even without a restart: on a `--resume`
spawn `create()` writes `sessionId: resumeId`, so the watcher's first
`onSessionId` (`session-manager.js:1092-1095`) reports the same id and
`setSessionId`'s inequality guard suppresses the append. That is deliberate and
documented at `session-info.js:21-25`; it is not the loss, but it means a
resumed seat carries no history until its first `/clear`.

Not implicated, checked and cleared:
- Field age: the append logic is present in the oldest commit that has the file
  (`568b087`, 2026-07-09), and `main.js` references go back to `b8d965d`
  (2026-06-17). It is not "newer than the seat" — seat `clodex` was created
  2026-07-25 02:03 (`createdAt` 1784934234935).
- Natural PTY exit: `session-manager.js:1237-1239` removes the record only when
  `!agentType` (bash sessions). Agent entries survive.
- App quit / restore: no `remove()` on that path.

Observed state consistent with this: seat `clodex` has `sessionIds` =
`['4fa3ff40-…']`, i.e. exactly one id minted after the last restart. Other seats
that were restarted less often carry more (`claude-code` = 9, `t2` = 4,
`degen` = 3).

**Verdict: (b)+(c) — the array is destroyed by the kill()/create() round trip
and not carried by `_preserveAcrossRestart`. Not (a).**

---

## Q2 — the ledger under-credits; the wire figure is wrong

**`wire/billing.js` has no `claude-opus-5` price row.** `PRICES`
(`wire/billing.js:28-43`) stops at `claude-opus-4-8`. `priceFor` is
longest-prefix (`:59-68`), and `claude-opus-5` matches no prefix — verified by
running the module:

```
priceFor('claude-opus-5')     -> null
priceFor('claude-opus-4-8')   -> {in:5, out:25, ...}
```

Consequence chain: `billing()` leaves `est_usd = null` and sets `unpriced`
(`:172-177`) → `bump()` adds `bill.est_usd || 0`, i.e. **zero**, and increments
`unpriced_requests` (`:269-275`). The requests/turns counters still tick, which
is why the ledger shows 160+ requests against ~$0.07: the wire sees every
request and prices none of the main-line ones. The $0.0713 is residue from
side-call models that DO have rows (haiku/sonnet).

The vendored proxy has the row and has had it since 2026-07-25:
`vendor/wirescope/proxylab/billing.py:122-126` — with a comment saying opus-5
needs its OWN entry precisely because prefix matching won't reach it. Commit
`f3bbee9` "vendor wirescope v0.6.40 (opus-5 pricing + fast-mode premium rows)".
`wire/billing.js` was last touched `5a83c89`, 2026-07-02 — the vendor bump never
mirrored into the in-process port.

**Independent confirmation from the transcript.** Repricing
`4fa3ff40-…jsonl` at opus-5 rates ($5/$25/$0.50 read/$10 1h-write), deduped by
`requestId` (duplicate assistant records carry byte-identical usage — verified,
70 of 166 ids repeat):

```
166 requests: in=88,749 out=117,883 cache_read=15,804,118 write_1h=148,483
              -> $12.78
cumulative at ~140 requests -> $10.08 ; at 150 -> $11.10
```

`payload.costRun` was $10.83 at the moment clodex read the panel — squarely on
that curve. The poll pipeline is accurate to the transcript; the wire ledger is
short by ~99%.

**Authoritative: `payload.costRun` (the wirescope poll). The wire-totals ledger
is a FLOOR for any opus-5 traffic.**

Two aggravating details worth flagging:
- `wire/billing.js` has **no fast-mode table at all**. The vendor has
  `PRICES_SPEED_FAST` (`billing.py:202-211`, opus-5 fast = 2× standard, detected
  from response `usage.speed`). The wire port ignores `usage.speed` entirely, so
  fast-mode turns would under-bill 2× even after an opus-5 row is added.
  (This conversation ran `speed: "standard"` on 239/240 records, so it is not
  the cause here.)
- `unpriced_requests` / `unpriced_models` are tracked in the in-memory totals but
  are **not persisted** — `wire-telemetry.js:_lifetime` (`:84-94`) and `_save`
  (`:102-118`) carry only cost/requests/turns/refusals. So the "this is a floor"
  signal never reaches `wire-totals.json` or the panel. The only surface is a
  `console.error` at first sight of the model (`wire/billing.js:72-79`).

**Why other sessions look fine.** `96ce9c47` shows $80.40 over 2,684 opus-5
requests. That is not the wire pricing anything — it is the persisted BASE from
`seedLifetime` (`wire-telemetry.js:155-173`), which imported wirescope's
correctly-priced lifetime total. Sessions with a seed look right; sessions
without one (or seeded at ~0) show the near-zero wire-only figure. `seedLifetime`
returns early once `_lifetimeBase.has(sessionId)` (`:161`), and `_save` writes an
entry for every live agent whether or not a real base was ever imported — so once
a session is persisted with a zero base it can never be seeded afterwards. That
is a second, independent reason the number cannot self-heal. I did not verify
the exact history for `4fa3ff40`; the pricing gap alone fully explains it.

---

## Q3 — pre-`/clear` history IS reconstructible; a backfill is cheap

**Yes.** `~/.claude/projects/<slug>/<sessionId>.jsonl` carries everything needed:
- the **filename is the session_id**, which is exactly `wire-totals.json`'s key,
  so no seat attribution is required for a backfill;
- every `type:"assistant"` record carries `message.model` and a full
  `message.usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`, plus `usage.speed`
  for fast-mode and `requestId` for dedupe.

Method (validated on the live conversation above): group by `requestId`, take one
record per id (duplicates are identical, not incremental — summing raw records
gave $18.76 vs the correct $12.78), price by `message.model` through the same
table `wire/billing.js` uses.

**Cost to run:** trivial. This project's dir is 338 files / 212k lines / 4.9 GB
and a raw pass takes 0.8s; with full JSON parsing budget ~30s. All of
`~/.claude/projects` is 1,623 dirs / 11 GB — call it 2–5 minutes single-threaded,
zero API spend, read-only.

**Caveats a backfill must state, not hide:**
1. **Not a total, a floor-from-below-and-above.** Transcripts contain main-line +
   subagent turns, but NOT what never lands in a transcript: `count_tokens`
   probes (unbilled anyway) and any traffic the CLI made outside a recorded
   conversation. Conversely wirescope's per-session totals include side-calls
   that DO appear. Expect the reconstruction to be close but not identical to the
   poll — mine landed on the poll's curve, which is the strongest check available.
2. **Retention.** `wire-totals.json` keeps only the newest 500 session ids
   (`wire-telemetry.js:111-115`); a backfill of 1,623 project dirs would exceed
   that and start evicting real history on the next save. Cap or widen
   deliberately.
3. **`<synthetic>` model records** appear in several transcripts (CLI-generated,
   no real spend) and must be skipped, not priced as unpriced.
4. **Historical rates.** Repricing 2026-06 traffic with today's table is wrong
   where a model was repriced (the opus 4.0/4.1 → 4.5 change is already noted at
   `wire/billing.js:27`). For opus-5, rates have been $5/$25 since introduction,
   so this conversation's number is safe.
5. **Fast mode.** `usage.speed == "fast"` needs the 2× row from
   `vendor/wirescope/proxylab/billing.py:202-211`, which the JS port lacks.

---

## Assumptions flagged

- I priced opus-5 at $5/$25/$0.50/$6.25/$10 taken from the vendored
  `billing.py:126` (the authoritative table), not from a row in `wire/billing.js`
  — there is none, which is the finding.
- The panel figures ($10.83 / $0.0713) are clodex's readings, taken as given per
  the ticket; I did not re-open the panel. The ledger has since moved to
  `{cost: 0.071336, requests: 170, turns: 38}` as the conversation continued —
  cost flat, requests climbing, which is itself the symptom.
- I did not confirm the specific historical restart that cleared `clodex`'s
  `sessionIds`; the mechanism is proven from code and consistent with the
  observed single-element array and with other seats' longer arrays.
