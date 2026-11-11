# suite-runner.js

## runJob
The engine runs git in a job tree only before `isolation.prepare`: once the suite user has written there, a planted `.git/config` would execute as the engine user, which has sudo in the image. Deps hits are linked before `prepare` for the same reason (the tree is still engine-owned); a miss is moved and linked back by the helper's `seal`. Pinned by the source-shape test in `test/suite-runner.test.js`.

## createSuiteRunner
`work` is resolved with `realpathSync`: `clodex-suite-exec` compares paths as strings against `pwd -P` of its work root, so a symlinked `<work>` (macOS `/var` → `/private/var`) would be refused.
`start()` resumes a recovered queue; a constructed runner does not pump until `start()`, a submit or a commit.

## maintain
Maintenance checks for a live job before each mirror gc and again before removing anything: a submit can land while `git gc` runs. `commit` waits for a running maintenance before `ingestPack`.

## noneIsolation
Runs the suite as the engine user with the scrubbed env only; it does not meet the no-credentials requirement and is for a loopback throwaway box.

## userIsolation
`sudo` resets the environment, so the job env travels to the helper as `KEY=VALUE` arguments for `env -i`, and `CLODEX_SUITE_WORK` / `CLODEX_SUITE_USER` cannot be overridden through sudo; they exist for the helper's shell test. `kill` calls the helper's `reap`: the engine user cannot signal the suite user's processes.
`reap` and `seal` kill every process of the suite user with one `kill -KILL -1` issued as that user (`setpriv`), which the kernel delivers in a single pass a forking process cannot outrun; `pkill` walks a process list and can miss a child forked after the walk. Because the kill reaches every suite process, `finish` reaps only a job that reached `setup`. The helper's `prepare` chowns `tree`, `home` and `tmp` but leaves the job directory engine-owned, so the suite user cannot swap `tree` for a symlink before `seal` moves paths out of it as root; `seal` also kills the suite user's processes before checking `tree`. Chowning only those three directories needs root, so no test covers it; the manual check below covers it.

Manual check, not machine-verifiable: the privilege drop and the image build need one run in the published image.

```
docker build -f docker/web/Dockerfile -t clodex-runner-check .
docker run --rm --entrypoint bash clodex-runner-check -c '
  set -e
  W=/var/lib/clodex-suite; mkdir -p $W/jobs/check1/tree $W/jobs/check1/home $W/jobs/check1/tmp
  sudo -n /usr/local/libexec/clodex-suite-exec prepare $W/jobs/check1; stat -c "%U %n" $W/jobs/check1 $W/jobs/check1/tree
  sudo -n /usr/local/libexec/clodex-suite-exec run $W/jobs/check1 HOME=/tmp -- sh -c "id -un; env | sort; cat /home/clodex/.clodex/x 2>&1 | head -1"
  sudo -n /usr/local/libexec/clodex-suite-exec prepare /etc || echo refused
  sudo -n /usr/local/libexec/clodex-suite-exec reap $W/jobs/check1; ls $W/jobs'
```

Expected: `clodex <job dir>` then `clodex-suite <job dir>/tree`; `clodex-suite`; an env of `HOME=/tmp` plus at most the shell's own `PWD`, `SHLVL`, `OLDPWD` (no `CLODEX_*`, no `CLAUDE_*`, no `PATH` from the engine); `Permission denied` for the `.clodex` read; `clodex-suite-exec: refusing /etc: …` then `refused`; an empty `jobs` listing.
