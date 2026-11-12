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

`prepare <job> <mirror> [<entry>]` closes every mirror (mode 0700) and opens the job's own one to the `clodex-suite` group (0750, read-only): the job tree reads its objects through `.git/objects/info/alternates`, so the mirror cannot be denied outright. `reap` closes every mirror again. Only one job runs at a time, so one open mirror is enough. Deps entries follow the same rule: at rest every entry is 0700 and every marker 0600 under `deps/` and `deps/<repoKey>` at 0711 (no listing), `prepare` closes every entry and opens only the job's own one to the group (0750), `seal` leaves the entry it built at 0750 to the group, and `reap <job> <entry>` closes that entry. An entry's name is sha256 of `setup.run`, the key files and the `envKey` that `/api/suite/info` serves, so another tenant can compute it: the mode is the barrier, not the name. The cache index `cache.json` stays out of the work root, and `createSuiteRunner` resets every mirror to 0700 and every deps entry and marker to 0700/0600 at start. The group switch needs root: the helper's shell test covers the path refusals and `reap`'s close of exactly the named entry, source-shape pins cover `prepare`'s and `seal`'s mode lines, and only the manual check below proves the suite user's actual view.

## jobPaths
A job's work dir is `jobs/<first 8 hex of sha256(id)>`, so the tree, home and temp dir under the default work root are 40, 40 and 39 bytes whatever the id: Unix socket paths a suite creates under `TMPDIR` must stay under 108 bytes (104 on macOS). The job record and store keep the full id.

## envIdentity
`imageVersion` and `imageRev` come from `/etc/clodex/image.json`, which the Dockerfile writes from the `CLODEX_VERSION` and `CLODEX_GIT_SHA` build args that `scripts/publish-image.sh` passes; both are in the hash behind `envKey`.

## moveState
The runner's state (`statePaths`: the job store, `cache.json` and `ledger.jsonl`) lives under `CLODEX_DATA_DIR` when it is set (`/data/suite-runner` in the image, on the data volume and under `/data` at 0700), else under the Clodex home; `suiteRunnerOptions` in remote-wiring.js passes the Clodex home as `oldRoot`, and `moveState` moves what it finds there on start. The container layer and the volume are different filesystems, so the move falls back from `rename` to a copy on `EXDEV`. A job id already at the new place keeps the new copy, and the old ledger is prepended to the new one.

Manual check, not machine-verifiable: the privilege drop, the mirror and deps isolation and the image build need one run in the published image.

```
docker build -f docker/web/Dockerfile -t clodex-runner-check .
docker run --rm --entrypoint bash clodex-runner-check -c '
  set -e
  W=/var/lib/clodex-suite; X="sudo -n /usr/local/libexec/clodex-suite-exec"
  for j in check1 check2 check3; do mkdir -p $W/jobs/$j/tree $W/jobs/$j/home $W/jobs/$j/tmp; done
  M=$W/mirrors; A=$M/$(printf "a%.0s" {1..40}).git; B=$M/$(printf "b%.0s" {1..40}).git
  DA=$W/deps/$(printf "a%.0s" {1..40})/$(printf "e%.0s" {1..64}); DB=$W/deps/$(printf "b%.0s" {1..40})/$(printf "f%.0s" {1..64})
  mkdir -p -m 0711 $M $W/deps; mkdir -m 0711 $(dirname $DA) $(dirname $DB); mkdir -m 0700 $A $B $DA $DB
  echo own > $A/HEAD; echo other > $B/HEAD; echo A-deps > $DA/stamp; echo B-deps > $DB/stamp
  $X prepare $W/jobs/check1 $A $DA; stat -c "%U %n" $W/jobs/check1 $W/jobs/check1/tree; stat -c "%a %G" $A $B $DA $DB
  $X run $W/jobs/check1 HOME=/tmp -- sh -c "id -un; env | sort; cat /home/clodex/.clodex/x 2>&1 | head -1; cat $A/HEAD; ls $M 2>&1 | head -1; cat $B/HEAD 2>&1 | head -1; ls $W/deps 2>&1 | head -1; cat $DA/stamp; cat $DB/stamp 2>&1 | head -1; cat $W/cache.json /data/suite-runner/cache.json 2>&1 | head -2"
  $X prepare /etc || echo refused
  $X reap $W/jobs/check1 $DA; stat -c "%a" $A $DA
  $X prepare $W/jobs/check2 $B $DB
  $X run $W/jobs/check2 HOME=/tmp -- sh -c "ls $W/deps 2>&1 | head -1; ls $(dirname $DA) 2>&1 | head -1; cat $DA/stamp 2>&1 | head -1; cat $DB/stamp"
  $X reap $W/jobs/check2 $DB
  $X prepare $W/jobs/check3 $A $DA; $X run $W/jobs/check3 HOME=/tmp -- cat $DA/stamp; $X reap $W/jobs/check3 $DA
  ls $W/jobs; stat -c "%a" $A $B $DA $DB'
```

Expected: `clodex <job dir>` then `clodex-suite <job dir>/tree`; `750 clodex-suite`, `700 clodex`, `750 clodex-suite`, `700 clodex`; `clodex-suite`; an env of `HOME=/tmp` plus at most the shell's own `PWD`, `SHLVL`, `OLDPWD` (no `CLODEX_*`, no `CLAUDE_*`, no `PATH` from the engine); `Permission denied` for the `.clodex` read; `own`; `Permission denied` for the `ls` of the mirrors and for the other mirror's `HEAD`; `Permission denied` for the `ls` of `deps`; `A-deps`; `Permission denied` for B's entry; `No such file or directory` for `$W/cache.json` and `Permission denied` for `/data/suite-runner/cache.json` (the index's real path; `/data` is 0700); `clodex-suite-exec: refusing /etc: …` then `refused`; `700` twice. From B's job (check2): `Permission denied` for the `ls` of `deps`, for the `ls` of A's repo dir and for A's entry read by its exact name, then `B-deps`. A's job again (check3): `A-deps`. Last, an empty `jobs` listing and `700` four times.
