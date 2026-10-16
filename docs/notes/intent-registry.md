# intent-registry notes

## rowVisibleTo

Keys on the seat's `plugins` list via `seatHasPlugin`, with NO `scope` short
circuit. That short circuit ("a global row is visible everywhere") was removed
in t654 and must not come back: it would make a global plugin unhideable from a
seat, which is the operator ask the field exists for.

## intentEnabledForSeat

Takes the whole persistence entry rather than `(intents, plugins)` so a caller
cannot pass one and not the other. `session-manager._handleIntent` is the only
production caller; `intentEnabledFor` beside it is the intents-only predicate
and stays that way.

## pruneForPlugins

Does not mutate its input. Returns `{ intents, pluginGrants }` where a
non-array input yields `null` — a null allowlist needs no prune because a
plugin row is enabled only by explicit inclusion, never by the all-enabled
default.

Both halves exempt a plugin with NO registered row, and the grants half only
gained that in t655. The case it exists for: a quarantined plugin's rows are
gone (`deactivate` unregisters its source), so it cannot appear in the catalog
snapshot an editor saves; pruning grants against that snapshot revoked them on
the first unrelated Edit-save of a pre-upgrade seat, irreversibly, because the
operator never saw the plugin to re-tick it. This module sees verbs only, so a
loaded plugin that happens to register none is exempted by the same test — that
widens what is RETAINED, never what is revoked, and a grant for a registered
plugin the seat unticked is still dropped.

## subagentCatalogFor

Lists core tool rows (`dm` for a seat holding `dm`, `term_exec` and `term_read` for one whose intents name `term`) ahead of plugin tools; a core tool's brief rides only when the tool declares one (`dm` does, main-only `term_exec` and `term_read` do not), since a SubagentStart brief for a main-only tool would spend tokens on every spawn. The name is kept because every caller and three tests pin it.

## parseDm

The dm head takes `urgent` and an optional `ref:<token>` (`DM_REF_RE`) in either order; a malformed, empty or repeated head token fails the whole parse (null), as an unknown head token always has.

## parseTask

`done` alone takes `tN@origin` (origin per `AGENT_NAME_RE`): it returns `id: 'tN'` and `board: origin`, and `board: null` for a bare id; every other sub keeps the `@` inside its token untouched.

## parseProbe

Any head word parses, so a mistyped sub reaches `_handleProbeIntent` and bounces naming the three verbs instead of falling to the near-miss list; `[agent:probe]` with an empty head is `begin`, greedy even when the head line is bare, so the question may start on the next line.

## parseCtl

`[agent:ctl <ctx>] <line>` is bodyless: the clodexctl line is the rest of the head line. The row is privileged in intent-catalog, so no seat has it until the operator lists `ctl`; the exec path (`inProcess: "ctl"`) reaches the same handler without it.

## EXEC_TOOL

`toIntent` serialises the payload with `JSON.stringify` and no indent: raw newlines are escaped, so an `[agent:…]` string inside a value can never start a line of its own and open a second intent (pinned by `exec: a payload round-trips through the intent text as one intent`). `payload` defaults to `{}` because `parseAndValidate` refuses an empty body. The command id is vetted with the dispatcher's own `isFilenameToken`, so a space can never split the head into cmd and body.

## classifyExecReply

Anchored on the dispatcher's `${cmd}: ` prefix and fixed phrases: a false `refused` or `error` on a success would trip the MCP loop ring on the third identical call, while a false `ok` on an unmatched failure costs nothing.
