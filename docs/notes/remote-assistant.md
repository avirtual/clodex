# remote.js — assistant-class seats

## _handleDm

`await` (ms) holds the reply for the turn's `result`, capped at `DM_AWAIT_MAX_MS`; the turn waiter arms when the dm is written, not when it queues, and the whole wait, queueing included, stays within `await`. A timeout, including a dm never written because its seat died first, answers `202 { queued: true }`.

## _handleSessionGet

A sleeper answers from its persisted record with `activity: 'asleep'`; `activityFor` is not consulted, since its default reads as a live idle seat.
