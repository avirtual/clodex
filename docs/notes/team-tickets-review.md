# docs/notes/team-tickets-review.md

The review-start half of team-tickets.js — split out of
`docs/notes/team-tickets.md`, which is at its 120-line cap. Same module.

## _checkReviewStarted

"Started" is transcript growth ABOVE the size stamped by `_armReviewStartCheck`
on its first arm (`_reviewStartSize`), not size > 0: a Muse seat's mint turn is
in `session.jsonl` before the PTY spawns, so `> 0` read every Muse reviewer as
started and never re-nudged one that never took a turn. Claude and Codex seats
have no transcript at arm, so their baseline is 0 and nothing changes for them.
