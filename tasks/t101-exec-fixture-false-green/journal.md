# t101 — the exec-def test validated a stale hand-copy instead of the shipped def

Branch `exec-fixture-false-green` off master `6c5c1bf`. Ticket verified in
`~/.clodex/teams/clodex/tickets.json` (id `t101`, open, assignee `clodex-hand`).
Delivered twice — once by dm, once relayed by `clodex-team` — same bytes, one
ticket.

## Premise check

Every reference in the ticket verified at source. **All correct**, first ticket
in a while with no premise defect.

| Claim | Verdict |
|---|---|
| `test/clodex-team.test.js:29` reads the fixture | exact line, exact statement |
| `:333` / `:345` are the two schema tests | exact lines |
| fixture enum `["roster","retire"]`, shipped `[...,"tickets"]` | confirmed by diff |
| fixture has no `filter` property | confirmed |
| t80 = `9822828` updated the seed, copy did not follow | confirmed in the commit |
| `resources/library/exec/clodex-team.json` is committed and in-repo | confirmed; `test/pot-cli-closure.test.js:122` already reads it directly, so the precedent for reading the seed from tests existed |

The full divergence is wider than the ticket states — the fixture also has
`"cwd": "."` and a hand-written `argv` (`scripts/clodex-team.js`) where the seed
carries `${CLODEX_BIN}/clodex-team.js` and a `description`. That extra
divergence turned out to be useful: see the ENTER check below.

## Fix

`EXEC_DEF` now reads `resources/library/exec/clodex-team.json`; the fixture is
deleted. Header comment corrected — its justification ("not committed, so a
hermetic suite can't read it") is true of the operator-installed
`~/.clodex/library/exec/` copy and false of the repo seed, and it now says which
one it means and records what the copy cost.

## Added assertions

- `action: 'tickets'` accepted — the verb the stale schema would have rejected.
- All four `filter` values accepted, and `rejected` / `OPEN` / `''` rejected.
  Driven from the SCRIPT's own `TICKET_FILTERS` declaration rather than a
  literal list, so widening one side without the other fails here rather than at
  an agent's payload. This is the same class of pin as t100's listing parity:
  two halves of one contract that live in different files.
- An **ENTER check** on the source itself.

### Why the ENTER check asserts a property of the FILE

The obvious guard is "the schema under test contains `tickets`". That is exactly
the assertion a future stale copy would satisfy the moment someone updated the
copy once — it checks the content that happens to be wrong today, not the thing
that made it wrong. So the check asserts two properties a copy cannot have:

1. the def carries the `${CLODEX_BIN}` placeholder (a hand-copy rewrites argv to
   a repo-relative path — the historical fixture did exactly this), and
2. `test/fixtures/clodex-team.exec.json` does not exist.

Measured both: they discriminate independently (revert D fired only (2); revert
D2 fired only (1)). Neither is redundant.

## Revert proofs

Restored from md5-verified `cp` copies each time (`test/clodex-team.test.js`
`07dc4c28…`, `resources/library/exec/clodex-team.json` `7ba823b0…`). No no-ops.
Every failure an AssertionError with its own message.

| # | Revert | Result |
|---|---|---|
| A | drop `tickets` from the SHIPPED enum | 2 fail — "should accept {action:tickets...}: not one of roster\|retire" |
| B | delete the `filter` property | 1 fail — "should accept filter \"open\": payload.filter: not allowed" |
| C | widen the def's filter enum with `rejected` | 1 fail — "should reject filter \"rejected\"" |
| D | repoint `EXEC_DEF` at a fresh hand-copy | 1 fail — "the stale hand-copy is gone" |
| D2 | repoint at the ACTUAL historical fixture | 3 fail — argv placeholder + both schema tests |

**D2 is the proof that matters.** It reconstitutes the exact bug this ticket
describes — the real pre-fix fixture, restored from `master` — and the suite
goes red in three places. Before this change that same state was green. That is
the difference between a fix and a claim about a fix.

C is the one the ticket did not ask for and is worth keeping: it is the drift in
the *opposite* direction (gate more permissive than the script), which fails at
the agent rather than at the schema and so is the harder one to notice.

## Survey: other hand-copied fixtures

`resources/library/` ships six artifacts. Checked every one against
`test/fixtures/`.

- `exec/clodex-team.json` — the copy this ticket removes. **Was the only one.**
- `exec/clodex-monitor.json` — no fixture copy. Read directly by
  `test/pot-cli-closure.test.js:122`, which is the correct shape. It has no
  schema test of its own, so its def is pinned only for the argv placeholder,
  not for what it accepts. Not a false green (nothing claims otherwise), but a
  gap — flagging, not fixing, since it is not a one-line repoint.
- `templates/clodex-team-reviewer.json`, `prompts/system/clodex-team-{lead,hand,reviewer}.md`
  — no fixture copies. Tests reference the prompts **by name only**
  (`prompt-rails.js:33` `NON_SESSION_STOCK`, `test/prompt-rails.test.js`), so
  there is no content copy to drift. The names are duplicated between
  `prompt-rails.js` and `resources/library/prompts/system/`, so RENAMING a stock
  prompt file would silently drop it from the picker rule — a different and much
  narrower hazard than a stale schema, and out of scope here.

`test/fixtures/` otherwise holds `task-ledger/` and `transcript-stats/`, both
synthetic corpora with no shipped counterpart. Nothing to drift.

So: **one instance, fixed; one gap flagged; no other copies.**
