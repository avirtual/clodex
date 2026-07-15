#!/bin/sh
# check-syntax.sh — node --check every changed .js file (vs HEAD, plus
# untracked) and write a ONE-LINE digest to STDERR, exit 0/1. Built for the
# `check-syntax` exec registry entry (replyStderr: true), same contract as
# test-digest.sh: the dispatcher returns only the LAST stderr line (200-char
# slice), so the whole verdict lives on a single bounded line.
#   pass: "syntax OK (4 files)"
#   fail: "SYNTAX: renderer/renderer.js: Unexpected token ..." (first failure)
#   none: "syntax OK (no changed .js files)"
# Dependency-free: sh + git + node.

cd "$(dirname "$0")/.." || exit 1

# Drain the exec payload (stdin) so the dispatcher's write can't EPIPE.
cat >/dev/null 2>/dev/null

files=$( { git diff --name-only HEAD -- '*.js'; \
           git ls-files --others --exclude-standard -- '*.js'; } | sort -u )

if [ -z "$files" ]; then
  printf 'syntax OK (no changed .js files)\n' 1>&2
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

printf 'syntax OK (%s files)\n' "$n" 1>&2
exit 0
