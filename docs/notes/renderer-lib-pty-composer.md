# renderer/lib/pty-composer.js

## ptyComposerWrites
Measured on Claude Code v2.1.283 through node-pty on a bare pty (no tmux): writing `ESC[200~reply with exactly the word PONG ESC[201~` then `\r` as a separate write submitted one message (answer `PONG`); a paste carrying `first line is alpha\nsecond line is beta; …` then a separate `\r` arrived as one two-line prompt and was submitted (answer `alpha-beta`). A `\r` inside the same burst as the text is taken as pasted content, not Enter.
