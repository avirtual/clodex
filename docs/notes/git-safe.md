# git-safe.js

## safeGitArgs
`core.sshCommand=` (empty) breaks every ssh fetch/push with "fatal: unable to fork" (git 2.52), so the fallback is `ssh`; `GIT_SSH_COMMAND` in the env still wins over it.
`-c diff.external=` alone did not stop a planted `diff.external` on `git diff HEAD` (git 2.52); `--no-ext-diff` is what stops it.

## filterOverrides
A driver name containing `=` cannot be blanked: git splits a `-c` argument at the first `=`, so `-c filter.a=b.clean=` sets the key `filter.a` instead; the name is refused instead.
An empty `filter.<name>.clean`/`smudge`/`process` makes git skip the driver instead of running it.

## operatorGitConfigFor
Cached per cwd for the process lifetime and never invalidated: a change to the operator's `core.hooksPath` or `core.sshCommand` takes effect after an app restart.
Measured on git 2.52: `git config --show-scope` reports a file pulled in by an `includeIf` in the global config as `global`, and one included from `.git/config` as `local`.

## repoFilterNames
`git config --local --get-regexp` skips `include.path` files unless `--includes` is given, and `--local` fails outside a repository (which would break `initRepo`'s `git init`), so the lookup reads every scope with `--show-scope` and keeps the names not in system or global scope.
