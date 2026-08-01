# t139 — automatic contextual hint arming (hand journal)

Write-ahead. Spec: `tasks/hint-injector/SPEC.md`.

## Recon — what the seam actually looks like

| Thing | Where | State |
|---|---|---|
| `write(name, data)` | `session-manager.js:1245` | tracks `lastUserInputTs`, `_inPaste`, `lastUserSubmitTs` via `isHumanPtyInput` + `draftChunkSignal`. Confirmed: **no draft accumulation**. |
| `draftChunkSignal` | `proxy-util.js:171` | `{closes, inPaste}`; `\r` and `\x03` close only OUTSIDE a paste region. |
| `stateOf` | `memory-load.js:98` | `'full' \| 'title' \| 'absent'`. Returns `'absent'` for an unknown agent — already the safe default. |
| compact/clear signals | `session-manager.js` `_fireCompactContinuation`, `onSessionId` | already call `memLoad.noteCompact` / `memLoad.noteSession`. The cooldown ledger hangs off the same two sites. |
| `ProxyClient` | `wirescope-proxy.js:19` | `_req` is **GET/POST with no body**. `/_hints` needs a JSON body, so a body-carrying POST is a required addition. |
| `/_hints` server | `vendor/wirescope/proxylab/hints.py` | `_validate` at :212. Confirms the `once` trap from the ticket: `once` defaults to `False` and unknown keys are dropped. Also: **`ttl_s` is REQUIRED when `once` is true** (hints.py:241) — a `once:true` post without a ttl is a 400, not a silent standing hint. |

Two facts read out of the vendor source that the spec does not state and that
shape the tests:

- **A one-shot hint is never persisted** (`_persist_agent`, hints.py:130 —
  early-returns on `once`). So a re-arm after a proxy restart is required, and
  reading `once` back must come from the live registry response, not the DB.
- `clear_hints` is **idempotent** (hints.py:310) — clearing an unarmed hint is
  a 200. So disarm can fire unconditionally without a read-modify-write.

## MIN_SCORE — derived, not copied

hint-probe's `MIN_SCORE = 2` was tuned at N=4. It does not transfer, and the
reason is sharper than "IDF is corpus-dependent": **at N=178 a single df=1 term
scores `log(1+179/1) = 5.19` on its own**, so any absolute floor at or below
5.19 is cleared by one coincidental rare word. Measured against the live store
(read-only, `scripts/` untouched — derivation script lived in scratchpad):

```
corpus: agent=clodex N=179   df=1 -> 5.19   df=2 -> 4.51   df=5 -> 3.61   df=N/2 -> 1.10

UNRELATED drafts (12, deliberately about nothing in the store), top-1 score:
   0.00 "what is the weather in paris tomorrow"
   5.59 "help me write a birthday card for my nephew"   [help write]
   5.19 "recommend a good italian restaurant nearby"    [nearby]
   5.19 "summarise this pdf for me please"              [please]
   5.19 "what should i cook with chicken and rice"      [chicken]
RELATED drafts (6), top-1 score:
  12.03 "why did the mutant escape the test suite"      [mutant escape test suite]
   5.76 "how do i close a ticket for clodex"            [close ticket clodex]
   5.19 "what is the rule about committing and pushing" [pushing]
  12.18 "how does the wirescope tail hint channel work" [wirescope tail hint channel work]
```

The two populations **overlap on score alone**: unrelated max 5.59 vs related
min 5.19. No scalar floor separates them, which is why the fix is not a bigger
number. What separates them is the number of the draft's terms a unit matches —
"chicken" is one lucky rare word; "wirescope tail hint channel work" is five.

**The rule shipped: `hits >= 2` AND `score >= log(1 + N)`.**

Both halves are load-bearing and both are corpus-derived. `log(1+N)` is exactly
the weight of one maximally-rare term, so the floor is by construction the
smallest value one lucky word cannot clear; `hits >= 2` is what actually does
the separating. Verified across four real stores spanning 45..179 units, using
the same 12 unrelated drafts for each:

```
clodex       N=179  floor 5.19   unrelated 1/12   related 5/6
clodex-hand  N=44   floor 3.81   unrelated 0/12   related 3/5
wirescope    N=49   floor 3.91   unrelated 1/12   related 2/3
trader       N=45   floor 3.83   unrelated 0/12   related 1/3
```

2 of 48 unrelated drafts still arm (both "help me write a birthday card",
matching on `help`+`write`). That residue is deliberate: a false arm costs a few
hundred tail tokens on a request the user is already paying for, and the small
stores show the rule does not collapse when N drops by 4x — which a hardcoded
`2`, or a hardcoded `6`, both would.

## Design

- `hint-arm.js` — draft folding, debounce, suppression, arm/disarm. Pure leaf.
- `hint-retrieve.js` — the lexical ranker (lifted from hint-probe) + the
  `memory` retriever. **Separate file on purpose**: SPEC §3 requires a second
  retriever to slot in "without touching `hint-arm.js`", and a retriever living
  inside hint-arm.js is exactly the thing that would have to be touched.
  Flagged as a deviation from the one-file deliverable.
- `confidence`: documented band `min(1, score / (2 * floor))` — the floor itself
  maps to 0.5, twice the floor saturates. Lexical IDF is unbounded above, so the
  normalisation has to pick a saturation point rather than divide by a max.
- Feature gate: `CLODEX_HINT_ARM=1`, read in `engine.js` where the arm is
  constructed. Off by default; matches the existing `CLODEX_*` convention.

## Known cost — the ranker reads the store SYNCHRONOUSLY on the Enter path

Not a defect today; recorded for whoever takes t141. `onDraft(..., {final:true})`
skips the debounce and calls `fire` inline (`hint-arm.js:198`), so
`retrieve` -> `listUnits` -> `store.list()` all run inside `write()` **before**
`s.pty.write(data)`. The POST is async and off the path; the rank is not.

Measured by clodex on a 179-unit store: **2.1ms warm, 12ms cold.** Fine at that
size, and the debounced (non-final) passes are off the keystroke anyway. But the
cost scales with the corpus, and t141 adds the basket — a materially larger one.
The failure mode when it stops being fine is a felt delay between Enter and the
line appearing, which reads as the CLI hanging, not as the hint feature being
slow.

**If it gets too expensive, cut the final pass — not the corpus, and NOT by
deferring it.** Trimming the store is the obvious reflex and it treats the
symptom. Deferring is worse, and worse for the reason the whole design rests on:
the debounce-armed hint is ALREADY registered for the current turn by the time
Enter is pressed, and the final pass is only a correction to it. Rank after
`pty.write` and the correction cannot land in time — it registers a one-shot for
the NEXT turn, ranked against the previous question. It also collides with
`once`: if the debounce-armed hint already popped this turn, a post-write re-arm
on the same fixed `HINT_ID` registers a fresh one-shot with a 180s TTL that pops
next turn carrying stale content. That is precisely the abandoned-draft misfire
`disarm` exists to prevent, reintroduced deliberately on every submit.

The honest options are: drop the final pass entirely and accept the
debounce-armed hint as final — the correction is small, since the last few
keystrokes rarely move the winner — or make it conditional on resolving before
the request leaves, which we cannot observe from this side.

## Things in the seam that did not match the spec

**1. A glob route is wrong here, and would have armed the wrong agents.** SPEC
§6 says route `clodex-<agent>-*` because "the hash suffix is unknowable before
the agent's first request". It is unknowable from OUTSIDE — hint-probe is a
separate process and has no choice. But Clodex MINTS `proxyAgent` itself
(`resolveProxyAgentId`, stored on the session), so inside session-manager the
exact route is in hand. That matters beyond tidiness: the proxy matches globs
with `fnmatchcase` (`hints.py:_matching_agent_scopes`), so `clodex-clodex-*`
also matches `clodex-clodex-hand-4f2a` — arming for `clodex` would arm
`clodex-hand` too, on a channel whose whole point is per-agent relevance.
Shipped: `s.proxyAgent || clodex-<name>-*`, glob only as the fallback.

**2. `once:true` requires `ttl_s`.** hints.py:241 rejects a one-shot without a
ttl (400, not a silent standing hint). The spec's `ttl_s: 180` satisfies it, but
the coupling is not optional and is now noted at the ProxyClient call site.

**3. A one-shot hint is never persisted** (`_persist_agent` early-returns on
`once`, hints.py:130). Consequence for the tests: `once === true` must be read
back from the live registry response, never from the proxy DB.

**4. The leak scanner cannot parse a nested paren in a default parameter.**
`ownDefinitions` matches a param list with `\(([^()]*)\)`, so writing
`now = () => Date.now()` in `createHintArm`'s deps destructure made the matcher
fail on the WHOLE list — every injected dep stopped counting as defined and the
scan reported `log` as a leak from main.js scope. Written as `now = Date.now`
(unbound; it needs no receiver). Comment left at the site because the failure
names a different file than the cause.

## Tests — 28 cases, `test/hint-arm.test.js`, green in 810ms, clean exit

Split three ways: the pure fold (7), the ranker (4), the arm's own logic
against injected seams (10), and the REAL `write()` seam through a real
`create()` (7). The seam half uses the same fixture shape as
`test/memory-load.test.js`, including every inject wait driven to 0 — the
boot-readiness gate polls until a real mode-2004 byte latches `_bootReadySeen`,
so with the production caps a file prints green and then HANGS.

Two things the fixture takes REAL rather than stubbed, both deliberate:

- `isHumanPtyInput` / `draftChunkSignal`. The injected-writes case asserts that
  a focus report and a mouse report do not reach the accumulator; that gate IS
  the guarantee, so a stub would leave the case asserting against the stub.
- `ProxyClient` in the one-shot case, against a real `http.createServer` that
  keeps only the keys the real server validates and 400s a `once:true` with no
  `ttl_s`. A stubbed sender proves only that the payload can be built; the claim
  is about what survives the wire.

Assertions worth naming:
- TITLE asserts a POST **happens** — the suppression bug is collapsing three
  states into a boolean, and this is the one that goes the wrong way.
- A `loadState` that THROWS asserts a POST happens too.
- A failed POST (503) asserts the cooldown was NOT burned, then asserts the next
  draft retries — the second half is what makes the first non-vacuous.
- The clear case fires the watcher's real `onSessionId` three times (first id,
  changed id, same id repeated) and asserts 0, 1, 1 resets.

Two of my own assertions were wrong and the product was right:
- I expected the paste fold to swallow an interior `\r`. Keeping it is correct —
  dropping it fuses `beta`+`gamma` into a compound the user never typed, which
  the ranker would then weight as a rare term. Assertion rewritten to pin the
  tokenizer output.
- The same case used `one`/`two` as sample words. Both are stop-words, so the
  tokenizer returned `['line','line']`. Renamed to alpha/beta/gamma/delta.

## Mutants — 34, all reddening BY MESSAGE, three escapes found and closed

Harness `mutate139.js` (scratchpad), same contract as t137: refuses to run if
the product differs from pristine, anchor must match exactly once, restores from
pristine and verifies byte-identity, flags `CRASHED-NO-ASSERTION` and
`TIMED-OUT/HUNG` separately. All four products verified `diff`-identical to
pristine after the run. No mutant reddened by crash, timeout or hang.

Coverage by family: suppression matrix (4), cooldown ledger (4), debounce/memo
(2), draft fold (8), disarm (1), ranker (5), write() seam (8), the wire (3
— `once`→`pop`, ttl dropped, hint id not fixed).

**Three escapes, all the same shape: a second mechanism was quietly satisfying
the assertion, so the assertion proved nothing about the one it named.**

1. `reposts-unchanged-winner` — deleting the winner memo left the suite GREEN.
   The cooldown ledger was doing the work: by the time the second draft ranked,
   the unit was already in the offer ledger. The memo's real job is the window
   BEFORE the POST resolves, where the ledger is still empty. Closed with a case
   that holds the POST open on a promise gate and fires the Enter pass while the
   first is still in flight — the one instant the cooldown cannot cover.
2. `min-terms-removed` — GREEN, because the probe draft was ONE content term and
   the ranker's own MIN_HITS was withholding it. Closed by moving to a two-term
   draft plus two ENTER assertions proving that draft DOES rank, so only the
   term floor can be what withholds it.
3. `compose-empty-not-null` — GREEN, because `compose([])` is caught by an
   earlier guard; the mutated branch guards a different case (a non-empty result
   whose bodies are all blank). Closed by asserting that case directly.

Three more reddened on a message that did not name the defect, and were fixed
rather than accepted — a red that does not say what broke is half a test:
`paste-interior-cr-closes` and `compose`'s blank case (bare "Expected values to
be strictly equal"), and `arm-can-break-keystroke`, which died on a RAW
PROPAGATING THROW before reaching any assertion. That last one is the sharper
lesson: the test asserted the keystroke arrived, but an arm exception escaping
`write()` kills the case first, so the invariant was never actually asserted —
now wrapped in `assert.doesNotThrow` with the message on it.

## Progress

- [x] Recon + vendor read
- [x] MIN_SCORE derivation
- [x] `hint-retrieve.js`
- [x] `hint-arm.js`
- [x] ProxyClient `_reqJson` + `armHints` / `clearHints` / `readHints`
- [x] `write()` wiring (`_foldDraft`, `_armCtx`), clear reset in `onSessionId`,
      compact reset in `_fireCompactContinuation`, `arm.forget` in `_cleanup`,
      engine.js construction behind `CLODEX_HINT_ARM=1`
- [x] leak scanner: both new modules added, 87/87
- [x] tests — 28 cases, green, clean exit
- [x] mutants — 34, zero escapes remaining
- [x] full suite — **3309/3309 green** (3279 baseline + 28 new + 2 leak-scanner
      entries for the two new modules)
