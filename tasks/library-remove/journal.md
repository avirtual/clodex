# library-remove — a delete path for library files, and the memory-viewer's delete button

> Read the ticket id off `[agent:task list]`. This directory's name is not an
> id and carries no number on purpose: artifact names and ticket ids are
> separate sequences and have drifted before.

The memory viewer is read-only. Bogdan asked for a delete button with a
confirmation. The interesting half is not the button — it is deciding what
core lends a plugin so the button can exist without becoming the first of four
subtly wrong deletion paths.

## The decision, already made — do not redesign it

**Generic in shape, per-kind in implementation.**

```js
host.library.remove(kind, ref)   // kind: 'memory', ref: { agent, id }
```

Core owns a `kind -> handler` table. **A kind with no registered handler is
refused.** Only `memory` is registered by this task.

The rejected alternative was a path- or `(kind, id)`-based unlink under
`~/.clodex/library/`. It is rejected because the four kinds do not mean the
same thing when deleted, and three of the four break *silently*:

| kind | files | what deletion breaks |
|---|---|---|
| `memory/` | 375 | live agents keep serving a stale `run/<name>/hook-digest.json` unless the digest is rewritten |
| `prompts/` | 14 | referenced BY NAME in `prompt-rails.js:33` `NON_SESSION_STOCK` — a rename or removal silently drops it from the picker rule |
| `templates/` | 5 | referenced by name in `team.json` `role.template`; deleting one makes `[agent:spawn template:X]` bounce |
| `exec/` | 8 | named in every seat's system prompt; the seat learns it is gone by running it |

A uniform unlink makes it equally easy to do the wrong thing for all four. The
refusal is the load-bearing part of this design: it forces whoever adds the
next kind to answer "what else has to happen when this file goes away?" — which
for `memory` is a digest rewrite, and is not optional.

This also satisfies the documented `host.lib` membership rule
(`plugins/plugin-api.md:630`: *a utility that core also uses may be lent*).
Requirement (2) below is what makes that true rather than aspirational.

Scope note: `remove` only. No rename, no write, no create. `host.library` is a
namespace with exactly one member when this task lands.

## Commit 1 — the core seam

### (1) One implementation, shared with the intent

`session-manager.js:2642` already deletes a memory unit for the
`[agent:memory forget]` intent: `memoryStore.forget()` then `refreshDigest()`.
The plugin path must not be a second copy of that pair.

Extract it into one method on SessionManager — name it something plain like
`removeMemoryUnit(agent, id)` — and have the `forget` branch call it. The
branch keeps its own ack and error text; only the delete-and-refresh moves.

The method must do three things:

- `memoryStore.forget(agent, id)`. Both arguments are already validated inside
  `forget` (`memory-store.js:111-116`, `MEMORY_AGENT_RE` / `MEMORY_ID_RE`) and
  it throws on a bad one. Do not add a second validation layer with different
  rules; let it throw and convert at the boundary.
- Rewrite the digest **only when a live session of that name exists**. Memories
  outlive sessions, so the plugin can delete a dead agent's unit;
  `writeClaudeDigestFile` calls `ensureDir(runDirFor(...))` (`cli-hooks.js:32`),
  so calling it for a dead agent would recreate that agent's run directory as a
  side effect of a delete. The spawn path already rewrites the digest
  (`session-manager.js:1341`), so a dead agent loses nothing.
- When there is a live session and it is `agentType === 'claude'`, assign the
  return value to `session.digestNonEmpty`, exactly as `:2595` does. This flag
  is not cosmetic: `:2550` calls `markDigested` when it is true, so a store
  emptied to zero while the flag stays true marks a conversation as digested
  when it never received one, and units saved later never reach it.

Return a plain result, not a throw, at the method boundary — the plugin seam
needs `{ ok: false, error }` and the intent needs a message; pick one shape and
convert once.

### (2) The host surface

`host.library` is new in `plugin-host-engine.js:214` (the frozen façade). It is
**additive**, so `HOST_API_VERSION` stays `"1"` — do not touch it.

`plugin-host-engine.js` must stay ignorant of what a memory is. Inject the
handler table from `engine.js:1235` alongside the other seams:

```js
libraryKinds: { memory: (ref) => manager.removeMemoryUnit(ref.agent, ref.id) },
```

The engine's `remove(kind, ref)` then:

- refuses an unregistered or non-string `kind` with a distinguishable error
  (not the same string as a failed delete — a plugin asking for a kind that
  does not exist is a different bug from a file that would not unlink);
- refuses a `ref` that is not an object;
- forwards, never interprets. The engine must not know that `memory` refs carry
  `agent` and `id`; per-kind ref validation belongs to the handler.

Wrap the table the same way `libGitWorktree` is wrapped at
`plugin-host-engine.js:37` and for the same recorded reason: freezing the
façade leaves an injected live object writable, so a plugin could repoint
core's own call. Derive from the table's keys; do not hardcode `['memory']` in
two places.

Deletion stays **permanent** — `forget` is `unlinkSync`. No archive tier, no
trash directory. A confirmation the user actually reads is the safeguard;
a second recovery mechanism nobody exercises is not.

### (3) Tests and pins

- `test/plugin-surface-contract.test.js:35` — the `HOST_CONTRACT` table is
  literal by design (its header says a generated table cannot fail). Add the
  `library` row with `members: ['remove']`, and pin it frozen.
- `plugins/plugin-api.md` — a `### host.library` subsection in §4, placed near
  `host.lib`, stating the kind table, the refusal, and that unregistered kinds
  are refused rather than falling back to a path unlink. `§13 What is
  deliberately not exposed` currently says a plugin cannot reach Clodex's
  persistence stores *including the library*. That sentence becomes wrong when
  this lands — amend it to name the one narrow exception rather than leaving a
  reader to discover the contradiction. `test/plugin-api-doc-snippets.test.js`
  and the surface-contract doc check both read this file; run them.
- `test/plugin-host-engine.test.js` — refusal of an unregistered kind, refusal
  of a bad ref, a successful forward, and that the returned table members
  cannot be reassigned.
- `test/memory-store.test.js` or a session-manager test — that the shared
  method rewrites the digest for a live claude session and does **not** for a
  dead agent (assert the run directory was not created; that is the observable
  half of the `ensureDir` reasoning above).
- `test/free-identifier-leaks.test.js` — `plugin-host-engine.js` is at `:75`
  and `session-manager.js` at `:30`, both already scanned. No list edit needed,
  but the reverse scan will catch a name that moved; run the suite.

**Commit 1 goes through `[agent:team-review]` before commit 2 starts.**

## Commit 2 — the plugin UI

`plugins/memory-viewer/` — engine half `engine.js`, renderer half
`renderer.js`, styles `style.css`, plus `README.md`.

- Engine: one new `host.ipc.handle('forget', ...)` that validates the agent
  through the existing `agentDir()` (`engine.js:74` — the sanctioned
  string-to-path conversion; its comment explains why the regex alone is not
  the containment check) and then calls `host.library.remove('memory', { agent, id })`.
  Return `{ ok }` / `{ ok: false, error }`.
- The engine's header comment currently says *"Read-only: no write path exists
  here on purpose"* with a pointer to the t110 one-consumer-first rationale.
  That is now false. Rewrite it to say what is true: exactly one mutation, and
  it goes through core's seam rather than unlinking the file this module can
  plainly see — which is the whole reason the seam exists.
- Renderer: a delete control on each unit card in `renderUnits`
  (`renderer.js:95`). Confirmation via `confirm()` — the same primitive
  `renderer/renderer.js:382` and `plugins/workbench/renderer.js:592` use; do
  not build a custom modal for this.
- **The confirmation must show the unit's body and its pinned state**, not just
  the id. `mem-1785440884251-q4d5j2` is unidentifiable; confirming it is
  confirming a string. Truncate a long body, and say plainly that this cannot
  be undone. If the unit is pinned, say so — a pinned unit is a settled
  position some session is relying on.
- On success, remove the card without a full refetch, or refetch the agent —
  either is fine, but the agent list's counts (`renderer.js:155`) must not be
  left stale. The overlay's stated freshness bound is "as of open"; a delete
  that leaves a wrong count on screen breaks it.
- `npm run build:web` after touching a plugin renderer —
  `renderer/web/plugin-registry.js:41` is generated and
  `test/plugin-web-parity.test.js` fails if the committed file drifts.
- README: the plugin currently advertises itself as read-only. Fix it.

## Non-goals

- No other kinds. Not `prompts`, not `templates`, not `exec` — each needs its
  own answer to "what breaks", and none is asked for.
- No bulk delete, no multi-select.
- No undo, archive or trash.
- No change to `HOST_API_VERSION`.
- Nothing in `renderer/plugin-host.js` — the renderer half reaches this through
  `rhost.invoke`, like every other plugin data call.

## Verification

`npm test` (`node scripts/run-tests.js`, NOT `node --test`). Baseline before
this task: **3099 pass, 0 fail, escapes 0.**

Journal as you go: this file is what a replacement reads if you are lost.
Flag deviations rather than silently absorbing them — the spec above names
call sites, and a spec that names call sites has been wrong about the set
twice in the last two tasks.

## Journal

### hand — commit 1 (core seam), done, awaiting cold review

Suite **3107 pass / 0 fail / escapes 0** via `npm test` (baseline 3099, +8).
`node --check` clean on session-manager.js, plugin-host-engine.js, engine.js.
Nothing committed; commit 2 not started.

**What changed**

- `session-manager.js` — new `removeMemoryUnit(agent, id)` above
  `_handleMemoryIntent`. Calls `memoryStore.forget` (no second validation
  layer), rewrites the digest only for a live `agentType === 'claude'` session,
  assigns `session.digestNonEmpty` from the return value, returns
  `{ ok }` / `{ ok: false, error }`. The `forget` branch is now four lines and
  a caller; it keeps its own ack and error text.
- `plugin-host-engine.js` — `libraryKinds` dep, a `libraryHandlers` bound-wrapper
  freeze modelled on `libGitWorktree`, and `host.library.remove(kind, ref)`
  refusing unregistered/non-string kinds with a distinguishable error, refusing
  non-object refs, forwarding without interpreting, converting a handler throw
  to an envelope. `HOST_API_VERSION` untouched.
- `engine.js:1242` — `libraryKinds: { memory: (ref) => manager.removeMemoryUnit(ref.agent, ref.id) }`.
- `plugins/plugin-api.md` — new `### host.library` in §4 before `host.telemetry`;
  §13's persistence-stores bullet amended to name the one exception.
- `test/plugin-surface-contract.test.js:35` — `library` row, `members: ['remove']`.
- `test/plugin-host-engine.test.js` — `makeHost` gained a `libraryKinds` hook and
  a `removals` log; four new cases (forward, kind refusal, ref refusal + throw
  conversion, table-repointing refusal).
- `test/session-manager.test.js` — `mkRemover` harness wiring the REAL
  `writeClaudeDigestFile` on a temp REGISTRY_DIR, plus four cases.

**DEVIATION 1 — the spec's call-site set was one short (same class as the last
two tasks).** The spec names `test/plugin-surface-contract.test.js:35` as the
pin to update. There is a SECOND full-surface pin:
`test/plugin-host-engine.test.js:455`, "the host deliberately exposes no
stores, manager, or transport seams", which `deepEqual`s the sorted key list of
`host`. Adding `library` failed it. That is the pin behaving exactly as its
comment says it should ("a new key is a one-way door, so it should cost a
deliberate edit here"), so I made the deliberate edit rather than routing
around it. Both pins now carry `library`. Nothing else in the tree pins the
surface — I checked for other `Object.keys(host)` assertions.

**DEVIATION 2 — digest side effect asserted through the real function, not a
stub.** The spec asks the dead-agent test to "assert the run directory was not
created". A stubbed `writeClaudeDigestFile` cannot show that: the `ensureDir` is
inside the real one. So `mkRemover` constructs real `createCliHooks` against a
temp `REGISTRY_DIR` and the tests assert on `fsReal.existsSync(runDirFor(...))`.
More setup than a stub, but it pins the actual property; a stub would have
pinned the call and passed even if `ensureDir` moved.

**Judgement call flagged.** `removeMemoryUnit` wraps the digest rewrite in
`try/catch` (`/* best-effort */`), matching `_rebakeDigest:1341`. The spec does
not say. Consequence: a digest write that fails leaves the unit deleted and
returns `{ ok: true }` — the delete succeeded, which is what the caller asked
about, and the digest is regenerated on next spawn. Say so if you want the
failure surfaced instead.

**Not done, deliberately:** `session.digestNonEmpty` is only assigned for
claude sessions, so a codex session's flag is untouched — the pre-existing
`refreshDigest` behaviour at what is now :2621. I did not extend it.

### lead verdict on the above (settled — do not re-open)

Both deviations upheld. The try/catch stays best-effort as written, and the
reason is worth keeping because it is not obvious from the code: returning
`{ ok: false }` after a successful unlink would be a lie in the direction that
provokes a retry, and the retry fails with "no unit", which reads as a bug in
the delete path. The digest failure is self-healing (regenerated on next
spawn); the delete is permanent and is not.

The stale-flag interaction is safe for a specific reason: if the write throws,
`hook-digest.json` keeps its OLD contents, so a `digestNonEmpty` left `true`
still describes a digest that exists — flag and file stay consistent through
the failure. That is why this catch is safe while `:2595` had to be an
assignment.

Claude-only `digestNonEmpty` confirmed right: codex has no digest path to keep
consistent.

Commit 1 is in cold review. Commit 2 does not start until the verdict lands.

### hand — commit 1, nit pass (all seven taken)

Cold review: ACCEPT, zero must-fixes, seven nits, all applied. Suite
**3110 pass / 0 fail / escapes 0** (baseline 3107, +3).

- **NIT-1** — new session-manager case: forget succeeds, then the digest write
  throws. Asserts `{ ok: true }`, the unit really deleted, `digestNonEmpty`
  left as it was. `mkRemover` gained a `digestThrows` option. Verified by
  applying the reviewer's named edit (hoist the try/catch to wrap the method
  body): the new case goes red, and it was the only one.
- **NIT-2** — cut the memory-viewer clause from `plugin-api.md`; it is false
  until commit 2. Re-add it with commit 2's doc edit.
- **NIT-3** — `!session._dead` added at what is now :2609.
- **NIT-4** — envelope rebuilt on the way out (`{ ok: true }` /
  `{ ok: false, error: String(...) }`). Comment says what it actually buys —
  no handler object crosses, contract enforced not observed — and does NOT
  claim it sanitizes the error, which still passes through. New engine case
  pins that extra handler fields do not cross and the object is not the
  handler's own.
- **NIT-5** — chose to REJECT a thenable rather than only document it.
- **NIT-6** — the freeze test now mutates `table.memory` after `register()` and
  asserts the repoint is not honoured. Verified by switching the wrappers to a
  call-time re-read (libGitWorktree's weaker shape): the case goes red.
- **NIT-7** — "a live *claude* session".

**Commit-1 note:** the lead asked for commit 1 to be committed. I do not
commit — standing instruction from Bogdan, who owns the commit train. The tree
is staged-ready and left for the lead. See the report for the suggested message.

**One thing found while writing NIT-5's test.** Refusing the promise is not
sufficient on its own: by the time `remove` sees it the async handler is
already running, so its rejection is unattached and takes the process down
under Node's default `--unhandled-rejections=throw`. The refusal now attaches
a no-op `.then(() => {}, () => {})` before returning. The test asserts no
unhandled rejection escapes, which is the half that would otherwise have been
a latent process-level failure rather than a returned error.

### hand — commit 2 (plugin UI), done, awaiting cold review

Suite **3115 pass / 0 fail / escapes 0** (baseline 3110, +5).
`verify.js plugins/memory-viewer` **16/16** — it picks up the new `forget` row
and exercises it. `npm run build:web` run; `web-dist/index.html` regenerated.
Note `renderer/web/plugin-registry.js` did NOT change — the registry lists
plugins, and this commit adds no plugin. `plugin-web-parity` is green.

- `plugins/memory-viewer/engine.js` — header rewritten (the read-only claim was
  false); one `forget` handler vetting the agent through `agentDir()` and
  calling `host.library.remove('memory', …)`.
- `plugins/memory-viewer/renderer.js` — `confirmText()` + `deleteUnit()`, a
  per-card delete control, `reload()` named so a delete refreshes the agent
  counts too. Subtitle no longer says "read-only".
- `plugins/memory-viewer/style.css` — `.mv-delete`, pushed to the far edge of
  the head row so it is not a mis-click on a scope or timestamp.
- `plugins/memory-viewer/README.md` — read-only section replaced by "Deleting".
- `plugins/plugin-api.md` — NIT-2 sentence re-added, now that it is true.
- `test/memory-viewer-plugin.test.js` — NEW, 5 cases through the real host.

**The pin that matters.** `the delete is the SEAM, not an unlink the plugin
does itself` asserts that when core REFUSES, the file is still on disk. A test
asserting only "the file is gone" passes for both the right implementation and
the wrong one, since the plugin holds a readable path to it. Verified by
replacing the seam call with `fs.unlinkSync` — three cases go red.

**Design note on the id.** The plugin vets the agent (renderer-supplied, and
`agentDir()` is this module's sanctioned string-to-path conversion) but
deliberately does NOT vet the unit id: `MEMORY_ID_RE` lives in core's store and
a second grammar here would drift. One test pins that the id reaches core
unmodified and core owns the refusal.

**Deviation flagged.** The delete control is `✕`, not a wastebasket glyph — the
repo's existing controls are plain text glyphs (`◈`, `×`) and an emoji would be
the only one in the UI. Cosmetic; say the word if you want it different.

**Selection is preserved across a delete**: `renderAgents` keeps `selected`
when the agent still exists, so deleting a unit does not bounce the user back
to the first agent. Deleting an agent's LAST unit leaves the agent row present
with count 0 (the directory survives), which is existing list behaviour, not
something this commit changed.
