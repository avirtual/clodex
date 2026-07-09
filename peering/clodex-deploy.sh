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

# Over `ssh host 'bash -s'` there's usually no login session, so `systemctl
# --user` can't find its bus without this — the exact pitfall peering/README.md
# warns about. Set it early so daemon-reload/enable --now work on first run.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
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
command -v systemctl >/dev/null 2>&1 || fail preflight "systemctl-not-found"
ok preflight

# --- apt deps: Electron's GUI libs + Xvfb + build toolchain ----------------
# Only touches apt if something's actually missing (idempotent re-run). Mirror
# of peering/README.md's dependency list — keep the two in sync.
step apt-deps
APT_PKGS="xvfb libnss3 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 build-essential python3"
missing=""
for p in $APT_PKGS; do
  # On Ubuntu 24.04 several of these are PROVIDED by their `t64` renames
  # (time_t transition): apt satisfies `libasound2` via `libasound2t64`, but
  # `dpkg -s libasound2` stays non-zero. Without the alias check every re-run
  # (= the update path) re-detects them as missing → eternal need-sudo on a box
  # without passwordless sudo. The install line keeps the unsuffixed names; apt
  # resolves the provider. Keep this list synced with peering/README.md step 4.
  dpkg -s "$p" >/dev/null 2>&1 || dpkg -s "${p}t64" >/dev/null 2>&1 || missing="$missing $p"
done
if [ -n "$missing" ]; then
  log "installing:$missing"
  if can_sudo; then
    $SUDO apt-get update -qq \
      && $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $missing \
      || fail apt-deps "apt-install-failed"
  else
    need_sudo "install system packages (Electron GUI libs, Xvfb, build tools)" \
      "sudo apt-get update" \
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y$missing"
  fi
fi
ok apt-deps

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

# --- npm install (near-noop when up to date) -------------------------------
step npm-install
npm install --no-audit --no-fund --loglevel=error >&2 || fail npm-install "npm-install-failed"
ok npm-install

# --- electron-rebuild: only when the native addon needs it -----------------
# node-pty must be built against the installed Electron ABI. Rebuild when the
# built artifact is missing or older than the last npm install / electron drop
# (a fresh install or an electron version bump) — not on every run.
step electron-rebuild
PTY_NODE="$SRC_DIR/node_modules/node-pty/build/Release/pty.node"
LOCK="$SRC_DIR/node_modules/.package-lock.json"
ELECTRON_DIR="$SRC_DIR/node_modules/electron"
need_rebuild=0
if [ ! -f "$PTY_NODE" ]; then
  need_rebuild=1
elif [ -f "$LOCK" ] && [ "$LOCK" -nt "$PTY_NODE" ]; then
  need_rebuild=1
elif [ -d "$ELECTRON_DIR" ] && [ "$ELECTRON_DIR" -nt "$PTY_NODE" ]; then
  need_rebuild=1
fi
if [ "$need_rebuild" = "1" ]; then
  log "rebuilding native addons for Electron"
  npx --yes electron-rebuild >&2 || fail electron-rebuild "electron-rebuild-failed"
fi
ok electron-rebuild

# --- chrome-sandbox: the Chromium SUID sandbox needs root:root + mode 4755 --
# Re-checked AFTER any rebuild/install because reinstalling electron resets it;
# node-pty dies with "killed" (or Electron refuses to start) without it.
step sandbox
SANDBOX="$SRC_DIR/node_modules/electron/dist/chrome-sandbox"
if [ -f "$SANDBOX" ]; then
  owner="$(stat -c '%u' "$SANDBOX" 2>/dev/null || echo -1)"
  mode="$(stat -c '%a' "$SANDBOX" 2>/dev/null || echo 0)"
  if [ "$owner" != "0" ] || [ "$mode" != "4755" ]; then
    if can_sudo; then
      $SUDO chown root:root "$SANDBOX" && $SUDO chmod 4755 "$SANDBOX" || fail sandbox "chrome-sandbox-fix-failed"
    else
      need_sudo "fix the Chromium SUID sandbox (root:root, mode 4755)" \
        "sudo chown root:root '$SANDBOX'" \
        "sudo chmod 4755 '$SANDBOX'"
    fi
  fi
else
  log "chrome-sandbox not present (electron layout differs) — skipping"
fi
ok sandbox

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
step service
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
systemctl --user enable --now clodex.service >&2 || fail service "enable-now-failed"
ok service

# --- verify: the box answers the peer protocol we just enabled -------------
step verify
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

echo "::done"
