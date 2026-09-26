# renderer/lib/pty-composer.js

## ptyComposerWrites
Measured on Claude Code v2.1.283 through node-pty on a bare pty (no tmux): writing `ESC[200~reply with exactly the word PONG ESC[201~` then `\r` as a separate write submitted one message (answer `PONG`); a paste carrying `first line is alpha\nsecond line is beta; …` then a separate `\r` arrived as one two-line prompt and was submitted (answer `alpha-beta`). A `\r` inside the same burst as the text is taken as pasted content, not Enter.

## pasteKind
Measured 2026-09-26 in a tmux pty with a PNG on the macOS clipboard: writing `\x16` (Ctrl-V) makes claude 2.1.283, codex 0.157.1 and muse 1.4.0 each read the clipboard image and show `[Image #1]` in their input row; on claude a following bracketed paste appends text after the chip.
