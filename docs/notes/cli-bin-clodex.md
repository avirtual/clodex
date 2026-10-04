# cli/bin/clodex notes

## agentIdFrom

`claude` 2.1.289 exports no agent-id env var to Bash children (strings of the binary: only `CLAUDE_AGENT_SDK_*`, `CLAUDE_CODE_AGENT_*`), so the verb forwards `CLODEX_AGENT_ID` for ticket B's stamp.
