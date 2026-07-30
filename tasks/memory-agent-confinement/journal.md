# t114 — path confinement at the library stores

## The class, not the site

Filed as "core's memory delete has no path confinement." That framing is one
site short, the same way my last three specs were. The actual defect class:

**Confinement is attached to VERBS, not to the path-building choke point.**

Every store here has a `_file(name)` / `_dir(name)` helper that joins a
caller-supplied segment onto a Clodex-owned root. That helper is the only place
a name becomes a path. Guards instead live on individual verbs, so each verb
added later is an independent chance to forget one — and several did.

Two variants of the same defect:

- `stores.js` libraries: guard on the WRITE path only. `save()` tests a regex;
  `raw()` and `remove()` test nothing.
- `memory-store.js`: guards on every verb, but the regex itself
  (`MEMORY_AGENT_RE`, `memory-store.js:21`) admits `.` and `..`, so the
  coverage is uniform and the check is weak.

## Sites (starting set — CLOSE IT, do not trust it)

This list is what I found by grepping `path.join(<ROOT>, <variable>)`. My specs
have named such a set one member short three tasks running. **First step of
this task is to complete the enumeration**, and report what I missed.

`stores.js`, unguarded read + delete, guarded write:

| store | choke point | guarded | unguarded |
|---|---|---|---|
| agentLibrary | `_file` :821 | `save` :860 | `raw` :857, `remove` :866 |
| skillLibrary | `_file` :872 | `save` :896 | `raw` :892, `remove` :902 |
| execLibrary  | `_file` :908 | `save` :934 | `raw` :930, `remove` :940 |

`stores.js` others to check (I did not chase these): `templates._file` :546 and
its `_read`/`remove` callers; `promptLibrary._dir(kind)` :694 / `_file(kind,
stem)` :695 — note `kind` is a SECOND caller-supplied segment and the guard at
:720 covers only `stem`.

`memory-store.js`: `_dir(agent)` :50, `_file(agent, id)` :51. Every verb tests
`MEMORY_AGENT_RE` (:53, :75, :99, :112) — the regex is the weak part, not the
coverage. `MEMORY_ID_RE` on the id segment is separate; check it independently.

`engine.js`, different provenance — segment is a SESSION name, not a library
name. **Establish provenance before changing anything here**; if session names
are already validated at every entry point that reaches these, say so and leave
them alone rather than adding a redundant guard:

- :331 / :346 — `path.join(SKILL_PLUGINS_DIR, name)` then
  `fs.rmSync(dir, { recursive: true, force: true })`. Highest blast radius on
  this page: recursive delete, not a single unlink.
- :600 — `path.join(MSG_DIR, recipient)`. Carries a comment ASSERTING the name
  is already constrained. That assertion is exactly the kind of cross-module
  claim that can be false without anything failing; verify it or delete it.

I could not find a name check in `session-manager.js create()` (:599) — that is
a negative result from one look, not a conclusion. Confirm it.

## Fix

Positive containment, at the choke point, once per store:

```js
const dir = path.resolve(ROOT, name);
if (path.dirname(dir) !== path.resolve(ROOT)) return null; // or throw
```

Model it on `plugins/memory-viewer/engine.js` `agentDir()` — it is currently the
ONLY correct guard on this surface, and it is in a PLUGIN guarding CORE. That
inversion is the thing this ticket exists to fix.

Positive, not blacklist: reject anything that does not resolve to a direct child
of the root, rather than hunting for `..` or separators. A blacklist has to
anticipate; `path.dirname` comparison does not.

Keep the regex as a cheap first test where it exists — it gives a better error
message and rejects control characters. It is no longer load-bearing for
containment. Do NOT widen it.

Failure mode per verb, and be deliberate: `raw()` returns null on a bad name
(matches its existing catch behaviour). `remove()` currently swallows errors and
returns `this.list()` — decide whether a rejected name should stay silent or
throw, and say which you chose and why. Silent is defensible for a delete that
already swallows ENOENT; what is NOT defensible is a rejected name being
indistinguishable from a successful delete when a CALLER needs to know.
`host.library.remove` is now a published seam with an `{ ok, error }` envelope —
whatever you choose must give that seam a truthful answer.

## Do not

- Do not weaken `plugins/memory-viewer/engine.js` `agentDir()` or delete its
  traversal test once core is fixed. Two guards on this path is correct: the
  plugin cannot assume core's behaviour, and the test documents the property.
- Do not touch `HOST_API_VERSION` — this changes no published shape.
- Do not commit. Leave the tree dirty; I split and land it.

## Severity, honestly

Not a remote attack surface. Every caller is local IPC or an in-process
plugin, on a machine the user already owns. What raises it above theory:
`host.library.remove` now publishes a delete seam to plugin code, so
"caller-supplied name" stopped meaning "name our own renderer built." And the
`engine.js:331` shape is recursive delete, where the cost of being wrong is not
disclosure but data loss.

Size the work accordingly — this is a correctness fix at a choke point, not a
security rewrite. If it starts sprawling, stop and report the boundary.

## Tests

One traversal test per fixed choke point, asserting the name is REFUSED rather
than that some file survived — a test that checks "the outside file still
exists" passes when the store is simply broken. Assert on the return value or
the thrown error.

Include a test that a LEGITIMATE name containing a dot still works
(`my.agent`, `foo.bar`) — the regex permits dots for a reason and a
containment fix that also bans them is a regression that no traversal test
would catch.

## Journal

Write findings here as they land, not at the end.

### Phase 1 — enumeration closed (what the starting set missed)

Method: `path.join(<CONST>, <variable>)` across all non-test, non-plugin `.js`,
then read every hit and classify by whether the variable is caller-supplied and
whether anything positively confines it. The starting set was accurate as far
as it went. It missed three things, one of which is worse than the ticket.

**FINDING 1 — `engine.js:331` is the worst site on this page, and its
provenance assertion is false.** The spec asked me to establish provenance
before touching it: "if session names are already validated at every entry
point that reaches these, say so and leave them alone." They ARE validated, at
every entry point I can find — and it does not help, because every one of those
checks is the same charset regex that admits `.` and `..`:

| entry point | check |
|---|---|
| `renderer.js:1827`, `:1904`, `:2095`; `library-drawers.js` ×4 | `/^[a-zA-Z0-9._-]{1,64}$/` |
| `remote.js` ×16 (`NAME_RE`) | same |
| `cli/src/verbs.js:591`, `cli/src/attach.js:224` | same |
| `session-manager.js:2688` (`[agent:dm]`-adjacent), `:3664` | `AGENT_NAME_RE`, same |
| `ipc-handlers.js` `spawnFromParams` → `manager.create()` | **no name check at all** — only a live/persisted CONFLICT check |

So the provenance claim is "validated everywhere", the reality is "filtered
everywhere, confined nowhere", and `create()` itself — the function that
actually spawns — validates nothing. A session named `..` is accepted by the
charset filter at every gate above, and then on spawn:

```
writeSkillPlugin('..')  →  path.join(REGISTRY_DIR + '/skill-plugins', '..')
                        →  ~/.clodex
                        →  fs.rmSync(dir, { recursive: true, force: true })
```

That is a recursive delete of the entire Clodex control plane — sessions,
libraries, memories, registry, pending mail — from a name typed into the New
Session dialog. `cleanupSkillPlugin('..')` (`:346`) is the same call on the
teardown path. Verified the path arithmetic (`node -e path.join`), not the
deletion: I am not running an rmSync against a real `~/.clodex` to prove it,
and I do not think the spec wants me to.

I am treating this as IN scope. It is the same defect, the same fix shape, and
the ticket's own severity note already singles this site out as "recursive
delete, where the cost of being wrong is not disclosure but data loss." Flagging
rather than absorbing, per the rule: it is a scope call, and it is yours to
reverse.

**FINDING 2 — `stores.js` `templates`, unguarded on BOTH write and delete.**
Not in the starting table (which listed templates only as "to check").
`_file(name)` `:546`; `save()` `:576` writes via `_write(template.name, …)`
with no regex; `saveByName()` `:590` the same; `remove(id)` `:604` unlinks with
no regex. The renderer checks the charset at `renderer.js:1827` — renderer-side
only, and again a charset filter. So templates is strictly weaker than the
agent/skill/exec trio, which at least guard `save`.

**FINDING 3 — `promptLibrary._dir(kind)` is guarded by an allow-LIST, not a
regex, and that is correct.** `save()` `:719` tests
`PROMPT_KINDS.includes(kind)` — a closed set, so `kind` cannot traverse on the
write path. `raw()`/`remove()`/`list()` still take `kind` unchecked, so the
second segment is unconfined on read and delete even though `stem` is checked
on write. Both segments need the treatment.

Sites deliberately NOT touched, with reasons:

- `engine.js:600` (`path.join(MSG_DIR, recipient)`) — the comment asserting
  "names are already constrained to [a-zA-Z0-9._-], safe as a path" is true
  about the charset and wrong about the conclusion, same as Finding 1. But this
  one only ever `ensureDir`s and writes a `msg-*.txt`; worst case is a stray
  file one level up, not a delete. Fixing it belongs with the session-name
  confinement, not with the library stores. **The comment is false as written
  and I am correcting it in place** rather than deleting it (a deleted guardrail
  note is the thing we agreed never to just delete).
- `pending-store.js` `agentDir(root, name)`, `peer-outbox.js` `originDir` —
  outbox already has the ONLY correct dot-check in the codebase
  (`origin !== '.' && origin !== '..'`, `:33`), pending-store has none but is
  fed exclusively from session names. Same class as Finding 1; same fix seam.
- `team-manifest.js:113/206`, `sandbox.js:488`, `session-discovery.js`,
  `plugin-loader.js`, `host-stamp.js`, `web-host.js` — segments are either
  read back from a directory listing (`readdirSync` output cannot traverse) or
  already sanitized (`sanitizeBasename`). No action.

### Boundary call

The ticket says "if it starts sprawling, stop and report the boundary." It
sprawls. Three separable pieces:

1. **The library stores** (`memory-store.js`, `stores.js` × 5 stores) —
   what the ticket describes. Self-contained, one helper, mechanical.
2. **Finding 1, session-name confinement** (`engine.js` skill-plugin dir, and
   by extension `pending-store`/`MSG_DIR`) — different provenance, different
   entry points, and the honest fix is at `create()`/the gates, not only at
   the join. Higher blast radius, wider test surface.
3. Everything else — no action needed.

I am doing (1) as specified and the `engine.js` half of (2), because a
recursive `rmSync` at the wrong root is not something to leave sitting while a
follow-up ticket is written. I am NOT rewriting the entry-point gates —
that is a real design question (does `create()` become the choke point? do all
sixteen `remote.js` sites change?) and it is above my pay grade to answer by
picking one.

*(clodex accepted this split as drawn and took (2a) in; entry-point gates,
`remote.js`, `pending-store.js` and `MSG_DIR` are filed separately.)*

### Phase 2 — implementation

**`path-confine.js`** (new, pure leaf — no electron, no I/O, `path` only; not
in the leak-scanner lists, same convention as `clodex-paths.js`).
`confine(root, name)` → the resolved child or null; `confineOrThrow(root, name,
label)` for callers that want it fatal. Positive check:
`path.dirname(path.resolve(root, name)) !== path.resolve(root)` → refuse.
No `realpath` — a sync stat per call on every list is real cost against a
threat that 0700 self-created roots don't have.

Choke points, one edit each:

| site | guard |
|---|---|
| `memory-store.js` `_dir` | `confine`, throws `invalid agent name` |
| `stores.js` agentLibrary/skillLibrary/execLibrary `_file` | `confineOrThrow` on `${name}.<ext>` |
| `stores.js` templates `_file` | `confineOrThrow` on `${name}.json` |
| `stores.js` promptLibrary `_dir` + `_file` | both segments |
| `engine.js` `writeSkillPlugin` | `confine`, THROWS (aborts the spawn) |
| `engine.js` `cleanupSkillPlugin` | `confine`, returns silently (teardown) |

**FINDING 4 — the suffix neutralizes a bare `..`, and a test using it would
have passed against no guard at all.** For every store whose choke point
confines `${name}.md` / `${name}.json` rather than the bare name,
`path.join(ROOT, '..' + '.md')` is `ROOT/...md` — a legal file *inside* the
root. So `..` is harmless at those sites and proves nothing. `../evil` and
`../..` still traverse. My first cut of the test used `['..', '../..']`
everywhere and four cases failed; the failure was in my vectors, not the
product. The suffixed stores now use a separate `SUFFIXED_ESCAPES` list with
the reason written next to it. Worth stating plainly: had I picked the
suffixed stores' vectors to match the memory store's, the tests would have been
green and empty.

I confine the SUFFIXED basename rather than the bare name for exactly this
reason — `${name}.json` is what becomes a path, so that is what must be checked.

### The `remove()` question clodex asked

**Yes, it did read as a successful delete, and no, it doesn't now.**

Before: `remove(name) { try { fs.unlinkSync(this._file(name)); } catch {} return this.list(); }`
— one catch over both the path build and the unlink. Once `_file()` throws on a
refused name, that catch would have swallowed the refusal too and returned
`this.list()`, i.e. **exactly what a successful delete returns**. Adding
containment without touching this would have converted a traversal into a
silent no-op reported as success — worse than before, because it looks handled.

The fix is to resolve the path OUTSIDE the try:

```js
const file = this._file(name);   // refused NAME propagates
try { fs.unlinkSync(file); } catch {}   // missing FILE stays silent
```

That preserves the property the swallow existed for — delete is idempotent,
ENOENT is not an error — while making a refusal loud. Pinned by the test
`stores: a REFUSED remove is distinguishable from a successful one`, which
asserts all three outcomes: real delete → emptied list, refused name → throws,
missing name → quiet.

Failure mode per verb, deliberately:

- **`raw()` → null.** Already its contract for anything unreadable, and its
  `_file()` call was already inside the try, so this needed no product change.
- **`remove()` / `save()` → throw.** A caller acting on a silent no-op is the
  bug this ticket is about. `host.library.remove`'s `{ ok, error }` envelope
  now gets a truthful answer.
- **`templates.save()` rename-cleanup unlink → still swallowed**, and that one
  is not a false green: `_write()` confines on the way in, so a name-illegal id
  can never name a file this store wrote. Commented in place.
- **`promptLibrary.list()` → empty, not throw.** It loops over kinds and skips
  unreadable ones; asserted so the asymmetry reads as a decision.

Five IPC handlers updated to catch (`templates:remove`, `prompts:remove`,
`agents:remove`, `skilllib:remove`, `exec:remove`) — a throw would otherwise
reject the invoke instead of returning the `{ ok: false, error }` these
surfaces use.

### Tests

`test/path-confine.test.js` (11) and `test/skill-plugin-confine.test.js` (3).

**FINDING 5 — a false green in my own first cut, worth recording because it is
the class we keep hitting.** Reverting `memory-store.js`'s `_dir` guard reddened
NOTHING. Cause: every public verb tests `MEMORY_AGENT_RE` first, and since t115
that regex rejects every name that could traverse (no `/`, no dot-only). So the
verb-level traversal cases were proving the REGEX and would pass with
`confine()` deleted outright. Fixed by testing `_dir` directly — the only case
that actually reaches the guard — and relabelling the verb-level cases as the
defence-in-depth layer they are. Both layers must refuse; each now has a case
that fails without it.

`skill-plugin-confine.test.js` is source-level, not behavioural, and says why:
`SKILL_PLUGINS_DIR` is module-scoped over the REAL `~/.clodex` with no
injection seam, and both functions are module-private. A behavioural traversal
test there would be safe only while the guard works — **the first person to
mutation-check it by reverting the product would delete their own home
directory.** So it pins what can only be established there (each destructive
call site is guarded; the guard PRECEDES the rmSync; the raw join is gone, not
merely supplemented), and `confine()` itself is proven behaviourally against a
temp root in the other file.

One test-authoring note: the corrected `engine.js:600` comment quotes the false
phrase in order to negate it, so a bare `doesNotMatch(/safe as a path/)` failed
on the fix itself. The assertion tests the claim, not the substring.

### Mutation verification

Baseline 14 pass across both files. Each product edit reverted individually:

| reverted | result |
|---|---|
| `memory-store.js` `_dir` guard | 13 / **1 fail** |
| `stores.js` `agentLibrary._file` | 12 / **2 fail** |
| `stores.js` `promptLibrary._dir` | 13 / **1 fail** |
| `remove()` swallow-fix (path back inside the try) | 12 / **2 fail** |
| `engine.js` `writeSkillPlugin` guard | 12 / **2 fail** |
| `confine()` → blacklist that only catches `'..'` | 8 / **5 fail** |
| `confine()` → over-eager, bans any dot | 7 / **6 fail** |

The last two matter most: the blacklist mutant is the wrong fix that passes a
naive traversal test, and the over-eager mutant is the wrong fix that passes
every traversal test while breaking `my.agent`. Both redden.

### State

Full suite **3152 pass / 0 fail / escapes 0** (baseline 3138, +14). Not
committed. `engine.js:600` comment corrected in place, not deleted.
