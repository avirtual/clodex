# ipc-handlers.js

## stripBytes

`bytes` on a gather plan item is the library file's whole contents, carried so
`applyGather` can write it without a second read. It is stripped from the
`team:gather` reply only — `applyGather` runs inside `gatherTeam`, before this
handler sees the result, so the leaf and the `[agent:team gather]` intent path
still have it.
