# t151 — spawnerHint as a generic per-session env var

Operator decision (2026-08-04): this must apply to ANY session, driven by an
env var. Rationale in Bogdan's words: *"i don't want special code in clodex
repo for our team. the teams are agnostic, even though only the clodex team
has ever been used."* The reviewer branch is the defect, not the feature.

## What it does

Suppresses wirescope's `[wirescope]` grammar block — the spawn-directive
documentation — for one agent route. Real cost on every request for a seat
that will never spawn a subagent.

Proxy-side, keyed by ROUTE NAME, not session: `POST /_hint?agent=<route>&on=0`.
The block is injected server-side into the forwarded system array, so the
proxy never sees the seat's env and a client-side variable cannot reach the
injection point — the env var is read by CLODEX and turned into that POST.
Route-keying survives `/clear` session-id rotation, where a session-keyed
switch would lose the seat.

Client already exists: `ProxyClient.spawnerHint` (`wirescope-proxy.js:119`),
best-effort with a 2s timeout, never fails or delays a spawn. `ProxyClient` is
an injected dep of `createSessionManager` (`session-manager.js:179`), so it
stubs cleanly in tests.

## Present state (the defect)

Read at exactly one place — `session-manager.js:3316`, the team-review path,
from the reviewer template with `REVIEWER_FALLBACK.spawnerHint` (`:51`) as
fallback; POSTed at `:3389` after `create()` returns.

Cleared at `kill()` (`:1391`) but gated on `ephemeral && reviewFor`, so only
ephemeral reviewers avoid accreting rows in wirescope's TTL-less hint table.

Consequence: any other template may declare `"spawnerHint": "off"` and nothing
reads it. `~/.clodex/library/templates/fable-design.json` does exactly that.

## Settled: the tool-gate caveat is NOT a reason to skip this

Injection is gated on `tools[]` containing `Agent` or `Task`
(`vendor/wirescope/proxylab/transforms.py:1649`, `_WS_SPAWN_TOOLS`).

The cold reviewer's cap is `['Read','Grep','Glob']` (`REVIEWER_TOOL_CAP:27`),
so it carries neither tool and **already never receives the block** — the
reviewer POST is a no-op today. That does not kill the feature, it kills the
special case: deleting the reviewer branch loses nothing measurable, and the
general lever is still wanted for a proxied seat that KEEPS `Agent` in its
tool set but should not be taught to spawn. Do not skip the env var; do
delete the branch without ceremony.

## Decided design

**Env var `CLODEX_SPAWNER_HINT`**, read from the merged env in `create()`.
- `off` → `POST ?on=0`
- `on`  → `POST ?on=1` (the mirror; wirescope supports per-agent opt-IN on a
  globally-off port, and leaving it out would make the var one-way for no
  saving — one extra branch)
- unset / anything else → **no POST at all**, no new traffic on the common
  path.

**Where to fire.** In `create()`, right after `proxyAgent` is minted
(`:675-681`) — `proxyBase` is already resolved at `:657` and already nulled by
the tee-blind guard at `:670-673`. This is before the PTY spawn, so it is
unconditionally before the seat's first turn. That ordering is not cosmetic:
the hint rides inside the marked system prefix and migrates the last system
cache marker onto itself, so a flip after the first turn reshapes that prefix
and costs one warm bust.

Guard on `proxyBase && proxyAgent`. Best-effort exactly like the existing call
sites: wrap in try/catch, `.catch()` the promise, log at warn. **A hint
failure must never fail a spawn** — there is already a test for that shape on
the reviewer path; keep an equivalent one here.

Firing again on every restart/resume is correct and intended: the POST is an
idempotent set, and a proxy restart reloads overrides pre-first-turn, so
re-asserting costs one 2s-timeout request and removes a whole class of drift.

**Clear on retire.** `kill()` `:1389` — drop the `ephemeral && reviewFor`
gate. Clear when THIS session set an override. Record that on the session
object at create time (e.g. `session.spawnerHintSet = true`) rather than
re-reading env in `kill()`, so the clear cannot outlive a config change.
A seat that never set one must still post nothing on kill.

**Delete the reviewer special case** — `:3316-3317` (`wantSpawnerHintOff`),
`:3385-3394` (the POST block), and `REVIEWER_FALLBACK.spawnerHint` (`:51`).

**Delete the `spawnerHint` template field**, do not honor it as a synonym.
Templates already carry `env` through to a spawn — that path exists and is
tested (`test/spawn-template-env.test.js`) — so one mechanism does the whole
job and nothing declares what nothing reads. Remove it from
`resources/library/templates/clodex-team-reviewer.json` and add
`CLODEX_SPAWNER_HINT: "off"` to that template's `env`.

**Add `CLODEX_SPAWNER_HINT` to `REVIEWER_ENV_ALLOWLIST`** (`:36`). That
allowlist is a code-level ceiling on template-supplied env (env is an
authority surface; agent-writable templates must not set arbitrary keys) and
drops unlisted keys loudly, so the reviewer template's new key is inert
without this line. Leave the allowlist's comment intact and accurate.

## Do not

- Do not touch `WS_SPAWN_DIRECTIVES` — a different, process-wide mechanism
  that gates PARSING of inbound `[wirescope:...]` directives. Unrelated.
- Do not widen `REVIEWER_ENV_ALLOWLIST` beyond this one key.
- Do not add the env var to `DEFAULT_TOOL_DENY_FLOOR` or any shipped default
  for ordinary sessions. Opt-in only.

## Verification

Existing reviewer hint tests (`test/session-manager.test.js:2386-2477`,
`:2877-2891`) assert the branch being deleted — rewrite them against the new
path rather than deleting the coverage. The T51 ordering test's claim
("AFTER create(), BEFORE the scope handover") is subsumed by firing inside
`create()` pre-spawn; say so in the replacement test's header comment.

- A session spawned with `CLODEX_SPAWNER_HINT=off` and a proxy POSTs `on:false`
  once, keyed on its `proxyAgent`, before the PTY spawn.
- `=on` POSTs `on:true`.
- Unset → zero POSTs (the common path gains no traffic).
- Set but no proxy (`proxyBase` null, incl. the tee-blind null) → zero POSTs.
- A thrown/rejected hint does not fail `create()`.
- `kill()` of a seat that set it POSTs `{clear:true}`; `kill()` of one that
  did not POSTs nothing.
- The shipped reviewer template still ends up with the hint off, now via env.
- Mutation-check before reporting green: delete the env read → the "posts
  on:false" test must fail. Delete the `spawnerHintSet` guard in `kill()` →
  the "did not set it" test must fail.

Full suite must be green (baseline 3557/0, ESCAPES 0). Use
`[agent:exec clodex-run-tests]`, or hand it to `clodex-monitor` with
`wake:false` if it outruns the 120s window. Never start a second run
concurrently — both entry points take `.test-digest.lock` and deadlock at 0%
CPU.

## Journal

Append outcomes here as they land, past tense, pinned to a commit or a
measured number. Nothing in the present progressive.

### t152 implementation (clodex-hand, uncommitted)

Product, all in `session-manager.js` unless noted:
- `CLODEX_SPAWNER_HINT` read off `mergedEnv` in `create()`, immediately after the
  `proxyAgent` mint, guarded on `proxyBase && proxyAgent`. `off`/`on` POST
  `{on:false}`/`{on:true}`; every other value (unset, `''`, `'0'`, garbage) posts
  nothing. try/catch + `.catch()`, warn-logged.
- `session.spawnerHintSet` records the POST that was actually made; `kill()` clears
  on THAT. The `ephemeral && reviewFor` gate and its `killRec` read are gone.
- Deleted: `wantSpawnerHintOff`, the `_handleTeamReview` POST block,
  `REVIEWER_FALLBACK.spawnerHint`.
- `CLODEX_SPAWNER_HINT` added to `REVIEWER_ENV_ALLOWLIST` and to
  `REVIEWER_FALLBACK.env`; the `spawnerHint` field removed from
  `resources/library/templates/clodex-team-reviewer.json`, replaced by
  `"CLODEX_SPAWNER_HINT": "off"` in its `env`.

Spec deviations: none in behaviour. Line numbers were all accurate except
`kill()`'s POST, which the spec cites at `:1389`/`:1391` — the guard was at
`:1389` and the call at `:1391`, so both readings point at the same block.

Tests (`test/session-manager.test.js`): the five T51/T52 reviewer hint tests at
`:2386-2477` and the T52 template-field test at `:2877-2891` were replaced by nine
against the new path, driving the REAL `create()` claude arm (the branch reads
`mergedEnv`, which does not exist outside it — a stubbed `create()`, correct when
the POST lived in the handler, would assert nothing now). Three fixtures that
mirrored the shipped template were updated, plus `test/stores.test.js:877`.

Mutation checks — 5 run, 5 killed, 0 escapes:

| # | Mutation | Result |
|---|---|---|
| M1 | delete the env read (`hintWant = undefined`) | **KILL** 2 fail (both named POST tests) |
| M2 | drop the `spawnerHintSet` guard in `kill()` | **KILL** 1 fail (the "did not set it" test) |
| M3 | fire the POST after `pty.spawn` instead of before | **KILL** 1 fail |
| M4 | accept any truthy value as an override | **KILL** 1 fail |
| M5 | drop the `proxyBase` guard | **KILL** 1 fail |

M1 and M2 are the two the spec named; M3-M5 cover claims those two do not reach
(the pre-first-turn ordering, the unset-is-silent promise, the tee-blind null).

Full suite: **3560 pass, 0 fail, ESCAPES 0**. Baseline 3557; the +3 delta is the
9 new tests less the 6 replaced. The first run wedged on `cli/test/attach.test.js`
at 0.0% CPU (the known concurrency hang, unrelated to this change) and was killed;
the clean re-run is the number above.
