# renderer/lib/status-rows.js

## readStatusRows
Measured by scripts/explore/capture-status.js on a bare node-pty fed into `@xterm/headless` (2026-09-27), argv mirroring a pty seat: Claude Code 2.1.283 with `--settings` naming a `renderClaudeStatusScript` statusLine (default components `model,context,cost,cwd`; `claude-headless` gets the headless script, `claude-bypass` adds `--dangerously-skip-permissions`); Codex 0.157.1 with `--no-alt-screen -c tui.status_line=[…]` (`codex-yolo` adds `--dangerously-bypass-approvals-and-sandbox`); Muse Code 1.4.0 with no flags (`muse-never` adds `--approval-mode never --disable-sandbox`). The fixtures in test/fixtures/status-states/ are its screens, renamed.

On all three the spinner (`✻ Thinking…`, `• Working (…)`, `◆ Thinking (…)`) sits above the input, never below it; nothing below the input changes during a turn except Claude's statusline ctx and cost.

## readClaude
The rows below the closing rule are the Clodex statusline (`[clodex:<name>] …`, absent under headless) and the mode line, last. A custom statusline can paint a mode lookalike, so the scan is bottom-up.

Mode labels and glyphs: `⏵⏵` bypass permissions, accept edits, auto mode; `⏸` plan mode, manual mode (manual prints no `(shift+tab to cycle)`). Label colours are theme-dependent and unused. shift+tab cycle, five presses back to the start. With bypass (only when launched with it): bypass permissions → auto mode → manual mode → accept edits → plan mode. Without: manual mode → accept edits → plan mode → auto mode.

Right-hand column transients, cut before matching: `● high · /effort` shows at boot and after each submit and is gone after 5.9 s (claude-bypass-effort@100 vs claude-bypass@100: row 8 differs, row 9 identical); `Ctrl+Y to paste deleted text` after a Ctrl-U kill, which the inject queue's Ctrl-U writes trigger. A draft in the input drops `· ← for agents`; a `· 1 shell` segment drops `(shift+tab to cycle)`. `N shell` is the only background segment measured.

## readCodex
The footer block is the first `CODEX_STATUS_ROW` match in `at+1…at+6` plus the non-blank rows after it up to `at+6`: one row at `at+2`, two while the model loads or at narrow widths. Plan shows as `5h 46% lef… Plan mode` after the truncated left side at 100 cols and as its own column `Plan mode (shift+tab to cycle)` at 200. shift+tab toggles Default and Plan only; YOLO and approvals are not shown. F2 opens a full overlay (`  Warnings · 1 of 3 · Startup` at zero-based row 12) with no composer anchor, so it measures full/busy. No wiggle while idle.

## readMuse
The status row is model · effort · cwd · posture. The posture is `Auto-review` by default and `Launch overrides` under `--approval-mode never --disable-sandbox`. There is no cycle key: six shift+tab presses changed nothing. No wiggle below the input.
