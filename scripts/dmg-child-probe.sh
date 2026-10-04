#!/usr/bin/env bash
# Usage: scripts/dmg-child-probe.sh <path/to.dmg>
# Mounts the DMG read-only and boots the bundle's binary straight into a child script via --clodex-electron-child=.
set -euo pipefail

DMG="${1:-}"
[ -n "$DMG" ] || { echo "usage: $0 <path/to.dmg>"; exit 1; }
[ -f "$DMG" ] || { echo "dmg child probe: no such file: $DMG"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/clodex-dmgchild-XXXXXX")"
MNT="$WORK/mnt"
ERR="$WORK/stderr"
OUT="$WORK/stdout"
PROBE="$WORK/probe.js"
mkdir -p "$MNT"

cleanup() {
  hdiutil detach "$MNT" -force >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

if ! hdiutil attach -nobrowse -readonly -noverify -mountpoint "$MNT" "$DMG" >/dev/null 2>"$ERR"; then
  echo "dmg child probe: could not mount $DMG"
  cat "$ERR"
  exit 1
fi

shopt -s nullglob
APPS=("$MNT"/*.app)
shopt -u nullglob
if [ "${#APPS[@]}" -ne 1 ]; then
  echo "dmg child probe: expected exactly one .app in $DMG, found ${#APPS[@]}"
  exit 1
fi
APP="${APPS[0]}"
APP_NAME="$(basename "$APP" .app)"

shopt -s nullglob
EXES=("$APP"/Contents/MacOS/*)
shopt -u nullglob
if [ "${#EXES[@]}" -ne 1 ]; then
  echo "dmg child probe: expected exactly one executable in $APP_NAME.app/Contents/MacOS, found ${#EXES[@]}"
  exit 1
fi
EXE="${EXES[0]}"

cat >"$PROBE" <<'JS'
exports.run = (e) => { process.stdout.write('CXB-OK ' + typeof e.app.whenReady + '\n'); process.exit(0); };
JS

rc=0
(unset ELECTRON_RUN_AS_NODE; exec "$EXE" "--clodex-electron-child=$PROBE") >"$OUT" 2>"$ERR" &
pid=$!
( trap 'kill "$s" 2>/dev/null; exit 0' TERM; sleep 10 & s=$!; wait "$s"; kill -9 "$pid" ) >/dev/null 2>&1 &
watchdog=$!
wait "$pid" || rc=$?
kill "$watchdog" 2>/dev/null || true
wait "$watchdog" 2>/dev/null || true

if [ "$rc" -eq 0 ] && grep -qx 'CXB-OK function' "$OUT"; then
  echo "dmg child probe: $APP_NAME booted the child script"
  exit 0
fi
case "$rc" in
  0) echo "dmg child probe: no CXB-OK line — $APP_NAME exited 0 without running the child script" ;;
  137) echo "dmg child probe: timed out — $APP_NAME did not exit within 10s (a second Clodex booted?)" ;;
  *) echo "dmg child probe: $APP_NAME exited $rc instead of running the child script" ;;
esac
cat "$OUT" "$ERR"
exit 1
