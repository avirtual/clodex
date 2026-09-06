# renderer/lib/team-roles.js

## usesByRole

A byte-identical copy of `team-gather.js`'s export, not a require of it.
`team-gather.js` requires `path`, and `build/build-web.js` aliases only
os/crypto/child_process, so a cross-boundary require fails the browser bundle
with `Could not resolve "path"`. The two bodies are pinned equal by
`test/team-uses.test.js`.
