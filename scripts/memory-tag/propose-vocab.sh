#!/usr/bin/env bash
# Pass A: propose a tag vocabulary from a live memory store. Runs ONCE per
# vocabulary version, not nightly — this is the judgment half, and its output is
# reviewed by hand before anything is frozen.
#
# Writes NOTHING to the memory store. The model gets Write and one target path.
#
# Usage: ./propose-vocab.sh [agent] [model]
set -uo pipefail
cd "$(dirname "$0")"

AGENT="${1:-clodex}"
MODEL="${2:-claude-sonnet-5}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$PWD/vocab-proposal.$AGENT.$STAMP.md"
CORPUS="$PWD/corpus.$AGENT.md"

# A long single-shot generation dies at the default stream-idle timeout while
# upstream is still working. Same wall the brain trials hit.
export API_TIMEOUT_MS="${API_TIMEOUT_MS:-1800000}"
export CLAUDE_STREAM_IDLE_TIMEOUT_MS="${CLAUDE_STREAM_IDLE_TIMEOUT_MS:-1800000}"

node build-corpus.js --all "--agent=$AGENT" > "$CORPUS" || exit 1

# The corpus rides as the system prompt; the task carries only the instruction
# and the output path. --system-prompt-file REPLACES the default prompt, so the
# model has no cwd context: every path below is absolute.
TASK="$(cat vocab-prompt.md)

Write your proposal to the absolute path: $OUT"

echo "=== vocabulary proposal: agent=$AGENT model=$MODEL corpus=$(wc -c <"$CORPUS") bytes ==="
date

claude -p "$TASK" \
  --system-prompt-file "$CORPUS" \
  --model "$MODEL" \
  --tools "Write" \
  --allowed-tools Write \
  >"proposal.$AGENT.$STAMP.stdout.log" 2>"proposal.$AGENT.$STAMP.stderr.log"
rc=$?

echo "=== exit rc=$rc ==="; date
if [ -s "$OUT" ]; then
  echo "PROPOSAL: $OUT ($(wc -l <"$OUT") lines)"
else
  echo "NO OUTPUT. stderr tail:"; tail -8 "proposal.$AGENT.$STAMP.stderr.log"
  exit 1
fi
