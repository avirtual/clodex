# renderer/popovers/voice-popover.js

## actionHtml

The unavailable button carries `aria-disabled` and `px-voice-dead`, never the
`disabled` ATTRIBUTE. It is the only entry point to this popover — `renderer.js`
routes `data-act="voice"` off a delegated `.px-action` click and nothing else
calls `openVoicePopover` — and `renderer/tooltip.js` is a delegated `mouseover`
→ `closest('[data-tip]')` listener. Chromium dispatches neither event over a
disabled form control, so a literal `disabled` takes BOTH channels that carry
the reason down with it and ships a dimmed button explaining nothing, against a
how-to that promises the popover names the cause. Nothing is settable through
the open popover regardless: `renderRows` omits `data-mode` on every row when
not capable, and the row click handler bails without it.

## recorderHtml

`data-rec` is what makes the indicator a CONTROL — the body click handler routes
it into `tapOffRecorder()` — so the `unavailable` state omits it. A machine that
cannot record has no recorder to tap off.
