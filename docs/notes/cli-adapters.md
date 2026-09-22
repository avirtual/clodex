# cli-adapters.js

## ADAPTERS

One entry per CLI Clodex can wrap, keyed by the seat `type` that `create()`
switches on. Every entry carries the same keys, pinned whole-object by
`test/cli-adapters.test.js`: `id` (the key), `label` (UI name), `cmd` (the
binary), `model` (`flags` the CLI takes a model on, `aliases` short names →
ids, `idRe` the id shape), `posture` (`bypassFlag`, the permission-bypass
argv token), `account` (`envKey` the config-dir env var; `bootstrap` names
the mechanism the call site with fs runs, `null` when none), `readOnlyCap`
(`null` until the platform has a reviewer cap), `instructions` (how a
system prompt reaches the CLI), `caps` (`park`: a held delivery can be
parked for this seat; `transcript`: the hook writes `transcript.jsonl`),
`ui` (the t749 dialog-field row `capsFor` returns). `Object.keys(ADAPTERS)`
must equal `skill-delivery.js`'s `providers()`, so a new platform is one
entry here plus one delivery function there and the suite names the missing
half.

### Guards that stay literal

The ~55 `agentType === 'claude'` guards left in `session-manager.js` and
`team-tickets.js` stay literal on purpose. They gate Claude ARTIFACTS —
`hookDigest`, the pending dir, `promptRecipe`/`session.md`, scratch marks,
move-to-peer, `refreshPrompt`, the argv arms themselves — not platform
policy. A boolean on the adapter would be true for exactly one platform and
would read as a promise that a second platform gains the artifact by
flipping it, which is false: each artifact needs its own mechanism written.
Convert a guard the day a second platform gets that artifact. The two
`transcript` guards on the review watchdog and the stall wake are the
exception and flip to `caps.transcript` when a Codex reviewer can exercise
them live.

## seatType

The ticket seat's `type` comes from the role's template; the opener's type fills
it only when the role names no template.

### Not in the leak lists

The module is a pure leaf — no `require`, no fs, no coordinator name — so
it is not listed in `test/free-identifier-leaks.test.js`, for the same
reason `clodex-paths.js` is not: there is no deps object whose identifiers
could leak. The renderer requires it directly and esbuild inlines it into
`web-dist`.
