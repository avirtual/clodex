# t505 — drop the seat name from the system-prompt team block

## Replay check
Clean tree at 86fb0e2 (spec's base, confirmed ancestor), no branch commits, no
prior JOURNAL. Nothing was started; did the task as specified.

## Risk gate (spec §"The one real risk") — CLEARED
Verified the SessionStart hook re-fires on compact, so identity survives:
- cli-hooks.js:536 registers SessionStart with `matcher: ''` — all sources.
- The generated script (cli-hooks.js:76-127) branches on `$SRC`:
  `startup|clear|compact` -> `cat "${digestPath}"`, else `cat "${outputPath}"`.
- BOTH files' additionalContext leads with
  `You are the clodex agent named '<name>'.` (writeClaudeDigestFile :41-45,
  outputPath :423-428).
So on every source, compact included, the name is re-emitted as conversation
content. Not shipping blind; the spec's stop-condition did not trigger.

## Baseline measurement (BEFORE, live manifest ~/.clodex/teams/clodex)
Rendered formatTeamBlock + the role's real library prompt for two same-role
seats, byte-diffed:
  hand      503/504  block=241B total=8829B  firstDiff@34  stranded=8795B
  reviewer  503/504  block=253B total=4522B  firstDiff@38  stranded=4484B
  lead      single seat -> identical, 0 stranded (only one lead seat exists)

## Change
team-manifest.js formatTeamBlock: line 2 drops `seat <name> `, line 3 drops the
rendered rosterExecPayload entirely (replaced by a constant sentence).
matchSeatRole still takes seatName to resolve the role - only the OUTPUT stops
varying. rosterExecPayload is still live: formatRoster:1171 (the HOOK roster)
keeps the concrete named line, untouched per spec.

## Next
Tests: update pins at test/team-manifest.test.js :1035, :1043, :1805; add the
byte-identical property test. Do NOT touch :1681 (hook roster). Then CHANGELOG.
