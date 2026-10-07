# renderer/lib/voice-submit.js

## ptyTypedSinceEnter
The latch gates only the screen-mode space trigger (`spaceTriggerAction`); the conversation-mode composer runs its own emptiness test.
Fail-safe direction: unknown bytes count as typed, because a latch wrongly false turns a space typed mid-draft into a recording start, while one wrongly true only blocks voice until the next Enter.
Proven not to add prompt text: C0 controls outside the clearing set (`\r`, Esc, Ctrl-C, Ctrl-U), DEL, and OSC/DCS terminal replies. `PTY_AUTO_REPLY_RE` in proxy-util.js is the sibling list of terminal replies; they stay separate because that one decides "human input" for the inject latch and must count a mouse report as non-human, while this one decides "prompt has text" and an SGR mouse report is already a stripped CSI here.
