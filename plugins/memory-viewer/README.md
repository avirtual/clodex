# Memory Viewer

Read-only browser for the memories Clodex agents save with
`[agent:memory remember]`. Opens from the "Memories" button in the sidebar
footer — the only surface it adds. Agents (with unit counts and a
live-session marker) on the left, that
agent's units — scope, learned-at, source, pinned state, body — on the right.
Pinned units are highlighted; they are the ones baked into every new session's
boot digest.

Every agent directory found in the store is listed, not just agents with a
running session: memories outlive their sessions, and the dead ones are exactly
the material you cannot reach any other way.

## Read-only

v1 displays. It does not pin, unpin, forget or edit — the `[agent:memory …]`
intent remains the only write path.

## Freshness

Nothing notifies a plugin when a memory file changes, so the store is read on
demand: the overlay re-reads from disk on every open, and nothing is read
before then. What you see is as of the moment you opened it.

There is no session-row badge. A standing unit count is not something you need
at all times, and carrying one meant a poll, a cache and a staleness bound on a
surface that now has none.

## Settings

None.
