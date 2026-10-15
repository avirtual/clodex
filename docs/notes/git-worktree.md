# git-worktree.js

## hasCommit

`git worktree add <path> HEAD` fails `fatal: invalid reference: HEAD` on a repo
with no commits (measured), so a team rooted on one refuses its first ticket.
The probe is `git rev-parse --verify --quiet HEAD`: exit 1 on the unborn branch,
a sha otherwise — a nonzero exit here is an answer, not a failure to run.

## initRepo

The `-c user.name` / `-c user.email` pair on the commit is load-bearing: a box
with no configured git identity (CI, docker) fails `git commit` and would leave
a commitless repo behind — exactly the state `hasCommit` exists to keep teams
out of.

## diffText

`-U20` is measured, not taste: over 16 cold reviewer rounds, 55 of 87 ranged
source reads of a touched file landed within 25 lines of a hunk the diff already
carried. At git's default 3 the diff answers almost none of them. The trade is
size — the largest observed round-1 diff (96KB) roughly doubles.

`headSha` is the full sha the `head` ref resolved to, taken from the `rev-parse
--verify` already run for the existence check. Callers stamp it on a record that
outlives the branch's position, where the ref name would later resolve somewhere
else. Null on every failure arm, so a failed diff cannot be stamped.

## headLogSync

`%h %s` on one line, so the subject may be empty (a commit with a blank subject)
and the parse tolerates that. 2s timeout: the only caller is on the resume-handoff
write path, where a hung git must not hold the handoff.

## relativizeWorktreePointers

The two pointer files are rewritten by hand because `git worktree add --relative-paths` (git >=2.48) sets
`extensions.relativeworktrees`, and the sandbox box's git 2.39 refuses the whole repo with that extension set;
plain relative pointers with no extension work on both sides (measured). `.clodex-wt/` must stay in `.gitignore`.
Measured on the box's git 2.39.5: `git worktree list` shows the in-root tree `prunable`, and `git worktree prune` there removes `.git/worktrees/<n>`, killing the tree on both sides.
Recovery on the host (git 2.52, tmp repo): `git worktree repair <tree>` fails ("does not reference a repository"); moving the dir aside and running `git worktree add --force <tree> <branch>` recreates the entry on the branch's committed tip, then `relativizeWorktreePointers` again and copy uncommitted files back from the moved-aside dir.
