# team-tickets.js

## REVIEWER_SHELL_DENY

Measured against CLI 2.1.261. `permissions.deny` refuses; `permissions.allow`
does NOT — it is a pre-approval list naming what runs without a prompt, so a
command merely absent from an allowlist still runs. The wall has to be built
from the deny half, which is why this list names what must not run rather than
what may.

Deny survives `--dangerously-skip-permissions`, which is what lets the shell arm
inherit the lead's posture like every other seat. Verified by hand under bypass:
`touch`, `rm -rf`, `git commit --allow-empty` were each refused with
"Permission to use Bash with command … has been denied" and the disk confirmed
untouched, while `git status` and `node --test` ran.

Matching is prefix-on-argv, so a spelling of the same operation needs its own
rule — `sed -i` and `sed --in-place` are two entries. It cannot see shell
syntax at all: `echo x > f` writes the file under a full deny list (measured).
Redirection is therefore owned by the reviewer-shell prompt, not by this list,
and no addition here can close it.

## REVIEWER_TOOL_CAP

The cap is an intersection for every tool except `Bash`, which
`REVIEWER_SHELL_DENY` admits beside it on a template's opt-in. A template that
lists Bash therefore resolves to the full cap plus Bash even when it named fewer
read tools; `beyondCap` deliberately does not report Bash, because reporting it
would print the "requires operator approval" warning about a grant this arm just
made on purpose.

## _reviewLedger

The model is taken on the session-ID gate alone, outside the cost check beside
it. That check exists to avoid overlaying an unobserved spend onto a recorded
one, which says nothing about which model billed. This is also the only moment
the model is legible: wire-totals.json rows carry no model field, and the seat
is reaped seconds later.
