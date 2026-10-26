#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PREV="${1:-}"
NEW="${2:-}"
BIN="${CLODEX_CLAUDE_BIN:-claude}"
GIT="${CLODEX_GIT_BIN:-git}"

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

BRIEF="$(cat "$ROOT/scripts/cloud-review-brief.md")"
BRIEF="${BRIEF//\{\{PREV\}\}/$PREV}"
BRIEF="${BRIEF//\{\{NEW\}\}/$NEW}"

LOG_DIR="$HOME/.clodex/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/cloud-review-$NEW.log"

STALE="$(GIT_TERMINAL_PROMPT=0 "$GIT" ls-remote origin "refs/heads/claude/review-$NEW" 2>/dev/null || true)"
if [ -n "$STALE" ]; then
  if GIT_TERMINAL_PROMPT=0 "$GIT" push -q origin --delete "claude/review-$NEW" >/dev/null 2>&1; then
    printf 'cloud-review: removed stale claude/review-%s\n' "$NEW"
  else
    printf 'warn: cloud-review: could not delete stale claude/review-%s\n' "$NEW"
  fi
fi

nohup env -u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_OAUTH_TOKEN script -q /dev/null "$BIN" --cloud "$BRIEF" --model claude-opus-5-5 --permission-mode bypassPermissions </dev/null >>"$LOG" 2>&1 &
CLAUDE_PID=$!
nohup "$ROOT/scripts/cloud-review-post.sh" "$NEW" </dev/null >>"$LOG" 2>&1 &
POST_PID=$!
printf 'cloud-review: launched for %s..%s (pid %s)\n' "$PREV" "$NEW" "$CLAUDE_PID"
printf 'cloud-review: issue poller launched (pid %s)\n' "$POST_PID"
printf 'cloud-review: the cloud session URL lands in %s\n' "$LOG"
