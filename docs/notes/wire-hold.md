# wire/hold.js

## holdDecision

A hold only buys anything when one ping covers more than one margin window; with
`ttl_s <= margin` every tick is due and each ping re-stamps a TTL that is due
again at the next tick, so the skip on that condition is what stops a perpetual
hold pinging forever. A `warmthQ` with no `ttl_s` (older ledger rows) is left on
the previous behaviour.

## _configDirFor

The dir this resolver returns reaches `readClaudeAuth` in wire/claude-auth.js, whose
`keychainServiceFor` names the Keychain item `Claude Code-credentials-<first 8 hex of
sha256 over CLAUDE_CONFIG_DIR as given>` when that env is set and the plain
`Claude Code-credentials` otherwise; measured against CLI 2.1.269 on 2026-09-12.
