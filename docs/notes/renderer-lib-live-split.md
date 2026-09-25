# renderer/lib/live-split.js

## codexStripTop
Codex draws its slash menu and typed-command completions ABOVE the composer (menu block, one blank row, then `› /`), measured at 100x30 on Codex v0.157.0.

## isCodexComposerRow
Codex runs in the alternate buffer in every captured state; its `/model` picker marks the selected row `› 1. …`, which is why a numbered `›` row is not a composer.

## isLabeledRuleRow
Muse Code 1.4.0 puts a label in the rule above its composer (`── Voice input (⌥ + v to start) ───…`) and draws the slash menu below the composer, inside the closing rule.
