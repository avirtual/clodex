# review-gate.js

## stripReviewGated
Ported from Claude Code 2.1.286's prompt gate (the bundle's gated-set function and its `Fye` keep switch). On a CLI bump, re-extract that module from the binary and diff the rules; a 300k-string fuzz against the extracted `Fye` matched with zero differences.
