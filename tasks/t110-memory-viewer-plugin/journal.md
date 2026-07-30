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

### Implementation (t110-memory-viewer)

- Scaffolded with `node plugins/tools/scaffold.js memory-viewer`; replaced the
  stub halves. Note the scaffold's renderer stub calls
  `rhost.statusBar.addAction` — the real path is `rhost.ui.statusBar`; not
  used here anyway.
- Engine parsing checked against the real store (`~/.clodex/library/memory/`,
  15 agent dirs, 369 units): frontmatter parses on all of them, `pinned: true`
  present only when pinned as the spec says, `learned_at` is ISO-8601 so a
  string sort gives newest-first. One non-`.md` file exists in the wild
  (`clodex/tmp`) and is skipped by the `.md` filter — hence clodex counts 177
  units against 178 directory entries; that is correct behaviour.
- Path traversal check verified: `units('../evil')` is refused before any
  join. Unknown-but-valid agent names return an empty list, not an error.
- IPC method names: `agents`, `units`, `settings.get`. `agents` takes
  `{ force }` — the overlay passes `force: true` to bypass the engine's 60s
  TTL (spec: no cache across opens); badge polls take the cached row.
- Liveness could go stale inside the 60s TTL, so `onCreate`/`onExit` drop the
  agents cache (invalidation only, synchronous, per §4).
- Freshness bound as shipped: overlay re-reads on every open; badge counts are
  renderer 60s poll on top of engine 60s TTL, so up to ~2 min stale — stated
  in the plugin README.
- Deviation from the letter of the spec: `agents()` rows are computed by
  reading every unit of every agent (needed anyway for the pinned count);
  fine at this store's size (~370 files), noted in case a huge store ever
  makes the badge poll expensive.

### Gate results

- `node plugins/tools/verify.js plugins/memory-viewer`: 16/16 checks passed
  (activation through the real loader + engine, all three IPC methods answer,
  deactivate releases everything).
- `npm test`: 3081 pass, 0 fail, escapes 0. Baseline was 3078; the +3 are the
  suite's per-plugin static gates picking up the new directory (2 style-css
  subtests + 1 boundary subtest for memory-viewer). No pre-existing test moved.
- `npm run build:web`: registry now bundles git-branches, memory-viewer,
  workbench; `renderer/web/plugin-registry.js` and `web-dist/index.html`
  regenerated (web-dist is tracked, so both are part of the change).

### What was and was not exercised

- Exercised: engine handlers against the real on-disk store; renderer half
  driven end-to-end through a fake rhost with a minimal hand-written DOM stub
  (not jsdom — the repo has none): activate, badge resolve before/after cache
  fill, overlay open (mount + onOpen refresh), agent list render (15 rows,
  live marker on the one live session), unit render (177 cards, 95 pinned),
  newest-first ordering, agent switch by click, settings toggle hiding the
  badge, dispose. Script: scratchpad overlay-smoke.js (not committed).
- NOT exercised: the overlay in a real browser/Electron window — layout, CSS,
  Escape-to-close, one-overlay-at-a-time are untested; the CSS has only the
  suite's static checks. Multi-window behaviour and a live enable/disable in
  the running app were reasoned about (relayout-at-activation is in), not run.

### Rework from cold review

Both MUST-FIXes taken, NITs 1/3/6 taken, 2 and 7 documented, 4 and 5 declined
per the lead's call.

**MUST-FIX 1 — a background poll no longer starves a forced read.**
`fetchAgents` now joins an in-flight *unforced* fetch (`inflight`, cleared in a
`finally`), while a forced one always issues its own invoke. Joining would have
been wrong for `force`: it would let a poll that started before the user opened
the overlay — or one that is failing — decide what the overlay paints, which is
the same lie in a different shape. The `finally` also closes the latch: the old
code's `fetching = false` sat in the `.then`/`.catch` tails, so a synchronous
throw out of `invoke` skipped both and killed badge and overlay for the window's
life. While proving that, found the throw *also* escaped into `activate()` (and
into a sidebar render pass, via the badge kick) — the invoke is now wrapped in
`Promise.resolve().then(...)` so it cannot. Not in the review; same defect's
other half.

**MUST-FIX 2 — containment is now positive.** New `agentDir(agent)` does the
regex check *and* `path.dirname(path.resolve(MEMORY_ROOT, agent)) === path.resolve(MEMORY_ROOT)`,
and is the only way a name becomes a path (`units()` and `readUnits()` both go
through it). Verified against the real store: `.`, `..`, `../..`, `''`,
`x/../y`, `/etc`, `null`, `42`, a 65-char name all rejected; `clodex` still
returns its 177 units. Then verified the property the fix exists for — with the
regex deliberately loosened to admit `/`, `..`, `../..` and `a/../..` are *still*
rejected. The comment at the regex now says what it is (a character filter, not
the containment check) and points at `agentDir`.

**NIT 1 — the 5s forever-poll is gone.** Replaced the time-gap guard with a
`loaded` flag: one `agents` fetch answers for every name at once, so after the
first success a miss means "this agent has no memories", not "not asked yet",
and the badge stops kicking. I did not mirror git-branches' `pending` Set —
that plugin fetches *per name* so it needs per-name bookkeeping; here a single
boolean is the whole state. Refreshes are the 60s poll's job. `applyAgents` now
returns whether anything the sidebar renders actually differs, and
`requestRelayout()` fires only then.

**NIT 3 — `null` (could not read) and `[]` (nothing saved) now render
differently** in the agents pane: "Could not read the memory store." vs "No
saved memories.". `fetchAgents` resolves to `[]`, never `null`, on a successful
but empty read, so the distinction survives the await.

**NIT 6 — plain string comparison** for the ISO sort, as the comment claimed.

**NIT 2 and NIT 7 — README lines, no code.** The hidden-window caveat now
states the ~2 min bound holds for a *visible* window and that a backgrounded one
can show an hour-old badge for up to 60s after unhide; settings are documented
as per-window at runtime.

**NIT 4 and NIT 5 — declined** on the lead's call. No `'no such plugin method'`
handling (the plugin keeps polling a dead channel; git-branches' precedent
exists but was not adopted here) and no `lstatSync` symlink refusal on the agent
directory.

### Rework verification

- Renderer: scratchpad `rework-smoke.js` (not committed), a fake rhost with a
  gateable `agents` invoke, driving the real renderer half through a hand-built
  DOM stub. 13 assertions: overlay renders rows with a poll held in flight, does
  not paint "No saved memories." over a full store, and its read is forced; a
  sync throw neither escapes nor latches; a failed read renders as a failure and
  an empty store still renders as empty; 50 resolves of a memory-less agent
  issue zero extra fetches; five identical polls request zero relayouts.
- **Mutation-checked, per the gate.** Three mutants built by reverting each fix
  in a copy: (A) pre-fix `if (inflight) return Promise.resolve(null)` → MUST-FIX
  1's two assertions fail, overlay renders 0 rows; (B) pre-fix unconditional
  badge kick + unconditional relayout → NIT 1's two fail (50 fetches, 5
  relayouts); (C) `renderAgents(agents || [])` → NIT 3's two fail, a failed read
  reads as "No saved memories.". No assertion here can pass on the old code.
- Engine: exercised against the real on-disk store as above, plus the
  loosened-regex mutant.
- `node plugins/tools/verify.js plugins/memory-viewer`: 16/16.
- Full suite: **3081 pass, 0 fail, escapes 0.**
- `npm run build:web` re-run; `renderer/web/plugin-registry.js` and
  `web-dist/index.html` regenerated.

**Flake worth knowing about, not mine.** The first full-suite run failed one
test — `_injectRoster: rides PASSIVELY (parked for organic drain…)`,
session-manager.test.js:1914, `0 !== 1`. It passes when that file runs alone and
the next clean full run was 3081/3081. It is in the t111 work sitting
uncommitted in the same tree (session-manager.js, cli-hooks.js, engine.js are
modified by that task, not by this one), so it is order-dependent, not caused by
the plugin — but it is real and it did fail once.
