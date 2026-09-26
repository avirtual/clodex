# renderer/lib/pty-composer.js

## PTY_NEWLINE
Measured on Claude Code v2.1.283 in tmux: `ESC CR` (`\x1b\r`) inserts a literal newline in the prompt, and one write of `reply ok\x1b\ronly\r` submitted a two-line prompt, so the chord survives inside a single burst.
