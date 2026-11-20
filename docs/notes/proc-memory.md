# proc-memory.js

## sample
Synchronous on purpose: `createIdlePauseAsker`'s `check` returns the ask object synchronously. It blocks the main process for at most `PS_TIMEOUT_MS` and runs only when a question or an automatic pass is about to happen.
