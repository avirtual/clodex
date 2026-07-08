#!/usr/bin/env bash
# clodex-seed.sh — headless Clodex session manager (seed / remove + launch).
# Ships in the repo under peering/; copy to the headless box as ~/clodex-seed.sh
# (see peering/README.md).
#
# What it does:
#   add (default) — upserts a session entry into ~/.config/clodex/sessions.json
#                   (the file Clodex reads at launch to restore/spawn sessions;
#                   matches manager.create()'s persisted shape), ensures
#                   remoteEnabled:true, then restarts so the restore path spawns
#                   it. Existing agents --resume with history intact.
#   remove        — drops the entry from sessions.json, restarts (killAll kills
#                   the running agent; restore no longer respawns it), then wipes
#                   its stale ~/.clodex/<name>-* runtime files.
#
# There is NO live reload of sessions.json — Clodex reads it only at launch, so
# both add and remove take effect via a service restart (systemd if installed,
# else tmux). On restart every OTHER session --resumes untouched.
#
# NOTE: don't run agents in $HOME — Claude's trust-dir prompt nags forever there.
# Use a real project dir (e.g. ~/projects/<name>).
#
# Usage:
#   clodex-seed.sh <name> [claude|codex] [cwd]     # add/update a session
#   clodex-seed.sh remove <name>                   # remove a session
#   SKIP_LAUNCH=1 clodex-seed.sh ...               # edit files, don't restart
#
# Examples:
#   clodex-seed.sh worker claude ~/projects/worker
#   clodex-seed.sh bot codex /srv/x
#   clodex-seed.sh remove testagent

set -euo pipefail

CFG="$HOME/.config/clodex"
REPO="$HOME/wb-wrap-ui"
SESSIONS="$CFG/sessions.json"
UISET="$CFG/ui-settings.json"
RUNTIME="$HOME/.clodex"
TMUX_SESS="clodex"

# (Re)start Clodex so a sessions.json change takes effect. Prefer the systemd
# user service (the durable, boot-surviving instance); fall back to tmux only on
# boxes without the service. Shared by add and remove.
restart_clodex() {
  if [[ "${SKIP_LAUNCH:-0}" == "1" ]]; then
    echo "SKIP_LAUNCH=1 — files changed, not restarting. Apply manually to take effect."
    return 0
  fi
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  if systemctl --user cat clodex.service >/dev/null 2>&1; then
    echo "restarting systemd user service 'clodex' (other sessions --resume)..."
    systemctl --user restart clodex.service
    echo "  status : systemctl --user status clodex"
    echo "  logs   : journalctl --user -u clodex -f"
    echo "  peer   : 127.0.0.1:7900 (tunnel from your Mac with ssh -L)"
  else
    if tmux has-session -t "$TMUX_SESS" 2>/dev/null; then
      echo "stopping existing tmux clodex session..."
      tmux kill-session -t "$TMUX_SESS" 2>/dev/null || true
      sleep 2   # let the old app release its single-instance lock + sockets
    fi
    tmux new-session -d -s "$TMUX_SESS" "cd '$REPO' && exec xvfb-run -a npm start"
    echo "launched Clodex headless in tmux session '$TMUX_SESS'"
    echo "  logs / attach : tmux attach -t $TMUX_SESS   (detach: Ctrl-b d)"
    echo "  peer port     : 127.0.0.1:7900 (tunnel from your Mac with ssh -L)"
  fi
}

mkdir -p "$CFG"

# ---- remove mode ------------------------------------------------------------
if [[ "${1:-}" == "remove" || "${1:-}" == "--remove" || "${1:-}" == "-r" ]]; then
  NAME="${2:-}"
  if [[ -z "$NAME" ]]; then echo "usage: $0 remove <name>" >&2; exit 1; fi
  if [[ ! "$NAME" =~ ^[a-zA-Z0-9._-]{1,64}$ ]]; then
    echo "error: bad name" >&2; exit 1
  fi
  node - "$SESSIONS" "$NAME" <<'NODE'
const fs = require('fs');
const [file, name] = process.argv.slice(2);
let all = [];
try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
if (!Array.isArray(all)) all = [];
const before = all.length;
all = all.filter((s) => s.name !== name);
if (all.length === before) { console.log(`no entry named '${name}' — nothing to remove`); }
else { fs.writeFileSync(file, JSON.stringify(all, null, 2)); console.log(`removed entry: ${name}`); }
console.log(`  remaining: ${all.map((s) => s.name).join(', ') || '(none)'}`);
NODE
  # Restart first so the app kills the live agent via its own lifecycle (before-
  # quit → killAll), THEN clear the orphaned runtime files it leaves behind.
  restart_clodex
  echo "clearing stale runtime files for '$NAME'..."
  rm -f "$RUNTIME/$NAME".* "$RUNTIME/$NAME"-* 2>/dev/null || true
  echo "done."
  exit 0
fi

# ---- add mode (default) -----------------------------------------------------
NAME="${1:-}"
TYPE="${2:-claude}"
CWD="${3:-$HOME}"

if [[ -z "$NAME" ]]; then
  echo "usage: $0 <name> [claude|codex] [cwd]   |   $0 remove <name>" >&2
  exit 1
fi
if [[ "$TYPE" != "claude" && "$TYPE" != "codex" ]]; then
  echo "error: type must be 'claude' or 'codex' (got '$TYPE')" >&2
  exit 1
fi
if [[ ! "$NAME" =~ ^[a-zA-Z0-9._-]{1,64}$ ]]; then
  echo "error: name must match [a-zA-Z0-9._-]{1,64}" >&2
  exit 1
fi
if [[ "$CWD" == "$HOME" ]]; then
  echo "warning: cwd is \$HOME — Claude will nag about trusting the folder. Consider ~/projects/$NAME." >&2
fi

# 1. Seed the session entry (create file if missing, upsert by name).
node - "$SESSIONS" "$NAME" "$TYPE" "$CWD" <<'NODE'
const fs = require('fs');
const [file, name, type, cwd] = process.argv.slice(2);
let all = [];
try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
if (!Array.isArray(all)) all = [];
// Mirror of manager.create()'s persistence.upsert() shape (main.js). sessionId
// null = fresh conversation; set to an existing id to resume one.
const entry = {
  name, type, cwd,
  extraArgs: [], sessionId: null, workspaceId: 'default',
  systemPrompt: null, systemPromptFile: null, appendPromptFiles: [],
  proxy: null, agents: [], denyBuiltins: [],
  disabledTools: [], disabledSkills: [], injectSkills: [],
};
const i = all.findIndex((s) => s.name === name);
if (i >= 0) { all[i] = { ...all[i], ...entry }; console.log(`updated existing entry: ${name}`); }
else { all.push(entry); console.log(`added new entry: ${name}`); }
fs.writeFileSync(file, JSON.stringify(all, null, 2));
console.log(`  type=${type} cwd=${cwd} workspace=default`);
NODE

# 2. Ensure the remote/peer server is enabled (binds 127.0.0.1; peer over ssh -L).
node - "$UISET" <<'NODE'
const fs = require('fs');
const [file] = process.argv.slice(2);
let s = {};
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
if (s.remoteEnabled !== true) {
  s.remoteEnabled = true;
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
  console.log(`remoteEnabled -> true (port ${s.remotePort || 7900})`);
} else {
  console.log(`remoteEnabled already true (port ${s.remotePort || 7900})`);
}
NODE

# 3. (Re)start so the restore path spawns the newly-seeded session.
restart_clodex
