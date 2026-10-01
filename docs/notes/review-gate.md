# review-gate.js

## stripReviewGated
Ported from Claude Code 2.1.286's prompt gate (the bundle's gated-set function and its `Fye` keep switch). On a CLI bump, re-extract that module from the binary and diff the rules.

## defuseSenderLines
The match runs on the line with every `\p{C}`, `\p{M}` and Default_Ignorable code point removed, a superset of what the inject strip deletes, because `stripReviewGated` keeps a bidi mark beside a non-letter on a line with an RTL letter. The `> ` goes on the original bytes, so a line without a marker is unchanged.
