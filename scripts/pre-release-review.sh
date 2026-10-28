#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GIT="${CLODEX_GIT_BIN:-git}"
GH="${CLODEX_GH_BIN:-gh}"

die() { printf 'pre-release-review: %s\n' "$1" >&2; exit 1; }

unset CLODEX_RELEASE_NO_REVIEW
ST="$("$GIT" status --porcelain)" || die "git status failed"
[ -z "$ST" ] || die "working tree not clean"
[ "$("$GIT" branch --show-current)" = master ] || die "not on master"
"$GIT" fetch -q origin master || die "git fetch failed"
[ "$("$GIT" rev-list --count HEAD..@{u})" = 0 ] || die "local master is behind origin/master — pull first"
"$GH" auth status >/dev/null 2>&1 || die "gh is not authenticated"
PREV="$("$GIT" describe --tags --abbrev=0 2>/dev/null || true)"
[ -n "$PREV" ] || die "no previous tag to review from"

SHA="$("$GIT" rev-parse --short=8 HEAD)"
LABEL="staging-$SHA"
FULL="$("$GIT" rev-parse HEAD)"

"$GIT" push -q --force origin "HEAD:refs/heads/staging" || die "push to origin staging failed"

export CLODEX_REVIEW_REF=staging
export CLODEX_REVIEW_SHA="$FULL"
export CLODEX_REVIEW_PREFIX="Pre-release review $LABEL:"
printf 'pre-release-review: launched for %s..%s\n' "$PREV" "$LABEL"
exec "$ROOT/scripts/cloud-review.sh" "$PREV" "$LABEL"
