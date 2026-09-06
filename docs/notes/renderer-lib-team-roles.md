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
