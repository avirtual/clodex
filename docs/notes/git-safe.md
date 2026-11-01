# git-safe.js

## SAFE_SETTINGS
`core.sshCommand=` (empty) breaks every ssh fetch/push with "fatal: unable to fork" (git 2.52), so the override is `ssh`; `GIT_SSH_COMMAND` in the env still wins over it.
`-c diff.external=` alone did not stop a planted `diff.external` on `git diff HEAD` (git 2.52); `--no-ext-diff` is what stops it.

## safeGitArgs
`keepHooks` exists for the merge gate's merge/commit/revert in the team root: the operator's global `core.hooksPath` pre-commit hook must keep running there.
