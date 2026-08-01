#!/usr/bin/env bash
# Pass C: consolidate a tagged store — archive superseded and expired units.
#
# One model call PER BUCKET (a tag's units read together), because contradiction
# is only visible between units seen side by side. The model writes a flat
# verdict file per bucket and never touches a unit; archive.js is the sole mover.
#
# Usage: ./consolidate.sh [agent] [model] [--tag=NAME] [--root=DIR] [--dry-run]
set -uo pipefail
cd "$(dirname "$0")"

# Positionals and flags separated by SHAPE: `shift 2` breaks when only an agent
# is given and the flags then land in $MODEL.
AGENT=""; MODEL=""; PASSTHRU=(); DRY=""; ONLY_TAG=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY="--dry-run" ;;
    --tag=*) ONLY_TAG="$a" ;;
    --*) PASSTHRU+=("$a") ;;
    *) if [ -z "$AGENT" ]; then AGENT="$a"; elif [ -z "$MODEL" ]; then MODEL="$a"; fi ;;
  esac
done
AGENT="${AGENT:-clodex}"
MODEL="${MODEL:-claude-sonnet-5}"

STAMP="$(date +%Y%m%d-%H%M%S)"
BUCKET_DIR="$PWD/buckets.$AGENT.$STAMP"

export API_TIMEOUT_MS="${API_TIMEOUT_MS:-1800000}"
export CLAUDE_STREAM_IDLE_TIMEOUT_MS="${CLAUDE_STREAM_IDLE_TIMEOUT_MS:-1800000}"

echo "=== consolidation: agent=$AGENT model=$MODEL ==="
date

TAGS="$(node build-buckets.js "--agent=$AGENT" "--out=$BUCKET_DIR" \
  ${ONLY_TAG:+"$ONLY_TAG"} ${PASSTHRU[@]+"${PASSTHRU[@]}"})"
if [ $? -ne 0 ] || [ -z "$TAGS" ]; then
  echo "no buckets to consolidate for $AGENT"
  exit 0
fi

# PHASE 1: every model call, no mutation. The store each bucket is judged
# against is therefore the SAME store for all of them — which is what the
# buckets, rendered up front by build-buckets.js, already describe.
rc_total=0
VERDICT_FILES=()
for TAG in $TAGS; do
  BUCKET="$BUCKET_DIR/bucket.$TAG.md"
  OUT="$BUCKET_DIR/verdicts.$TAG.txt"
  echo
  echo "--- bucket: $TAG ($(grep -c '^### ' "$BUCKET") units) ---"

  # The bucket rides as the system prompt; the task carries the instruction and
  # the output path. --system-prompt-file REPLACES the default prompt, so the
  # model has no cwd context: every path below is absolute.
  TASK="$(cat consolidate-prompt.md)

Write your verdicts to the absolute path: $OUT"

  claude -p "$TASK" \
    --system-prompt-file "$BUCKET" \
    --model "$MODEL" \
    --tools "Write" \
    --allowed-tools Write \
    >"$BUCKET_DIR/consolidate.$TAG.stdout.log" 2>"$BUCKET_DIR/consolidate.$TAG.stderr.log"

  if [ ! -s "$OUT" ]; then
    echo "NO VERDICTS for $TAG. stderr tail:"; tail -5 "$BUCKET_DIR/consolidate.$TAG.stderr.log"
    rc_total=1
    continue
  fi

  VERDICT_FILES+=("$OUT")
done

if [ ${#VERDICT_FILES[@]} -eq 0 ]; then
  echo "no verdicts produced for $AGENT"
  exit 1
fi

# PHASE 2: one apply over EVERY verdict file. Applying per bucket meant the last
# bucket to name an id won, so a unit died if any single bucket voted to archive
# while another bucket's keep had already been written and discarded — an OR
# where the prompt promises an AND. archive.js resolves the whole batch first.
echo
echo "--- applying ${#VERDICT_FILES[@]} verdict file(s) as one batch ---"
node archive.js "${VERDICT_FILES[@]}" "--agent=$AGENT" "--out=$BUCKET_DIR" \
  $DRY ${PASSTHRU[@]+"${PASSTHRU[@]}"} 2>&1 | tee "$BUCKET_DIR/archive.stdout.log"
# tee eats the exit status; PIPESTATUS is bash-specific and this script is bash.
[ "${PIPESTATUS[0]}" -eq 0 ] || rc_total=1

echo
echo "=== consolidation complete: agent=$AGENT ==="
echo "buckets, verdicts, snapshot and archive log kept for review: $BUCKET_DIR"
node archive.js --drift "--agent=$AGENT" ${PASSTHRU[@]+"${PASSTHRU[@]}"}
exit $rc_total
