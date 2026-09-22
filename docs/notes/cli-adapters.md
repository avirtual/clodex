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

A Muse seat's transcript is non-empty BEFORE its PTY spawns (the m2 mint turn),
and the resume APPENDS at boot with nothing typed (measured, echo provider, Muse
Code 1.3.0: 82,821 bytes / 66 records before `resume`, 89,710 / 72 six seconds
after boot — five boot records totalling 6,165 bytes: `route_facts`,
`workspace_branch.observed`, `session.opened.observed`, `session.resumed`, the
`session_permission_transaction` frame — plus `session.end` from the SIGTERM;
every boot record classifies inert under the muse reader). So
`_checkReviewStarted` counts TURNS, not bytes: `_seatTurnSince` reads the
transcript from the offset stamped at the first arm through the seat's
`transcript.reader` and takes any `turnStart`/`isReply`/`turnEnd` record as
started. A TUI-spawned Codex seat could not be measured the same way: in a
fresh scratch project `codex --enable hooks` chains a directory-trust dialog and
then a "Hooks need review" dialog (measured, 0.155.1 — trust is per project, so
even the loop's own trusted hook script is "new" there), and the SessionStart
hook runs only past both; persisting hook trust for a throwaway project in the
operator's config was declined. A Codex `session_meta` written at boot, before
or after the arm, classifies as no turn, so the same probe covers it.

The committed snapshot under the widened profile (run 2) keeps the filesystem
read-only: `filesystem.mode: managed`, rules `:minimal` / `:root` /
`:workspace_roots` all `access: read`, `protected_metadata: true`, beside
`local_command_network.mode: enabled`, `approval: allow_all`, `reviewer: none`.

Gap, follow-up: the reviewer's MINT turn (the `muse exec` at create) runs
uncapped — `--approval-mode never --disable-sandbox`, cwd the review worktree,
the reviewer AGENTS.md already written, steps unbounded; only the resume
carries `--permission-profile reviewer`. The two flag sets are mutually
exclusive, so the fix is a swap: a seat whose extraArgs carry a cap mints under
the cap args in place of the bypass pair.
