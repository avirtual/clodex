# renderer/lib/team-roles.js

## usesByRole

A byte-identical copy of `team-gather.js`'s export, not a require of it.
`team-gather.js` requires `path`, and `build/build-web.js` aliases only
os/crypto/child_process, so a cross-boundary require fails the browser bundle
with `Could not resolve "path"`. The two bodies are pinned equal by
`test/team-uses.test.js`.

## usesByRole — the `also` fan-out

`planGather` emits one item per `kind+stem` for the WHOLE team, so the second
role to name a shared stem contributes no item of its own; it is recorded as an
`also` entry on the first role's item. The fan-out here is what gives that role
any rows at all — without it a role whose only ref is a template another role
already named maps to `[]` and renders as "uses nothing".

## roleSummaries

The reviewer row omits `dispatch` rather than carrying it: nothing reads a
reviewer's `dispatch` value (`team-manifest.js` reserves the role and the loop
reaches it through `[agent:team-review]`, spawning one seat per review round), so
a chip showing that value names a mode the loop never honours. Its absence is
what `buildSummaryLine` branches on.

## activityTime

Formats in the VIEWER's timezone, from `Date`'s local getters. Fixtures must
build their epochs with `new Date(y, m, d, …)` for that reason — a UTC epoch
literal renders differently per machine and pins nothing.
