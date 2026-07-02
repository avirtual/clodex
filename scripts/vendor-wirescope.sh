#!/bin/bash
# Vendor a pinned wirescope snapshot into vendor/wirescope.
#
# Takes the code-only runtime payload (logproxy.py, proxylab/, requirements.txt,
# LICENSE) from a COMMITTED ref of the wirescope checkout — never the working
# tree, which is a live agent's dirty workspace. Writes VENDOR.json so the
# shipped copy is traceable to an exact upstream commit.
#
# Usage: scripts/vendor-wirescope.sh [ref]        (default: the pinned REF below)
#        WIRESCOPE_SRC=/path/to/checkout scripts/vendor-wirescope.sh v0.6.13
set -euo pipefail

REF="${1:-v0.6.13}"
SRC="${WIRESCOPE_SRC:-$HOME/projects/proxy-lab}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor/wirescope"
PAYLOAD=(logproxy.py proxylab requirements.txt LICENSE)

[ -d "$SRC/.git" ] || { echo "error: no git checkout at $SRC (set WIRESCOPE_SRC)" >&2; exit 1; }
COMMIT=$(git -C "$SRC" rev-parse --verify "$REF^{commit}") \
  || { echo "error: ref $REF not found in $SRC" >&2; exit 1; }

rm -rf "$DEST"
mkdir -p "$DEST"
git -C "$SRC" archive "$COMMIT" -- "${PAYLOAD[@]}" | tar -x -C "$DEST"

# RELEASE stamp: wirescope's _detect_version() returns this verbatim, else it
# falls back to `git describe` — which, from inside OUR repo, would report
# Clodex's version as wirescope's. Written before the digest so it's covered.
printf '%s (vendored)\n' "$REF" > "$DEST/RELEASE"

# Deterministic payload digest: file-relative sha256 lines, sorted, hashed.
DIGEST=$(cd "$DEST" && find . -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)

cat > "$DEST/VENDOR.json" <<EOF
{
  "name": "wirescope",
  "repo": "https://github.com/avirtual/wirescope",
  "ref": "$REF",
  "commit": "$COMMIT",
  "vendored_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "payload_sha256": "$DIGEST",
  "payload": [$(printf '"%s",' "${PAYLOAD[@]}" | sed 's/,$//')]
}
EOF

echo "vendored wirescope $REF ($COMMIT)"
echo "  -> $DEST"
echo "  payload sha256: $DIGEST"
