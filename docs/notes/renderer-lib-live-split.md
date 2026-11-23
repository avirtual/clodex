# renderer/lib/live-split.js

## codexStripTop
Codex draws its slash menu and typed-command completions ABOVE the composer (menu block, one blank row, then `› /`), measured at 100x30 on Codex v0.157.0.

## isCodexComposerRow
Codex runs in the alternate buffer in every captured state; its `/model` picker marks the selected row `› 1. …`, which is why a numbered `›` row is not a composer.
Codex echoes every past prompt in its history as a `› text` row, so the composer is the `›` row with a `Context N% used` or `? for shortcuts` footer within six rows beneath it and no other `›` row between; the boot screen has only `? for shortcuts` until the model loads, and a draft wrapped to four rows pushes the footer to i+5 (Codex v0.157.1, 100x40).

## isLabeledRuleRow
Muse Code 1.4.0 puts a label in the rule above its composer (`── Voice input (⌥ + v to start) ───…`) and draws the slash menu below the composer, inside the closing rule.

## measureSplit
`busy` on an unanchored screen means some row carries text (a picker, dialog or spinner is drawn); a blank screen is a CLI still booting, which has nothing to show in a sheet, so it keeps the whole-terminal view.

## workingPane
clodent paints no prompt row during a turn, so a busy activity state (its prompt-submit to stop hooks) stands in for the anchor: `measureSplit` returns a zero-row split (`at: -1`), the pane alone. An ask at the cursor is checked first and still wins.

## museStripIsIdle
Muse Code 1.4.0 keeps its input strip while a picker such as `/model` is open and draws the picker below the bottom rule, so more than the status row below that rule is not an idle prompt.

## isClodentPromptRow
clodent writes `\x1b[?2004h` immediately before every `> ` prompt and leaves paste mode on through the turn, and it streams model text unbuffered, so a quoted `> ` line mid-turn renders exactly like an idle prompt (bottom row, cursor on it, nothing below); only the row where the last `?2004h` was parsed (the view's prompt marker) tells them apart.

## isClodentAsk
While `Allow? [y/n] ` is on screen the ask is answerable only in the terminal and is not in the transcript, so `measureSplit` reports it unbusy and the view shows the plain full terminal rather than the sheet.
