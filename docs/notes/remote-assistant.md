# remote.js — assistant-class seats

## _handleDm

`await` (ms) holds the reply for the turn's `result`, capped at `DM_AWAIT_MAX_MS`; the turn waiter arms when the dm is written, not when it queues. A timeout, including a dm never written because its seat died first, answers `202 { queued: true }`; a dm to a sleeper takes the wake time plus up to `await`: the deadline is set after the wake.
`ref` is echoed top-level on every answer and comes back inside `turn.refs`; `turn.refs` is every ref written since the previous `result`, so two dms joined into one write share a turn.
Measured 2026-10-25 on claude 2.1.310 (haiku, stream-json, one turn: text, a Bash `tool_use`, text): the assistant events held `"working on it"` then `"all done"`; `result.result` was `"all done"` — only the final assistant message's text, so `turn.text` drops prose emitted before a tool call (exec-text-probe.js in the sleeping-assistants task artifacts).

## _handleSessionGet

A sleeper answers from its persisted record with `activity: 'asleep'`; `activityFor` is not consulted, since its default reads as a live idle seat.

## _handleTranscript

A sleeping assistant reads its `sessionIds` files concatenated with `seq` renumbered; `since` restarts at every wake, `after` spans sleeps.
