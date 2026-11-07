# accounts.js

## SHARED_LINKS

The five names shared by symlink so every account sees one roster and one
transcript history. `history.jsonl`, `todos`, `shell-snapshots` and `statsig`
are deliberately NOT here: they churn per dir and sharing them makes two
accounts fight over one file. `~/.claude.json` itself is never copied either —
it is ~700KB of per-project state, which is why `mint` writes a fresh minimal
one instead.

## mint

A `SHARED_LINKS` target that does not exist in `claudeHome` is skipped rather
than linked: the Claude CLI treats a dangling symlink as a present-but-broken
directory, which is worse than an absent one.

## save

`fs.writeFileSync`'s `mode` applies only when the call CREATES the file, so the
explicit `chmodSync` is what keeps a `.tmp` left behind by an earlier crash at
0600. `renameSync` carries that mode onto the registry, which is therefore never
chmod'd in place.

## modelSelects

`fable` is an alias, not an id: the operator writes `--model fable` and the CLI
resolves it to a dated `claude-fable-*`. Matching has to work in both
directions because a live seat's `extraArgs` may carry either spelling.

## createAccounts

`claudeConfigFile` derives from `path.dirname(claudeHome)` because `~/.claude`
pairs with `~/.claude.json` — a sibling, not a child. Deriving it keeps a test's
fake home self-consistent.

## setApiKey

A key is 1–`API_KEY_MAX` (512) characters with no whitespace; a pasted trailing
newline is refused rather than trimmed. `default` is refused, and so is any
registered account whose config dir is `claudeHome`: that settings.json is the
operator's real `~/.claude/settings.json`. An existing settings.json that does
not parse as a JSON object is refused rather than replaced, so a hand-edited
file with a typo is never clobbered.

## resync

The account's own `env.ANTHROPIC_API_KEY` is read before the copy and written
back after it (`restoreKey`); a key in the default settings.json is stripped, so
a keyless account stays keyless. A default settings.json that is not a JSON
object is refused for a keyed account (copying it would drop the key) and
copied raw for a keyless one.
