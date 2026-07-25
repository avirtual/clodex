# git-branches — install and verify

Assumes the app is running and you have at least one local session whose `cwd`
is a git repo.

**Read this first.** This file used to list five behaviours "no test harness
reaches". That conflated two different claims — *no harness reaches it* and *no
source read settles it* — and four of the five turned out to be answerable
without you. Those are now recorded below under **Settled by source**, with
file:line, and are not yours to check. What remains in the manual section is the
residue: things a running app genuinely shows and a source read cannot.

Every manual step names what failure looks like. None are softened — if a step
fails, that is the point.

---

## 0. Install

**Do:** copy this directory to `<repo>/plugins/git-branches/`, then restart the app.
**Observable:** menu bar shows **Plugins ▸ Git Branches** with a tick.
**If not:** no `Plugins` menu at all → `CLODEX_PLUGINS=0` is set in the environment. Menu present but the entry shows an error → open **Plugins ▸ Manage Plugins…**; the refusal reason is printed under the directory name. Entry present, unticked → tick it.

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

**If you skip the grant, the failure is total silence** — no reply, no toast, no
error, and nothing in the app log under `plugin:git-branches`, because the
handler is never called. Silence means "not granted", not "plugin broken".

**Do:** in a granted session whose `cwd` is a git repo, have the agent emit exactly:

```
[agent:branch]
```

**Observable:** on the agent's **next turn** it receives `[git-branches] branch: <name>`, and `<name>` matches the chip on that session's row. Exactly **one** such line, not two.
**If not:**
- **Verb absent from the checklist**, or ticking it changes nothing → the finding. The registry row exists (a plugin verb is privileged by construction), but the seat-facing path does not honour it. This is the leg no test covers.
- Reply names a *different* session, or the log shows `fired without a usable session handle` → contradicts `session-manager.test.js:4892`; tell me, because a green test is then lying.
- **Two or more replies** → dispatch is per-feed, not per-line. Tell me the count: it is the number of live feeds, and it contradicts the three-legged source argument in step 5 below. `inject()` is not idempotent, so this is the one wrong answer that silently doubles every reply.

Worth also doing once in a **non-repo** session (expect `not a git repository`) and once in a **remote** session (expect `not available for remote sessions`) — those two paths run through `fsScope`.

---

## 2. Two windows, disable, re-enable

Per-window activation and teardown; no harness holds two real BrowserWindows.

- **Two windows:** open a second workspace window with a git session. Both windows show correct chips at the same time, each filled by its own renderer activation.
- **Disable cleanly:** untick **Plugins ▸ Git Branches** with both windows open. Every chip disappears from both immediately, the **Preferences ▸ Git Branches** section is gone, and no error appears in either console over the following minute (a leaked timer would surface as a failed `invoke`).
- **Re-enable live:** tick it again without restarting. Chips come back in both windows within one refresh interval, and the log shows `plugin:git-branches activated` exactly once.

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
for step 1 — the log line verbatim. A failure in the **grant** leg of step 1 is a
finding against core. A doubled reply is a finding against the source argument
above. Everything in step 2 failing is a finding against my code.
