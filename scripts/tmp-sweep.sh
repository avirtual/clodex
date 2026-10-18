#!/usr/bin/env bash
# tmp-sweep.sh — manual janitor for the scratch roots the test suite abandons in
# $TMPDIR.
#
# The suite mints scratch roots with mkdtemp under $TMPDIR/clodex-suite. test/lib/tmp-roots.js
# sweeps the ones it registered, but roots still escape: a run killed mid-flight
# (SIGKILL, a crashed seat, a force-exit before the top-level `after`) never gets
# to sweep at all. They accumulate into the hundreds of thousands, and macOS
# reaps them on no timescale that matters.
#
#   scripts/tmp-sweep.sh                   # dry-run: what it WOULD remove, plus totals
#   scripts/tmp-sweep.sh --list            # dry-run, printing every path
#   scripts/tmp-sweep.sh --older-than 72   # only roots older than 72h
#   scripts/tmp-sweep.sh --yes             # actually remove
#
# Deleting the wrong thing in $TMPDIR destroys another process's live data, so
# every gate below fails CLOSED:
#   - dry-run unless --yes
#   - an age floor of 1 hour (a running suite's roots are minutes old)
#   - $TMPDIR must be a per-user temp dir, checked literal and resolved
#   - direct children of $TMPDIR/clodex-suite only, never followed through a symlink
set -uo pipefail

HOURS=24
APPLY=0
LIST=0

die() { echo "tmp-sweep: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) APPLY=1 ;;
    --list) LIST=1 ;;
    --older-than)
      [ $# -ge 2 ] || die "--older-than needs a value (hours)"
      HOURS="$2"; shift ;;
    --older-than=*) HOURS="${1#*=}" ;;
    -h|--help) sed -n '2,/^set -uo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument '$1'" ;;
  esac
  shift
done

# An age of 0 would put a running suite's own fixtures in scope, so it is not
# merely discouraged — it is rejected, along with anything that is not a plain
# positive integer. A typo must not widen the blast radius.
[[ "$HOURS" =~ ^[1-9][0-9]*$ ]] || die "--older-than must be a whole number of hours, 1 or more (got '$HOURS')"

TMP="${TMPDIR:-}"
[ -n "$TMP" ] || die "TMPDIR is unset — refusing to guess"
TMP="${TMP%/}"
[ -d "$TMP" ] || die "TMPDIR is not a directory: $TMP"

# Both the literal value and what it resolves to must look like a per-user temp
# dir. Checking only the string would let a symlinked TMPDIR point the sweep at
# $HOME; checking only the resolved path would miss nothing but costs nothing.
# /private/var is the macOS realpath of /var, which is why both spellings pass.
#
# `*` matches `/` in a bash case pattern, so a deeper path like
# /var/folders/a/b/T/scratch/T also passes. That is DELIBERATE and the blast
# radius stays inside /var/folders either way. Tightening to [!/]*/[!/]* would
# also lock out test/tmp-sweep-behavior.test.js, which cannot mint a real
# /var/folders/xx/yy/T (that directory is root-owned) and instead points TMPDIR
# at a scratch parent nested under the real one. A gate nothing can exercise is
# worth less than one extra path component of slack.
looks_like_user_tmp() {
  case "$1" in
    /var/folders/*/*/T|/private/var/folders/*/*/T) return 0 ;;
    *) return 1 ;;
  esac
}
REAL="$(cd "$TMP" 2>/dev/null && pwd -P)" || die "cannot resolve TMPDIR: $TMP"
looks_like_user_tmp "$TMP" || die "TMPDIR does not look like a per-user temp dir (want /var/folders/…/T): $TMP"
looks_like_user_tmp "$REAL" || die "TMPDIR resolves outside /var/folders: $TMP -> $REAL"

SUITE="$TMP/clodex-suite"
[ -L "$SUITE" ] && die "suite root is a symlink — refusing to follow it: $SUITE"
if [ ! -d "$SUITE" ]; then
  echo "tmp-sweep: nothing to remove — no suite root at $SUITE"
  exit 0
fi
MINUTES=$((HOURS * 60))

LISTFILE="$(mktemp "$TMP/clodex-tmpsweep-XXXXXX")" || die "cannot create work file"
trap 'rm -f "$LISTFILE"' EXIT

# -P never follows a symlink, so a symlinked entry cannot take the sweep out of
# the suite root; -mindepth/-maxdepth 1 keep it to direct children; -type d means a
# symlink is not a candidate in the first place. Errors are dropped: entries
# owned by other users are expected here and are not ours to report on.
enumerate() {
  find -P "$SUITE" -mindepth 1 -maxdepth 1 -type d -mmin "+$MINUTES" -print0 2>/dev/null
}

enumerate > "$LISTFILE"
COUNT="$(tr -dc '\0' < "$LISTFILE" | wc -c | tr -d ' ')"

if [ "$COUNT" -eq 0 ]; then
  echo "tmp-sweep: nothing to remove in $SUITE (older than ${HOURS}h)"
  exit 0
fi

KB="$(xargs -0 du -sk < "$LISTFILE" 2>/dev/null | awk '{s+=$1} END {printf "%d", s}')"
[ -n "$KB" ] || KB=0
HUMAN="$(awk -v k="$KB" 'BEGIN{ if (k>=1048576) printf "%.1f GB", k/1048576; else if (k>=1024) printf "%.1f MB", k/1024; else printf "%d KB", k }')"

if [ "$LIST" -eq 1 ]; then
  tr '\0' '\n' < "$LISTFILE"
else
  tr '\0' '\n' < "$LISTFILE" | head -20
  [ "$COUNT" -gt 20 ] && echo "  … $((COUNT - 20)) more (--list to print every path)"
fi

if [ "$APPLY" -eq 0 ]; then
  echo "tmp-sweep: would remove $COUNT directories, $HUMAN, from $SUITE (older than ${HOURS}h)"
  echo "tmp-sweep: DRY RUN — nothing was removed. Re-run with --yes to remove them."
  exit 0
fi

echo "tmp-sweep: removing $COUNT directories, $HUMAN, from $SUITE (older than ${HOURS}h)…"

# Removal is guarded exactly the way rmQuiet in test/lib/tmp-roots.js is, and for
# the same reason: a fixture that chmod 0o000'd a directory and died before the
# restore leaves a root nothing can descend into. `rm -rf` reports that and moves
# on to the rest of its batch; letting its exit status kill the sweep would mean
# one poisoned root blocks the other 300,000. What survives is counted honestly
# below rather than assumed gone.
xargs -0 rm -rf -- < "$LISTFILE" 2>/dev/null

# Survivors are counted by re-testing the paths we tried to remove, NOT by a
# second enumerate. Two reasons, and the first is a correctness bug the second
# pass had: `rm -rf` that empties a root and then fails on a chmod-0o000
# directory INSIDE it leaves the root with an mtime of now, so `-mmin +$MINUTES`
# no longer selects it and the survivor reads as removed. Dropping the age gate
# instead would over-count the other way — a concurrent suite run mints fresh
# matching roots that were never in this list. The list is the exact set this
# run is answerable for.
LEFT=0
while IFS= read -r -d '' path; do
  [ -e "$path" ] && LEFT=$((LEFT + 1))
done < "$LISTFILE"
REMOVED=$((COUNT - LEFT))
if [ "$LEFT" -gt 0 ]; then
  echo "tmp-sweep: removed $REMOVED; $LEFT could not be removed (unreadable or not ours to force)" >&2
  exit 1
fi
echo "tmp-sweep: removed $REMOVED directories."
