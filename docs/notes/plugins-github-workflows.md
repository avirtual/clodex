# plugins/github/workflows.js

## fenceUntrusted

The closing `---- END UNTRUSTED ----` is load-bearing: an agent that cannot see
where outside text STOPS has no fence at all. `reply` clips from the end, so an
interior long enough to reach `MAX_REPLY_CHARS` would remove exactly that line.
`interiorBudget` sizes the interior against the room the header and both fence
lines leave; `reply` stays in the path only as a backstop.

## issue

Comments are selected newest-first against the remaining budget and rendered
chronologically: a tail-cut of the assembled text drops the LAST comment, which
on an issue is the one saying how it ended. Which cap binds depends on the
issue — for one oversized comment the per-comment cap (2000), on a busy issue
the reply cap (3000), which drops whole comments.

## omittedLine

Reserved inside the budget BEFORE selection, at the width of the largest count
that can print, since the reserve is subtracted before the count is known.
Appended after selection instead, it falls outside the budget and the interior
clip lands on the declaration itself — the agent loses the notice that evidence
was withheld.

## clip

Below a max of 40 it slices to `max - 40` for its marker, so the index goes
negative and counts from the end: on a 500-char input the result is `490 + max`,
which exceeds the max throughout and exceeds the INPUT for max 11..39. Never
hand it a small remaining-room figure as a bound — `MIN_CLIP_CHARS` guards that
in `issue`.

## issues

`comments` arrives as a COUNT from `gh issue list` and as an ARRAY from
`gh issue view`; `commentCount` accepts both because the two sub-commands share
these helpers.
