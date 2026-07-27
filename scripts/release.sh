#!/usr/bin/env bash
#
# Clodex release pipeline — one command, no babysitting.
#
#   scripts/release.sh <patch|minor|major|X.Y.Z> [notes-file]
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

die() { printf '\n\033[31mrelease: %s\033[0m\n' "$1" >&2; exit 1; }
step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }

# --- args ------------------------------------------------------------------
BUMP="${1:-}"
NOTES_FILE="${2:-}"
[ -n "$BUMP" ] || die "usage: scripts/release.sh <patch|minor|major|X.Y.Z> [notes-file]"
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
[ "$(git rev-parse HEAD)" = "$(git rev-parse @{u})" ] \
  || die "local master is not in sync with origin/master — pull/push first"

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
node scripts/electron-smoke.js || die "electron smoke failed — wire/ uses something Electron's runtime lacks"

PREV_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
echo "previous tag: ${PREV_TAG:-<none>}"

# --- compute the new version (writes package.json + lock, no commit/tag) ---
step "Bumping version ($BUMP)"
NEW_VERSION="$(npm version "$BUMP" --no-git-tag-version | tail -1 | sed 's/^v//')"
TAG="v$NEW_VERSION"
echo "new version: $NEW_VERSION  ->  tag $TAG"

git tag | grep -qx "$TAG" && die "tag $TAG already exists"

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
  echo "  pinned $file"
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
trap 'rm -f "$NOTES"' EXIT
FOOTER=$'\n\n---\n\n**Apple Silicon (arm64) build.** Intel (x64) users can build from source (`npm install && npx electron-rebuild && npm run dist:mac`).\n\nUnsigned (ad-hoc) build: first launch needs right-click → Open, or `xattr -cr /Applications/Clodex.app`.'

# release title: tag, plus the notes-file's first heading as a subtitle when given
TITLE="$TAG"
if [ -n "$NOTES_FILE" ]; then
  SUBTITLE="$(grep -m1 -E '^#+ +' "$NOTES_FILE" | sed -E 's/^#+ +//' || true)"
  [ -n "$SUBTITLE" ] && TITLE="$TAG — $SUBTITLE"
  cat "$NOTES_FILE" > "$NOTES"
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
echo "--- notes preview ---"; cat "$NOTES"; echo "---------------------"

# --- build -----------------------------------------------------------------
step "Building arm64 DMG"
rm -rf dist
npm run dist:mac || die "build failed (try: npx electron-rebuild)"

DMG="$(ls dist/*.dmg 2>/dev/null | head -1 || true)"
[ -n "$DMG" ] || die "no .dmg produced in dist/"
echo "built: $DMG"
case "$DMG" in
  *"$NEW_VERSION"*) ;;
  *) die "dmg name ($DMG) does not contain version $NEW_VERSION" ;;
esac

# --- commit, tag, push -----------------------------------------------------
step "Commit + tag + push"
git commit -am "$TAG" || die "commit failed"
git tag "$TAG"
git push origin master || die "git push failed"
git push origin "$TAG"  || die "git push tag failed"

# --- publish ---------------------------------------------------------------
step "Creating GitHub release $TAG"
gh release create "$TAG" "$DMG" \
  --title "$TITLE" \
  --notes-file "$NOTES" \
  || die "gh release create failed (tag/commit are already pushed — fix and re-run just the gh step)"

# --- prune old release assets ---------------------------------------------
# Keep the DMG pile bounded: only the newest KEEP releases retain binaries
# (tags + notes always survive; old versions stay buildable from source).
# Non-fatal — the release itself is already published.
# The retention count lives in prune-releases.sh (KEEP, default 5); don't
# duplicate the number here — the prune script reports its own effective KEEP.
step "Pruning old release assets"
"$(dirname "$0")/prune-releases.sh" --delete || echo "warn: prune failed (release is fine); run scripts/prune-releases.sh --delete manually"

# --- publish the sandbox image --------------------------------------------
# Folded in after two manual runs proved it stable. Non-fatal for the same
# reason as the prune above: the GitHub release is already published, and a
# docker/buildx hiccup must not leave the caller thinking the release failed.
# It IS load-bearing though — running it by hand let ghcr's :latest drift three
# versions behind, which is undiagnosable from a deployed box (an old image's
# hello carries no webHost, so features simply appear missing).
step "Publishing container image $NEW_VERSION"
"$(dirname "$0")/publish-image.sh" "$NEW_VERSION" \
  || echo "warn: image publish failed (GitHub release is fine); run scripts/publish-image.sh $NEW_VERSION manually"

step "Done"
echo "released $TAG"
gh release view "$TAG" --json url -q .url
