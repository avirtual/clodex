# t118 — CLODEX_HOME is honoured by the team layer, not by app core

## Decision: REGISTRY_DIR is the app's root. The team layer must follow it.

Decided 2026-07-31 by the lead. Not "remove the env var" and not "make core read
it" — both were the framings I carried in, and the code says a third thing.

## What the tree actually shows

Every reader of `process.env.CLODEX_HOME`, whole tree, vendor excluded:

- `team-manifest.js:32` `defaultClodexHome()` — the in-app team layer.
- `scripts/clodex-team.js:10` — the standalone exec script.
- `scripts/task-ledger.js:54` — standalone.
- `scripts/clodex-monitor.js:33` — standalone, the second shipped exec command.
- `plugins/tickets-viewer/engine.js:20` — mirrored `team-manifest`, which t125
  corrected: mirroring the team layer's OLD behaviour is what carried the split
  into the plugin.
- tests.

`session-manager.js:2464` is NOT a reader and is the decisive evidence: it
expands the literal token `${CLODEX_HOME}` in exec argv to **`REGISTRY_DIR`**.
The token already means "the app's root", not "the environment variable". Core's
root is `engine.js:133` `path.join(os.homedir(), '.clodex')`, bare homedir, and
`main.js` / `headless-main.js` derive it the same way.

So with the variable set, teams resolve to one tree while memory, messages,
pending, peer-outbox, `run/` and skill-plugins resolve to another. Latent only
because it is unset in the app today.

## Why this direction

`createTeamManifest({ fs, clodexHome })` (`team-manifest.js:82`) **already has
the seam** — `clodexHome || defaultClodexHome()`. `engine.js:398` constructs it
as `createTeamManifest({ fs })` and simply never passes one, so the env-var
fallback wins by omission rather than by decision. The fix is to pass what every
other subsystem already uses.

The env var must STAY for `scripts/clodex-team.js`: it is a separate process
with no access to `REGISTRY_DIR`, and `test/clodex-team.test.js` needs the seam.
It is a test/IPC seam for a standalone script, not app configuration.

Rejected — "make `REGISTRY_DIR` honour `CLODEX_HOME`": it would move `~/.clodex`
for real, which is a migration with live sessions, registries and sockets in it,
bought for a variable nobody sets. The hand already flagged this shape when it
refused my wrong fix on memory-viewer: core is bare homedir, so anything that
"fixes" a plugin toward the env var CREATES the divergence.

## Implementation (filed separately, unassigned)

1. `engine.js:398` → `createTeamManifest({ fs, clodexHome: REGISTRY_DIR })`.
2. The exec child must agree by construction. `resources/library/exec/clodex-team.json`
   spawns `${CLODEX_BIN}/clodex-team.js` and `session-manager.js:2478` spawns
   with **no `env` key**, so the child inherits the app's environment. If
   `CLODEX_HOME` is set in the app's env the child follows it while the app no
   longer does — the same split, relocated. Set `CLODEX_HOME=REGISTRY_DIR`
   explicitly in the exec spawn env. There is no `--home` flag; the env is the
   only channel.
3. Red-first test: set `CLODEX_HOME` to a tree that is NOT `REGISTRY_DIR`, and
   assert the teams root follows `REGISTRY_DIR`. That case fails today.

Do NOT let the test assert only that the two agree when the variable is unset —
they agree then whatever the code does, which is the vacuity shape this repo
spent the night on. The fixture must make them differ.

---

# t124 / t120 — implementation (hand)

Dispatched twice: the registry has **t120 open/unassigned** (filed by this
journal) and **t124 open/hand**, same title, same work. Doing it once, closing
both. The dispatch's close instruction said `t120` while its header said t124,
which is the same duplication seen from the other side.

Spec said `plugins/tickets-viewer/engine.js:398`; the call site is ROOT
`engine.js:398` (as this journal's own line 47 says — the plugin prefix was
added in the dispatch). No `createTeamManifest` exists in the plugin. Both
`engine.js:398` and `session-manager.js:2478` have `REGISTRY_DIR` in scope
(engine.js:133, inside `createEngine`, brace-depth verified).

## Plan
1. `engine.js:398` → `createTeamManifest({ fs, clodexHome: REGISTRY_DIR })`.
2. `session-manager.js` exec spawn → explicit `env: { ...process.env,
   CLODEX_HOME: REGISTRY_DIR }`.
3. `defaultClodexHome()` and `scripts/clodex-team.js` untouched.

## Test shape (the vacuity trap)
Set `CLODEX_HOME` to a temp tree that is NOT `REGISTRY_DIR`, plant a team in
it, and assert the in-app team layer does NOT see it — the two trees must
genuinely differ or the case passes whatever the code does. Red-first.

## Implemented

1. **`engine.js:398`** → `createTeamManifest({ fs, clodexHome: REGISTRY_DIR })`.
   Comment names what the omission cost: the fallback reads CLODEX_HOME, so with
   the variable set teams resolved to one tree while every other subsystem
   resolved to REGISTRY_DIR.
2. **`session-manager.js`** exec spawn → `env: { ...process.env, CLODEX_HOME:
   REGISTRY_DIR }`. SPREAD, not replaced: `/usr/bin/env node` needs PATH to
   resolve at all, so a bare `{ CLODEX_HOME }` would break the spawn while
   looking like the fix.
3. `defaultClodexHome()` and `scripts/clodex-team.js` untouched, as decided.

## Test — `test/clodex-home-app-root.test.js` (new, 2 cases)

The fixture makes the trees DIFFER: `CLODEX_HOME` points at a temp tree
carrying a team named `decoy-team-from-env`, and the app must not see it. An
assertion inside the fixture helper pins that the decoy is not the app root,
so the vacuous shape (asserting the two agree while the variable is unset)
cannot creep back in later.

Case 1 drives `createEngine(...).listTeams()` — the front door's own reader,
not a re-derived path. Case 2 drives the real `_handleExecIntent` with a
capturing `childProcess.spawn`.

Both red BY MESSAGE against the unmodified product before the fix
("got [\"decoy-team-from-env\"]" / "the spawn must set an env explicitly").
One harness bug found and fixed on the way: `createSessionManager` returns the
CLASS, so the first draft failed by crash (`_handleExecIntent is not a
function`) rather than by assertion — a red that proves nothing.

Four mutants, all reddening, product restored byte-identical after each.
`test/clodex-team.test.js` and `test/team-manifest.test.js` ran alongside every
mutant and stayed green — the standalone seam is genuinely untouched.

| # | mutant | result |
|---|---|---|
| M-1 | engine back to `createTeamManifest({ fs })` | 1 fail |
| M-2 | exec spawn back to inheriting (no `env`) | 1 fail |
| M-3 | exec env REPLACES process.env (**wrong-fix**, kills PATH) | 1 fail |
| M-4 | exec env spreads but does not set CLODEX_HOME (**wrong-fix**) | 1 fail |

## t125 — rework from cold review (2 must-fixes, 4 nits)

**MUST-FIX 1 — the split survived inside the plugin.** `plugins/tickets-viewer/
engine.js:19-21` read `CLODEX_HOME`, so with core pinned to REGISTRY_DIR the
board reported on a different teams tree than the app hosting it. Now a bare
homedir join, byte-identical to `engine.js:133`. The old comment claimed the
env var was honoured "because core's team layer honours it" — false in both
halves after t124, and replaced with the change it prevents.

Its test seam was `CLODEX_HOME` and had to be replaced. The seam is a
module-level `teamsRootOverride`, null in the app, written ONLY by
`_internals.setTeamsRootForTest`. Nothing on the plugin's own code path
assigns it. Deliberately not on the host surface: `hostApi` is frozen at "1",
and a plugin able to ask core where the teams live is a contract change.

Added `tickets-viewer: the teams root ignores CLODEX_HOME and matches core's`
— asserted with the variable SET to a decoy, because with it unset the two
agree whatever the code does. Without it, swapping the test seam would have
removed the only place the env-var behaviour was observable.

**MUST-FIX 2 — the decoy env was torn down before the spawn read it.**
`withDecoyHome` was synchronous while case 2 passed an `async` fn, so the
`finally` ran at the first await — restoring `CLODEX_HOME` before the exec
spawn's `setImmediate` snapshotted `process.env`. The decoy assertion compared
against `undefined` and could not fail. Now `async` + `await fn(home)`, awaited
at both call sites.

**M-4 re-run, as asked.** It now fails on the decoy value:

    actual   '/…/clx-decoy-home-xHVcx6'
    expected '/…/clx-exec-home-DvnNsC'

With the old synchronous teardown the same mutant reported `actual undefined`.
The fix took.

Note M-7 (reverting ONLY the async fix, product intact) stays green, and
should: with the product correct the child's CLODEX_HOME is REGISTRY_DIR
either way, so the comparison passes trivially. The harness bug was only ever
observable in combination with a mutant — which is precisely why it was worth
fixing, and why a green suite did not notice it.

Three more mutants, product restored byte-identical after each:

| # | mutant | result |
|---|---|---|
| M-5 | plugin reads CLODEX_HOME again (the split restored) | 1 fail — the new root case |
| M-6 | plugin ignores the test override (seam dead) | 25 fail |
| M-7 | `withDecoyHome` synchronous again, product intact | green (see above) |
| M-4′ | sync teardown + exec env mutant, combined | fails on `undefined` — the old blind spot, reproduced |

**Nits taken:** exec comment now says "a registered exec script (clodex-team,
clodex-monitor)" — `_handleExecIntent` is generic over `library/exec/*.json`;
the reader enumeration above corrected to the full set; `engine.js` comment cut
from five lines to two; both `rmSync` calls moved into `try/finally` so a
failing assertion no longer leaks a tmpdir.

**Declined by the lead, not applied:** `createTeamManifest` throwing without
`clodexHome`, and pinning CLODEX_HOME on the PTY spawn at
`session-manager.js:883`. Both filed separately.

No `build:web`: only plugin RENDERER halves are bundled (`build/build-web.js:55`)
and this touched the engine half.
