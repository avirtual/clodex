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

## copyRolePrompts

The prompt twin of `copyRoleTemplates`, and the reason both exist separately: a
template copy is REWRITTEN on the way out (`name` restamped to the role,
`LISTING_KEYS` cut) because a template's `name` is what addresses the seat, while
a system prompt is addressed only by its path, so this one copies bytes verbatim.

`unwindPromptCopies` rmdirs `prompts/system` and then `prompts`, children first,
and both rmdirs refuse a non-empty directory. That refusal is load-bearing here in
a way the template unwind never faces: the kickstart create saves the team brief
to `prompts/append/team-project.md`, so `prompts/` is shared with a file these
copies do not own and must survive their unwind.

The kickstart create's brief-save cleanup (team-tickets.js `_handleTeamCreate`)
unwinds these by hand over `team.promptsCopied`, like the templates, and its
`prompts/system` rmdir must run before its `prompts` one.
