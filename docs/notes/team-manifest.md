# team-manifest.js

## copyRoleTemplates

Writes through this module's own `atomicWrite`, not team-prompt-dir's
`teamTemplateSave`: the saver refuses a team `listTeams()` does not carry, and
during a `createTeam` that is every team — the manifest it would be listed by is
written after this runs.

`unwindTemplateCopies` deletes the copies made for one call, then the
`templates/` directory with `rmdir`, which refuses a non-empty one — that refusal
is what keeps a failed `addRole` against a live team from taking the copies its
other roles already own. Both throwing sides run it: a copy that fails mid-loop,
and a `team.json` write that fails after the copies landed.

It leaves `teams/<name>/` itself in place. `listTeams` reports that directory as
a team, so a refused create is visible in the listing until something removes it
— unchanged from before this, where the same directory was created by the
manifest write's own `ensureDir`.

The kickstart create's brief-save cleanup (team-tickets.js `_handleTeamCreate`)
unwinds the same copies by hand, over `team.templatesCopied`, and must delete
them before its own `rmdir` of the team directory — that `rmdir` refuses a
non-empty directory, so a copy left behind leaves a team dir with no manifest
that `listTeams` still reports while the reply says no team was created.

`repointOnly` is the `addRole` pre-check arm. It repoints a def whose copy is
already on disk and writes nothing, so the exact-match comparison downstream runs
against a def shaped the way a stored one is. Without it `team:join`'s
unconditional re-ride of the stock def compares `clodex-team-hand` against a role
already pointing at `hand` and throws "already exists with a different
definition".
