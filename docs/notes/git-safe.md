# git-safe.js

## safeGitArgs
Neutralised on every call: `core.fsmonitor`, `core.hooksPath`, `diff.external`, `core.sshCommand`, `core.pager`, `log.showSignature`, `commit.gpgSign`, `tag.gpgSign`, `gpg.program`, `gpg.ssh.program`, `gpg.x509.program`, `gpg.openpgp.program`, `merge.verifySignatures`, `core.alternateRefsCommand`, submodule recursion (`diff.ignoreSubmodules`, `status.submoduleSummary`, `submodule.recurse`, `fetch.recurseSubmodules`, `push.recurseSubmodules`), the `ext` and `git` protocols, `credential.helper` (reset, then the operator's system/global helpers re-added) and `core.askPass`; `--no-ext-diff --no-textconv` on diff/show/log, `--ignore-submodules=all` on status/diff, `--upload-pack=git-upload-pack` on fetch/pull/ls-remote and `--receive-pack=git-receive-pack` on push.
`-c remote.<n>.uploadpack=` does not override a repo-local value (git 2.52 keeps the first and warns "more than one uploadpack given"), so the pack programs are pinned by the subcommand flags instead.
In a partial clone, `diff`/`log`/`status` lazily fetch missing blobs through a child fetch that gets the `-c` prefix but not `--upload-pack`, so a repo-local `remote.<n>.uploadpack` runs; `-c remote.<n>.promisor=false`, `-c remote.<n>.partialclonefilter=` and `-c extensions.partialClone=` (empty or `none`) do NOT stop it, `--no-lazy-fetch` does (measured git 2.52), so the prefix leads with it. It needs git 2.45+; older git exits 129 on the unknown option.

`git status`/`git diff` recurse into a populated gitlink and the child git runs the nested repo's own clean filter, which `driverOverrides` never sees (it reads only the top repo's config); `--ignore-submodules=all` also hides a gitlink whose commit moved.
`git add` ignores `diff.ignoreSubmodules` and `submodule.recurse`: `add -- <gitlink>`, update-mode add and a glob pathspec matching the gitlink (with or without `--literal-pathspecs`) still run the nested repo's clean filter; restore, reset, checkout and `commit -m` do not (measured, git 2.52).
`fetch --all` (and `fetch.all=true`, git 2.44+) spawns one child `git fetch <remote>` per remote without forwarding `--upload-pack`, so `fetch.all=false` is pinned and Workbench's `remoteOp` fetches each remote by name.
With no operator `core.askPass`, the pinned empty value also stops git falling back to `SSH_ASKPASS` for an https password prompt.
`core.sshCommand=` (empty) breaks every ssh fetch/push with "fatal: unable to fork" (git 2.52), so the fallback is `ssh`; `GIT_SSH_COMMAND` in the env still wins over it.
`-c core.gitProxy=` (or `=none`) does not override a repo-local `core.gitProxy`: git keeps the first value it reads and `-c` is read last (measured git 2.52), so `protocol.git.allow=never` blocks git:// instead.
`protocol.ext.allow=never` also blocks a repo-local `url.<x>.insteadOf` that rewrites a normal remote to `ext::` (measured git 2.52), so `protocol.allow=user` is not needed.
`-c diff.external=` alone did not stop a planted `diff.external` on `git diff HEAD` (git 2.52); `--no-ext-diff` is what stops it.
`core.alternateRefsCommand=` (empty) makes git print "cannot run" and drop the alternate's haves, and a plain `for-each-ref` value gets the alternate path appended as a ref pattern and lists nothing; the trailing `#` swallows that argument, so the pinned value lists what the default does (measured git 2.52).

## lazyFetchPrefix
Runs `git --version` on the first `safeGitArgs` call, not at require time: the hosts require git-safe before `fixPathFromLoginShell`, and the launchd PATH would find a different git than the one later spawns run.
A failed probe (timeout, ENOENT) is not cached: the next call probes again, so one slow first spawn cannot turn the option off for the process.
git < 2.45: lazy fetch is not blocked, since no argv option stops it there; the box image ships 2.39 — upgrading the image's git closes it.

## driverOverrides
Blanks repo-local `merge.<n>.driver` as well as filters; an empty driver makes `git merge` report "cannot run" and leave a conflict instead of running it.
A driver name containing `=` cannot be blanked: git splits a `-c` argument at the first `=`, so `-c filter.a=b.clean=` sets the key `filter.a` instead; the name is refused instead.
An empty `filter.<name>.clean`/`smudge`/`process` makes git skip the driver instead of running it.

## operatorGitConfigFor
Measured on Apple Git 2.54 (Apple Git-157): the Xcode-shipped gitconfig that sets `credential.helper=osxkeychain` reports scope `unknown`, so `OPERATOR_SCOPES` includes it.
Cached per cwd for the process lifetime and never invalidated: a change to the operator's `core.hooksPath` or `core.sshCommand` takes effect after an app restart, and a value from an `includeIf "onbranch:…"` file stays the one resolved at the first lookup.
Measured on git 2.52: `git config --show-scope` reports a file pulled in by an `includeIf` in the global config as `global`, and one included from `.git/config` as `local`.

## repoFilterNames
`git config --local --get-regexp` skips `include.path` files unless `--includes` is given, and `--local` fails outside a repository (which would break `initRepo`'s `git init`), so the lookup reads every scope with `--show-scope` and keeps the names not in system or global scope.
