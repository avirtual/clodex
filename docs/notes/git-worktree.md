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
