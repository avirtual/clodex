# docs/notes/memory-load.md

## createMemoryLoad
Three states per unit: `full` (body rode the digest, a recall, or a late operator-directive push), `title` (index line only), `absent`. The set is seeded from `digestTiers()` by `SessionManager._seedMemoryLoad` at a non-resume claude spawn, after `noteCompact` in `_fireCompactContinuation`, and after `noteSession` on a /clear (not a fork, which resumes and gets no digest); the hook re-serves the digest on startup, clear and compact. `noteRecall` marks full for a recall intent and for `_pushLateDirective`.
Wirescope tail hints are not recorded: they appear in the transcript zero times (verified 2026-07-31), so they are live for one request only.
