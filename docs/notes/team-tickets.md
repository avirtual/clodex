# team-tickets.js

## REVIEWER_SHELL_DENY

Measured against CLI 2.1.261. `permissions.deny` refuses; `permissions.allow`
does NOT — it names what runs without a prompt, so a command absent from an
allowlist still runs. Hence a denylist, not an allowlist.

Deny survives `--dangerously-skip-permissions`, which is what lets the shell arm
inherit the lead's posture like every other seat. Verified by hand under bypass:
`touch`, `rm -rf` and `git commit` were refused and the disk confirmed
untouched, while `git status` and `node --test` ran.

Matching is prefix-on-argv, so each spelling needs its own rule — `sed -i` and
`sed --in-place` are two entries. It cannot see shell syntax: `echo x > f`
writes under a full deny list (measured), so redirection is owned by the
reviewer-shell prompt and no addition here closes it.

## REVIEWER_TOOL_CAP

The cap is an intersection for every tool except `Bash`, which
`REVIEWER_SHELL_DENY` admits beside it on a template's opt-in — so a template
listing Bash gets the full cap plus Bash even when it named fewer read tools.
`beyondCap` deliberately omits Bash: reporting it would print the "requires
operator approval" warning about a grant this arm just made on purpose.

## _reviewLedger

The model is taken on the session-ID gate alone, outside the cost check beside
it. That check exists to avoid overlaying an unobserved spend onto a recorded
one, which says nothing about which model billed. This is also the only moment
the model is legible: wire-totals.json rows carry no model field, and the seat
is reaped seconds later.

## _taskStart

The `reviewer:` validation sits above `_mintTicketSeat`: a refusal below it has
already reserved the seat name and cut the worktree. `ticket.reviewerTemplate`
is written above BOTH save arms — the one-shot arm returns before the second
save, so a write below it survives only on the standing-seat path.
