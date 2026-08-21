#!/bin/sh
# check-syntax.sh — node --check every changed .js file and write a ONE-LINE
# digest to STDERR, exit 0/1. Built for the `check-syntax` exec registry entry
# (replyStderr: true), same contract as test-digest.sh: the dispatcher returns
# only the LAST stderr line (200-char slice), so the whole verdict lives on a
# single bounded line — and it names WHAT was compared, because a green that
# does not say what it inspected is the bug this script has now had twice.
# ONE file list in every tree state: what the BRANCH changed (vs its merge base)
# UNION what is uncommitted (vs HEAD, plus untracked). The halves are never
# gated on each other — a base half skipped because the tree happened to be
# dirty is the shape of this script's original bug.
#     pass: "syntax OK (5 files vs base master@7f3a91c +worktree)"
#     fail: "SYNTAX: renderer/renderer.js: Unexpected token ..." (first failure)
#     none: "syntax OK (no changed .js files vs base master@7f3a91c +worktree)"
#   Where NOTHING could be compared, the digest never contains "syntax OK":
#     on the trunk: "nothing to compare: on trunk master", exit 0 (normal state)
#     no usable base: "refused, nothing checked: ...", exit 1 (misconfigured)
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


# WHAT IS COMPARED, and why it no longer depends on the state of the tree.
#
# The file list is a UNION of two halves, both computed on EVERY run:
#   base half     — what the branch changed: `git diff <merge-base> HEAD`
#   worktree half — what is uncommitted: `git diff HEAD` + untracked
#
# Gating the base half behind an empty worktree half (which this did) left a
# committed syntax error unopened whenever any unrelated file was dirty:
# `files={notes.js}`, `broken.js` never checked, `syntax OK`, exit 0. Hands are
# told to commit as they go, so a dirty tree is the COMMON state of this
# workflow, not an edge — that gate made the check blind for most of it. A union
# is strictly more checking than either half alone, and it makes the digest mean
# one thing regardless of tree state.
unborn=0
git rev-parse --verify --quiet HEAD >/dev/null 2>&1 || unborn=1

wt_files=$( { [ "$unborn" = "1" ] || git diff --name-only HEAD -- '*.js'; \
              git ls-files --others --exclude-standard -- '*.js'; } 2>/dev/null | sort -u )

# THE BASE. Precedence is local main/master, then origin/HEAD — deliberately NOT
# git-worktree.js `defaultBranch`, whose origin/HEAD preference answers where a
# branch FORKS FROM. The question here is what the branch CHANGED, and
# `isMerged` settles that one the other way, for the reason it states: the base
# must be the ref the operator actually merges into. Measured on this repo,
# origin/master sat 42 commits behind local master, so origin/HEAD reported 14
# changed files where the branch had 1 — a gap that grows between releases until
# a green is a claim about the repo rather than the branch.
#
# `defaultBranch`'s last resort, the CURRENT branch, is absent on purpose: it
# compares the branch to itself. Every no-base outcome below records WHY in
# `note`, because the reason decides the operator's next move.
base_files=
scope=
note=
if [ "$unborn" = "1" ]; then
  # Its own case: no base and no branch commit either, so the on-trunk wording
  # would misdescribe it and point at the wrong fix.
  note="clean tree and no base ref to compare against"
else
  cur=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  def=
  for b in main master; do
    if git rev-parse --verify --quiet "refs/heads/$b" >/dev/null 2>&1; then def=$b; break; fi
  done
  [ -n "$def" ] || def=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
  if [ -z "$def" ]; then
    note="no base ref other than the branch itself"
  elif [ "$def" = "$cur" ]; then
    # VACUOUS: the base names the branch we are ON, so the merge base is HEAD and
    # the diff is empty by construction — over a trunk that may hold a real
    # syntax error. The test is whether the COMPARISON is vacuous, not which arm
    # produced `def`: keying on the arm let this through on the default, no-payload
    # invocation, where `def=master` comes from the local-trunk loop and the
    # checkout is master. A ref name must not decide whether the check happens.
    note="no base: on trunk $def"
  else
    mb=$(git merge-base "$def" HEAD 2>/dev/null)
    if [ -z "$mb" ]; then
      note="no merge base with $def"
    else
      base_files=$(git diff --name-only "$mb" HEAD -- '*.js' 2>/dev/null)
      scope="base ${def}@$(printf '%.7s' "$mb") +worktree"
    fi
  fi
fi
[ -n "$scope" ] || scope="worktree; $note"

files=$(printf '%s\n%s\n' "$base_files" "$wt_files" | sed '/^$/d' | sort -u)

if [ -z "$files" ]; then
  if [ -n "$note" ]; then
    # NOTHING was compared and nothing was read. Being ON the trunk is a normal
    # state — it is the documented default invocation — so it exits 0, but with
    # wording that cannot be read as a check result: no "syntax OK" in it. A repo
    # with no usable base at all is misconfigured rather than normal, and refuses.
    case $note in
      "no base: on trunk "*)
        printf '%.180s\n' "nothing to compare: on trunk ${def}${in_tree}" 1>&2
        exit 0 ;;
      *)
        printf '%.180s\n' "refused, nothing checked: ${note}${in_tree}" 1>&2
        exit 1 ;;
    esac
  fi
  printf 'syntax OK (no changed .js files vs %s%s)\n' "$scope" "$in_tree" 1>&2
  exit 0
fi

# Heredoc, not a pipe, for the reason the worktree walk above states: a piped
# `while` runs in a subshell, so neither the count nor the `exit 1` would escape.
# `read -r` rather than `for f in $files` because word splitting turns a tracked
# path containing a space into two nonexistent paths, which the -f guard then
# skips — a false green per affected file, and the base diff surfaces far more
# paths than the worktree diff ever did.
n=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue   # deleted files show in diff --name-only, so N can undercount
  err=$(node --check "$f" 2>&1) || {
    # node --check prints "file:line" + source context first and the actual
    # "SyntaxError: ..." near the end — prefer that line, fall back to the first.
    msg=$(printf '%s\n' "$err" | awk '/^[A-Za-z]*Error/{m=$0} NF&&!f{f=$0} END{print (m?m:f)}')
    printf '%.180s\n' "SYNTAX: $f: $msg" 1>&2
    exit 1
  }
  n=$((n + 1))
done <<CLX_FILES
$files
CLX_FILES

printf 'syntax OK (%s files vs %s%s)\n' "$n" "$scope" "$in_tree" 1>&2
exit 0
