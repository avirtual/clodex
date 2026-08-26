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

## Tests changed (test/team-manifest.test.js)
- :1032 lead-seat block pin -> new constant line 2; asserts the ABSENCE of the
  name and of `[agent:exec clodex-team]` rather than a new phrasing.
- :1041 convention pin -> `You are on team shop` + name-absent assertion.
- :1805 "ground-truth invocation is concrete" -> inverted: the block carries NO
  payload now, and the same test proves formatRoster still does, so the pin
  states "the duplicate moved" rather than "it vanished".
- NEW: same-role seats render BYTE-IDENTICAL blocks. strictEqual on the whole
  string across shop-hand-503 / -504 / bare shop-hand, plus one hardcoded
  literal of the exact expected bytes (equality alone would pass on an empty or
  role-less block), plus a notStrictEqual across DIFFERENT roles so a constant-
  returning implementation fails.
- :1681 hook-roster pin: NOT touched, per spec.

## After-measurement (same script, live manifest)
  hand      block=183B  stranded=0  identical=true   (was 8795 stranded)
  reviewer  block=187B  stranded=0  identical=true   (was 4484 stranded)
  lead      block=183B  stranded=0  identical=true
Block itself also shrank 241->183B (hand), 253->187B (reviewer).

## CHANGELOG
Entry added under `## Unreleased` — behavioural change, states the honest TTL
caveat (only pays when same-role seats overlap).

## r1 rework — the cost model was wrong (lead's correction, reviewer's catch)

My spec's premise (role prompt concatenated AFTER the block, so the varying
token strands it) does NOT hold for the seats it named. Verified at source AND
empirically, rather than taking it on trust a second time:

- session-manager.js:2448 `promptRidesAsSystem = def && def.prompt &&
  systemPromptFile === def.prompt`; the append at :2467 is guarded
  `else if (!promptRidesAsSystem && rolePrompt)` — so it is SKIPPED.
- team-tickets.js:3852 `systemPromptFile: (def && def.prompt) || ...` makes that
  equality hold for every ticket seat. The role prompt rides
  --system-prompt-file, a separate channel, already per-role constant.
- Live files: ~/.clodex/run/clodex-hand-505/append-prompt.md has `# Team` at
  line 104 of 106 — the block is the TAIL, nothing trails it. The lead's has it
  at 79 with `# Team lead` at 83 of 307 — the concat case is the LEAD's only,
  and a team has one lead, so it can never be shared with a same-role peer.

Honest figure: the block ITSELF moves from unshareable to shareable.
  hand      241B -> 183B   reviewer  253B -> 187B   (~180B/seat, both roles)
8,795/4,484 were the lead's stranding, generalized to roles where it is zero.

Fixed all three repetitions: CHANGELOG entry rewritten (hygiene at ~180B, not a
KB win), team-manifest.js:1035-1037 and test/team-manifest.test.js:1063-1064
now state the tail-vs-lead mechanism. Grepped: no stale figure remains.
Also fixed the stale :1097 comment ("naming the seat + team" -> "the team +
resolved role"), per the lead.

Deviation adjudicated by the lead: constant line 3 STAYS. Production change
unchanged — only numbers and comments were wrong.
