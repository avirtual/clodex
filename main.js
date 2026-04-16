const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const pty = require('node-pty');

const REGISTRY_DIR = '/tmp/wb-wrap';
const MSG_DIR = path.join(REGISTRY_DIR, 'messages');
const MAX_MSG = 65536;
const MSG_SPILL_THRESHOLD = 500;
const MSG_MAX_AGE = 1800;
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
      return JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf-8'));
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

function setupClaudeHook(name) {
  ensureDir(REGISTRY_DIR);
  const linkPath = path.join(REGISTRY_DIR, `${name}.jsonl`);
  const scriptPath = path.join(REGISTRY_DIR, `${name}-hook.sh`);
  const settingsPath = path.join(REGISTRY_DIR, `${name}-hook.json`);
  const outputPath = path.join(REGISTRY_DIR, `${name}-hook-output.json`);
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
  const script = `#!/bin/bash
set -euo pipefail
INPUT="$(cat)"
TPATH="$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('transcript_path',''))" 2>/dev/null || true)"
[ -z "$TPATH" ] && exit 0
TMPLINK="${linkPath}.tmp.$$"
ln -sf "$TPATH" "$TMPLINK"
mv -f "$TMPLINK" "${linkPath}"
cat "${outputPath}"
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });

  // Settings JSON
  const settings = {
    trustedDirectories: [msgDir],
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
OUTPUT="${REGISTRY_DIR}/\${NAME}-hook-output.json"
[ -f "$OUTPUT" ] && cat "$OUTPUT"
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
  for (const suffix of ['-hook.sh', '-hook.json', '-hook-output.json', '.jsonl']) {
    try { fs.unlinkSync(path.join(REGISTRY_DIR, `${name}${suffix}`)); } catch {}
  }
}

function cleanupCodexHook(name, cwd) {
  for (const suffix of ['-hook-output.json', '.jsonl']) {
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
        // Session id = transcript filename without .jsonl extension
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
      bytesRead = fs.readSync(this._fd, buf, 0, buf.length, null);
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
    this.win = null;
  }

  setWindow(win) {
    this.win = win;
  }

  _send(channel, ...args) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, ...args);
    }
  }

  async create(name, type, cwd, extraArgs = [], resumeId = null) {
    if (this.sessions.has(name)) {
      throw new Error(`Session "${name}" already exists`);
    }

    let cmd, args;
    const shell = process.env.SHELL || '/bin/bash';
    const agentType = (type === 'claude') ? 'claude' : (type === 'codex') ? 'codex' : null;

    switch (type) {
      case 'claude': {
        cmd = 'claude';
        args = [...extraArgs];
        // Inject hook settings
        if (!args.includes('--settings')) {
          const settingsPath = setupClaudeHook(name);
          args.push('--settings', settingsPath);
        }
        // Allow reading spilled message files without prompting
        ensureDir(MSG_DIR);
        if (!args.includes(MSG_DIR)) args.push('--add-dir', MSG_DIR);
        // Resume previous conversation if we have a session id
        if (resumeId && !args.includes('--resume') && !args.includes('-r')) {
          args.push('--resume', resumeId);
        }
        break;
      }
      case 'codex': {
        cmd = 'codex';
        args = [...extraArgs];
        setupCodexHook(name, cwd);
        if (!args.includes('codex_hooks')) args.push('--enable', 'codex_hooks');
        if (!args.includes('--no-alt-screen')) args.push('--no-alt-screen');
        ensureDir(MSG_DIR);
        if (!args.includes(MSG_DIR)) args.push('--add-dir', MSG_DIR);
        if (resumeId && !args.includes('--resume') && !args.includes('-r')) {
          args.push('--resume', resumeId);
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
        await transport.stop();
        throw e;
      }
    }

    const session = {
      name, type, cwd, pty: ptyProc, transport, socketPath,
      agentType, lineBuffer: '', watcher: null,
      sessionId: resumeId || null,
    };
    this.sessions.set(name, session);

    // Persist this session so we can resume it on next launch
    if (agentType) {
      persistence.upsert({
        name, type, cwd,
        extraArgs,
        sessionId: resumeId || null,
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
          this._send('session-activity', name, state);
          // Surface a system notification when an agent finishes
          if (state === 'idle' && this.win && !this.win.isFocused()) {
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

    ptyProc.onData((data) => {
      this._send('pty-data', name, data);

      // In agent mode, PTY output is pass-through (intents come from JSONL)
      if (!agentType) {
        this._scanPtyOutput(session, data);
      }
    });

    ptyProc.onExit(({ exitCode }) => {
      this._cleanup(name);
      this._send('session-exit', name, exitCode);
    });

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
    }));
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

  async _handleIntent(senderName, intent) {
    const session = this.sessions.get(senderName);

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
        this._send('ipc-message', {
          type: 'dm', from: senderName, to: intent.target, body: intent.body,
        });
        break;
      }
      case 'broadcast': {
        // Local agent sessions only
        for (const [name, s] of this.sessions) {
          if (name !== senderName && s.agentType) {
            this._deliverMessage(name, senderName, intent.body, 'broadcast');
          }
        }
        // External peers
        const msg = { type: 'broadcast', from: senderName, body: intent.body };
        for (const peer of registry.listPeers()) {
          if (peer.name !== senderName && !this.sessions.has(peer.name)) {
            Transport.send(peer.socket, msg);
          }
        }
        this._send('ipc-message', {
          type: 'broadcast', from: senderName, body: intent.body,
        });
        break;
      }
      case 'who': {
        // Only agent sessions are addressable peers — bash can't process intents
        const localAgents = Array.from(this.sessions.values())
          .filter(s => s.agentType)
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
// App lifecycle
// ---------------------------------------------------------------------------

const manager = new SessionManager();

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  manager.setWindow(win);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--devtools')) {
    win.webContents.openDevTools({ mode: 'bottom' });
  }
  return win;
}

app.whenReady().then(() => {
  PERSIST_FILE = path.join(app.getPath('userData'), 'sessions.json');

  cleanupOldMessages();
  registry.cleanup();

  ipcMain.handle('session:create', async (_e, name, type, cwd, extraArgs) => {
    try {
      return { ok: true, session: await manager.create(name, type, cwd, extraArgs) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('session:list', () => manager.list());
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

  ipcMain.on('session:context-menu', (e, { name, cwd }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const menu = Menu.buildFromTemplate([
      {
        label: 'Switch to Session',
        click: () => e.sender.send('session:context-action', { action: 'switch', name }),
      },
      {
        label: 'Rename…',
        click: () => e.sender.send('session:context-action', { action: 'rename', name }),
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

  // Renderer tells us it's ready — that's when we restore saved sessions
  ipcMain.handle('app:restore-sessions', async () => {
    const saved = persistence.list();
    const restored = [];
    for (const entry of saved) {
      try {
        await manager.create(
          entry.name,
          entry.type,
          entry.cwd,
          entry.extraArgs || [],
          entry.sessionId,
        );
        restored.push({
          name: entry.name,
          type: entry.type,
          cwd: entry.cwd,
          label: entry.label || null,
        });
      } catch (err) {
        console.error(`Failed to restore session ${entry.name}:`, err.message);
        persistence.remove(entry.name);
      }
    }
    return restored;
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  manager.killAll();
  app.quit();
});

app.on('before-quit', () => {
  manager.killAll();
});
