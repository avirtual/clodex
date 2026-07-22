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
# fallback. Params via env: REPO_URL, BRANCH, PORT, CLODEX_SRC,
# CLODEX_NO_WIRESCOPE (=1 → skip wirescope python deps + pin CLODEX_WIRESCOPE=off).

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

# Wirescope opt-out (T49): CLODEX_NO_WIRESCOPE=1 rides the deploy preamble when
# `deploy --no-wirescope` is passed (Bedrock nodes: the tee never sees a byte).
# Effects: (a) the wirescope-only python sys-deps (venv/pip) are skipped —
# node-gyp still needs python3 itself; (b) a systemd drop-in pins
# CLODEX_WIRESCOPE=off in the service env, which the engine honors over the
# proxyEnabled pref. Flag absent on a re-run removes the drop-in, so a redeploy
# converges the node to the flag's state.
WIRESCOPE_OFF=0
case "${CLODEX_NO_WIRESCOPE:-}" in 1|true|yes|on) WIRESCOPE_OFF=1;; esac

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
  # Debian/Ubuntu: build-essential (gcc/g++/make) + python3 for node-gyp, plus
  # python3-venv/python3-pip for the wirescope managed venv (Debian's python3
  # can't create venvs without python3-venv; AL-style pipless venvs exist too).
  # Wirescope opted out → the venv/pip packages are dead weight; skip them
  # (best-effort dep trim — python3 itself stays, node-gyp needs it).
  # dpkg -s present-check keeps a satisfied box off the need-sudo path.
  APT_PKGS="build-essential python3 python3-venv python3-pip"
  [ "$WIRESCOPE_OFF" = "1" ] && APT_PKGS="build-essential python3"
  missing=""
  for p in $APT_PKGS; do
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
  # RHEL/Fedora/Amazon Linux: gcc-c++ + make + python3 for node-gyp, plus
  # python3-pip — AL2023's base python3 creates venvs WITHOUT pip (ensurepip is
  # split out), which breaks the wirescope managed venv. rpm -q is the
  # present-check (dpkg doesn't exist here); PM is dnf when available, else yum.
  PM="yum"; command -v dnf >/dev/null 2>&1 && PM="dnf"
  RPM_PKGS="gcc-c++ make python3 python3-pip"
  [ "$WIRESCOPE_OFF" = "1" ] && RPM_PKGS="gcc-c++ make python3"
  missing=""
  for p in $RPM_PKGS; do
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
# Record WHAT got deployed — the ref + short commit sha. A stdout ::log marker
# (not the stderr log() helper) so it rides BOTH the ssh trail and the ssm
# wrapper's ^:: filter; parses grammar-generically to {type:'log'} in both
# parsers (no new marker kind). BRANCH is the already-provided ref; the sha is
# git's own output, no caller data. Makes "box cloned the wrong ref" visible.
DEPLOYED_SHA="$(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "::log deployed $BRANCH@$DEPLOYED_SHA"
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

# --- agent-clis: the claude/codex CLIs a spawn will exec ---------------------
# The engine spawns `claude`/`codex` as child PTYs; without the binaries on PATH
# the child dies on execvp with a bare code-1 (the exact silent-death this step
# prevents). Install them the SETTLED native way — the same one-liners the GUI's
# "Install <tool>…" button runs (tool-doctor.js): curl|sh into ~/.local/bin, no
# npm, no root, self-updating. BEST-EFFORT by design: a node that only runs bash
# sessions is legitimate, so a failed CLI install is logged but NEVER fails the
# deploy and NEVER needs sudo. Idempotent: a present CLI is skipped. macOS is the
# desktop-app story — skip there too (the app manages its own tools).
step agent-clis
if [ "$IS_MAC" = "1" ]; then
  log "macOS: skipping agent-CLI install (desktop app manages its own tools)"
  ok agent-clis
else
  if command -v claude >/dev/null 2>&1; then
    log "claude already present — skipping"
  else
    log "installing claude CLI (native installer → ~/.local/bin)…"
    curl -fsSL https://claude.ai/install.sh | bash >&2 \
      && log "claude installed" \
      || log "claude install failed (best-effort) — a Claude spawn will fail until it is installed"
  fi
  if command -v codex >/dev/null 2>&1; then
    log "codex already present — skipping"
  else
    log "installing codex CLI (native installer → ~/.local/bin)…"
    curl -fsSL https://chatgpt.com/codex/install.sh | sh >&2 \
      && log "codex installed" \
      || log "codex install failed (best-effort) — a Codex spawn will fail until it is installed"
  fi
  # Onboarding pre-seed (T42): a fresh claude shows a first-run wizard (theme/ANSI
  # prompt) before it is usable, which blinds a headless spawn. Seed ~/.claude.json
  # with onboarding-complete state IF ABSENT — never overwrite an existing file
  # (the user's real config or a prior deploy's seed). Keys verified against a live
  # ~/.claude.json. No codex twin: codex has no equivalent single-file
  # onboarding-complete flag (~/.codex/config.toml is per-project trust), so skip it.
  if [ ! -e "$HOME/.claude.json" ]; then
    printf '%s\n' '{"hasCompletedOnboarding": true, "theme": "dark"}' > "$HOME/.claude.json" \
      && log "seeded ~/.claude.json (onboarding-complete)" \
      || log "could not seed ~/.claude.json (best-effort) — first claude spawn may show the onboarding wizard"
  else
    log "~/.claude.json present — leaving it untouched"
  fi
  ok agent-clis
fi

# --- systemd --user service + linger ---------------------------------------
# macOS: Bogdan's ruling — "if it is a mac we don't make it start automatically".
# No unit, no linger; a fresh mac deploy ends with a manual first start, and the
# update path just restarts the already-running app via POST /api/restart (fired
# by the wizard after the script succeeds), which needs no service manager.
step service
if [ "$IS_MAC" = "1" ]; then
  log "macOS: auto-start not configured — start Clodex manually (npm start) or use the app"
  # No systemd on macOS, so there's no unit drop-in to carry a Claude token —
  # the desktop app manages its own auth. Say so rather than silently dropping it.
  [ -n "${CLODEX_CLAUDE_TOKEN:-}" ] && log "macOS: --claude-token-file ignored (no systemd unit; the app manages Claude auth)"
  [ "$WIRESCOPE_OFF" = "1" ] && log "macOS: --no-wirescope noted, but no systemd unit to carry it — export CLODEX_WIRESCOPE=off yourself"
  ok service
else
mkdir -p "$UNIT_DIR"
# Install/refresh the unit from the repo copy, pinning WorkingDirectory to the
# actual source dir (the repo unit uses %h/wb-wrap-ui; honor a CLODEX_SRC override).
sed "s#^WorkingDirectory=.*#WorkingDirectory=$SRC_DIR#" "$SRC_DIR/peering/clodex.service" > "$UNIT_DIR/clodex.service" \
  || fail service "unit-install-failed"
# Web GUI (T42): enable the browser frontend on wire-port+1, bound to loopback so
# it is reachable ONLY over an authenticated tunnel (`clodexctl web <ctx>` /
# port-forward). A drop-in (not the unit body) keeps the shipped unit generic and
# survives a unit refresh. daemon-reload/restart below picks it up.
WEB_PORT=$((PORT + 1))
WEB_DROPIN_DIR="$UNIT_DIR/clodex.service.d"
mkdir -p "$WEB_DROPIN_DIR" || fail service "web-dropin-mkdir-failed"
printf '[Service]\nEnvironment=CLODEX_WEB_PORT=%s\nEnvironment=CLODEX_WEB_HOST=127.0.0.1\n' "$WEB_PORT" > "$WEB_DROPIN_DIR/web.conf" \
  || fail service "web-dropin-write-failed"
echo "::log web port $WEB_PORT"
# Wirescope opt-out (T49): a drop-in pins CLODEX_WIRESCOPE=off in the service
# env — the engine's autoStartWanted() honors it over the proxyEnabled pref.
# Same mechanism as the web/token drop-ins. Symmetric on re-run: flag absent →
# drop-in removed, so a redeploy without --no-wirescope re-enables wirescope.
if [ "$WIRESCOPE_OFF" = "1" ]; then
  printf '[Service]\nEnvironment=CLODEX_WIRESCOPE=off\n' > "$WEB_DROPIN_DIR/wirescope.conf" \
    || fail service "wirescope-dropin-write-failed"
  echo "::log wirescope disabled (CLODEX_WIRESCOPE=off drop-in)"
else
  rm -f "$WEB_DROPIN_DIR/wirescope.conf" 2>/dev/null || true
fi
# Claude auth (ssh flavor): if a token rode the ssh stdin (CLODEX_CLAUDE_TOKEN,
# set by the deploy preamble — never argv, never ps), write it into a unit
# drop-in so the engine spawns `claude` already authenticated. printf is a shell
# builtin (token never in a process arg list); the file is 0600, owned by this
# user; done BEFORE daemon-reload/restart below so the restart picks it up. The
# ssm flavor does NOT use this path — it delivers the token over the wire.
if [ -n "${CLODEX_CLAUDE_TOKEN:-}" ]; then
  DROPIN_DIR="$UNIT_DIR/clodex.service.d"
  ( umask 077; mkdir -p "$DROPIN_DIR" ) || fail service "token-dropin-mkdir-failed"
  ( umask 077; printf '[Service]\nEnvironment=CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$CLODEX_CLAUDE_TOKEN" > "$DROPIN_DIR/claude-token.conf" ) \
    || fail service "token-dropin-write-failed"
  chmod 600 "$DROPIN_DIR/claude-token.conf" 2>/dev/null || true
  unset CLODEX_CLAUDE_TOKEN
  log "claude token drop-in written (unit env)"
fi
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
# This installer is deliberately tokenless (CLODEX_REMOTE_TOKEN rides a systemd
# drop-in it never reads), so on a token-gated node the hello answers 401 — that
# IS the app, alive and auth-gated. Accept the 200-with-identity body OR a 401
# status; the caller's laptop-side verify does the real authenticated check.
probe_hello() {
  # body plus a trailing status marker in one round-trip (no -f: we parse the
  # code ourselves; -f would suppress the 401 path we specifically want to see).
  curl -sS -m 3 -w ' HTTPCODE:%{http_code}' "http://127.0.0.1:$PORT/api/peer/hello" 2>/dev/null || true
}
step verify
if [ "$IS_MAC" = "1" ]; then
  hello=""
  for _ in $(seq 1 5); do
    hello="$(probe_hello)"
    case "$hello" in *'"app":"clodex"'*|*'HTTPCODE:401') break;; esac
    sleep 1
  done
  case "$hello" in
    *'"app":"clodex"'*|*'HTTPCODE:401') log "Clodex answering on :$PORT" ;;
    *) log "no Clodex answering on :$PORT — start it manually (npm start) or launch the app" ;;
  esac
  ok verify
else
hello=""
for _ in $(seq 1 30); do
  hello="$(probe_hello)"
  case "$hello" in *'"app":"clodex"'*|*'HTTPCODE:401') break;; esac
  sleep 1
done
case "$hello" in
  *'"app":"clodex"'*|*'HTTPCODE:401') ok verify ;;
  *) fail verify "no-hello-on-127.0.0.1:$PORT-after-30s" ;;
esac
fi

echo "::done"
