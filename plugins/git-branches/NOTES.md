# git-branches — build notes against `plugin-api.md` (hostApi "1")

Kept while building. § references are to `plugin-api.md`.

> **Placement note.** The brief said "in `NOTES.md` beside the plugin" and also
> that everything I write must be inside `plugins/git-branches/` ("absolute").
> I treated the absolute constraint as binding and put this file inside the
> plugin directory. Move it up one level if that was the wrong read.

---

## The one finding that matters most — RESOLVED, and it inverted

**`plugin-api.md:739` documents the intent handler as `handler(intent, ctx)`. The
shipped signature is `handler(handle, intent)` — a full `SessionHandle` in first
position, the parsed intent second. There is no `ctx`.**

My original conclusion was that the emitting session's identity was *missing*
from the API and might require a core change. It was not missing. It was sitting
in the argument the document labels `intent`. The doc is not vague here, it is
wrong in a specific and expensive way: it names a parameter that does not exist,
and it puts the one that does exist in the wrong position. Confirmed by the
maintainer; a doc fix is dispatched. **No core change is needed.**

What this cost, and why it still surfaced correctly: reading only the contract, a
plugin author has no way to see the inversion. Trusting `intent` as the first
argument means calling `.match()` on a `SessionHandle` and getting nothing, or
worse, reading `.name` off a parsed intent that happens not to have one. The
reason this came out as a *question* rather than as a plugin that silently never
replied is that I validated every candidate identity through
`host.sessions.get()` — documented in §4 to return `null` for unknown names —
instead of trusting any shape I had inferred. Failing loudly on an unverifiable
assumption is what made the gap legible.

The code now takes `handle` directly: `handle.name` keys the cache,
`handle.inject()` carries the reply. The probing and the once-per-run key logging
have been removed — they were scaffolding for a gap that does not exist. The
handler still refuses to act on a first argument that is not a handle with a
string `name`, and logs when that happens, because that is the shape of the
failure if the signature ever moves again.

Filed below as **Misleading #1**, where it belongs.

---

## Assumed

Things the docs implied but never stated, that I had to decide.

1. **§6.4 `rowBadge.resolve` returns `{ text, tip?, cls? }` — what `cls` *is* is
   never stated.** §6.1's analogue on `statusBar.addAction` is named
   `accentClass` and is documented ("a CSS class name added to the button; define
   it in your `style.css`"); §6.4 renames it to `cls` and says nothing at all.
   Assumed it is the same thing: a CSS class name put on the chip element. If it
   is instead an enum of core-defined chip styles, my badges render unstyled (but
   still correct — the text is the payload, the class is only cosmetic).
2. **Whether `cls` accepts more than one class token is unstated.** I wanted
   `gb-branch gb-detached` (base + modifier). Since a space-separated list might
   equally be rejected, set as a single invalid token, or escaped as text (§6
   says everything supplied is "escaped by the host and inserted as text" — which
   would make a class name meaningless), I send exactly one token per state and
   duplicate the shared rules in `style.css`.
3. **Plugin CSS is not scoped for me.** §1 says `style.css` is "injected as a
   per-plugin `<style>`" and §2 that it is "loaded as **text** and injected per
   window" — neither states any wrapping or namespacing. §2 mentions the id
   "becomes … a CSS attribute selector" and §6.7 shows `data-plugin="<yourId>"`,
   but only on *overlay containers*. Assumed raw injection, so every selector in
   `style.css` is a single uniquely-prefixed `gb-*` class I put there myself, no
   element/descendant selectors and no `!important`. If the host does scope it,
   my selectors still work; the reverse would not have been true.
4. **`deactivate()` receives no arguments.** §1's signature is `deactivate?()`,
   bare. So `host` is captured at `activate()` into module scope.
5. **Engine-side timers are not cleaned up by the host.** §5 documents wrapped,
   auto-cleared timers on `rhost`; §4 has no equivalent on `host`, and §10 only
   promises unconditional teardown of "every dispatch method, intent row and
   session hook" — timers are not in that list. I designed around the assumption
   rather than on it: freshness is a TTL evaluated on demand, so the engine runs
   **no interval at all**. The only engine timers are sub-second one-shots from
   `onCreate`, and they are tracked in a `Set` and cleared in `deactivate()`.
6. **Re-enabling calls `activate()` again on the *same* module object.** §10 says
   "Node's module cache still holds your code", which implies this but never says
   it. If true and I had initialised state only at module scope, a disable →
   enable cycle would resurrect a stale cache and double-registered state.
   Every piece of engine module state is therefore reset at the top of
   `activate()`, not merely at declaration. (Tested; see below.)
7. **`requestRelayout()` takes no arguments**, and is safe to call repeatedly.
   §6.4 calls it "a debounced request for another render pass" and §5 lists it as
   a bare name — no signature, no debounce window. I coalesce my own calls into
   at most one per 120 ms so I am not relying on the host's unstated debounce.
8. **An intent `handler` is synchronous and its return value is ignored.** §7
   states neither. The neighbouring contracts point in opposite directions —
   §4 makes session hooks *explicitly* sync-by-contract and logs a violation for a
   returned promise, while §8 makes ipc handlers *explicitly* awaited — so silence
   in §7 is genuinely ambiguous. I chose the conservative reading: my handler
   starts async work, returns `undefined`, and expresses nothing through its
   return value. Correct under either interpretation.
9. **`SessionHandle.inject()` is how a plugin verb answers the emitting agent.**
   §7 never says how a verb "reports" anything back. `inject` (§4) is the only
   documented channel to a session's input, and its `parkable` default of `true`
   is exactly right here — an agent that just emitted an intent is mid-turn by
   definition, so the answer lands on its next turn instead of interrupting.
10. **§6.6 `collect()` does not coerce.** An `<input>` value is always a string
    and the returned patch is "shallow-merged" verbatim, so persisting would
    store `"10"`. I coerce and clamp in `collect()` myself, and clamp again
    engine-side on read, so a hand-edited settings file cannot produce a 0 ms
    poll.
11. **`git` is reachable from the engine process.** §4 says the engine is "plain
    Node" but never describes its environment. A GUI-launched app on macOS often
    has a minimal `PATH`, so I widen `PATH` with the usual install locations and
    classify a spawn `ENOENT` as a distinct, reportable state rather than as
    "not a repo".
12. **§10 step 3 completes before step 4** — engine `activate()` finishes before
    any window's renderer half activates. Stated as an ordered list, never as a
    guarantee. My renderer degrades safely if it is wrong (it just gets
    `'no such plugin method'` and retries on the next poll).

---

## Missing

Things the docs never mention that I needed.

1. ~~**The shape of `ctx` in `handler(intent, ctx)` (§7).**~~ **Withdrawn** — not
   a missing field but a wrong signature. Refiled as Misleading #1.
2. **Any notification that a session's branch — or its `cwd` — has changed.**
   §4 offers `onCreate` and `onExit` and nothing else. The brief said "refresh on
   the session lifecycle notifications the docs describe", and those two are the
   complete set — but neither fires when a user runs `git checkout`, which is the
   *only* event that actually changes this plugin's answer. Session lifecycle
   alone cannot keep a branch badge correct. Polling is the only available
   mechanism, so badge freshness is bounded by a poll interval rather than by
   when the data changed. A `cwd`-changed hook, or any filesystem-watch
   affordance, would remove the poll entirely.
3. **The element shape of `rhost.sessions.listWorkspace(id)` (§5).** It is
   documented as `-> Promise<[session, …]>` and `session` is never defined. §4
   defines the engine-side equivalent precisely (`{ name, type, cwd, workspaceId, … }`);
   the renderer side documents nothing. I avoided depending on it.
4. **No way to enumerate the rows the sidebar is currently showing.**
   `rowBadge.resolve` firing is the *only* signal that a row exists. So a badge
   cache can only ever be demand-driven, and every session's badge is
   structurally guaranteed to be blank on its first render pass. That is
   unavoidable, not a defect — but §6.4's idiom presents cache-then-relayout as
   if the cache could be pre-warmed, and it cannot.
5. **Whether `handler` fires once or once per input feed.** §7 says "your verb is
   live on every input feed at once" without saying whether that describes
   registration or dispatch. It matters here: my handler replies via `inject()`,
   which is not idempotent, so per-feed dispatch would duplicate.
   **Resolved by the maintainer from source: one matched line, one handler call**
   — the two feeds are mutually exclusive per session (PTY line-scanning is
   gated to bash sessions; agent intents arrive only via the JSONL turn-text
   path). The sentence describes registration, and a doc fix is dispatched. No
   dedup code, which is what shipped.

   Keeping the reasoning, because it generalises past this verb: a defence would
   have needed an identity for the **utterance**, not the **speaker**. Those are
   orthogonal, and `handle.name` — the obvious key — dedups the wrong axis: it
   cannot distinguish one line delivered twice from an agent legitimately asking
   twice, so it suppresses the second to fix the first. The rule the maintainer
   is taking into the contract: *any callback that can fire more than once per
   logical event, whose handler performs a non-idempotent side effect, needs
   either a multiplicity guarantee or an emission id.* §7 had neither.
9. **Whether a throwing `handler` is caught, and how far the blast radius
   reaches.** §7 specifies it for `parse` ("treated as no match") and says
   nothing for `handler`, where §4 and §6 both specify their equivalents.
   **Resolved: a throw becomes an `[agent:<verb>] error: …` bounce and cannot
   affect intent handling for other sessions.** I had guessed around this with a
   try/catch; knowing the real semantics I removed it, because a bounce reaches
   the agent that asked and a swallowed log line does not.
6. **Whether `deactivate()` may be async / is awaited** before the unconditional
   teardown in §10. Mine is synchronous.
7. **Whether the dispose functions returned by §6 slots are safe to call twice.**
   §5 explicitly grants this for `rhost.onDispose`'s disposer ("calling it twice
   is safe") and is silent for all seven slots. Because §5 also guarantees slot
   registrations are removed for me regardless, I chose not to call them at all
   in my teardown rather than find out.
8. **Any stated bound on how often `rowBadge.resolve` is called.** It is "inside
   the sidebar's render loop, once per row" — per what? I made `resolve` a pure
   map lookup so the answer cannot matter, but a plugin doing anything heavier
   would need to know.

---

## Misleading

Things the docs state that led me somewhere wrong.

1. **The intent handler's signature is documented backwards, with a parameter
   that does not exist.** `plugin-api.md:739` says `handler(intent, ctx)`; the
   shipped call is `handler(handle, intent)`. Confirmed by the maintainer, fix
   dispatched. Worst of the set, on three counts: it is the only one where the
   document is *wrong* rather than silent or ambiguous; the wrong value is a
   plausible-looking object, so the failure is quiet rather than a crash; and it
   is unreachable by reading — no amount of care with the contract alone
   surfaces it. It cost me a full defensive probe-and-validate mechanism, now
   deleted. See the resolved section at the top.
2. **§2 says the plugin id "becomes … an intent-verb namespace". It does not.**
   §7's own worked example registers `verb: 'review'` and parses
   `/^\[agent:review\s+(\S+)\]\s*(.*)/` — unprefixed — and §7 requires the verb
   "must not collide with a core verb **or another plugin's**", which is only
   meaningful if verbs share one global namespace. Those two statements cannot
   both be true. I wrote my parser against §2 first, for `[agent:git-branches:branch]`,
   and it would never have matched a single line. §2's row is correct about the
   id namespacing *dispatch methods* (§8, explicit) and *slot ids* (§6, explicit);
   verbs are the one item in that list that is **not** namespaced, and it is the
   one where getting it wrong produces silent total failure rather than an error.
3. **§6's opening paragraph states the id-prefixing rule backwards.** It says the
   host namespaces your `id` "before it reaches the DOM. You never write the
   prefix yourself, and you never see an unnamespaced id come back to you except
   where noted." The last clause is inverted — what you never see is a
   *namespaced* id. §6.5 says so plainly for the same mechanism ("The host
   namespaces `act` for the DOM and hands it back to `onPick` **unprefixed**, so
   you compare against the string you wrote"). As written, §6 tells you to
   compare against the prefixed form and §6.5 tells you the opposite.
4. **§4's stated remedy for the `onCreate` gap does not work.** It says: "if you
   need to know about pre-existing sessions, call `listAll()` at activation and
   reconcile" (echoed by §14). But §4's own header says that at activation time
   "there are no windows and (usually) no sessions yet" — so `listAll()` at
   activation returns nothing to reconcile *with*, and §14 separately says it is
   unspecified whether restored sessions fire `onCreate`. Follow the stated
   remedy and sessions restored at launch are reachable by **neither** route.
   The only thing that actually works is resolving on first demand, which the
   document never suggests. That is what this plugin does, and it is also why it
   works for sessions that were already running before it was enabled.
5. **§6.4's example returns a value its own spec does not allow.** The example
   body is `return cache.get(sessionName);` while the spec says
   `-> { text, tip?, cls? } | null`. A `Map` miss returns `undefined`, not `null`,
   and `undefined` is not one of the documented return values — and a miss is
   precisely the case the surrounding paragraph is about. Small, but it is the
   canonical snippet for the one slot that is *defined* by having a cold cache.
6. **§3 Law 2's pull triggers do not exist for the slot that most needs them.**
   Law 2's rule is "pull on window open, on surface open, and on reattach". A
   `rowBadge` has no open, no surface and no reattach — its only entry point is a
   synchronous `resolve` inside a render loop. So the one slot §6.4 explicitly
   says requires a cache is the one slot for which Law 2 names no applicable
   trigger. In practice the trigger has to be "on first resolve", which is a
   fourth case the law does not list.
7. *(Minor, cosmetic.)* The two "extra CSS class" fields are named `accentClass`
   (§6.1, §6.2) and `cls` (§6.4) for the same concept, and only the first is
   explained. Reading §6.4 in isolation gives you no way to know what to do with
   `cls`.

---

## Where I was forced to guess

**Now: nowhere.** The single guess — the intent handler's second argument — was
resolved by the maintainer and turned out to be a documentation error rather than
a gap. The guessing machinery is deleted; the handler reads the `SessionHandle`
it is actually given.

Worth keeping on the record, because it is the transferable part: the guess was
survivable only because it was *validated against something the document does
guarantee* (`host.sessions.get()` returning `null` for unknown names) rather than
trusted. An inferred shape that is checked against a documented invariant fails
loudly; one that is merely assumed fails silently and in both directions. Where a
gap forces inference, the question worth asking is not "what is the most likely
shape" but "what documented fact can disprove my inference".

Everything else is either documented, or an assumption listed above that I
*designed around* rather than *relied on* — the engine has no interval to leak
if assumption 5 is wrong, my CSS is self-scoped if assumption 3 is wrong, and a
wrong assumption 1 or 2 costs styling but never correctness.

---

## What I verified, and what I could not

Both halves were run against stub `host` / `rhost` objects built to the shapes in
§4 and §5, with real `git` repositories on disk.

Verified: branch resolution on a normal repo, detached HEAD, a repo with no
commits, a non-repo directory, a `remote` session, a session with no `cwd`, a
session whose `cwd` was deleted, and an unknown session; TTL caching and forced
refresh; settings clamping; that both session hooks return `undefined` rather
than a promise (§4's contract); intent parsing including the near-misses
(`[agent:branchy]`, another verb, mid-line); the intent handler on the real
`(handle, intent)` signature — right session replied to, default `parkable`,
every non-branch outcome, five degenerate first arguments (`undefined`, `null`,
`{}`, a bare string, `{name: 123}`) each injecting nothing without throwing, and
a session that exits mid-resolve; and disable → re-enable on the
cached module. Renderer-side: cold-cache render returning no badges without
blocking, ~57 µs for a five-row pass, four cache misses debounced into one
`invoke`, remote rows never round-tripping, coalesced relayout with no storm,
truncation and tips, two windows activating independently and staying correct
alongside each other, a vanished session being dropped, the settings form
round-tripping with coercion and clamping, teardown leaving zero live timers and
zero subsequent invokes, and the `'no such plugin method'` discriminator halting
the poll.

**Not verified — needs a real Clodex.** Four remain, and `VERIFY.md` beside this
file is the ordered script for confirming each: whether `cls` styles the chip;
whether `style.css` is scoped; whether `[agent:branch]` fires once or once per
feed; and whether `requestRelayout()` genuinely triggers a re-render (my stub
only counts the calls). The fifth — the handler signature — is settled.

**Before it will do anything visible:** §7 forces every plugin verb to be
privileged — "off for every seat unless the user has explicitly granted it".
`branch` must be granted in the per-seat intent checklist or the handler never
runs, and the failure mode is total silence with nothing in the log.
