# review-gate.js

## stripReviewGated
Ported from Claude Code 2.1.286's prompt gate (the bundle's gated-set function and its `Fye` keep switch). On a CLI bump, re-extract that module from the binary and diff the rules.

## defuseSenderLines
A line is quoted when it starts with `[agent:from` after `stripReviewGated` and the removal of leading whitespace, control, mark and default-ignorable characters; the `> ` goes on the original bytes, so a line without a marker is unchanged.
