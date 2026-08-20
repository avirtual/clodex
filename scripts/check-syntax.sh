#!/bin/sh
# check-syntax.sh — node --check every changed .js file (vs HEAD, plus
# untracked) and write a ONE-LINE digest to STDERR, exit 0/1. Built for the
# `check-syntax` exec registry entry (replyStderr: true), same contract as
# test-digest.sh: the dispatcher returns only the LAST stderr line (200-char
# slice), so the whole verdict lives on a single bounded line.
#   pass: "syntax OK (4 files)"
#   fail: "SYNTAX: renderer/renderer.js: Unexpected token ..." (first failure)
#   none: "syntax OK (no changed .js files)"
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

files=$( { git diff --name-only HEAD -- '*.js'; \
           git ls-files --others --exclude-standard -- '*.js'; } | sort -u )

if [ -z "$files" ]; then
  printf 'syntax OK (no changed .js files%s)\n' "$( [ "$check" = "$root" ] || printf ' in %s' "${check##*/}" )" 1>&2
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

printf 'syntax OK (%s files%s)\n' "$n" "$( [ "$check" = "$root" ] || printf ' in %s' "${check##*/}" )" 1>&2
exit 0
