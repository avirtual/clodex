#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TAG="${1:-}"
GH="${CLODEX_GH_BIN:-gh}"
GIT="${CLODEX_GIT_BIN:-git}"
POLL_S="${CLODEX_REVIEW_POLL_S:-60}"
TIMEOUT_S="${CLODEX_REVIEW_TIMEOUT_S:-7200}"
CALL_S="${CLODEX_REVIEW_CALL_S:-60}"
RETRY_S="${CLODEX_REVIEW_RETRY_S:-10}"
export GIT_TERMINAL_PROMPT=0
REPO=avirtual/clodex

if [ -z "$TAG" ]; then
  printf 'usage: scripts/cloud-review-post.sh <newTag>\n' >&2
  exit 1
fi

BRANCH="claude/review-$TAG"
REF="refs/clodex-review/$TAG"
PREFIX="Release review $TAG:"
LOG="$HOME/.clodex/logs/cloud-review-$TAG.log"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REPORT="$TMP/report.md"
BODY="$TMP/body.md"
GH_ERR="$TMP/gh.err"

bounded() {
  perl -e '
    my $t = shift;
    my $p = fork;
    die "fork: $!" unless defined $p;
    if (!$p) { setpgrp(0, 0); exec @ARGV or exit 127; }
    setpgrp($p, $p);
    $SIG{ALRM} = sub { kill "KILL", -$p; exit 124; };
    alarm $t;
    waitpid($p, 0);
    exit($? & 127 ? 128 + ($? & 127) : $? >> 8);
  ' "$CALL_S" "$@"
}

found=0
start=$SECONDS
while :; do
  if [ -n "$(bounded "$GIT" ls-remote origin "refs/heads/$BRANCH" 2>/dev/null)" ]; then
    found=1
    break
  fi
  if [ $((SECONDS - start)) -ge "$TIMEOUT_S" ]; then
    break
  fi
  sleep "$POLL_S"
done

delete=0
fetched=0
if [ "$found" = 0 ]; then
  TITLE="$PREFIX NO REPORT"
  printf 'No branch %s appeared on origin within %ss, so the cloud review never reported.\n\nLog: %s\n' "$BRANCH" "$TIMEOUT_S" "$LOG" >"$BODY"
elif ! { fetched=1; bounded "$GIT" fetch -q origin "+$BRANCH:$REF"; } || ! "$GIT" show "$REF:.review/$TAG.md" >"$REPORT"; then
  TITLE="$PREFIX UNPARSED REPORT"
  printf 'Branch %s is on origin, but .review/%s.md could not be read from it; the branch was kept.\n\nLog: %s\n' "$BRANCH" "$TAG" "$LOG" >"$BODY"
else
  delete=1
  TITLE="$(head -n 1 "$REPORT" | tr -d '\r')"
  case "$TITLE" in
    "$PREFIX"*)
      if [ -z "$(sed -n 2p "$REPORT" | tr -d '\r')" ]; then
        tail -n +3 "$REPORT" >"$BODY"
      else
        tail -n +2 "$REPORT" >"$BODY"
      fi
      ;;
    *)
      TITLE="$PREFIX UNPARSED REPORT"
      cp "$REPORT" "$BODY"
      ;;
  esac
fi

TITLE="${TITLE:0:256}"
tries=0
until URL="$("$GH" issue create -R "$REPO" -t "$TITLE" -F "$BODY" 2>"$GH_ERR")"; do
  tries=$((tries + 1))
  if [ "$tries" -ge 3 ]; then
    mkdir -p "$(dirname "$LOG")"
    printf 'cloud-review: ERROR issue create failed: %s\n' "$(cat "$GH_ERR")" >>"$LOG"
    exit 1
  fi
  sleep "$RETRY_S"
done
printf 'cloud-review-post: opened %s\n' "$URL"

case "$TITLE" in
  *": CLEAN")
    "$GH" issue close "$URL" -R "$REPO" || printf 'cloud-review-post: gh issue close failed for %s\n' "$URL" >&2
    ;;
esac

if [ "$fetched" = 1 ]; then
  "$GIT" update-ref -d "$REF" || printf 'cloud-review-post: could not delete %s\n' "$REF" >&2
fi

if [ "$delete" = 1 ]; then
  bounded "$GIT" push -q origin --delete "$BRANCH" || printf 'cloud-review-post: could not delete %s\n' "$BRANCH" >&2
fi
