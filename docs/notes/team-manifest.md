# team-manifest.js

## copyRoleTemplates

Writes through this module's own `atomicWrite`, not team-prompt-dir's
`teamTemplateSave`: the saver refuses a team `listTeams()` does not carry, which
during a `createTeam` is every team — the manifest is written after this runs.

`unwindTemplateCopies` deletes the copies made for one call, then the
`templates/` directory with `rmdir`, which refuses a non-empty one — that refusal
is what keeps a failed `addRole` against a live team from taking the copies its
other roles already own. Both throwing sides run it: a copy that fails mid-loop,
and a `team.json` write that fails after the copies landed.

It leaves `teams/<name>/` itself in place, which `listTeams` reports as a team —
unchanged from before, where the manifest write's own `ensureDir` created it.

The kickstart create's brief-save cleanup (team-tickets.js `_handleTeamCreate`)
unwinds the same copies by hand, over `team.templatesCopied`, before its own
`rmdir` of the team directory — that `rmdir` refuses a non-empty one, so a copy
left behind leaves a manifest-less team `listTeams` still reports while the reply
says no team was created.

`repointOnly` is the `addRole` pre-check arm. It repoints a def whose copy is
already on disk and writes nothing, so the exact-match comparison downstream runs
against a def shaped the way a stored one is. Without it `team:join`'s re-ride of
the stock def compares `clodex-team-hand` against a role already pointing at
`hand` and throws "already exists with a different definition".

## copyRolePrompts

The prompt twin, copying bytes VERBATIM where the template copy restamps `name`
and cuts `LISTING_KEYS` — a template's `name` addresses the seat, a prompt's path
is its only address.

`unwindPromptCopies` rmdirs `prompts/system` then `prompts`, children first, both
refusing a non-empty directory. That refusal is load-bearing in a way the template
unwind never faces: the kickstart create puts the team brief at
`prompts/append/team-project.md`, so `prompts/` holds a file these copies do not
own. That same cleanup unwinds these over `team.promptsCopied`.
