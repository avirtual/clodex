# voice-engine.js

Measured 2026-09-24 against CLI 2.1.281 in a raw pty with no terminal attached
and a focus-out (`\e[O`) written before the key.

## RECORD_KEY

Space, the default `voice:pushToTalk` binding. The recorder starts and stops
with the pty unfocused and nothing visible, so a hidden seat can record.

## planRecord

Tap: one space starts recording (`⏺ REC · tap to send`), a second stops it.
The second tap SUBMITS even with `voice.autoSubmit: false`, which is why the
engine's wire answers every request locally. Hold: spaces written as an
auto-repeat stream (every ~30ms) show `keep holding…`; when they stop the CLI
shows `Voice: processing…`. The transcription is painted into the input row
while speaking (an interim word followed by a U+2588 block), then replaced by
the final sentence.

## engineSettings

Speech-to-text does not go through `ANTHROPIC_BASE_URL`: with it pointed at a
dead port, tap recording still ran to `No speech detected`. So sinking the
engine's base URL at the wire costs the recorder nothing.

## REPAINT_MAX_MS

A resize repaints the whole screen from home (`\e[H`, every row erased, then
the banner and the `❯ ` row with its text), so a hidden xterm that joins
mid-stream gets the input row. Two resizes written back to back paint nothing:
the CLI reads the size once and sees it unchanged. So the engine waits for the
prompt mark after each resize, `+1` column and back (measured on 2.1.281, the
repaint arrived within 50ms).
