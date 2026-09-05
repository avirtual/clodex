# team-tickets.js

## REVIEWER_SHELL_ALLOW

`--permission-mode dontAsk` is what makes this list a wall: under
`--dangerously-skip-permissions` the CLI ignores `permissions.allow` and
`permissions.deny` entirely, so a shell reviewer inheriting the lead's bypass
posture would hold an unrestricted Bash with the allowlist present and inert.

Deny outranks allow in the CLI, so the tool denylist and this allowlist compose
rather than conflict: an allow entry cannot restore a tool the deny list turned
off.
