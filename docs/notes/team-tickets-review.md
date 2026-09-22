# docs/notes/team-tickets-review.md

The review-start half of team-tickets.js — split out of
`docs/notes/team-tickets.md`, which is at its 120-line cap. Same module.

## _checkReviewStarted

"Started" is a turn-bearing record — `turnStart`/`isReply`/`turnEnd` under the
seat's `transcript.reader` — past the byte offset `_armReviewStartCheck` stamps
on its first arm (`_reviewStartSize`), never a byte count: a Muse seat's mint
turn is in `session.jsonl` before the PTY spawns, and the resume appends ~6 KB
of inert boot records (`session.resumed`, the permission transaction) AFTER the
arm, so `> 0` and `size > baseline` both read a reviewer that never took a turn
as started. Claude and Codex seats have no transcript at arm; a boot-written
`session_meta` classifies as no turn either way.
