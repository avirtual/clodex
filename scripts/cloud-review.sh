#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PREV="${1:-}"
NEW="${2:-}"
BIN="${CLODEX_CLAUDE_BIN:-claude}"
GIT="${CLODEX_GIT_BIN:-git}"
POLLER="${CLODEX_REVIEW_POLLER_BIN:-$ROOT/scripts/cloud-review-post.sh}"

if [ "${CLODEX_RELEASE_NO_REVIEW:-}" = 1 ]; then
  printf 'cloud-review: skipped (CLODEX_RELEASE_NO_REVIEW=1)\n'
  exit 0
fi
if [ -z "$NEW" ]; then
  printf 'usage: scripts/cloud-review.sh <prevTag> <newTag>\n' >&2
  exit 1
fi
if [ -z "$PREV" ]; then
  printf 'warn: cloud-review: no previous tag; nothing to review\n'
  exit 0
fi
if ! command -v "$BIN" >/dev/null 2>&1; then
  printf 'warn: cloud-review: %s not on PATH; review not launched\n' "$BIN"
  exit 0
fi
if ! command -v script >/dev/null 2>&1; then
  printf 'warn: cloud-review: script(1) not on PATH; claude --cloud needs a terminal; review not launched\n'
  exit 0
fi

REVIEW_REF="${CLODEX_REVIEW_REF:-}"
PREFIX="${CLODEX_REVIEW_PREFIX:-Release review $NEW:}"
if [ -z "$REVIEW_REF" ]; then
  CHECKOUT="git checkout $NEW"
  SECTION="the $NEW section of CHANGELOG.md (its heading is \`## <version> — <date>\`, the version being $NEW without its leading \`v\`)"
  RANGE="$PREV..$NEW"
else
  REVIEW_SHA="${CLODEX_REVIEW_SHA:-}"
  if [ -z "$REVIEW_SHA" ]; then
    printf 'cloud-review: CLODEX_REVIEW_REF needs CLODEX_REVIEW_SHA\n' >&2
    exit 1
  fi
  CHECKOUT="git fetch origin $REVIEW_REF && git checkout $REVIEW_SHA"
  SECTION="the \`## Unreleased\` section of CHANGELOG.md (its bullets are the candidate release notes; the heading has no version yet)"
  RANGE="$PREV..$REVIEW_SHA"
fi

shopt -u patsub_replacement 2>/dev/null || true
BRIEF="$(cat "$ROOT/scripts/cloud-review-brief.md")"
BRIEF="${BRIEF//\{\{CHECKOUT\}\}/$CHECKOUT}"
BRIEF="${BRIEF//\{\{SECTION\}\}/$SECTION}"
BRIEF="${BRIEF//\{\{RANGE\}\}/$RANGE}"
BRIEF="${BRIEF//\{\{PREFIX\}\}/$PREFIX}"
BRIEF="${BRIEF//\{\{PREV\}\}/$PREV}"
BRIEF="${BRIEF//\{\{NEW\}\}/$NEW}"

LOG_DIR="$HOME/.clodex/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/cloud-review-$NEW.log"

STALE="$(GIT_TERMINAL_PROMPT=0 "$GIT" ls-remote origin "refs/heads/claude/review-$NEW" 2>/dev/null || true)"
if [ -n "$STALE" ]; then
  # The poller keeps this branch when it cannot read the report, so it may be the only copy: rename before deleting.
  SHORT="${STALE%%[[:space:]]*}"
  SHORT="${SHORT:0:8}"
  KEPT="claude/review-$NEW-prev-$SHORT"
  if GIT_TERMINAL_PROMPT=0 "$GIT" fetch -q origin "refs/heads/claude/review-$NEW:refs/remotes/origin/claude/review-$NEW" >/dev/null 2>&1 \
    && GIT_TERMINAL_PROMPT=0 "$GIT" push -q origin "refs/remotes/origin/claude/review-$NEW:refs/heads/$KEPT" >/dev/null 2>&1; then
    printf 'cloud-review: kept the previous report as %s\n' "$KEPT"
    if GIT_TERMINAL_PROMPT=0 "$GIT" push -q origin --delete "claude/review-$NEW" >/dev/null 2>&1; then
      printf 'cloud-review: removed stale claude/review-%s\n' "$NEW"
    else
      printf 'warn: cloud-review: could not delete stale claude/review-%s\n' "$NEW"
    fi
  else
    printf 'warn: cloud-review: could not keep claude/review-%s as %s; left it in place\n' "$NEW" "$KEPT"
  fi
fi

nohup env -u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_OAUTH_TOKEN script -q /dev/null "$BIN" --cloud "$BRIEF" --model claude-opus-5-5 --permission-mode bypassPermissions </dev/null >>"$LOG" 2>&1 &
CLAUDE_PID=$!
nohup "$POLLER" "$NEW" </dev/null >>"$LOG" 2>&1 &
POST_PID=$!
printf 'cloud-review: launched for %s..%s (pid %s)\n' "$PREV" "$NEW" "$CLAUDE_PID"
printf 'cloud-review: issue poller launched (pid %s)\n' "$POST_PID"
printf 'cloud-review: the cloud session URL lands in %s\n' "$LOG"
