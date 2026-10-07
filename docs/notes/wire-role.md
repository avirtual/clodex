# wire/role.js

## isCompactCall

The needle is the CLI's appended compact instruction, verified against a captured CLI request body
(`~/.clodex/boxes/team-avh/data/wirescope/logs/fa06a9c2-…/383-…request.json`): it rides as the last
text block of the LAST user message, after a `<pasted_content>` block. Only that message is scanned — an
earlier user message can quote the sentence (an agent reading compaction code) and is history, not a compact.

## RoleClassifier

On claude 2.1.286 with `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`, `x-claude-code-request-class` was seen as `main`, `subagent` and `compaction`; `x-claude-code-agent-type` carries the subagent's name (e.g. `Explore`), and the compact request also sends `x-claude-code-compaction: manual` (auto value unmeasured).
Title, classifier and probe requests were not produced, so their values are unmeasured; without the env var only `x-claude-code-session-id` is sent. Capture: `~/.clodex/projects/wb-wrap-ui-5bc8ce0a/tasks/gateway-hint-headers/CAPTURE.md`.
The proxy passes `x-claude-code-request-class: subagent` to `genuineSubagent` as one more trigger under the fingerprint backstop, not a replacement for it, and `compaction` marks a compact call alongside `isCompactCall`; `main` decides nothing.

## billingText

The billing flag and fingerprint are read from the billing block (`system[0]`, starting `x-anthropic-billing-header:`) only, because appended system prose (a review scope) once carried the flag literal and muted a reviewer seat as a subagent for its whole life.

## isBareSideCall

WebFetch's page summariser, measured on CLI 2.1.288: no tools, system = billing block (70 chars) + `You are Claude Code, Anthropic's official CLI for Claude.` (57 chars), one user message whose text starts `\nWeb page content:\n---\n`, `max_tokens` 64000, no thinking, the parent's session_id.
The proxy keys on "no tools + one message + every system block ≤ 200 chars" rather than the WebFetch prefix alone because every CLI helper call shares that shape and no agent turn has it (an agent turn carries tools and a kilobytes-long system), so a future summariser is excluded without a new needle; `isWebFetchCall` only names the kind (`sideKind`).

## isTitleCall

`TITLE_SYS_PREFIX` has matched nothing since CLI 2.1.280 rewrote the title prompt; the call is now recognised by structure (no tools, `output_config.format` a `json_schema` whose `required` is exactly `['title']`), and the prefix is kept only for replayed pre-2.1.280 captures.
From CLI 2.1.286 the proxy also treats `x-claude-code-request-class: auxiliary` as a side-call: over 8 days it carried only side-calls (classifier, probe, progress summary, title, count_tokens, WebSearch/WebFetch).
