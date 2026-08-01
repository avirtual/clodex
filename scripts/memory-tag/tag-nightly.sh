#!/usr/bin/env bash
# Pass B: tag the store's untagged units. Runs nightly, unattended.
#
# The model writes ONE flat file and never touches a memory unit; apply.js is
# the sole writer and rejects anything malformed rather than repairing it.
#
# Usage: ./tag-nightly.sh [agent] [model] [--seed=FILE] [--root=DIR]
set -uo pipefail
cd "$(dirname "$0")"

# Positionals and flags are separated by shape, not position: `shift 2` breaks
# when only an agent is given, and the flags then arrive as $MODEL.
AGENT=""; MODEL=""; PASSTHRU=()
for a in "$@"; do
  case "$a" in
    --*) PASSTHRU+=("$a") ;;
    *) if [ -z "$AGENT" ]; then AGENT="$a"; elif [ -z "$MODEL" ]; then MODEL="$a"; fi ;;
  esac
done
AGENT="${AGENT:-clodex}"
MODEL="${MODEL:-claude-sonnet-5}"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$PWD/tags.$AGENT.$STAMP.txt"
CORPUS="$PWD/corpus.$AGENT.md"

# A long single-shot generation dies at the default stream-idle timeout while
# upstream is still working. Same wall the brain trials hit.
export API_TIMEOUT_MS="${API_TIMEOUT_MS:-1800000}"
export CLAUDE_STREAM_IDLE_TIMEOUT_MS="${CLAUDE_STREAM_IDLE_TIMEOUT_MS:-1800000}"

echo "=== nightly tagging: agent=$AGENT model=$MODEL ==="
date

# Corpus first: nothing to tag means nothing else needs to happen, and this is
# the branch that makes the run converge instead of re-tagging the store nightly.
node build-corpus.js --unprocessed "--agent=$AGENT" ${PASSTHRU[@]+"${PASSTHRU[@]}"} > "$CORPUS"
rc=$?
if [ $rc -ne 0 ] || [ ! -s "$CORPUS" ]; then
  echo "nothing unprocessed for $AGENT — no units to tag"
  exit 0
fi

CENSUS="$(node census.js "--agent=$AGENT" ${PASSTHRU[@]+"${PASSTHRU[@]}"})"
# A census that FAILED and a store with no tags both yield an empty string, and
# the second is a legitimate first run. Distinguished by exit code, because
# degrading a seeded run to censusless silently is how the model coins a
# parallel vocabulary nobody asked for.
if [ $? -ne 0 ]; then
  echo "census failed (bad --seed path?) — refusing to run censusless"
  exit 1
fi
if [ -n "$CENSUS" ]; then
  CENSUS_BLOCK="Tags already in this store, with how many units carry each:

$CENSUS"
else
  # First run on an untagged store. Say so explicitly: an empty section where
  # the model expects a census reads as "the census failed", and it may hedge.
  CENSUS_BLOCK="This store has no tags yet. You are choosing the first ones."
fi

# The corpus rides as the system prompt; the task carries the instruction, the
# census and the output path. --system-prompt-file REPLACES the default prompt,
# so the model has no cwd context: every path below is absolute.
TASK="$(cat tag-prompt.md)

$CENSUS_BLOCK

Write your tag file to the absolute path: $OUT"

claude -p "$TASK" \
  --system-prompt-file "$CORPUS" \
  --model "$MODEL" \
  --tools "Write" \
  --allowed-tools Write \
  >"tagging.$AGENT.$STAMP.stdout.log" 2>"tagging.$AGENT.$STAMP.stderr.log"
rc=$?

echo "=== model exit rc=$rc ==="; date
if [ ! -s "$OUT" ]; then
  echo "NO OUTPUT. stderr tail:"; tail -8 "tagging.$AGENT.$STAMP.stderr.log"
  exit 1
fi
echo "TAGFILE: $OUT ($(wc -l <"$OUT") lines)"

# apply.js exits nonzero when any line was rejected, and that exit is this
# script's: an unattended run whose rejections scroll past in a log is how a
# half-landed tagging pass goes unnoticed.
node apply.js "$OUT" "--agent=$AGENT" ${PASSTHRU[@]+"${PASSTHRU[@]}"}
