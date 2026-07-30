# Memory Viewer

Read-only browser for the memories Clodex agents save with
`[agent:memory remember]`. Opens from the "Memories" button in the sidebar
footer: agents (with unit counts and a live-session marker) on the left, that
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

Nothing notifies a plugin when a memory file changes, so freshness is bounded
by re-reads:

- **Overlay**: re-reads the store from disk on every open. What you see is as
  of the moment you opened it.
- **Session-row badge counts**: cached; the renderer polls every 60s and the
  engine caches agent counts for 60s, so a badge count may be up to ~2 minutes
  stale. Opening the overlay refreshes it.

The ~2 minute bound holds for a visible window only. The poll skips a hidden
one and there is no refresh on unhide, so a window that has been in the
background for an hour can show an hour-old badge for up to 60s after you come
back to it. The overlay is unaffected — it always re-reads.

## Settings

One toggle in Manage Plugins > Memory Viewer: "Show unit count on session
rows" (default on).

The setting is per-window at runtime: toggling it in one window does not reach
the others until they are reopened or the plugin is re-enabled.
