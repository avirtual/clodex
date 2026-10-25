# session-manager.js (stream seats)

## seatCommands

Codex bills slash text as a model turn (`encodeUser` refuses it), so a Codex or Muse seat's menu holds only controls that go over `encodeContext` and `encodeInterrupt`.

## _writeImageFiles
Measured 2026-09-26 in a tmux pty with `tmux paste-buffer -p` (bracketed paste): codex 0.157.1 and muse 1.4.0 each turn a paste that is exactly one PNG path into an `[Image #1]` chip, and leave `Image #1: /path.png` (the path inside a longer line) as plain text. The pty dm delivery pastes the whole message, so on those two seats the `Image:` lines arrive as paths the agent opens with a tool.

## _buildDeliveryText
Measured 2026-10-01 on claude 2.1.286 (PTY seat), `<pasted_content>` wrap: a bracketed-paste delivery is wrapped in `<pasted_content id=…>` exactly when the composer collapses it to `[Pasted text #N]` — at ≥ 4 lines regardless of size, or > 800 bytes on any line count. Below both (≤ 3 lines and ≤ 800 bytes) it arrives bare. A delivery up to 3 KB (`MSG_SPILL_THRESHOLD`) arrives inline, wrapped or bare, and the harness prompt tells the seat to read a wrapped `[agent:` block as a delivery.
An unbracketed multi-line write is held for a review Enter (the composer strips `\r`), so it is not a usable alternative. Stream-io seats deliver through the SDK, not a paste, and are unaffected.
Evidence: ~/.clodex/projects/wb-wrap-ui-5bc8ce0a/tasks/paste-wrap-threshold/MEASURE.md.

`SYSTEM_SENDERS` bodies skip the `> ` defuse here; the loop's notices defuse the hand- and reviewer-authored spans they embed before interpolation (team-tickets.js, `defuseSenderLines`). The match runs on the strip-reduced line so a character the inject strip deletes cannot hide the marker.

## _foldSeatCost

Measured on claude 2.1.310: a stream `/clear` emits an `init` under a new `session_id` plus a `result` with `total_cost_usd: 0, num_turns: 0`, and the next result carries only its own cost, so the counter is per CLI session and the `onSessionId` reset holds; the `/clear` result is a zero-cost `num_turns: 0` row and counts one turn.
Fold before the `onSessionId` reset, or the old CLI session's unfolded tail is lost. Restart paths snapshot the record before `kill()`, so one fold window's tail can miss the re-seeded record.

## _onStreamPermission

An assistant seat has no operator watching its pane, so a permission request is denied on the wire at once and raises no attention, broadcast or OS notification; a codec that cannot encode the deny falls through to the held prompt.

## _gatedDeliver

The assistant-class guard runs before the live-session lookup, so seat mail to a sleeping assistant bounces with the class error instead of `no such agent`.

## awaitTurn

A waiter is armed when the dm is written to the CLI (the item's `onSend`), never at enqueue: a `result` that lands while the item still queues belongs to the previous turn. The next `result` resolves it; a close or the timeout resolves `null`. The text is the CLI's final `result` string, so prose emitted before a tool call in the same turn is not in it; the transcript route has the whole turn.
