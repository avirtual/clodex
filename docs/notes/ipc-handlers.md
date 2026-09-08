# ipc-handlers.js

## stripBytes

`bytes` on a gather plan item is the library file's whole contents, carried so
`applyGather` can write it without a second read. It is stripped from the
`team:gather` reply only — `applyGather` runs inside `gatherTeam`, before this
handler sees the result, so the leaf and the `[agent:team gather]` intent path
still have it.

## teamTemplatePath

Resolves `<teamsDir>/<team>/templates/<stem>.json` WITHOUT creating anything: an
unknown team is a refusal, never an mkdir, so a typo in a save cannot mint a team
directory. `team.json` is never written by this path.
