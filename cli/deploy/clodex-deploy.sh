#!/usr/bin/env bash
# Clodex headless peer-node deploy / update — idempotent, non-interactive.
#
# Runs on a Linux box over ssh (fed to `bash -s` by ssh-run.js). Installs or
# UPDATES a headless Clodex as a systemd --user service answering the peer
# protocol on 127.0.0.1:<PORT>. Safe to re-run: every step checks before it
# acts, so a re-run IS the update path (Batch B's "Update Clodex on <box>" is
# literally this script again).
#
# Progress is machine-readable on stdout (parsed by peer-deploy.js):
#   ::step <name>            a step is starting
#   ::ok <name>              step done (or already satisfied)
#   ::fail <name> <reason>   step failed — script exits 1
#   ::need-sudo <what>       a sudo step can't run non-interactively;
#   ::sudo-cmd <command>       ...exact commands follow, then exit 42
#   ::done                   finished
# Human-readable detail goes to stderr, so stdout stays a clean marker stream.
#
# NEVER prompts, NEVER hangs: if it needs root and can't sudo without a
# password, it emits ::need-sudo + the exact commands and exits 42 (distinct
# from a real failure's 1) — that exit is where the wizard offers the agent
# fallback. Params via env: REPO_URL, BRANCH, PORT, CLODEX_SRC.

set -uo pipefail

REPO_URL="${REPO_URL:-https://github.com/avirtual/clodex}"
BRANCH="${BRANCH:-master}"
PORT="${PORT:-7900}"
SRC_DIR="${CLODEX_SRC:-$HOME/wb-wrap-ui}"
CONFIG_DIR="$HOME/.config/clodex"
SETTINGS="$CONFIG_DIR/ui-settings.json"
UNIT_DIR="$HOME/.config/systemd/user"

# OS awareness: macOS is a supported deploy target for source install/update, but
# we do NOT set up auto-start there — the Linux-only steps (sys-deps toolchain and
# the systemd --user service + linger) are skipped with a note,
# and on a mac starting the app is manual (or, on the update path, the already-
# running app is restarted via POST /api/restart after the script succeeds).
OS="$(uname -s)"
IS_MAC=0
[ "$OS" = "Darwin" ] && IS_MAC=1

# Over `ssh host 'bash -s'` there's usually no login session, so `systemctl
# --user` can't find its bus without this — the exact pitfall peering/README.md
# warns about. Set it early so daemon-reload/enable/restart work on first run.
# Linux-only: it's a systemd-bus concern and there's no systemd on Darwin.
[ "$IS_MAC" = "1" ] || export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
# set -u + a non-login ssh that doesn't export USER would otherwise kill the
# script at the linger check (which needs the username).
USER="${USER:-$(id -un)}"

NEED_SUDO_EXIT=42

# stdout = markers only; stderr = human detail.
step() { echo "::step $1"; }
ok()   { echo "::ok $1"; }
log()  { echo "$*" >&2; }
fail() { echo "::fail $1 ${2:-}"; exit 1; }
need_sudo() {                     # $1 = what; remaining args = exact commands
  local what="$1"; shift
  echo "::need-sudo $what"
  local c
  for c in "$@"; do echo "::sudo-cmd $c"; done
  exit "$NEED_SUDO_EXIT"
}

# sudo policy: root needs nothing; a passwordless sudo is fine; otherwise the
# caller must emit ::need-sudo (we never prompt). SUDO is the prefix to use.
SUDO=""
can_sudo() {
  if [ "$(id -u)" = "0" ]; then SUDO=""; return 0; fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then SUDO="sudo -n"; return 0; fi
  return 1
}

# --- preflight: the tools the rest of the script assumes -------------------
step preflight
command -v git  >/dev/null 2>&1 || fail preflight "git-not-found"
command -v curl >/dev/null 2>&1 || fail preflight "curl-not-found"
command -v node >/dev/null 2>&1 || fail preflight "node-not-found"
command -v npm  >/dev/null 2>&1 || fail preflight "npm-not-found"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 20 ] 2>/dev/null || fail preflight "node-$(node -v 2>/dev/null)-too-old-need-20+"
# systemctl gates the Linux service step only; a mac never installs a unit.
[ "$IS_MAC" = "1" ] || command -v systemctl >/dev/null 2>&1 || fail preflight "systemctl-not-found"
ok preflight

# --- sys-deps: the node-pty build toolchain (headless engine, no Electron) --
# The remote node runs the HEADLESS engine (node headless-main.js): no Electron,
# no Xvfb, no GUI libs. The ONLY native piece is node-pty, so the system deps are
# just its build toolchain (a C++ compiler + make + python3 for node-gyp). Family
# aware: apt on Debian/Ubuntu, dnf/yum on RHEL/AL2023 — the old apt-only logic ran
# `dpkg -s` on rpm boxes and flagged everything missing → a bogus apt need-sudo.
# Only touches the package manager if something's actually missing (idempotent).
step sys-deps
if [ "$IS_MAC" = "1" ]; then
  log "macOS: skipping system packages (node-pty builds against the Xcode CLT here)"
  ok sys-deps
elif command -v apt-get >/dev/null 2>&1; then
  # Debian/Ubuntu: build-essential (gcc/g++/make) + python3 for node-gyp. Neither
  # is a t64 package, so the noble virtual-provider dance the Electron libs needed
  # is gone. dpkg -s present-check keeps a satisfied box off the need-sudo path.
  missing=""
  for p in build-essential python3; do
    dpkg -s "$p" >/dev/null 2>&1 || missing="$missing $p"
  done
  if [ -n "$missing" ]; then
    log "missing:$missing"
    if can_sudo; then
      $SUDO apt-get update -qq || fail sys-deps "apt-update-failed"
      $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $missing \
        || fail sys-deps "apt-install-failed"
    else
      need_sudo "install the node-pty build toolchain" \
        "sudo apt-get update" \
        "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y$missing"
    fi
  fi
  ok sys-deps
elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
  # RHEL/Fedora/Amazon Linux: gcc-c++ + make + python3 for node-gyp. rpm -q is the
  # present-check (dpkg doesn't exist here); PM is dnf when available, else yum.
  PM="yum"; command -v dnf >/dev/null 2>&1 && PM="dnf"
  missing=""
  for p in gcc-c++ make python3; do
    rpm -q "$p" >/dev/null 2>&1 || missing="$missing $p"
  done
  if [ -n "$missing" ]; then
    log "missing:$missing"
    if can_sudo; then
      $SUDO $PM install -y $missing || fail sys-deps "$PM-install-failed"
    else
      need_sudo "install the node-pty build toolchain" \
        "sudo $PM install -y$missing"
    fi
  fi
  ok sys-deps
else
  # No known package manager — assume the toolchain is present (the npm rebuild
  # step fails distinguishably if it isn't) rather than blocking the deploy.
  log "no apt/dnf/yum found — assuming the node-pty build toolchain is present"
  ok sys-deps
fi

# --- source: clone or fast-forward to origin/<BRANCH> ----------------------
step source
if [ -d "$SRC_DIR/.git" ]; then
  git -C "$SRC_DIR" fetch --quiet origin "$BRANCH"           || fail source "git-fetch-failed"
  git -C "$SRC_DIR" checkout --quiet "$BRANCH" 2>/dev/null   || git -C "$SRC_DIR" checkout --quiet -b "$BRANCH" "origin/$BRANCH" || fail source "git-checkout-failed"
  git -C "$SRC_DIR" reset --hard --quiet "origin/$BRANCH"    || fail source "git-reset-failed"
else
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$SRC_DIR" || fail source "git-clone-failed"
fi
cd "$SRC_DIR" || fail source "cd-failed"
ok source

# --- npm install: prod deps only, then rebuild node-pty for the Node ABI ----
# The HEADLESS engine needs the runtime deps + node-pty, NOT the Electron devDep
# (or its ~100MB binary / the chrome-sandbox SUID / electron-rebuild). This is
# the proven headless-image recipe: `npm ci --omit=dev --ignore-scripts` installs
# a clean prod-only tree — and because `ci` wipes node_modules first, it also
# CONVERGES an existing Electron-flavor node (old electron + Electron-ABI node-pty
# gone) to the headless shape in one shot. `--ignore-scripts` skips our
# Electron-dev-only postinstall (dev-rename-electron.js / fix-pty-helper.js); the
# node-pty native addon is then built against the NODE ABI by an explicit rebuild.
step npm-install
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error >&2 \
  || fail npm-install "npm-ci-failed"
npm rebuild node-pty >&2 || fail npm-install "node-pty-rebuild-failed"
ok npm-install

# --- ui-settings.json: enable the peer server, MERGE (don't clobber) --------
step settings
mkdir -p "$CONFIG_DIR"
node -e '
const fs = require("fs");
const [p, portStr] = process.argv.slice(1);
const port = parseInt(portStr, 10);
let s = {};
try { s = JSON.parse(fs.readFileSync(p, "utf8")) || {}; } catch {}
s.remoteEnabled = true;
s.remotePort = port;
const tmp = p + ".tmp." + process.pid;
fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
fs.renameSync(tmp, p);
' "$SETTINGS" "$PORT" >&2 || fail settings "ui-settings-merge-failed"
ok settings

# --- systemd --user service + linger ---------------------------------------
# macOS: Bogdan's ruling — "if it is a mac we don't make it start automatically".
# No unit, no linger; a fresh mac deploy ends with a manual first start, and the
# update path just restarts the already-running app via POST /api/restart (fired
# by the wizard after the script succeeds), which needs no service manager.
step service
if [ "$IS_MAC" = "1" ]; then
  log "macOS: auto-start not configured — start Clodex manually (npm start) or use the app"
  ok service
else
mkdir -p "$UNIT_DIR"
# Install/refresh the unit from the repo copy, pinning WorkingDirectory to the
# actual source dir (the repo unit uses %h/wb-wrap-ui; honor a CLODEX_SRC override).
sed "s#^WorkingDirectory=.*#WorkingDirectory=$SRC_DIR#" "$SRC_DIR/peering/clodex.service" > "$UNIT_DIR/clodex.service" \
  || fail service "unit-install-failed"
# enable-linger so the --user service runs without an active login session.
if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
  if can_sudo; then
    $SUDO loginctl enable-linger "$USER" || fail service "enable-linger-failed"
  else
    need_sudo "enable systemd linger (run the service with no active login)" \
      "sudo loginctl enable-linger $USER"
  fi
fi
systemctl --user daemon-reload            || fail service "daemon-reload-failed"
systemctl --user enable clodex.service >&2 || fail service "enable-failed"
# restart (not just `enable --now`): on the UPDATE path an OLD unit is already
# running — for a fresh Xvfb/Electron→headless flip the new ExecStart only takes
# effect on an actual restart, and `start` is a no-op on an already-active unit.
# `restart` starts a stopped unit too, so it covers the first-install case as well.
systemctl --user restart clodex.service >&2 || fail service "restart-failed"
ok service
fi

# --- verify: the box answers the peer protocol we just enabled -------------
# macOS: nothing auto-starts by design, so a fresh deploy legitimately has no app
# answering — never FAIL on silence. Probe briefly (~5s): if it answers (the
# update path, where the OLD app is still running when verify fires — its restart
# comes later from the wizard, and the next hello is the real version check) → ok;
# if silent → still ok, with a note to start it manually. Linux is unchanged
# (30s, fail on silence — the systemd service must have come up).
step verify
if [ "$IS_MAC" = "1" ]; then
  hello=""
  for _ in $(seq 1 5); do
    hello="$(curl -fsS -m 3 "http://127.0.0.1:$PORT/api/peer/hello" 2>/dev/null || true)"
    case "$hello" in *'"app":"clodex"'*) break;; esac
    sleep 1
  done
  case "$hello" in
    *'"app":"clodex"'*) log "Clodex answering on :$PORT" ;;
    *) log "no Clodex answering on :$PORT — start it manually (npm start) or launch the app" ;;
  esac
  ok verify
else
hello=""
for _ in $(seq 1 30); do
  hello="$(curl -fsS -m 3 "http://127.0.0.1:$PORT/api/peer/hello" 2>/dev/null || true)"
  case "$hello" in *'"app":"clodex"'*) break;; esac
  sleep 1
done
case "$hello" in
  *'"app":"clodex"'*) ok verify ;;
  *) fail verify "no-hello-on-127.0.0.1:$PORT-after-30s" ;;
esac
fi

echo "::done"
