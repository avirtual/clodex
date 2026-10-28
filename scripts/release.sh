#!/usr/bin/env bash
#
# Clodex release pipeline — one command, no babysitting.
#
#   scripts/release.sh [--quiet] <patch|minor|major|X.Y.Z> [notes-file]
#
# Bumps the version, builds the arm64 DMG, commits + tags + pushes, and cuts
# the GitHub release. Every step is mechanical; the only judgement call is the
# release notes. By default notes are auto-generated from the commit subjects
# since the last tag — pass a notes-file (markdown) to override with hand-
# written copy.
#
# Fails loudly and stops at the first error (set -euo pipefail). Nothing here
# is interactive: run it only when you actually mean to ship.
#
set -euo pipefail

# --- locate repo root (script lives in scripts/) ---------------------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --- args ------------------------------------------------------------------
# --quiet is filtered OUT of the positional args before they are read, so it may
# sit anywhere on the line without displacing the bump or the notes file.
QUIET=0
ARGS=()
for a in "$@"; do
  case "$a" in
    -q|--quiet) QUIET=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
if [ -n "${CI:-}" ]; then QUIET=1; fi
set -- ${ARGS[@]+"${ARGS[@]}"}

# The log must survive the `rm -rf dist` at the build step and must exist before
# the version is known (both smoke tests run before the bump), so it lives
# outside the tree and is named by timestamp rather than by version. It is
# deliberately NOT on the EXIT trap: a log deleted on the failure path is
# useless exactly when it is the only record of what failed.
LOG=""
if [ "$QUIET" = 1 ]; then
  LOG="${RELEASE_LOG:-${TMPDIR:-/tmp}/clodex-release-$(date +%Y%m%d-%H%M%S).log}"
  : > "$LOG" || { printf 'release: cannot write log %s\n' "$LOG" >&2; exit 1; }
fi

die() {
  printf '\n\033[31mrelease: %s\033[0m\n' "$1" >&2
  if [ -n "$LOG" ]; then printf 'release: full log at %s\n' "$LOG" >&2; fi
  exit 1
}
# say = milestone, always on stdout. note = detail, stdout only when verbose.
# step = section header. run = a child command whose output is verbose middle.
say()  { printf '%s\n' "$1"; if [ -n "$LOG" ]; then printf '%s\n' "$1" >>"$LOG"; fi; }
note() { if [ "$QUIET" = 1 ]; then printf '%s\n' "$1" >>"$LOG"; else printf '%s\n' "$1"; fi; }
step() {
  if [ "$QUIET" = 1 ]; then printf '\n==> %s\n' "$1" >>"$LOG"
  else printf '\n\033[36m==> %s\033[0m\n' "$1"; fi
}
run()  { if [ "$QUIET" = 1 ]; then "$@" >>"$LOG" 2>&1; else "$@"; fi; }

BUMP="${1:-}"
NOTES_FILE="${2:-}"
[ -n "$BUMP" ] || die "usage: scripts/release.sh [--quiet] <patch|minor|major|X.Y.Z> [notes-file]"
if [ -n "$LOG" ]; then say "quiet mode — verbose output at $LOG"; fi
if [ -n "$NOTES_FILE" ] && [ ! -f "$NOTES_FILE" ]; then
  die "notes file not found: $NOTES_FILE"
fi

# --- preflight -------------------------------------------------------------
step "Preflight"
command -v gh >/dev/null   || die "gh CLI not installed"
gh auth status >/dev/null 2>&1 || die "gh not authenticated (run: gh auth login)"

BRANCH="$(git branch --show-current)"
[ "$BRANCH" = "master" ] || die "not on master (on '$BRANCH'); release from master only"

git fetch --quiet origin master || die "git fetch failed"
# BEHIND is the failure; AHEAD is the normal case. Requiring equality here
# blocked releasing unpushed work — which is most releases, since the script
# pushes master itself further down. Only commits on the remote that we do not
# have can make the build disagree with what ships, so that is what this tests.
BEHIND="$(git rev-list --count HEAD..@{u})" || die "could not compare with origin/master"
[ "$BEHIND" = "0" ] \
  || die "local master is $BEHIND commit(s) BEHIND origin/master — pull first, or the release would ship without them"

# web-dist staleness guard (T42): the prebuilt browser bundle is TRACKED, so a
# release must ship a bundle built from the current sources. Rebuild it here —
# BEFORE the dirty-tree check below — so a stale web-dist/index.html dirties the
# tree and the dirty check IS the staleness failure ("web-dist stale — rebuild
# and commit"). A clean rebuild leaves the tree untouched and the check passes.
step "Rebuilding web bundle (web-dist staleness guard)"
npm run build:web >/dev/null || die "build:web failed — the tracked web-dist bundle could not be rebuilt"

if [ -n "$(git status --porcelain)" ]; then
  die "working tree is dirty — commit or stash before releasing (a dirty web-dist/ here means the committed bundle is stale: re-run 'npm run build:web' and commit it)"
fi

# Runtime-split smoke: import + exercise wire/ under the ELECTRON binary.
# node --test can't see BoringSSL gaps (the blake2b512 incident, 3297835);
# this is the only preflight step that runs in the runtime we actually ship.
step "Electron runtime smoke (wire/)"
run node scripts/electron-smoke.js || die "electron smoke failed — wire/ uses something Electron's runtime lacks"

# Renderer startup smoke: the unit suite reasons about the renderer as text and
# so shipped v5.5.0 with a renderer that threw on load and drew nothing. This
# step is the only one that opens a window.
step "Renderer startup smoke (index.html)"
run node scripts/renderer-smoke.js || die "renderer smoke failed — the renderer throws on startup or never renders the sidebar"

CUR_VERSION="$(node -p "require('./package.json').version")"
RESUME=""
if git tag --points-at HEAD | grep -qx "v$CUR_VERSION"; then
  REMOTE_TAG="$(git ls-remote --tags origin "refs/tags/v$CUR_VERSION")" || die "git ls-remote failed"
  if [ -z "$REMOTE_TAG" ]; then
    RESUME=push
    say "resuming release v$CUR_VERSION from the push step"
  elif ! gh release view "v$CUR_VERSION" >/dev/null 2>&1; then
    RESUME=gh
    say "resuming release v$CUR_VERSION from the gh release step"
  fi
fi
if [ "${CLODEX_RELEASE_NO_REVIEW:-}" = 1 ]; then
  [ -z "$NOTES_FILE" ] || die "CLODEX_RELEASE_NO_REVIEW=1 cannot ship a notes file: the pre-release review certified the Unreleased section, not $NOTES_FILE — drop one or the other"
  REVIEWED="$(git rev-parse "HEAD${RESUME:+^}")"
  WHICH=HEAD; [ -z "$RESUME" ] || WHICH="the reviewed commit"
  MARK="$HOME/.clodex/logs/prerelease-clean-$REVIEWED"
  [ -f "$MARK" ] || die "CLODEX_RELEASE_NO_REVIEW=1 but no CLEAN pre-release review covers $WHICH $(git rev-parse --short=8 "$REVIEWED") — run scripts/pre-release-review.sh and wait for its CLEAN issue, or release with the post-release review"
  say "pre-release review CLEAN for $WHICH: $(cat "$MARK")"
fi

PREV_TAG="$(git describe --tags --abbrev=0 ${RESUME:+HEAD^} 2>/dev/null || true)"
note "previous tag: ${PREV_TAG:-<none>}"

# Everything below edits tracked files before the build; a die before the commit must not leave them for the dirty-tree preflight.
NOTES=""
COMMITTED=0
release_cleanup() {
  if [ -n "$NOTES" ]; then rm -f "$NOTES"; fi
  if [ "$COMMITTED" = 1 ]; then return 0; fi
  local f
  for f in "$@"; do
    if [ -e "$f" ]; then git checkout -- "$f" 2>/dev/null || true; fi
  done
  printf 'release aborted: version bump and CHANGELOG stamp rolled back\n' >&2
}
trap 'release_cleanup package.json package-lock.json CHANGELOG.md cli/deploy/helm/clodex/values.yaml cli/deploy/helm/clodex/Chart.yaml cli/deploy/clodex-fargate.yaml' EXIT

# --- compute the new version (writes package.json + lock, no commit/tag) ---
step "Bumping version ($BUMP)"
if [ -n "$RESUME" ]; then
  NEW_VERSION="$CUR_VERSION"
  COMMITTED=1
else
  NEW_VERSION="$(npm version "$BUMP" --no-git-tag-version | tail -1 | sed 's/^v//')"
fi
TAG="v$NEW_VERSION"
KEPT_NOTES="$HOME/.clodex/logs/release-notes-$TAG.md"
say "new version: $NEW_VERSION  ->  tag $TAG"

if [ -z "$RESUME" ] && git tag | grep -qx "$TAG"; then die "tag $TAG already exists"; fi

# --- sync the packaged deploy assets to the new version --------------------
# cli/deploy/ ships one reviewable asset per deploy flavor, and each NAMES the
# container image it runs. The image is published at $NEW_VERSION below
# (publish-image.sh), but nothing updated the assets that name it — so they
# drifted from the app and from each other (a 4.5.0 app shipping a chart pinned
# at 4.1.0 and an appVersion of 3.5.3). That is live, not cosmetic: a fresh
# `clodexctl deploy helm <name>` brings up a three-version-old node, and a
# re-run REVERTS an operator's hand-upgraded cluster back to it.
#
# Same defect one layer up from the one recorded at the publish step below, and
# the same fix: fold it in rather than trust a human to remember.
#
# Anchored, one edit per file, and LOUD on a miss. A blanket version-shaped sed
# across the tree would rewrite unrelated pins (the CHART version, a sample
# digest, a doc example) and would silently rewrite nothing at all if a file
# moved — which is exactly the invisible drift being fixed. So each pin must
# match its anchor EXACTLY ONCE before the edit, and the expected line must be
# there EXACTLY ONCE after it. Verifying after is not belt-and-braces: it is the
# half that catches a substitution that ran and produced the wrong bytes.
#
# NOT synced: Chart.yaml's `version:`. Helm's two version fields answer
# different questions — appVersion is "which application does this deploy",
# `version` is the CHART's own revision, which helm records per release and
# reports in `helm history`/`rollback`. Moving it every patch would assert a
# structural change that did not happen, and an operator reading that history
# could no longer tell a chart change from an app rebuild. Hand-managed, and
# pinned as such in test/deploy-version-pin.test.js.
#
# `sed -i ''` is the BSD form. This script is macOS-only by construction
# already (it builds an arm64 DMG and ad-hoc-codesigns it), so that is the
# right dialect here rather than portability the rest of the file does not have.
step "Syncing deploy assets to $NEW_VERSION"
sync_pin() {
  local file="$1" anchor="$2" want="$3" n
  [ -f "$file" ] || die "deploy asset missing: $file (the release would ship an unpinned image reference)"
  n="$(grep -cE "$anchor" "$file" || true)"
  [ "$n" = "1" ] || die "deploy asset $file: version anchor matched $n times, expected exactly 1 — the file was restructured, so this sync is no longer updating it and the pin would silently stay at the old version"
  sed -E -i '' "s|$anchor|$want|" "$file"
  n="$(grep -cFx "$want" "$file" || true)"
  [ "$n" = "1" ] || die "deploy asset $file: after the edit the expected line appeared $n times, expected exactly 1 — the substitution did not produce what it claimed"
  note "  pinned $file"
}
sync_pin cli/deploy/helm/clodex/values.yaml \
  '^  tag: "[^"]+"$' "  tag: \"$NEW_VERSION\""
sync_pin cli/deploy/helm/clodex/Chart.yaml \
  '^appVersion: "[^"]+"$' "appVersion: \"$NEW_VERSION\""
sync_pin cli/deploy/clodex-fargate.yaml \
  "^    Default: 'ghcr\.io/avirtual/clodex:[^']+'\$" "    Default: 'ghcr.io/avirtual/clodex:$NEW_VERSION'"

# --- release notes (auto from commits, or the provided file) ---------------
step "Preparing release notes"
NOTES="$(mktemp)"
FOOTER=$'\n\n---\n\n**Apple Silicon (arm64) build.** Intel (x64) users can build from source (`npm install && npx electron-rebuild && npx electron-builder --mac dmg --x64`).\n\nUnsigned (ad-hoc) build: first launch needs right-click → Open, or `xattr -cr /Applications/Clodex.app`.'

# release title: tag, plus the notes-file's first heading as a subtitle when given
TITLE="$TAG"
CHANGELOG="CHANGELOG.md"
CHANGELOG_BODY=""
# The Unreleased section, when it has content, IS the release notes — that is
# what makes the changelog the thing people maintain rather than a file that
# quietly rots next to auto-generated notes. Empty (or absent) falls through to
# the commit-subject default, so this never blocks a release.
if [ -z "$RESUME" ] && [ -z "$NOTES_FILE" ] && [ -f "$CHANGELOG" ]; then
  CHANGELOG_BODY="$(awk '/^## +\[?Unreleased\]?/{f=1;next} /^## /{f=0} f' "$CHANGELOG")"
  [ -n "$(printf '%s' "$CHANGELOG_BODY" | tr -d '[:space:]')" ] || CHANGELOG_BODY=""
fi

STAMPED_HEADING=""
if [ -n "$RESUME" ] && [ -f "$CHANGELOG" ]; then
  STAMPED_HEADING="$(grep -m1 -F "## $NEW_VERSION — " "$CHANGELOG" || true)"
  SUBTITLE="$(printf '%s' "$STAMPED_HEADING" | sed -E 's/^## +[^ ]+ — [0-9-]+( — )?//')"
  [ -n "$SUBTITLE" ] && TITLE="$TAG — $SUBTITLE"
fi

if [ -n "$RESUME" ] && [ -z "$NOTES_FILE" ] && [ -f "$KEPT_NOTES" ]; then
  cat "$KEPT_NOTES" > "$NOTES"
  FOOTER=""
  note "  notes: kept copy $KEPT_NOTES"
elif [ -n "$NOTES_FILE" ]; then
  SUBTITLE="$(grep -m1 -E '^#+ +' "$NOTES_FILE" | sed -E 's/^#+ +//' || true)"
  [ -n "$SUBTITLE" ] && TITLE="$TAG — $SUBTITLE"
  cat "$NOTES_FILE" > "$NOTES"
elif [ -n "$CHANGELOG_BODY" ]; then
  # An optional subtitle rides the heading: `## Unreleased — Some theme`.
  SUBTITLE="$(grep -m1 -E '^## +\[?Unreleased\]?' "$CHANGELOG" | sed -E 's/^## +\[?Unreleased\]?[[:space:]]*(—|-)?[[:space:]]*//' || true)"
  [ -n "$SUBTITLE" ] && TITLE="$TAG — $SUBTITLE"
  printf '%s\n' "$CHANGELOG_BODY" > "$NOTES"
  # Stamp the section and open a fresh empty one ABOVE it, so the next cycle has
  # somewhere to write. Done before the commit below, which picks the file up.
  STAMP="## $NEW_VERSION — $(date +%Y-%m-%d)${SUBTITLE:+ — $SUBTITLE}"
  awk -v stamp="$STAMP" '
    !done && /^## +\[?Unreleased\]?/ { print "## Unreleased"; print ""; print stamp; done=1; next }
    { print }
  ' "$CHANGELOG" > "$CHANGELOG.tmp" && mv "$CHANGELOG.tmp" "$CHANGELOG"
  grep -qF "$STAMP" "$CHANGELOG" || die "changelog stamp failed — $STAMP is not in $CHANGELOG"
  note "  changelog: stamped $STAMP"
elif [ -n "$STAMPED_HEADING" ]; then
  awk -v h="$STAMPED_HEADING" '$0==h{f=1;next} /^## /{f=0} f' "$CHANGELOG" > "$NOTES"
else
  {
    echo "## What's changed"
    echo
    if [ -n "$PREV_TAG" ]; then
      git log "$PREV_TAG"..HEAD --no-merges --pretty='- %s' \
        | grep -viE '^- (v?[0-9]+\.[0-9]+\.[0-9]+|bump version|release )' || true
    else
      git log --no-merges --pretty='- %s' | head -20
    fi
  } > "$NOTES"
fi
printf '%s' "$FOOTER" >> "$NOTES"
# The preview echoes a file the operator just wrote, so quiet mode reports its
# shape instead of its content and keeps the full text in the log.
if [ "$QUIET" = 1 ]; then
  { echo "--- notes preview ---"; cat "$NOTES"; echo "---------------------"; } >>"$LOG"
  say "notes: $TITLE ($(grep -c '^- ' "$NOTES" || true) bullets)"
else
  echo "--- notes preview ---"; cat "$NOTES"; echo "---------------------"
fi

# --- build -----------------------------------------------------------------
if [ -n "$RESUME" ] && ls dist/*"$NEW_VERSION"*.dmg >/dev/null 2>&1; then
  say "resume: reusing the $NEW_VERSION DMG already in dist/"
else
  step "Building arm64 DMG"
  rm -rf dist
  run npm run dist:mac || die "build failed (try: npx electron-rebuild)"
fi

DMG="$(ls dist/*"$NEW_VERSION"*.dmg 2>/dev/null | head -1 || true)"
[ -n "$DMG" ] || die "no .dmg produced in dist/"
say "built: $DMG"

step "DMG pty probe"
run bash scripts/dmg-pty-probe.sh "$DMG" || die "the packaged app cannot spawn a shell through node-pty — do not ship this DMG"

step "DMG child probe"
run bash scripts/dmg-child-probe.sh "$DMG" || die "the packaged app cannot boot a plugin Electron child — do not ship this DMG"

# --- commit, tag, push -----------------------------------------------------
# The tag must name the commit built above, never a named ref like origin/master.
# Every check upstream — the web-dist rebuild, the smoke test, the deploy pins,
# the DMG — validates the WORKING TREE. Tagging anything else would leave all of
# them reading bytes that are not the ones shipping, and they would read green
# precisely when the two disagree.
step "Commit + tag + push"
if [ -z "$RESUME" ]; then
  run git commit -am "$TAG" || die "commit failed"
fi
COMMITTED=1
if [ -z "$RESUME" ]; then
  git tag "$TAG"
fi
{ mkdir -p "$(dirname "$KEPT_NOTES")" && cp "$NOTES" "$KEPT_NOTES"; } || die "could not keep the notes at $KEPT_NOTES"
note "notes kept at $KEPT_NOTES"
followups() {
  printf 'gh release create %s %s --title "%s" --notes-file %s\nscripts/publish-image.sh %s\nscripts/cloud-review.sh %s %s\n(or re-run scripts/release.sh to resume)' \
    "$TAG" "$DMG" "$TITLE" "$KEPT_NOTES" "$NEW_VERSION" "$PREV_TAG" "$TAG"
}
PUSH_FAILED="tag $TAG is committed locally but not on origin — finish with:
git push origin master $TAG
$(followups)"
run git push origin master || die "git push failed: $PUSH_FAILED"
run git push origin "$TAG"  || die "git push tag failed: $PUSH_FAILED"
say "pushed master and $TAG to origin"

# --- publish ---------------------------------------------------------------
step "Creating GitHub release $TAG"
# GitHub's asset upload has answered HTTP 500 on a healthy release; a retry succeeded.
ATTEMPTS=3
attempt=1
published=0
while [ "$attempt" -le "$ATTEMPTS" ]; do
  if [ "$attempt" -gt 1 ]; then sleep "${RELEASE_RETRY_SLEEP:-15}"; fi
  if run gh release view "$TAG" >/dev/null 2>&1; then
    if run gh release upload "$TAG" "$DMG" --clobber; then published=1; break; fi
  elif run gh release create "$TAG" "$DMG" \
    --title "$TITLE" \
    --notes-file "$NOTES"; then
    published=1; break
  fi
  attempt=$((attempt + 1))
done

# --- prune old release assets ---------------------------------------------
# Keep the DMG pile bounded: only the newest KEEP releases retain binaries
# (tags + notes always survive; old versions stay buildable from source).
# Non-fatal — the release itself is already published.
# The retention count lives in prune-releases.sh (KEEP, default 5); don't
# duplicate the number here — the prune script reports its own effective KEEP.
if [ "$published" = 1 ]; then
  step "Pruning old release assets"
  run "$(dirname "$0")/prune-releases.sh" --delete || say "warn: prune failed (release is fine); run scripts/prune-releases.sh --delete manually"
fi

# --- publish the sandbox image --------------------------------------------
# Non-fatal: a docker/buildx hiccup must not leave the caller thinking the
# release failed. It IS load-bearing though — running it by hand let ghcr's :latest drift three
# versions behind, which is undiagnosable from a deployed box (an old image's
# hello carries no webHost, so features simply appear missing).
step "Publishing container image $NEW_VERSION"
if run "$(dirname "$0")/publish-image.sh" "$NEW_VERSION"; then
  say "image published: $NEW_VERSION (+latest)"
else
  say "warn: image publish failed; run scripts/publish-image.sh $NEW_VERSION manually"
fi
[ "$published" = 1 ] || die "gh release create failed (tag/commit are already pushed, notes kept at $KEPT_NOTES) — finish with:
$(followups)"

step "Launching cloud release review"
if run "$(dirname "$0")/cloud-review.sh" "$PREV_TAG" "$TAG"; then
  if [ -n "$LOG" ]; then say "$(tail -n 1 "$LOG")"; fi
else
  say "warn: cloud review launch failed; run scripts/cloud-review.sh $PREV_TAG $TAG manually"
fi

step "Done"
say "released $TAG"
say "$(gh release view "$TAG" --json url -q .url)"
