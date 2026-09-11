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

`fs.writeFileSync`'s `mode` option applies only when the call CREATES the file,
so the explicit `chmodSync` afterwards is what keeps an already-existing
registry at 0600.

## modelSelects

`fable` is an alias, not an id: the operator writes `--model fable` and the CLI
resolves it to a dated `claude-fable-*`. Matching has to work in both
directions because a live seat's `extraArgs` may carry either spelling.

## createAccounts

`claudeConfigFile` derives from `path.dirname(claudeHome)` because `~/.claude`
pairs with `~/.claude.json` — a sibling, not a child. Deriving it keeps a test's
fake home self-consistent.
