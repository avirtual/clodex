# scripts/clodex-team.js

## readTeamLedger

This and `rollupTeam` are copies of team-cost.js's, duplicated for the reason
`projectDirFor` states: bin-materialize flat-copies this script into
`<REGISTRY_DIR>/bin/` by basename, so it may require node builtins only and a
`require('../team-cost')` would throw MODULE_NOT_FOUND at load, killing every
verb. test/clodex-team.test.js pins the copies against core.

## money

Cents below $100 are the whole signal — `$21.64` for a ticket; above it they are
noise against a total like `$4,212`.
