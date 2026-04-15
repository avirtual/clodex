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

// Default cwd
const homeDir = require('os').homedir();
inputCwd.value = homeDir;

// ---------------------------------------------------------------------------
// Session UI
// ---------------------------------------------------------------------------

function addSessionToSidebar(name, type) {
  const item = document.createElement('div');
  item.className = 'session-item';
  item.dataset.name = name;
  item.innerHTML = `
    <span class="session-dot"></span>
    <div class="session-info">
      <div class="session-name">${esc(name)}</div>
      <div class="session-type">${esc(type)}</div>
    </div>
    <button class="session-close" title="Kill session">&times;</button>
  `;

  item.addEventListener('click', (e) => {
    if (e.target.closest('.session-close')) return;
    switchSession(name);
  });

  item.querySelector('.session-close').addEventListener('click', (e) => {
    e.stopPropagation();
    window.api.killSession(name);
  });

  sessionList.appendChild(item);
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

function openDialog() {
  sessionCounter++;
  inputName.value = `session-${sessionCounter}`;
  inputType.value = 'claude';
  inputName.style.borderColor = '';
  dialogOverlay.classList.remove('hidden');
  setTimeout(() => inputName.select(), 50);
}

function closeDialog() {
  dialogOverlay.classList.add('hidden');
}

async function doCreate() {
  const name = inputName.value.trim();
  const type = inputType.value;
  const cwd = inputCwd.value || homeDir;

  if (!name) return;
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
    inputName.style.borderColor = '#e94560';
    return;
  }

  closeDialog();

  const result = await window.api.createSession(name, type, cwd);
  if (!result.ok) {
    console.error('Failed to create session:', result.error);
    return;
  }

  createTerminal(name);
  addSessionToSidebar(name, type);
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

// Enter to create, Escape to cancel
dialogOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doCreate();
  if (e.key === 'Escape') closeDialog();
});

// Click outside dialog to cancel
dialogOverlay.addEventListener('click', (e) => {
  if (e.target === dialogOverlay) closeDialog();
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
// Helpers
// ---------------------------------------------------------------------------

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
