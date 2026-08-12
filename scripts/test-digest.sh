#!/bin/sh
# test-digest.sh — run the Clodex test suite and write a ONE-LINE digest to
# STDERR, exiting with node's exit code. Built for the `run-tests` exec
# registry entry (replyStderr: true): the exec dispatcher returns only the
# LAST stderr line (200-char slice) on both the success and failure paths, so
# the whole digest lives on a single bounded line.
#   pass: "[wb-wrap-ui] 811/811 green"
#   fail: "[wb-wrap-ui] 798/811 green, 13 failing: name1; name2; …" (capped)
# Dependency-free: sh + awk only. The TAP reporter is forced so the summary
# grammar ("# pass N") doesn't shift with TTY detection across node versions.

cd "$(dirname "$0")/.." || exit 1

# The cd above means the tree measured is THIS script's checkout no matter who
# calls it, so a caller in another worktree gets a real, current, green number
# for code that was never run — that reads as a pass, not an error. Hence every
# digest line names its tree, AHEAD of the failing names: the 180-char cap below
# eats the tail first. Parameter expansion, not basename(1), to keep the
# dependency-free promise in the header literal.
tree=${PWD##*/}

# Drain the exec payload (stdin) so the dispatcher's write can't EPIPE.
cat >/dev/null 2>/dev/null

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
LOCK=".test-digest.lock"
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
