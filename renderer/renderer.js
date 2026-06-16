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
const inputSystemPrompt = document.getElementById('input-system-prompt');
const systemPromptRow = document.getElementById('system-prompt-row');
const inputResume = document.getElementById('input-resume');
const inputFork = document.getElementById('input-fork');
const resumeRow = document.getElementById('resume-row');
const proxyRow = document.getElementById('proxy-row');
const inputProxyMode = document.getElementById('input-proxy-mode');
const inputProxyUrl = document.getElementById('input-proxy-url');

// Map a proxy <select> mode + URL field to the persisted tri-state value:
// null = follow the Clodex-level preference, false = off, string = custom.
function proxyValueFromControls(modeSel, urlInput) {
  if (modeSel.value === 'off') return false;
  if (modeSel.value === 'custom') return urlInput.value.trim() || false;
  return null;
}

function setProxyControls(modeSel, urlInput, proxy, rememberedUrl) {
  modeSel.value = proxy === false ? 'off' : (typeof proxy === 'string' ? 'custom' : '');
  urlInput.value = typeof proxy === 'string' ? proxy : (rememberedUrl || 'http://127.0.0.1:7800');
  urlInput.style.display = modeSel.value === 'custom' ? '' : 'none';
}

// Reflect the global preference in the "Default" option label so the
// dialog says what inheriting actually means right now.
function labelProxyDefault(modeSel, settings) {
  const opt = modeSel.querySelector('option[value=""]');
  if (opt) {
    opt.textContent = settings?.proxyEnabled
      ? `Default (on — ${settings.proxyUrl})`
      : 'Default (off)';
  }
}
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

// Triggered from the File menu > Rename Workspace…
window.api.onRequestRenameWorkspace(() => startWorkspaceRename());

// ---------------------------------------------------------------------------
// Session UI
// ---------------------------------------------------------------------------

// Add a sidebar entry for a session that failed to restore
function addFailedSessionToSidebar(entry) {
  const item = document.createElement('div');
  item.className = 'session-item failed';
  item.dataset.name = entry.name;
  item.dataset.cwd = entry.cwd || '';
  item.dataset.failed = '1';
  const displayName = entry.label || entry.name;
  const cwdLabel = entry.cwd ? esc(shortPath(entry.cwd)) : '';
  item.innerHTML = `
    <span class="session-dot"></span>
    <div class="session-info">
      <div class="session-name" title="Restore failed: ${esc(entry.error || 'unknown error')}">${esc(displayName)}</div>
      <div class="session-meta">
        <span class="session-type">${esc(entry.type)} — failed</span>
        ${cwdLabel ? `<span class="session-cwd" title="${esc(entry.cwd || '')}">${cwdLabel}</span>` : ''}
      </div>
    </div>
    <button class="session-close" title="Forget session">&times;</button>
  `;

  // Click anywhere (except close) to retry
  item.addEventListener('click', async (e) => {
    if (e.target.closest('.session-close')) return;
    const res = await window.api.retrySpawnSession(entry.name);
    if (!res.ok) {
      alert(`Retry failed: ${res.error}`);
      return;
    }
    // Reload this item: remove the failed placeholder and add a real one
    item.remove();
    createTerminal(entry.name);
    addSessionToSidebar(entry.name, entry.type, entry.cwd, entry.label);
    switchSession(entry.name);
  });

  item.querySelector('.session-close').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm(`Forget session "${entry.name}"? It isn't running — this just removes the saved entry.`)) {
      await window.api.forgetSession(entry.name);
      item.remove();
    }
  });

  sessionList.appendChild(item);
}

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
    <span class="session-warm" title="Prompt-cache warmth (time to expiry)"></span>
    <span class="session-ctx" title="Context used"></span>
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
    case 'editArgs':
      openArgsDialog(name);
      break;
    case 'restart': {
      // Snapshot sidebar metadata before the kill+respawn wipes the tab
      // via session-exit, same dance as the Edit Session save path.
      const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
      const snapType = item ? item.querySelector('.session-type')?.textContent : null;
      const snapCwd = item ? item.dataset.cwd : null;
      window.api.restartSession(name).then((res) => {
        if (!res || !res.ok) {
          alert(`Restart failed: ${res && res.error ? res.error : 'unknown error'}`);
          return;
        }
        if (snapType) {
          createTerminal(name);
          addSessionToSidebar(name, snapType, snapCwd, null);
          switchSession(name);
        }
      });
      break;
    }
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

  // Proxy status bar follows the active session. Render last-known immediately,
  // then pull a fresh snapshot so the bar fills without waiting for a poll.
  renderProxyBar();
  if (window.api.getProxySnapshot) {
    window.api.getProxySnapshot(name).then((p) => {
      if (!p) return;
      proxyState.set(name, { payload: p, at: Date.now() });
      applyWarmBadge(name);
      if (activeSession === name) renderProxyBar();
    }).catch(() => {});
  }

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
  proxyState.delete(name);

  if (activeSession === name) {
    const remaining = Array.from(sessions.keys());
    if (remaining.length > 0) {
      switchSession(remaining[0]);
    } else {
      activeSession = null;
      emptyState.style.display = '';
      renderProxyBar();
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
  const supportsSystemPrompt = type === 'claude' || type === 'codex';
  systemPromptRow.style.display = supportsSystemPrompt ? '' : 'none';
  if (!supportsSystemPrompt) inputSystemPrompt.value = '';
  // Custom subagents and per-session tool gating are Claude-only.
  agentsRow.style.display = type === 'claude' ? '' : 'none';
  toolsRow.style.display = type === 'claude' ? '' : 'none';
  const supportsResume = type === 'claude' || type === 'codex';
  resumeRow.style.display = supportsResume ? '' : 'none';
  if (!supportsResume) {
    inputResume.value = '';
    inputFork.checked = false;
  }
  // Proxy routing only makes sense for agent types
  proxyRow.style.display = supportsResume ? '' : 'none';
  if (!supportsResume) {
    inputProxyMode.value = '';
    inputProxyUrl.style.display = 'none';
  }
}

async function refreshSystemPromptDropdown() {
  const list = await window.api.listPrompts();
  while (inputSystemPrompt.options.length > 1) inputSystemPrompt.remove(1);
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.title;
    opt.dataset.body = p.body;
    inputSystemPrompt.appendChild(opt);
  }
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

// --- Custom subagent enablement (Claude only). Shared by the new-session
// and edit-session dialogs; the library itself lives in the Agents drawer. ---
const agentsRow = document.getElementById('agents-row');
const inputAgentsList = document.getElementById('input-agents-list');
const inputDenyBuiltins = document.getElementById('input-deny-builtins');
let agentLibCache = [];

function renderAgentChecklist(container, enabledSet) {
  container.innerHTML = '';
  if (!agentLibCache.length) {
    container.innerHTML = '<span class="hint-text">No agents in library — add some via the 🤖 Agents drawer.</span>';
    return;
  }
  for (const a of agentLibCache) {
    const row = document.createElement('label');
    row.className = 'agent-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = a.name;
    cb.checked = enabledSet.has(a.name);
    const txt = document.createElement('span');
    txt.innerHTML = `<strong>${esc(a.name)}</strong>${a.description ? ' — ' + esc(a.description) : ''}`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}
function collectAgentChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}

// --- Per-session tool gating (Claude only). The catalog is a curated static
// list supplied by main via getSettings().claudeTools. Checkboxes default to
// checked (= tool available); unchecking adds the tool to `disabledTools`,
// which becomes a permissions.deny entry at spawn. A stored disabled tool that
// isn't in the current catalog is still shown (unchecked) so editing a session
// never silently re-enables a tool the catalog dropped. ---
const toolsRow = document.getElementById('tools-row');
const inputToolsList = document.getElementById('input-tools-list');
let claudeToolsCache = [];

function renderToolChecklist(container, disabledSet) {
  container.innerHTML = '';
  // Catalog is authoritative: render only known tools. A stale name in
  // disabledSet (removed from the catalog, or persisted before our time) is
  // intentionally NOT shown — it falls out of the deny on the next Apply.
  const names = [...claudeToolsCache];
  if (!names.length) {
    container.innerHTML = '<span class="hint-text">No tool catalog available.</span>';
    return;
  }
  for (const name of names) {
    const row = document.createElement('label');
    row.className = 'agent-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = name;
    cb.checked = !disabledSet.has(name);
    const txt = document.createElement('span');
    txt.innerHTML = `<strong>${esc(name)}</strong>`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}
// Returns the UNCHECKED tools (the disabled set).
function collectToolChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:not(:checked)')).map(cb => cb.value);
}

async function openDialog() {
  sessionCounter++;
  inputName.value = `session-${sessionCounter}`;
  inputType.value = 'claude';
  inputCwd.value = homeDir;
  inputTemplate.value = '';
  inputSystemPrompt.value = '';
  inputResume.value = '';
  inputFork.checked = false;
  applyTypeDefaults();
  inputName.style.borderColor = '';
  const [, , settings, agentLib] = await Promise.all([
    refreshTemplatesDropdown(),
    refreshSystemPromptDropdown(),
    window.api.getSettings(),
    window.api.listAgents(),
  ]);
  agentLibCache = agentLib || [];
  renderAgentChecklist(inputAgentsList, new Set());
  inputDenyBuiltins.checked = false;
  claudeToolsCache = settings?.claudeTools || [];
  renderToolChecklist(inputToolsList, new Set());
  setProxyControls(inputProxyMode, inputProxyUrl, null, settings?.proxyUrl);
  labelProxyDefault(inputProxyMode, settings);
  dialogOverlay.classList.remove('hidden');
  setTimeout(() => inputName.select(), 50);
}

inputType.addEventListener('change', applyTypeDefaults);

inputProxyMode.addEventListener('change', () => {
  inputProxyUrl.style.display = inputProxyMode.value === 'custom' ? '' : 'none';
  if (inputProxyMode.value === 'custom') inputProxyUrl.focus();
});

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

function expandPath(p) {
  if (!p) return p;
  if (p === '~') return homeDir;
  if (p.startsWith('~/')) return homeDir + p.slice(1);
  return p;
}

async function doCreate() {
  const name = inputName.value.trim();
  const type = inputType.value;
  const cwd = expandPath(inputCwd.value.trim()) || homeDir;
  const extraArgs = parseArgs(inputArgs.value || '');

  let systemPromptBody = null;
  if ((type === 'claude' || type === 'codex') && inputSystemPrompt.value) {
    const opt = inputSystemPrompt.options[inputSystemPrompt.selectedIndex];
    systemPromptBody = (opt && opt.dataset.body) || null;
  }

  if (!name) return;
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
    inputName.style.borderColor = '#e94560';
    return;
  }

  const resumeId = (type === 'claude' || type === 'codex') ? inputResume.value.trim() || null : null;
  const fork = (type === 'claude' || type === 'codex') ? inputFork.checked : false;
  const proxy = (type === 'claude' || type === 'codex')
    ? proxyValueFromControls(inputProxyMode, inputProxyUrl) : null;
  const agents = type === 'claude' ? collectAgentChecklist(inputAgentsList) : [];
  const denyBuiltins = (type === 'claude' && inputDenyBuiltins.checked) ? ['general-purpose'] : [];
  const disabledTools = type === 'claude' ? collectToolChecklist(inputToolsList) : [];

  closeDialog();

  if (typeof proxy === 'string') window.api.setSettings({ proxyUrl: proxy }); // remember last used
  const result = await window.api.createSession(name, type, cwd, extraArgs, systemPromptBody, resumeId, fork, proxy, agents, denyBuiltins, disabledTools);
  if (!result.ok) {
    console.error('Failed to create session:', result.error);
    alert(`Failed to create session: ${result.error || 'unknown error'}`);
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

// Context-window usage per session, from Claude's statusline side-channel (the
// real figures — the proxy only reports message/turn counts, not % or absolute
// tokens of the window). Cached so the proxy bar can show them too.
const ctxPct = new Map();
const ctxTokens = new Map(); // name -> { used, size }

// Context heaviness thresholds (absolute tokens), mirroring status-line.sh's
// WARN_TOKENS / HEAVY_TOKENS so the bar and the statusline agree on color.
// Absolute, not %: long context degrades quality regardless of the window cap.
const CTX_WARN_TOKENS = 200000;   // yellow
const CTX_HEAVY_TOKENS = 300000;  // red

// Compact token count: 201234 -> "201k", 1000000 -> "1M".
function fmtTokens(n) {
  if (n >= 1e6) { const m = n / 1e6; return (Number.isInteger(m) ? m : m.toFixed(1)) + 'M'; }
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function applyCtxBadge(name, pct) {
  const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (!el) return;
  const badge = el.querySelector('.session-ctx');
  if (!badge) return;
  badge.textContent = pct > 0 ? `${pct}%` : '';
  badge.dataset.level = pct >= 80 ? 'high' : pct >= 60 ? 'mid' : 'low';
}

window.api.onSessionCtx((name, pct, tok, size) => {
  ctxPct.set(name, pct);
  if (typeof tok === 'number' && typeof size === 'number' && size > 0) {
    ctxTokens.set(name, { used: tok, size });
  }
  applyCtxBadge(name, pct);
  if (name === activeSession) renderProxyBar();
});

// --- Proxy telemetry status bar (wirescope pull) --------------------------
// The main process polls the proxy and pushes a per-session payload. We show
// the ACTIVE session's line in a strip under the terminal, ticking the cache
// countdown locally between polls and degrading honestly (~/grey/"stale")
// when polls stop arriving so it never fakes precision.
const PROXY_POLL_MS = 5000;
const proxyState = new Map(); // name -> { payload, at }

function fmtCountdown(remaining_s) {
  const s = Math.max(0, Math.round(remaining_s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Type of a session, read from its sidebar tab (the renderer's source for it).
function sessionTypeOf(name) {
  const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  return item ? (item.querySelector('.session-type')?.textContent || null) : null;
}
function activeIsAgent() {
  const t = activeSession ? sessionTypeOf(activeSession) : null;
  return t === 'claude' || t === 'codex';
}

// Per-session quick-access icons on the left of the status bar. Claude gets a
// Tools button (tool gating is Claude-only); both agent types get an Edit
// shortcut so the crowded right-click menu isn't the only way in.
// Right side of the bar: session actions (tools, edit) plus the keep-warm
// control. `holdHtml` is the warm-control markup built by renderProxyBar from
// the live payload; the early-return paths call this with no argument.
function renderSessionActions(holdHtml = '') {
  const el = document.getElementById('proxy-actions');
  if (!el) return;
  const type = activeSession ? sessionTypeOf(activeSession) : null;
  const btns = [];
  if (type === 'claude') {
    btns.push('<button class="px-action" data-act="tools" title="Enable/disable tools for this session">🛠 tools</button>');
  }
  if (type === 'claude' || type === 'codex') {
    btns.push('<button class="px-action" data-act="edit" title="Edit session settings">⚙ edit</button>');
  }
  el.innerHTML = btns.join('') + (holdHtml || '');
}

function renderProxyBar() {
  const bar = document.getElementById('proxy-bar');
  if (!bar) return;
  const main = document.getElementById('main');
  const tele = document.getElementById('proxy-telemetry');
  renderSessionActions();
  const st = activeSession ? proxyState.get(activeSession) : null;
  // Show the bar whenever an agent session is active (so the action icons are
  // always reachable), or whenever there's telemetry to show. Hide it only for
  // non-agent sessions with nothing to display.
  if (!st || !st.payload) {
    if (activeIsAgent()) {
      bar.style.display = '';
      if (main) main.classList.add('has-proxy-bar');
      tele.className = '';
      tele.innerHTML = '';
    } else {
      bar.style.display = 'none';
      if (main) main.classList.remove('has-proxy-bar');
    }
    return;
  }
  const p = st.payload;
  bar.style.display = '';
  if (main) main.classList.add('has-proxy-bar');

  if (!p.linked) {
    tele.className = 'px-muted';
    tele.textContent = 'proxy: no live session for this agent';
    return;
  }

  const ageMs = Date.now() - st.at;
  const stale = ageMs > PROXY_POLL_MS * 2;
  const dead = ageMs > PROXY_POLL_MS * 4;
  tele.className = dead ? 'px-dead' : (stale ? 'px-stale' : '');

  const segs = [];
  if (p.model) segs.push(`<span class="px-seg">${esc(p.model)}</span>`);
  // Real context usage. Token COUNT prefers wirescope's live input_tokens (it
  // updates even while the session is idle/unfocused — the statusline can't);
  // the window SIZE is off-wire, so it comes from the CLI statusline side-
  // channel. With both we show "201k/1M (20%)" — 20% of 1M reads very
  // differently from 20% of 200k. Degrades to side-channel tokens, then bare %,
  // then the proxy's message count (Codex, "msg" so it can't read as minutes).
  const pct = ctxPct.get(activeSession);
  const sc = ctxTokens.get(activeSession); // { used, size } from CLI side-channel
  const wireTok = p.context && typeof p.context.inputTokens === 'number' ? p.context.inputTokens : null;
  const usedTok = wireTok != null ? wireTok : (sc && sc.used > 0 ? sc.used : null);
  const sizeTok = sc && sc.size > 0 ? sc.size : null;
  // When wirescope exposes the breakdown, the ctx seg becomes a button that
  // opens the composition popover. Standalone (no cap) → plain text.
  const ctxUtil = !!(p.capabilities && p.capabilities.context_utilization);
  const ctxClickable = !!(p.linked && p.capabilities &&
    (p.capabilities.context_composition || p.capabilities.context_view || ctxUtil));
  const ctxCls = ctxClickable ? ' px-ctx-btn' : '';
  const ctxAttr = ctxClickable ? ' data-act="ctx"' : '';
  const ctxTip = ctxClickable
    ? (ctxUtil ? 'Click for context + tool-utilization breakdown' : 'Click for context breakdown')
    : null;
  if (usedTok != null && usedTok > 0) {
    const heavy = usedTok >= CTX_HEAVY_TOKENS ? ' px-ctx-heavy' : usedTok >= CTX_WARN_TOKENS ? ' px-ctx-warn' : '';
    if (sizeTok) {
      const p2 = Math.round((usedTok / sizeTok) * 100);
      segs.push(`<span class="px-seg${heavy}${ctxCls}"${ctxAttr} title="${ctxTip || 'Context: tokens used / window size'}">ctx ${fmtTokens(usedTok)}/${fmtTokens(sizeTok)} (${p2}%)</span>`);
    } else {
      segs.push(`<span class="px-seg${heavy}${ctxCls}"${ctxAttr} title="${ctxTip || 'Context tokens used'}">ctx ${fmtTokens(usedTok)}</span>`);
    }
  } else if (typeof pct === 'number' && pct > 0) {
    segs.push(`<span class="px-seg${ctxCls}"${ctxAttr} title="${ctxTip || 'Context window used'}">ctx ${pct}%</span>`);
  } else if (p.context && p.context.messages != null) {
    segs.push(`<span class="px-seg${ctxCls}"${ctxAttr} title="${ctxTip || 'Messages in context'}">ctx ${p.context.messages} msg</span>`);
  }
  if (p.turns != null) segs.push(`<span class="px-seg">turn ${p.turns}</span>`);
  if (p.warmth) {
    let txt;
    if (dead) {
      txt = '🔥 ?';
    } else if (p.warmth.state === 'warm' && p.warmth.remaining_s != null) {
      const remaining = p.warmth.remaining_s - ageMs / 1000;
      txt = remaining > 0 ? `🔥 ${stale ? '~' : ''}${fmtCountdown(remaining)}` : '❄️ cold';
    } else {
      txt = '❄️ cold';
    }
    segs.push(`<span class="px-seg px-warm">${txt}</span>`);
  }
  if (p.cost && p.cost.usd != null) {
    // ~ signals "estimate"; drop the cryptic "px est." label. Trim decimals once
    // the number is large enough that 4 places are just noise.
    const costTxt = p.cost.usd >= 1 ? p.cost.usd.toFixed(2) : p.cost.usd.toFixed(4);
    segs.push(`<span class="px-seg px-cost" title="wirescope cost estimate">~$${costTxt}</span>`);
  }
  if (p.refusals > 0) segs.push(`<span class="px-seg px-refusal">⚠ ${p.refusals}</span>`);
  if (p.base && p.sessionId) {
    const url = `${p.base}/_session?session=${encodeURIComponent(p.sessionId)}`;
    segs.push(`<a class="px-seg px-link" data-url="${esc(url)}" title="Open this session's page on wirescope">🔍 wirescope</a>`);
  }

  // Keep-warm control (only when the proxy advertises the capability): a single
  // fire button that opens a duration dropdown (1h/4h/8h, plus Stop when held).
  let holdHtml = '';
  if (p.capabilities && p.capabilities.hold) {
    if (p.hold) {
      // `until` re-anchors to the last real turn, so this slides forward as the
      // session is used — it's "stays warm ~N more hours if idle", not a fixed
      // countdown. pingable=false → armed but waiting for the next turn to fire.
      const untilS = typeof p.hold.until === 'number' ? p.hold.until : null;
      const remH = untilS != null ? Math.max(0, (untilS - Date.now() / 1000) / 3600) : null;
      const remTxt = remH == null ? '' : (remH < 1 ? ` ~${Math.round(remH * 60)}m` : ` ~${remH.toFixed(1)}h`);
      const pending = p.pingable === false;
      const label = pending ? '🔒 armed' : `🔒 held${remTxt}`;
      const tip = pending ? 'Armed — starts keeping warm after the next turn. Click to change or stop.' : 'Keeping cache warm. Click to change or stop.';
      holdHtml = `<button class="px-hold" data-act="warm-menu" data-held="1" title="${tip}">${label}</button>`;
    } else {
      holdHtml = `<button class="px-hold" data-act="warm-menu" title="Keep prompt cache warm">🔥 keep warm</button>`;
    }
  }
  tele.innerHTML = segs.join('<span class="px-sep">·</span>');
  // Keep-warm lives with the actions on the right, not in the info column.
  renderSessionActions(holdHtml);
}

// Lightweight per-second update: refresh only the countdown text + staleness
// class, leaving the keep-warm buttons (and their hover state) untouched.
function tickProxyBar() {
  const bar = document.getElementById('proxy-bar');
  if (!bar || bar.style.display === 'none' || !activeSession) return;
  const st = proxyState.get(activeSession);
  if (!st || !st.payload || !st.payload.linked || !st.payload.warmth) return;
  const p = st.payload;
  const ageMs = Date.now() - st.at;
  const stale = ageMs > PROXY_POLL_MS * 2, dead = ageMs > PROXY_POLL_MS * 4;
  const tele = document.getElementById('proxy-telemetry');
  if (!tele) return;
  tele.classList.toggle('px-stale', stale && !dead);
  tele.classList.toggle('px-dead', dead);
  const w = tele.querySelector('.px-warm');
  if (!w) return;
  if (dead) w.textContent = '🔥 ?';
  else if (p.warmth.state === 'warm' && p.warmth.remaining_s != null
           && p.warmth.remaining_s - ageMs / 1000 > 0) {
    w.textContent = `🔥 ${stale ? '~' : ''}${fmtCountdown(p.warmth.remaining_s - ageMs / 1000)}`;
  } else w.textContent = '❄️ cold';
}

// Per-tab cache-warmth badge — the async payoff: every open session shows a
// live countdown even while unfocused (the statusline can't, it only runs on
// interaction). Also flags refusals on the tab.
function applyWarmBadge(name) {
  const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (!el) return;
  const badge = el.querySelector('.session-warm');
  const st = proxyState.get(name);
  const p = st && st.payload;

  if (badge) {
    if (!p || !p.linked || !p.warmth) {
      badge.textContent = '';
      badge.dataset.state = '';
    } else {
      const ageMs = Date.now() - st.at;
      if (ageMs > PROXY_POLL_MS * 4) {
        badge.textContent = '🔥?'; badge.dataset.state = 'stale';
      } else if (p.warmth.state === 'warm' && p.warmth.remaining_s != null
                 && p.warmth.remaining_s - ageMs / 1000 > 0) {
        badge.textContent = '🔥' + fmtCountdown(p.warmth.remaining_s - ageMs / 1000);
        badge.dataset.state = 'warm';
      } else {
        badge.textContent = '❄️'; badge.dataset.state = 'cold';
      }
    }
  }
  el.dataset.refusal = (p && p.linked && p.refusals > 0) ? '1' : '';
}

window.api.onSessionProxy((name, payload) => {
  proxyState.set(name, { payload, at: Date.now() });
  applyWarmBadge(name);
  if (name === activeSession) renderProxyBar();
});

// Tick live countdowns once a second: the active session's bar plus every
// tab's warmth badge. Uses the light text-only update so keep-warm buttons
// aren't rebuilt out from under the cursor.
setInterval(() => {
  for (const name of proxyState.keys()) applyWarmBadge(name);
  tickProxyBar();
}, 1000);

// Keep-warm control — delegated so it survives bar re-renders. Distinguishes
// "armed" from "proxy declined (reason)" so a no-op never reads as success;
// discloses the per-ping cost before arming.
(() => {
  const bar = document.getElementById('proxy-bar');
  if (!bar) return;
  bar.addEventListener('click', async (e) => {
    const link = e.target.closest('.px-link');
    if (link && link.dataset.url) { e.preventDefault(); window.api.openExternal(link.dataset.url); return; }
    const ctxSeg = e.target.closest('[data-act="ctx"]');
    if (ctxSeg && activeSession) { openContextPopover(activeSession, ctxSeg); return; }
    const action = e.target.closest('.px-action');
    if (action && activeSession) {
      if (action.dataset.act === 'edit') openArgsDialog(activeSession);
      else if (action.dataset.act === 'tools') openToolsPopover(activeSession, action);
      return;
    }
    const btn = e.target.closest('.px-hold');
    if (!btn || !activeSession || btn.dataset.act !== 'warm-menu') return;
    if (warmMenu) closeWarmMenu();
    else openWarmMenu(btn, btn.dataset.held === '1');
  });
})();

// --- Keep-warm duration dropdown ----------------------------------------
// The fire button in the bottom bar opens this; items arm/extend a hold
// (1h/4h/8h) or stop it. Floats above the button, dismissed on outside-click.
let warmMenu = null;

function closeWarmMenu() {
  if (warmMenu) { warmMenu.remove(); warmMenu = null; }
}

function openWarmMenu(anchorBtn, held) {
  closeWarmMenu();
  warmMenu = document.createElement('div');
  warmMenu.className = 'warm-menu';
  const items = ['<div class="warm-menu-label">Keep cache warm for</div>'];
  for (const h of [1, 4, 8]) items.push(`<button class="warm-item" data-hours="${h}">${h} hours</button>`);
  if (held) items.push('<button class="warm-item warm-stop" data-act="off">Stop keeping warm</button>');
  warmMenu.innerHTML = items.join('');
  warmMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('.warm-item');
    if (!item || !activeSession) return;
    const name = activeSession;
    closeWarmMenu();
    if (item.dataset.act === 'off') await doWarmHold(name, { off: true });
    else await doWarmHold(name, { hours: Number(item.dataset.hours) });
  });
  document.body.appendChild(warmMenu);
  // Anchor above the button, clamped to the viewport.
  const r = anchorBtn.getBoundingClientRect();
  const w = warmMenu.offsetWidth;
  warmMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  warmMenu.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
}

// off:true disarms; otherwise arms/extends for opts.hours. Mirrors the prior
// inline handler (confirm, force-on-not-warm, armed/pending feedback).
async function doWarmHold(name, opts) {
  if (opts.off) {
    const r = await window.api.proxyHold(name, 0, false);
    if (!r.ok) alert('Could not disarm hold: ' + r.error);
    return;
  }
  const hours = opts.hours;
  if (!confirm(`Keep "${name}" prompt cache warm for ${hours}h?\n\nThe proxy auto-pings to refresh the cache until ${hours}h after the last turn; each ping costs ~1 token.`)) return;
  let r = await window.api.proxyHold(name, hours, false);
  if (r.ok && !r.armed && r.skipped) {
    if (confirm(`Proxy declined (${r.skipped}): the cache prefix isn't warm yet, so there's nothing to keep warm. Force the hold anyway?`)) {
      r = await window.api.proxyHold(name, hours, true);
    } else return;
  }
  if (!r.ok) alert('Hold failed: ' + r.error);
  else if (!r.armed) alert('Hold not armed' + (r.skipped ? ` (${r.skipped})` : ''));
  else if (r.body && r.body.pingable === false) {
    alert(`Hold armed for "${name}". It will start keeping the cache warm after the next turn (nothing to ping yet).`);
  }
  // The armed/disarmed state shows on the next poll (≤5s).
}

document.addEventListener('click', (e) => {
  if (!warmMenu) return;
  if (warmMenu.contains(e.target)) return;
  if (e.target.closest('.px-hold[data-act="warm-menu"]')) return; // toggle handled by the bar
  closeWarmMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && warmMenu) closeWarmMenu();
});

// --- Tools quick-access popover ------------------------------------------
// Opened from the status-bar "tools" icon. Reads the session's current
// disabled set + the known-tool catalog, lets the user toggle, and persists
// via session:setTools (optionally restarting to apply immediately). The disabled
// set drives permissions.deny at spawn — see CLAUDE_TOOLS in main.js.
const toolsPopover = document.getElementById('tools-popover');
const toolsPopoverName = document.getElementById('tools-popover-name');
const popoverToolsList = document.getElementById('popover-tools-list');
const toolsPopoverRestart = document.getElementById('tools-popover-restart');

function closeToolsPopover() {
  toolsPopover.classList.add('hidden');
  toolsPopover.dataset.name = '';
}

async function openToolsPopover(name, anchorBtn) {
  const [settings, res] = await Promise.all([
    window.api.getSettings(),
    window.api.getSessionArgs(name),
  ]);
  if (!res || !res.ok) { alert('Session not found in persistence.'); return; }
  claudeToolsCache = settings?.claudeTools || [];
  renderToolChecklist(popoverToolsList, new Set(res.disabledTools || []));
  toolsPopoverRestart.checked = false;
  toolsPopoverName.textContent = name;
  toolsPopover.dataset.name = name;
  toolsPopover.classList.remove('hidden');
  // Anchor above the button, clamped to the viewport.
  const r = anchorBtn.getBoundingClientRect();
  const w = toolsPopover.offsetWidth;
  toolsPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  toolsPopover.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
}

document.getElementById('tools-popover-cancel').addEventListener('click', closeToolsPopover);
document.getElementById('tools-popover-apply').addEventListener('click', async () => {
  const name = toolsPopover.dataset.name;
  if (!name) return closeToolsPopover();
  const disabledTools = collectToolChecklist(popoverToolsList);
  const restart = toolsPopoverRestart.checked;
  closeToolsPopover();
  const r = await window.api.setSessionTools(name, disabledTools);
  if (!r || !r.ok) { alert(`Failed to update tools: ${r && r.error ? r.error : 'unknown error'}`); return; }
  if (!restart) return;
  // Same re-attach dance as the context-menu restart path.
  const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  const snapType = item ? item.querySelector('.session-type')?.textContent : null;
  const snapCwd = item ? item.dataset.cwd : null;
  const rr = await window.api.restartSession(name);
  if (!rr || !rr.ok) { alert(`Restart failed: ${rr && rr.error ? rr.error : 'unknown error'}`); return; }
  if (snapType) {
    createTerminal(name);
    addSessionToSidebar(name, snapType, snapCwd, null);
    switchSession(name);
  }
});
// Dismiss on outside click / Escape.
document.addEventListener('mousedown', (e) => {
  if (toolsPopover.classList.contains('hidden')) return;
  if (toolsPopover.contains(e.target)) return;
  if (e.target.closest('.px-action')) return; // the toggle button handles itself
  closeToolsPopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !toolsPopover.classList.contains('hidden')) closeToolsPopover();
});

// --- Context-breakdown popover -------------------------------------------
// Opened from the ctx telemetry seg (only when wirescope advertises
// context_view/context_composition). Pulls /_context for the live session and
// renders the per-category composition (biggest-first), per agent line. Falls
// back to the tools roster on a context_view-only proxy. Standalone clodex
// (no proxy) never shows the button — see renderProxyBar.
const ctxPopover = document.getElementById('ctx-popover');
const ctxPopoverName = document.getElementById('ctx-popover-name');
const ctxPopoverBody = document.getElementById('ctx-popover-body');

const CTX_CAT_LABELS = {
  tools: 'Tools', system: 'System prompt', claudemd: 'CLAUDE.md',
  useremail: 'User email', user: 'User messages', assistant: 'Assistant',
  thinking: 'Thinking', tool_calls: 'Tool calls', tool_results: 'Tool results',
};
// Unknown future categories collapse to "other" (forward-compatible per the
// wirescope contract).
const ctxCatLabel = (c) => CTX_CAT_LABELS[c] || 'other';

function closeContextPopover() {
  ctxPopover.classList.add('hidden');
  ctxPopover.dataset.name = '';
}

function placeCtxPopover(anchor) {
  const r = anchor.getBoundingClientRect();
  const w = ctxPopover.offsetWidth;
  ctxPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  ctxPopover.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
}

function renderCompositionLine(a) {
  const comp = a.composition;
  const head = a.line === 'main' ? 'main' : (a.display_name || a.agent_id || 'subagent');
  const est = comp.basis === 'estimate' ? '<span class="ctx-est">~est</span>' : '';
  const rows = (comp.by_category || []).map((c) => {
    const pct = typeof c.pct === 'number' ? c.pct : 0;
    const pctTxt = pct < 10 ? pct.toFixed(1) : Math.round(pct);
    return `<div class="ctx-row"><div class="ctx-row-top">` +
      `<span class="ctx-cat">${esc(ctxCatLabel(c.category))}</span>` +
      `<span class="ctx-nums">${fmtTokens(c.tokens)} · ${pctTxt}%</span></div>` +
      `<div class="ctx-bar"><i style="width:${Math.max(1, Math.min(100, pct))}%"></i></div></div>`;
  }).join('');
  return `<div class="ctx-line-head"><span>${esc(head)}${est}</span>` +
    `<span class="ctx-line-total">${fmtTokens(comp.total_tokens)}</span></div>${rows}`;
}

// Below this many evaluable (tool-loading) turns, a `used:0` verdict is too
// thin to trust — a never-called tool over 2 turns is inconclusive, over 40
// it's genuine deadweight. We say so rather than crying "deadweight" early.
// Aligned to wirescope's analyze_tools.DEFAULT_MIN_TURNS so the popover's
// idle→dead graduation matches the offline ledger exactly (a floor, not a
// cliff: confidence keeps rising with turns; 0/40 is just more damning).
const UTIL_MIN_TURNS = 3;
// Cap the unused trim-list; the rest collapse into a "+N more" summary.
const UTIL_UNUSED_CAP = 12;

// Renders the tool-utilization block for one agent line (the "did it pay off"
// view). Mirrors the per-agent composition shape; '' when the agent carries no
// utilization (Codex/openai lines, or a non-utilization proxy build).
function renderUtilization(a) {
  const u = a.utilization;
  const t = a.tools;
  if (!u || !t || !Array.isArray(t.per_tool)) return '';
  const turns = u.evaluable_turns || 0;
  const loaded = u.loaded != null ? u.loaded : (t.count || t.per_tool.length);
  const usedDistinct = u.used_distinct != null ? u.used_distinct : t.per_tool.filter((x) => (x.used || 0) > 0).length;
  const deadweight = u.deadweight_tokens || 0;
  const lowConf = turns < UTIL_MIN_TURNS;
  // "dead" is a verdict; only claim it once enough turns back it. Until then
  // the same tokens are merely "idle" — present but not yet proven wasted.
  const deadWord = lowConf ? 'idle' : 'dead';

  const head = `<div class="ctx-util-head"><span>Tool utilization</span>` +
    `<span class="ctx-util-stat">${loaded} loaded · ${usedDistinct} used` +
    (deadweight > 0 ? ` · <b>~${fmtTokens(deadweight)} ${deadWord}</b>` : '') + `</span></div>`;

  // No tool-loading turn has actually run yet — nothing to judge.
  if (turns === 0) {
    return `<div class="ctx-util">${head}` +
      `<div class="ctx-util-conf">No evaluable turns yet — run the session to see usage.</div></div>`;
  }
  const conf = lowConf
    ? `<div class="ctx-util-conf">Only ${turns} turn${turns === 1 ? '' : 's'} evaluated — unused ≠ dead yet.</div>`
    : `<div class="ctx-util-conf">Over ${turns} turns.</div>`;

  // per_tool arrives deadweight-first (used==0, then highest est_tokens); keep
  // wirescope's order and just split the two groups.
  const unused = t.per_tool.filter((pt) => (pt.used || 0) === 0);
  const used = t.per_tool.filter((pt) => (pt.used || 0) > 0);

  let body = '';
  if (unused.length) {
    body += `<div class="ctx-util-group">Unused${lowConf ? '' : ' — trim to save'}` +
      (!lowConf && deadweight > 0 ? ` ~${fmtTokens(deadweight)}` : '') + `</div>`;
    body += unused.slice(0, UTIL_UNUSED_CAP).map((pt) =>
      `<div class="ctx-row ctx-dead"><div class="ctx-row-top">` +
      `<span class="ctx-cat">${esc(pt.name)}</span>` +
      `<span class="ctx-nums">~${fmtTokens(pt.est_tokens || 0)}</span></div></div>`).join('');
    if (unused.length > UTIL_UNUSED_CAP) {
      body += `<div class="ctx-util-more">+${unused.length - UTIL_UNUSED_CAP} more unused</div>`;
    }
  }
  if (used.length) {
    body += `<div class="ctx-util-group">Used</div>`;
    body += used.map((pt) =>
      `<div class="ctx-row"><div class="ctx-row-top">` +
      `<span class="ctx-cat">${esc(pt.name)}</span>` +
      `<span class="ctx-nums">~${fmtTokens(pt.est_tokens || 0)} · ${pt.used}×</span></div></div>`).join('');
  }
  return `<div class="ctx-util">${head}${conf}${body}</div>`;
}

async function openContextPopover(name, anchor) {
  ctxPopoverName.textContent = name;
  ctxPopover.dataset.name = name;
  ctxPopoverBody.innerHTML = '<div class="ctx-note">Loading…</div>';
  ctxPopover.classList.remove('hidden');
  placeCtxPopover(anchor);
  // Opt into the (heavier) utilization capture-scan only when the proxy
  // advertises it — otherwise this is byte-identical to the composition fetch.
  const wantUtil = !!(proxyState.get(name)?.payload?.capabilities?.context_utilization);
  const res = await window.api.getProxyContext(name, { utilization: wantUtil });
  // Bail if the popover was closed or retargeted while the fetch was in flight.
  if (ctxPopover.dataset.name !== name || ctxPopover.classList.contains('hidden')) return;
  if (!res || !res.ok) {
    ctxPopoverBody.innerHTML = `<div class="ctx-note">${esc(res && res.error ? res.error : 'Unavailable')}</div>`;
    placeCtxPopover(anchor); return;
  }
  const agents = (res.data && Array.isArray(res.data.agents)) ? res.data.agents : [];
  if (!agents.length) {
    const note = (res.data && res.data.note) || 'No live context for this session.';
    ctxPopoverBody.innerHTML = `<div class="ctx-note">${esc(note)}</div>`;
    placeCtxPopover(anchor); return;
  }
  const withComp = agents.filter((a) => a.composition && Array.isArray(a.composition.by_category));
  let html;
  if (withComp.length) {
    withComp.sort((a, b) => (a.line === 'main' ? -1 : b.line === 'main' ? 1 : 0));
    // Per agent: composition (what's loaded) then utilization (did it pay off).
    html = withComp.map((a) => renderCompositionLine(a) + renderUtilization(a)).join('');
  } else {
    // context_view-only proxy: no composition, but the tools roster is there.
    const main = agents.find((a) => a.line === 'main') || agents[0];
    const t = main && main.tools;
    if (t && Array.isArray(t.per_tool)) {
      const rows = t.per_tool.slice(0, 12).map((pt) =>
        `<div class="ctx-row"><div class="ctx-row-top"><span class="ctx-cat">${esc(pt.name)}</span>` +
        `<span class="ctx-nums">${fmtTokens(pt.est_tokens)}</span></div></div>`).join('');
      html = `<div class="ctx-line-head"><span>tools (${t.count})</span>` +
        `<span class="ctx-line-total">${fmtTokens(t.est_tokens)}</span></div>${rows}` +
        `<div class="ctx-note">Composition breakdown not available from this proxy build.</div>`;
    } else {
      html = '<div class="ctx-note">No breakdown available.</div>';
    }
  }
  // Cross-link to the tools manager for Claude sessions. When utilization data
  // is present, frame it as the trim lever: how many tools to drop and the
  // tokens it frees (the main agent's deadweight, only once it's conclusive).
  const mainAgent = agents.find((a) => a.line === 'main');
  const mainTools = mainAgent?.tools;
  if (mainTools && sessionTypeOf(name) === 'claude') {
    const mu = mainAgent.utilization;
    const conclusive = mu && (mu.evaluable_turns || 0) >= UTIL_MIN_TURNS;
    const unusedCount = mainTools.per_tool
      ? mainTools.per_tool.filter((pt) => (pt.used || 0) === 0).length : 0;
    const label = (conclusive && unusedCount > 0)
      ? `Trim ${unusedCount} unused tool${unusedCount === 1 ? '' : 's'}` +
        (mu.deadweight_tokens > 0 ? ` (~${fmtTokens(mu.deadweight_tokens)})` : '') + ' →'
      : `Manage tools (${mainTools.count}) →`;
    html += `<span class="ctx-tools-link" data-act="manage-tools">${label}</span>`;
  }
  ctxPopoverBody.innerHTML = html;
  placeCtxPopover(anchor);
}

ctxPopoverBody.addEventListener('click', (e) => {
  if (!e.target.closest('[data-act="manage-tools"]')) return;
  const name = ctxPopover.dataset.name;
  closeContextPopover();
  // Anchor the tools popover to the live ctx seg (still visible in the bar).
  const anchor = document.querySelector('#proxy-bar [data-act="ctx"]');
  if (name && anchor) openToolsPopover(name, anchor);
});

document.addEventListener('mousedown', (e) => {
  if (ctxPopover.classList.contains('hidden')) return;
  if (ctxPopover.contains(e.target)) return;
  if (e.target.closest('[data-act="ctx"]')) return; // toggle handled by the bar
  closeContextPopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !ctxPopover.classList.contains('hidden')) closeContextPopover();
});

window.api.onSessionMention((name, mtype /* 'dm'|'broadcast' */) => {
  const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (!el) return;
  el.classList.remove('mention-pulse');
  // Force reflow so re-adding the class restarts the animation
  void el.offsetWidth;
  el.classList.add('mention-pulse');
  setTimeout(() => el.classList.remove('mention-pulse'), 2000);
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
window.api.onRequestOpenAgentsDrawer(() => openAgentsDrawer());
window.api.onRequestOpenPromptsDrawer(() => openPromptsDrawer());
window.api.onRequestOpenIpcLog(() => {
  if (ipcLog.classList.contains('collapsed')) toggleIpcLog();
  broadcastInput.focus();
});

// ---------------------------------------------------------------------------
// Preferences dialog
// ---------------------------------------------------------------------------

const prefsOverlay = document.getElementById('prefs-overlay');
const prefsClaudeBox = document.getElementById('prefs-claude-components');
const prefsClaudeCmd = document.getElementById('prefs-claude-sl-cmd');
const prefsCodexBox = document.getElementById('prefs-codex-components');
const prefsProxyEnabled = document.getElementById('prefs-proxy-enabled');
const prefsProxyUrl = document.getElementById('prefs-proxy-url');
const prefsWsDir = document.getElementById('prefs-ws-dir');
const prefsWsPort = document.getElementById('prefs-ws-port');
const wsDot = document.getElementById('ws-dot');
const wsStatusText = document.getElementById('ws-status-text');
const wsToggleBtn = document.getElementById('btn-ws-toggle');
const CLAUDE_LABELS = {
  'model': 'Model name',
  'context': 'Context usage (estimated)',
  'cost': 'Session cost',
  'cwd': 'Working directory',
  'git-branch': 'Git branch',
};
const CODEX_LABELS = {
  'context-used': 'Context used (%)',
  'model-name': 'Model name',
  'project-root': 'Project root',
  'git-branch': 'Git branch',
  'five-hour-limit': '5-hour usage limit',
  'weekly-limit': 'Weekly usage limit',
  'current-dir': 'Current directory',
  'context-remaining': 'Context remaining (%)',
  'model-with-reasoning': 'Model + reasoning level',
};

function renderPrefsCheckboxes(container, all, enabled, labels) {
  container.innerHTML = '';
  const enabledSet = new Set(enabled);
  for (const key of all) {
    const row = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = key;
    cb.checked = enabledSet.has(key);
    const span = document.createElement('span');
    span.textContent = labels[key] || key;
    row.appendChild(cb);
    row.appendChild(span);
    container.appendChild(row);
  }
}

// wirescope status dot — colors + label per supervisor state.
const WS_DOT = { managed: '#3fb950', external: '#58a6ff', starting: '#d29922', stopped: '#888', error: '#f85149' };

function renderWsStatus(st) {
  const err = st && st.error;
  let color = WS_DOT[st ? st.state : 'stopped'] || '#888';
  let text;
  if (st && st.state === 'managed') {
    text = `Running (managed)${st.version ? ' — wirescope ' + st.version : ''}`;
  } else if (st && st.state === 'external') {
    text = `Adopted a wirescope already running on this port${st.version ? ' — ' + st.version : ''} · managed externally`;
  } else if (st && st.state === 'starting') {
    text = 'Starting…';
  } else {
    text = err ? err : 'Stopped';
    if (err) color = WS_DOT.error;
  }
  wsDot.style.background = color;
  wsStatusText.textContent = text;
  // The toggle only makes sense for a Clodex-managed lifecycle: Start when
  // nothing's running, Stop when it's ours. When a wirescope is already running
  // (adopted/external) neither applies, so hide the button rather than show a
  // dead greyed-out "Start". 'starting' keeps a disabled button for feedback.
  const state = st ? st.state : 'stopped';
  const managed = state === 'managed';
  const starting = state === 'starting';
  wsToggleBtn.style.display = state === 'external' ? 'none' : '';
  wsToggleBtn.textContent = managed ? 'Stop' : 'Start';
  wsToggleBtn.disabled = starting;
}

let wsPollTimer = null;
async function refreshWsStatus() {
  try { renderWsStatus(await window.api.wirescopeStatus()); } catch {}
}

async function openPrefs() {
  const s = await window.api.getSettings();
  renderPrefsCheckboxes(prefsClaudeBox, s.claudeComponents, s.statusline.claude, CLAUDE_LABELS);
  prefsClaudeCmd.value = s.statusline.claudeCommand || '';
  renderPrefsCheckboxes(prefsCodexBox, s.codexComponents, s.statusline.codex, CODEX_LABELS);
  prefsProxyEnabled.checked = !!s.proxyEnabled;
  prefsProxyUrl.value = s.proxyUrl || 'http://127.0.0.1:7800';
  prefsWsDir.value = s.wirescopeDir || '';
  prefsWsPort.value = s.wirescopePort || 7800;
  prefsOverlay.classList.remove('hidden');
  refreshWsStatus();
  if (wsPollTimer) clearInterval(wsPollTimer);
  wsPollTimer = setInterval(refreshWsStatus, 1500);
}

function closePrefs() {
  prefsOverlay.classList.add('hidden');
  if (wsPollTimer) { clearInterval(wsPollTimer); wsPollTimer = null; }
}

// Persist the live wirescope dir/port so the supervisor (which reads settings)
// acts on what's in the fields right now.
async function saveWsFields() {
  const port = parseInt(prefsWsPort.value, 10);
  await window.api.setSettings({
    wirescopeDir: prefsWsDir.value.trim(),
    wirescopePort: Number.isInteger(port) && port > 0 ? port : 7800,
  });
}

document.getElementById('btn-ws-browse').addEventListener('click', async () => {
  const dir = await window.api.selectDirectory();
  if (dir) { prefsWsDir.value = dir; await saveWsFields(); refreshWsStatus(); }
});

// The supervisor probes the SAVED port/dir, so persist edits live — otherwise
// changing the port to a free one wouldn't flip "adopted" back to a startable
// "stopped". (These two operational fields intentionally save on edit, not just
// on the Save button.)
for (const el of [prefsWsDir, prefsWsPort]) {
  el.addEventListener('change', async () => { await saveWsFields(); refreshWsStatus(); });
}

wsToggleBtn.addEventListener('click', async () => {
  const st = await window.api.wirescopeStatus();
  if (st && st.state === 'managed') {
    await window.api.wirescopeStop();
  } else {
    await saveWsFields();
    await window.api.wirescopeStart();
  }
  refreshWsStatus();
});

document.getElementById('ws-repo-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://github.com/avirtual/wirescope');
});

function collectChecked(container) {
  return [...container.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value);
}

document.getElementById('btn-prefs-cancel').addEventListener('click', closePrefs);
document.getElementById('btn-prefs-save').addEventListener('click', async () => {
  await window.api.setSettings({
    statusline: {
      claude: collectChecked(prefsClaudeBox),
      claudeCommand: prefsClaudeCmd.value.trim(),
      codex: collectChecked(prefsCodexBox),
    },
    proxyEnabled: prefsProxyEnabled.checked,
    proxyUrl: prefsProxyUrl.value.trim() || 'http://127.0.0.1:7800',
    wirescopeDir: prefsWsDir.value.trim(),
    wirescopePort: (() => { const p = parseInt(prefsWsPort.value, 10); return Number.isInteger(p) && p > 0 ? p : 7800; })(),
  });
  closePrefs();
});

window.api.onRequestOpenPreferences(() => openPrefs());

// ---------------------------------------------------------------------------
// Edit Session Args
// ---------------------------------------------------------------------------

const argsOverlay = document.getElementById('args-overlay');
const argsInput = document.getElementById('args-input');
const argsTarget = document.getElementById('args-target');
const argsRestart = document.getElementById('args-restart');
const argsProxyRow = document.getElementById('args-proxy-row');
const argsProxyMode = document.getElementById('args-proxy-mode');
const argsProxyUrl = document.getElementById('args-proxy-url');
const argsPromptRow = document.getElementById('args-prompt-row');
const argsPromptSelect = document.getElementById('args-prompt-select');
const argsPromptBody = document.getElementById('args-prompt-body');
const argsAgentsRow = document.getElementById('args-agents-row');
const argsAgentsList = document.getElementById('args-agents-list');
const argsDenyBuiltins = document.getElementById('args-deny-builtins');
const argsToolsRow = document.getElementById('args-tools-row');
const argsToolsList = document.getElementById('args-tools-list');
let argsEditingName = null;

argsProxyMode.addEventListener('change', () => {
  argsProxyUrl.style.display = argsProxyMode.value === 'custom' ? '' : 'none';
  if (argsProxyMode.value === 'custom') argsProxyUrl.focus();
});

// Picking a library prompt fills the textarea; the textarea is what gets
// saved, so library edits stay local to this session.
argsPromptSelect.addEventListener('change', () => {
  const opt = argsPromptSelect.selectedOptions[0];
  if (opt && opt.dataset.body !== undefined) argsPromptBody.value = opt.dataset.body;
  argsPromptSelect.value = '';
});

async function openArgsDialog(name) {
  const [res, settings, promptLib, agentLib] = await Promise.all([
    window.api.getSessionArgs(name),
    window.api.getSettings(),
    window.api.listPrompts(),
    window.api.listAgents(),
  ]);
  if (!res || !res.ok) { alert('Session not found in persistence.'); return; }
  agentLibCache = agentLib || [];
  argsEditingName = name;
  argsTarget.textContent = `${name} (${res.type}) — new settings apply on next spawn.`;
  argsInput.value = (res.extraArgs || []).map(a => /\s/.test(a) ? `"${a}"` : a).join(' ');
  const isAgent = res.type === 'claude' || res.type === 'codex';
  argsProxyRow.style.display = isAgent ? '' : 'none';
  setProxyControls(argsProxyMode, argsProxyUrl, res.proxy, settings?.proxyUrl);
  labelProxyDefault(argsProxyMode, settings);
  argsPromptRow.style.display = isAgent ? '' : 'none';
  argsPromptBody.value = res.systemPrompt || '';
  while (argsPromptSelect.options.length > 1) argsPromptSelect.remove(1);
  for (const p of promptLib || []) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.title;
    opt.dataset.body = p.body;
    argsPromptSelect.appendChild(opt);
  }
  // Custom subagents — Claude-only.
  const isClaude = res.type === 'claude';
  argsAgentsRow.style.display = isClaude ? '' : 'none';
  renderAgentChecklist(argsAgentsList, new Set(res.agents || []));
  argsDenyBuiltins.checked = (res.denyBuiltins || []).includes('general-purpose');
  argsToolsRow.style.display = isClaude ? '' : 'none';
  claudeToolsCache = settings?.claudeTools || [];
  renderToolChecklist(argsToolsList, new Set(res.disabledTools || []));
  argsRestart.checked = false;
  argsOverlay.classList.remove('hidden');
  setTimeout(() => argsInput.focus(), 50);
}

function closeArgsDialog() {
  argsOverlay.classList.add('hidden');
  argsEditingName = null;
}

document.getElementById('btn-args-cancel').addEventListener('click', closeArgsDialog);
document.getElementById('btn-args-save').addEventListener('click', async () => {
  if (!argsEditingName) return closeArgsDialog();
  const parsed = parseArgs(argsInput.value || '');
  const restart = argsRestart.checked;
  const proxy = argsProxyRow.style.display === 'none'
    ? null : proxyValueFromControls(argsProxyMode, argsProxyUrl);
  const systemPrompt = argsPromptRow.style.display === 'none'
    ? null : (argsPromptBody.value.trim() || null);
  const agents = argsAgentsRow.style.display === 'none' ? [] : collectAgentChecklist(argsAgentsList);
  const denyBuiltins = (argsAgentsRow.style.display !== 'none' && argsDenyBuiltins.checked)
    ? ['general-purpose'] : [];
  const disabledTools = argsToolsRow.style.display === 'none' ? [] : collectToolChecklist(argsToolsList);
  const name = argsEditingName;
  // Snapshot metadata from the current sidebar entry so we can re-render it
  // after the kill+respawn wipes it via session-exit.
  const existing = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  const snapType = existing ? existing.querySelector('.session-type')?.textContent : null;
  const snapCwd = existing ? existing.dataset.cwd : null;
  closeArgsDialog();
  const res = await window.api.setSessionArgs(name, parsed, restart, proxy, systemPrompt, agents, denyBuiltins, disabledTools);
  if (!res || !res.ok) {
    alert(`Failed: ${res && res.error ? res.error : 'unknown error'}`);
    return;
  }
  if (res.restarted && snapType) {
    createTerminal(name);
    addSessionToSidebar(name, snapType, snapCwd, null);
    switchSession(name);
  }
});

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
// Agents library — custom subagents stored as ~/.clodex/agents/*.md
// ---------------------------------------------------------------------------

const agentsDrawer = document.getElementById('agents-drawer');
const agentsListEl = document.getElementById('agents-list');
const agentsEmpty = document.getElementById('agents-empty');
const agentEditor = document.getElementById('agent-editor');
const agentEditorTitle = document.getElementById('agent-editor-title');
const agentNameInput = document.getElementById('agent-name');
const agentContent = document.getElementById('agent-content');
const agentSave = document.getElementById('agent-save');
const agentCancel = document.getElementById('agent-cancel');
const agentDelete = document.getElementById('agent-delete');
const agentsNew = document.getElementById('agents-new');
const agentsClose = document.getElementById('agents-close');

let editingAgentName = null;

async function refreshAgentsList() {
  const items = await window.api.listAgents();
  agentLibCache = items || [];
  agentsListEl.innerHTML = '';
  if (!items || items.length === 0) {
    agentsEmpty.style.display = '';
    return;
  }
  agentsEmpty.style.display = 'none';
  for (const a of items) {
    const meta = [a.model && `model: ${a.model}`, a.tools && `tools: ${a.tools}`].filter(Boolean).join(' · ');
    const preview = a.description || meta || '(no description)';
    const el = document.createElement('div');
    el.className = 'prompt-item';
    el.innerHTML = `
      <div class="prompt-item-title">${esc(a.name)}</div>
      <div class="prompt-item-preview">${esc(preview)}</div>
      <div class="prompt-item-actions">
        <button data-action="edit">Edit</button>
      </div>
    `;
    el.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
      e.stopPropagation();
      openAgentEditor(a);
    });
    el.addEventListener('click', () => openAgentEditor(a));
    agentsListEl.appendChild(el);
  }
}

function openAgentsDrawer() {
  agentsDrawer.classList.remove('hidden');
  refreshAgentsList();
}
function closeAgentsDrawer() {
  agentsDrawer.classList.add('hidden');
}

async function openAgentEditor(agent = null) {
  if (agent) {
    editingAgentName = agent.name;
    agentEditorTitle.textContent = 'Edit Agent';
    agentNameInput.value = agent.name;
    agentContent.value = (await window.api.getAgent(agent.name)) || '';
    agentDelete.style.display = '';
  } else {
    editingAgentName = null;
    agentEditorTitle.textContent = 'New Agent';
    agentNameInput.value = '';
    agentContent.value = '---\ndescription: Fast read-only repo search.\ntools: Read, Grep, Glob\nmodel: haiku\n---\nYou are a focused explorer. Return conclusions, not file dumps.';
    agentDelete.style.display = 'none';
  }
  agentNameInput.style.borderColor = '';
  agentEditor.classList.remove('hidden');
  setTimeout(() => agentNameInput.focus(), 50);
}
function closeAgentEditor() {
  agentEditor.classList.add('hidden');
  editingAgentName = null;
}

agentsClose.addEventListener('click', closeAgentsDrawer);
agentsNew.addEventListener('click', () => openAgentEditor(null));

agentSave.addEventListener('click', async () => {
  const name = agentNameInput.value.trim();
  const content = agentContent.value;
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
    agentNameInput.style.borderColor = '#e94560';
    return;
  }
  const res = await window.api.saveAgent(name, content);
  if (!res || !res.ok) {
    alert(`Failed: ${res && res.error ? res.error : 'unknown error'}`);
    return;
  }
  // Rename: a changed Name field writes a new file — drop the old one.
  if (editingAgentName && editingAgentName !== name) {
    await window.api.removeAgent(editingAgentName);
  }
  closeAgentEditor();
  refreshAgentsList();
});

agentCancel.addEventListener('click', closeAgentEditor);
agentDelete.addEventListener('click', async () => {
  if (!editingAgentName) return;
  if (!confirm(`Delete agent "${editingAgentName}"?`)) return;
  await window.api.removeAgent(editingAgentName);
  closeAgentEditor();
  refreshAgentsList();
});

// Keep keyboard shortcuts from firing inside the editor fields
agentNameInput.addEventListener('keydown', (e) => e.stopPropagation());
agentContent.addEventListener('keydown', (e) => e.stopPropagation());
agentNameInput.addEventListener('input', () => { agentNameInput.style.borderColor = ''; });

// ---------------------------------------------------------------------------
// Restore sessions on startup
// ---------------------------------------------------------------------------

(async function restoreSessions() {
  const restored = await window.api.restoreSessions();
  if (!restored || restored.length === 0) return;

  let firstHealthy = null;
  for (const entry of restored) {
    if (entry.failed) {
      // Render as a ghost entry — no xterm, but visible in the sidebar so
      // the user can either retry it or forget it.
      addFailedSessionToSidebar(entry);
      continue;
    }
    const { terminal } = createTerminal(entry.name);
    addSessionToSidebar(entry.name, entry.type, entry.cwd, entry.label);
    if (entry.replay) terminal.write(entry.replay);
    if (typeof entry.ctx === 'number') { ctxPct.set(entry.name, entry.ctx); applyCtxBadge(entry.name, entry.ctx); }
    if (typeof entry.ctxTok === 'number' && typeof entry.ctxSize === 'number' && entry.ctxSize > 0) {
      ctxTokens.set(entry.name, { used: entry.ctxTok, size: entry.ctxSize });
    }
    if (entry.proxy) { proxyState.set(entry.name, { payload: entry.proxy, at: Date.now() }); applyWarmBadge(entry.name); }
    if (!firstHealthy) firstHealthy = entry.name;
  }
  if (firstHealthy) switchSession(firstHealthy);
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
