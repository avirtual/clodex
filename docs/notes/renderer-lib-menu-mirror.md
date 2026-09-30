# renderer/lib/menu-mirror.js

## BACKSPACE
`\x7f` is the byte scripts/explore/capture-menu.js sends in its `backspace` step; Claude Code 2.1.283, Codex 0.157.0 and Muse Code 1.4.0 each deleted one character and re-filtered the menu on it (t1212, docs/notes/renderer-lib-menu-rows.md).

## createMenuMirror
Escape erases the mirrored draft and sends no ESC byte: a bare ESC to a CLI mid-turn interrupts the turn, and an emptied input closes the menu on its own. Measured 2026-09-30 with scripts/explore/capture-menu.js, STEPS set to `/`, `c`, `o`, then `\x7f` ×3 (no alt steps): Claude Code 2.1.285, Codex 0.157.1 and Muse Code 1.4.0 each showed an empty prompt with no menu rows after the third backspace.
