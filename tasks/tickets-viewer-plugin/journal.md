# t116 — tickets-viewer plugin (a Manage-Plugins board for team tickets)

## Spec (from clodex, msg-24254-19, verbatim intent)

Build `plugins/tickets-viewer/` showing the team ticket board, modelled
directly on `plugins/memory-viewer/`. That plugin is the template for
structure, manifest shape, engine/renderer split, and style conventions —
read it first, then `plugins/plugin-api.md`.

Data source is `tickets-store.js`. **Establish its read surface yourself; do
not assume it mirrors the memory store's.**

**Scope v1 is READ-ONLY — a deliberate constraint, not an oversight.** The
memory viewer got a delete button because `host.library.remove` already
existed with `memory` as a registered kind. Tickets are NOT a library kind,
and inventing a mutation seam for them under time pressure would mean
designing a published API surface in a hurry — the one category of work that
must not be rushed, since out-of-tree authors can't be un-shipped.

Board view only: **id, title, status, assignee, age, artifact path.**
If I find myself wanting a close button: STOP and tell clodex. It is the next
ticket, not this one.

What earns its place in v1 — the states a lead actually acts on:
- open tickets sorted so STALLED ones are visible
- assignee shown
- artifact path shown (how a fresh seat recovers a dead worker's task)
- recently-closed available but NOT competing for space with open work

**Watch for:** the false-green class hit three times tonight. An empty board
and a board that FAILED TO LOAD must not render identically. Make the failure
say so.

**Path building:** `plugins/memory-viewer/engine.js:27` carried the dot-blind
regex until an hour ago; its `agentDir()` containment is what actually made it
safe. If this plugin builds any path from a caller-supplied value, use
`path-confine.js` (landed in 5552a31), NOT a regex.

Baseline **3152 pass / 0 fail** at 5552a31, tree clean. Do not commit.

## Standing constraints (mine, not the ticket's)

- Never commit/tag/push. Leave the tree dirty for clodex.
- Never edit `.claude/memory.md` or `.claude/CLAUDE.md`.
- Full suite via the clodex-test-green skill (test-runner subagent), never
  `node --test` on the whole suite. Green requires **escapes: 0** too.
- `npm run build:web` after touching bundled renderer sources (plugin renderer
  halves ARE bundled — the build log lists them by name).
- New plugin must pass `node plugins/tools/verify.js plugins/tickets-viewer`
  (takes a PATH, not a name).
- clodex's site lists are a SEED — close the enumeration myself and report
  what was missed. Four specs running have been short.

## Plan

1. Read `plugins/memory-viewer/` (manifest, engine, renderer, style, README)
   and `plugins/plugin-api.md`. Establish `tickets-store.js`'s real read
   surface by reading it, not by analogy.
2. Decide the board's sort/grouping (stalled-visible) and the
   loaded-but-empty vs. failed-to-load distinction BEFORE writing render code.
3. Implement engine half (plain Node, no electron) + renderer half (rhost
   only, never window.api).
4. Tests + `verify.js` + `build:web` + full suite.

## Journal

### Phase 1 — read surface established (done)

**`tickets-store.js` does NOT mirror the memory store.** Its whole exported
surface is four things:

- `createTicketsStore({fs, path})` → `{ load(teamDir), save(teamDir, tickets), ticketsPath(teamDir) }`
- `nextTicketId(tickets)`, `ticketTitle(specText)`, `extractTaskDir(specText)`, `TICKET_FILE`

Critical differences from `memory-store.js`:

1. **It is team-DIRECTORY-scoped, not name-scoped.** `load(teamDir)` takes an
   absolute dir; the store never enumerates teams and never builds a path from a
   team NAME. Storage is `~/.clodex/teams/<team>/tickets.json` — one flat JSON
   ARRAY per team, not a directory of files.
2. **`load()` never throws.** Missing/unreadable/corrupt/non-array → `[]`. This
   is the whole false-green hazard clodex flagged: **a team whose tickets.json
   is corrupt is indistinguishable from a team that never opened a ticket, if I
   just call `load()`.** So the plugin must NOT use `load()` for the read path —
   it has to stat/read/parse itself so "failed" and "empty" stay distinct.
3. There is no list-of-teams accessor anywhere. Enumerating `~/.clodex/teams/*`
   is the plugin's own job.

**Ticket record shape** (written by `session-manager.js` `_taskAdd`, mutated by
assign/done/reject/cancel):

```
id, title, spec, assignee|null, opener, state: 'open'|'done'|'cancelled',
openedAt, closedAt|null, lastActivityAt, nudgedAt|null, closedBy?, taskDir?
```

`taskDir` is the spec's `tasks/<dir>` path — **optional, absent when the spec's
first line has none.** That is the "artifact path" column; it is frequently
missing and the board must say so rather than render blank.

**Stall is a real product concept, not something I invent:** `_sweepTickets`
uses `TICKET_STALL_MS = 30min` (overridable per team by `team.watchdogMs`) over
`lastActivityAt || openedAt`, and `nudgedAt` records that a stall nudge already
fired. So "sorted so stalled ones are visible" = sort open tickets by
`lastActivityAt` ASCENDING (quietest first) and mark those past the team's
stall threshold. I take the threshold from `team.json`'s `watchdogMs` when
present, exactly as core does, so the badge cannot disagree with the nudge.

`_taskList` (session-manager.js:~3316) is the existing listing and defines the
house treatment of recently-closed: `RECENT_DONE_MS = 24h`, `RECENT_DONE_CAP =
10`, **done only — recently-cancelled deliberately absent**, and counts of done
and cancelled reported separately. I mirror those constants rather than picking
my own; a third disagreeing definition of "recent" is worse than duplication.

### DECISION — `path-confine.js` cannot be required, and must be copied

clodex's instruction was "use `path-confine.js`, not a regex". **The plugin
boundary forbids the require**: plugin-api.md §12 refuses any relative require
that leaves the plugin's own directory, so `require('../../path-confine')` fails
the boundary lint. §4 states the rule for exactly this case — *"A utility only
your plugin uses belongs in your own directory — copy it in, don't ask for it
here."* `plugins/memory-viewer/engine.js` `agentDir()` already resolves it the
same way (an inline dirname comparison), which is why it was safe.

So: a local `confine()` inside the plugin with `path-confine.js`'s semantics
(resolve, compare `dirname` to the root), NOT a regex, and NOT a copy of
`AGENT_NAME_RE` doing the work. Flagged as a deviation in the report — the
instruction's intent is honoured, its literal form cannot be.

The caller-supplied value here is the **team name** (renderer picks a team →
engine builds `<teamsRoot>/<team>/tickets.json`). That is the one and only
path built from renderer input.

### Root derivation

`process.env.CLODEX_HOME || ~/.clodex`, matching `team-manifest.js`'s
`defaultClodexHome()`. Deliberately NOT memory-viewer's bare
`os.homedir()/.clodex`: for the teams root core itself honours `CLODEX_HOME`, so
hardcoding would make the plugin read a different tree than the app under a
CLODEX_HOME run — and it gives the tests a seam that needs no fake home.

### Empty vs. failed — the three states the board must distinguish

Per team, and per the whole board:
1. **loaded, has tickets** → rows
2. **loaded, no tickets** → "no tickets" (file absent OR array empty — both are
   genuinely "nothing here", and `_taskAdd` creates the file on first ticket)
3. **could not read** → an explicit error row naming the reason. Reached by:
   readFile threw for a reason other than ENOENT, or JSON.parse threw, or the
   parsed value is not an array. `tickets-store.load()` collapses all three into
   `[]`, which is why the plugin reads the file itself.

The whole-board case is the same trichotomy: no teams dir / no teams / teams
root unreadable must not render identically.

### Phase 2 — plugin written (done)

`plugins/tickets-viewer/{manifest.json,engine.js,renderer.js,style.css,README.md}`.
`node plugins/tools/verify.js plugins/tickets-viewer` → **15/15**.

Engine exposes exactly two rows, both reads: `teams` and `board(team)`. No
mutation seam of any kind — asserted, so a close button appearing later is a red
test rather than a review catch.

### FINDING — containment is not existence (my test vector was wrong, the
### product had a real gap)

My escape list included `'...'`. It failed: `confine()` accepts it, correctly —
`...` is a legal single path component that resolves to a direct child of the
teams root. Containment has nothing to say about it. My vector was wrong.

But the failure surfaced a genuine product gap: **`board('no-such-team')` was
returning a healthy empty board**, because `readTickets` treats ENOENT as "no
tickets yet". That is the exact false-green class this ticket is about, one
level up — a team that does not exist looked like a team with nothing open. Fix
in the product: `board()` now requires `team.json` to exist (the same thing that
makes a directory a team in `teams()`) and returns `no team "<name>" under
<root>` otherwise. The test now asserts both refusal REASONS separately, and
the comment says why `...` is not a containment case.

Worth noting the shape: had I not run the accept/reject split, the plugin would
have shipped with a nonexistent team rendering as an idle one.

### Phase 3 — tests (done)

`test/tickets-viewer-plugin.test.js` (21, engine through the REAL plugin host
engine over a temp CLODEX_HOME tree) + `test/tickets-viewer-renderer.test.js`
(15, overlay mounted against a fake rhost + the minimal fake DOM
memory-viewer-renderer uses; no jsdom). **36 new, all green.**

`npm run build:web` → registry now lists `tickets-viewer`. Plugin suites
(boundary, style, web-parity, core-innocence, surface-contract, loader) 106/106.

### Mutation table — every case watched fail BY MESSAGE

| # | mutant | fails |
|---|---|---|
| M1 | `readTickets` swallows like `tickets-store.load()` | 3 |
| M2 | drop the team-existence check | 1 |
| M3 | stall threshold ignores `team.watchdogMs` | 1 |
| M4 | open sort inverted (stalled sinks) | 1 |
| M5 | renderer paints a failed board as empty | 1 |
| M6 | **wrong fix:** regex instead of containment | 1 |
| M7 | **wrong fix:** over-eager guard bans `my.team` | 1 |
| M8 | recently-closed includes cancelled | 1 |
| M9 | malformed count zeroed | 1 |
| M10 | trailer prints zero counts | 1 |
| M11 | absent artifact renders blank | 1 |

Both wrong-fix mutants redden, which is the pair that matters: M6 is exactly
the regex clodex warned against and M7 is the over-eager fix that would break a
legal dotted team name. Product restored from a pristine copy and re-verified
byte-identical after every mutant (`diff -q`), 36/36 green after.

### Phase 4 — full suite (done)

**3191 pass / 0 fail / ESCAPES 0** (baseline 3152, +39).

+39 not +36: three plugin suites are PARAMETERIZED over `plugins/*`, so a new
directory adds cases by itself. Verified rather than assumed — removed the
plugin dir, re-ran, re-counted: plugin-boundary 23→22, css-parses +
plugin-host-engine + plugin-loader 127→125. 36 mine + 3 generated = 39.

Tree: `plugins/tickets-viewer/` (new), two new test files, the task dir, and
`renderer/web/plugin-registry.js` + `web-dist/index.html` regenerated by
`build:web`. Not committed.

---

# Rework round (msg-24254-46, cold review)

Both must-fixes verified against the sources before implementing, per the
lesson from the withdrawn `CLODEX_HOME` item.

## MUST-FIX 1 — mirror core's CLAMP, not just its default

`team-manifest.js:157-163` neutralises `watchdogMs` at READ, in `loadManifest`,
and its comment says why: `team.json` is agent-writable, so the value is fixed
at the choke point every consumer passes. My `stallMsFor` mirrored the
*precedence* (`team.watchdogMs || TICKET_STALL_MS`) because that is what was
visible from `_sweepTickets` — but `_sweepTickets` only ever sees a value that
already went through the loader. This plugin does not, so it has to clamp for
itself.

The reasoning that decides the priority, not just the fix: `JSON.parse('1e400')`
is `Infinity`. `typeof` is `number` and `> 0` is true, so the old guard passed
it, `stallMs` became `Infinity`, and **every `stalled` on the board became
false** — while core kept nudging on 30 minutes. That is the silent direction of
this plugin's own false-green rule, landing on the single number the whole
surface is organised around. A board that says nothing is stalled is not
distinguishable, by looking at it, from a board where nothing is stalled.

Added `WATCHDOG_MIN_MS` / `WATCHDOG_MAX_MS` beside `DEFAULT_STALL_MS`, required
`Number.isFinite`, clamped into [5m, 7d].

Note on test teeth: the pre-existing threshold case used `4 * HOUR`, which sits
*inside* the clamp window — the suite was green across the whole gap. The new
cases use `1000` (below the floor), `365d` (above the ceiling) and `1e400`
(non-finite), and each was proved by reverting the product (M-A, M-B below).

## MUST-FIX 2 — unassigned tickets are never stalled

`session-manager.js:3421` is unambiguous: `if (t.state !== 'open' ||
t.assignee == null) continue; // backlog/closed exempt`. There is no seat to
nudge, so core can neither raise nor clear a stall on a backlog ticket, and a
board that flagged one would be showing a state the app cannot reach.

The renderer already carried the distinction in a comment — "an unassigned open
ticket is backlog, not an unlabelled row: it is a different action for the lead"
— and the engine never carried it into the flag. Two states needing opposite
actions (assign it vs. chase whoever holds it) painted identically, which is
this plugin's stated reason for existing pointed backwards.

Took the SEPARATE-FLAG option clodex offered, since it was cheap:
- `shape()` hoists `assignee` and gates `stalled` on it; adds `backlog`.
- `counts.backlog` and a per-team `backlog` count, both distinct from `stalled`.
- Renderer: `tv-backlog-flag` on the row, `tv-backlog-count` in the section
  head, `tv-team-backlog` in the sidebar. Neutral/dimmed, deliberately NOT the
  stall amber, and the backlog flag is in the `else` branch of `stalled` so the
  two can never both appear.
- Age is still computed and shown for backlog rows — a backlog ticket sitting
  for a week is worth seeing; calling it a stall is what was wrong.

## NITS — all four taken

1. **`existsSync` → a real read.** `existsSync` answers false for EACCES,
   EPERM and ELOOP alike, so an unreadable team VANISHED rather than showing
   the error row the design already provides. Replaced with `readManifest()`,
   which reads the file and returns exactly one of `{missing}` / `{error}` /
   `{manifest}` — the read IS the existence probe, and the three outcomes get
   three different pictures. Used in both `board()` and `teams()`. Took
   `readFileSync` + ENOENT rather than the suggested `statSync({throwIfNoEntry:
   false})` because the manifest is read a line later anyway: one syscall, one
   error path, and no window between the probe and the read.
2. **A `team.json` core would REJECT** now yields `warning` on the board and on
   the sidebar row (amber `tv-warning` / `tv-team-warning`), while the tickets
   still render — they are real, so this is a warning beside them, not an error
   instead of them. `manifestWarning()` is a deliberate SUBSET of core's
   validator (root/lead/roles/lead-role, plus non-object and non-JSON); the full
   thing is 50 lines of per-role normalization and would be a third copy to
   drift. The subset is one-directional: what it names, core also rejects; what
   core rejects and it misses renders as it does today. It never calls a
   manifest good. Not checked: per-role shapes, the lead role's `instantiate`.
3. **`selectTeam` captures `reloadSeq` too.** The memory-viewer token bug class.
   The reachable path is sharper than "a reload lands first": `renderTeams`
   returns EARLY when the teams list fails, so it never starts a new select and
   never bumps `selectSeq` — an in-flight board result then paints tickets over
   the error the user is looking at. That is the case the new renderer test
   drives, and it is the one that reddens on revert.
4. **`?? openedAt` vs `|| openedAt`** — comment added at the site. The two
   diverge only at an epoch-zero timestamp; `??` is kept on purpose, since
   `num()` has already mapped every genuinely absent value to `null` and a
   timestamp of 0 is not "no timestamp".

## Verification — every new case proved by reverting the product

| # | mutant | expected red | result |
|---|---|---|---|
| M-A | clamp reverted to raw `watchdogMs` | clamp + Infinity cases | 2 fail |
| M-B | only `Number.isFinite` dropped, clamp kept | Infinity case alone | 1 fail |
| M-C | `stalled` ignores assignee again | backlog case | 1 fail |
| M-D | renderer paints backlog with the stall flag | renderer backlog case | 1 fail |
| M-E | `reloadSeq` capture removed | reload-race case | 1 fail |
| M-F | `readManifest` back to a bare existence probe | unreadable-team case | 1 fail |
| M-G | manifest warning always null | reject case | 1 fail |
| M-H | warning fires on EVERY manifest (over-eager) | reject case's accept half | 1 fail |
| M-I | renderer drops the warning line | renderer warning case | 1 fail |
| M-J | sidebar backlog chip removed | renderer backlog case | 1 fail |

M-B and M-H are the wrong-fix mutants — a clamp without the finiteness test, and
a warning that cannot say a manifest is fine. Both redden.

Product restored byte-identical after every mutant (`diff` against a pristine
copy, checked at the end).

Fixture note: `mkTeam` now writes a manifest core's `loadManifest` ACCEPTS
(`root` + `lead` + a `lead` role). Without that every pre-existing case would
have carried a warning, and the new warning assertions would have been true of
the fixture rather than of the case.

## Live evidence for must-fix 2

Against the real `~/.clodex/teams/clodex` registry at the time of the fix:
21 open tickets, 18 of which would have rendered `stalled` under the pre-fix
engine, and **0** under core's own rule. Every one of the 18 was unassigned
backlog. The board's headline number was wrong by 18 on the only team that
exists.

## Final verification

- Full suite: **3199 pass / 0 fail / ESCAPES 0** (baseline 3191, +8: engine
  21→26, renderer 15→18).
- `node plugins/tools/verify.js plugins/tickets-viewer`: 15/15.
- `npm run build:web` re-run (renderer half is bundled).
- Not committed.
