# wirescope-supervisor.js

## _spawn

`STRIP_MCP_SERVERS` defaults to `claude_design` because the vendored proxy
defaults it OFF in code (`proxylab/transforms.py`) and `start_proxy.sh`, which
turns it on, is not what Clodex runs. Kill switch is an exported empty string
(preserved by the `??`); per-agent re-admit is `[wirescope:keep-mcp claude_design]`.

`STRIP_MIDTURN_THINKING` defaults to `0` because wirescope measured (14 days,
84k receipts) that stripping thinking inside the RUNNING turn loses on 78% of
Opus and 99% of Fable seats: each round re-reads the new tail uncached. The
settled prior-turn strip stays on. A Finder-launched Clodex inherits no shell
env, so the default has to live here; an explicit export sticks via the `??`.

## start

A managed survivor predates this default, so it is restarted once on the
`_upgradeTried` latch when it does not report the strip at `/_identity`.
