# git-branches — install and verify

Confirms the five things that stub harnesses cannot reach. Assumes the app is
running and you have at least one local session whose `cwd` is a git repo.

**On ordering.** You asked for the five in the order you listed them. Two of them
cannot be checked in that order: `cls` and stylesheet scoping are only observable
once a badge has actually painted, and on a cold cache the *only* thing that can
paint it is `requestRelayout`. So relayout is checked first, as the prerequisite
it is. Original numbering is carried in brackets.

Every step names what failure looks like. None of them are softened — if a step
fails, that is the point.

---

## 0. Install

**Do:** copy this directory to `<repo>/plugins/git-branches/`, then restart the app.
**Observable:** menu bar shows **Plugins ▸ Git Branches** with a tick.
**If not:** no `Plugins` menu at all → `CLODEX_PLUGINS=0` is set in the environment. Menu present but the entry shows an error → open **Plugins ▸ Manage Plugins…**; the refusal reason is printed under the directory name. Entry present, unticked → tick it.

---

## 1. [was #5] `requestRelayout()` actually causes a re-render

This is the load-bearing one: without it, `rowBadge` cannot ever show data that
took I/O to fetch, and §6.4's documented cache-then-relayout idiom does not work.

**Do:** after the restart in step 0, look at the sidebar and **touch nothing** — no clicks, no hover, no resize, no session switching — for 15 seconds.
**Observable:** a branch chip appears on the git-repo session's row on its own, within about a second.
**If not:** if the row stays bare until you click another session, resize the window, or create a session, then `requestRelayout()` is not triggering a pass and the badge is only riding on renders caused by something else. That is a doc/core finding, not a plugin bug — on the first pass `resolve()` has an empty cache and correctly returns `null` for every row, exactly as §6.4 prescribes.

---

## 2. [was #2] `cls` becomes a CSS class on the chip

**Do:** in a second git session, run `git checkout --detach` and wait one refresh (≤10 s). You now have one normal-branch chip and one detached chip on screen.
**Observable:** both chips are monospace and slightly dimmed against the row label; the detached one is *italic* and shows a 7-character sha rather than a name.
**If not:** if the text is right but the styling is absent on both, `cls` is not reaching the DOM as a class name — §6.4 names the field but never says what it is (§6.1's equivalent is `accentClass` and *is* explained).

**Then confirm precisely, in DevTools:** inspect the chip element and read its class list.

- `gb-branch` present → as documented-by-analogy, and my `style.css` matches.
- `git-branches:gb-branch`, or any prefixed form → **finding**: the host namespaces `cls` the way §6 says it namespaces slot `id`s, but §6.4 never says so, so every plugin's `style.css` selector will silently fail to match. My CSS would need the prefix.
- class absent, text present → `cls` is accepted and discarded.

---

## 3. [was #3] Whether `style.css` is scoped for the plugin

**Do:** in the window's DevTools console, run:

```js
[...document.querySelectorAll('style')].filter(s => s.textContent.includes('gb-branch')).map(s => s.textContent.slice(0, 220))
```

**Observable:** exactly one match, and its rules read verbatim as written — `.gb-branch, .gb-unborn, .gb-detached { … }`.
**If not:** if the selectors come back rewritten or wrapped (e.g. `[data-plugin="git-branches"] .gb-branch`), the host scopes plugin CSS — which is good, but is stated nowhere in §1, §2 or §6, and means any plugin styling something outside its own container fails silently. Zero matches → the `style` manifest field did not load at all; check **Manage Plugins…** for a path refusal (§2 forbids paths escaping the plugin directory).

---

## 4. [was #1] The verb replies, proving `handler(handle, intent)`

**Grant it first — it does nothing until you do.** In the **per-seat intent
checklist**, grant the verb `branch` for the seat you are about to test (it is
listed as **"Report git branch"**). §7 forces every plugin verb to be privileged:
off for every seat until explicitly granted.

**If you skip the grant, the failure is total silence** — the agent's
`[agent:branch]` line produces no reply, no toast, no error, and **nothing in the
app log under `plugin:git-branches`**, because the handler is never called at all.
Silence here means "not granted", not "plugin broken". That is the one failure in
this document with no observable of its own, which is why it is called out.

**Do:** in a granted session whose `cwd` is a git repo, have the agent emit exactly:

```
[agent:branch]
```

**Observable:** on the agent's **next turn** it receives `[git-branches] branch: <name>`, and `<name>` matches the chip on that session's row.
**If not:**
- Reply names a *different* session → the first argument is not the emitting session's handle.
- App log shows `[agent:branch] fired without a usable session handle` → the first argument is not a `SessionHandle`; tell me its shape and I will rewire again.
- Nothing at all, and the verb *is* granted → `parse` is not matching; confirm the line was emitted bare on its own line.

Worth also doing once in a **non-repo** session (expect `not a git repository`) and once in a **remote** session (expect `not available for remote sessions`) — those two paths run through `fsScope`, which is the guard that keeps a plugin off a peer machine's filesystem.

---

## 5. [was #4] Once per line, or once per input feed

**Settled in source since this was written** — PTY line-scanning is gated to bash
sessions and agent intents arrive only via the JSONL turn-text path, so the two
feeds are mutually exclusive per session: one matched line, one handler call.
This step is now a cheap confirmation that the observable matches the source,
not an open question. Still worth doing, because `inject()` is not idempotent and
this is the only step where a wrong answer would silently double every reply.

**Do:** in the granted session from step 4, emit `[agent:branch]` **once**. Count the `[git-branches] branch: …` lines that come back on the next turn.
**Observable:** exactly one.
**If not:** two or more means dispatch is per-feed, not per-line, and §7's "your verb is live on every input feed at once" describes dispatch rather than registration. **Tell me the count** — it is the number of live feeds, and it changes the code: I would need a per-emission identifier to deduplicate correctly (see the answer in my reply, and NOTES.md ▸ Missing #5). Session identity does not help here; it cannot distinguish one line delivered twice from an agent legitimately asking twice.

---

## 6. Three quick ones from the original brief

- **Two windows:** open a second workspace window with a git session. Both windows show correct chips at the same time, and each was filled by its own renderer activation.
- **Disable cleanly:** untick **Plugins ▸ Git Branches** with both windows open. Every chip disappears from both immediately, the **Preferences ▸ Git Branches** section is gone, and no error appears in either window's console over the following minute (a leaked timer would surface as a failed `invoke`).
- **Re-enable live:** tick it again without restarting. Chips come back in both windows within one refresh interval, and the log shows `plugin:git-branches activated` exactly once.

---

## Reporting back

For anything that fails, the useful payload is: the step number, the observable
you actually got, and — for steps 2 and 4 — the DevTools class list or the log
line verbatim. Steps 2, 3 and 5 failing are findings against the document.
Steps 1, 4 and 6 failing are findings against my code.
