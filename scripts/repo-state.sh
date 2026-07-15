#!/bin/sh
# repo-state.sh — ONE-LINE repo digest to STDERR, exit 0. Built for the
# `repo-state` exec registry entry (replyStderr: true), same contract as
# test-digest.sh: the dispatcher returns only the LAST stderr line (200-char
# slice). Replaces the recurring status+log+rev-list inspection round-trips.
#   "master | clean | in sync with origin | v2.25.0+3 (last: Sandbox M2: ...)"
#   "master | dirty: 4 files | ahead 2 / behind 1 | v2.25.0+5 (last: ...)"
# Dependency-free: sh + git + awk.

cd "$(dirname "$0")/.." || exit 1

# Drain the exec payload (stdin) so the dispatcher's write can't EPIPE.
cat >/dev/null 2>/dev/null

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')

dirty=$(git status --porcelain 2>/dev/null | wc -l | awk '{print $1}')
if [ "$dirty" -eq 0 ]; then wt='clean'; else wt="dirty: $dirty files"; fi

if git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
  set -- $(git rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null)
  behind=${1:-0}; ahead=${2:-0}
  if [ "$ahead" -eq 0 ] && [ "$behind" -eq 0 ]; then sync='in sync with origin'
  else sync="ahead $ahead / behind $behind"; fi
else
  sync='no upstream'
fi

tag=$(git describe --tags --abbrev=0 2>/dev/null || echo 'no tag')
since=$(git rev-list "$tag"..HEAD --count 2>/dev/null || echo '?')
last=$(git log -1 --format=%s 2>/dev/null)

printf '%.198s\n' "$branch | $wt | $sync | $tag+$since (last: $last)" 1>&2
exit 0
