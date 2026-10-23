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
| Codex | T-C | T-C |
| Muse | T-C | T-C |

## normaliseDiscovered

Returns the proposed `${NAME}` entry and the literal values it lifted out; it writes nothing. `mcp:discover` hands
the renderer the secret names only, never the values, matching `envScopes:get`'s write-only rule for secrets.

## mcpLeaks

The library and a seat's `mcpServers` are managed configuration policy, not a tamper-proof boundary: a same-user
agent that can write `~/.clodex/library/mcp` or a template file can change them. No intent, exec, socket verb or
peer request writes them (`test/mcp-operator-only.test.js`); a `protectCredentials` seat is additionally
write-denied on every `~/.clodex` entry but `projects` by `dataWriteDeny` in credential-sandbox.js.
