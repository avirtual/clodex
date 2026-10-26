#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PREV="${1:-}"
NEW="${2:-}"
BIN="${CLODEX_CLAUDE_BIN:-claude}"

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

BRIEF="$(cat "$ROOT/scripts/cloud-review-brief.md")"
BRIEF="${BRIEF//\{\{PREV\}\}/$PREV}"
BRIEF="${BRIEF//\{\{NEW\}\}/$NEW}"

LOG_DIR="$HOME/.clodex/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/cloud-review-$NEW.log"

nohup env -u CLAUDE_CONFIG_DIR "$BIN" --cloud "$BRIEF" --model opus </dev/null >>"$LOG" 2>&1 &
printf 'cloud-review: launched for %s..%s (pid %s); log at %s\n' "$PREV" "$NEW" "$!" "$LOG"
