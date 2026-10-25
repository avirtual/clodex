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

Fold before the `onSessionId` reset, or the old CLI session's cumulative `total_cost_usd` double-counts. Restart paths snapshot the record before `kill()`, so one fold window's tail can miss the re-seeded record.
