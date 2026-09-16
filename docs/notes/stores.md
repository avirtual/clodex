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

## getDefaultSkillDeny

Deliberately NOT filtered against a skill catalog, unlike `getDefaultDeny` and
`getDefaultBuiltinDeny`. Skill names are cwd-dependent — a project skill exists
only under its own tree — so a name absent from the global catalog is still a
real default, and filtering would silently drop it the first time Preferences
was opened anywhere else.

A stored NON-EMPTY explicit list (no `*`) is upgraded on read to
`deferredSkillDeny(known − stored)` and written back once, using the
`knownSkillNames` dep `initStores` takes (the store never reaches into the
engine). Such a list was written before t918 and is a snapshot of what was known
that day, so every skill the CLI syncs afterwards arrived enabled. A stored
deferred list is returned byte-identical with no write; an explicit `[]` stays
`[]`, because it is the only shape the UI has for "deny nothing" and expanding
it would deny every later-synced skill. Without the dep — a store built by a
test or a host that has no catalog — the stored list is returned unchanged.
