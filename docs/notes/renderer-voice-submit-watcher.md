# renderer/voice-submit-watcher.js

## VOICE_RELEASE_MS

How long a tap-mode stream seat waits, after the stop tap was written, for the engine's input row to read empty before it sends the composer anyway. Chosen to outlast the CLI's post-tap "processing" repaint; the empty-row edge it backstops is the one measured on 2.1.281 (`planRecord` in docs/notes/voice-engine.md). A judgement, not a measurement of this constant.
