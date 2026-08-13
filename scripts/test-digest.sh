#!/bin/sh
# test-digest.sh — run the Clodex test suite and write a ONE-LINE digest to
# STDERR, exiting with node's exit code. Built for the `run-tests` exec
# registry entry (replyStderr: true): the exec dispatcher returns only the
# LAST stderr line (200-char slice) on both the success and failure paths, so
# the whole digest lives on a single bounded line.
#   pass: "[wb-wrap-ui] 811/811 green"
#   fail: "[wb-wrap-ui] 798/811 green, 13 failing: name1; name2; …" (capped)
# Dependency-free: sh + awk + git only. The TAP reporter is forced so the
# summary grammar ("# pass N") doesn't shift with TTY detection across node
# versions.
#
# WHICH TREE. The optional `tree` payload field names the checkout to measure;
# with no field this measures its own, which is the team root. The two are
# separate from the LOCK, which is box-wide and always the root's — see the
# lock block. Every digest line names the tree that actually ran.

cd "$(dirname "$0")/.." || exit 1
# The team root, fixed for the rest of this script. The lock lives here even
# when the measurement runs elsewhere, and this is the checkout whose
# `git worktree list` is the allowlist below.
root=$PWD

# The exec payload (stdin), drained in FULL so the dispatcher's write can't
# EPIPE.
payload=$(cat 2>/dev/null)

# One optional string field out of a flat JSON object, in awk, because giving
# this script a JSON dependency would make the digest depend on the tree it is
# measuring. This is not the security gate — the dispatcher has already checked
# the payload against the def's schema, and `git worktree list` below is the
# authorization. A value carrying a quote or a backslash escape cannot name a
# real worktree and is refused there.
want=$(printf '%s' "$payload" | tr '\n' ' ' | awk '{
  if (!match($0, /"tree"[ \t]*:[ \t]*"[^"]*"/)) exit
  s = substr($0, RSTART, RLENGTH)
  sub(/^"tree"[ \t]*:[ \t]*"/, "", s)
  sub(/"$/, "", s)
  print s
}')

measure=$root
if [ -n "$want" ]; then
  # `cd` + `pwd -P` is the dependency-free realpath, and it is load-bearing, not
  # cosmetic: on macOS /tmp is a symlink to /private/tmp, so comparing the string
  # git prints against the string the caller passed rejects genuine worktrees.
  # Both sides go through it.
  want_abs=$(cd "$want" 2>/dev/null && pwd -P)
  measure=
  if [ -n "$want_abs" ]; then
    # THE ALLOWLIST. A caller-supplied path becomes the cwd of a `node --test`
    # sweep, which runs whatever *.test.js it finds there — so the path must be
    # constrained to this repo's own checkouts, and `git worktree list` from the
    # root enumerates exactly those. Membership in it IS the authorization.
    #
    # Fed by heredoc rather than a pipe on purpose: a piped `while` runs in a
    # subshell, so the `measure=` assignment inside it would be discarded and
    # every tree would be refused.
    candidates=$(git -C "$root" worktree list --porcelain 2>/dev/null \
      | awk '$1=="worktree" { sub(/^worktree /, ""); print }')
    while IFS= read -r cand; do
      [ -n "$cand" ] || continue
      cand_abs=$(cd "$cand" 2>/dev/null && pwd -P)
      if [ "$cand_abs" = "$want_abs" ]; then measure=$want_abs; break; fi
    done <<CLX_WORKTREES
$candidates
CLX_WORKTREES
  fi
  if [ -z "$measure" ]; then
    # LOUD, and never a fallback to the root. A silent fallback rebuilds the
    # original bug exactly: the caller asked about its branch and would get a
    # real, current, green number about master, which reads as its own pass.
    printf '%.180s\n' "[${root##*/}] refused, nothing measured: not a worktree of this repo: $want" 1>&2
    exit 1
  fi
fi

# ONE SUITE AT A TIME, ENFORCED RATHER THAN ASKED FOR. Parts of this suite bind
# real ports and spawn real children (cli/test/attach.test.js), so two
# concurrent runs deadlock: both sit at 0% CPU and neither finishes. That
# failure is indistinguishable from a slow suite, and the wrong lesson —
# "raise the timeout" — makes the next collision longer instead of impossible.
# The suite takes ~24s; anything past this wait is a wedge, not contention.
#
# But a timeout is NOT evidence of a second runner: until 46cd13d a SINGLE run
# could wedge alone, because an unguarded tail `close()` in attach.test.js left
# a listening handle when an assertion threw, and node's default per-test
# timeout is infinite — so a FAILED test presented as a hang. Three occurrences
# were diagnosed as contention and searched for a second runner that never
# existed. Check for one, but do not assume it.
#
# mkdir is the atomic test-and-set on every POSIX filesystem. A lock holding a
# DEAD pid is stale (a killed runner never cleans up) and is reclaimed, or the
# first crash would wedge every later run forever.
#
# PINNED TO THE ROOT, ABSOLUTELY, and that is the whole reason the tree is a
# parameter rather than a `cd`. A lock relative to the MEASURED tree gives every
# worktree its own mutex, which excludes nothing: two suites then reach the
# port-binding tests together and deadlock at 0% CPU. Absolute, not relative,
# because the measurement cd's away below and the EXIT trap would otherwise
# delete a path resolved against the worktree — i.e. release nothing and leave
# the real lock held forever. Same split as the ticket loop's
# CLODEX_TEST_LOCK_DIR (session-manager.js), expressed in sh.
LOCK="$root/.test-digest.lock"
waited=0
while ! mkdir "$LOCK" 2>/dev/null; do
  holder=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    rm -rf "$LOCK"
    continue
  fi
  if [ "$waited" -ge 30 ]; then
    # STRICTLY under the exec entry's timeoutMs (120000ms), and not merely equal
    # to it: an equal deadline means the exec SIGKILLs this child at the instant
    # this message would print, so the caller gets "timed out after 120000ms" —
    # the least informative outcome — and never learns a second run was the
    # cause. That is what shipped, and it cost three misdiagnosed timeouts.
    #
    # 30s also beats waiting the full cap on purpose: the caller is an agent
    # whose turn is billed while this blocks, and a suite that runs in ~24s is
    # either nearly done or wedged. Long enough to inherit a finishing run,
    # short enough that the answer arrives while it is still worth having.
    #
    # `ps -o etime=` rather than a stored start time: the holder may be a run
    # this script never launched (npm test takes the same lock), so the process
    # table is the only source that knows when it actually began.
    started=$(ps -o etime= -p "${holder:-0}" 2>/dev/null | tr -d ' ')
    printf 'another suite run is already going (pid %s, running %s) - waited %ss, not starting a second\n' \
      "${holder:-unknown}" "${started:-unknown}" "$waited" 1>&2
    exit 1
  fi
  waited=$((waited + 2))
  sleep 2
done
echo $$ > "$LOCK/pid"
# Covers the normal exit and the common signals; without this a Ctrl-C leaves a
# lock whose pid IS alive for a moment and the next run waits on a ghost.
trap 'rm -rf "$LOCK"' EXIT HUP INT TERM

# ONLY NOW move to the measured tree: the lock above was taken at the root and
# is held across this cd.
cd "$measure" || exit 1

# Recomputed AFTER the cd, so the digest names the tree that actually ran rather
# than the tree that holds the lock — a marker naming the root while measuring a
# worktree would be worse than none. Parameter expansion, not basename(1), to
# keep the dependency-free promise in the header literal.
tree=${PWD##*/}

# A worktree has no node_modules and nothing creates one, so the ~7 files
# requiring electron/node-pty/ws would fail MODULE_NOT_FOUND and the digest
# would report a red suite for a defect in its own harness. A symlink to the
# root's tree is what the ticket loop's gate already does for the same reason
# (session-manager.js `_runTicketSuite`); it is gitignored, so it neither
# dirties the worktree nor blocks its removal.
if [ "$measure" != "$root" ] && [ ! -e "$measure/node_modules" ] \
   && [ -d "$root/node_modules" ]; then
  ln -s "$root/node_modules" "$measure/node_modules" 2>/dev/null
fi

out=$(node --test --test-reporter=tap 2>&1)
code=$?

pass=$(printf '%s\n' "$out" | awk '$1=="#" && $2=="pass" {n=$3} END{print n+0}')
tests=$(printf '%s\n' "$out" | awk '$1=="#" && $2=="tests" {n=$3} END{print n+0}')
fail=$(printf '%s\n' "$out" | awk '$1=="#" && $2=="fail" {n=$3} END{print n+0}')

if [ "$tests" -eq 0 ]; then
  # The runner never produced a summary — surface its last line, not silence.
  last=$(printf '%s\n' "$out" | awk 'NF{l=$0} END{print l}')
  printf '%.180s\n' "[$tree] suite did not run: $last" 1>&2
  [ "$code" -eq 0 ] && exit 1
  exit "$code"
fi

if [ "$code" -eq 0 ] && [ "$fail" -eq 0 ]; then
  printf '[%s] %s/%s green\n' "$tree" "$pass" "$tests" 1>&2
  exit 0
fi

# Failing test names ride the same line, ;-joined and capped. `not ok` lines
# appear at every nesting depth; parent wrappers of a failed subtest are noise
# but harmless — the cap keeps the reply bounded either way.
names=$(printf '%s\n' "$out" | awk 'sub(/^[ \t]*not ok [0-9]+ - /, "") {printf "%s%s", sep, $0; sep="; "}')
printf '%.180s\n' "[$tree] $pass/$tests green, $fail failing: $names" 1>&2
[ "$code" -eq 0 ] && exit 1
exit "$code"
