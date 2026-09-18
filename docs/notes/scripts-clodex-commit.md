# scripts/clodex-commit.js

## git

`--literal-pathspecs` is a GLOBAL flag and must sit before the subcommand. It is
on every call rather than only `add` because git applies pathspec globbing to
whatever a subcommand reads as a pathspec: `add -- 'a[1].txt'` stages `a1.txt`
too, and the pre-add guard has already passed by then, so the extra file rides
the commit under a message that never names it.

## indexNames

`diff --cached --name-only` quotes a non-ASCII name per `core.quotePath`, whose
default is on: `résumé.txt` comes back as `"r\303\251sum\303\251.txt"`. That
matches no entry in `paths` — which holds the bytes `path.relative` produced —
so the file the payload DID name reads as one it did not, and the pre-staged
guard refuses the hand's own commit. `-c core.quotePath=false` is what makes the
two comparable.

Its names are relative to the REPO ROOT while `paths` are relative to `tree`.
The two agree because `tree` is always a worktree root: the exec def pins `cwd`
to `${TEAM_ROOT}` and `resolveTree` accepts only a path `git worktree list`
reports, both of which are toplevels. A cwd below the repo root is unreachable
through the grant, so no resolution to `rev-parse --show-toplevel` is wired.
