#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FORCE=0
START=0
CHECK=0
QUIET=0
[ "${npm_config_force:-}" = "true" ] && FORCE=1
unset npm_config_force
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --start) START=1 ;;
    --check) CHECK=1 ;;
    --quiet) QUIET=1 ;;
    *) echo "setup: unknown flag $arg (expected --force, --start, --check, --quiet)" >&2; exit 2 ;;
  esac
done

step() { [ "$QUIET" = 1 ] || echo "==> $*"; }
say() { [ "$QUIET" = 1 ] || echo "    $*"; }
warn() { [ "$QUIET" = 1 ] || echo "    WARN: $*"; }
die() { echo "setup: $*" >&2; exit 1; }

step "OS and architecture"
OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" != "Darwin" ]; then
  [ "$CHECK" = 1 ] && exit 0
  die "the Clodex desktop app needs macOS; on $OS use the headless engine, see docs/how-to.md."
fi
say "$OS $ARCH"

step "Xcode Command Line Tools"
command -v xcode-select >/dev/null 2>&1 && xcode-select -p >/dev/null 2>&1 \
  || die "Xcode Command Line Tools are missing — run \`xcode-select --install\`, then rerun setup."

step "Node 22.12+"
command -v node >/dev/null 2>&1 || die "Node is not on PATH — install Node 22.12+ with \`brew install node\` or nvm, then rerun setup."
NODE_VERSION="$(node -v)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MINOR="${NODE_MAJOR#*.}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
NODE_MINOR="${NODE_MINOR%%.*}"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MINOR" =~ ^[0-9]+$ ]] \
  && { [ "$NODE_MAJOR" -gt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 12 ]; }; } \
  || die "Node $NODE_VERSION is too old — install Node 22.12+ with \`brew install node\` or nvm, then rerun setup."
command -v npm >/dev/null 2>&1 || die "npm is not on PATH — reinstall Node 22.12+ with \`brew install node\` or nvm, then rerun setup."
say "node $NODE_VERSION"

step "Agent CLIs"
CLIS=""
for cli in claude codex; do
  if command -v "$cli" >/dev/null 2>&1; then CLIS="$CLIS $cli"; fi
done
command -v claude >/dev/null 2>&1 || warn "\`claude\` is not on PATH — install Claude Code: https://docs.claude.com/en/docs/claude-code"
command -v codex >/dev/null 2>&1 || warn "\`codex\` is not on PATH — install Codex: https://github.com/openai/codex"
[ -n "$CLIS" ] || warn "New Session needs at least one of claude or codex."

electron_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' node_modules/electron/package.json 2>/dev/null | head -1
}

if [ "$CHECK" = 0 ]; then
  step "npm install"
  if [ "$FORCE" = 0 ] && [ -f node_modules/.package-lock.json ] && [ node_modules/.package-lock.json -nt package-lock.json ]; then
    say "up to date (skipped; --force reruns it)"
  else
    npm install || die "npm install failed — fix the error above, then rerun \`npm run setup -- --force\`."
    rm -f node_modules/.clodex-rebuilt-*
  fi

  step "electron-rebuild"
  ELECTRON_VERSION="$(electron_version)"
  [ -n "$ELECTRON_VERSION" ] || die "Electron is not installed under node_modules — rerun \`npm run setup -- --force\`."
  STAMP="node_modules/.clodex-rebuilt-$ELECTRON_VERSION"
  if [ "$FORCE" = 0 ] && [ -f "$STAMP" ]; then
    say "already rebuilt for Electron $ELECTRON_VERSION (skipped; --force reruns it)"
  else
    npx electron-rebuild || die "electron-rebuild failed — fix the error above, then rerun \`npm run setup -- --force\`."
    node build/fix-pty-helper.js
    rm -f node_modules/.clodex-rebuilt-*
    touch "$STAMP"
  fi
fi

step "node-pty spawns a shell under Electron"
[ -x node_modules/.bin/electron ] || die "Electron is not installed — run \`npm run setup\`."
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e "const p=require('node-pty').spawn('/bin/sh',['-c','exit 0'],{cols:1,rows:1}); p.onExit(({exitCode})=>process.exit(exitCode===0?0:1)); setTimeout(()=>process.exit(2),3000)" >/dev/null 2>&1 \
  || die "node-pty cannot spawn a shell under Electron — run \`npm run setup -- --force\` (reinstalls and re-marks spawn-helper executable); if it persists, \`xattr -cr node_modules/node-pty\`."
ELECTRON_VERSION="$(electron_version)"

[ "$QUIET" = 1 ] && exit 0
step "Summary"
say "macOS $ARCH, node $NODE_VERSION, electron ${ELECTRON_VERSION:-unknown}, CLIs:${CLIS:- none}"
if [ "$START" = 1 ]; then
  exec npm start
fi
say "run \`npm start\`"
