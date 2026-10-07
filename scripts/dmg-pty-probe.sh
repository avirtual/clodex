#!/usr/bin/env bash
# Usage: scripts/dmg-pty-probe.sh <path/to.dmg>
# Mounts the DMG read-only and spawns /bin/sh through the packaged node-pty under the bundle's Electron.
set -euo pipefail

DMG="${1:-}"
[ -n "$DMG" ] || { echo "usage: $0 <path/to.dmg>"; exit 1; }
[ -f "$DMG" ] || { echo "dmg probe: no such file: $DMG"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/clodex-dmgprobe-XXXXXX")"
MNT="$WORK/mnt"
ERR="$WORK/stderr"
mkdir -p "$MNT"

cleanup() {
  hdiutil detach "$MNT" -force >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

if ! hdiutil attach -nobrowse -readonly -noverify -mountpoint "$MNT" "$DMG" >/dev/null 2>"$ERR"; then
  echo "dmg probe: could not mount $DMG"
  cat "$ERR"
  exit 1
fi

shopt -s nullglob
APPS=("$MNT"/*.app)
shopt -u nullglob
if [ "${#APPS[@]}" -ne 1 ]; then
  echo "dmg probe: expected exactly one .app in $DMG, found ${#APPS[@]}"
  exit 1
fi
APP="${APPS[0]}"
APP_NAME="$(basename "$APP" .app)"

shopt -s nullglob
EXES=("$APP"/Contents/MacOS/*)
shopt -u nullglob
if [ "${#EXES[@]}" -ne 1 ]; then
  echo "dmg probe: load failed — expected exactly one executable in $APP_NAME.app/Contents/MacOS, found ${#EXES[@]}"
  exit 1
fi
EXE="${EXES[0]}"

PROBE_JS="let pty; try { pty = require(process.env.CLODEX_PROBE_APP + '/Contents/Resources/app.asar/node_modules/node-pty'); } catch (e) { console.error(e && e.stack || e); process.exit(3); } try { const p = pty.spawn('/bin/sh', ['-c', 'exit 0'], { cols: 1, rows: 1 }); p.onExit(({ exitCode }) => process.exit(exitCode === 0 ? 0 : 1)); } catch (e) { console.error(e && e.stack || e); process.exit(1); } setTimeout(() => process.exit(2), 20000);"

rc=0
ELECTRON_RUN_AS_NODE=1 CLODEX_PROBE_APP="$APP" "$EXE" -e "$PROBE_JS" >"$ERR" 2>&1 || rc=$?

case "$rc" in
  0) echo "dmg probe: $APP_NAME spawned /bin/sh"; exit 0 ;;
  1) echo "dmg probe: spawn failed — $APP_NAME loaded node-pty but could not spawn /bin/sh (exit $rc)" ;;
  2) echo "dmg probe: timed out — $APP_NAME spawned /bin/sh but it never exited within 20s (exit $rc)" ;;
  *) echo "dmg probe: load failed — $APP_NAME could not load node-pty from app.asar (exit $rc)" ;;
esac
cat "$ERR"
exit 1
