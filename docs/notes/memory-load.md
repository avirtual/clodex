# docs/notes/memory-load.md

## createMemoryLoad
Three states per unit: `full` (body rode the digest, a recall, or a late operator-directive push), `title` (index line only), `absent`. The set is seeded from `digestTiers()` by `SessionManager._seedMemoryLoad` at a non-resume claude spawn, after `noteCompact` in `_fireCompactContinuation`, and after `noteSession` on a /clear (not a fork, which resumes and gets no digest); the hook re-serves the digest on startup, clear and compact. `SessionManager._seedMemoryLoad` with `fresh` calls `reset` first at every non-resume spawn: the state outlives the seat's process, and a previous life's `sessionId` would make the new life's first `noteSession` read as a /clear and wipe the seed. The /clear and compact reseeds keep their state.
`noteRecall` marks full for a recall intent and for `_pushLateDirective`.
Wirescope tail hints are not recorded: they appear in the transcript zero times (verified 2026-07-31), so they are live for one request only.
