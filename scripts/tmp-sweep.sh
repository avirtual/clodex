#!/usr/bin/env bash
# tmp-sweep.sh — manual janitor for the scratch roots the test suite abandons in
# $TMPDIR.
#
# The suite mints scratch roots with mkdtemp in $TMPDIR. test/lib/tmp-roots.js
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
#   - direct children of $TMPDIR only, never followed through a symlink
#   - names matching an enumerated prefix AND mkdtemp's own suffix shape,
#     with every prefix required to be free of regex metacharacters
set -uo pipefail

# Every prefix the suite mints, enumerated from the source rather than guessed:
# across every tracked .js, the union of raw mint-literals, mkTmpRoot() literals,
# and literals passed to a local wrapper that forwards its parameter to one of
# those (`mkEngine('t748-rows-')` → `mkHome(prefix)` → `mkTmpRoot(prefix)`, to a
# fixpoint so a wrapper declared above its callee resolves too). Strings and
# comments are masked out first, so prose naming a mint call is not read as one.
# test/tmp-sweep-prefix-coverage.test.js re-derives that union from source and
# reds when a new prefix is not covered here, which is the only thing stopping
# this list going stale.
#
# mkTmpDirIn() prefixes are deliberately absent: it mints INSIDE an already
# tracked root, so those directories are never direct children of $TMPDIR and
# this sweep removes them with their parent or not at all.
#
# Listed in full, NOT collapsed to family roots, and the difference is not
# cosmetic. Keeping only `clodex-` because it is a string-prefix of
# `clodex-pend-` would drop every `clodex-pend-*` root on the floor: the suffix
# rule below anchors six random characters directly after the prefix, so
# `clodex-` matches `clodex-TB03fh` and NOT `clodex-pend-TB03fh`. Measured: the
# collapsed list matched about one root in five of what the full list matches.
# If you shorten this list, you are deleting coverage, not duplication.
#
# The generic-looking tail (proj-, reg-, ctx-, outer-, plain-) is safe ONLY
# because of the suffix shape below: `ctx-0J62Vc` is ours, `ctx-cache` is
# somebody else's and does not match.
#
# Parsed by the test between this quote and the closing one — keep the shape.
PREFIXES='
basepath-
boxed-
ce-cwd-
ce-home-
clodex-2team-
clodex-arch-
clodex-atomic-
clodex-bash-marks-
clodex-bundles-
clodex-candidate-
clodex-changelog-
clodex-check-syntax-
clodex-check-syntax-notrunk-
clodex-check-syntax-remote-
clodex-check-syntax-unborn-
clodex-confine-mem-
clodex-confine-reg-
clodex-confine-ud-
clodex-control-
clodex-default-mode-
clodex-depless-root-
clodex-depless-tree-
clodex-disc-
clodex-empty-
clodex-envroot-
clodex-envud-
clodex-eoo-
clodex-eoo2-
clodex-escape-
clodex-exec-
clodex-fake-plugin-
clodex-first-run-
clodex-fix-outbox-
clodex-folder-
clodex-folder-bad-
clodex-folder-clear-
clodex-folder-gone-
clodex-folder-peer-
clodex-folder-x-
clodex-fse-
clodex-gone-
clodex-guard-
clodex-hc-
clodex-hint-
clodex-home-
clodex-hooks-
clodex-hs-
clodex-init-
clodex-ipccache-
clodex-jsonlw-
clodex-keymap-
clodex-keymap-probe-
clodex-keys-
clodex-killswitch-
clodex-leakpin-
clodex-library-stage-
clodex-live-
clodex-live-cwd-
clodex-live-fb-
clodex-live-real-
clodex-loader-library-stage-
clodex-loader-registered-
clodex-loader-source-
clodex-loader-source-elsewhere-
clodex-loader-source-moved-
clodex-loader-source-stage-
clodex-loop-
clodex-loop-repo-
clodex-loop-seed-
clodex-loop-ud-
clodex-mem-
clodex-mem-outside-
clodex-menu-
clodex-merge-
clodex-merge-repo-
clodex-merge-seed-
clodex-merge-userdata-
clodex-meta-
clodex-mig-
clodex-mon-
clodex-move-
clodex-move-a-
clodex-move-b-
clodex-move-beta-
clodex-move-exit-
clodex-move-home-
clodex-move-inrepo-
clodex-move-outrepo-
clodex-move-outrepo2-
clodex-msg-
clodex-mv-data-
clodex-mv-decoyhome-
clodex-mv-envroot-
clodex-mv-home-
clodex-mv-link-
clodex-mv-real-
clodex-mv-secret-
clodex-norepo-
clodex-not-a-worktree-
clodex-nr-
clodex-nr2-
clodex-nri-
clodex-out-
clodex-outbox-
clodex-outside-
clodex-outsider-
clodex-outsider-b-
clodex-pend-
clodex-pend-ondata-
clodex-plugin-source-
clodex-plugin-source-library-
clodex-plugin-source-sidecar-
clodex-plugin-source-stage-
clodex-plugin-source-tree-
clodex-plugin-source-work-
clodex-plugin-test-
clodex-plugins-
clodex-poll-
clodex-pr-
clodex-preflight-
clodex-proj-
clodex-ptr-
clodex-quiet-host-
clodex-quota-
clodex-rcost-
clodex-rcost-ud-
clodex-readme-
clodex-refresh-
clodex-reg-
clodex-release-die-
clodex-release-log-
clodex-remind-pending-
clodex-rename-
clodex-rename-proj-
clodex-rename-seed-
clodex-rename-ud-
clodex-repo-
clodex-repo-b-
clodex-repo-b-wt-
clodex-repoint-
clodex-repoint2-
clodex-respec-
clodex-retire-
clodex-retire-intree-
clodex-revert-
clodex-review-
clodex-review-fx-
clodex-review-t699-
clodex-review-t791-
clodex-review-t791-x-
clodex-rm-
clodex-rtn-
clodex-rv-
clodex-scm-
clodex-scope-
clodex-sinfo-
clodex-sinfo-overlay-
clodex-sm-
clodex-solo-home-
clodex-solo-repo-
clodex-surface-
clodex-surface-gate-
clodex-sweep-
clodex-sweeptest-
clodex-t166-
clodex-t170-
clodex-t188-
clodex-t240-
clodex-t390-
clodex-t390-ud-
clodex-t395-
clodex-t395-repo-
clodex-t395-ud-
clodex-t416-
clodex-t416-ud-
clodex-t418-seam-
clodex-t433-
clodex-t470-
clodex-t470-repo-
clodex-t470-seed-
clodex-t470-ud-
clodex-t482-
clodex-t482-repo-
clodex-t482-seed-
clodex-t482-ud-
clodex-t57-
clodex-t618-
clodex-t618-repo-
clodex-t618-seed-
clodex-t618-ud-
clodex-t619-abs-
clodex-t619-base-
clodex-t619-rt-
clodex-t63-
clodex-t679-a-
clodex-t679-b-
clodex-t679-c-
clodex-t679-d-
clodex-t679-e-core-
clodex-t679-e-user-
clodex-t679-f-core-
clodex-t679-f-user-
clodex-t679-g-
clodex-t679-h-
clodex-t679-res-
clodex-t679-spawn-a-
clodex-t679-spawn-b-
clodex-t679-spawn-c-
clodex-t679-spawn-d-
clodex-t751-
clodex-t751-proj-
clodex-t751-proj2-
clodex-t751-sl-
clodex-t751-slproj-
clodex-t767-
clodex-t767-proj-
clodex-t776-gone-
clodex-t776-root-
clodex-t776-sub-
clodex-t776-task-
clodex-t776-tree-
clodex-t780-bare-
clodex-t780-clause-
clodex-t780-files-
clodex-t780-nocommit-
clodex-t780-take-
clodex-t801-code-
clodex-t801-host-
clodex-t801-other-
clodex-t801-symcode-
clodex-t801-symlink-
clodex-t817-
clodex-t827-home-
clodex-t827-repo-
clodex-t827-seed-
clodex-t827-tree-
clodex-t827-ud-
clodex-t830-
clodex-t870-outbox-
clodex-t911-mark-
clodex-t911-route-
clodex-t913-curated-
clodex-t913-fresh-
clodex-t94-sm-
clodex-t94-sm2-
clodex-tag-
clodex-tc-
clodex-tc2-
clodex-team-repo-
clodex-teammut-
clodex-teams-
clodex-tee-
clodex-teehome-
clodex-termreports-
clodex-termreports-home-
clodex-test-
clodex-textfeed-
clodex-textfeed-np-
clodex-tickets-
clodex-tk-
clodex-tm-
clodex-tpl-
clodex-ts-
clodex-tv-data-
clodex-tv-home-
clodex-tv-outside-
clodex-twt-
clodex-ud-
clodex-ui-
clodex-uisettings-
clodex-userroot-
clodex-vdraft-
clodex-verify-
clodex-verify-data-
clodex-voice-
clodex-voice-ipc-
clodex-voicedang-
clodex-voicesym-
clodex-voicesymd-
clodex-voicew-
clodex-watcher-
clodex-web-register-
clodex-wl-
clodex-workbench-test-
clodex-wscount-
clodex-wsdel-
clodex-wt-
clodex-wt-x-
clodexctl-attach-
clodexctl-cloud-
clodexctl-deploy-
clodexctl-docker-
clodexctl-fargate-t-
clodexctl-fargate-tok-
clodexctl-helm-
clodexctl-helm-t-
clodexctl-helm-tok-
clodexctl-ssm-
clodexctl-tok-
clodexctl-undeploy-t-
clodexctl-up-t-
clx-accounts-
clx-accounts-create-
clx-accounts-global-
clx-accounts-global-ud-
clx-accounts-ud-
clx-agentplugin-
clx-basket-
clx-bundle-
clx-cdelta-
clx-cf-
clx-clearcont-
clx-common-
clx-commonmeta-
clx-console-
clx-createdat-
clx-createdat-mgr-
clx-ctl-
clx-ctx-timeout-
clx-decoy-home-
clx-dm-home-
clx-dm-run-
clx-drawer-seam-
clx-eb-
clx-emb-
clx-eng-env-
clx-eng-help-
clx-eng-home-
clx-eng-prune-
clx-eng-sbx-
clx-eng-web-
clx-env-
clx-exec-home-
clx-hintarm-
clx-hintwire-
clx-hold-restore-
clx-home-
clx-idle-
clx-idle-seed-reg-
clx-idle-seed-ud-
clx-idle-ud-
clx-keepwarm-
clx-label-
clx-lib-
clx-lock-
clx-memload-
clx-move-reattach-
clx-nap-
clx-notice-wiring-
clx-pdf-
clx-refusal-
clx-registry-
clx-reload-env-
clx-reload-ud-
clx-repaint-
clx-repo-
clx-resumecwd-
clx-resumecwd-gone-
clx-resumecwd-nomain-
clx-resumecwd-repo-
clx-resumecwd-throw-
clx-runstatus-
clx-sandbox-
clx-sbx-detect-
clx-sbx-ud-
clx-shelldeny-
clx-skill-catalog-
clx-skillsoff-
clx-statusq-
clx-t279-
clx-t282-
clx-t283-
clx-t358-
clx-t358-OUTSIDER-
clx-t359-fakehome-
clx-t359-guard-
clx-t359-home-
clx-t359-ud-
clx-t363-
clx-t363-cap-
clx-t491-
clx-t5-
clx-t518-
clx-t678-bareflag-
clx-t678-content-
clx-t678-libdir-
clx-t678-name-
clx-t678-noskill-
clx-t678-scaffold-
clx-t678-verifytmp-
clx-t687-manifest-
clx-t699-
clx-t700-defs-
clx-t700-grant-
clx-t700-ipc-
clx-t700-ipcguard-
clx-t700-leaf-
clx-t700-run-
clx-t700-runbad-
clx-t700-runguard-
clx-t700-runnone-
clx-t700-shape-
clx-t700-shapeguard-
clx-t700-shapeplugin-
clx-t700-spawn-
clx-t700-spawnguard-
clx-t701-dry-
clx-t701-effect-
clx-t701-ipc-
clx-t701-real-
clx-t701-twice-
clx-t702-flip-
clx-t702-ipc-
clx-t702-lead-
clx-t702-leaf-
clx-t702-plan-
clx-t702-shared-
clx-t711-silent-
clx-t711-verb-
clx-t732-companions-
clx-t738-home-
clx-t738-repo-
clx-t738-ud-
clx-t747-
clx-t772-
clx-t826-
clx-t840-registry-
clx-t88-
clx-t88-CALLER-
clx-t910-
clx-t916-home-
clx-t918-
clx-t952-
clx-t952-env-
clx-t955-
clx-t962-staged-
clx-t962-verify-
clx-teamroot-
clx-totals-
clx-tpl-deny-
clx-tr-home-
clx-tr-repo-
clx-tr-run-
clx-tr-spill-
clx-ud-
clx-vec-
clx-wireoff-
clx-wt-
crt-
ct-parity-
cteam-
ctx-
cwdlink-
cwdout-
cwdproj-
cwdproj2-
cwdproj3-
cwdproj4-
cwdreal-
cx-commit-
cx-commit-other-
env-scopes-
envdef-home-
envdef-home2-
envdef-realud-
envdef-realud2-
envdef-reg-
envdef-src-
envdef-src2-
envdef-ud-
envfile-
execbin-
fs-util-
help-corpus-
hint-recall-
hold-restart-
ipc-act-home-
ipc-act-root-
ipc-del-home-
ipc-del-root-
ipc-team-home-
ipc-team-root-
legib-home-
legib-proj-
nodev-
notif-reg-
notif-ud-
outer-
parity-
parity-atomic-
parity-atomic-fail-
parity-atomic-mode-
parity-ledger-
parity-watchdog-
peerimp-ctx-
peerimp-reg-
peerimp-ud-
pending-test-
plain-
preseed-
proj-
proj2-
proj3-
proj4-
r5-noctx-
reg-
remind-gone-reg-
remind-gone-ud-
remind-race-reg-
remind-race-ud-
remote-resources-
remote-wt-
remote-wt-nr-
remotetok-
remsched-reg-
remsched-ud-
renderer-smoke-
renderer-smoke-profile-
retired-roster-
review-ab-
review-ab-empty-
review-ab-torn-
rolecwd-
rolecwd-lnk-
rolecwd-out-
rolecwd-real-
runner-root-
shadow-ret-
sm-nogit-
sm-wt-
spill-receipt-
stall-apierr-
stall-tail-
stores-reg-
stores-res-
stores-skillres-
stores-ud-
svcport-
t415-reg-
t415-ud-
t748-bad-
t748-empty-
t748-ipc-
t748-rows-
t748-shadow-
t748-two-
t753-
t753-parity-
t753-throw-
t754-home-
t754-root-
t770-home-
t770-proj-
t770-reg-
t770-tpl-
t770-ud-
t789-home-
t789-portable-
t789-portable-proj-
t789-proj-
t790-bad-
t790-both-
t790-empty-
t790-ipc-
t790-kind-
t790-rows-
t790-shadow-
t791-proj-
t803-bare-
t803-home-
t803-nokits-
t803-proj-
t808-
t808-reg-
t808-ud-
t810-
t822-nowhere-
t824-nowhere-
t830-home-
t830-root-
t836-state-
t838-blocked-
t891-proj-
t891-team-
t912-live-
t959-eng-
t959-hostlog-
t959-hostlog-clean-
t959-nodelog-
t959-term-
team-home-
teams-menu-
tl-home-
tl-none-
tl-outer-
tmp-roots-pin-
warmth-
wire-hold-cred-
ws-gate-
ws-spawnenv-
ws-src-
wt-fake-
wt-team-
'

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

NPREFIX="$(printf '%s' "$PREFIXES" | tr -d ' \t' | grep -cv '^$')"
ALT="$(printf '%s' "$PREFIXES" | tr -d ' \t' | grep -v '^$' | paste -sd'|' -)"
[ -n "$ALT" ] || die "prefix list is empty — refusing to match everything"

# Prefixes are interpolated raw into an extended regex below, so a future entry
# containing `.` or `+` would silently become a wildcard and widen what gets
# deleted. Every current entry is [A-Za-z0-9-]; anything else stops the run
# rather than quietly matching more than its author meant.
BADPREFIX="$(printf '%s' "$PREFIXES" | tr -d ' \t' | grep -v '^$' | grep -vE '^[A-Za-z0-9-]+$' | head -1)"
[ -z "$BADPREFIX" ] || die "prefix '$BADPREFIX' has characters that are regex metacharacters — refusing to run"

# The whole match, and the reason a prefix as generic as `proj-` is safe here:
# mkdtemp appends exactly six random alphanumerics, so a real scratch root is
# `<prefix><6 chars>`. The optional `-…` tail covers the derived siblings
# test/lib/tmp-roots.js documents (git-worktree.js drops `<base>-<branch>` beside
# the root it is given).
PATTERN=".*/($ALT)[A-Za-z0-9]{6}(-.*)?"
MINUTES=$((HOURS * 60))

LISTFILE="$(mktemp "$TMP/clodex-tmpsweep-XXXXXX")" || die "cannot create work file"
trap 'rm -f "$LISTFILE"' EXIT

# ONE enumeration pass over $TMPDIR, because that directory is huge: a single
# readdir of it costs ~170ms, and the full filtered walk measured 24s against
# several hundred thousand entries. Per-prefix passes would multiply that by the
# prefix count.
#
# -P never follows a symlink, so a symlinked entry cannot take the sweep out of
# $TMPDIR; -mindepth/-maxdepth 1 keep it to direct children; -type d means a
# symlink is not a candidate in the first place. Errors are dropped: entries
# owned by other users are expected here and are not ours to report on.
enumerate() {
  find -P -E "$TMP" -mindepth 1 -maxdepth 1 -type d -mmin "+$MINUTES" -regex "$PATTERN" -print0 2>/dev/null
}

enumerate > "$LISTFILE"
COUNT="$(tr -dc '\0' < "$LISTFILE" | wc -c | tr -d ' ')"

if [ "$COUNT" -eq 0 ]; then
  echo "tmp-sweep: nothing to remove in $TMP (older than ${HOURS}h, across $NPREFIX prefixes)"
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
  echo "tmp-sweep: would remove $COUNT directories, $HUMAN, from $TMP (older than ${HOURS}h)"
  echo "tmp-sweep: DRY RUN — nothing was removed. Re-run with --yes to remove them."
  exit 0
fi

echo "tmp-sweep: removing $COUNT directories, $HUMAN, from $TMP (older than ${HOURS}h)…"

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
