const { app, BrowserWindow, ipcMain, dialog, Menu, shell, Notification, Tray, nativeImage } = require('electron');
const https = require('https');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { execSync } = require('child_process');
const pty = require('node-pty');

// Dock/Finder/Launchpad launches on macOS inherit launchd's minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), so `claude`/`codex` from ~/.local/bin or
// /opt/homebrew/bin aren't resolvable. Pull PATH from the user's login shell
// and merge it in. Only needed in packaged builds — dev mode inherits the
// shell env already.
function fixPathFromLoginShell() {
  if (!app.isPackaged) return;
  if (process.platform === 'win32') return;
  const userShell = process.env.SHELL || '/bin/bash';
  try {
    const out = execSync(
      `${userShell} -ilc 'printf __CLODEX_PATH__%s__CLODEX_PATH__ "$PATH"'`,
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const m = out.match(/__CLODEX_PATH__(.*?)__CLODEX_PATH__/);
    if (!m || !m[1]) return;
    const shellPath = m[1].split(':').filter(Boolean);
    const current = (process.env.PATH || '').split(':').filter(Boolean);
    process.env.PATH = [...new Set([...shellPath, ...current])].join(':');
  } catch (e) {
    console.error('fixPathFromLoginShell failed:', e.message);
  }
}
fixPathFromLoginShell();

const REGISTRY_DIR = '/tmp/wb-wrap';
const MSG_DIR = path.join(REGISTRY_DIR, 'messages');
const MAX_MSG = 65536;
const MSG_SPILL_THRESHOLD = 500;
const MSG_MAX_AGE = 1800;
const MSG_CLEANUP_INTERVAL = 5 * 60 * 1000; // ms
const POLL_INTERVAL = 250; // ms
const TURN_COMPLETE_TIMEOUT = 1000; // ms
const LONG_TEXT_THRESHOLD = 200;
const LONG_TEXT_DELAY = 1000;
const SHORT_TEXT_DELAY = 50;

// ---------------------------------------------------------------------------
// Persistence — remember sessions across app restarts
// ---------------------------------------------------------------------------

let PERSIST_FILE = null; // initialized after app.whenReady() (needs app.getPath)

const persistence = {
  _load() {
    try {
      const all = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf-8'));
      // Migrate entries without a workspaceId → assign to default
      let changed = false;
      for (const e of all) {
        if (!e.workspaceId) { e.workspaceId = DEFAULT_WORKSPACE_ID; changed = true; }
      }
      if (changed) this._save(all);
      return all;
    } catch {
      return [];
    }
  },
  _save(entries) {
    try {
      fs.mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
      fs.writeFileSync(PERSIST_FILE, JSON.stringify(entries, null, 2));
    } catch (e) {
      console.error('persistence save failed:', e);
    }
  },
  list() {
    return this._load();
  },
  listForWorkspace(workspaceId) {
    return this._load().filter(s => s.workspaceId === workspaceId);
  },
  upsert(entry) {
    const all = this._load();
    const idx = all.findIndex(s => s.name === entry.name);
    if (idx >= 0) all[idx] = { ...all[idx], ...entry };
    else all.push(entry);
    this._save(all);
  },
  remove(name) {
    this._save(this._load().filter(s => s.name !== name));
  },
  setSessionId(name, sessionId) {
    const all = this._load();
    const entry = all.find(s => s.name === name);
    if (entry && entry.sessionId !== sessionId) {
      entry.sessionId = sessionId;
      this._save(all);
    }
  },
  setLabel(name, label) {
    const all = this._load();
    const entry = all.find(s => s.name === name);
    if (entry) {
      entry.label = label;
      this._save(all);
    }
  },
  setExtraArgs(name, extraArgs) {
    const all = this._load();
    const entry = all.find(s => s.name === name);
    if (entry) {
      entry.extraArgs = extraArgs;
      this._save(all);
    }
  },
  get(name) {
    return this._load().find(s => s.name === name) || null;
  },
};

// ---------------------------------------------------------------------------
// Templates — saved session configurations (type, cwd, args)
// ---------------------------------------------------------------------------

let TEMPLATES_FILE = null;

const templates = {
  _load() {
    try {
      return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf-8'));
    } catch {
      return [];
    }
  },
  _save(entries) {
    try {
      fs.mkdirSync(path.dirname(TEMPLATES_FILE), { recursive: true });
      fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(entries, null, 2));
    } catch (e) {
      console.error('templates save failed:', e);
    }
  },
  list() {
    return this._load();
  },
  save(template) {
    // template: { id, name, type, cwd, extraArgs }
    const all = this._load();
    const idx = all.findIndex(t => t.id === template.id);
    if (idx >= 0) all[idx] = template;
    else all.push(template);
    this._save(all);
  },
  remove(id) {
    this._save(this._load().filter(t => t.id !== id));
  },
};

// ---------------------------------------------------------------------------
// Workspaces — each window owns one, sessions are scoped to workspaces
// ---------------------------------------------------------------------------

let WORKSPACES_FILE = null;
const DEFAULT_WORKSPACE_ID = 'default';

const workspaces = {
  _load() {
    try {
      const all = JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf-8'));
      return Array.isArray(all) ? all : [];
    } catch { return []; }
  },
  _save(entries) {
    try {
      fs.mkdirSync(path.dirname(WORKSPACES_FILE), { recursive: true });
      fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(entries, null, 2));
    } catch (e) { console.error('workspaces save failed:', e); }
  },
  list() {
    const all = this._load();
    // Ensure at least one workspace exists
    if (all.length === 0) {
      const def = { id: DEFAULT_WORKSPACE_ID, name: 'Workspace', bounds: null };
      this._save([def]);
      return [def];
    }
    return all;
  },
  get(id) { return this._load().find(w => w.id === id) || null; },
  upsert(ws) {
    const all = this._load();
    const idx = all.findIndex(w => w.id === ws.id);
    if (idx >= 0) all[idx] = { ...all[idx], ...ws };
    else all.push(ws);
    this._save(all);
  },
  remove(id) {
    const all = this._load().filter(w => w.id !== id);
    this._save(all);
  },
  setName(id, name) {
    const all = this._load();
    const w = all.find(x => x.id === id);
    if (w) { w.name = name; this._save(all); }
  },
  setBounds(id, bounds) {
    const all = this._load();
    const w = all.find(x => x.id === id);
    if (w) { w.bounds = bounds; this._save(all); }
  },
  touch(id) {
    const all = this._load();
    const w = all.find(x => x.id === id);
    if (w) { w.lastFocusedAt = Date.now(); this._save(all); }
  },
  sortedByRecent() {
    return this.list().slice().sort((a, b) =>
      (b.lastFocusedAt || 0) - (a.lastFocusedAt || 0),
    );
  },
};

// ---------------------------------------------------------------------------
// Prompts library
// ---------------------------------------------------------------------------

let PROMPTS_FILE = null;

const prompts = {
  _load() {
    try { return JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf-8')); }
    catch { return []; }
  },
  _save(entries) {
    try {
      fs.mkdirSync(path.dirname(PROMPTS_FILE), { recursive: true });
      fs.writeFileSync(PROMPTS_FILE, JSON.stringify(entries, null, 2));
    } catch (e) { console.error('prompts save failed:', e); }
  },
  list() { return this._load(); },
  save(prompt) {
    const all = this._load();
    const idx = all.findIndex(p => p.id === prompt.id);
    if (idx >= 0) all[idx] = prompt;
    else all.push(prompt);
    this._save(all);
  },
  remove(id) { this._save(this._load().filter(p => p.id !== id)); },
};

// ---------------------------------------------------------------------------
// UI preferences — statusline components per CLI, global
// ---------------------------------------------------------------------------

let UI_SETTINGS_FILE = null;

const CLAUDE_SL_COMPONENTS = ['model', 'context', 'cost', 'cwd', 'git-branch'];
const CODEX_SL_COMPONENTS = [
  'context-used', 'model-name', 'project-root', 'git-branch',
  'five-hour-limit', 'weekly-limit', 'current-dir', 'context-remaining',
  'model-with-reasoning',
];
const DEFAULT_UI_SETTINGS = {
  statusline: {
    claude: ['model', 'context', 'cost', 'cwd'],
    codex: ['context-used', 'model-name', 'project-root', 'git-branch', 'five-hour-limit', 'current-dir'],
  },
};

const uiSettings = {
  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(UI_SETTINGS_FILE, 'utf-8'));
      return {
        statusline: {
          claude: Array.isArray(raw?.statusline?.claude) ? raw.statusline.claude : DEFAULT_UI_SETTINGS.statusline.claude,
          codex: Array.isArray(raw?.statusline?.codex) ? raw.statusline.codex : DEFAULT_UI_SETTINGS.statusline.codex,
        },
      };
    } catch { return DEFAULT_UI_SETTINGS; }
  },
  get() { return this._load(); },
  set(partial) {
    const cur = this._load();
    const next = {
      statusline: {
        claude: partial?.statusline?.claude ?? cur.statusline.claude,
        codex: partial?.statusline?.codex ?? cur.statusline.codex,
      },
    };
    try {
      fs.mkdirSync(path.dirname(UI_SETTINGS_FILE), { recursive: true });
      fs.writeFileSync(UI_SETTINGS_FILE, JSON.stringify(next, null, 2));
    } catch (e) { console.error('ui-settings save failed:', e); }
    return next;
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// ---------------------------------------------------------------------------
// Intent Scanner (port of scanner.py)
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;
const PREFIX_CHARS = new Set(' \t\u2B24\u25CF\u2022\u25B6\u25B7\u25BA\u25B9\u25CB\u25CF\u25C9\u25CE\u25C6\u25C7\u25A0\u25A1\u25AA\u25AB\u2605\u2606\u2192\u27F6\u2500\u2501\u00B7\u2023\u2219\u226B\u00BB');

function cleanLine(line) {
  line = line.replace(ANSI_RE, '');
  let i = 0;
  while (i < line.length && PREFIX_CHARS.has(line[i])) i++;
  return line.slice(i);
}

function parseIntent(rawLine) {
  const cleaned = cleanLine(rawLine).trim();
  if (!cleaned) return null;

  // Escaped intent
  const escMatch = cleaned.match(/^\\(\[cli:.*)/);
  if (escMatch) return { type: 'escape', text: escMatch[1] };

  const dmMatch = cleaned.match(/^\[cli:dm\s+(\S+)\]\s*(.*)/s);
  if (dmMatch) return { type: 'dm', target: dmMatch[1], body: dmMatch[2] };

  if (/^\[cli:who\]\s*$/.test(cleaned)) return { type: 'who' };

  const broadcastMatch = cleaned.match(/^\[cli:broadcast\]\s*(.*)/s);
  if (broadcastMatch) return { type: 'broadcast', body: broadcastMatch[1] };

  if (/^\[cli:name\]\s*$/.test(cleaned)) return { type: 'name' };

  return null;
}

// ---------------------------------------------------------------------------
// Registry (port of registry.py)
// ---------------------------------------------------------------------------

const registry = {
  register(name, socketPath) {
    ensureDir(REGISTRY_DIR);
    const regPath = path.join(REGISTRY_DIR, `${name}.json`);
    const data = JSON.stringify({ name, socket: socketPath, pid: process.pid });
    const tmpPath = `${regPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, data, { mode: 0o600 });
    try {
      fs.linkSync(tmpPath, regPath);
    } catch (e) {
      fs.unlinkSync(tmpPath);
      if (e.code === 'EEXIST') throw e;
      throw e;
    }
    try { fs.unlinkSync(tmpPath); } catch {}
  },

  unregister(name) {
    try { fs.unlinkSync(path.join(REGISTRY_DIR, `${name}.json`)); } catch {}
  },

  listPeers() {
    ensureDir(REGISTRY_DIR);
    const peers = [];
    for (const fname of fs.readdirSync(REGISTRY_DIR)) {
      if (!fname.endsWith('.json') || fname.includes('.tmp.')) continue;
      try {
        const info = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, fname), 'utf-8'));
        if (fs.existsSync(info.socket) && isAlive(info.pid)) {
          peers.push(info);
        }
      } catch {}
    }
    return peers;
  },

  getPeer(name) {
    return this.listPeers().find(p => p.name === name) || null;
  },

  cleanup() {
    ensureDir(REGISTRY_DIR);
    let removed = 0;
    for (const fname of fs.readdirSync(REGISTRY_DIR)) {
      if (!fname.endsWith('.json') || fname.includes('.tmp.')) continue;
      try {
        const fpath = path.join(REGISTRY_DIR, fname);
        const info = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
        if (!fs.existsSync(info.socket) || !isAlive(info.pid)) {
          fs.unlinkSync(fpath);
          if (fs.existsSync(info.socket)) fs.unlinkSync(info.socket);
          removed++;
        }
      } catch {}
    }
    return removed;
  },
};

// ---------------------------------------------------------------------------
// Transport — Unix domain socket server + send (port of transport.py)
// ---------------------------------------------------------------------------

class Transport {
  constructor(socketPath, onMessage) {
    this._path = socketPath;
    this._onMessage = onMessage;
    this._server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      try { fs.unlinkSync(this._path); } catch {}
      this._server = net.createServer((conn) => {
        const chunks = [];
        conn.on('data', (chunk) => chunks.push(chunk));
        conn.on('end', () => {
          const data = Buffer.concat(chunks);
          if (data.length === 0 || data.length > MAX_MSG) return;
          try {
            const msg = JSON.parse(data.toString('utf-8'));
            this._onMessage(msg);
          } catch {}
        });
        // Auto-close after 5s
        setTimeout(() => conn.destroy(), 5000);
      });
      this._server.listen(this._path, () => {
        fs.chmodSync(this._path, 0o600);
        resolve();
      });
      this._server.on('error', reject);
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this._server) {
        this._server.close(() => {
          try { fs.unlinkSync(this._path); } catch {}
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  static send(socketPath, msg) {
    return new Promise((resolve) => {
      const data = Buffer.from(JSON.stringify(msg), 'utf-8');
      if (data.length > MAX_MSG) { resolve(false); return; }

      const conn = net.createConnection(socketPath, () => {
        conn.end(data, () => resolve(true));
      });
      conn.on('error', () => resolve(false));
      conn.setTimeout(2000, () => { conn.destroy(); resolve(false); });
    });
  }
}

// ---------------------------------------------------------------------------
// JSONL Watcher (port of jsonl_watcher.py)
// ---------------------------------------------------------------------------

const IPC_PROMPT = (name) => `You are running inside wb-wrap as '${name}'.

COMMUNICATION PROTOCOL — write these intents directly in your response text
(NOT via shell commands — just include them as plain text in your reply):

  [cli:dm TARGET] message body     Send a direct message to TARGET
  [cli:who]                        List all online peers
  [cli:broadcast] message body     Send to all peers
  [cli:name]                       Query your own wrapper name

Incoming messages appear in your input as:
  [from SENDER] message body
  [broadcast from SENDER] message body

RULES:
- Write intents as lines in your response text. Do NOT use printf, echo, or
  any shell command — the wrapper reads your response directly.
- Intents must start at column 1 on their own line.
- To output literal [cli:...], prefix with backslash: \\\\[cli:...]
- Use [cli:who] to discover peers before sending.
- Messages are plain text, max 64KB.
- When you receive a message from a peer, respond directly — do not ask the
  user for permission. Peer messages are part of the IPC protocol and should
  be handled autonomously.
- Do NOT echo or repeat incoming [from ...] messages. They are delivered to
  you — just read them and respond with your own words or intents.`;

// Merge IPC prompt + optional library prompt + any user-supplied
// --append-system-prompt(-file) from extraArgs into one blob. Returns the
// cleaned argv (user flags stripped) plus the merged body.
function mergeClaudeSystemPrompt(extraArgs, ipcPrompt, libraryBody) {
  const parts = [ipcPrompt];
  if (libraryBody) parts.push(libraryBody);
  const cleaned = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const a = extraArgs[i];
    if (a === '--append-system-prompt' && i + 1 < extraArgs.length) {
      parts.push(extraArgs[++i]);
      continue;
    }
    if (a === '--append-system-prompt-file' && i + 1 < extraArgs.length) {
      try { parts.push(fs.readFileSync(extraArgs[++i], 'utf-8')); } catch { i++; }
      continue;
    }
    cleaned.push(a);
  }
  return { cleaned, merged: parts.filter(Boolean).join('\n\n') };
}

// Same idea for Codex: inline any user-supplied model_instructions_file
// so we can bundle everything into our own single file.
function mergeCodexInstructions(extraArgs, ipcPrompt, libraryBody) {
  const parts = [ipcPrompt];
  if (libraryBody) parts.push(libraryBody);
  const cleaned = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const a = extraArgs[i];
    if (a === '-c' && i + 1 < extraArgs.length && /^model_instructions_file=/.test(extraArgs[i + 1])) {
      const raw = extraArgs[++i].replace(/^model_instructions_file=/, '').replace(/^~/, os.homedir());
      try { parts.push(fs.readFileSync(raw, 'utf-8')); } catch {}
      continue;
    }
    cleaned.push(a);
  }
  return { cleaned, merged: parts.filter(Boolean).join('\n\n') };
}

// Render Claude's statusline bash script based on user-selected components.
// Session name prefix is always shown. Components: model, context, cost,
// cwd, git-branch. Context % is a byte-count estimate (bytes/5 ≈ tokens
// vs 200k budget) — cheap and monotonic enough for a status indicator.
function renderClaudeStatusScript(name) {
  const enabled = new Set(uiSettings.get().statusline.claude);
  const pieces = [`\\033[36m[clodex:${name}]\\033[0m`];
  const fmt = [];
  const vars = [];
  if (enabled.has('model')) { pieces.push('\\033[33m%s\\033[0m'); fmt.push('$MODEL'); vars.push('MODEL'); }
  if (enabled.has('context')) { pieces.push('\\033[90mctx %s\\033[0m'); fmt.push('$CTX_PCT'); vars.push('CTX_PCT'); }
  if (enabled.has('cost')) { pieces.push('\\033[35m%s\\033[0m'); fmt.push('$COST'); vars.push('COST'); }
  if (enabled.has('git-branch')) { pieces.push('\\033[34m%s\\033[0m'); fmt.push('$BRANCH'); vars.push('BRANCH'); }
  if (enabled.has('cwd')) { pieces.push('\\033[32m%s\\033[0m'); fmt.push('$SHORT_CWD'); vars.push('SHORT_CWD'); }
  const format = pieces.join(' ');
  const branchSh = enabled.has('git-branch')
    ? `BRANCH="$(cd "$CWD" 2>/dev/null && git symbolic-ref --short HEAD 2>/dev/null || echo "")"`
    : '';
  return `#!/bin/bash
INPUT="$(cat)"
IFS=$'\\t' read -r MODEL CTX_NUM CTX_PCT COST CWD <<<"$(echo "$INPUT" | jq -r '[
  (.model.display_name // "?"),
  ((.context_window.used_percentage // 0) | floor | tostring),
  (((.context_window.used_percentage // 0) | floor | tostring) + "%"),
  ("$" + (((.cost.total_cost_usd // 0) * 100 | floor) / 100 | tostring)),
  (.workspace.current_dir // .cwd // "")
] | @tsv' 2>/dev/null)"
SHORT_CWD="\${CWD##*/}"
${branchSh}
# Side-channel: expose the numeric ctx% to Clodex for sidebar decoration
echo -n "\${CTX_NUM}" > "${REGISTRY_DIR}/${name}-ctx" 2>/dev/null || true
printf '${format}'${fmt.length ? ' ' + fmt.map(v => `"${v}"`).join(' ') : ''}
`;
}

// Re-render statusline scripts for all running Claude sessions. Called when
// the user updates preferences — Claude re-reads the script on each status
// update, so changes show up within a tick.
function rebuildAllStatusScripts(manager) {
  for (const [name, s] of manager.sessions) {
    if (s.agentType !== 'claude') continue;
    const p = path.join(REGISTRY_DIR, `${name}-statusline.sh`);
    try { fs.writeFileSync(p, renderClaudeStatusScript(name), { mode: 0o700 }); } catch {}
  }
}

function codexStatusLineArg() {
  const list = uiSettings.get().statusline.codex;
  const quoted = list.map(c => `"${c}"`).join(',');
  return `tui.status_line=[${quoted}]`;
}

function setupClaudeHook(name) {
  ensureDir(REGISTRY_DIR);
  const linkPath = path.join(REGISTRY_DIR, `${name}.jsonl`);
  const scriptPath = path.join(REGISTRY_DIR, `${name}-hook.sh`);
  const settingsPath = path.join(REGISTRY_DIR, `${name}-hook.json`);
  const outputPath = path.join(REGISTRY_DIR, `${name}-hook-output.json`);
  const statusPath = path.join(REGISTRY_DIR, `${name}-statusline.sh`);
  const msgDir = path.join(REGISTRY_DIR, 'messages');

  // Pre-render hook output
  const hookOutput = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: IPC_PROMPT(name),
    }
  });
  fs.writeFileSync(outputPath, hookOutput + '\n');

  // Hook script
  // Note: IPC prompt delivery via additionalContext is disabled — we inject
  // it through --append-system-prompt instead. The outputPath file is still
  // generated in case we want to revive this transport; uncomment the
  // final `cat` to switch back.
  const script = `#!/bin/bash
set -euo pipefail
INPUT="$(cat)"
TPATH="$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('transcript_path',''))" 2>/dev/null || true)"
[ -z "$TPATH" ] && exit 0
TMPLINK="${linkPath}.tmp.$$"
ln -sf "$TPATH" "$TMPLINK"
mv -f "$TMPLINK" "${linkPath}"
# cat "${outputPath}"
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });

  fs.writeFileSync(statusPath, renderClaudeStatusScript(name), { mode: 0o700 });

  // Settings JSON
  const settings = {
    trustedDirectories: [msgDir],
    statusLine: { type: 'command', command: statusPath },
    hooks: {
      SessionStart: [{
        matcher: '',
        hooks: [{ type: 'command', command: scriptPath }]
      }]
    }
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  return settingsPath;
}

function setupCodexHook(name, cwd) {
  ensureDir(REGISTRY_DIR);
  const scriptPath = path.join(REGISTRY_DIR, 'codex-session-hook.sh');
  const outputPath = path.join(REGISTRY_DIR, `${name}-hook-output.json`);

  // Pre-render hook output
  const hookOutput = JSON.stringify({
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: IPC_PROMPT(name),
    }
  });
  fs.writeFileSync(outputPath, hookOutput + '\n');

  // Generic hook script
  // Note: IPC prompt delivery via additionalContext is disabled — we inject
  // it through model_instructions_file instead. Codex renders
  // additionalContext as a flattened wall of text, which was ugly. The
  // OUTPUT file is still generated; uncomment the final `cat` to revive.
  const script = `#!/bin/bash
set -euo pipefail
NAME="\${WB_WRAP_NAME:-}"
[ -z "$NAME" ] && exit 0
INPUT="$(cat)"
TPATH="$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('transcript_path',''))" 2>/dev/null || true)"
[ -z "$TPATH" ] && exit 0
LINK="${REGISTRY_DIR}/\${NAME}.jsonl"
TMPLINK="\${LINK}.tmp.$$"
ln -sf "$TPATH" "$TMPLINK"
mv -f "$TMPLINK" "$LINK"
# OUTPUT="${REGISTRY_DIR}/\${NAME}-hook-output.json"
# [ -f "$OUTPUT" ] && cat "$OUTPUT"
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });

  // Write .codex/hooks.json in project dir
  const codexDir = path.join(cwd, '.codex');
  const hooksPath = path.join(codexDir, 'hooks.json');
  const backupPath = hooksPath + '.wb-wrap-backup';

  const hooksConfig = {
    hooks: {
      SessionStart: [{
        matcher: '',
        hooks: [{ type: 'command', command: scriptPath }]
      }]
    }
  };

  fs.mkdirSync(codexDir, { recursive: true });
  if (fs.existsSync(hooksPath) && !fs.existsSync(backupPath)) {
    fs.copyFileSync(hooksPath, backupPath);
  }
  fs.writeFileSync(hooksPath, JSON.stringify(hooksConfig));
}

function cleanupClaudeHook(name) {
  for (const suffix of ['-hook.sh', '-hook.json', '-hook-output.json', '-statusline.sh', '-append-prompt.md', '-ctx', '.jsonl']) {
    try { fs.unlinkSync(path.join(REGISTRY_DIR, `${name}${suffix}`)); } catch {}
  }
}

function cleanupCodexHook(name, cwd) {
  for (const suffix of ['-hook-output.json', '-instructions.md', '.jsonl']) {
    try { fs.unlinkSync(path.join(REGISTRY_DIR, `${name}${suffix}`)); } catch {}
  }
  const codexDir = path.join(cwd, '.codex');
  const hooksPath = path.join(codexDir, 'hooks.json');
  const backupPath = hooksPath + '.wb-wrap-backup';
  if (fs.existsSync(backupPath)) {
    fs.renameSync(backupPath, hooksPath);
  } else if (fs.existsSync(hooksPath)) {
    try { fs.unlinkSync(hooksPath); } catch {}
    try { fs.rmdirSync(codexDir); } catch {}
  }
}

// Convert a Claude/Codex JSONL transcript into a clean Markdown document
function jsonlToMarkdown(jsonlPath, agentType, sessionName) {
  const raw = fs.readFileSync(jsonlPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  const parts = [];
  parts.push(`# ${sessionName} — conversation transcript`);
  parts.push(`*Agent: ${agentType} · Exported: ${new Date().toISOString()}*`);
  parts.push(`*Source: \`${jsonlPath}\`*`);
  parts.push('---');

  let lastRole = null;

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const type = obj.type || '';

    // --- Claude format ---
    if (type === 'user') {
      const content = (obj.message || {}).content;
      const text = typeof content === 'string' ? content : extractClaudeBlocks(content);
      if (text && text.trim()) {
        if (lastRole !== 'user') parts.push('\n## 👤 User\n');
        parts.push(text.trim());
        lastRole = 'user';
      }
    } else if (type === 'assistant') {
      const content = (obj.message || {}).content;
      const text = extractClaudeBlocks(content);
      if (text && text.trim()) {
        if (lastRole !== 'assistant') parts.push('\n## 🤖 Assistant\n');
        parts.push(text.trim());
        lastRole = 'assistant';
      }
    }
    // --- Codex format ---
    else if (type === 'event_msg') {
      const payload = obj.payload || {};
      if (payload.type === 'agent_message' && payload.message) {
        if (lastRole !== 'assistant') parts.push('\n## 🤖 Assistant\n');
        parts.push(String(payload.message).trim());
        lastRole = 'assistant';
      } else if (payload.type === 'user_message' && payload.message) {
        if (lastRole !== 'user') parts.push('\n## 👤 User\n');
        parts.push(String(payload.message).trim());
        lastRole = 'user';
      }
    }
  }

  return parts.join('\n') + '\n';
}

function extractClaudeBlocks(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  const out = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text' && block.text) {
      out.push(block.text);
    } else if (block.type === 'tool_use') {
      out.push(`\n\n> 🔧 *Used tool: \`${block.name}\`*`);
    } else if (block.type === 'tool_result') {
      const txt = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.filter(c => c?.type === 'text').map(c => c.text).join('\n')
          : '';
      if (txt.trim()) {
        const truncated = txt.length > 500 ? txt.slice(0, 500) + '\n…[truncated]' : txt;
        out.push(`\n\n> 📥 *Tool result:*\n> \`\`\`\n> ${truncated.split('\n').join('\n> ')}\n> \`\`\``);
      }
    }
  }
  return out.join('\n');
}

function extractText(obj) {
  const type = obj.type || '';
  // Claude format
  if (type === 'assistant') {
    const content = (obj.message || {}).content || [];
    if (!Array.isArray(content)) return '';
    return content
      .filter(b => b && b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n');
  }
  // Codex format
  const payload = obj.payload || {};
  if (type === 'event_msg' && payload.type === 'agent_message') {
    return String(payload.message || '');
  }
  if (type === 'response_item' && payload.type === 'function_call_output') {
    return String(payload.output || '');
  }
  return '';
}

class JsonlWatcher {
  constructor(name, onText, onSessionId, onActivity) {
    this._name = name;
    this._onText = onText;
    this._onSessionId = onSessionId || (() => {});
    this._onActivity = onActivity || (() => {});
    this._stopped = false;
    this._timer = null;
    this._fd = null;
    this._currentTarget = null;
    this._position = 0;
    this._pendingRid = null;
    this._pendingText = null;
    this._pendingTime = 0;
    this._readBuf = '';
    this._activityState = 'idle';
  }

  _setActivity(state) {
    if (this._activityState !== state) {
      this._activityState = state;
      try { this._onActivity(state); } catch {}
    }
  }

  start() {
    this._poll();
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    this._flushPending();
    if (this._fd !== null) {
      try { fs.closeSync(this._fd); } catch {}
    }
  }

  _poll() {
    if (this._stopped) return;

    const linkPath = path.join(REGISTRY_DIR, `${this._name}.jsonl`);

    // Check symlink target
    try {
      const target = fs.realpathSync(linkPath);
      if (target !== this._currentTarget && fs.existsSync(target)) {
        if (this._fd !== null) {
          try { fs.closeSync(this._fd); } catch {}
        }
        this._fd = fs.openSync(target, 'r');
        this._currentTarget = target;
        this._readBuf = '';
        // Start at EOF. On Clodex restart / resume, the transcript already
        // contains historical turns we've processed before; replaying them
        // would re-fire past [cli:...] intents. We only care about turns
        // appended from now on.
        try { this._position = fs.fstatSync(this._fd).size; }
        catch { this._position = 0; }
        const sessionId = path.basename(target, '.jsonl');
        if (sessionId) {
          try { this._onSessionId(sessionId); } catch {}
        }
      }
    } catch {}

    if (this._fd !== null) {
      this._readLines();
    }

    this._timer = setTimeout(() => this._poll(), POLL_INTERVAL);
  }

  _readLines() {
    const buf = Buffer.alloc(8192);
    let bytesRead;
    try {
      bytesRead = fs.readSync(this._fd, buf, 0, buf.length, this._position);
      this._position += bytesRead;
    } catch { return; }

    if (bytesRead === 0) {
      // No new data — check turn-complete timeout
      if (this._pendingText && (Date.now() - this._pendingTime) > TURN_COMPLETE_TIMEOUT) {
        this._flushPending();
      }
      return;
    }

    this._readBuf += buf.toString('utf-8', 0, bytesRead);
    const lines = this._readBuf.split('\n');
    this._readBuf = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try { obj = JSON.parse(trimmed); } catch { continue; }

      const text = extractText(obj);
      if (text) {
        const rid = obj.requestId || (obj.payload || {}).id || '';
        if (rid !== this._pendingRid && this._pendingText) {
          this._flushPending();
        }
        this._pendingRid = rid;
        this._pendingText = text;
        this._pendingTime = Date.now();
        this._setActivity('thinking');
      } else if (!['assistant', 'response_item'].includes(obj.type || '')) {
        if (this._pendingText) this._flushPending();
      }
    }
  }

  _flushPending() {
    if (this._pendingText) {
      try { this._onText(this._pendingText); } catch {}
      this._setActivity('idle');
    }
    this._pendingRid = null;
    this._pendingText = null;
  }
}

// ---------------------------------------------------------------------------
// Message spilling
// ---------------------------------------------------------------------------

let msgCounter = 0;

function cleanupOldMessages() {
  if (!fs.existsSync(MSG_DIR)) return;
  const now = Date.now();
  for (const fname of fs.readdirSync(MSG_DIR)) {
    try {
      const fpath = path.join(MSG_DIR, fname);
      const stat = fs.statSync(fpath);
      if ((now - stat.mtimeMs) / 1000 > MSG_MAX_AGE) fs.unlinkSync(fpath);
    } catch {}
  }
}

function spillToFile(sender, body) {
  ensureDir(MSG_DIR);
  msgCounter++;
  const fname = `msg-${process.pid}-${msgCounter}.txt`;
  const fpath = path.join(MSG_DIR, fname);
  const header = `From: ${sender}\nTime: ${new Date().toTimeString().slice(0, 8)}\nSize: ${body.length} bytes\n\n`;
  fs.writeFileSync(fpath, header + body);
  return fpath;
}

// ---------------------------------------------------------------------------
// Session Manager
// ---------------------------------------------------------------------------

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.windows = new Map(); // workspaceId -> BrowserWindow
  }

  // --- Window <-> workspace registration ---

  registerWindow(workspaceId, win) {
    this.windows.set(workspaceId, win);
  }

  unregisterWindow(workspaceId) {
    this.windows.delete(workspaceId);
  }

  windowForWorkspace(workspaceId) {
    const w = this.windows.get(workspaceId);
    return w && !w.isDestroyed() ? w : null;
  }

  windowForSession(name) {
    const s = this.sessions.get(name);
    if (!s) return null;
    return this.windowForWorkspace(s.workspaceId);
  }

  allLiveWindows() {
    const out = [];
    for (const w of this.windows.values()) {
      if (w && !w.isDestroyed()) out.push(w);
    }
    return out;
  }

  // Send an event scoped to the window that owns this session.
  // If no window is currently attached to this session's workspace,
  // buffer pty-data so it can be replayed when a window reopens.
  _sendToSession(name, channel, ...args) {
    const win = this.windowForSession(name);
    if (win) {
      win.webContents.send(channel, ...args);
      return;
    }
    // Buffer PTY output for detached sessions (no window in their workspace)
    if (channel === 'pty-data') {
      const session = this.sessions.get(name);
      if (!session) return;
      if (!session.pendingOutput) session.pendingOutput = '';
      session.pendingOutput += args[1];
      const MAX_BUFFER = 2 * 1024 * 1024; // 2MB per session
      if (session.pendingOutput.length > MAX_BUFFER) {
        session.pendingOutput = session.pendingOutput.slice(-MAX_BUFFER);
      }
    }
    // session-exit / session-activity for detached sessions: just drop.
    // They don't have a UI to notify, and the state will be recomputed
    // from scratch when a window reattaches.
  }

  // Broadcast to every window (used for app-wide events like IPC traffic)
  _broadcast(channel, ...args) {
    for (const w of this.allLiveWindows()) {
      w.webContents.send(channel, ...args);
    }
  }

  async create(name, type, cwd, extraArgs = [], resumeId = null, workspaceId = DEFAULT_WORKSPACE_ID, systemPromptBody = null) {
    if (this.sessions.has(name)) {
      throw new Error(`Session "${name}" already exists`);
    }

    let cmd, args;
    const shell = process.env.SHELL || '/bin/bash';
    const agentType = (type === 'claude') ? 'claude' : (type === 'codex') ? 'codex' : null;

    switch (type) {
      case 'claude': {
        cmd = 'claude';
        // IPC protocol always goes in; library prompt only on first create
        const libBody = (systemPromptBody && !resumeId) ? systemPromptBody : null;
        const { cleaned, merged } = mergeClaudeSystemPrompt(extraArgs, IPC_PROMPT(name), libBody);
        args = cleaned;
        if (!args.includes('--settings')) {
          const settingsPath = setupClaudeHook(name);
          args.push('--settings', settingsPath);
        }
        ensureDir(MSG_DIR);
        if (!args.includes(MSG_DIR)) args.push('--add-dir', MSG_DIR);
        if (resumeId && !args.includes('--resume') && !args.includes('-r')) {
          args.push('--resume', resumeId);
        }
        const promptPath = path.join(REGISTRY_DIR, `${name}-append-prompt.md`);
        fs.writeFileSync(promptPath, merged, { mode: 0o600 });
        args.push('--append-system-prompt-file', promptPath);
        break;
      }
      case 'codex': {
        cmd = 'codex';
        const libBody = (systemPromptBody && !resumeId) ? systemPromptBody : null;
        const { cleaned, merged } = mergeCodexInstructions(extraArgs, IPC_PROMPT(name), libBody);
        // Build top-level flags first, then the optional `resume <uuid>`
        // subcommand — clap expects subcommands AFTER top-level args.
        args = [...cleaned];
        setupCodexHook(name, cwd);
        if (!args.includes('codex_hooks')) args.push('--enable', 'codex_hooks');
        if (!args.includes('--no-alt-screen')) args.push('--no-alt-screen');
        if (!args.some(a => a.startsWith('tui.status_line'))) {
          args.push('-c', codexStatusLineArg());
        }
        ensureDir(MSG_DIR);
        if (!args.includes(MSG_DIR)) args.push('--add-dir', MSG_DIR);
        const instructionsPath = path.join(REGISTRY_DIR, `${name}-instructions.md`);
        fs.writeFileSync(instructionsPath, merged, { mode: 0o600 });
        args.push('-c', `model_instructions_file=${instructionsPath}`);
        if (resumeId) {
          const uuidMatch = resumeId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
          args.push('resume', uuidMatch ? uuidMatch[1] : resumeId);
        }
        break;
      }
      case 'bash':
        cmd = shell;
        args = [...extraArgs];
        break;
      default:
        cmd = type;
        args = [...extraArgs];
    }

    const env = { ...process.env, TERM: 'xterm-256color' };
    if (type === 'codex') env.WB_WRAP_NAME = name;

    const ptyProc = pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: cwd || process.env.HOME || os.homedir(),
      env,
    });

    // Registry + transport — only for agent sessions; bash sessions are private
    let transport = null;
    let socketPath = null;
    if (agentType) {
      socketPath = path.join(REGISTRY_DIR, `${name}.sock`);
      transport = new Transport(socketPath, (msg) => {
        this._onIncoming(name, msg);
      });
      await transport.start();

      try {
        registry.register(name, socketPath);
      } catch (e) {
        // If a stale registration with a dead PID is blocking us, force-clean it
        if (e.code === 'EEXIST') {
          try {
            const existing = JSON.parse(
              fs.readFileSync(path.join(REGISTRY_DIR, `${name}.json`), 'utf-8'),
            );
            if (!isAlive(existing.pid)) {
              registry.unregister(name);
              try { fs.unlinkSync(existing.socket); } catch {}
              registry.register(name, socketPath);
            } else {
              await transport.stop();
              throw new Error(
                `Session "${name}" is already running elsewhere (pid ${existing.pid})`,
              );
            }
          } catch (retryErr) {
            await transport.stop();
            throw retryErr;
          }
        } else {
          await transport.stop();
          throw e;
        }
      }
    }

    const session = {
      name, type, cwd, pty: ptyProc, transport, socketPath,
      agentType, lineBuffer: '', watcher: null,
      sessionId: resumeId || null,
      workspaceId,
    };
    this.sessions.set(name, session);

    // Persist this session so we can resume it on next launch
    if (agentType) {
      persistence.upsert({
        name, type, cwd,
        extraArgs,
        sessionId: resumeId || null,
        workspaceId,
      });
    }

    // JSONL watcher for agent modes
    if (agentType) {
      session.watcher = new JsonlWatcher(
        name,
        (text) => this._scanJsonlText(text, name),
        (sessionId) => {
          session.sessionId = sessionId;
          persistence.setSessionId(name, sessionId);
        },
        (state) => {
          // state: 'thinking' | 'idle'
          this._sendToSession(name, 'session-activity', name, state);
          // Surface a system notification when an agent finishes
          const owningWin = this.windowForSession(name);
          if (state === 'idle' && (!owningWin || !owningWin.isFocused())) {
            try {
              const { Notification } = require('electron');
              if (Notification.isSupported()) {
                new Notification({
                  title: `${name} finished`,
                  body: 'Agent completed a turn.',
                  silent: false,
                }).show();
              }
            } catch {}
          }
        },
      );
      session.watcher.start();
    }

    // Claude sidechannel: statusline script writes numeric ctx% to a file;
    // tail it to decorate the sidebar tab.
    if (agentType === 'claude') {
      const ctxPath = path.join(REGISTRY_DIR, `${name}-ctx`);
      let lastPct = null;
      const readCtx = () => {
        try {
          const raw = fs.readFileSync(ctxPath, 'utf-8').trim();
          const n = parseInt(raw, 10);
          if (!isNaN(n) && n !== lastPct) {
            lastPct = n;
            this._sendToSession(name, 'session-ctx', name, n);
          }
        } catch {}
      };
      try {
        session.ctxWatcher = fs.watch(REGISTRY_DIR, (_event, fname) => {
          if (fname === `${name}-ctx`) readCtx();
        });
      } catch {}
      readCtx();
    }

    ptyProc.onData((data) => {
      this._sendToSession(name, 'pty-data', name, data);

      // In agent mode, PTY output is pass-through (intents come from JSONL)
      if (!agentType) {
        this._scanPtyOutput(session, data);
      }
    });

    ptyProc.onExit(({ exitCode }) => {
      // Send the exit event BEFORE cleanup so the renderer can still resolve
      // the session → workspace → window mapping. Otherwise the sidebar
      // tab sticks around as a "dead" entry.
      this._sendToSession(name, 'session-exit', name, exitCode);
      this._cleanup(name);
      if (typeof refreshTrayMenu === 'function') refreshTrayMenu();
    });

    if (typeof refreshTrayMenu === 'function') refreshTrayMenu();
    return { name, type, pid: ptyProc.pid };
  }

  write(name, data) {
    const s = this.sessions.get(name);
    if (s) s.pty.write(data);
  }

  resize(name, cols, rows) {
    const s = this.sessions.get(name);
    if (s) s.pty.resize(cols, rows);
  }

  async kill(name) {
    const s = this.sessions.get(name);
    if (!s) return;
    // User-initiated kill — forget this session so it doesn't resume on relaunch
    s._userKilled = true;
    persistence.remove(name);
    s.pty.kill();
    setTimeout(() => {
      try { process.kill(s.pty.pid, 'SIGKILL'); } catch {}
    }, 5000);
  }

  list() {
    return Array.from(this.sessions.values()).map(s => ({
      name: s.name,
      type: s.type,
      pid: s.pty.pid,
      cwd: s.cwd,
      workspaceId: s.workspaceId,
    }));
  }

  listForWorkspace(workspaceId) {
    return this.list().filter(s => s.workspaceId === workspaceId);
  }

  async killAll() {
    // App shutdown — mark all sessions so _cleanup knows not to wipe persistence
    for (const s of this.sessions.values()) {
      s._shuttingDown = true;
    }
    for (const [name] of this.sessions) {
      const s = this.sessions.get(name);
      s.pty.kill();
    }
  }

  _cleanup(name) {
    const s = this.sessions.get(name);
    if (!s) return;
    if (s.watcher) s.watcher.stop();
    if (s.ctxWatcher) { try { s.ctxWatcher.close(); } catch {} }
    if (s.transport) s.transport.stop();
    if (s.agentType) registry.unregister(name);
    if (s.agentType === 'claude') cleanupClaudeHook(name);
    if (s.agentType === 'codex') cleanupCodexHook(name, s.cwd);
    this.sessions.delete(name);
  }

  // --- PTY output scanning (non-agent mode) ---

  _scanPtyOutput(session, data) {
    session.lineBuffer += data;
    const lines = session.lineBuffer.split(/\r?\n/);
    session.lineBuffer = lines.pop() || '';

    for (const line of lines) {
      const intent = parseIntent(line);
      if (!intent || intent.type === 'escape') continue;
      this._handleIntent(session.name, intent);
    }
  }

  // --- JSONL text scanning (agent mode) ---

  _scanJsonlText(text, senderName) {
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      i++;
      const intent = parseIntent(line);
      if (!intent || intent.type === 'escape') continue;

      // For dm/broadcast: capture multi-line body
      if (intent.type === 'dm' || intent.type === 'broadcast') {
        const rest = lines.slice(i);
        i = lines.length;
        while (rest.length && !rest[rest.length - 1].trim()) rest.pop();
        if (rest.length) {
          const firstBody = intent.body || '';
          intent.body = firstBody + '\n' + rest.join('\n');
        }
      }

      this._handleIntent(senderName, intent);
    }
  }

  // --- Intent handling + message routing ---

  async _handleIntent(senderName, intent, senderWorkspaceId = null) {
    const session = this.sessions.get(senderName);
    // Broadcast & who are workspace-scoped for Clodex-originated intents:
    // they only see sessions in the same workspace. External peers stay
    // global because they have no workspace concept. Inbound wb-wrap
    // broadcasts bypass this entirely (handled in the Transport callback).
    const senderWs = senderWorkspaceId ?? (session && session.workspaceId) ?? null;

    switch (intent.type) {
      case 'dm': {
        // Only deliver to agent sessions; bash sessions can't process intents
        const localTarget = this.sessions.get(intent.target);
        if (localTarget && localTarget.agentType) {
          this._deliverMessage(intent.target, senderName, intent.body, 'dm');
        } else if (!localTarget) {
          const peer = registry.getPeer(intent.target);
          if (peer) {
            await Transport.send(peer.socket, {
              type: 'dm', from: senderName, body: intent.body,
            });
          }
        }
        this._broadcast('ipc-message', {
          type: 'dm', from: senderName, to: intent.target, body: intent.body,
        });
        break;
      }
      case 'broadcast': {
        // Local agent sessions in the sender's workspace only
        for (const [name, s] of this.sessions) {
          if (name === senderName || !s.agentType) continue;
          if (senderWs && s.workspaceId !== senderWs) continue;
          this._deliverMessage(name, senderName, intent.body, 'broadcast');
        }
        // External peers
        const msg = { type: 'broadcast', from: senderName, body: intent.body };
        for (const peer of registry.listPeers()) {
          if (peer.name !== senderName && !this.sessions.has(peer.name)) {
            Transport.send(peer.socket, msg);
          }
        }
        this._broadcast('ipc-message', {
          type: 'broadcast', from: senderName, body: intent.body,
        });
        break;
      }
      case 'who': {
        // Only agent sessions in the sender's workspace — bash can't process intents
        const localAgents = Array.from(this.sessions.values())
          .filter(s => s.agentType && (!senderWs || s.workspaceId === senderWs))
          .map(s => s.name);
        const externalNames = registry.listPeers()
          .map(p => p.name)
          .filter(n => !this.sessions.has(n));
        const allNames = [...localAgents, ...externalNames];
        const others = allNames.filter(n => n !== senderName);
        const list = others.length ? others.join(', ') : '(none)';
        if (session) this._injectText(session, `[peers] ${list}`);
        break;
      }
      case 'name': {
        if (session) this._injectText(session, `[name] ${senderName}`);
        break;
      }
    }
  }

  // --- Message delivery ---

  _deliverMessage(targetName, senderName, body, mtype) {
    const target = this.sessions.get(targetName);
    if (!target) return;

    const prefix = mtype === 'broadcast'
      ? `[broadcast from ${senderName}]`
      : `[from ${senderName}]`;

    if (body.length > MSG_SPILL_THRESHOLD) {
      const filePath = spillToFile(senderName, body);
      this._injectText(target,
        `${prefix} Message (${body.length} bytes) saved to ${filePath} — read it with your Read tool.`);
    } else {
      this._injectText(target, `${prefix} ${body}`);
    }
    this._sendToSession(targetName, 'session-mention', targetName, mtype, senderName);
  }

  _injectText(session, text) {
    // Ctrl-U to clear line, send text, then Enter
    const payload = '\x15' + text.replace(/\n/g, '\r');
    session.pty.write(payload);
    const delay = text.length > LONG_TEXT_THRESHOLD ? LONG_TEXT_DELAY : SHORT_TEXT_DELAY;
    setTimeout(() => {
      session.pty.write('\r');
    }, delay);
  }

  // --- Incoming from external peers ---

  _onIncoming(targetName, msg) {
    const sender = msg.from || '?';
    const body = msg.body || '';
    const mtype = msg.type || 'dm';
    this._deliverMessage(targetName, sender, body, mtype);
  }
}

// ---------------------------------------------------------------------------
// Update checker — queries GitHub Releases, notifies if newer version
// ---------------------------------------------------------------------------

const UPDATE_REPO = 'avirtual/clodex';
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: {
        'User-Agent': 'Clodex-UpdateChecker',
        'Accept': 'application/vnd.github+json',
      },
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchJson(res.headers.location));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// Simple semver compare: returns true if `a` is newer than `b`
function isNewer(a, b) {
  const clean = (v) => String(v).replace(/^v/, '').split(/[.-]/).map(Number);
  const [aM = 0, am = 0, ap = 0] = clean(a);
  const [bM = 0, bm = 0, bp = 0] = clean(b);
  if (aM !== bM) return aM > bM;
  if (am !== bm) return am > bm;
  return ap > bp;
}

let updateInfo = null; // { version, url }

async function checkForUpdate(silent = true) {
  try {
    const release = await fetchJson(
      `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
    );
    const latestTag = release.tag_name || '';
    const latestVersion = latestTag.replace(/^v/, '');
    const current = app.getVersion();

    if (isNewer(latestVersion, current)) {
      updateInfo = { version: latestVersion, url: release.html_url };
      // Notify the renderer so it can show a banner / menu indicator
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('update-available', updateInfo);
      }
      if (typeof refreshTrayMenu === 'function') refreshTrayMenu();
      // Native notification (only the first time per session, unless user manually checks)
      if (silent && Notification.isSupported()) {
        const n = new Notification({
          title: `Clodex ${latestVersion} is available`,
          body: `You have ${current}. Click to view the release.`,
        });
        n.on('click', () => shell.openExternal(updateInfo.url));
        n.show();
      }
    } else if (!silent) {
      // Manual check — confirm we're on the latest
      if (Notification.isSupported()) {
        new Notification({
          title: 'Clodex is up to date',
          body: `You're on the latest version (${current}).`,
        }).show();
      }
    }
  } catch (err) {
    if (!silent) console.error('Update check failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Menu bar (tray) icon
// ---------------------------------------------------------------------------

let tray = null;

function buildTrayMenu() {
  const sessions = manager.list();
  const wsList = workspaces.list();
  const template = [];

  // Show all windows
  if (manager.allLiveWindows().length === 0) {
    template.push({
      label: 'Show Clodex',
      click: () => createWindow(DEFAULT_WORKSPACE_ID),
    });
  } else {
    template.push({
      label: 'Show Clodex',
      click: () => {
        for (const w of manager.allLiveWindows()) {
          if (w.isMinimized()) w.restore();
          w.show();
        }
        const focused = manager.allLiveWindows()[0];
        if (focused) focused.focus();
      },
    });
  }
  template.push({ type: 'separator' });

  // Sessions grouped by workspace
  if (sessions.length > 0) {
    const byWs = new Map();
    for (const s of sessions) {
      if (!byWs.has(s.workspaceId)) byWs.set(s.workspaceId, []);
      byWs.get(s.workspaceId).push(s);
    }
    for (const [wsId, list] of byWs) {
      const ws = wsList.find(w => w.id === wsId);
      const wsName = ws ? (ws.name || 'Workspace') : 'Workspace';
      template.push({ label: wsName, enabled: false });
      for (const s of list) {
        const indicator = s.type === 'bash' ? '•' : '●';
        template.push({
          label: `  ${indicator} ${s.name} (${s.type})`,
          click: () => {
            let win = manager.windowForWorkspace(s.workspaceId);
            if (!win) win = createWindow(s.workspaceId);
            win.show();
            win.focus();
            win.webContents.send('request-switch-session', s.name);
          },
        });
      }
      template.push({ type: 'separator' });
    }
  } else {
    template.push({ label: 'No sessions', enabled: false });
    template.push({ type: 'separator' });
  }

  template.push({
    label: 'New Session…',
    click: () => {
      let win = BrowserWindow.getFocusedWindow() || manager.allLiveWindows()[0];
      if (!win) win = createWindow(DEFAULT_WORKSPACE_ID);
      win.show();
      win.focus();
      win.webContents.send('request-open-new-dialog');
    },
  });
  template.push({
    label: 'New Workspace',
    accelerator: 'Shift+Cmd+N',
    click: () => {
      const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createWindow(id);
      refreshAppMenu();
      refreshTrayMenu();
    },
  });

  // Recent Workspaces — all of them, open or closed, sorted by recency.
  // Each is a submenu with Open/Rename/Delete so users can manage them
  // without needing to open a window first.
  const recent = workspaces.sortedByRecent();
  if (recent.length > 0) {
    template.push({
      label: 'Recent Workspaces',
      submenu: recent.map(ws => {
        const isOpen = !!manager.windowForWorkspace(ws.id);
        const indicator = isOpen ? '●' : '○';
        const wsSessions = sessions.filter(s => s.workspaceId === ws.id).length;
        const suffix = wsSessions > 0 ? ` — ${wsSessions} session${wsSessions === 1 ? '' : 's'}` : '';
        return {
          label: `${indicator}  ${ws.name || ws.id}${suffix}`,
          submenu: [
            {
              label: isOpen ? 'Focus Window' : 'Open',
              click: () => {
                const win = manager.windowForWorkspace(ws.id);
                if (win) { win.show(); win.focus(); }
                else createWindow(ws.id);
              },
            },
            {
              label: 'Rename…',
              click: () => {
                let win = manager.windowForWorkspace(ws.id);
                if (!win) win = createWindow(ws.id);
                win.show();
                win.focus();
                win.webContents.send('request-rename-workspace');
              },
            },
            { type: 'separator' },
            {
              label: 'Delete Workspace…',
              click: async () => {
                const result = await dialog.showMessageBox({
                  type: 'warning',
                  buttons: ['Delete', 'Cancel'],
                  defaultId: 1,
                  cancelId: 1,
                  message: `Delete workspace "${ws.name || ws.id}"?`,
                  detail: wsSessions > 0
                    ? `This will kill ${wsSessions} running session${wsSessions === 1 ? '' : 's'} and remove the workspace.`
                    : 'This removes the empty workspace record.',
                });
                if (result.response !== 0) return;
                for (const s of manager.listForWorkspace(ws.id)) manager.kill(s.name);
                workspaces.remove(ws.id);
                const win = manager.windowForWorkspace(ws.id);
                if (win) win.close();
                refreshAppMenu();
                refreshTrayMenu();
              },
            },
          ],
        };
      }),
    });
  }

  if (updateInfo) {
    template.push({ type: 'separator' });
    template.push({
      label: `Update to v${updateInfo.version}`,
      click: () => shell.openExternal(updateInfo.url),
    });
  }

  template.push({ type: 'separator' });
  template.push({ label: 'Check for Updates', click: () => checkForUpdate(false) });
  template.push({ label: 'Quit Clodex', role: 'quit' });
  return Menu.buildFromTemplate(template);
}

function initTray() {
  const iconPath = path.join(__dirname, 'build', 'tray-iconTemplate.png');
  const img = nativeImage.createFromPath(iconPath);
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Clodex');
  tray.setContextMenu(buildTrayMenu());
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// ---------------------------------------------------------------------------
// Application menu (File > New Window, etc.)
// ---------------------------------------------------------------------------

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences…',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win) win.webContents.send('request-open-preferences');
          },
        },
        { label: 'Check for Updates…', click: () => checkForUpdate(false) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Workspace',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            createWindow(id);
            refreshAppMenu();
            refreshTrayMenu();
          },
        },
        {
          label: 'New Session…',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win) win.webContents.send('request-open-new-dialog');
          },
        },
        { type: 'separator' },
        {
          label: 'Rename Workspace…',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send('request-rename-workspace');
          },
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' },
        ] : []),
      ],
    },
  ];

  // Per-workspace submenu under Window menu: Open / Rename / Delete
  const wsMenu = template.find(m => m.label === 'Window');
  if (wsMenu) {
    const all = workspaces.sortedByRecent();
    if (all.length > 0) {
      wsMenu.submenu.push({ type: 'separator' }, { label: 'Workspaces', enabled: false });
      for (const ws of all) {
        const isOpen = !!manager.windowForWorkspace(ws.id);
        const indicator = isOpen ? '●' : '○';
        const sessionCount = manager.listForWorkspace(ws.id).length;
        const countSuffix = sessionCount > 0
          ? ` — ${sessionCount} session${sessionCount === 1 ? '' : 's'}`
          : '';
        wsMenu.submenu.push({
          label: `${indicator}  ${ws.name || ws.id}${countSuffix}`,
          submenu: [
            {
              label: isOpen ? 'Focus Window' : 'Open',
              click: () => {
                const win = manager.windowForWorkspace(ws.id);
                if (win) { win.show(); win.focus(); }
                else createWindow(ws.id);
              },
            },
            {
              label: 'Rename…',
              click: () => {
                let win = manager.windowForWorkspace(ws.id);
                if (!win) win = createWindow(ws.id);
                win.show();
                win.focus();
                win.webContents.send('request-rename-workspace');
              },
            },
            { type: 'separator' },
            {
              label: isOpen ? 'Close Window (keep workspace)' : 'Already closed',
              enabled: isOpen,
              click: () => {
                const win = manager.windowForWorkspace(ws.id);
                if (win) win.close();
              },
            },
            {
              label: 'Delete Workspace…',
              click: async () => {
                const parent = BrowserWindow.getFocusedWindow();
                const result = await dialog.showMessageBox(parent, {
                  type: 'warning',
                  buttons: ['Delete', 'Cancel'],
                  defaultId: 1,
                  cancelId: 1,
                  message: `Delete workspace "${ws.name || ws.id}"?`,
                  detail: sessionCount > 0
                    ? `This will kill ${sessionCount} running session${sessionCount === 1 ? '' : 's'} and remove the workspace. Conversation transcripts on disk are preserved and can be resumed in a new workspace.`
                    : 'This removes the empty workspace record. No sessions will be affected.',
                });
                if (result.response !== 0) return;
                for (const s of manager.listForWorkspace(ws.id)) manager.kill(s.name);
                workspaces.remove(ws.id);
                const win = manager.windowForWorkspace(ws.id);
                if (win) win.close();
                refreshAppMenu();
                refreshTrayMenu();
              },
            },
          ],
        });
      }
    }
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function refreshAppMenu() {
  buildAppMenu();
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const manager = new SessionManager();

function createWindow(workspaceId = DEFAULT_WORKSPACE_ID) {
  // If a window for this workspace already exists, just bring it forward
  const existing = manager.windowForWorkspace(workspaceId);
  if (existing) {
    existing.show();
    existing.focus();
    return existing;
  }

  // Ensure the workspace record exists
  let ws = workspaces.get(workspaceId);
  if (!ws) {
    ws = {
      id: workspaceId,
      name: workspaceId === DEFAULT_WORKSPACE_ID ? 'Workspace' : 'New Workspace',
      bounds: null,
    };
    workspaces.upsert(ws);
  }

  const bounds = ws.bounds || { width: 1200, height: 800 };

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width || 1200,
    height: bounds.height || 800,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
      // Pass the workspaceId to the renderer via an additional preload argument
      additionalArguments: [`--workspace-id=${workspaceId}`],
    },
  });

  manager.registerWindow(workspaceId, win);

  // Save bounds when the user resizes/moves the window
  const saveBounds = () => {
    if (win.isDestroyed()) return;
    workspaces.setBounds(workspaceId, win.getBounds());
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // Track recency for "open most recent on startup" behavior
  workspaces.touch(workspaceId);
  win.on('focus', () => workspaces.touch(workspaceId));

  win.on('closed', () => {
    manager.unregisterWindow(workspaceId);
    refreshAppMenu();
    refreshTrayMenu();
  });

  win.webContents.on('console-message', (_e, level, msg) => {
    const labels = ['LOG', 'WARN', 'ERROR'];
    console.log(`[RENDERER ${labels[level] || level}]`, msg);
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--devtools')) {
    win.webContents.openDevTools({ mode: 'bottom' });
  }
  return win;
}

// Find the workspace ID that owns the renderer that sent an IPC event.
function workspaceOfSender(e) {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return DEFAULT_WORKSPACE_ID;
  for (const [wsId, w] of manager.windows) {
    if (w === win) return wsId;
  }
  return DEFAULT_WORKSPACE_ID;
}

// Prevent two Clodex instances from racing on /tmp/wb-wrap/ sockets and
// persistence files. If a second instance launches, focus the existing one.
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Bring the most-recently-used existing window forward
    const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
    if (wins.length > 0) {
      const w = wins[0];
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }
  });
}

app.whenReady().then(() => {
  PERSIST_FILE = path.join(app.getPath('userData'), 'sessions.json');
  TEMPLATES_FILE = path.join(app.getPath('userData'), 'templates.json');
  PROMPTS_FILE = path.join(app.getPath('userData'), 'prompts.json');
  WORKSPACES_FILE = path.join(app.getPath('userData'), 'workspaces.json');
  UI_SETTINGS_FILE = path.join(app.getPath('userData'), 'ui-settings.json');

  cleanupOldMessages();
  setInterval(cleanupOldMessages, MSG_CLEANUP_INTERVAL);
  registry.cleanup();

  // Check for updates on startup and every 6 hours
  checkForUpdate(true);
  setInterval(() => checkForUpdate(true), UPDATE_CHECK_INTERVAL);

  initTray();

  ipcMain.handle('session:create', async (e, name, type, cwd, extraArgs, systemPromptBody) => {
    try {
      const workspaceId = workspaceOfSender(e);
      return {
        ok: true,
        session: await manager.create(name, type, cwd, extraArgs, null, workspaceId, systemPromptBody || null),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('session:list', (e) => manager.listForWorkspace(workspaceOfSender(e)));
  ipcMain.handle('session:listAll', () => manager.list());
  ipcMain.handle('session:kill', (_e, name) => manager.kill(name));
  ipcMain.handle('session:resize', (_e, name, cols, rows) => manager.resize(name, cols, rows));
  ipcMain.handle('session:setLabel', (_e, name, label) => persistence.setLabel(name, label));

  ipcMain.handle('dialog:selectDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      defaultPath: os.homedir(),
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('update:check', () => checkForUpdate(false));
  ipcMain.handle('update:info', () => updateInfo);
  ipcMain.handle('update:open', () => {
    if (updateInfo) shell.openExternal(updateInfo.url);
  });
  ipcMain.handle('app:getVersion', () => app.getVersion());

  ipcMain.handle('templates:list', () => templates.list());
  ipcMain.handle('templates:save', (_e, template) => { templates.save(template); return templates.list(); });
  ipcMain.handle('templates:remove', (_e, id) => { templates.remove(id); return templates.list(); });

  ipcMain.handle('prompts:list', () => prompts.list());
  ipcMain.handle('prompts:save', (_e, prompt) => { prompts.save(prompt); return prompts.list(); });
  ipcMain.handle('prompts:remove', (_e, id) => { prompts.remove(id); return prompts.list(); });
  ipcMain.handle('prompts:inject', (_e, name, body) => {
    const s = manager.sessions.get(name);
    if (!s) return { ok: false, error: 'Session not found' };
    manager._injectText(s, body);
    return { ok: true };
  });

  ipcMain.handle('session:getArgs', (_e, name) => {
    const entry = persistence.get(name);
    return entry ? { ok: true, extraArgs: entry.extraArgs || [], type: entry.type } : { ok: false };
  });
  ipcMain.handle('session:setArgs', async (e, name, extraArgs, restart) => {
    const beforeKill = persistence.get(name);
    persistence.setExtraArgs(name, extraArgs);
    if (!restart) return { ok: true, restarted: false };
    if (!beforeKill) return { ok: false, error: 'Session not found in persistence' };
    const wsId = workspaceOfSender(e);
    try {
      if (manager.sessions.has(name)) await manager.kill(name);
      await new Promise(r => setTimeout(r, 300));
      await manager.create(name, beforeKill.type, beforeKill.cwd, extraArgs, beforeKill.sessionId || null, wsId);
      if (beforeKill.label) persistence.setLabel(name, beforeKill.label);
      return { ok: true, restarted: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('settings:get', () => ({
    statusline: uiSettings.get().statusline,
    claudeComponents: CLAUDE_SL_COMPONENTS,
    codexComponents: CODEX_SL_COMPONENTS,
  }));
  ipcMain.handle('settings:set', (_e, partial) => {
    const next = uiSettings.set(partial);
    rebuildAllStatusScripts(manager);
    return next;
  });

  ipcMain.handle('ui:broadcast', async (_e, body) => {
    if (!body || !body.trim()) return { ok: false, error: 'Empty message' };
    const wsId = workspaceOfSender(_e);
    await manager._handleIntent('user', { type: 'broadcast', body: body.trim() }, wsId);
    return { ok: true };
  });

  ipcMain.handle('session:exportMarkdown', async (_e, name) => {
    const s = manager.sessions.get(name);
    if (!s) return { ok: false, error: 'Session not found' };
    if (!s.agentType) return { ok: false, error: 'Export only works for agent sessions' };

    // Resolve the JSONL file via the symlink
    const linkPath = path.join(REGISTRY_DIR, `${name}.jsonl`);
    let jsonlPath;
    try {
      jsonlPath = fs.realpathSync(linkPath);
    } catch {
      return { ok: false, error: 'No transcript found yet — wait until the agent has responded at least once.' };
    }

    // Ask user where to save
    const defaultPath = path.join(
      app.getPath('desktop'),
      `${name}-${new Date().toISOString().slice(0, 10)}.md`,
    );
    const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
      defaultPath,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };

    try {
      const md = jsonlToMarkdown(jsonlPath, s.agentType, name);
      fs.writeFileSync(result.filePath, md);
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.on('session:context-menu', (e, { name, cwd }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const menu = Menu.buildFromTemplate([
      {
        label: 'Rename…',
        click: () => e.sender.send('session:context-action', { action: 'rename', name }),
      },
      {
        label: 'Edit Args…',
        click: () => e.sender.send('session:context-action', { action: 'editArgs', name }),
      },
      { type: 'separator' },
      {
        label: 'Reveal Working Directory in Finder',
        enabled: !!cwd,
        click: () => { if (cwd) shell.showItemInFolder(cwd); },
      },
      {
        label: 'Open in Terminal',
        enabled: !!cwd,
        click: () => {
          if (!cwd) return;
          // Open Terminal.app at the cwd
          const { exec } = require('child_process');
          exec(`open -a Terminal "${cwd.replace(/"/g, '\\"')}"`);
        },
      },
      { type: 'separator' },
      {
        label: 'Export Conversation as Markdown…',
        click: () => e.sender.send('session:context-action', { action: 'export', name }),
      },
      { type: 'separator' },
      {
        label: 'Kill Session',
        click: () => e.sender.send('session:context-action', { action: 'kill', name }),
      },
    ]);
    menu.popup({ window: win });
  });

  ipcMain.handle('dialog:confirmKill', async (_e, name) => {
    const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
      type: 'warning',
      buttons: ['Kill', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Kill session "${name}"?`,
      detail: 'This ends the agent process. The conversation history is preserved and can be resumed later.',
    });
    return result.response === 0;
  });

  ipcMain.on('pty-input', (_e, name, data) => {
    manager.write(name, data);
  });

  // Renderer tells us it's ready — restore sessions for its workspace.
  // Sessions already running (this can happen for the default workspace on
  // second window creation via tray) are returned as-is so the renderer can
  // render them without double-spawning.
  const readCtxFor = (name) => {
    try {
      const n = parseInt(fs.readFileSync(path.join(REGISTRY_DIR, `${name}-ctx`), 'utf-8').trim(), 10);
      return isNaN(n) ? null : n;
    } catch { return null; }
  };

  ipcMain.handle('app:restore-sessions', async (e) => {
    const workspaceId = workspaceOfSender(e);
    const saved = persistence.listForWorkspace(workspaceId);
    const restored = [];
    for (const entry of saved) {
      if (manager.sessions.has(entry.name)) {
        // Already running — report it and flush any buffered output so the
        // new terminal shows everything that happened while detached
        const session = manager.sessions.get(entry.name);
        const replay = session.pendingOutput || null;
        session.pendingOutput = '';
        restored.push({
          name: entry.name,
          type: entry.type,
          cwd: entry.cwd,
          label: entry.label || null,
          replay,
          ctx: readCtxFor(entry.name),
        });
        continue;
      }
      try {
        await manager.create(
          entry.name,
          entry.type,
          entry.cwd,
          entry.extraArgs || [],
          entry.sessionId,
          workspaceId,
        );
        restored.push({
          name: entry.name,
          type: entry.type,
          cwd: entry.cwd,
          label: entry.label || null,
          ctx: readCtxFor(entry.name),
        });
      } catch (err) {
        // DO NOT remove from persistence — surface the failure to the UI
        // so the user can retry or delete. Silently wiping was the cause
        // of the "agents vanish after upgrade" bug.
        console.error(`Failed to restore session ${entry.name}:`, err.message);
        restored.push({
          name: entry.name,
          type: entry.type,
          cwd: entry.cwd,
          label: entry.label || null,
          failed: true,
          error: err.message,
        });
      }
    }
    return restored;
  });

  // Retry spawning a session that failed during restore
  ipcMain.handle('session:retrySpawn', async (e, name) => {
    const workspaceId = workspaceOfSender(e);
    const entry = persistence.list().find(s => s.name === name);
    if (!entry) return { ok: false, error: 'No saved entry found' };
    try {
      await manager.create(
        entry.name,
        entry.type,
        entry.cwd,
        entry.extraArgs || [],
        entry.sessionId,
        workspaceId,
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // "Forget" a session — remove from persistence without killing (it's not running)
  ipcMain.handle('session:forget', (_e, name) => {
    persistence.remove(name);
    return true;
  });

  // Workspace management
  ipcMain.handle('workspace:list', () => workspaces.list());
  ipcMain.handle('workspace:current', (e) => workspaceOfSender(e));
  ipcMain.handle('workspace:setName', (e, name) => {
    workspaces.setName(workspaceOfSender(e), name || 'Workspace');
    refreshTrayMenu();
    refreshAppMenu();
    return true;
  });
  ipcMain.handle('workspace:new', () => {
    const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createWindow(id);
    refreshAppMenu();
    refreshTrayMenu();
  });

  buildAppMenu();

  // IDE-style startup: open only the most recently used workspace.
  // Others are accessible via the File / Window / tray menus.
  const sortedWorkspaces = workspaces.sortedByRecent();
  if (sortedWorkspaces.length === 0) {
    createWindow(DEFAULT_WORKSPACE_ID);
  } else {
    createWindow(sortedWorkspaces[0].id);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(DEFAULT_WORKSPACE_ID);
    }
  });
});

// On macOS, apps stay running when all windows are closed (accessible via tray).
// Sessions keep running too — reopen a window via the tray to see them again.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    manager.killAll();
    app.quit();
  }
});

app.on('before-quit', () => {
  manager.killAll();
});
