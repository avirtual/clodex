# t117 — does path confinement belong on the host surface?

## Decision: NO. Keep the per-plugin copies.

Decided 2026-07-31 by the lead. `hostApi` is frozen at `"1"`, so adding to the
surface is a one-way door; that raised the bar but is not the reason.

## Why the duplication argument loses

Three copies of the predicate exist (`path-confine.js`, `plugins/memory-viewer`,
`plugins/tickets-viewer`) and a fourth would have been written for
`manifestWarning()` before the hand correctly declined. Duplication is the
strongest argument FOR hoisting it, and it still loses to §13's stated posture.

`plugins/plugin-api.md` §13 already answers this, for the neighbouring case:

> `fsScope` refuses peers, but neither scopes workspaces nor confines the cwd
> … confine your own path joins (a lexical check is not enough — a symlink
> inside the cwd resolves out of it).

The API's position is **contract, not containment**: with
`contextIsolation: false` a plugin that wanted to reach around the host could,
so a host-side guard buys appearance rather than safety. Hoisting `confine()`
would put a *containment-shaped* function on a surface that deliberately does
not contain, and the name would promise a property the architecture cannot
deliver. That is worse than duplication — it is a false green on the API
surface itself, which is the failure class this repo spent the night on.

The second reason is narrower and decides it independently. `path-confine.js`
deliberately does NOT call `realpath` (comment at :21), so it is a lexical
check — exactly what §13 says is insufficient against a symlink. Core's own
roots are 0700 and self-created, which is what makes the lexical check correct
THERE. A plugin's root is whatever the plugin points it at. Same code, different
precondition, opposite correctness — the "one function, two consumers" pattern
that bit twice already (`tickets-store.load()`, wirescope's `_classify_role`).
Shipping it as a host primitive would export the code and silently drop the
precondition that makes it sound.

## What to do instead

Nothing, for now. The copies are ~10 lines, pure, and each sits next to the
root it guards where its precondition is visible. If a fourth appears, revisit
as a **documented pattern in §13** (a snippet plugins are told to copy, with the
realpath caveat stated) rather than as a host method.

Reopen if either changes: `contextIsolation` becomes true, or the host starts
handing plugins roots they did not choose.
