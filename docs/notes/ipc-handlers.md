# ipc-handlers.js

## stripBytes

`bytes` on a gather plan item is the library file's whole contents, carried so
`applyGather` can write it without a second read. It is stripped from the
`team:gather` reply only — `applyGather` runs inside `gatherTeam`, before this
handler sees the result, so the leaf and the `[agent:team gather]` intent path
still have it.

## enableAccounts

The `accounts:*` family is gated by ABSENCE of registration, the
`enableDrawerServices` shape, not by a flag the handler consults: web-host
dispatches any registered channel by name, so registration IS the capability
there. It joins the DECLINED set rather than the granted one because
`accounts:list` hands out the filesystem path of each account's credential
store and `accounts:move-by-model` kills and respawns live seats — neither is
something the ungated `session:create` already grants a web client.

## envLockedSettings

The predicate is the coercer each resolver uses, not "the variable is set". Both
`resolveRemoteBasePathSetting` and `resolveRemotePort` fall back to the STORED
value when the variable is set but fails coercion, so a lock keyed on mere
presence made the field read-only and the note claim the box served a value it
did not. Widening this back to a truthiness check re-opens that lie.
