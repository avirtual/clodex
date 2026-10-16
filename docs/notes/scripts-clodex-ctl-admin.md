# scripts/clodex-ctl-admin.js

## contextsFile
HOME-based on purpose: clodexctl reads `~/.clodex/cli/contexts.json` from `os.homedir()`, not from `CLODEX_HOME`, so the launcher must read the same file the child will.

## runsDir
`ctl-runs/` lives beside `run/`, never under `run/<name>/`, which every exit path removes; run logs and records must survive a restart.

## tokenize
A copy of `tokenize` in ctl-service.js (same quoting and escapes, no shell). The script is copied flat into `~/.clodex/bin`, so it cannot require the original; change both together.

## childEnv
Deletes `CLODEX_URL`/`CLODEX_TOKEN`: the CLI's `resolve` lets env override an explicit `--ctx`, so an app environment carrying them would re-target every wire verb. `ELECTRON_RUN_AS_NODE=1` lets `CLODEX_NODE` (the Electron binary under the desktop app) run `CLODEX_CTL`, which is an asar path in the DMG; plain node ignores it.

## redact
`KEYED_TOKEN_RE` also accepts `=` before the key so a systemd `Environment=CLODEX_REMOTE_TOKEN=…` line is caught. The 48-hex pattern matches the `randomBytes(24)` wire token a deploy mints before it is saved. `redactionTokens` is re-read at child exit because a deploy saves a new token mid-run.

## runWorker
The clodexctl child is spawned `detached` so `process.kill(-pid)` at the ceiling reaches its ssh/aws/helm grandchildren too. The worker is a grandchild of the Electron main process (the exec dispatcher spawns the launcher), never of the seat's CLI, so the seat's credential sandbox does not wrap it. Progress dms are passive and capped at one per `THROTTLE_MS`; dm failures never abort the run. The result dm is sent after the record is written and the lock released.

## sweep
Reconciles on lock present + pid dead + no final record; it never re-runs anything. A record whose `workerPid` is still alive is skipped when re-sending undelivered results, so a worker mid-retry is not doubled.

## buildArgv
`-o json` is forced on every verb: every CLI prompt site throws `EXIT.USAGE` under `flags.json` before prompting (pinned in test/ctl-admin.test.js), so no built argv can block on stdin.

## deployLocator
A record with `ssh` and no `deploy.flavor` is inferred as an ssh-installer node; `docker` is only ever taken from `deploy.flavor`. Helm gets no `--port`: the carried values restore it.
