# renderer/lib/voice-submit.js

## ptyTypedSinceEnter
The latch gates only the screen-mode space trigger (`spaceTriggerAction`); the conversation-mode composer runs its own emptiness test.
Fail-safe direction: unknown bytes count as typed, because a latch wrongly false turns a space typed mid-draft into a recording start, while one wrongly true only blocks voice until the next Enter.
Every byte counts as typed except a named set that cannot add text (Ctrl-O verbose toggle, Ctrl-L redraw, DEL/backspace, cursor moves, deletions, Ctrl-T transpose) and OSC/DCS terminal replies; Tab, Ctrl-P/N history recall, Ctrl-Y yank, Ctrl-V image paste, Ctrl-R reverse search and Ctrl-_ undo insert text and are deliberately not in the set. `foldDraft` in hint-arm.js is the sibling draft tracker. `PTY_AUTO_REPLY_RE` in proxy-util.js is the sibling list of terminal replies; they stay separate because that one decides "human input" for the inject latch and must count a mouse report as non-human, while this one decides "prompt has text" and an SGR mouse report is already a stripped CSI here.
