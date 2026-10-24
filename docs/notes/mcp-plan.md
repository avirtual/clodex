# mcp-plan

Notes for `mcp-plan.js`: facts the code cannot state. Provable ones are tests (`test/mcp-plan.test.js`,
`test/mcp-operator-only.test.js`).

## MCP_NAME_RE

No `__` anywhere in a name: tools arrive as `mcp__<server>__<tool>`, and a server name containing `__` makes that
string ambiguous (`renderer/lib/mcp-group.js` takes the lazy reading). No dot: Codex addresses a server as
`-c mcp_servers.<name>.<key>`, where a dot is a path separator. `clodex` (the implicit server) and `claude_design`
(injected by the CLI from the claude.ai account) are reserved.

## validateMcpEntry

The literal-secret check is a lint, not a guarantee: it catches a literal in a header whose name matches
`authorization|api-?key|token` (case-insensitive) or an env key ending `TOKEN|SECRET|PASSWORD|API_KEY`. A secret
under any other key name, or inside `args`/`url`, passes. Library files are 0600 but nothing promises they hold no
secret.

## resolveMcpEntry

Resolution happens in Clodex at spawn, against the seat's merged env. A missing or empty `${NAME}` omits the whole
server (fail closed) and the spawn warns naming the var; a server is never injected with an empty token. Whether
the Claude CLI expands `${VAR}` inside an `--mcp-config` file is unmeasured, so nothing relies on it.

## mcpDigest

Hashes the unresolved CLI shape (with `${NAME}` placeholders), never a resolved value, so `mcpApplied.digest` on a
record changes when a definition changes and stays put when only a secret rotates.

## denyToolsOf

`denyTools` is enforcement at call time, not removal: `claudeMcpServers` turns each name into an
`mcp__<server>__<tool>` rule that `setupClaudeHook` writes to the seat's `permissions.deny`, so a denied tool still
appears in tools/list and still costs its tokens. Stripping it from the roster is a wirescope concern
(`STRIP_MCP_SERVERS` has no per-tool form) and out of scope. Codex maps the list to `disabled_tools` (`codexMcpArgs`); Muse gets the same `denyRules` from `claudeMcpServers` but
nothing enforces them yet.

Measured on claude 2.1.309, 2026-10-24: the hosted Atlassian server (`https://mcp.atlassian.com/v2/mcp`) is
OAuth-only. A library entry with `Authorization: Bearer ${TOKEN}` gets 401 and disables the CLI's own OAuth
fallback; a header-less `{type:http,url}` entry under `--strict-mcp-config` reports `status: needs-auth` in
`system/init`. The CLI documents `/mcp` as the login path, keeping the token keyed by server name (unmeasured
here).

## codexMcpArgs

Measured on codex-cli 0.164.0, 2026-10-24 (contradicting the design's first probe):
(1) `-c 'mcp_servers={}'` does NOT clear config.toml servers — every `-c` deep-merges, inline tables included;
(2) `${X}` inside an `env` value is NOT expanded (the child saw the literal `${JIRA_TOKEN}`);
(3) a stdio child receives ONLY HOME LANG LOGNAME PATH SHELL TERM TMPDIR USER __CF_USER_TEXT_ENCODING plus `env` keys
plus `env_vars` names — `env_vars` is required;
(4) `-c mcp_servers.<n>.enabled=false` works for a config.toml server and FAILS the whole load ("invalid transport in
mcp_servers.cua_repl") for a plugin-bundled one;
(5) `mcp_servers."q"` is not addressable, bare `mcp_servers.my-srv` is;
(6) `codex debug prompt-input` starts the configured stdio servers in ~1.4 s with no model call.

So a server is built key by key, a value carrying `${…}` is resolved by Clodex into the codex process env and only
its key travels in argv (`env_vars`), and plugin servers are never disabled (that would fail the load).
The codex process has one env, so an alias key two servers (or the seat itself) hold with different values cannot be
expressed: the later server is omitted rather than handed another service's secret.
`test/mcp-codex-env-probe.test.js` reruns the stdio case against the installed binary; on 0.164.0 the child's env
keys were `API_TOKEN EMPTY FIXED HOME LANG LOGNAME PATH PROBE_OUT Q SHELL TERM TMPDIR UNI URL USER
__CF_USER_TEXT_ENCODING` (the source `JIRA_TOKEN` absent). With an empty `CODEX_HOME` the probe needs no login.

`disabled_tools` is a key of the 0.164.0 server config (`codex mcp get --json` echoes it); that the server's tools are
then withheld is unverified — `debug prompt-input` does not list a config server's tools, so the probe cannot see it.

Follow-up: on a `protectCredentials` seat the alias keys `codexMcpArgs` puts in `seatEnv` (e.g. `API_TOKEN`) are not
added to the credential deny list; only the Claude arm feeds `mcpSecretNames`.

## mcpArgvPlan

Measured on claude 2.1.309, 2026-10-23: a throwaway `--plugin-dir` plugin carrying a stdio server (once as
`.mcp.json` at the plugin root, once as `mcpServers` in `plugin.json`), seat run as
`claude -p --output-format stream-json --verbose --plugin-dir <p> [--strict-mcp-config] --mcp-config <file>`.
The `system/init` event listed only the `--mcp-config` server, with and without `--strict-mcp-config`; the plugin
loaded (it is in `plugins`) but its server never appeared in either arm. The control arm failed, so whether strict
excludes plugin MCP servers is unverified: the Claude label is "partially managed: CLI plugins may add servers",
and `mcpLeaks` on the live roster is the detector.

Both user-args arms (own `--mcp-config`, own `--strict-mcp-config`) are unmanaged: Clodex pushes nothing and
records `mcpUnmanaged`.

## discoverMcpSources

Clodex controls the configured selection; the CLI's own sources are excluded where verified. Status per CLI:

| CLI | Own sources excluded | Residue |
|---|---|---|
| Claude | `~/.claude.json` user and local scopes, `.mcp.json`, `claude mcp add` scopes — by `--strict-mcp-config` | CLI plugins: unverified (see `mcpArgvPlan`); `claude_design` is shed by strict |
| Codex | `~/.codex/config.toml` servers — disabled by name with `-c mcp_servers.<n>.enabled=false` (see `codexMcpArgs`) | plugin-bundled servers are residue: `codex mcp list --json` rows outside config.toml and the selection, labelled not controllable |
| Muse | T-C | T-C |

## normaliseDiscovered

Returns the proposed `${NAME}` entry and the literal values it lifted out; it writes nothing. `mcp:discover` hands
the renderer the secret names only, never the values, matching `envScopes:get`'s write-only rule for secrets.

## mcpLeaks

The library and a seat's `mcpServers` are managed configuration policy, not a tamper-proof boundary: a same-user
agent that can write `~/.clodex/library/mcp` or a template file can change them. No intent, exec, socket verb or
peer request writes them (`test/mcp-operator-only.test.js`); a `protectCredentials` seat is additionally
write-denied on every `~/.clodex` entry but `projects` by `dataWriteDeny` in credential-sandbox.js.
