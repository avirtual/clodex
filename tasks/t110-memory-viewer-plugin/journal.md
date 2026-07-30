# t110 — a memory viewer, as a plugin

## Why this exists

Clodex agents save memories (`[agent:memory remember]`), and there is **no way
to see them.** Not in the app, not anywhere: you either ask the agent to
`[agent:memory list]` — which costs a turn — or you read
`~/.clodex/library/memory/<agent>/*.md` by hand. This plugin closes that.

It is also the deliberate answer to "should memory become a plugin?" **No** — see
the decision below. The *viewer* is the plugin; the mechanism stays in core.

## Decision: build the viewer, do NOT extract memory

Memory participates in **session boot**: `cli-hooks.js:20`
(`writeClaudeDigestFile`) bakes pinned units into the `SessionStart` hook's
`additionalContext` *before the PTY spawns*. That is what makes "your memories
reach every new conversation automatically" true, and §13 of the contract closes
that path to plugins on purpose. An extracted memory plugin would save and recall
correctly and silently lose the digest — a feature regression shaped like a
refactor.

The general test, which the implementer should not have to re-derive: **does the
feature participate in session boot, or cross the peer wire?** Either one means
it cannot be a plugin at `hostApi "1"`. Reading a store on disk is neither.

## Scope: READ-ONLY

v1 displays. It does not pin, unpin, forget or edit.

This is not timidity, it is the one-consumer-first rule: writes couple the plugin
to core's digest-refresh timing (core rewrites the digest file on every memory
intent, `session-manager.js:2538`), and that interaction should be understood
from a shipped viewer rather than guessed at now. Ship the read, learn, then
decide. **Do not add write operations because they look easy.**

## What to build

Id and directory name: **`memory-viewer`** (they must match — use
`node plugins/tools/scaffold.js memory-viewer` to start, it enforces this).

Target it at `plugins/memory-viewer/` in this repo (not `~/.clodex/plugins/`) so
the test suite's static gates cover it.

### Engine half

Reads `~/.clodex/library/memory/`. Derive it as
`path.join(os.homedir(), '.clodex', 'library', 'memory')`.

> **Known coupling, state it in a comment.** That path is core's, derived at
> `engine.js:132` + `:305`, and nothing exports it to plugins. If core moves the
> library root this plugin silently shows an empty list. This is legal —
> `plugin-api.md` §13 says an engine half is plain Node and may use `fs` — but it
> is a real coupling and the comment must name the consequence, not just the fact.

Do **not** `require('../../memory-store')`. `test/plugin-boundary.test.js` fails
it, and correctly: that is exactly the reach-around the boundary exists to stop.
Parse the frontmatter yourself — it is ~15 lines, and the format is
`---\nkey: value\n---\n\nbody` with keys `id`, `scope`, `learned_at`, `source`,
and `pinned: true` written **only when pinned** (absent means unpinned; do not
expect `pinned: false`).

IPC methods (via `host.ipc.handle`), names are yours:

- `agents()` → `[{ agent, count, pinned, live }]` for every directory under the
  memory root. **`live` is whether a session of that name currently exists** —
  `host.sessions.get(agent) !== null`.
- `units(agent)` → that agent's units, newest first, each
  `{ id, scope, learned_at, source, pinned, body }`.

**List every agent directory found on disk, not just live sessions.** Memories
outlive their sessions — the store has units for agents with no process. Showing
only live ones would hide exactly the material a user cannot otherwise reach.
Mark liveness; don't filter on it.

Validate the agent name against `/^[a-zA-Z0-9._-]{1,64}$/` before joining it into
a path, in `units()`. The argument arrives over IPC from the renderer; a `..`
component would resolve out of the memory root.

### Renderer half

- **Sidebar footer button** (§6.3) — glyph + label, opens the overlay. Badge it
  with nothing; a count of all memories everywhere is noise.
- **Overlay** (§6.7) — the surface. Left: agents with unit counts and a live
  marker. Right: that agent's units, showing scope, learned-at, pinned state and
  body. Pinned units visually distinct (they are the ones that ride every boot —
  that is the distinction that matters to a user).
- **Row badge** (§6.4) — unit count on a session row, for sessions that have
  memories. Use the cache-plus-`requestRelayout()` idiom; §6.4 spells it out,
  including the `requestRelayout()` at the end of `activate()` without which a
  live-enable shows nothing for tens of seconds.
- **Settings section** (§6.6) — one toggle, "show unit count on session rows",
  default on. Keep it to that: it is there to exercise the slot honestly, not to
  accumulate options.

### Freshness — pick a bound and say so

Nothing tells a plugin that a memory file changed (§14). So:

- Re-read on overlay open, every time. No cache across opens.
- Badge counts: cache with a TTL, 60s is fine.
- **State the bound in the plugin's README.** A count that is silently two
  minutes stale is worse than one documented as such.

### No intent verb

Do not register one. `memory` is a core verb and reserved — registration would
throw and the plugin would not load. There is nothing to add here: the viewer's
job is to show what the existing verb already stores.

## Constraints

- `hostApi: "1"`. Do not touch `HOST_API_VERSION` or anything outside
  `plugins/memory-viewer/` except the two files named under "Also".
- Engine half must not `require('electron')` (`test/electron-boundary.test.js`).
- Renderer half must reach nothing but `rhost` — no `window.api`
  (`test/plugin-boundary.test.js`).
- `enabledByDefault`: **false**. Git Branches and Workbench are both true and
  that is already two; a third default-on plugin makes a fresh install noisy.
  The user turns this one on.
- No secrets, no emojis (repo rule). Memory bodies are user content — render
  them as **text**, never as HTML.

## Also

- `npm run build:web`, and commit the regenerated
  `renderer/web/plugin-registry.js` — adding a `renderer.js` requires it and
  `test/plugin-web-parity.test.js` fails without it.
- A `README.md` in the plugin directory: what it shows, the freshness bound, and
  the fact that it is read-only.

## Gate

- `node plugins/tools/verify.js plugins/memory-viewer` passes.
- Full suite green. Baseline **3078 pass, 0 fail**, escape gate clean. A new
  plugin must not move an unrelated test.
- Report honestly what was and was not exercised. In particular: was the overlay
  ever actually rendered, or only reasoned about? Say which.

## Journal

(implementer: append findings, deviations and surprises here as you go)
