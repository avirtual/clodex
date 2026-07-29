# t108 — rhost.events.on(topic, fn)

Seeded by the lead at dispatch. Assignee: clodex-hand.

## Corrections to the ticket body

The ticket's first line points at `tasks/t107-rhost-events-on`. Wrong id — the
board minted t108. **This directory is the artifact.** The t107 path in the
ticket is a dead pointer, not a second task.

Journal here AS YOU GO, not at the end. A compact or a crash mid-task is
recovered by a fresh spawn reading this file; anything left only in a context
dies with it.

## The gap, in one line

`emitScoped` already delivers `plugin-event` to the renderer process; the
renderer drops every event that is not core's own `_host`/`plugin-state`
housekeeping, and `buildRhost` has no `events` member to hand one to.

Call sites (verified against source at dispatch time, not from docs):

- `plugin-host-engine.js:240-260` — `emitScoped()`, three scopes, validated.
  UNTOUCHED by this task.
- `api-contract.js:298` — `onPluginEvent`, channel `plugin-event`,
  args `(pluginId, topic, payload)`. Already on the contract.
- `renderer/renderer.js:2370-2376` — already subscribed. The early return on
  line 2372 is the drop.
- `renderer/plugin-host.js:381-450` — `buildRhost`; add `events` here, dispose
  through the existing `onDispose` path.

## Scope walls (the load-bearing part)

If the work starts pushing against one of these, STOP and flag it to the lead
rather than building through it. Each one is where this turns into a general
event-bus rewrite:

1. **No `hostApi` bump.** Stays frozen at `"1"`. `docs/plugin-api.md:1590-1600`
   is the policy: a new `rhost` member ships as "1.1 behaviour" under `"1"`.
2. **No buffering, no replay, no delivery guarantee.** Events stay unbuffered
   (Law 2) — a window opening after an emit still hears nothing. This is an
   optimization over polling BETWEEN opens, not a replacement for pull-on-open.
   Wanting a queue means the ticket has been left.
3. **No cross-plugin delivery.** A plugin hears its own engine half only.

## Verification

- The existing `deactivate() releases surfaces` property must cover listeners.
- A NEW test: an emit scoped `{ workspace }` must not reach a plugin in another
  workspace. The scoping is core's and predates this work, but this is the first
  path that lets a plugin observe it, so it is the first that can leak it.
- Suite green via the test-runner agent (baseline 203+), not by hand.

## Journal

Taken over by the lead after two dispatches to clodex-hand died to upstream 529s
(the DM was delivered and read — `Read msg-65089-1.txt` — so the spec arrived;
the model call behind it failed). Cold seats are shed first under capacity
pressure, which is also why resetting that session made it less likely to land,
not more.

## Implemented

- `renderer/plugin-host.js` — `eventListeners` registry (same shape as the other
  seven: array, `pluginId` per entry, in the `purge` sweep, in `_counts()`, so it
  inherits the existing zero-leak teardown tests rather than restating them);
  `deliverEvent(pluginId, topic, payload)`; `events: { on }` on `buildRhost`,
  disposing through `disposable()`.
- `renderer/renderer.js:2370` — the `_host`/`plugin-state` branch became a
  positive match with an explicit return, then everything else fans out.
- `web-dist/index.html` — rebuilt. Cold review caught that the committed bundle
  was stale, which would have made this a desktop-only feature: the browser
  frontend would register listeners that never fire. No test gates the bundle
  (`plugin-web-parity` gates the registry, not the build); the release script's
  dirty-tree check is the only backstop, and that only fires at release.

## Deviations from the seeded spec

None on the scope walls: hostApi still "1", no buffering, no cross-plugin
delivery, engine `events` untouched at `{ emit }`.

One thing the spec did not anticipate, surfaced by review: `'all'`-scoped emits
are cross-workspace by design (`_broadcast`), and the §9 rule banning data
payloads on `'all'` was inert while the renderer discarded events. It is
load-bearing as of this change. Said so in §9 rather than changing behaviour —
narrowing `'all'` would be a different ticket.

## Verification

- 3075/3075, ESCAPES 0.
- Cold reviewer: `ship-with-nits`, no blockers. Traced the leak question end to
  end and confirmed a plugin in workspace A cannot hear an event scoped to B
  (`windowForWorkspace` picks one webContents; A is never a recipient).
- Nits taken: §5 inventory entry (the reference object omitted `events`, so an
  author reading §5 would never learn it exists); three comments cut for failing
  CLAUDE.md's bar (doc restatement, narration, ticket archaeology); sync-only
  caveat documented — `try/catch` cannot see an async listener's rejection, so
  the previous "caught and logged" claim was true only for sync listeners.
- Nit declined: none.
