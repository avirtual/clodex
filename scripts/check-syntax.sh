#!/bin/sh
# check-syntax.sh — node --check every changed .js file and write a ONE-LINE
# digest to STDERR, exit 0/1. Built for the `check-syntax` exec registry entry
# (replyStderr: true), same contract as test-digest.sh: the dispatcher returns
# only the LAST stderr line (200-char slice), so the whole verdict lives on a
# single bounded line — and it names WHAT was compared, because a green that
# does not say what it inspected is the bug this script has now had twice.
#   dirty tree: files vs HEAD, plus untracked
#     pass: "syntax OK (4 files vs HEAD)"
#     fail: "SYNTAX: renderer/renderer.js: Unexpected token ..." (first failure)
#   clean tree: files the BRANCH changed, vs its base
#     pass: "syntax OK (3 files vs base master@7f3a91c in wb-wrap-ui-t452)"
#     none: "syntax OK (no changed .js files vs base master@7f3a91c)"
#     no base resolvable, or none but the branch itself:
#           "refused, nothing checked: ...", exit 1 — a comparison that could
#           not be made is never reported as a pass
# Takes the same optional `tree` payload field as test-digest.sh; without it
# this checks the team root.
# Dependency-free: sh + git + node.

cd "$(dirname "$0")/.." || exit 1
root=$PWD

# Drain the exec payload (stdin) in FULL so the dispatcher's write can't EPIPE.
payload=$(cat 2>/dev/null)

# WHICH TREE, mirroring test-digest.sh's block for the same reason: a hand works
# in a WORKTREE, and a check that silently measures the root instead reports
# "syntax OK (no changed .js files)" over unexamined code — a false green from a
# granted command, which is worse than no check at all.
#
# Presence and value are separate. `{"tree":""}` — what a caller gets from
# templating an unset variable — must take the refusal path, not fall through to
# the root, or the silent-root bug is rebuilt behind a field that looks honest.
has_tree=$(printf '%s' "$payload" | tr '\n' ' ' | awk '{ print match($0, /"tree"[ \t]*:/) ? 1 : 0 }')
want=$(printf '%s' "$payload" | tr '\n' ' ' | awk '{
  if (!match($0, /"tree"[ \t]*:[ \t]*"[^"]*"/)) exit
  s = substr($0, RSTART, RLENGTH)
  sub(/^"tree"[ \t]*:[ \t]*"/, "", s)
  sub(/"$/, "", s)
  print s
}')

check=$root
if [ "$has_tree" = "1" ]; then
  # `cd` + `pwd -P` is the dependency-free realpath, load-bearing on macOS where
  # /tmp is a symlink: comparing git's string against the caller's would reject
  # genuine worktrees.
  want_abs=
  [ -n "$want" ] && want_abs=$(cd "$want" 2>/dev/null && pwd -P)
  check=
  if [ -n "$want_abs" ]; then
    # THE ALLOWLIST. `git worktree list` from the root enumerates this repo's own
    # checkouts; membership IS the authorization. Heredoc rather than a pipe: a
    # piped `while` runs in a subshell and the assignment would be discarded.
    candidates=$(git -C "$root" worktree list --porcelain 2>/dev/null \
      | awk '$1=="worktree" { sub(/^worktree /, ""); print }')
    while IFS= read -r cand; do
      [ -n "$cand" ] || continue
      cand_abs=$(cd "$cand" 2>/dev/null && pwd -P)
      if [ "$cand_abs" = "$want_abs" ]; then check=$want_abs; break; fi
    done <<CLX_WORKTREES
$candidates
CLX_WORKTREES
  fi
  if [ -z "$check" ]; then
    # LOUD, never a fallback to the root — see the header.
    printf '%.180s\n' "refused, nothing checked: not a worktree of this repo — ${want:-(empty)}" 1>&2
    exit 1
  fi
  cd "$check" || exit 1
fi

in_tree=$( [ "$check" = "$root" ] || printf ' in %s' "${check##*/}" )

# WHAT IS COMPARED AGAINST WHAT, and why a clean tree is not an empty answer.
# A dirty tree is checked against HEAD. A CLEAN one is checked against the
# BRANCH'S BASE, because hands are told to commit as they go — so the workflow
# this check exists to serve ends with `git diff HEAD` empty over exactly the
# code that still needs checking. That empty list used to take the SUCCESS path:
# a green from a granted command that had inspected nothing, reproduced both
# ways on one worktree (uncommitted -> SYNTAX:, exit 1; same bytes committed ->
# "syntax OK", exit 0). The header already calls that class worse than no check
# at all for the wrong-TREE door; this was the same green through the commit
# door.
#
# "no changed .js files" is the TRUTH for a clean tree on a branch with no
# commits and a LIE for a clean tree with commits, and only naming the base the
# comparison used tells a reader which one they are holding.
files=$( { git diff --name-only HEAD -- '*.js'; \
           git ls-files --others --exclude-standard -- '*.js'; } | sort -u )
against=HEAD

if [ -z "$files" ]; then
  # BASE PRECEDENCE: local main/master FIRST, then origin/HEAD, then the current
  # branch. Deliberately NOT git-worktree.js `defaultBranch`, whose origin/HEAD
  # preference answers a different question — that one picks where a new branch
  # FORKS FROM. The question here is what this branch CHANGED, and `isMerged`
  # settles that one the other way for the same reason it states: the base must
  # be the branch the operator actually merges into, not a ref this repo may
  # rarely push to. Measured on this repo: origin/master sat 42 commits behind
  # local master, so origin/HEAD reported 14 changed files where the branch had
  # 1 — 13 already merged and already checked. That gap grows without bound
  # between releases, so the digest drifts toward checking the whole repo and
  # its green stops being a claim about the branch: a slower form of the false
  # green this script was fixed for.
  #
  # There is deliberately NO last-resort fallback to the current branch, which is
  # where `defaultBranch` ends. That base compares the branch to ITSELF: the
  # merge base is HEAD, the file list is empty, and the digest returns exit 0
  # over a branch that may contain a real syntax error — reproduced on a repo
  # with no local trunk and no origin/HEAD, carrying a committed
  # `function (((broken {`, which reported `syntax OK (no changed .js files vs
  # base feat@85d9420)`. That is this script's own bug one door further in, and
  # naming the ref does not repair it: it asks a reader to notice the base is the
  # branch's own name and infer the comparison was vacuous. When nothing could be
  # compared, refuse — the same principle as the no-base path below.
  # Unborn HEAD (no commit yet) is its OWN case: there is no base and no branch
  # commit either, so the "other than the branch itself" wording below would
  # misdescribe it and point at the wrong fix. Checked first for that reason.
  if ! git rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
    printf '%.180s\n' "refused, nothing checked: clean tree and no base ref to compare against${in_tree}" 1>&2
    exit 1
  fi
  def=
  for b in main master; do
    if git rev-parse --verify --quiet "refs/heads/$b" >/dev/null 2>&1; then def=$b; break; fi
  done
  [ -n "$def" ] || def=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
  if [ -z "$def" ]; then
    # Distinct from the no-base message: the remediation differs (no base ref at
    # all vs. one that degenerated to the branch), and a shared wording would
    # send the operator to the wrong fix.
    printf '%.180s\n' "refused, nothing checked: no base ref other than the branch itself${in_tree}" 1>&2
    exit 1
  fi
  mb=
  [ -n "$def" ] && mb=$(git merge-base "$def" HEAD 2>/dev/null)
  if [ -z "$mb" ]; then
    # No base and nothing committed to compare: we do not know what this branch
    # changed, and saying "syntax OK" here would rebuild the false green behind
    # a clean tree. Refuse in the same shape as the wrong-tree path.
    printf '%.180s\n' "refused, nothing checked: clean tree and no base ref to compare against${in_tree}" 1>&2
    exit 1
  fi
  against="base ${def}@$(printf '%.7s' "$mb")"
  files=$(git diff --name-only "$mb" HEAD -- '*.js' | sort -u)
fi

if [ -z "$files" ]; then
  printf 'syntax OK (no changed .js files vs %s%s)\n' "$against" "$in_tree" 1>&2
  exit 0
fi

n=0
for f in $files; do
  [ -f "$f" ] || continue   # deleted files show in diff --name-only
  err=$(node --check "$f" 2>&1) || {
    # node --check prints "file:line" + source context first and the actual
    # "SyntaxError: ..." near the end — prefer that line, fall back to the first.
    msg=$(printf '%s\n' "$err" | awk '/^[A-Za-z]*Error/{m=$0} NF&&!f{f=$0} END{print (m?m:f)}')
    printf '%.180s\n' "SYNTAX: $f: $msg" 1>&2
    exit 1
  }
  n=$((n + 1))
done

printf 'syntax OK (%s files vs %s%s)\n' "$n" "$against" "$in_tree" 1>&2
exit 0
