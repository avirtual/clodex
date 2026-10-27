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
STARTED="$(date +%s)"
export GIT_TERMINAL_PROMPT=0
REPO=avirtual/clodex

if [ -z "$TAG" ]; then
  printf 'usage: scripts/cloud-review-post.sh <newTag>\n' >&2
  exit 1
fi

nonneg() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; }
nonneg "$CALL_S" && [ "$CALL_S" -gt 0 ] || CALL_S=60
nonneg "$POLL_S" || POLL_S=60
[ "${CLODEX_REVIEW_TEST:-}" = 1 ] || [ "$POLL_S" -ge 5 ] || POLL_S=5
nonneg "$TIMEOUT_S" || TIMEOUT_S=7200

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
  perl -MPOSIX -e '
    my $t = shift;
    my $p = fork;
    die "fork: $!" unless defined $p;
    if (!$p) { setpgrp(0, 0); exec @ARGV or exit 127; }
    setpgrp($p, $p);
    $SIG{ALRM} = sub {
      kill "TERM", -$p;
      for (1 .. 20) { last if waitpid($p, POSIX::WNOHANG()) > 0; select(undef, undef, undef, 0.1); }
      kill "KILL", -$p;
      exit 124;
    };
    alarm $t;
    waitpid($p, 0);
    exit($? & 127 ? 128 + ($? & 127) : $? >> 8);
  ' "$CALL_S" "$@"
}

found=0
fetched=0
fetch_ok=0
stale_seen=
start=$SECONDS
while :; do
  remote="$(bounded "$GIT" ls-remote origin "refs/heads/$BRANCH" 2>/dev/null)"
  if [ -n "$remote" ]; then
    fetched=1
    if ! bounded "$GIT" fetch -q origin "+$BRANCH:$REF"; then
      found=1
      break
    fi
    ct="$("$GIT" log -1 --format=%ct "$REF" 2>/dev/null)"
    sha="${remote%%[[:space:]]*}"
    if nonneg "$ct" && [ "$ct" -lt $((STARTED - 300)) ]; then
      if [ "$stale_seen" != "$sha" ]; then
        printf 'cloud-review-post: ignoring stale report %s\n' "$sha"
        stale_seen="$sha"
      fi
    else
      found=1
      fetch_ok=1
      break
    fi
  fi
  if [ $((SECONDS - start)) -ge "$TIMEOUT_S" ]; then
    break
  fi
  sleep "$POLL_S"
done

delete=0
if [ "$found" = 0 ]; then
  TITLE="$PREFIX NO REPORT"
  if [ -n "$stale_seen" ]; then
    printf 'Branch %s on origin held only report %s, committed before this run, and no fresh report replaced it within %ss.\n\nLog: %s\n' "$BRANCH" "$stale_seen" "$TIMEOUT_S" "$LOG" >"$BODY"
  else
    printf 'No branch %s appeared on origin within %ss, so the cloud review never reported.\n\nLog: %s\n' "$BRANCH" "$TIMEOUT_S" "$LOG" >"$BODY"
  fi
elif [ "$fetch_ok" = 0 ] || ! "$GIT" show "$REF:.review/$TAG.md" >"$REPORT"; then
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
: >"$GH_ERR"
tries=0
until URL="$("$GH" issue create -R "$REPO" -t "$TITLE" -F "$BODY" 2>>"$GH_ERR")"; do
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
