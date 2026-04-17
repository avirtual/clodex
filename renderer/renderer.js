const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SearchAddon } = require('@xterm/addon-search');

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
const inputTemplate = document.getElementById('input-template');
const templateRow = document.getElementById('template-row');
const btnTemplateDelete = document.getElementById('btn-template-delete');
const btnSaveTemplate = document.getElementById('btn-save-template');

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
// Workspace (window) name display and rename
// ---------------------------------------------------------------------------

const sidebarHeader = document.getElementById('sidebar-header');
let currentWorkspaceId = null;
let currentWorkspaceName = 'Workspace';

function renderWorkspaceName() {
  const el = document.getElementById('workspace-name');
  if (el) el.textContent = currentWorkspaceName;
}

(async function initWorkspace() {
  currentWorkspaceId = await window.api.currentWorkspace();
  const all = await window.api.listWorkspaces();
  const ws = all.find(w => w.id === currentWorkspaceId);
  if (ws) {
    currentWorkspaceName = ws.name || 'Workspace';
    renderWorkspaceName();
    document.title = currentWorkspaceName;
  }
})();

function startWorkspaceRename() {
  const span = document.getElementById('workspace-name');
  if (!span) return;
  const current = span.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'workspace-name-input';
  span.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const newName = commit ? (input.value.trim() || 'Workspace') : current;
    const newSpan = document.createElement('span');
    newSpan.id = 'workspace-name';
    newSpan.className = 'workspace-name';
    newSpan.title = 'Double-click to rename workspace';
    newSpan.textContent = newName;
    input.replaceWith(newSpan);
    if (commit && newName !== current) {
      currentWorkspaceName = newName;
      await window.api.setWorkspaceName(newName);
      document.title = newName;
    }
  };

  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
}

// Event delegation — survives element replacement
sidebarHeader.addEventListener('dblclick', (e) => {
  const target = e.target.closest('#workspace-name');
  if (target) startWorkspaceRename();
});

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
    case 'export':
      window.api.exportSessionMarkdown(name).then((res) => {
        if (!res.ok && res.error !== 'cancelled') {
          console.error('Export failed:', res.error);
        }
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

  const searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);
  searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
    // Only update UI if this is the active session
    if (activeSession === name) {
      if (resultCount === 0) searchInfo.textContent = 'no matches';
      else searchInfo.textContent = `${resultIndex + 1}/${resultCount}`;
    }
  });

  const wrapperEl = document.createElement('div');
  wrapperEl.className = 'terminal-wrapper';
  wrapperEl.dataset.name = name;
  terminalContainer.appendChild(wrapperEl);

  terminal.open(wrapperEl);

  // Send keystrokes to PTY
  terminal.onData((data) => {
    window.api.writeToSession(name, data);
  });

  sessions.set(name, { terminal, fitAddon, searchAddon, wrapperEl });
  updateWindowTitle();
  return { terminal, fitAddon, searchAddon, wrapperEl };
}

function switchSession(name) {
  if (!sessions.has(name)) return;

  // Close search if open — decorations are per-terminal
  if (!searchBar.classList.contains('hidden')) closeSearch();

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

async function refreshTemplatesDropdown() {
  const list = await window.api.listTemplates();
  // Clear existing options except the placeholder
  while (inputTemplate.options.length > 1) inputTemplate.remove(1);
  for (const t of list) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    inputTemplate.appendChild(opt);
  }
  templateRow.style.display = list.length > 0 ? '' : 'none';
  return list;
}

async function openDialog() {
  sessionCounter++;
  inputName.value = `session-${sessionCounter}`;
  inputType.value = 'claude';
  inputCwd.value = homeDir;
  inputTemplate.value = '';
  applyTypeDefaults();
  inputName.style.borderColor = '';
  await refreshTemplatesDropdown();
  dialogOverlay.classList.remove('hidden');
  setTimeout(() => inputName.select(), 50);
}

inputType.addEventListener('change', applyTypeDefaults);

// Apply a template's values to the form when selected
inputTemplate.addEventListener('change', async () => {
  const id = inputTemplate.value;
  if (!id) return;
  const list = await window.api.listTemplates();
  const t = list.find(x => x.id === id);
  if (!t) return;
  inputType.value = t.type;
  inputCwd.value = t.cwd || homeDir;
  inputArgs.value = (t.extraArgs || []).join(' ');
  argsHint.textContent = ARGS_HINTS[t.type] || '';
});

btnTemplateDelete.addEventListener('click', async () => {
  const id = inputTemplate.value;
  if (!id) return;
  await window.api.removeTemplate(id);
  await refreshTemplatesDropdown();
  inputTemplate.value = '';
});

btnSaveTemplate.addEventListener('click', async () => {
  const templateName = prompt('Template name:', '');
  if (!templateName || !templateName.trim()) return;
  const template = {
    id: `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: templateName.trim(),
    type: inputType.value,
    cwd: inputCwd.value || homeDir,
    extraArgs: parseArgs(inputArgs.value || ''),
  };
  await window.api.saveTemplate(template);
  await refreshTemplatesDropdown();
  inputTemplate.value = template.id;
});

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

const broadcastInput = document.getElementById('broadcast-input');
const broadcastSend = document.getElementById('broadcast-send');

async function sendBroadcast() {
  const body = broadcastInput.value.trim();
  if (!body) return;
  broadcastInput.disabled = true;
  broadcastSend.disabled = true;
  try {
    await window.api.broadcast(body);
    broadcastInput.value = '';
  } finally {
    broadcastInput.disabled = false;
    broadcastSend.disabled = false;
    broadcastInput.focus();
  }
}

broadcastSend.addEventListener('click', sendBroadcast);
broadcastInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') sendBroadcast();
});

// ---------------------------------------------------------------------------
// Terminal search (Cmd+F)
// ---------------------------------------------------------------------------

const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const searchInfo = document.getElementById('search-info');
const searchPrev = document.getElementById('search-prev');
const searchNext = document.getElementById('search-next');
const searchClose = document.getElementById('search-close');

const SEARCH_OPTS = {
  decorations: {
    matchBackground: '#e94560',
    matchBorder: '#e94560',
    matchOverviewRuler: '#e94560',
    activeMatchBackground: '#fbbf24',
    activeMatchBorder: '#fbbf24',
    activeMatchColorOverviewRuler: '#fbbf24',
  },
};

function openSearch() {
  searchBar.classList.remove('hidden');
  searchInput.focus();
  searchInput.select();
}

function closeSearch() {
  searchBar.classList.add('hidden');
  searchInfo.textContent = '';
  if (activeSession) {
    const s = sessions.get(activeSession);
    if (s && s.searchAddon) s.searchAddon.clearDecorations();
    if (s) s.terminal.focus();
  }
}

function findInTerminal(direction = 'next') {
  if (!activeSession) return;
  const s = sessions.get(activeSession);
  if (!s || !s.searchAddon) return;
  const term = searchInput.value;
  if (!term) {
    s.searchAddon.clearDecorations();
    searchInfo.textContent = '';
    return;
  }
  const method = direction === 'prev' ? 'findPrevious' : 'findNext';
  s.searchAddon[method](term, SEARCH_OPTS);
}

searchInput.addEventListener('input', () => findInTerminal('next'));
searchInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') findInTerminal(e.shiftKey ? 'prev' : 'next');
  if (e.key === 'Escape') closeSearch();
});
searchPrev.addEventListener('click', () => findInTerminal('prev'));
searchNext.addEventListener('click', () => findInTerminal('next'));
searchClose.addEventListener('click', closeSearch);

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

  // Cmd+F — open search bar for active terminal
  if (e.key === 'f' && !e.shiftKey) {
    if (activeSession) {
      e.preventDefault();
      e.stopPropagation();
      openSearch();
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

// ---------------------------------------------------------------------------
// Update banner
// ---------------------------------------------------------------------------

const updateBanner = document.getElementById('update-banner');
const updateText = document.getElementById('update-text');

function showUpdateBanner(info) {
  updateText.textContent = `Update available: v${info.version}`;
  updateBanner.classList.remove('hidden');
}

updateBanner.addEventListener('click', () => {
  window.api.openUpdate();
});

// Check if an update was already detected before the renderer loaded
window.api.getUpdateInfo().then((info) => { if (info) showUpdateBanner(info); });

// Listen for updates detected while running
window.api.onUpdateAvailable((info) => showUpdateBanner(info));

// Tray-triggered actions
window.api.onRequestSwitchSession((name) => switchSession(name));
window.api.onRequestOpenNewDialog(() => openDialog());

// ---------------------------------------------------------------------------
// Prompts library
// ---------------------------------------------------------------------------

const promptsDrawer = document.getElementById('prompts-drawer');
const promptsList = document.getElementById('prompts-list');
const promptsEmpty = document.getElementById('prompts-empty');
const promptEditor = document.getElementById('prompt-editor');
const promptEditorTitle = document.getElementById('prompt-editor-title');
const promptTitle = document.getElementById('prompt-title');
const promptBody = document.getElementById('prompt-body');
const promptSave = document.getElementById('prompt-save');
const promptCancel = document.getElementById('prompt-cancel');
const promptDelete = document.getElementById('prompt-delete');
const btnPrompts = document.getElementById('btn-prompts');
const promptsNew = document.getElementById('prompts-new');
const promptsClose = document.getElementById('prompts-close');

let editingPromptId = null;

async function refreshPromptsList() {
  const items = await window.api.listPrompts();
  promptsList.innerHTML = '';
  if (items.length === 0) {
    promptsEmpty.style.display = '';
    return;
  }
  promptsEmpty.style.display = 'none';
  for (const p of items) {
    const el = document.createElement('div');
    el.className = 'prompt-item';
    const preview = p.body.split('\n')[0].slice(0, 80) + (p.body.length > 80 ? '…' : '');
    el.innerHTML = `
      <div class="prompt-item-title">${esc(p.title)}</div>
      <div class="prompt-item-preview">${esc(preview)}</div>
      <div class="prompt-item-actions">
        <button class="primary" data-action="inject">Inject</button>
        <button data-action="edit">Edit</button>
      </div>
    `;
    el.querySelector('[data-action="inject"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!activeSession) {
        alert('No active session. Select one first.');
        return;
      }
      await window.api.injectPrompt(activeSession, p.body);
    });
    el.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
      e.stopPropagation();
      openPromptEditor(p);
    });
    // Clicking the body (not a button) = inject
    el.addEventListener('click', async () => {
      if (!activeSession) { alert('No active session. Select one first.'); return; }
      await window.api.injectPrompt(activeSession, p.body);
    });
    promptsList.appendChild(el);
  }
}

function openPromptsDrawer() {
  promptsDrawer.classList.remove('hidden');
  refreshPromptsList();
}

function closePromptsDrawer() {
  promptsDrawer.classList.add('hidden');
}

function openPromptEditor(prompt = null) {
  if (prompt) {
    editingPromptId = prompt.id;
    promptEditorTitle.textContent = 'Edit Prompt';
    promptTitle.value = prompt.title;
    promptBody.value = prompt.body;
    promptDelete.style.display = '';
  } else {
    editingPromptId = null;
    promptEditorTitle.textContent = 'New Prompt';
    promptTitle.value = '';
    promptBody.value = '';
    promptDelete.style.display = 'none';
  }
  promptEditor.classList.remove('hidden');
  setTimeout(() => promptTitle.focus(), 50);
}

function closePromptEditor() {
  promptEditor.classList.add('hidden');
  editingPromptId = null;
}

btnPrompts.addEventListener('click', () => {
  if (promptsDrawer.classList.contains('hidden')) openPromptsDrawer();
  else closePromptsDrawer();
});
promptsClose.addEventListener('click', closePromptsDrawer);
promptsNew.addEventListener('click', () => openPromptEditor(null));

promptSave.addEventListener('click', async () => {
  const title = promptTitle.value.trim();
  const body = promptBody.value;
  if (!title || !body.trim()) return;
  const id = editingPromptId || `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await window.api.savePrompt({ id, title, body });
  closePromptEditor();
  refreshPromptsList();
});

promptCancel.addEventListener('click', closePromptEditor);
promptDelete.addEventListener('click', async () => {
  if (!editingPromptId) return;
  if (!confirm('Delete this prompt?')) return;
  await window.api.removePrompt(editingPromptId);
  closePromptEditor();
  refreshPromptsList();
});

// Prevent keyboard shortcuts from firing inside the editor
promptTitle.addEventListener('keydown', (e) => e.stopPropagation());
promptBody.addEventListener('keydown', (e) => e.stopPropagation());

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
