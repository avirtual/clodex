# git-safe.js

## safeGitArgs
`core.sshCommand=` (empty) breaks every ssh fetch/push with "fatal: unable to fork" (git 2.52), so the fallback is `ssh`; `GIT_SSH_COMMAND` in the env still wins over it.
`-c diff.external=` alone did not stop a planted `diff.external` on `git diff HEAD` (git 2.52); `--no-ext-diff` is what stops it.

## filterOverrides
A driver name containing `=` cannot be blanked: git splits a `-c` argument at the first `=`, so `-c filter.a=b.clean=` sets the key `filter.a` instead; the name is refused instead.
An empty `filter.<name>.clean`/`smudge`/`process` makes git skip the driver instead of running it.

## operatorGitConfig
Memoised for the process: a change to the operator's global `core.hooksPath` or `core.sshCommand` takes effect after an app restart.
