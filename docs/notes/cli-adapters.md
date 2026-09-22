# cli-adapters.js

## ADAPTERS

One entry per CLI Clodex can wrap, keyed by the seat `type` that `create()`
switches on. Every entry carries the same keys, pinned whole-object by
`test/cli-adapters.test.js`: `id` (the key), `label` (UI name), `cmd` (the
binary), `model` (`flags` the CLI takes a model on, `aliases` short names →
ids, `idRe` the id shape), `posture` (`bypassArgs`, the permission-bypass
argv tokens as an array; `hasBypass(adapter, argv)` is true only when that
array occurs contiguously in `argv`), `account` (`envKey` the config-dir env
var, which `create()` resolves the account dir through for every type that
names one; `bootstrap` names the mechanism the call site with fs runs, `null`
when none), `cwdDir` (the directory the CLI writes into the seat's cwd, which
a worktree seat gitignores via `ignoreCwdDir`; `null` when it writes none),
`readOnlyCap` (how the platform expresses the reviewer's read-only cap,
`null` when it has none and so cannot seat a reviewer), `instructions` (how a
system prompt reaches the CLI), `transcript` (`reader`: the transcript reader
id; `link`: `hook` = the CLI's hook writes the transcript symlink, `clodex` =
`create()` writes it before spawn — reserved, no reader yet), `caps` (`park`:
a held delivery can be parked for this seat; `transcript`: the hook writes
`transcript.jsonl`; `warmth`: the renderer shows the prompt-cache warmth
segment), `ui` (the t749 dialog-field row `capsFor` returns). `Object.keys(ADAPTERS)`
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
`transcript` guards on the review watchdog and the stall wake read
`caps.transcript` since t1078, which measured the Codex hook landing the
symlink live (see `readOnlyCap` below).

### Not in the leak lists

The module is a pure leaf — no `require`, no fs, no coordinator name — so
it is not listed in `test/free-identifier-leaks.test.js`, for the same
reason `clodex-paths.js` is not: there is no deps object whose identifiers
could leak. The renderer requires it directly and esbuild inlines it into
`web-dist`.

## seatType

The ticket seat's `type` comes from the role's template; the opener's type fills
it only when the role names no template.

## readOnlyCap

`enforce: 'tool-denylist'` (Claude) inverts `REVIEWER_TOOL_CAP` into a settings
denylist; `enforce: 'argv'` (Codex) appends `args` to the seat's argv and the
review arm carries no posture flag and no template argv ahead of it. Measured
against codex-cli 0.155.1 (`codex exec --enable hooks -s read-only -c
approval_policy="never" --add-dir <dir>` in a scratch dir carrying the loop's
`.codex/hooks.json`, `WB_WRAP_NAME` set): the SessionStart hook fired and
`run/<name>/transcript.jsonl` landed although `hooks.state` in `config.toml`
held no entry for that path — trust followed the already-trusted hook hash, and
no entry was written; `--add-dir` under `read-only` is NOT writable (`touch`:
Operation not permitted), the cwd is not either, and outbound network is off
(DNS fails). `exec` rejects `--ask-for-approval`; the TUI the seat boots takes
it.

`enforce: 'settings-profile'` (Muse) is a settings file plus a flag: `settings`
is deep-merged into every Muse seat's settings.json by `bootstrapSeatConfig`
(inert until selected) and `args` selects it. It carries NO posture args:
`--permission-profile` is mutually exclusive with `--approval-mode`, `--yolo`
AND `--sandbox-network` (all measured on Muse Code 1.3.0). The profile's
`network: { mode: 'enabled' }` member is the only headless way to reach
loopback: under the bare `:read-only` profile the sandbox commits
`local_command_network.mode: restricted` and `curl 127.0.0.1:7800` is refused
(connection refused, measured); `restricted` + `targets` is "contradictory
authority: network rules outside proxy_only"; `proxy_only` (+targets) "requires
prompting approval with human fallback", which a headless reviewer cannot give;
`local_command_network` is not a profile field. With `network.mode: enabled`
the same curl returned wirescope's `_identity` (measured, 1 request, 4.0 s). A
file under `~/.clodex/messages` (a spilled spec) IS readable under the profile
(measured: `cat` returned the header), and the transcript carries
`runtime.session.permission_profile_committed` with `source.kind: "user_named"`,
`id: "reviewer"` inside a `session_permission_transaction` frame.

## skills

`null` where the platform has no listable roster (Claude sweeps transcripts; Codex has none); `{ list, activation }` where it has: `list.args` after `cmd` prints the roster as JSON, `list.env` names the variable pointed at the SOURCE config (`account.envKey`, never the seat overlay the list is about to shape), `list.scratchEnv` a data-home variable pointed at a scratch dir, `activation.key`/`activation.off` the settings path and value the off-block is written under. Measured facts live in docs/notes/muse-skills.md.
