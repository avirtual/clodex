# docs/notes/stores.md

## seedEnvDefaults

The `seeded` list on env-scopes.json is what makes an operator's DELETION stick.
A key absent from the global scope is written only while it is also absent from
that list, so seed-if-absent alone would restore a deleted default on the next
launch. `envScopes._load` normalizes the whole file, so it must carry `seeded`
through or every save drops it and re-arms the seeder.

The NODE_TEST_CONTEXT refusal keys on `registryDir`, not on the userData path,
because engine.js passes the real `~/.clodex` and the real userData together —
a test that forgets the seam would otherwise write the operator's live
env-scopes.json.

## envDefaults

`restore` clears the shipped keys off `seeded` and calls the seeder rather than
writing values itself, so "absent keys come back, edited ones are left alone"
has one implementation.

## refuseEnvWriteUnderTest

Shared between `seedEnvDefaults` and `envDefaults.restore` (t681): `restore`
used to clear `seeded` and save BEFORE this same refusal ran, only inside
`seedEnvDefaults`, so a refused restore still stripped the shipped keys off
the list and left the seeder re-armed for the next real launch.
