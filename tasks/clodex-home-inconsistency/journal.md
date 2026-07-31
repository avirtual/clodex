# t118 — CLODEX_HOME is honoured by the team layer, not by app core

## Decision: REGISTRY_DIR is the app's root. The team layer must follow it.

Decided 2026-07-31 by the lead. Not "remove the env var" and not "make core read
it" — both were the framings I carried in, and the code says a third thing.

## What the tree actually shows

Every reader of `process.env.CLODEX_HOME`, whole tree, vendor excluded:

- `team-manifest.js:32` `defaultClodexHome()` — the in-app team layer.
- `scripts/clodex-team.js:10` — the standalone exec script.
- `plugins/tickets-viewer/engine.js` — correct, mirrors `team-manifest`.
- tests.

`session-manager.js:2464` is NOT a reader and is the decisive evidence: it
expands the literal token `${CLODEX_HOME}` in exec argv to **`REGISTRY_DIR`**.
The token already means "the app's root", not "the environment variable". Core's
root is `engine.js:133` `path.join(os.homedir(), '.clodex')`, bare homedir, and
`main.js` / `headless-main.js` derive it the same way.

So with the variable set, teams resolve to one tree while memory, messages,
pending, peer-outbox, `run/` and skill-plugins resolve to another. Latent only
because it is unset in the app today.

## Why this direction

`createTeamManifest({ fs, clodexHome })` (`team-manifest.js:82`) **already has
the seam** — `clodexHome || defaultClodexHome()`. `engine.js:398` constructs it
as `createTeamManifest({ fs })` and simply never passes one, so the env-var
fallback wins by omission rather than by decision. The fix is to pass what every
other subsystem already uses.

The env var must STAY for `scripts/clodex-team.js`: it is a separate process
with no access to `REGISTRY_DIR`, and `test/clodex-team.test.js` needs the seam.
It is a test/IPC seam for a standalone script, not app configuration.

Rejected — "make `REGISTRY_DIR` honour `CLODEX_HOME`": it would move `~/.clodex`
for real, which is a migration with live sessions, registries and sockets in it,
bought for a variable nobody sets. The hand already flagged this shape when it
refused my wrong fix on memory-viewer: core is bare homedir, so anything that
"fixes" a plugin toward the env var CREATES the divergence.

## Implementation (filed separately, unassigned)

1. `engine.js:398` → `createTeamManifest({ fs, clodexHome: REGISTRY_DIR })`.
2. The exec child must agree by construction. `resources/library/exec/clodex-team.json`
   spawns `${CLODEX_BIN}/clodex-team.js` and `session-manager.js:2478` spawns
   with **no `env` key**, so the child inherits the app's environment. If
   `CLODEX_HOME` is set in the app's env the child follows it while the app no
   longer does — the same split, relocated. Set `CLODEX_HOME=REGISTRY_DIR`
   explicitly in the exec spawn env. There is no `--home` flag; the env is the
   only channel.
3. Red-first test: set `CLODEX_HOME` to a tree that is NOT `REGISTRY_DIR`, and
   assert the teams root follows `REGISTRY_DIR`. That case fails today.

Do NOT let the test assert only that the two agree when the variable is unset —
they agree then whatever the code does, which is the vacuity shape this repo
spent the night on. The fixture must make them differ.
