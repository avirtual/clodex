# t113 — the digest serves the oldest pins and silently drops the rest

> Close this as ticket **t112**, not t113. Artifact directory names and ticket
> ids are separate sequences and have drifted by one: the lead names the
> directory when writing the spec, before `[agent:task add]` mints the id. Read
> the id off `[agent:task list]`, never off the directory name.

Three defects in `composeDigest` (memory-store.js:147). All three are live
today, measured on a real store, and all three are independent of the larger
question of how memories should be retrieved.

## Evidence

The lead's store: 179 units, 97 pinned, 227KB of bodies. `DIGEST_BUDGET` is
8KB (memory-store.js:136). Actually served: **11 pinned units, all created
2026-07-08**. Index lines for the other 86 pinned: **zero**. Two units pinned
that same day — deliberately, so future sessions would carry them — were on
disk and in no context, with nothing reporting it.

## The three defects

**(1) The pinned half is served oldest-first.** `list()` (memory-store.js:72)
sorts `learned_at` ascending. `composeDigest:150` reverses the unpinned half to
newest-first; `:149` does not reverse the pinned half, and its comment states
the ascending order as a known fact. Under budget this is invisible — with five
pins everything fits and order is irrelevant. Past the budget it means the
served set was frozen at whatever was pinned first, and no later pin can ever
displace it. A store crossing the budget goes monotonically stale with no
signal.

The two halves already disagree about which end matters, so consistency alone
argues for the flip. The stronger reason: a pin is a claim about what a future
session needs, and that claim decays. Newest-first also gives pinning a
correction path — re-pin to promote — which oldest-first does not have.

What the flip loses, stated honestly: a foundational pin from day one can be
displaced by twenty recent ones. That is real, and it is the survivable
failure, because defect (2)'s fix means the displaced unit still lands in the
index and stays recallable.

**(2) A dropped pin falls out of the digest entirely.** `:162` does
`omitted += 1; continue`, and the index loop at `:169` only ever walks `rest`.
So an over-budget pinned unit gets neither a body nor a line — it is strictly
LESS reachable than if it had never been pinned, since an unpinned unit at
least gets a snippet the agent can recall from. Pinning past the budget is
actively counterproductive, which is the opposite of what the word promises.

**(3) One counter hides the distinction.** `omitted` is shared by both loops,
so `(+168 more — [agent:memory list])` cannot tell "indexed and recallable"
from "pinned and vanished". `writeClaudeDigestFile` (cli-hooks.js:42) returns
`!!digest` — true if anything composed at all — so the save path reports
success identically either way. Nothing anywhere distinguishes a healthy digest
from one serving 11 of 97 pins.

## Fix

In `composeDigest`, and nowhere else:

1. Reverse the pinned slice to newest-first, matching `rest`. Replace the
   comment at `:149` — it currently states the ascending order as intent.
2. A pinned unit that does not fit falls back to an index line instead of
   vanishing. Emit it into the index section, marked as pinned so a reader can
   see the pin exists but its body did not fit. Budget-check the fallback line
   too: if even that does not fit, it counts as fully omitted.
3. Count pinned-demoted, index-omitted and pinned-omitted separately, and
   render a tail that names them. Something like
   `(12 of 97 pinned shown; 85 listed by title · +68 more — [agent:memory list])`,
   with clauses omitted when their count is zero. Exact wording is yours —
   the requirement is that a reader can tell the three cases apart.

Ordering within the fallback: demoted pins come before the unpinned index, so
the pinned-but-demoted set stays visually grouped with the pins.

## Constraints

- `composeDigest` is a pure function over `units`. Do not touch `list()`'s sort
  — four other things read it, and ascending is right for a listing.
- Do not change `DIGEST_BUDGET`. The budget is not the defect; how it is spent
  is. Raising it is a separate decision with a per-reset token cost.
- Do not change front matter, the store, or `writeClaudeDigestFile`. A curator
  that adds fields is a later, separate task; nothing here should anticipate it.
- No emojis, no ALL-CAPS in comments. Comments per `.claude/CLAUDE.md`: only if
  they name a wrong change they prevent. The one that clearly qualifies: why
  pinned is reversed (a future reader must not "restore" ascending order).

## Tests

`test/memory-store.test.js:75` and `:91` both pin current behaviour and will
need updating. `:91` asserts overflow produces `(+N more — …)`; that string
changes. Update, do not delete.

New cases, each named for the property it pins:

1. Pinned are served newest-first: with three pins over budget for two, the two
   NEWEST are rendered in full and the oldest is not.
2. A pinned unit that does not fit appears as an index line, not nowhere. Its
   id must be findable in the digest.
3. A demoted pin is distinguishable from an ordinary index entry.
4. Demoted pins sort before unpinned index entries.
5. The tail reports the three counts separately; each clause is absent when its
   count is zero.
6. The existing invariant still holds: no unit is ever truncated mid-body
   (`:99-101` covers this — keep it).
7. Regression, stated as the real case: 97 pinned units of ~900 bytes against
   the real 8KB budget yields a digest in which every one of the 97 ids appears
   somewhere — in full or as a line. This is the test that would have caught
   today's failure.

Mutation-check cases 1-5 before reporting: break each property in the source,
confirm the test fails, restore. Report the tally.

Per the mutation-harness rule (two false tallies in this repo in one day):
assert the exact substring is present before mutating, and assert the baseline
is green immediately before and after each mutant. Write the harness in Node
parsing runner output, never as a shell grep pipeline. A tally with an
implausible shape — all-survive or all-pass — is more likely a broken harness
than a real result; check the shape before believing the number.

## Not in scope

Deliberately excluded, all pending a design decision that is not made yet:
curation front matter (`subject`, `tags`, `superseded_by`, `verified_at`), any
Sonnet curation pass, per-turn retrieval delivery, and any change to what
`pinned` means. This task makes the current mechanism honest; it does not
change the model.

## Journal

- Spec written by clodex (lead) from a measured store: 179 units / 97 pinned /
  11 served, the served set frozen at 2026-07-08.
