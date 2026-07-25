# git-branches — install and verify

Assumes the app is running and you have at least one local session whose `cwd`
is a git repo.

**Read this first.** This file used to list five behaviours "no test harness
reaches". That conflated two different claims — *no harness reaches it* and *no
source read settles it* — and four of the five turned out to be answerable
without you. Those are now recorded below under **Settled by source**, with
file:line, and are not yours to check. What remains in the manual section is the
residue: things a running app genuinely shows and a source read cannot.

**Then the file was audited a second time**, because the first pass only checked
the five listed behaviours and took every other sentence as framing. It wasn't:
the surrounding prose was unrun prediction too, and three claims in it were
wrong — an ungranted verb was said to fail silently (it bounces), a re-enable was
said to log a line that does not exist, and a leaked timer was said to surface as
a console error (it cannot). All three told you to expect the wrong thing, which
is the failure mode that wastes a run you alone can perform.

So every sentence here now either cites a `file:line` or is marked **[unrun
prediction]**. Nothing is softened — if a step fails, that is the point — but you
should know which sentences have been checked and which are still guesses.

---

## 0. Install

**Do:** copy this directory to `<repo>/plugins/git-branches/`, then restart the app.
**Observable:** menu bar shows **Plugins ▸ Git Branches** with a tick.
**If not** — the branches below are settled by source, so they are diagnostics rather than guesses:

- **No `Plugins` menu at all.** Two causes, not one: `CLODEX_PLUGINS=0` in the environment, **or** no plugins and no problem directories found on disk. `app-menus.js:342-352` returns `null` in both cases and the caller splices nothing in, deliberately — "an empty Plugins menu is worse than no menu". So an absent menu can mean the copy in step 0 did not land where the app looks, not only that the kill switch is on.
- **The directory was refused.** It appears in the menu as a disabled `<dir> — not loaded` item (`app-menus.js:378-380`), with no toggle, because a broken manifest leaves no id to key one by. Open **Plugins ▸ Manage Plugins…** for the reason: the dialog prints `Not loaded: <why>` under the directory name (`renderer.js:5196`).
- **It loaded but `activate()` threw.** Different state, different place: the menu label reads `Git Branches — held back after N failed launches` (`:361-363`) and the dialog shows the error plus a **Retry** button (`:5153-5180`). Ticking a held-back plugin is itself a retry — enabling clears the strike first (`:366-372`).
- **Entry present, unticked** → tick it.

---

## 1. The grant, and the verb replying through it

This is the one behaviour from the original five with a real live residue. The
handler signature itself is pinned in CI — `test/session-manager.test.js:4892`
asserts the handler runs, that the handle carries exactly
`['cwd','inject','isAlive','name','type','workspaceId']`, that it names the
**emitting** session, and that the reply rides `handle.inject`. What that test
cannot exercise is the **grant**: it hands the seat's allowlist in directly
(`:4871`), so the checklist UI and the effect of ticking it are untested.

**Grant it first — it does nothing until you do.** In the **per-seat intent
checklist**, grant the verb `branch` for the seat you are about to test (listed
as **"Report git branch"**). §7 forces every plugin verb privileged: off for
every seat until explicitly granted.

**If you skip the grant, you get the standard gate bounce**, not silence:

```
[agent:branch] the branch intent is disabled for this session
```

The handler never runs — `session-manager.js:2825` refuses at the gate and
returns before dispatch, injecting that line at `:2839`. Pinned by
`test/plugin-fake.test.js:999-1009` ("refused at the gate, never at the
handler"), which asserts both the empty handler record and the exact bounce.

**So silence means something is genuinely wrong**, and is worth reporting: the
plugin failed to load, or `parse` did not match the line. Note this file
previously said the opposite — that an ungranted verb fails silently — which
would have told you to dismiss a real failure as an expected one. That claim was
carried over unchecked and is corrected here; the bounce above is what the code
does.

**Do:** in a granted session whose `cwd` is a git repo, have the agent emit exactly:

```
[agent:branch]
```

**Observable:** on the agent's **next turn** it receives `[git-branches] branch: <name>`, and `<name>` matches the chip on that session's row. Exactly **one** such line, not two.

**Check `<name>` against the cwd of the session that emitted it** — not against
the branch you happen to have in mind. This is a live trap, not a hypothetical:
on the first real run the designing agent predicted `plugin-phase-1` and the
reply said `master`, because that seat's cwd is the main checkout while the
worktree belongs to a different seat. **That was the designer being wrong, not
the plugin.** Had it answered `plugin-phase-1` it would have been the "reply
names a different session" failure below. Confirm the cwd first, then judge the
answer.

**Confirmed by running** (Bogdan's first pass): the grant takes effect **live,
with no restart**, and the reply correctly named the **emitting** session. Those
two are no longer predictions.
**If not:**
- **Verb absent from the checklist**, or ticking it changes nothing — i.e. you still get `the branch intent is disabled for this session` after granting → **the finding**. The registry row exists (a plugin verb is privileged by construction) and the gate is refusing anyway, so the seat-facing grant is not reaching `intentEnabledFor`. This is the leg no test covers, and the persisting bounce is how you will recognise it.
- Reply names a *different* session, or the log shows `fired without a usable session handle` → contradicts `session-manager.test.js:4892`; tell me, because a green test is then lying.
- **Two or more replies** → dispatch is per-feed, not per-line. Tell me the count: it is the number of live feeds, and it contradicts the three-legged source argument in step 5 below. `inject()` is not idempotent, so this is the one wrong answer that silently doubles every reply.

Worth also doing once in a **non-repo** session (expect `not a git repository`) and once in a **remote** session (expect `not available for remote sessions`) — those two paths run through `fsScope`.

---

## 2. Two windows, disable, re-enable

Per-window activation and teardown; no harness holds two real BrowserWindows.

**Marking convention for this step.** Everything here was written as prediction
by an agent that could not run the app. Each bullet is now marked either
**[source]** — the mechanism is settled, you are confirming it — or
**[unrun prediction]** — nobody has watched this and it may simply be wrong. A
prediction that fails is a finding about the file, not necessarily about the
code.

- **Two windows** *[unrun prediction]*. Open a second workspace window with a git session. Expect both windows to show correct chips at once, each filled by its own renderer activation. The mechanism is real (`renderer.js:3040-3050`: the engine broadcasts `plugin-state` on the `_host` pseudo-id and each window activates or disposes its **own** renderer half). Whether two live windows actually paint together is what you are checking.
- **Disable cleanly** *[source, for the teardown]*. Untick **Plugins ▸ Git Branches** with both windows open. Chips should vanish from both **immediately, without waiting for a relayout** — `renderer/plugin-host.js:649` removes every `[data-plugin-badge^="git-branches:"]` node directly, and `:644` removes the `<style>`. The **Preferences ▸ Git Branches** section going with it is the same teardown (`:645` purges `settingsSections`).
- **Re-enable live** *[source, and previously OBSERVED TO FAIL]*. Tick it again without restarting. Expect chips back in **both** windows promptly — not one, and not after a wait.

  **This is the step that failed on the first real run**, and it is worth knowing
  what you are re-checking. Bogdan saw exactly one window repaint; the other came
  back **30–60 seconds later, on its own, while he typed.** Root cause (t17): the
  plugin's poll set is written only by `resolve()`, i.e. only when core renders a
  row, so a re-enabled window polled an empty list forever — and the host paints
  eagerly at teardown (`plugin-host.js:649`) but has no counterpart at activation,
  and registering a row badge paints nothing (`:243`). The window therefore waited
  for an unrelated relayout: core's 30 s `refreshSidebarMeta` interval
  (`renderer/renderer.js:1172`) or the activity a keystroke produces — which is
  where the 30–60 s and the "while I was typing" both come from. Fixed in the
  plugin by requesting one relayout at the end of `activate()`, pinned by
  `test/plugin-git-branches-renderer.test.js`. **If you see a single window
  repaint again, or any wait at all, say so — the fix is wrong.**

**Two corrections to what this step used to say**, both found by reading rather
than running, and both of the "told you to expect the wrong thing" kind:

1. It said the log shows `plugin:git-branches activated` exactly once. **No such
   line exists.** Nothing in `plugin-host.js`, `plugin-host-engine.js` or
   `plugin-loader.js` logs an activation; `logFor` (`plugin-host-engine.js:120`)
   only ever emits what a plugin itself passes to `host.log`. The loader logs
   `loaded git-branches v<version>` at **startup discovery** (`plugin-loader.js:281`),
   which is not the same event and will not reappear on a live re-enable. Do not
   go looking for a line that cannot be printed.
2. It said "no error in either console over the following minute (a leaked timer
   would surface as a failed `invoke`)". **A leaked timer would not surface that
   way.** This plugin handles the disabled-engine case deliberately: a stray
   `invoke` returns the documented `{ ok:false, error:'no such plugin method' }`,
   and `checkRoutable` (`renderer.js:155-162`) swallows it, stops its timers and
   logs the *info* line `engine half is not routable; stopping badge updates`. So
   a silent console is consistent with both a clean teardown and a leaked timer —
   **the stated observable cannot tell them apart.** If you want the real signal,
   look for that info line under `plugin:git-branches` after disabling: its
   presence means a timer outlived the teardown and caught itself; a genuinely
   clean teardown never fires it, because the timer was cleared before it could
   run (`plugin-host.js:625-628`).

---

## Settled by source — do not hand-check these

Each was in the original five. Each is now answered, with the code that answers
it. Recorded here because the answer is a fact we own, not because the step was
unimportant.

**`requestRelayout()` causes a re-render.** Closed chain, no gap:
`renderer/plugin-host.js:244` calls the injected `scheduleSidebarRelayout` →
`renderer/renderer.js:1069-1072` debounces 250 ms then calls
`refreshSidebarView()` → `:971-988` loops every local row → `applyRowBadges(el)`
at `:982`. The plugin→core seam is pinned by `test/plugin-host.test.js:371`
("the plugin never reaches refreshSidebarView directly"). Only the four core
lines past that injected fake are audited by reading rather than by running;
driving `refreshSidebarView` under faked timers was considered and rejected as
scaffolding costing more than it protects.

**`cls` becomes a CSS class, unprefixed.** `renderer/plugin-host.js:268`
concatenates `cls` onto `session-plugin-badge` **verbatim**. So the selectors in
this plugin's `style.css` — `.gb-branch`, `.gb-unborn`, `.gb-detached` — are
correct as written, and no prefixed form was ever going to appear. Note the
asymmetry on the same element: the badge **`id`** *is* namespaced
(`data-plugin-badge="git-branches:branch"`, `:258`/`:265`). Both halves are now
pinned as a deliberate pair in `test/plugin-host.test.js`, and
`docs/plugin-api.md` §6 states the rule scoped to `id` rather than as a general
one.

**`style.css` is not scoped.** `renderer/plugin-host.js:583-592` creates one
`<style data-plugin-style="<id>">` per plugin per window and assigns
`textContent = String(css)` — verbatim, never rewritten or wrapped. A plugin's
CSS matches anywhere in the window, including core's DOM. The
`data-plugin-style` attribute exists so the sheet can be removed wholesale at
disable, not to confine it. Now stated in `docs/plugin-api.md` §14 as a limit,
in the same "contract, not containment" register as the rest of the posture.

**Once per line, not once per feed.** Three independent legs: `intentSource` is
`'wire'` xor `'jsonl'` per session; `_scanPtyOutput` is gated behind
`if (!agentType)` (`session-manager.js:1519`) so PTY line-scanning never applies
to an agent; and `_dispatchPluginIntent` refuses non-agent sessions (`:3170`).
The wire path additionally carries a per-batch `fired` Set (`:521-530`). Step 1
above still counts the replies, because this is the one wrong answer that would
be silent.

---

## Reporting back

For anything that fails: the step number, the observable you actually got, and —
for step 1 — the reply or log line verbatim.

**Route it by what failed, not by which step it was in.** The blanket
"everything in step 2 is a finding against my code" this section used to carry
was wrong, and wrong in the way that wastes your run: two of step 2's stated
observables turned out to be defects in *this document* (see the corrections
there), so a mismatch there is at least as likely to be my prose as my code.

- **The grant leg of step 1** (the bounce persists after granting) → **core**: the seat-facing grant is not reaching `intentEnabledFor`.
- **A doubled reply** → **the source argument** in "Once per line" below, which asserts it cannot happen. Report the count.
- **Silence with the verb granted** → **the plugin**: it failed to load, or `parse` did not match.
- **A bullet marked *[unrun prediction]*** → most likely **this document**. Tell me what you saw; a prediction is not a specification, and I would rather correct the file than have you debug against it.
- **A bullet marked *[source]*, with a file:line, behaving differently** → the most interesting outcome of the whole run: source says one thing and the app does another. Those are worth reporting verbatim above everything else here.
