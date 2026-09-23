# wirescope-supervisor.js

## _spawn

`STRIP_MCP_SERVERS` defaults to `claude_design` because the vendored proxy
defaults it OFF in code (`proxylab/transforms.py`) and `start_proxy.sh`, which
turns it on, is not what Clodex runs. Kill switch is an exported empty string
(preserved by the `??`); per-agent re-admit is `[wirescope:keep-mcp claude_design]`.

## start

A managed survivor predates this default, so it is restarted once on the
`_upgradeTried` latch when it does not report the strip at `/_identity`.

## _reclaimPidFile

A 2 s `lsof`/`ps` timeout returns null, which reads as "not adopted", so under box load a negative
test passes for the wrong reason; the tests drive canned output through the injected `exec` dep and use the real binaries only in the one smoke test.
