# wirescope-supervisor.js

## _spawn

`STRIP_MCP_SERVERS` defaults to `claude_design` here because the vendored proxy
defaults it OFF in code (`proxylab/transforms.py`) and `start_proxy.sh`, which
turns it on for the lab, is not what Clodex runs — an absent default made
`/_identity` answer `servers: []`, so every Claude spawn fell back to
`--strict-mcp-config` and dropped the user's own MCP servers too. Kill switch is
an exported empty string, which the `??` preserves; per-agent re-admit is
`[wirescope:keep-mcp claude_design]`.
