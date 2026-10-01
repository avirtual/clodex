# voice-engine.js

Measured 2026-09-24 against CLI 2.1.281 in a raw pty with no terminal attached
and a focus-out (`\e[O`) written before the key.

## RECORD_KEY

Space, the default `voice:pushToTalk` binding. The recorder starts and stops
with the pty unfocused and nothing visible, so a hidden seat can record.

## planRecord

Tap: one space starts recording (`⏺ REC · tap to send`), a second stops it.
The second tap SUBMITS even with `voice.autoSubmit: false`, which is why the
engine's wire answers every request locally. The transcription is painted into the input row
while speaking (an interim word followed by a U+2588 block), then replaced by
the final sentence.

Probe 2026-09-24, CLI 2.1.281, `say -r 150 "hello world enter"` into the mic.
The block after the text is the level meter, drawn in the cursor cell as any
of U+2581..U+2588 and re-drawn on a ~50ms tick while any sound reaches the mic.
Tap: `❯ ▁`..`❯ █` (meter only), `❯ Hello█`, `❯ Hello▇`..`❯ Hello▂`,
`❯ Hello world▂`, `❯ Hello world enter.▂` (then `.▅`, `.▆`, `.▇`, `.█`, ...
for as long as the room is not silent); on the stop tap `❯ Hello world enter.`,
`❯ Hello world, enter.`, then the row clears (the CLI submits) to `❯`.

`recording` is reconciled from the engine screen before every tap: the CLI's tap recorder stops itself after its silence timeout (`No speech detected`) with no signal to the pty owner (observed 2026-09-25 01:40; one tap out of phase silenced every later sentence).

## engineSettings

Speech-to-text does not go through `ANTHROPIC_BASE_URL`: with it pointed at a
dead port, tap recording still ran to `No speech detected`. So sinking the
engine's base URL at the wire costs the recorder nothing.

The engine is the only CLI on the box that receives a voice section, and it
receives it inline in its `--settings` JSON (`voice.mode`, `voiceEnabled`);
Clodex no longer reads or writes `~/.claude/settings.json` for voice. A seat's
mode lives in its own record.

## REPAINT_MAX_MS

A resize repaints the whole screen from home (`\e[H`, every row erased, then
the banner and the `❯ ` row with its text), so a hidden xterm that joins
mid-stream gets the input row. Two resizes written back to back paint nothing:
the CLI reads the size once and sees it unchanged. So the engine waits for the
prompt mark after each resize, `+1` column and back (measured on 2.1.281, the
repaint arrived within 50ms).

## RECORDING_INDICATOR

The CLI's recording indicator lands in the buffer as `⏺ REC · tap to send`,
U+23FA U+0020 R E C (outerHTML of a live row, identical on two boxes). The DOM
puts the bullet in its own span only for letter-spacing; that is a styling
boundary, not a cell boundary. A space-less rule matched nothing for its whole
life while the mic was live — do not close the space.

The trailing `(?!\w)` is what makes the space safe: the bare-space and `\s*`
forms also match `⏺ RECOVERY.md` and `⏺ RECORD the thing` (measured against
real rows), and a phantom lit recorder arms a mic nobody asked for. Bullet and
space are spelled as escapes because a pasted glyph is one editor
normalisation away from a rule that matches nothing.

U+23FA is the macOS glyph; every other platform paints U+25CF. Clodex ships
macOS-only, so the rule is dark off macOS.

## PROCESSING_INDICATOR

The CLI's processing indicator (2.1.251 binary) REPLACES the lit one rather than joining it:
when recording stops, `⏺ REC` is gone and this is painted in its place while
the CLI finishes transcribing.

Anchored on `Voice:` + `processing` and nothing else. The CLI's literal ends in
a single U+2026, one editor normalisation away from three ASCII dots, so the
ellipsis is not encoded. `\s*` rather than a literal space because JS `\s`
admits U+00A0.
