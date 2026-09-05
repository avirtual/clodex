# team-tickets.js

## REVIEWER_SHELL_ALLOW

THIS LIST IS NOT A WALL, measured against CLI 2.1.261. `permissions.allow` is a
PRE-APPROVAL list — it names what runs without a prompt, not what may run. A
command outside it is not denied; under `--permission-mode dontAsk` it simply
proceeds. Verified by hand: with `allow: ["Bash(git status:*)"]` and dontAsk,
`touch` and `rm -rf` both ran with no permission message. `manual` behaves the
same non-interactively.

`permissions.deny` DOES refuse. Deny also outranks allow, so a denylist and this
allowlist compose rather than conflict — but confining the shell to read-only
verbs needs the deny side (or a PreToolUse hook), not this list.

## REVIEWER_TOOL_CAP

The cap is an intersection for every tool except `Bash`, which
`REVIEWER_SHELL_ALLOW` admits beside it on a template's opt-in. A template that
lists Bash therefore resolves to the full cap plus Bash even when it named fewer
read tools; `beyondCap` deliberately does not report Bash, because reporting it
would print the "requires operator approval" warning about a grant this arm just
made on purpose.
