# stream-seat.js

## spawnStreamSeat

Spawned `detached: true` so the child leads its own process group: `groupKill` signals `-pid`, which reaches the CLI's tool children without ever reaching Clodex's own group. A pipe child gets no SIGHUP when Clodex dies (unlike a pty), and SIGKILL to the leader alone leaves its tool children running (measured, headless-seats.md §0.5).

The transcript symlink has one writer at a time: headless, `hook.sh` repoints it only on SessionStart `startup` (no later SessionStart fires under `-p`), and `_repointStreamTranscript` repoints it on every session-id change after that.
They cannot race: startup's SessionStart precedes the first `init` (headless-seats.md §0.4, row "The transcript symlink").

## groupKill

Refuses a non-positive pid before negating it: `-0` and `-(-1)` would be broadcasts. Censused in test/sigkill-pid-census.test.js.

## send

M16 (wirescope, claude 2.1.281): a stdin message written between tool calls folds into the running turn (one `result`, replayed after the tool_result); one written during plain text generation is queued and gets its own `init` and `result` after the first. `queued_turn_count` is 0 on every `result` either way, so it cannot tell the cases apart; `_onStreamEvent` holds the first `result` after a tool-boundary drain for `STREAM_RESULT_HOLD_MS` instead.
