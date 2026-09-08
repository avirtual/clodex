# team-prompt-dir.js

## teamTemplatePath

Resolves `<teamsDir>/<team>/templates/<stem>.json` WITHOUT creating anything: an
unknown team is a refusal, never an mkdir, so a typo in a save cannot mint a team
directory. `team.json` is never written by this path. `teamPromptPath` is the same
shape for `prompts/<kind>/<stem>.md`.

## teamPromptRemove

A role def names a SYSTEM prompt stem (`prompt`) and a template stem
(`template`); nothing in `team.json` names an append stem. So the caller's
"still named by a role" guard applies to `system` only — guarding `append` would
refuse on a dependency that cannot exist, leaving the lead unable to delete it.
