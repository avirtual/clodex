# plugins/github/workflows.js

## fenceUntrusted

The closing `---- END UNTRUSTED ----` is load-bearing: an agent that cannot see
where outside text STOPS has no fence at all. `reply` clips from the end, so an
interior long enough to reach `MAX_REPLY_CHARS` would remove exactly that line.
`interiorBudget` therefore sizes the interior against the room the header and
both fence lines leave, and `reply` stays in the path only as a backstop.

## issue

Comments are selected newest-first against the remaining budget and rendered
chronologically. A straight tail-cut of the assembled text would drop the LAST
comment, which on an issue is the one saying how it ended. The per-comment cap
(2000) is a first bound, not the operative one: the whole reply is capped at
3000, so on a busy issue the budget binds first — which is why a single long
comment cannot starve the newest one.

## issues

`comments` arrives as a COUNT from `gh issue list` and as an ARRAY from
`gh issue view`; `commentCount` accepts both because the two sub-commands share
these helpers.
