#!/bin/sh
# test-digest.sh — run the Clodex test suite and write a ONE-LINE digest to
# STDERR, exiting with node's exit code. Built for the `run-tests` exec
# registry entry (replyStderr: true): the exec dispatcher returns only the
# LAST stderr line (200-char slice) on both the success and failure paths, so
# the whole digest lives on a single bounded line.
#   pass: "[wb-wrap-ui] 811/811 green"
#   fail: "[wb-wrap-ui] 798/811 green, 13 failing (~/.clodex/test-failures/last.txt): name1; …"
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
#
# PRESENCE AND VALUE ARE SEPARATE, and conflating them rebuilds this script's
# own bug. `[^"]*` matches the empty string, so `{"tree":""}` — the shape a
# caller gets from templating an unset variable, `{"tree":"$WT"}` — yields an
# empty value. Keying the branch off a non-empty value alone then falls through
# to the root and reports a green about master to a caller who explicitly asked
# about a worktree. The field being THERE is what commits us to the refusal
# path; whether it is usable is a separate question answered below.
has_tree=$(printf '%s' "$payload" | tr '\n' ' ' | awk '{ print match($0, /"tree"[ \t]*:/) ? 1 : 0 }')
want=$(printf '%s' "$payload" | tr '\n' ' ' | awk '{
  if (!match($0, /"tree"[ \t]*:[ \t]*"[^"]*"/)) exit
  s = substr($0, RSTART, RLENGTH)
  sub(/^"tree"[ \t]*:[ \t]*"/, "", s)
  sub(/"$/, "", s)
  print s
}')

measure=$root
if [ "$has_tree" = "1" ]; then
  # `cd` + `pwd -P` is the dependency-free realpath, and it is load-bearing, not
  # cosmetic: on macOS /tmp is a symlink to /private/tmp, so comparing the string
  # git prints against the string the caller passed rejects genuine worktrees.
  # Both sides go through it.
  want_abs=
  [ -n "$want" ] && want_abs=$(cd "$want" 2>/dev/null && pwd -P)
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
    #
    # Cause BEFORE the path: `tree` may be 1000 chars and this line is capped at
    # 180, so a long bad path would truncate away the reason for the refusal.
    printf '%.180s\n' "[${root##*/}] refused, nothing measured: not a worktree of this repo — ${want:-(empty)}" 1>&2
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

# The refusal message, and it RE-READS the lock rather than reporting the pid the
# wait loop happened to be holding in a variable.
#
# WHY THAT MATTERS MORE THAN IT LOOKS. The refusal was observed naming a pid that
# was already dead while a DIFFERENT, genuinely live run held the lock: the
# holder finished between the loop's read and the print, and the next waiter took
# the lock and rewrote the pid file. The refusal was CORRECT — a run really was
# in flight — but its evidence was not, and a dead pid in this message is exactly
# the reasoning that ends in `rm -rf`-ing a valid lock and deadlocking two runs.
#
# So the three states are reported as three different sentences, and the one that
# invites the wrong conclusion says so outright. Uses $LOCK and $waited from the
# caller; no arguments, so the wait loop and a test can both call it.
lock_refusal() {
  # Re-read AT PRINT TIME. `now` is the pid the lock names right now, which is
  # the only pid a reader can act on.
  now=$(cat "$LOCK/pid" 2>/dev/null)
  if [ ! -d "$LOCK" ]; then
    # Released in the instant between giving up and reporting. Nothing here is
    # wedged and there is no pid worth naming — telling the caller to re-run is
    # the whole content of the message.
    printf 'another suite run held the lock for the whole %ss wait and released it just as we gave up - nothing is wedged, re-run to take it\n' \
      "$waited" 1>&2
    return
  fi
  if [ -n "$now" ] && kill -0 "$now" 2>/dev/null; then
    # `ps -o etime=` rather than a stored start time: the holder may be a run
    # this script never launched (npm test takes the same lock), so the process
    # table is the only source that knows when it actually began.
    started=$(ps -o etime= -p "$now" 2>/dev/null | tr -d ' ')
    printf 'another suite run is already going (pid %s, running %s) - waited %ss, not starting a second\n' \
      "$now" "${started:-unknown}" "$waited" 1>&2
    return
  fi
  # HELD, but its pid file does not name a live process. Reported WITHOUT
  # presenting that pid as the holder: naming it reads as "kill this and clear
  # the lock", and the last two times that reasoning was followed the lock was
  # valid and held by a run the pid file simply did not name yet. A lock dir with
  # no pid file is also this case — it is the window between mkdir and the write.
  #
  # THE WARNING LEADS, and the lock path is omitted entirely, because the exec
  # dispatcher delivers only the last stderr line SLICED TO 200 CHARS. A message
  # that opened with the path (~80 chars of tmpdir) would be cut off exactly at
  # "Do NOT clear it" — leaving a reader with a dead pid, no warning, and the
  # obvious wrong conclusion. Same rule the `refused, nothing measured` line
  # above states: cause before path, on any line a cap can reach.
  printf 'the suite lock is HELD but its pid file names no live process (pid: %s), waited %ss. Do NOT clear it: the pid file LAGS the real holder. Re-run; check ps for a live node --test first\n' \
    "${now:-absent}" "$waited" 1>&2
}

waited=0
while ! mkdir "$LOCK" 2>/dev/null; do
  holder=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    rm -rf "$LOCK"
    continue
  fi
  if [ "$waited" -ge 30 ]; then
    # STRICTLY under the exec entry's timeoutMs, and not merely equal to it: an
    # equal deadline means the exec SIGKILLs this child at the instant this
    # message would print, so the caller gets "timed out" — the least
    # informative outcome — and never learns a second run was the cause. That is
    # what shipped, and it cost three misdiagnosed timeouts.
    # test/test-digest-lock.test.js pins the relation against the shipped def.
    #
    # 30s also beats waiting the full cap on purpose: the caller is an agent
    # whose turn is billed while this blocks, and the suite runs in ~74s, so a
    # holder is either nearly done or wedged. Long enough to inherit a finishing
    # run, short enough that the answer arrives while it is still worth having.
    lock_refusal
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
#
# THE HALF THIS DOES NOT COPY: that gate also refuses to run when the branch
# changes package.json dependencies, because the suite then resolves out of the
# ROOT's installed tree and goes green over a dependency set the branch does not
# declare. This digest is deliberately OPTIMISTIC about dependencies — it is a
# self-check an agent fires mid-work, not a merge gate. A branch that touches
# deps gets a number that is real about the code and wrong about the deps; the
# loop's gate is the thing that catches that, and nothing merges without it.
if [ "$measure" != "$root" ] && [ ! -e "$measure/node_modules" ] \
   && [ -d "$root/node_modules" ]; then
  ln -s "$root/node_modules" "$measure/node_modules" 2>/dev/null
fi

out=$(node --test --test-reporter=tap 2>&1)
code=$?

pass=$(printf '%s\n' "$out" | awk '$1=="#" && $2=="pass" {n=$3} END{print n+0}')
tests=$(printf '%s\n' "$out" | awk '$1=="#" && $2=="tests" {n=$3} END{print n+0}')
fail=$(printf '%s\n' "$out" | awk '$1=="#" && $2=="fail" {n=$3} END{print n+0}')

# THE EVIDENCE, NOT JUST THE VERDICT. Everything above reduces `$out` to counts
# and names and then drops it on exit — assertion text, diff, stack and anything
# the test printed. Two agents were each blocked on evidence this script had
# already captured and threw away.
#
# WHERE. Outside the measured tree, always: that tree is the user's checkout, or
# a worktree that gets removed under us. `~/.clodex/test-failures/` is a SHARED
# root dir, deliberately not under `run/<name>/` — that one is rm -rf'd on every
# exit path (clodex-paths.js's header is the authority on the split, and names
# putting must-survive data under the run dir as the recurring bug).
#
# BOUNDED BY SHAPE, NOT BY A SWEEP. One fixed file that every failing run
# overwrites, with the body line-capped in awk below. It cannot grow, so there
# is nothing to prune later — t187 exists because a log grew at 1.16 MB/day and
# a second one is not worth a reader who read the digest line seconds ago.
#
# The cost of one fixed path is that a second tree's failure clobbers the first
# before anyone reads it. The box-wide lock above already serializes runs, and
# the header written below names the tree, the commit and the time, so a stale
# or foreign dump is detectable on sight rather than silently misread.
keep_dir=${CLODEX_HOME:-$HOME/.clodex}/test-failures
keep=$keep_dir/last.txt
# Display form for the digest line, which is capped at 180 chars and where the
# failing NAMES are the more valuable half. Empty $HOME would make the pattern
# `/*` and match everything, so the guard is not decorative.
keep_show=$keep
if [ -n "$HOME" ]; then
  case $keep in "$HOME"/*) keep_show="~${keep#"$HOME"}" ;; esac
fi

# Writes $out to $keep and succeeds, or fails and writes nothing — the caller
# names the file on the digest line ONLY on success, so an unwritable home
# cannot produce a digest pointing at a file that is not there.
#   $1: "tap" to trim, anything else to keep a raw tail.
save_failing_output() {
  mkdir -p "$keep_dir" 2>/dev/null || return 1
  {
    printf '# clodex test-digest — preserved output of a FAILING run.\n'
    printf '# ONE fixed file, overwritten by the next failing run on this box.\n'
    printf '# tree:  %s\n' "$measure"
    printf '# head:  %s %s\n' \
      "$(git -C "$measure" rev-parse --abbrev-ref HEAD 2>/dev/null)" \
      "$(git -C "$measure" log -1 --format='%h %s' 2>/dev/null)"
    printf '# when:  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)"
    printf '# count: %s/%s green, %s failing (exit %s)\n\n' "$pass" "$tests" "$fail" "$code"
    # Two sections, buffered and emitted separately so the caps cannot evict the
    # failing rows: a single running cap over a suite whose passing tests print
    # heavily would drop exactly the blocks this file exists to preserve.
    #
    # The raw fallback is the same guard one level up. A reduction that matches
    # nothing yields a confidently EMPTY file, which is worse than no file at
    # all — it reads as "the runner said nothing". If no `not ok` row matched,
    # the TAP grammar is not what this expects and the raw tail ships instead.
    printf '%s\n' "$out" | awk -v raw="$1" '
      BEGIN { fcap = 2000; dcap = 400; rcap = 400; state = 0 }
      { r[NR] = $0 }
      raw != "tap" { next }
      state == 2 {
        nf++; f[nf] = $0
        # ANCHORED TO THE OPENER INDENT, and that is the whole point: node
        # assert emits a bare `...` elision INSIDE a large deep-equal diff,
        # deeper-indented than the block it sits in. An unanchored terminator
        # ends the block there and silently drops the rest of the diff, `code:`
        # and the entire `stack:` — on precisely the big-diff failures this
        # file exists to preserve.
        if ($0 ~ /^[ \t]*\.\.\.[ \t]*$/) {
          match($0, /^[ \t]*/)
          if (RLENGTH == ind) state = 0
        }
        next
      }
      state == 1 {
        if ($0 ~ /^[ \t]*---[ \t]*$/) {
          nf++; f[nf] = $0; state = 2
          match($0, /^[ \t]*/); ind = RLENGTH
          next
        }
        state = 0
      }
      # A failing row at any nesting depth, then the YAML block node writes under
      # it — that block is where the assertion text, the diff and the stack are.
      /^[ \t]*not ok [0-9]+ - / { nf++; f[nf] = $0; state = 1; next }
      # One `# Subtest:` per test in the suite, i.e. THOUSANDS at real scale,
      # against a cap of a few hundred. Keeping them starves the diagnostics
      # buffer with names that are already in the failure rows above, and the
      # middle-drop then evicts what this section is actually for: mid-run test
      # stdout and the `# Error: ... asynchronous activity after the test
      # ended` escapes that test/test-escapes.test.js is the guard on.
      # No apostrophes anywhere in this awk program: it is single-quoted, and
      # one would end it mid-script.
      /^# Subtest: / { next }
      # Top-level diagnostics: test stdout and the summary tail.
      /^# / { nd++; d[nd] = $0 }
      END {
        if (raw != "tap" || nf == 0) {
          if (raw == "tap") print "## no `not ok` row matched — raw tail follows"
          lo = (NR > rcap) ? NR - rcap + 1 : 1
          if (lo > 1) printf "## (%d earlier lines dropped)\n", lo - 1
          for (i = lo; i <= NR; i++) print r[i]
          exit
        }
        print "## failing rows, with the assertion text, diff and stack"
        hi = (nf > fcap) ? fcap : nf
        for (i = 1; i <= hi; i++) print f[i]
        if (nf > hi) printf "## (%d further failure lines dropped)\n", nf - hi
        print ""
        print "## top-level diagnostics (test stdout and the summary)"
        if (nd > dcap) {
          h = int(dcap / 2)
          for (i = 1; i <= h; i++) print d[i]
          printf "## (%d diagnostic lines dropped)\n", nd - dcap
          for (i = nd - (dcap - h) + 1; i <= nd; i++) print d[i]
        } else {
          for (i = 1; i <= nd; i++) print d[i]
        }
      }
    '
  } > "$keep.tmp" 2>/dev/null || { rm -f "$keep.tmp" 2>/dev/null; return 1; }
  # Rename, because the reader is an agent running `cat` outside this script's
  # lock: writing in place lets it read a half-written dump as the whole truth.
  mv "$keep.tmp" "$keep" 2>/dev/null || { rm -f "$keep.tmp" 2>/dev/null; return 1; }
}

if [ "$tests" -eq 0 ]; then
  # The runner never produced a summary — surface its last line, not silence.
  # This arm carries the LEAST information of the three, so it is the one that
  # most needs the dump; there is no TAP to trim, hence the raw tail.
  last=$(printf '%s\n' "$out" | awk 'NF{l=$0} END{print l}')
  at=
  save_failing_output raw && at=" ($keep_show)"
  printf '%.180s\n' "[$tree] suite did not run$at: $last" 1>&2
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
# BEFORE the names, not after, even though the names are the more valuable half
# of this line. The file holds every `not ok` row itself, so a name the 180-char
# cap truncates is still recoverable from it; a truncated PATH is recoverable
# from nothing, and it is precisely the run with the most failing names — the
# one that overruns the cap — that has the most evidence worth pointing at.
at=
save_failing_output tap && at=" ($keep_show)"
printf '%.180s\n' "[$tree] $pass/$tests green, $fail failing$at: $names" 1>&2
[ "$code" -eq 0 ] && exit 1
exit "$code"
