# Addenda to the durable-state design

Post-design refinements. Kept separate from `design.md` so the designer's
artifact stays as delivered and reviewed. Past tense, pinned, attributed.

## A1 — the writing rule extends to messages, not just files

From clodex-hand, 2026-08-04, after applying §6 to its own traffic.

`design.md` §6 was written for records on disk. It applies unchanged to
inter-seat messages: a report is a durable record with a **delayed read** —
the lead may act on it several turns later — so a present-tense status claim
fails there for the same reason it fails in an artifact.

Live example from the session that produced the design: the hand's t152
progress report said "suite is running". When the exec wrapper timed out at
120s, that line left the lead unable to distinguish finished-green from
died-with-its-process — the original re-run-suite instance, reproduced in the
message channel instead of a file.

## A2 — some channels are unpinnable in principle

The sharper form, also from clodex-hand, and it supersedes A1's framing as
merely "might go stale".

Two different failures were being treated as one:

- A claim that **went** stale — true when written, falsified by later events.
  Fragile, timing-dependent.
- A claim that is false **on arrival by construction** — written into a
  channel whose delivery is deliberately deferred to a time the writer cannot
  name.

The second is the harder case and has a cleaner test than "might this go
stale":

> **Ask whether the channel guarantees the read happens at a time the writer
> can name.** If it does not, status in that channel is unpinnable in
> principle, not merely fragile.

Reminders and parked dms never guarantee it. Measured instance: a reminder
body armed 2026-08-04 carried "nothing pending on me, tree clean and in sync
with origin"; it arrived 45 minutes later with three seats in flight and the
tree held uncommitted. Both clauses false on arrival. The same body's OTHER
content — the artifact path, and that a fresh seat could resume from it —
was still true, because a path is not a status.

Consequence for writing: a deferred-channel body should carry only what to
CHECK and where the durable artifact lives. Never what the world looked like
when it was armed.
