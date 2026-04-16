const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const sessions = new Map(); // name -> { terminal, fitAddon, wrapperEl }
let activeSession = null;

// DOM refs
const sessionList = document.getElementById('session-list');
const terminalContainer = document.getElementById('terminal-container');
const emptyState = document.getElementById('empty-state');
const dialogOverlay = document.getElementById('dialog-overlay');
const inputName = document.getElementById('input-name');
const inputType = document.getElementById('input-type');
const inputCwd = document.getElementById('input-cwd');
const inputArgs = document.getElementById('input-args');
const argsHint = document.getElementById('args-hint');

// Default extra CLI args per session type — user can edit or clear
const DEFAULT_ARGS = {
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  bash: '',
};

const ARGS_HINTS = {
  claude: 'Skips per-tool permission prompts. Clear if you want to be asked.',
  codex: 'Skips approval prompts and sandboxing. Clear for safer defaults.',
  bash: '',
};

// Default cwd
const homeDir = require('os').homedir();
inputCwd.value = homeDir;

// ---------------------------------------------------------------------------
// Session UI
// ---------------------------------------------------------------------------

// Shorten a path by replacing $HOME with ~ and showing only the last 2 segments
function shortPath(p) {
  if (!p) return '';
  let s = p;
  if (s.startsWith(homeDir)) s = '~' + s.slice(homeDir.length);
  const parts = s.split('/').filter(Boolean);
  if (parts.length > 2) {
    return (s.startsWith('/') ? '/' : '') + '…/' + parts.slice(-2).join('/');
  }
  return s;
}

function addSessionToSidebar(name, type, cwd, label) {
  const item = document.createElement('div');
  item.className = 'session-item';
  item.dataset.name = name;
  item.dataset.cwd = cwd || '';
  const displayName = label || name;
  const cwdLabel = cwd ? esc(shortPath(cwd)) : '';
  item.innerHTML = `
    <span class="session-dot"></span>
    <div class="session-info">
      <div class="session-name" title="Double-click to rename. Internal name: ${esc(name)}">${esc(displayName)}</div>
      <div class="session-meta">
        <span class="session-type">${esc(type)}</span>
        ${cwdLabel ? `<span class="session-cwd" title="${esc(cwd)}">${cwdLabel}</span>` : ''}
      </div>
    </div>
    <button class="session-close" title="Kill session">&times;</button>
  `;

  item.addEventListener('click', (e) => {
    if (e.target.closest('.session-close')) return;
    if (e.target.closest('.rename-input')) return;
    switchSession(name);
  });

  item.querySelector('.session-close').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (await window.api.confirmKill(name)) {
      window.api.killSession(name);
    }
  });

  // Double-click name to rename (just the display label, not the IPC name)
  const nameEl = item.querySelector('.session-name');
  nameEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(item, nameEl, name);
  });

  // Right-click to show context menu
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.api.showSessionContextMenu(name, cwd || '');
  });

  sessionList.appendChild(item);
}

// Handle context menu actions from main process
window.api.onSessionContextAction(({ action, name }) => {
  switch (action) {
    case 'switch':
      switchSession(name);
      break;
    case 'rename': {
      const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
      if (item) {
        const nameEl = item.querySelector('.session-name');
        if (nameEl) startRename(item, nameEl, name);
      }
      break;
    }
    case 'kill':
      window.api.confirmKill(name).then((ok) => {
        if (ok) window.api.killSession(name);
      });
      break;
  }
});

function startRename(item, nameEl, sessionName) {
  const current = nameEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = current;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const newLabel = input.value.trim();
    const newNameEl = document.createElement('div');
    newNameEl.className = 'session-name';
    newNameEl.title = `Double-click to rename. Internal name: ${sessionName}`;
    if (commit && newLabel && newLabel !== sessionName) {
      newNameEl.textContent = newLabel;
      window.api.setSessionLabel(sessionName, newLabel);
    } else if (commit && (!newLabel || newLabel === sessionName)) {
      // Clear label
      newNameEl.textContent = sessionName;
      window.api.setSessionLabel(sessionName, null);
    } else {
      newNameEl.textContent = current;
    }
    newNameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(item, newNameEl, sessionName);
    });
    input.replaceWith(newNameEl);
  };

  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { finish(true); }
    if (e.key === 'Escape') { finish(false); }
  });
}

function removeSessionFromSidebar(name) {
  const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (el) el.remove();
}

function updateSidebarActive() {
  for (const el of sessionList.querySelectorAll('.session-item')) {
    el.classList.toggle('active', el.dataset.name === activeSession);
  }
}

function updateWindowTitle() {
  const n = sessions.size;
  if (n === 0) {
    document.title = 'Clodex';
  } else if (n === 1) {
    document.title = `Clodex (1 session)`;
  } else {
    document.title = `Clodex (${n} sessions)`;
  }
}

// ---------------------------------------------------------------------------
// Terminal management
// ---------------------------------------------------------------------------

function createTerminal(name) {
  const terminal = new Terminal({
    fontSize: 13,
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
    theme: {
      background: '#1a1a2e',
      foreground: '#eee',
      cursor: '#e94560',
      selectionBackground: '#3a4a6a',
      black: '#1a1a2e',
      red: '#e94560',
      green: '#4ade80',
      yellow: '#fbbf24',
      blue: '#60a5fa',
      magenta: '#c084fc',
      cyan: '#22d3ee',
      white: '#eee',
    },
    cursorBlink: true,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const wrapperEl = document.createElement('div');
  wrapperEl.className = 'terminal-wrapper';
  wrapperEl.dataset.name = name;
  terminalContainer.appendChild(wrapperEl);

  terminal.open(wrapperEl);

  // Send keystrokes to PTY
  terminal.onData((data) => {
    window.api.writeToSession(name, data);
  });

  sessions.set(name, { terminal, fitAddon, wrapperEl });
  updateWindowTitle();
  return { terminal, fitAddon, wrapperEl };
}

function switchSession(name) {
  if (!sessions.has(name)) return;

  activeSession = name;

  // Toggle visibility — use visibility so xterm can still measure
  for (const [n, s] of sessions) {
    s.wrapperEl.classList.toggle('visible', n === name);
  }

  updateSidebarActive();
  emptyState.style.display = 'none';

  // Fit and focus after becoming visible
  const { fitAddon, terminal } = sessions.get(name);
  requestAnimationFrame(() => {
    fitAddon.fit();
    window.api.resizeSession(name, terminal.cols, terminal.rows);
    terminal.focus();
  });
}

function removeSession(name) {
  const s = sessions.get(name);
  if (s) {
    s.terminal.dispose();
    s.wrapperEl.remove();
    sessions.delete(name);
  }
  removeSessionFromSidebar(name);
  updateWindowTitle();

  if (activeSession === name) {
    const remaining = Array.from(sessions.keys());
    if (remaining.length > 0) {
      switchSession(remaining[0]);
    } else {
      activeSession = null;
      emptyState.style.display = '';
    }
  }
}

// ---------------------------------------------------------------------------
// New session dialog
// ---------------------------------------------------------------------------

let sessionCounter = 0;

function applyTypeDefaults() {
  const type = inputType.value;
  inputArgs.value = DEFAULT_ARGS[type] || '';
  argsHint.textContent = ARGS_HINTS[type] || '';
}

function openDialog() {
  sessionCounter++;
  inputName.value = `session-${sessionCounter}`;
  inputType.value = 'claude';
  applyTypeDefaults();
  inputName.style.borderColor = '';
  dialogOverlay.classList.remove('hidden');
  setTimeout(() => inputName.select(), 50);
}

inputType.addEventListener('change', applyTypeDefaults);

function closeDialog() {
  dialogOverlay.classList.add('hidden');
}

// Split a CLI args string into an argv array, respecting quoted segments
function parseArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return out;
}

async function doCreate() {
  const name = inputName.value.trim();
  const type = inputType.value;
  const cwd = inputCwd.value || homeDir;
  const extraArgs = parseArgs(inputArgs.value || '');

  if (!name) return;
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
    inputName.style.borderColor = '#e94560';
    return;
  }

  closeDialog();

  const result = await window.api.createSession(name, type, cwd, extraArgs);
  if (!result.ok) {
    console.error('Failed to create session:', result.error);
    return;
  }

  createTerminal(name);
  addSessionToSidebar(name, type, cwd, null);
  switchSession(name);
}

document.getElementById('btn-new').addEventListener('click', openDialog);
document.getElementById('btn-cancel').addEventListener('click', closeDialog);
document.getElementById('btn-create').addEventListener('click', doCreate);

document.getElementById('btn-browse').addEventListener('click', async () => {
  const dir = await window.api.selectDirectory();
  if (dir) inputCwd.value = dir;
});

inputCwd.addEventListener('click', async () => {
  const dir = await window.api.selectDirectory();
  if (dir) inputCwd.value = dir;
});

// Enter to create (Escape no longer closes — only Cancel button does)
dialogOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doCreate();
});

// ---------------------------------------------------------------------------
// PTY data routing
// ---------------------------------------------------------------------------

window.api.onPtyData((name, data) => {
  const s = sessions.get(name);
  if (s) s.terminal.write(data);
});

window.api.onSessionExit((name) => {
  removeSession(name);
});

window.api.onSessionActivity((name, state) => {
  const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (el) el.dataset.activity = state;
});

// ---------------------------------------------------------------------------
// IPC log panel
// ---------------------------------------------------------------------------

const ipcLog = document.getElementById('ipc-log');
const ipcLogHeader = document.getElementById('ipc-log-header');
const ipcLogBody = document.getElementById('ipc-log-body');
const ipcEmpty = document.getElementById('ipc-empty');
const ipcCount = document.getElementById('ipc-count');
const ipcClearBtn = document.getElementById('ipc-clear');
const ipcToggleBtn = document.getElementById('ipc-toggle');

let ipcMessageCount = 0;
let unreadIpcCount = 0;

function updateIpcCount() {
  ipcCount.textContent = String(unreadIpcCount);
  ipcCount.classList.toggle('zero', unreadIpcCount === 0);
}
updateIpcCount();

function toggleIpcLog() {
  ipcLog.classList.toggle('collapsed');
  const expanded = !ipcLog.classList.contains('collapsed');
  document.getElementById('main').classList.toggle('ipc-expanded', expanded);
  if (expanded) {
    unreadIpcCount = 0;
    updateIpcCount();
    ipcLogBody.scrollTop = ipcLogBody.scrollHeight;
  }
  // Refit the terminal after layout shift
  if (activeSession) {
    const s = sessions.get(activeSession);
    if (s) {
      requestAnimationFrame(() => {
        s.fitAddon.fit();
        window.api.resizeSession(activeSession, s.terminal.cols, s.terminal.rows);
      });
    }
  }
}

function clearIpcLog() {
  ipcLogBody.innerHTML = '';
  ipcLogBody.appendChild(ipcEmpty);
  ipcMessageCount = 0;
  unreadIpcCount = 0;
  updateIpcCount();
}

ipcLogHeader.addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  toggleIpcLog();
});
ipcToggleBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleIpcLog(); });
ipcClearBtn.addEventListener('click', (e) => { e.stopPropagation(); clearIpcLog(); });

function appendIpcEntry(msg) {
  if (ipcMessageCount === 0 && ipcEmpty.parentNode === ipcLogBody) ipcEmpty.remove();
  ipcMessageCount++;

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = document.createElement('div');
  entry.className = 'ipc-entry' + (msg.type === 'broadcast' ? ' ipc-bcast' : '');

  const fromBadge = `<span class="ipc-from">${esc(msg.from)}</span>`;
  const arrow = `<span class="ipc-arrow">→</span>`;
  const targetBadge = msg.type === 'broadcast'
    ? `<span class="ipc-to">all</span>`
    : `<span class="ipc-to">${esc(msg.to)}</span>`;
  const body = `<span class="ipc-body">${esc(msg.body)}</span>`;

  entry.innerHTML = `<span class="ipc-time">${time}</span>${fromBadge}${arrow}${targetBadge}${body}`;
  ipcLogBody.appendChild(entry);

  // Auto-scroll if already near the bottom
  const nearBottom = ipcLogBody.scrollHeight - ipcLogBody.scrollTop - ipcLogBody.clientHeight < 40;
  if (nearBottom) ipcLogBody.scrollTop = ipcLogBody.scrollHeight;

  // Update unread counter if panel is collapsed
  if (ipcLog.classList.contains('collapsed')) {
    unreadIpcCount++;
    updateIpcCount();
  }
}

window.api.onIpcMessage((msg) => {
  appendIpcEntry(msg);
});

// ---------------------------------------------------------------------------
// Resize handling
// ---------------------------------------------------------------------------

const resizeObserver = new ResizeObserver(() => {
  if (!activeSession) return;
  const s = sessions.get(activeSession);
  if (s) {
    s.fitAddon.fit();
    window.api.resizeSession(activeSession, s.terminal.cols, s.terminal.rows);
  }
});

resizeObserver.observe(terminalContainer);

// ---------------------------------------------------------------------------
// Keyboard shortcuts — Cmd+T (new), Cmd+W (close), Cmd+1..9 (switch)
// ---------------------------------------------------------------------------

// Capture at document level (capture phase) so xterm doesn't swallow them
document.addEventListener('keydown', (e) => {
  if (!e.metaKey || e.altKey || e.ctrlKey) return;

  // Cmd+T — new session (open dialog)
  if (e.key === 't') {
    e.preventDefault();
    e.stopPropagation();
    if (dialogOverlay.classList.contains('hidden')) openDialog();
    return;
  }

  // Cmd+W — kill active session (or close dialog if open)
  if (e.key === 'w') {
    e.preventDefault();
    e.stopPropagation();
    if (!dialogOverlay.classList.contains('hidden')) {
      closeDialog();
    } else if (activeSession) {
      const target = activeSession;
      window.api.confirmKill(target).then((ok) => {
        if (ok) window.api.killSession(target);
      });
    }
    return;
  }

  // Cmd+1..9 — switch to nth session
  if (/^[1-9]$/.test(e.key)) {
    const idx = parseInt(e.key, 10) - 1;
    const items = Array.from(sessionList.querySelectorAll('.session-item'));
    if (items[idx]) {
      e.preventDefault();
      e.stopPropagation();
      switchSession(items[idx].dataset.name);
    }
    return;
  }

  // Cmd+Shift+] / Cmd+Shift+[ — next/prev session (like browser tabs)
  if (e.shiftKey && (e.key === ']' || e.key === '[')) {
    const items = Array.from(sessionList.querySelectorAll('.session-item'));
    if (items.length === 0) return;
    const cur = items.findIndex(it => it.dataset.name === activeSession);
    const next = e.key === ']'
      ? (cur + 1) % items.length
      : (cur - 1 + items.length) % items.length;
    e.preventDefault();
    e.stopPropagation();
    switchSession(items[next].dataset.name);
  }
}, true);

// ---------------------------------------------------------------------------
// Restore sessions on startup
// ---------------------------------------------------------------------------

(async function restoreSessions() {
  const restored = await window.api.restoreSessions();
  if (!restored || restored.length === 0) return;

  for (const entry of restored) {
    createTerminal(entry.name);
    addSessionToSidebar(entry.name, entry.type, entry.cwd, entry.label);
  }
  // Focus the first restored session
  switchSession(restored[0].name);
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
