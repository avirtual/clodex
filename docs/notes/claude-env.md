# claude-env.js

## SCRUB_SURVIVORS

`CLAUDE_CONFIG_DIR` survives the scrub: it is the Claude account `envKey`, config rather than session state.

## dropInheritedConfigDir

Desktop only: `main.js` calls it after the scrub because a Clodex launched or relaunched from inside an account seat would otherwise run every default seat on that account (Bogdan ruling 2026-09-29). `headless-main.js` does not: a server or box may set `CLAUDE_CONFIG_DIR` in its unit env on purpose.

## scrubInheritedClaudeMarkers

A kept non-agent `ANTHROPIC_BASE_URL` does not bypass the tee: measured on claude 2.1.286, a `--settings` `env.ANTHROPIC_BASE_URL` beats the same key exported in the launch env, with no "ignored" debug line. The CLI's launch-env-wins rule applies only to desktop/runner-hosted sessions (tasks/base-url-precedence/MEASURE.md).
