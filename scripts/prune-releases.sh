#!/usr/bin/env bash
# prune-releases.sh — expire old release BINARIES (assets) on GitHub while
# keeping every release + tag + notes intact (history stays browsable; any old
# version stays buildable from source at its tag).
#
# Retention: the newest KEEP releases (by creation date) keep their assets;
# everything older has its assets deleted. Deleting an asset is permanent —
# hence dry-run by default.
#
#   scripts/prune-releases.sh            # dry-run: print what would be deleted
#   scripts/prune-releases.sh --delete   # actually delete
#   KEEP=10 scripts/prune-releases.sh    # override retention (default 5)
set -euo pipefail

REPO="avirtual/clodex"
KEEP="${KEEP:-5}"
MODE="dry-run"
[[ "${1:-}" == "--delete" ]] && MODE="delete"

# KEEP must be a positive integer — a typo (KEEP=abc) or KEEP=0 would otherwise
# keep zero releases and delete every asset. Die loudly rather than nuke assets.
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || {
  echo "error: KEEP must be a positive integer (got '$KEEP')" >&2; exit 2; }

# Newest-first list of releases with their assets. NOTE: under --paginate the
# --jq filter runs PER response page, so sort_by|reverse sorts within each page,
# not globally across pages. That's cosmetic here: the GitHub API already returns
# releases newest-first, and with <100 releases they all land on one per_page=100
# page. A true cross-page global sort isn't worth the jq gymnastics unless/until
# we exceed 100 releases.
rows=$(gh api "repos/$REPO/releases?per_page=100" --paginate \
  --jq 'sort_by(.created_at) | reverse | .[] |
        {tag: .tag_name, assets: [.assets[] | {id, name, size}]} | @json')

total_bytes=0
total_assets=0
i=0
while IFS= read -r row; do
  [[ -z "$row" ]] && continue   # no releases → empty $rows is one blank line; skip it
  i=$((i + 1))
  tag=$(jq -r '.tag' <<<"$row")
  if (( i <= KEEP )); then
    echo "KEEP    $tag"
    continue
  fi
  while IFS=$'\t' read -r id name size; do
    [[ -z "$id" ]] && continue
    total_assets=$((total_assets + 1))
    total_bytes=$((total_bytes + size))
    if [[ "$MODE" == "delete" ]]; then
      gh api -X DELETE "repos/$REPO/releases/assets/$id" >/dev/null
      echo "DELETED $tag  $name  ($((size / 1024 / 1024)) MB)"
    else
      echo "would delete  $tag  $name  ($((size / 1024 / 1024)) MB)"
    fi
  done < <(jq -r '.assets[] | [.id, .name, .size] | @tsv' <<<"$row")
done <<<"$rows"

echo "----"
echo "$MODE: $total_assets assets, $((total_bytes / 1024 / 1024 / 1024)) GB (kept newest $KEEP releases untouched)"
