# claude-env.js

## SCRUB_SURVIVORS

`CLAUDE_CONFIG_DIR` survives the scrub: it is the Claude account `envKey`, config rather than session state, so a node started with one keeps it for every seat it spawns.
