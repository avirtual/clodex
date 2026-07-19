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

if [ -n "$(git status --porcelain)" ]; then
  die "working tree is dirty — commit or stash before releasing"
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
step "Pruning old release assets (keep newest ${KEEP:-5})"
"$(dirname "$0")/prune-releases.sh" --delete || echo "warn: prune failed (release is fine); run scripts/prune-releases.sh --delete manually"

step "Done"
echo "released $TAG"
gh release view "$TAG" --json url -q .url
