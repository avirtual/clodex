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
there. web-host.js grants it: every web caller already reaches the ungated
`session:create` (a `$SHELL` on the box) and `session:setArgs` /
`session:restart`, which move a seat to any `CLAUDE_CONFIG_DIR`, so refusing
the family protected nothing.

## secureTransportOfSender

`accounts:setApiKey` refuses unless this dep answers exactly `true`; an absent
dep refuses. main.js answers `true`; web-host.js answers `true` only for a
connection whose peer address was loopback or whose `Origin` was `https:` when
the socket was accepted. The other six `accounts:*` channels are not gated.
Unverified: a client behind a published Docker port likely arrives from the
bridge gateway, not loopback, so `http://localhost:<port>` would be refused.

## envLockedSettings

The predicate is the coercer each resolver uses, not "the variable is set". Both
`resolveRemoteBasePathSetting` and `resolveRemotePort` fall back to the STORED
value when the variable is set but fails coercion, so a lock keyed on mere
presence made the field read-only and the note claim the box served a value it
did not. Widening this back to a truthiness check re-opens that lie.
