# t80 — task list defaults to open, done tickets on request

Branch: `t80-ticket-list-filter` off `t81-exec-prompt-grammar` head (see below).
Spec from `~/.clodex/teams/clodex/tickets.json` (t80); spool file already reaped.

## Branch base — FLAGGED

t81 is not merged yet, and t80 touches `session-manager.js` and
`test/session-manager.test.js` — both also touched by t81. Branching t80 off
master would give clodex two branches with overlapping files and a likely
conflict at the second merge. Branching off the t81 HEAD makes t80 a clean
fast-forward once t81 lands. **If clodex wants t80 independent of t81, say so and
I will rebase.**

## Phase A — verification (clodex's queue-ahead claims, checked myself)

clodex said: state set is exactly open/done/cancelled, and REJECT IS NOT A STATE
(they cited `session-manager.js:4887`). **Confirmed, with a line correction.**
Every write to `ticket.state` in the tree:

| site | value |
|---|---|
| `session-manager.js:4792` | `'open'` (add) |
| `session-manager.js:4889` | `'done'` |
| `session-manager.js:4917` | `'open'` — **reject REOPENS** |
| `session-manager.js:4939` | `'cancelled'` |

`:4913` guards reject with `if (ticket.state !== 'done')`, so reject is a
transition from done back to open, never a state of its own. clodex's cite was
`:4887`; the actual reopen is `:4917`. Fact holds, number was off.

**So the filter vocabulary is: `open` (default), `done`, `cancelled`, `all`.**
No `rejected` filter — per clodex, it would read as "none rejected" rather than
"not a category", which is the same class of lie t81 just spent a ticket
removing.

## Phase A — the two listings

1. `session-manager.js:4952` `_taskList` — intent path.
2. `scripts/clodex-team.js:155` `doTickets` — exec path.

Both build byte-identical lines:
```js
`${t.id} [${t.state}] ${t.assignee || '—'} ${humanizeAge(now - (t.openedAt || now))} — ${t.title || '(untitled)'}`
```
and `humanizeAge` is DUPLICATED (`scripts/clodex-team.js:145` is a verbatim copy
of the core one). So the duplication the spec worries about already exists and
predates this ticket.

### cli/-sharing decision: KEEP THEM SEPARATE

`scripts/clodex-team.js` requires exactly four node builtins (`fs`, `net`,
`path`, `os`) and nothing else — verified by reading its require block. It is
materialized OUT of the repo into `~/.clodex/run/bin/` by
`pot-bin.js materializeExecScripts` as a FLAT COPY BY BASENAME, with the comment
at `pot-bin.js:47-51` stating they are "dependency-free (node builtins only), so
a flat copy by relative path is sufficient — no require-closure to walk."

**A shared formatter module would break that materialization outright**: the
flat copy moves only the script, so a `require('../ticket-format')` would
resolve to nothing at run time in `run/bin/`. Sharing would mean either adding
the formatter to a require-closure walk (real machinery, well beyond this
ticket) or breaching the leaf invariant. The spec explicitly says "do not breach
the boundary to save a few lines."

So: **two independent implementations, kept behaviourally identical, with a
cross-reference comment in each pointing at the other.** Stated in the report as
the spec asks.

## Phase A — grammar/doc site

The `task` verb has NO line in `ipc-prompt.js` (grepped: no match). Its
agent-facing documentation is the team-lead system prompt,
`resources/library/prompts/system/clodex-team-lead.md:60`:
`- `[agent:task list]` — the current board.`
That is the file to update. `clodex-team-hand.md` mentions only `task add`/`done`
and does not describe `list`, so it needs no change.

`intent-registry.js:199` `list` branch drops `argToks` entirely; `:290` gives
list `bodyMode 'none'`, so the filter must be a BRACKET arg, as the spec says.

## Design

- `parseTask` list branch carries `filter: argToks[0] || null`.
- `_taskList` / `doTickets`: default `open`; `done`/`cancelled`/`all` supported;
  unknown bounces loudly naming the valid set.
- Default view appends a count line that STATES THE QUERY, per spec.

## Phase B — implemented

| # | Site | Change |
|---|---|---|
| 1 | `session-manager.js:177` | `TICKET_FILTERS = ['open','done','cancelled','all']` |
| 2 | `session-manager.js:4965` `_taskList` | filter + default-open + count line + loud bounce |
| 3 | `intent-registry.js:199` `parseTask` | list branch carries `filter` |
| 4 | `intent-registry.js:187` | header comment: `list [filter]` |
| 5 | `scripts/clodex-team.js:155` `doTickets` | mirrored, own `TICKET_FILTERS` copy |
| 6 | `resources/library/exec/clodex-team.json` | `filter` enum property on the schema |
| 7 | `resources/library/prompts/system/clodex-team-lead.md:60` | the agent-facing grammar |

Site 6 was not in the spec's list and is required by it: the exec path takes its
input as a validated JSON payload, so a `filter` the schema does not declare is
rejected by `additionalProperties: false` before `doTickets` ever sees it. Adding
the CLI branch without the schema field would have shipped a filter that bounces
on the exec path — a silent half-feature. It also picks up t81's rendering for
free, so the granted seat's prompt now shows the filter enum.

### Behaviour

- default (no arg) = `open`, plus `(N closed — [agent:task list done], [agent:task
  list cancelled] or [agent:task list all])` when N > 0.
- explicit filter = that state only, header `tickets on <team> [<filter>]`, and
  NO count line (the caller chose the slice).
- all-closed board says "no open tickets" and still carries the count+query,
  rather than the pre-existing "no tickets" which would now be a lie.
- unknown filter: `error: unknown filter "x" — use one of: open, done, cancelled, all`
  and renders nothing else.

## Phase C — tests: 6 added + 2 existing updated + 2 parse pins updated

Existing tests updated HONESTLY, not loosened:
- `test/session-manager.test.js:3251` — added `filter: null` to the intent and a
  new assertion that no count line appears when nothing is hidden (STRENGTHENED).
- `:3265` — added `filter: null`.
- `test/intent-scanner.test.js:259` — the bare-list shape now includes
  `filter: null`, plus two NEW cases (explicit filter, unknown filter parses).
- `test/intent-registry.test.js:77` — the legacy-chain equivalence pin holds a
  frozen COPY of the old parser; its list branch moved in lockstep. That pin
  exists to catch UNINTENDED drift, so a reviewed shape change belongs in both
  or the pin stops meaning anything. Commented in place.

### REVERTS — all by message

Pristine copies taken first; `git diff --numstat` after every restore and revert,
plus a grep confirming each substitution actually landed (revert C and
anti-revert D are same-line-count edits, where numstat alone cannot tell a real
change from a perl no-op — the grep is what proves it).

| # | Change | Tests failed | By |
|---|---|---|---|
| A | default filter `open` -> `all` | 3 | message |
| B | drop the unknown-filter bounce (silent fallback) | 1 | message |
| C | count line keeps the number, drops the query names | 2 | message |
| D* | emit the count line ALWAYS (>= 0, every filter) | 2 | message |

\* D is an ANTI-revert. The two "no count line" assertions pin an ABSENCE, which
is the pre-existing value — no revert of mine could move them, so only forcing
the line to appear enters their window.

### ENTER check

`mkBoard()` asserts t1/t2/t3 really are open/done/cancelled BEFORE any listing
runs. Without that, every "hidden" assertion would pass trivially on a board
where nothing was ever closed. The bad-filter test also asserts the default board
was NOT also rendered — otherwise "it bounced" would pass while the caller still
got a board.

Nothing armed: `mkTasks` never calls the real `create()`; no timers, no fs.

### Suite

**2986/2986, ESCAPES 0** (2980 + 6), via the test-runner subagent.
