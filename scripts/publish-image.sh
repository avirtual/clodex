#!/usr/bin/env bash
#
# Clodex sandbox image publish — sandbox-plan.md [internal design doc, not in this repo] M0.
#
#   scripts/publish-image.sh [version]
#
# Builds the web-frontend image (docker/web/Dockerfile, repo-root context)
# multi-arch (arm64 + amd64) and pushes ghcr.io/avirtual/clodex:<version>
# plus :latest. Version defaults to package.json's — pass one explicitly to
# republish an older tag. Deliberately NOT part of release.sh: run manually
# after a release until this proves stable.
#
# Credentials ride the gh CLI: `gh auth token` must carry write:packages
# (grant once with `gh auth refresh -s write:packages`).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

die() { printf '\n\033[31mpublish-image: %s\033[0m\n' "$1" >&2; exit 1; }
step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }

IMAGE="ghcr.io/avirtual/clodex"
PLATFORMS="linux/arm64,linux/amd64"

# --- version ----------------------------------------------------------------
VERSION="${1:-$(node -p "require('./package.json').version")}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "bad version: '$VERSION' (want X.Y.Z)"

# --- preflights ---------------------------------------------------------------
step "preflight"
command -v docker >/dev/null || die "docker not found"
docker info >/dev/null 2>&1 || die "docker daemon not running"
docker buildx version >/dev/null 2>&1 || die "docker buildx not available"
command -v gh >/dev/null || die "gh not found"
gh auth status >/dev/null 2>&1 || die "gh not authenticated"
[ -f docker/web/Dockerfile ] || die "docker/web/Dockerfile missing (run from a checkout)"

# The published image must correspond to committed bytes. Building from a
# dirty tree would mint a version tag whose contents no commit describes.
[ -z "$(git status --porcelain)" ] || die "working tree dirty — commit or stash first"

# ghcr login via the gh token (needs write:packages).
step "login ghcr.io"
gh auth token | docker login ghcr.io -u avirtual --password-stdin >/dev/null \
  || die "ghcr login failed (token may lack write:packages — gh auth refresh -s write:packages)"

# A multi-arch push needs a docker-container builder (the default docker driver
# can't build foreign platforms or assemble a multi-arch manifest).
if ! docker buildx inspect clodex-multiarch >/dev/null 2>&1; then
  step "create buildx builder clodex-multiarch"
  docker buildx create --name clodex-multiarch --driver docker-container >/dev/null
fi

# --- build + push -------------------------------------------------------------
step "build + push $IMAGE:$VERSION + :latest ($PLATFORMS)"
docker buildx build \
  --builder clodex-multiarch \
  --platform "$PLATFORMS" \
  -f docker/web/Dockerfile \
  -t "$IMAGE:$VERSION" \
  -t "$IMAGE:latest" \
  --push \
  .

step "verify manifest"
docker buildx imagetools inspect "$IMAGE:$VERSION" | sed -n '1,12p'

printf '\n\033[32mpublished %s:%s (+latest)\033[0m\n' "$IMAGE" "$VERSION"
