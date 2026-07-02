const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SearchAddon } = require('@xterm/addon-search');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const sessions = new Map(); // name -> { terminal, fitAddon, wrapperEl }
let activeSession = null;

// ---------------------------------------------------------------------------
// Themes — chrome retints via CSS [data-theme]; each theme also carries an
// xterm color object (incl. the 16-color ANSI palette) since the terminal's
// palette lives in JS, not CSS. 'midnight' is the default (matches :root).
// ---------------------------------------------------------------------------
const THEMES = {
  midnight: {
    label: 'Midnight (default)',
    xterm: {
      background: '#1a1a2e', foreground: '#eee', cursor: '#e94560',
      selectionBackground: '#3a4a6a',
      black: '#1a1a2e', red: '#e94560', green: '#4ade80', yellow: '#fbbf24',
      blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#eee',
      brightBlack: '#6b7689', brightRed: '#ff6b81', brightGreen: '#86efac',
      brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9', brightWhite: '#fff',
    },
  },
  claude: {
    label: 'Claude (warm dark)',
    xterm: {
      background: '#262624', foreground: '#f5f4ef', cursor: '#d97757',
      selectionBackground: '#4a4641',
      black: '#3a3733', red: '#e0816b', green: '#a3b18a', yellow: '#d9a55b',
      blue: '#7da3c4', magenta: '#b08cba', cyan: '#6fb3b8', white: '#f5f4ef',
      brightBlack: '#9b9690', brightRed: '#eb9a85', brightGreen: '#bcc7a6',
      brightYellow: '#e6bd7c', brightBlue: '#9bbcd6', brightMagenta: '#c6a7ce',
      brightCyan: '#8ec9cd', brightWhite: '#fffefb',
    },
  },
  light: {
    label: 'Light',
    xterm: {
      background: '#faf9f5', foreground: '#1f1e1d', cursor: '#c15f3c',
      selectionBackground: '#d8e2ec',
      black: '#1f1e1d', red: '#c1442e', green: '#4f7a3a', yellow: '#9a6b1e',
      blue: '#2b6cb0', magenta: '#8a4f9e', cyan: '#2d8a8f', white: '#5c5852',
      brightBlack: '#6b6862', brightRed: '#a8351f', brightGreen: '#3f6630',
      brightYellow: '#855a14', brightBlue: '#225a96', brightMagenta: '#763f88',
      brightCyan: '#247479', brightWhite: '#1f1e1d',
    },
  },
};
const THEME_DEFAULT = 'midnight';
function themeName() {
  const t = localStorage.getItem('clodex-theme');
  return THEMES[t] ? t : THEME_DEFAULT;
}
function currentXtermTheme() { return THEMES[themeName()].xterm; }
// Apply a theme: retint chrome (data-theme), persist, and live-swap every
// open terminal's palette. Midnight clears the attr so :root wins.
function applyTheme(name) {
  if (!THEMES[name]) name = THEME_DEFAULT;
  localStorage.setItem('clodex-theme', name);
  if (name === THEME_DEFAULT) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = name;
  for (const s of sessions.values()) {
    if (s.terminal) s.terminal.options.theme = THEMES[name].xterm;
  }
  const sel = document.getElementById('prefs-theme');
  if (sel && sel.value !== name) sel.value = name; // keep the picker in sync
}
// Set the chrome attr before first paint (terminals read currentXtermTheme()
// at creation, so they're correct without a re-swap).
(function initTheme() {
  const n = themeName();
  if (n !== THEME_DEFAULT) document.documentElement.dataset.theme = n;
})();
// Populate the Preferences theme picker once; apply live on change.
(function setupThemePicker() {
  const sel = document.getElementById('prefs-theme');
  if (!sel) return;
  sel.innerHTML = Object.entries(THEMES)
    .map(([k, t]) => `<option value="${k}">${t.label}</option>`).join('');
  sel.value = themeName();
  sel.addEventListener('change', () => { applyTheme(sel.value); window.api.setTheme(sel.value); });
})();
// Apply theme changes pushed from the View menu / other windows, and report
// our persisted theme up to main so the menu radio + canonical settings match
// the value we applied pre-paint (covers first run on this machine).
window.api.onSetTheme((name) => applyTheme(name));
try { window.api.setTheme(themeName()); } catch {}

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
const appendPromptsRow = document.getElementById('append-prompts-row');
const inputAppendList = document.getElementById('input-append-list');
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
        <span class="session-badges">
          <span class="session-warm" title="Prompt-cache warmth (time to expiry)"></span>
          <span class="session-ctx" title="Context used"></span>
        </span>
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
// Restart a session and re-create its sidebar tab + terminal. Snapshots sidebar
// metadata first because the kill+respawn wipes the tab via session-exit (same
// dance as the Edit Session save path).
function restartSessionWithReattach(name) {
  const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  const snapType = item ? item.querySelector('.session-type')?.textContent : null;
  const snapCwd = item ? item.dataset.cwd : null;
  return window.api.restartSession(name).then((res) => {
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
}

window.api.onSessionContextAction(({ action, name, type, cwd }) => {
  switch (action) {
    case 'editArgs':
      openArgsDialog(name);
      break;
    case 'restart':
      restartSessionWithReattach(name);
      break;
    case 'reattach':
      // Main-process-driven respawn ([agent:context reload]) already killed +
      // recreated the session; the kill removed our sidebar tab + terminal via
      // session-exit, so rebuild them. Mirrors restartSessionWithReattach's
      // success branch, but main owns the respawn (type/cwd come in the signal).
      if (type) {
        createTerminal(name);
        addSessionToSidebar(name, type, cwd, null);
        switchSession(name);
      }
      break;
    case 'promptsChanged':
      // The quick-picker persisted new prompt refs; they only take effect on a
      // (re)start, so offer one now. Declining leaves them to apply next spawn.
      if (confirm(`Prompt changed for "${name}". Restart now to apply? (Otherwise it applies on the next start.)`)) {
        restartSessionWithReattach(name);
      }
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
  // Child subagent rows are siblings, not descendants — sweep them too.
  sessionList.querySelectorAll(`.session-child[data-parent="${CSS.escape(name)}"]`).forEach((c) => c.remove());
  if (subagentPopover && subagentPopover.dataset.name === name) closeSubagentPopover();
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
    theme: currentXtermTheme(),
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
  if (subagentPopover && !subagentPopover.classList.contains('hidden')) closeSubagentPopover();

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
  if (appendPromptsRow) appendPromptsRow.style.display = supportsSystemPrompt ? '' : 'none';
  if (!supportsSystemPrompt) inputSystemPrompt.value = '';
  // Custom subagents and per-session tool/skill/strip gating are Claude-only.
  // These live in collapsible accordion sections (Tools / Skills / Other) so the
  // dialog stays short by default; toggle the whole section per type.
  const claudeOnly = type === 'claude';
  for (const sec of [toolsSection, skillsSection, otherSection]) {
    if (sec) sec.style.display = claudeOnly ? '' : 'none';
  }
  if (claudeOnly) { refreshNewSessionSkills(); refreshNewSessionInjectSkills(); refreshNewSessionTools(); }
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

// Prompt library — shared by the new-session + edit dialogs. `system` prompts
// fill a <select> (one replaces the CLI default); `append` prompts fill a
// checklist (0+ compose, applied in filename order). Cached per dialog open.
let promptLibCache = { system: [], append: [] };

async function loadPromptLib() {
  const all = await window.api.listPrompts();
  promptLibCache = {
    system: all.filter(p => p.kind === 'system'),
    append: all.filter(p => p.kind === 'append'),
  };
}

function fillSystemPromptSelect(selectEl, current) {
  while (selectEl.options.length > 1) selectEl.remove(1);
  for (const p of promptLibCache.system) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    selectEl.appendChild(opt);
  }
  // A persisted ref whose file was deleted falls back to (CLI default).
  selectEl.value = current && promptLibCache.system.some(p => p.name === current) ? current : '';
}

function renderAppendChecklist(container, enabledSet) {
  container.innerHTML = '';
  if (!promptLibCache.append.length) {
    container.innerHTML = '<span class="hint-text">No append prompts in library — add some via the Prompts drawer.</span>';
    return;
  }
  for (const p of promptLibCache.append) {
    const row = document.createElement('label');
    row.className = 'agent-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = p.name;
    cb.checked = enabledSet.has(p.name);
    const preview = (p.body.split('\n')[0] || '').slice(0, 60);
    const txt = document.createElement('span');
    txt.innerHTML = `<strong>${esc(p.name)}</strong>${preview ? ' — ' + esc(preview) : ''}`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}
function collectAppendChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}

async function refreshSystemPromptDropdown() {
  await loadPromptLib();
  fillSystemPromptSelect(inputSystemPrompt, inputSystemPrompt.value);
  renderAppendChecklist(inputAppendList, new Set());
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
const inputBuiltinsList = document.getElementById('input-builtins-list');
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

// The built-in subagents the CLI injects into the roster (each costs its
// description line every turn). Denying one via permissions.deny Agent(name)
// filters it out of the injected listing — a real roster trim (traced through
// the listing builder; confirmed on the wire) AND stops delegation to it.
// Names are case-sensitive — exactly the agentType strings, verified present
// across live transcripts. Not every session injects all six (a session
// launched with --agents/append-prompt can drop claude-code-guide/statusline-
// setup), so denying an absent one is a harmless no-op.
const BUILTIN_AGENTS = ['Explore', 'Plan', 'general-purpose', 'claude', 'claude-code-guide', 'statusline-setup'];

// Checklist polarity matches tools/skills: checked = available, unchecked =
// denied. `deniedSet` is the persisted denyBuiltins list; collect returns the
// unchecked (denied) names.
function renderBuiltinChecklist(container, deniedSet) {
  container.innerHTML = '';
  for (const name of BUILTIN_AGENTS) {
    const row = document.createElement('label');
    row.className = 'agent-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = name;
    cb.checked = !deniedSet.has(name);
    const txt = document.createElement('span');
    txt.innerHTML = `<strong>${esc(name)}</strong>`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}
function collectBuiltinChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:not(:checked)')).map(cb => cb.value);
}

// Bulk check/uncheck for a popover checklist. Skips :disabled rows (e.g. skills
// locked by a lower settings layer) so "Check all" never tries to re-enable
// something clodex can't actually toggle. `wireBulkToggles` hooks the
// data-bulk="all"/"none" buttons sitting above `listEl` to it.
function setChecklistAll(listEl, checked) {
  listEl.querySelectorAll('input[type="checkbox"]:not(:disabled)').forEach(cb => { cb.checked = checked; });
}
function wireBulkToggles(popoverEl, listEl) {
  popoverEl.querySelectorAll('.popover-bulk [data-bulk]').forEach(btn => {
    btn.addEventListener('click', () => setChecklistAll(listEl, btn.dataset.bulk === 'all'));
  });
}

// --- Per-session tool gating (Claude only). The catalog is a curated static
// list supplied by main via getSettings().claudeTools. Checkboxes default to
// checked (= tool available); unchecking adds the tool to `disabledTools`,
// which becomes a permissions.deny entry at spawn. A stored disabled tool that
// isn't in the current catalog is still shown (unchecked) so editing a session
// never silently re-enables a tool the catalog dropped. ---
const toolsRow = document.getElementById('tools-row');
const inputToolsList = document.getElementById('input-tools-list');
const skillsRow = document.getElementById('skills-row');
const inputSkillsList = document.getElementById('input-skills-list');
// Bulk check/uncheck for the new-session dialog's catalog checklists (same
// control as the popovers). wireBulkToggles is defined just above.
wireBulkToggles(toolsRow, inputToolsList);
wireBulkToggles(skillsRow, inputSkillsList);
const injectSkillsRow = document.getElementById('inject-skills-row');
const inputInjectSkillsList = document.getElementById('input-inject-skills-list');
const stripRow = document.getElementById('strip-row');
const inputStripLevel = document.getElementById('input-strip-level');
// Collapsible accordion sections grouping the Claude-only advanced controls, so
// the new-session dialog stays short by default (expand the one you need).
const toolsSection = document.getElementById('tools-section');
const skillsSection = document.getElementById('skills-section');
const otherSection = document.getElementById('other-section');

// Custom-skill injection checklist (opt-in: unchecked by default). Mirrors the
// subagent checklist — checked names are scaffolded into a --plugin-dir at
// spawn. The library is authored in the Skill Library drawer.
let skillLibCache = [];
function renderInjectChecklist(container, enabledSet) {
  container.innerHTML = '';
  if (!skillLibCache.length) {
    container.innerHTML = '<span class="hint-text">No skills in library — add some via the 🧩 Skill Library (Skills menu).</span>';
    return;
  }
  for (const s of skillLibCache) {
    const row = document.createElement('label');
    row.className = 'agent-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = s.name;
    cb.checked = enabledSet.has(s.name);
    const txt = document.createElement('span');
    txt.innerHTML = `<strong>${esc(s.name)}</strong>${s.description ? ' — ' + esc(s.description) : ''}`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}
function collectInjectChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}
async function refreshNewSessionInjectSkills(enabledSet = new Set()) {
  if (inputType.value !== 'claude') return;
  skillLibCache = (await window.api.listSkillLib()) || [];
  renderInjectChecklist(inputInjectSkillsList, enabledSet);
}

// Populate the new-session Skills checklist for the currently-entered cwd. The
// catalog (known built-ins + whatever a lower settings layer for that cwd
// disables) and provenance both depend on cwd, so this re-runs when cwd changes.
async function refreshNewSessionSkills() {
  if (inputType.value !== 'claude') return;
  const cwd = expandPath(inputCwd.value.trim()) || homeDir;
  const res = await window.api.getSkillCatalogFor(cwd);
  if (!res || !res.ok) { renderSkillChecklist(inputSkillsList, [], new Set()); return; }
  renderSkillChecklist(inputSkillsList, res.names || [], new Set(),
    res.effective || {}, { skillsLocked: res.skillsLocked, canReenable: res.canReenable });
}
// Tool provenance for the new-session dialog — same cwd-dependence as skills: a
// lower settings layer for the chosen cwd may already deny tools, shown
// read-only here. claudeToolsCache is seeded from getSettings in openDialog.
async function refreshNewSessionTools() {
  if (inputType.value !== 'claude') return;
  const cwd = expandPath(inputCwd.value.trim()) || homeDir;
  const res = await window.api.getToolCatalogFor(cwd);
  // Pre-uncheck the global default deny set so a fresh session inherits the
  // shared, lean tools loadout out of the box (still editable here per session).
  renderToolChecklist(inputToolsList, new Set(defaultToolDenyCache), (res && res.ok && res.effective) || {});
}
let claudeToolsCache = [];
// Global default tool-deny set (the "*" agent-default), seeded from getSettings
// in openDialog; new sessions start with these tools unchecked.
let defaultToolDenyCache = [];

// Mirror of renderSkillChecklist for tools. `disabledSet` is clodex's own
// layer-4 off list; `effective` (tool -> {value:'off', source, locked}) is the
// lower-layer permissions.deny state. A tool denied in a layer clodex doesn't
// own renders unchecked + read-only + labeled with provenance — and because
// permissions.deny is union (no allow overrides a deny), it is ALWAYS read-only
// here, never re-enableable from clodex's settings (unlike skills' canReenable).
function renderToolChecklist(container, disabledSet, effective) {
  effective = effective || {};
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
    const eff = effective[name];
    const lowerOff = !!(eff && eff.value === 'off');
    const clodexOff = disabledSet.has(name);
    const row = document.createElement('label');
    row.className = 'agent-check' + (lowerOff ? ' skill-readonly' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = name;
    cb.checked = !clodexOff && !lowerOff;
    if (lowerOff) cb.disabled = true; // external deny is unrevokable from here
    const txt = document.createElement('span');
    let note = '';
    if (lowerOff) note = eff.locked
      ? ' <span class="skill-src">denied by policy</span>'
      : ` <span class="skill-src">off via ${esc(eff.source)} settings</span>`;
    txt.innerHTML = `<strong>${esc(name)}</strong>${note}`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}
// Returns the UNCHECKED, toggleable tools (clodex's off list). A read-only row
// is owned by a lower settings layer / policy, not clodex, so it's excluded.
function collectToolChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:not(:checked):not(:disabled)')).map(cb => cb.value);
}

// Skills mirror tools. The catalog combines a static seed (CLAUDE_SKILLS), the
// live transcript roster, clodex's own off list, and any skill a LOWER settings
// layer mentions. A skill that's off in a lower layer (global/project/local
// settings) or locked by managed policy is rendered unchecked + disabled +
// labeled with provenance: clodex can't change it from its layer-4 file (a
// lower-layer off can only be re-enabled if SKILL_REENABLE_CONFIRMED, a managed
// lock never), so we show it honestly rather than as a silently-inert toggle.
function renderSkillChecklist(container, names, disabledSet, effective, opts) {
  effective = effective || {};
  opts = opts || {};
  const canReenable = !!opts.canReenable;
  const skillsLocked = !!opts.skillsLocked;
  container.innerHTML = '';
  if (!names || !names.length) {
    container.innerHTML = '<span class="hint-text">No skills detected yet — they appear once the session has run a turn.</span>';
    return;
  }
  for (const name of names) {
    const eff = effective[name];
    const lowerOff = !!(eff && eff.value === 'off');
    const clodexOff = disabledSet.has(name);
    // Read-only when clodex's layer-4 write can't actually change it: a lower-
    // layer off we can't re-enable yet, or a managed-policy lock.
    const readonly = skillsLocked || (lowerOff && !canReenable);
    const row = document.createElement('label');
    row.className = 'agent-check' + (readonly ? ' skill-readonly' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = name;
    cb.checked = !clodexOff && !lowerOff;
    if (readonly) cb.disabled = true;
    const txt = document.createElement('span');
    let note = '';
    if (skillsLocked) note = ' <span class="skill-src">locked by policy</span>';
    else if (lowerOff) note = ` <span class="skill-src">off via ${esc(eff.source)} settings</span>`;
    txt.innerHTML = `<strong>${esc(name)}</strong>${note}`;
    row.appendChild(cb);
    row.appendChild(txt);
    container.appendChild(row);
  }
}
// Only collect toggleable rows: a disabled (read-only) checkbox is owned by a
// lower layer / policy, not by clodex, so it never enters clodex's off list.
function collectSkillChecklist(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:not(:checked):not(:disabled)')).map(cb => cb.value);
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
  if (inputStripLevel) inputStripLevel.value = '0'; // default off each open
  // Collapse the advanced accordions each open so the dialog starts short.
  for (const sec of [toolsSection, skillsSection, otherSection]) {
    if (sec) sec.open = false;
  }
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
  renderBuiltinChecklist(inputBuiltinsList, new Set());
  claudeToolsCache = settings?.claudeTools || [];
  defaultToolDenyCache = settings?.defaultToolDeny || [];
  renderToolChecklist(inputToolsList, new Set(defaultToolDenyCache));
  refreshNewSessionTools();
  setProxyControls(inputProxyMode, inputProxyUrl, null, settings?.proxyUrl);
  labelProxyDefault(inputProxyMode, settings);
  dialogOverlay.classList.remove('hidden');
  setTimeout(() => inputName.select(), 50);
}

inputType.addEventListener('change', applyTypeDefaults);
// cwd drives the skill catalog's provenance (which lower-layer settings apply),
// so re-fetch when it changes.
inputCwd.addEventListener('change', refreshNewSessionSkills);
inputCwd.addEventListener('change', refreshNewSessionTools);

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

  // Prompts are referenced by library file now (system replaces, appends
  // compose); the legacy inline body is no longer authored at create.
  const supportsPrompts = type === 'claude' || type === 'codex';
  const systemPromptBody = null;
  const systemPromptFile = supportsPrompts ? (inputSystemPrompt.value || null) : null;
  const appendPromptFiles = supportsPrompts ? collectAppendChecklist(inputAppendList) : [];

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
  const denyBuiltins = type === 'claude' ? collectBuiltinChecklist(inputBuiltinsList) : [];
  const disabledTools = type === 'claude' ? collectToolChecklist(inputToolsList) : [];
  const disabledSkills = type === 'claude' ? collectSkillChecklist(inputSkillsList) : [];
  const injectSkills = type === 'claude' ? collectInjectChecklist(inputInjectSkillsList) : [];
  const stripLevel = type === 'claude' ? (Number(inputStripLevel && inputStripLevel.value) || 0) : 0;

  closeDialog();

  if (typeof proxy === 'string') window.api.setSettings({ proxyUrl: proxy }); // remember last used
  const result = await window.api.createSession(name, type, cwd, extraArgs, systemPromptBody, resumeId, fork, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, stripLevel, systemPromptFile, appendPromptFiles);
  if (!result.ok) {
    console.error('Failed to create session:', result.error);
    alert(`Failed to create session: ${result.error || 'unknown error'}`);
    refreshDiagBanner(); // a posix_spawnp failure usually means a broken install
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
  if (dir) { inputCwd.value = dir; refreshNewSessionSkills(); refreshNewSessionTools(); }
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
    btns.push('<button class="px-action" data-act="skills" title="Enable/disable skills for this session">🧩 skills</button>');
    // Always shown for Claude: the popover composes the custom-subagent library
    // AND toggles the built-in agents (denying Explore/Plan/general-purpose
    // trims them from the roster), so it's useful even with an empty library.
    btns.push('<button class="px-action" data-act="agents" title="Enable/disable custom + built-in subagents for this session">🤖 agents</button>');
  }
  if (type === 'claude' || type === 'codex') {
    btns.push('<button class="px-action" data-act="history" title="Past conversations — resume an earlier session">🕘 history</button>');
    btns.push('<button class="px-action" data-act="reload" title="Hard restart: reload tools/skills/settings from disk in a fresh conversation (the CLI only reads them at launch — /clear and --resume don\'t). The current conversation stays in 🕘 history.">🔄 reload</button>');
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
    // Keep the action controls present (disabled) instead of yanking them on
    // every link blip — the persisted strip level + advertised caps still ride
    // this payload, so the buttons show their saved state and re-enable on relink.
    renderSessionActions(buildProxyExtras(p));
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
      segs.push(`<span class="px-seg${heavy}${ctxCls}"${ctxAttr} title="${ctxTip || 'Context: tokens used / window size'}">🧠 ${fmtTokens(usedTok)}/${fmtTokens(sizeTok)} (${p2}%)</span>`);
    } else {
      segs.push(`<span class="px-seg${heavy}${ctxCls}"${ctxAttr} title="${ctxTip || 'Context tokens used'}">🧠 ${fmtTokens(usedTok)}</span>`);
    }
  } else if (typeof pct === 'number' && pct > 0) {
    segs.push(`<span class="px-seg${ctxCls}"${ctxAttr} title="${ctxTip || 'Context window used'}">🧠 ${pct}%</span>`);
  } else if (p.context && p.context.messages != null) {
    segs.push(`<span class="px-seg${ctxCls}"${ctxAttr} title="${ctxTip || 'Messages in context'}">🧠 ${p.context.messages} msg</span>`);
  }
  if (p.turns != null) segs.push(`<span class="px-seg">turn ${p.turns}</span>`);
  // API roundtrips — the truer "how busy" gauge than turns (one prompt fans out
  // into many tool-loop roundtrips; ~8× is typical). From wirescope's
  // session_totals.requests, already shaped onto cost.requests. Aggregate incl.
  // count_tokens probes — fine for an activity gauge.
  if (p.cost && p.cost.requests != null) {
    segs.push(`<span class="px-seg" title="API roundtrips this session (tool-loop calls, not just your prompts)">req ${p.cost.requests}</span>`);
  }
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
    // When wirescope advertises the cost-over-time timeline, the cost number
    // opens a native breakdown popover (read-carriage vs output, cumulative),
    // which itself links out to the full /_timeline dashboard. Stays plain text
    // otherwise, so a pre-deploy/standalone session just shows the estimate.
    const timeline = !!(p.capabilities && p.capabilities.context_timeline && p.base && p.sessionId);
    if (timeline) {
      segs.push(`<span class="px-seg px-cost px-ctx-btn" data-act="cost" title="Cost over time — click for the breakdown">~$${costTxt}</span>`);
    } else {
      segs.push(`<span class="px-seg px-cost" title="wirescope cost estimate">~$${costTxt}</span>`);
    }
  }
  if (p.refusals > 0) segs.push(`<span class="px-seg px-refusal">⚠ ${p.refusals}</span>`);
  if (p.base && p.sessionId) {
    const url = `${p.base}/_session?session=${encodeURIComponent(p.sessionId)}`;
    segs.push(`<a class="px-seg px-link" data-url="${esc(url)}" title="Open this session's wirescope page in a clodex window (⌘-click for browser)">🔍 wirescope</a>`);
  }

  tele.innerHTML = segs.join('<span class="px-sep">·</span>');
  // Keep-warm + strip level live with the actions on the right, not the info column.
  renderSessionActions(buildProxyExtras(p));
}

// The two live-action controls (keep-warm, strip level) that sit with the static
// action buttons. Their VISIBILITY is gated on the advertised capability +
// persisted state; their ACTIONABILITY (enabled vs disabled) on the live link.
// Two independent disappearance bugs had to be closed for the strip button:
//   1. Link flicker — the button was being removed from the DOM whenever the
//      proxy link blipped. Fixed by gating presence on capability+persisted
//      stripLevel (which we always know) and only DISABLING on lost link.
//   2. Capability flap — a failed/foreign/fallback probe returns capabilities
//      WITHOUT strip_thinking, which used to retract the button for up to a probe
//      cache TTL. strip_thinking.available is a STATIC property of a wirescope
//      deployment, so main.js latches it permanently per base (ProxyPoller
//      .stripCapBases) and a downgraded probe can no longer drop the cap.
// Net: the button's presence is now a deployment property, never a per-tick
// network fact; only its enabled state tracks the live link.
function buildProxyExtras(p) {
  const actionable = !!(p.linked && p.base && p.sessionId);

  // Keep-warm: a single fire button that opens a duration dropdown (1h/4h/8h,
  // plus Stop when held). Held/armed state is only known on a live record.
  let holdHtml = '';
  if (p.capabilities && p.capabilities.hold) {
    if (actionable && p.hold) {
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
    } else if (actionable) {
      holdHtml = `<button class="px-hold" data-act="warm-menu" title="Keep prompt cache warm">🔥 keep warm</button>`;
    } else {
      holdHtml = `<button class="px-hold" disabled title="Keep prompt cache warm — waiting for a live proxy session">🔥 keep warm</button>`;
    }
  }

  // Strip-level control (only when wirescope advertises the lever). A cumulative
  // ladder opened via dropdown: 0 off · 1 strips prior-turn thinking · 2 also
  // strips superseded tool results. The current turn is never touched;
  // non-destructive. p.stripLevel is our persisted, authoritative level.
  let stripHtml = '';
  const stripCap = p.capabilities && p.capabilities.strip_thinking;
  if (stripCap && stripCap.available) {
    const lvl = typeof p.stripLevel === 'number' ? p.stripLevel : 0;
    const label = lvl === 0 ? '🧠 strip' : `🧠 strip L${lvl}`;
    const tip = !actionable
      ? `Wire stripping${lvl > 0 ? ` — level ${lvl} saved` : ''}. Waiting for a live proxy session to change it.`
      : (lvl === 0
        ? 'Strip wasted re-read carriage from the wire to reclaim cost. Click to choose a level.'
        : `Strip level ${lvl} active${lvl >= 2 ? ' (thinking + edit-acks + failed-call stubs)' : ' (prior-turn thinking)'}. Click to change.`);
    stripHtml = `<button class="px-action px-strip${lvl > 0 ? ' is-on' : ''}"${actionable ? '' : ' disabled'} data-act="strip-menu" data-level="${lvl}" title="${esc(tip)}">${label}</button>`;
  }

  return stripHtml + holdHtml;
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
  applySubagents(name);
  if (name === activeSession) renderProxyBar();
});

// --- Subagent child rows -----------------------------------------------------
// Task/background subagents a session spawns share the parent's session_id on
// the wire, so the parent's /_status record carries them in `payload.subagents`
// (shaped in proxy-util). We draw them as indented child rows under the parent
// tab and, on click, open a popover that polls the on-demand /_subagents detail
// for "what is it doing right now" (~one turn stale — see wirescope contract).
//
// There is NO wire signal for "subagent done" — a Task sub just stops making
// requests — so done/aging is POLICY we own here (the proxy emits raw facts
// only). We derive an effective inactivity = lastActiveS + age-of-this-payload,
// and: under ACTIVE_S → live (pulsing); past DROP_S → stop rendering (the entry
// lingers in the array until the whole session is swept, so we age it out
// ourselves rather than wait). Between the two it reads as a settled child.
const SUBAGENT_ACTIVE_S = 30;   // seen within this window → "live"
const SUBAGENT_DROP_S = 300;    // stale past this → drop the row entirely

function subagentRows(name) {
  return sessionList.querySelectorAll(`.session-child[data-parent="${CSS.escape(name)}"]`);
}

function applySubagents(name) {
  const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (!item) { return; } // tab gone — child rows (siblings) get cleared on removal
  const st = proxyState.get(name);
  const p = st && st.payload;
  const ageS = st ? (Date.now() - st.at) / 1000 : 0;
  const dead = ageS > PROXY_POLL_MS * 4 / 1000;
  const subs = (p && p.linked && !dead && Array.isArray(p.subagents)) ? p.subagents : [];

  // Filter to the renderable (not-yet-aged-out) set, preserving proxy order.
  const live = [];
  for (const s of subs) {
    const eff = (s.lastActiveS == null) ? 0 : s.lastActiveS + ageS;
    if (eff > SUBAGENT_DROP_S) continue;
    live.push({ s, state: eff < SUBAGENT_ACTIVE_S ? 'active' : 'done' });
  }

  const existing = subagentRows(name);
  if (!live.length) { existing.forEach((el) => el.remove()); return; }

  // Reconcile by key: update in place where possible so a popped-open popover's
  // anchor row survives a re-render, append the rest in order after the parent.
  const have = new Map();
  existing.forEach((el) => have.set(el.dataset.key, el));
  const seen = new Set();
  let anchor = item;
  for (const { s, state } of live) {
    seen.add(s.key);
    let row = have.get(s.key);
    if (!row) {
      row = document.createElement('div');
      row.className = 'session-child';
      row.dataset.parent = name;
      row.dataset.key = s.key;
      row.innerHTML = '<span class="child-dot"></span><span class="child-label"></span><span class="child-meta"></span>';
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        openSubagentPopover(name, s.key, row);
      });
    }
    row.dataset.state = state;
    row.title = `${s.label || s.key}${s.model ? ' · ' + s.model : ''}${s.requests ? ' · ' + s.requests + ' turn' + (s.requests === 1 ? '' : 's') : ''}\nClick for live activity`;
    row.querySelector('.child-label').textContent = s.label || s.key;
    row.querySelector('.child-meta').textContent = s.requests ? `${s.requests}` : '';
    // Keep DOM order matching proxy order, right after the running anchor.
    if (anchor.nextSibling !== row) anchor.after(row);
    anchor = row;
  }
  // Drop rows whose subagent vanished from the renderable set.
  existing.forEach((el) => { if (!seen.has(el.dataset.key)) el.remove(); });

  // If a popover is open for this parent and its row aged out, close it.
  if (subagentPopover && subagentPopover.dataset.name === name
      && subagentPopover.dataset.key && !seen.has(subagentPopover.dataset.key)) {
    closeSubagentPopover();
  }
}

// --- Subagent live-activity popover ------------------------------------------
// On-demand detail for one child row. Polls /_subagents (via main) every
// SUBAGENT_DETAIL_MS while open — NEVER folded into the 5s session poll, the
// request body it reads is heavy. Shows at most one-turn-stale activity (the
// in-flight token stream isn't on the wire as a request body until the next
// turn); `turn_ts` lets us label it honestly as "as of Ns ago".
const subagentPopover = document.getElementById('subagent-popover');
const subagentPopoverName = document.getElementById('subagent-popover-name');
const subagentPopoverBody = document.getElementById('subagent-popover-body');
const SUBAGENT_DETAIL_MS = 1500;
let subagentPollTimer = null;

// Accumulating live feed. The detail endpoint only ever returns the latest
// COMPLETED turn (keyed by turn_ts), so instead of replacing the body each poll
// we dedup by turn_ts and APPEND each newly-seen turn as an entry — the popover
// reads as a running log of what the sub did, not a slideshow. Honest caveat:
// we only observe the latest completed turn per poll, so a sub that finishes
// several turns faster than our 1.5s cadence will skip the in-between ones — the
// feed is "the turns we caught", not a guaranteed-complete transcript.
let subagentFeed = [];           // [{ ts, tool, toolInput, truncated, text }]
let subagentFeedSeen = new Set(); // turn signatures already appended
let subagentFeedMeta = null;      // { role, model } captured once
let subagentFeedEnded = false;    // session went cold — stop, but keep history

function resetSubagentFeed() {
  subagentFeed = [];
  subagentFeedSeen = new Set();
  subagentFeedMeta = null;
  subagentFeedEnded = false;
}

function closeSubagentPopover() {
  if (subagentPollTimer) { clearInterval(subagentPollTimer); subagentPollTimer = null; }
  subagentPopover.classList.add('hidden');
  subagentPopover.dataset.name = '';
  subagentPopover.dataset.key = '';
  resetSubagentFeed();
}

function openSubagentPopover(name, key, anchorRow) {
  // Toggle off if re-clicking the same row.
  if (!subagentPopover.classList.contains('hidden')
      && subagentPopover.dataset.name === name && subagentPopover.dataset.key === key) {
    return closeSubagentPopover();
  }
  if (subagentPollTimer) { clearInterval(subagentPollTimer); subagentPollTimer = null; }
  subagentPopover.dataset.name = name;
  subagentPopover.dataset.key = key;
  resetSubagentFeed();
  const label = anchorRow.querySelector('.child-label')?.textContent || key;
  subagentPopoverName.textContent = label;
  subagentPopoverBody.innerHTML = '<div class="subagent-detail-empty">Loading…</div>';
  subagentPopover.classList.remove('hidden');
  // Anchor to the row, clamped to the viewport (mirrors the other popovers).
  // The box can be tall (content-driven, up to 78vh), so clamp top by the box's
  // actual height — not a fixed 60px — or a popover opened from a low row would
  // spill off the bottom edge.
  const r = anchorRow.getBoundingClientRect();
  const w = subagentPopover.offsetWidth || 760;
  // Reserve the box's MAX possible height (CSS max-height is 78vh): offsetHeight
  // here is just the "Loading…" stub, and the box grows downward as content
  // arrives anchored at this top, so clamping by the stub height would let a
  // fully-loaded popover spill off the bottom. Budget the worst case so even a
  // full-height box fits; a short popover just sits a little higher (harmless).
  const hMax = window.innerHeight * 0.78;
  subagentPopover.style.left = `${Math.max(8, Math.min(r.right + 6, window.innerWidth - w - 8))}px`;
  subagentPopover.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - hMax - 8))}px`;
  subagentPopover.style.bottom = 'auto';
  const poll = () => fetchSubagentDetail(name, key);
  poll();
  subagentPollTimer = setInterval(poll, SUBAGENT_DETAIL_MS);
}

async function fetchSubagentDetail(name, key) {
  // Bail if the popover was closed / retargeted while a fetch was in flight.
  const stillOpen = () => subagentPopover.dataset.name === name && subagentPopover.dataset.key === key
    && !subagentPopover.classList.contains('hidden');
  if (!stillOpen()) return;
  let res;
  try { res = await window.api.getProxySubagentDetail(name, key, 800); }
  catch (e) { res = { ok: false, error: String(e) }; }
  if (!stillOpen()) return;
  if (!res || !res.ok) {
    // Transient fetch error — only show it if we have no history to preserve.
    if (!subagentFeed.length) {
      subagentPopoverBody.innerHTML = `<div class="subagent-detail-empty">${esc(res && res.error ? res.error : 'unavailable')}</div>`;
    }
    return;
  }
  const d = res.data || {};
  if (d.found === false) {
    // A missing child mid-stream: once we've accumulated history, keep showing
    // it rather than wiping the feed. session_cold means the in-memory bodies are
    // gone, so stop polling — but leave the captured log on screen with an end
    // note. With no history yet, fall back to the plain reason message.
    if (subagentFeed.length) {
      if (d.reason === 'session_cold' && !subagentFeedEnded) {
        subagentFeedEnded = true;
        if (subagentPollTimer) { clearInterval(subagentPollTimer); subagentPollTimer = null; }
        renderSubagentFeed();
      }
      return;
    }
    const reason = d.reason === 'session_cold' ? 'Session ended — no live activity.'
      : d.reason === 'no_request_body' ? 'No activity captured yet.'
      : 'Subagent is no longer tracked.';
    subagentPopoverBody.innerHTML = `<div class="subagent-detail-empty">${esc(reason)}</div>`;
    if (d.reason === 'session_cold') closeSubagentPopover();
    return;
  }
  // Append this turn if it's new, then re-render. Keep the view pinned to the
  // bottom when a fresh turn lands or the user is already there; otherwise leave
  // their scroll position alone so they can read back through earlier turns.
  const appended = ingestSubagentTurn(d);
  const sc = subagentPopoverBody;
  const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40;
  renderSubagentFeed();
  if (appended || nearBottom) sc.scrollTop = sc.scrollHeight;
}

// Fold one detail response into the feed. Dedup by turn_ts (the per-turn key);
// without one, fall back to a content signature so identical repeats don't pile
// up. Returns true iff a new entry was appended.
function ingestSubagentTurn(d) {
  if (!subagentFeedMeta && (d.role || d.model)) {
    subagentFeedMeta = { role: d.role || null, model: d.model || null };
  }
  if (!d.last_tool && !d.last_text) return false; // nothing to show this turn
  const sig = (typeof d.turn_ts === 'number')
    ? `t:${d.turn_ts}`
    : `c:${d.last_tool || ''}|${(d.last_text || '').slice(0, 80)}`;
  if (subagentFeedSeen.has(sig)) return false;
  subagentFeedSeen.add(sig);
  subagentFeed.push({
    ts: typeof d.turn_ts === 'number' ? d.turn_ts : null,
    tool: d.last_tool || null,
    toolInput: d.last_tool_input || null,
    truncated: !!d.truncated,
    text: d.last_text || null,
  });
  return true;
}

// Pull a compact one-line preview out of a tool_use input object. The keys are
// whatever the model emitted (wirescope forwards it verbatim) so we probe the
// common primaries and fall back to compact JSON — always truncating on render
// since an unexpected key could be large even past the server-side maxlen clamp.
function subagentToolPreview(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description']) {
    if (typeof input[k] === 'string' && input[k]) return input[k];
  }
  try { return JSON.stringify(input); } catch { return ''; }
}

function renderSubagentFeed() {
  const parts = [];
  if (subagentFeedMeta) {
    const meta = [];
    if (subagentFeedMeta.role) meta.push(esc(subagentFeedMeta.role));
    if (subagentFeedMeta.model) meta.push(esc(subagentFeedMeta.model));
    if (meta.length) parts.push(`<div class="subagent-detail-meta">${meta.join(' · ')}</div>`);
  }
  if (!subagentFeed.length) {
    parts.push('<div class="subagent-detail-empty">No activity captured yet.</div>');
    subagentPopoverBody.innerHTML = parts.join('');
    return;
  }
  subagentFeed.forEach((e) => {
    const entry = [];
    if (e.tool) {
      const preview = subagentToolPreview(e.toolInput);
      const clamped = preview.length > 600 ? preview.slice(0, 600) + '…' : preview;
      // Tool name is the colored first word, args flow inline after it: "Read: …".
      const nameTxt = clamped ? `${esc(e.tool)}:` : esc(e.tool);
      entry.push(`<div class="subagent-detail-tool"><span class="subagent-tool-name">${nameTxt}</span>` +
        (clamped ? ` <span class="subagent-tool-arg">${esc(clamped)}</span>` : '') + '</div>');
      if (e.truncated) entry.push('<div class="subagent-detail-note">(arguments truncated)</div>');
    }
    if (e.text) {
      const t = e.text.length > 1200 ? e.text.slice(0, 1200) + '…' : e.text;
      entry.push(`<div class="subagent-detail-text">${esc(t)}</div>`);
    }
    parts.push(`<div class="subagent-feed-entry">${entry.join('')}</div>`);
  });
  // One timestamp for the whole feed, on the latest turn — reads as a live
  // conversation rather than a stack of separately-stamped segments.
  const latest = subagentFeed[subagentFeed.length - 1];
  if (latest && latest.ts != null) {
    const agoS = Math.max(0, Math.round(Date.now() / 1000 - latest.ts));
    parts.push(`<div class="subagent-detail-asof">${fmtCountdown(agoS)} ago</div>`);
  }
  if (subagentFeedEnded) {
    parts.push('<div class="subagent-detail-note">Session ended — no further activity.</div>');
  }
  subagentPopoverBody.innerHTML = parts.join('');
}

document.getElementById('subagent-popover-close').addEventListener('click', closeSubagentPopover);
document.addEventListener('click', (e) => {
  if (subagentPopover.classList.contains('hidden')) return;
  if (subagentPopover.contains(e.target)) return;
  if (e.target.closest('.session-child')) return; // row clicks toggle themselves
  closeSubagentPopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !subagentPopover.classList.contains('hidden')) closeSubagentPopover();
});

// --- Toast bubbles -----------------------------------------------------------
// Transient bottom-right notifications. Returns nothing; auto-dismisses unless
// opts.sticky. Body text is set via textContent (never innerHTML) so a session
// name can't inject markup.
function showToast(msg, opts = {}) {
  const host = document.getElementById('toast-host');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast' + (opts.kind ? ' toast-' + opts.kind : '');
  const body = document.createElement('span');
  body.className = 'toast-msg';
  body.textContent = msg;
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.title = 'Dismiss';
  close.innerHTML = '&times;';
  el.appendChild(body);
  el.appendChild(close);
  let done = false;
  const dismiss = () => {
    if (done) return; done = true;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
  };
  close.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
  // Clicking the body of a session-scoped toast jumps to that session.
  if (opts.name) {
    el.classList.add('toast-clickable');
    el.addEventListener('click', () => { if (sessions.has(opts.name)) switchSession(opts.name); dismiss(); });
  }
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  if (!opts.sticky) setTimeout(dismiss, opts.duration || 9000);
  return dismiss;
}

// --- Cache-cooldown heads-up -------------------------------------------------
// Warn once per warm episode when a session's prompt cache is ~5 min from cold.
// Scoped to kept-warm holds (ttl_s > the warn horizon): a plain ~5-min Anthropic
// cache has a lifetime no longer than the horizon, so a 5-min warning would fire
// the instant it warms — useless and noisy. The badge already shows those.
const WARM_WARN_S = 300;
const warmWarned = new Set(); // names warned in the current warm episode

function checkWarmthCooldown(name) {
  const st = proxyState.get(name);
  const p = st && st.payload;
  if (!p || !p.linked || !p.warmth || p.warmth.state !== 'warm' || p.warmth.remaining_s == null) {
    warmWarned.delete(name); return;
  }
  const ageMs = Date.now() - st.at;
  if (ageMs > PROXY_POLL_MS * 4) return; // payload dead — don't warn on a stale projection
  const ttl = p.warmth.ttl_s;
  if (ttl != null && ttl <= WARM_WARN_S) { warmWarned.delete(name); return; } // not a kept-warm hold
  const remaining = p.warmth.remaining_s - ageMs / 1000;
  if (remaining > WARM_WARN_S) { warmWarned.delete(name); return; } // re-warmed / still plenty
  if (remaining <= 0) { warmWarned.delete(name); return; }          // already cold — re-arm next episode
  if (!warmWarned.has(name)) {
    warmWarned.add(name);
    const mins = Math.max(1, Math.round(remaining / 60));
    showToast(`${name}: cache going cold in ~${mins} min`, { kind: 'warm', name });
  }
}

// Tick live countdowns once a second: the active session's bar plus every
// tab's warmth badge. Uses the light text-only update so keep-warm buttons
// aren't rebuilt out from under the cursor.
setInterval(() => {
  for (const name of proxyState.keys()) { applyWarmBadge(name); checkWarmthCooldown(name); }
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
    if (link && link.dataset.url) {
      e.preventDefault();
      // Cmd/Ctrl-click escapes to the system browser (DevTools, tabs); a plain
      // click opens the page in an in-app, theme-chromed wirescope window.
      if (e.metaKey || e.ctrlKey) {
        window.api.openExternal(link.dataset.url);
      } else {
        const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg');
        window.api.openWirescope(link.dataset.url, bg);
      }
      return;
    }
    const ctxSeg = e.target.closest('[data-act="ctx"]');
    if (ctxSeg && activeSession) { openContextPopover(activeSession, ctxSeg); return; }
    const costSeg = e.target.closest('[data-act="cost"]');
    if (costSeg && activeSession) { openCostPopover(activeSession, costSeg); return; }
    const action = e.target.closest('.px-action');
    if (action && activeSession) {
      if (action.dataset.act === 'edit') openArgsDialog(activeSession);
      else if (action.dataset.act === 'tools') openToolsPopover(activeSession, action);
      else if (action.dataset.act === 'skills') openSkillsPopover(activeSession, action);
      else if (action.dataset.act === 'agents') openAgentsPopover(activeSession, action);
      else if (action.dataset.act === 'history') openHistoryMenu(activeSession, action);
      else if (action.dataset.act === 'reload') doHardRestart(activeSession);
      else if (action.dataset.act === 'strip-menu') {
        if (stripMenu) closeStripMenu();
        else openStripMenu(action, Number(action.dataset.level) || 0);
      }
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
// The hold owner is the payload's choice, not the renderer's: holdSource
// 'wire' (in-process HoldKeeper, W2 cutover) routes to wire:hold, anything
// else to the external proxy's /_hold. Same return contract on both.
function holdApiFor(name) {
  const st = proxyState.get(name);
  return (st && st.payload && st.payload.holdSource === 'wire')
    ? window.api.wireHold : window.api.proxyHold;
}

async function doWarmHold(name, opts) {
  const holdApi = holdApiFor(name);
  if (opts.off) {
    const r = await holdApi(name, 0, false);
    if (!r.ok) alert('Could not disarm hold: ' + r.error);
    return;
  }
  const hours = opts.hours;
  if (!confirm(`Keep "${name}" prompt cache warm for ${hours}h?\n\nThe proxy auto-pings to refresh the cache until ${hours}h after the last turn; each ping costs ~1 token.`)) return;
  let r = await holdApi(name, hours, false);
  if (r.ok && !r.armed && r.skipped) {
    if (confirm(`Proxy declined (${r.skipped}): the cache prefix isn't warm yet, so there's nothing to keep warm. Force the hold anyway?`)) {
      r = await holdApi(name, hours, true);
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

// --- Strip-level dropdown ------------------------------------------------
// The 🧠 strip button opens this. A cumulative ladder (each level a superset):
// 0 off · 1 prior-turn thinking · 2 + edit-acks/failed-call stubs. Level 2 is
// gated on the proxy advertising strip_thinking.max_level>=2 — shown disabled
// until the L2 build is live, then it lights up automatically. Mirrors keep-warm.
let stripMenu = null;
function closeStripMenu() { if (stripMenu) { stripMenu.remove(); stripMenu = null; } }

const STRIP_LEVELS = [
  { lvl: 0, name: 'Off', desc: 'No stripping' },
  { lvl: 1, name: 'Level 1 — thinking', desc: 'Strip prior-turn reasoning (~30% off, no visible degradation)' },
  { lvl: 2, name: 'Level 2 — + edit-acks & failed calls', desc: 'Also collapse succeeded edit/write acks and stub failed tool calls (only reclaims while L1 is stripping)' },
];

function openStripMenu(anchorBtn, currentLevel) {
  closeStripMenu();
  const caps = (activeSession && proxyState.get(activeSession)?.payload?.capabilities) || {};
  // L2 folds into strip_thinking as a level; gate on the advertised max_level.
  const toolsAvail = (caps.strip_thinking && caps.strip_thinking.max_level >= 2);
  stripMenu = document.createElement('div');
  stripMenu.className = 'warm-menu strip-menu';
  const items = ['<div class="warm-menu-label">Wire stripping level</div>'];
  for (const s of STRIP_LEVELS) {
    const cur = s.lvl === currentLevel ? ' strip-cur' : '';
    const lock = (s.lvl === 2 && !toolsAvail);
    const dis = lock ? ' disabled' : '';
    const note = lock ? '<span class="strip-soon">coming soon</span>' : `<span class="strip-desc">${esc(s.desc)}</span>`;
    items.push(`<button class="warm-item strip-item${cur}" data-level="${s.lvl}"${dis}>` +
      `<span class="strip-name">${esc(s.name)}${s.lvl === currentLevel ? ' ✓' : ''}</span>${note}</button>`);
  }
  stripMenu.innerHTML = items.join('');
  stripMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('.strip-item');
    if (!item || item.disabled || !activeSession) return;
    const level = Number(item.dataset.level) || 0;
    const name = activeSession;
    closeStripMenu();
    if (level === currentLevel) return;
    // Changing strip state on a WARM cache forces a one-time full-window premium
    // re-write: stripped vs unstripped is a maximal prefix byte-difference, so the
    // whole cached message region busts (wirescope measured 95k–261k tokens/flip).
    // It's cheap on a cold cache, and pays off if you KEEP the new level — but
    // flipping back and forth is the most expensive mode of all. So gate it: free
    // when cold, confirm-with-warning when the cache is established/warm.
    const pl = proxyState.get(name)?.payload;
    const warm = pl && pl.warmth ? pl.warmth.state === 'warm' : (pl && pl.turns > 0);
    if (warm && !confirm(
      `Changing the strip level mid-session forces a one-time full-window cache re-write ` +
      `(premium-priced — often 100k–250k tokens). It only pays off if you keep the new level ` +
      `for the rest of this conversation; flipping back and forth is the most expensive option.\n\n` +
      `Set ${(STRIP_LEVELS.find((s) => s.lvl === level) || {}).name || `level ${level}`} now?\n\n` +
      `(Tip: cheapest to set the level on a fresh session, or after /clear when the cache is cold.)`
    )) return;
    const r = await window.api.setStripLevel(name, level);
    if (!r || !r.ok) alert('Could not change strip level: ' + ((r && r.error) || 'unknown error'));
    // New level shows on the next poll (≤5s).
  });
  document.body.appendChild(stripMenu);
  const r = anchorBtn.getBoundingClientRect();
  const w = stripMenu.offsetWidth;
  stripMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  stripMenu.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
}

document.addEventListener('click', (e) => {
  if (!stripMenu) return;
  if (stripMenu.contains(e.target)) return;
  if (e.target.closest('.px-strip[data-act="strip-menu"]')) return; // toggle handled by the bar
  closeStripMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stripMenu) closeStripMenu();
});

// --- Per-session history picker (past conversations) ---------------------
// A lightweight dynamic menu (like the warm menu) listing the agent's prior
// conversations: observed ids first (authoritative — clodex watched them mint
// on each /clear), then dimmed "inferred" transcripts found in the same project
// dir but never observed. Picking one restarts the session with --resume <id>,
// switching it to that conversation; the live one stays re-selectable here.
let historyMenu = null;
function closeHistoryMenu() { if (historyMenu) { historyMenu.remove(); historyMenu = null; } }

function histRelTime(iso) {
  const t = Date.parse(iso || '');
  if (!isFinite(t)) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return shortTs(iso);
}

async function openHistoryMenu(name, anchorBtn) {
  closeHistoryMenu();
  const res = await window.api.getSessionHistory(name);
  if (activeSession !== name) return; // user switched away while it loaded
  historyMenu = document.createElement('div');
  historyMenu.className = 'history-menu';
  if (!res || !res.ok) {
    historyMenu.innerHTML = '<div class="history-empty">Could not load history.</div>';
  } else if (!res.sessions.length) {
    historyMenu.innerHTML = '<div class="history-empty">No past conversations yet.</div>';
  } else {
    const rows = res.sessions.map((s) => {
      const title = s.title || (s.missing ? 'conversation (transcript gone)' : 'untitled conversation');
      const badges =
        (s.active ? '<span class="history-badge active">active</span>' : '') +
        (s.inferred ? '<span class="history-badge inferred" title="found in the project dir but not observed by clodex — may belong to another agent sharing this cwd">inferred</span>' : '');
      const meta = [s.lastActive ? histRelTime(s.lastActive) : '', s.turns ? `${s.turns} msgs` : '']
        .filter(Boolean).join(' · ');
      const cls = 'history-item' + (s.active ? ' is-active' : '') + (s.inferred ? ' is-inferred' : '');
      const dis = (s.active || s.missing) ? ' data-disabled="1"' : '';
      return `<button class="${cls}"${dis} data-sid="${esc(s.sessionId)}" title="${esc(s.sessionId)}">` +
        `<span class="history-title">${esc(title)}${badges}</span>` +
        `<span class="history-meta">${esc(meta)}</span></button>`;
    }).join('');
    historyMenu.innerHTML = `<div class="history-menu-label">Past conversations — ${esc(name)}</div>` + rows;
  }
  historyMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('.history-item');
    if (!item || item.dataset.disabled) return;
    const sid = item.dataset.sid;
    closeHistoryMenu();
    if (!confirm(`Switch "${name}" to this past conversation?\n\nThe session restarts with --resume on ${sid.slice(0, 8)}…. The current conversation is kept and stays re-selectable here.`)) return;
    const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
    const snapType = el ? el.querySelector('.session-type')?.textContent : null;
    const snapCwd = el ? el.dataset.cwd : null;
    const rr = await window.api.restartSession(name, { resumeId: sid });
    if (!rr || !rr.ok) { alert(`Resume failed: ${rr && rr.error ? rr.error : 'unknown error'}`); return; }
    if (snapType) { createTerminal(name); addSessionToSidebar(name, snapType, snapCwd, null); switchSession(name); }
  });
  document.body.appendChild(historyMenu);
  // Anchor above the button, clamped to the viewport (mirrors the warm menu).
  const r = anchorBtn.getBoundingClientRect();
  const w = historyMenu.offsetWidth;
  historyMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  historyMenu.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
}
document.addEventListener('click', (e) => {
  if (!historyMenu) return;
  if (historyMenu.contains(e.target)) return;
  if (e.target.closest('.px-action[data-act="history"]')) return; // toggle handled by the bar
  closeHistoryMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && historyMenu) closeHistoryMenu();
});

// Hard restart: respawn the CLI in a FRESH conversation (no --resume). The CLI
// snapshots its tool/skill/settings roster at process launch and rebuilds it
// only when a new conversation is created — /clear and --resume both replay the
// frozen roster — so this is the one action that picks up an edited settings.json
// (re-enabled tools, skill changes, MCP, etc.). Not destructive: the prior
// conversation is preserved on disk and stays resumable via the 🕘 history picker.
async function doHardRestart(name) {
  if (!confirm(
    `Hard-restart "${name}"?\n\n` +
    `Starts a fresh conversation so the CLI reloads tools, skills, and settings ` +
    `from disk (a plain restart, --resume, or /clear keeps the old roster). ` +
    `The current conversation isn't lost — it stays available under 🕘 history.`
  )) return;
  const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  const snapType = el ? el.querySelector('.session-type')?.textContent : null;
  const snapCwd = el ? el.dataset.cwd : null;
  const rr = await window.api.restartSession(name, { fresh: true });
  if (!rr || !rr.ok) { alert(`Hard restart failed: ${rr && rr.error ? rr.error : 'unknown error'}`); return; }
  if (snapType) { createTerminal(name); addSessionToSidebar(name, snapType, snapCwd, null); switchSession(name); }
}

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
  renderToolChecklist(popoverToolsList, new Set(res.disabledTools || []), res.effectiveTools || {});
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

// --- Per-session Skills popover ------------------------------------------
// Mirrors the tools popover, but writes skillOverrides:{name:"off"} (which
// reclaims the per-turn roster tokens) instead of permissions.deny. The
// catalog is the live transcript roster unioned with the disabled set
// (session:skillCatalog), so a turned-off skill stays re-enable-able.
const skillsPopover = document.getElementById('skills-popover');
const skillsPopoverName = document.getElementById('skills-popover-name');
const popoverSkillsList = document.getElementById('popover-skills-list');
const popoverInjectSkillsSection = document.getElementById('popover-inject-skills-section');
const popoverInjectSkillsList = document.getElementById('popover-inject-skills-list');
const skillsPopoverRestart = document.getElementById('skills-popover-restart');

function closeSkillsPopover() {
  skillsPopover.classList.add('hidden');
  skillsPopover.dataset.name = '';
}

async function openSkillsPopover(name, anchorBtn) {
  const res = await window.api.getSkillCatalog(name);
  if (!res || !res.ok) { alert('Session not found in persistence.'); return; }
  renderSkillChecklist(popoverSkillsList, res.names || [], new Set(res.disabledSkills || []),
    res.effective || {}, { skillsLocked: res.skillsLocked, canReenable: res.canReenable });
  // Library-injection section: only shown when the library is non-empty.
  skillLibCache = res.skillLib || [];
  if (skillLibCache.length) {
    renderInjectChecklist(popoverInjectSkillsList, new Set(res.injectSkills || []));
    popoverInjectSkillsSection.style.display = '';
  } else {
    popoverInjectSkillsSection.style.display = 'none';
  }
  skillsPopoverRestart.checked = false;
  skillsPopoverName.textContent = name;
  skillsPopover.dataset.name = name;
  skillsPopover.classList.remove('hidden');
  const r = anchorBtn.getBoundingClientRect();
  const w = skillsPopover.offsetWidth;
  skillsPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  skillsPopover.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
}

document.getElementById('skills-popover-cancel').addEventListener('click', closeSkillsPopover);
document.getElementById('skills-popover-apply').addEventListener('click', async () => {
  const name = skillsPopover.dataset.name;
  if (!name) return closeSkillsPopover();
  const disabledSkills = collectSkillChecklist(popoverSkillsList);
  // Only send injectSkills when the library section is shown; otherwise pass
  // undefined so the handler preserves the persisted set (empty library != none).
  const injectSkills = popoverInjectSkillsSection.style.display === 'none'
    ? undefined : collectInjectChecklist(popoverInjectSkillsList);
  const restart = skillsPopoverRestart.checked;
  // Skill changes (trim or inject) only land in a NEW conversation (the roster
  // is fixed at creation; --resume replays the old one), so confirm the
  // history-clearing fresh restart before doing it.
  if (restart && !confirm(`Apply skill changes to "${name}" now?\n\nThis starts a NEW conversation — the current session's history will be cleared. (Leave "Restart fresh" unchecked to apply on the next fresh start instead.)`)) return;
  closeSkillsPopover();
  const r = await window.api.setSessionSkills(name, disabledSkills, injectSkills);
  if (!r || !r.ok) { alert(`Failed to update skills: ${r && r.error ? r.error : 'unknown error'}`); return; }
  if (!restart) return;
  // Fresh (non-resume) restart — the only way a skill change takes effect.
  // Same re-attach dance as the tools popover restart path.
  const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  const snapType = item ? item.querySelector('.session-type')?.textContent : null;
  const snapCwd = item ? item.dataset.cwd : null;
  const rr = await window.api.restartSession(name, { fresh: true });
  if (!rr || !rr.ok) { alert(`Restart failed: ${rr && rr.error ? rr.error : 'unknown error'}`); return; }
  if (snapType) {
    createTerminal(name);
    addSessionToSidebar(name, snapType, snapCwd, null);
    switchSession(name);
  }
});
document.addEventListener('mousedown', (e) => {
  if (skillsPopover.classList.contains('hidden')) return;
  if (skillsPopover.contains(e.target)) return;
  if (e.target.closest('.px-action')) return;
  if (e.target.closest('[data-act="manage-skills"]')) return; // ctx cross-link opens it
  closeSkillsPopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !skillsPopover.classList.contains('hidden')) closeSkillsPopover();
});

// --- Per-session Agents popover ------------------------------------------
// A shortcut for composing the custom-subagent library into a running session
// (--agents) + toggling the built-in agents, instead of right-click → Edit
// settings → check/uncheck. Denying a built-in (Agent(Explore) etc.) filters it
// out of the injected roster — reclaiming its per-turn description tokens — and
// stops delegation to it, so this IS a (capability-costing) trim lever. Like
// skills, the roster is frozen at conversation creation, so applying needs a
// FRESH (non-resume) restart.
const agentsPopover = document.getElementById('agents-popover');
const agentsPopoverName = document.getElementById('agents-popover-name');
const popoverAgentsList = document.getElementById('popover-agents-list');
const popoverBuiltinsList = document.getElementById('popover-builtins-list');
const agentsPopoverRestart = document.getElementById('agents-popover-restart');

function closeAgentsPopover() {
  agentsPopover.classList.add('hidden');
  agentsPopover.dataset.name = '';
}

async function openAgentsPopover(name, anchorBtn) {
  const res = await window.api.getAgentCatalog(name);
  if (!res || !res.ok) { alert('Session not found in persistence.'); return; }
  agentLibCache = res.agents || [];
  renderAgentChecklist(popoverAgentsList, new Set(res.enabled || []));
  renderBuiltinChecklist(popoverBuiltinsList, new Set(res.denyBuiltins || []));
  agentsPopoverRestart.checked = false;
  agentsPopoverName.textContent = name;
  agentsPopover.dataset.name = name;
  agentsPopover.classList.remove('hidden');
  const r = anchorBtn.getBoundingClientRect();
  const w = agentsPopover.offsetWidth;
  agentsPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  agentsPopover.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
}

document.getElementById('agents-popover-cancel').addEventListener('click', closeAgentsPopover);
document.getElementById('agents-popover-close').addEventListener('click', closeAgentsPopover);
document.getElementById('agents-popover-apply').addEventListener('click', async () => {
  const name = agentsPopover.dataset.name;
  if (!name) return closeAgentsPopover();
  const agents = collectAgentChecklist(popoverAgentsList);
  const denyBuiltins = collectBuiltinChecklist(popoverBuiltinsList);
  const restart = agentsPopoverRestart.checked;
  // The agent roster is fixed at conversation creation (--resume replays the
  // old one), so a restart that applies it must be the fresh, history-clearing
  // kind — confirm before doing it.
  if (restart && !confirm(`Apply agent changes to "${name}" now?\n\nThis starts a NEW conversation — the current session's history will be cleared. (Leave "Restart fresh" unchecked to apply on the next fresh start instead.)`)) return;
  closeAgentsPopover();
  const r = await window.api.setSessionAgents(name, agents, denyBuiltins);
  if (!r || !r.ok) { alert(`Failed to update agents: ${r && r.error ? r.error : 'unknown error'}`); return; }
  if (!restart) return;
  // Fresh (non-resume) restart — same re-attach dance as the skills popover.
  const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  const snapType = item ? item.querySelector('.session-type')?.textContent : null;
  const snapCwd = item ? item.dataset.cwd : null;
  const rr = await window.api.restartSession(name, { fresh: true });
  if (!rr || !rr.ok) { alert(`Restart failed: ${rr && rr.error ? rr.error : 'unknown error'}`); return; }
  if (snapType) {
    createTerminal(name);
    addSessionToSidebar(name, snapType, snapCwd, null);
    switchSession(name);
  }
});
document.addEventListener('mousedown', (e) => {
  if (agentsPopover.classList.contains('hidden')) return;
  if (agentsPopover.contains(e.target)) return;
  if (e.target.closest('.px-action')) return;
  closeAgentsPopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !agentsPopover.classList.contains('hidden')) closeAgentsPopover();
});

// Bulk "Check all / Uncheck all" controls for the three checklist popovers.
wireBulkToggles(toolsPopover, popoverToolsList);
wireBulkToggles(skillsPopover, popoverSkillsList);
wireBulkToggles(agentsPopover, popoverAgentsList);

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
  agents: 'Agents', skills: 'Skills',
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

function renderCompositionLine(a, stripLevel = 0) {
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
    `<span class="ctx-line-total">${fmtTokens(comp.total_tokens)}</span></div>${rows}` +
    renderStripPanel(comp.strip_prior_thinking, stripLevel >= 1) +
    (stripLevel >= 2 ? (
      renderL2StripPanel(comp.strip_prior_tool_errors, true, 'prior tool errors',
        (comp.strip_prior_tool_errors ? (comp.strip_prior_tool_errors.failed_calls || 0) + (comp.strip_prior_tool_errors.error_results || 0) : 0)) +
      renderL2StripPanel(comp.strip_prior_edit_acks, true, 'prior edit acks',
        (comp.strip_prior_edit_acks ? (comp.strip_prior_edit_acks.collapsed_acks || 0) : 0))
    ) : '');
}

// The wirescope strip-prior-thinking story for one agent line, from
// composition.strip_prior_thinking (always present when there's prior thinking
// to evaluate; absent on turn 1 / right after a compact = nothing to strip).
// `would_strip` is the gate's verdict on the window, independent of opt-in — so
// "actually stripping" = stripOn AND would_strip. When opted-in but would_strip
// is false, the monster guard skipped this turn (low thinking density).
function renderStripPanel(sp, stripOn) {
  if (!sp || typeof sp.prior_thinking_tokens !== 'number' || sp.prior_thinking_tokens <= 0) return '';
  const tok = sp.prior_thinking_tokens;
  const usd = typeof sp.est_read_reclaim_usd_per_turn === 'number' ? sp.est_read_reclaim_usd_per_turn : null;
  const pct = typeof sp.pct_of_window === 'number' ? sp.pct_of_window : null;
  const usdTxt = usd == null ? '' : (usd >= 0.01 ? ` (~$${usd.toFixed(2)}/turn)` : ` (~$${usd.toFixed(4)}/turn)`);
  const pctTxt = pct == null ? '' : ` · ${pct < 10 ? pct.toFixed(1) : Math.round(pct)}% of window`;
  let verdict, cls;
  if (stripOn && sp.would_strip) {
    verdict = `Stripping ~${fmtTokens(tok)}/turn${usdTxt}`;
    cls = 'on';
  } else if (stripOn && !sp.would_strip) {
    const ratio = typeof sp.body_thinking_ratio === 'number' ? sp.body_thinking_ratio.toFixed(1) : '?';
    const max = typeof sp.max_body_ratio === 'number' ? sp.max_body_ratio.toFixed(1) : '?';
    verdict = `On, but this turn skipped: low thinking density (ratio ${ratio} > ${max})`;
    cls = 'skip';
  } else {
    verdict = `Off — turn on 🧠 strip to reclaim ~${fmtTokens(tok)}/turn${usdTxt}`;
    cls = 'off';
  }
  return `<div class="ctx-strip ctx-strip-${cls}">` +
    `<div class="ctx-strip-head">🧠 prior thinking: <b>${fmtTokens(tok)}</b>${pctTxt}</div>` +
    `<div class="ctx-strip-verdict">${esc(verdict)}</div></div>`;
}

// The two L2 add-ons, from composition.strip_prior_tool_errors (failed calls +
// error results) and composition.strip_prior_edit_acks (succeeded Edit/Write
// acks collapsed to "ok"). Same shape; each is present only on an L2-capable
// proxy once the prior window holds collapsible items (edit_acks key landed in
// wirescope v0.6.1 — gate on presence). `rides_thinking_bust` means the add-on
// only reclaims on turns where L1's thinking strip ALSO rewrote the window, so
// the stripping verdict gates on would_strip just like L1. Rendered at level 2.
function renderL2StripPanel(d, stripOn, label, count) {
  if (!d) return '';
  const tok = typeof d.read_reclaim_tokens_per_turn === 'number' ? d.read_reclaim_tokens_per_turn : 0;
  if (!(tok > 0)) return '';
  const usd = typeof d.est_read_reclaim_usd_per_turn === 'number' ? d.est_read_reclaim_usd_per_turn : null;
  const usdTxt = usd == null ? '' : (usd >= 0.01 ? ` (~$${usd.toFixed(2)}/turn)` : ` (~$${usd.toFixed(4)}/turn)`);
  const n = count || 0;
  const countTxt = n > 0 ? ` · ${n} item${n === 1 ? '' : 's'}` : '';
  let verdict, cls;
  if (stripOn && d.would_strip) {
    verdict = `Also stripping ~${fmtTokens(tok)}/turn${usdTxt}`;
    cls = 'on';
  } else if (stripOn && !d.would_strip) {
    verdict = d.rides_thinking_bust
      ? 'On, but idle this turn — rides the thinking bust (nothing extra until thinking strips)'
      : 'On, but nothing to strip this turn';
    cls = 'skip';
  } else {
    verdict = `+~${fmtTokens(tok)}/turn${usdTxt} on top of thinking`;
    cls = 'off';
  }
  return `<div class="ctx-strip ctx-strip-${cls}">` +
    `<div class="ctx-strip-head">🧠 ${esc(label)}: <b>${fmtTokens(tok)}</b>${countTxt}</div>` +
    `<div class="ctx-strip-verdict">${esc(verdict)}</div></div>`;
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

// Renders one utilization block (the "did it pay off" view) from a rollup +
// deadweight-first per-item list. Shared by tools and skills — wirescope ships
// both as the exact same shape ({evaluable_turns, loaded, used_distinct,
// deadweight_tokens} + per-item {name, est_tokens, used}). '' when the agent
// carries no utilization for this surface (Codex/openai lines, a non-utilization
// proxy build, or a pre-context_skills proxy for skills).
function renderUtilBlock(u, items, title) {
  if (!u || !Array.isArray(items)) return '';
  const turns = u.evaluable_turns || 0;
  const loaded = u.loaded != null ? u.loaded : items.length;
  const usedDistinct = u.used_distinct != null ? u.used_distinct : items.filter((x) => (x.used || 0) > 0).length;
  const deadweight = u.deadweight_tokens || 0;
  const lowConf = turns < UTIL_MIN_TURNS;
  // "dead" is a verdict; only claim it once enough turns back it. Until then
  // the same tokens are merely "idle" — present but not yet proven wasted.
  const deadWord = lowConf ? 'idle' : 'dead';

  // Token figures are char-based estimates (≈chars/4, wirescope's basis); a real
  // tokenizer (what the CLI's native /context shows) reads ~25% higher. The `~`
  // prefix signals estimate; the tooltip explains the systematic direction so the
  // gap vs native /context doesn't read as a mismatch.
  const estHint = 'Char-based estimate (≈chars/4); a tokenizer reads ~25% higher.';
  const head = `<div class="ctx-util-head"><span>${title}</span>` +
    `<span class="ctx-util-stat" title="${estHint}">${loaded} loaded · ${usedDistinct} used` +
    (deadweight > 0 ? ` · <b>~${fmtTokens(deadweight)} ${deadWord}</b>` : '') + `</span></div>`;

  // No loading turn has actually run yet — nothing to judge.
  if (turns === 0) {
    return `<div class="ctx-util">${head}` +
      `<div class="ctx-util-conf">No evaluable turns yet — run the session to see usage.</div></div>`;
  }
  const conf = lowConf
    ? `<div class="ctx-util-conf">Only ${turns} turn${turns === 1 ? '' : 's'} evaluated — unused ≠ dead yet.</div>`
    : `<div class="ctx-util-conf">Over ${turns} turns.</div>`;

  // Items arrive deadweight-first (used==0, then highest est_tokens); keep
  // wirescope's order and just split the two groups.
  const unused = items.filter((pt) => (pt.used || 0) === 0);
  const used = items.filter((pt) => (pt.used || 0) > 0);

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
// Tool + skill utilization for one agent line. Mirror shapes (a.tools.per_tool +
// a.utilization; a.skills.per_skill + a.skills_utilization), same renderer.
function renderUtilization(a) {
  return renderUtilBlock(a.utilization, a.tools && a.tools.per_tool, 'Tool utilization');
}
function renderSkillUtilization(a) {
  return renderUtilBlock(a.skills_utilization, a.skills && a.skills.per_skill, 'Skill utilization');
}

async function openContextPopover(name, anchor) {
  ctxPopoverName.textContent = name;
  ctxPopover.dataset.name = name;
  ctxPopoverBody.innerHTML = '<div class="ctx-note">Loading…</div>';
  ctxPopover.classList.remove('hidden');
  placeCtxPopover(anchor);
  // Opt into the (heavier) utilization capture-scan only when the proxy
  // advertises it — otherwise this is byte-identical to the composition fetch.
  // Skill usage rides the same &utilization=1 flag, so fetch it when either
  // tool-utilization or the v0.4.14 skills roster is available.
  const caps = proxyState.get(name)?.payload?.capabilities || {};
  const wantUtil = !!(caps.context_utilization || caps.context_skills);
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
    // Two columns so the popover stays short: composition (what's loaded) on the
    // left, tool + skill utilization (did it pay off) on the right. Falls back to
    // a single column when there's no utilization (composition-only proxy).
    const stripLevel = (proxyState.get(name)?.payload?.stripLevel || 0);
    const compCol = withComp.map((a) => renderCompositionLine(a, stripLevel)).join('');
    const utilCol = withComp.map((a) => renderUtilization(a) + renderSkillUtilization(a)).join('');
    html = utilCol.trim()
      ? `<div class="ctx-cols"><div class="ctx-col">${compCol}</div><div class="ctx-col">${utilCol}</div></div>`
      : compCol;
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
  // Cross-link to the skills manager. With the v0.4.14 per-skill roster
  // (capabilities.context_skills) it becomes the trim lever — N unused skills +
  // the deadweight tokens skillOverrides:off would reclaim, mirroring tools.
  // Falls back to the aggregate composition category on a pre-context_skills
  // proxy. The popover itself sources skill names standalone (transcript + seed).
  const mainSkills = mainAgent?.skills;
  if (sessionTypeOf(name) === 'claude') {
    if (mainSkills && Array.isArray(mainSkills.per_skill)) {
      const su = mainAgent.skills_utilization;
      const conclusive = su && (su.evaluable_turns || 0) >= UTIL_MIN_TURNS;
      const unusedCount = mainSkills.per_skill.filter((ps) => (ps.used || 0) === 0).length;
      const label = (conclusive && unusedCount > 0)
        ? `Trim ${unusedCount} unused skill${unusedCount === 1 ? '' : 's'}` +
          (su.deadweight_tokens > 0 ? ` (~${fmtTokens(su.deadweight_tokens)})` : '') + ' →'
        : `Manage skills (${mainSkills.count}) →`;
      html += `<span class="ctx-tools-link" data-act="manage-skills">${label}</span>`;
    } else {
      const skillsCat = mainAgent?.composition?.by_category?.find((c) => c.category === 'skills');
      if (skillsCat) {
        html += `<span class="ctx-tools-link" data-act="manage-skills">Manage skills (~${fmtTokens(skillsCat.tokens)}/turn) →</span>`;
      }
    }
  }
  // Full report → the deep, ground-truth cost/efficiency analysis (wirescope
  // /_report, report_version 1). Capability-gated; opens the report modal.
  if (caps.context_report) {
    html += `<span class="ctx-tools-link" data-act="report">Full cost &amp; efficiency report →</span>`;
  }
  ctxPopoverBody.innerHTML = html;
  placeCtxPopover(anchor);
}

ctxPopoverBody.addEventListener('click', (e) => {
  const toolsLink = e.target.closest('[data-act="manage-tools"]');
  const skillsLink = e.target.closest('[data-act="manage-skills"]');
  const reportLink = e.target.closest('[data-act="report"]');
  if (!toolsLink && !skillsLink && !reportLink) return;
  const name = ctxPopover.dataset.name;
  closeContextPopover();
  if (!name) return;
  if (reportLink) { openReportPanel(name); return; }
  // Anchor the target popover to the live ctx seg (still visible in the bar).
  const anchor = document.querySelector('#proxy-bar [data-act="ctx"]');
  if (!anchor) return;
  if (toolsLink) openToolsPopover(name, anchor);
  else openSkillsPopover(name, anchor);
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

// --- Cost-over-time popover ----------------------------------------------
// Native render of wirescope's detail=1 `series` (gated on context_timeline):
// the exact spine (read/write/generation), a cumulative-cost line chart over
// requests, and the ~est content split — plus a link out to the full
// /_timeline HTML dashboard. Opened from the bar's ~$N cost segment.
const costPopover = document.getElementById('cost-popover');
const costPopoverName = document.getElementById('cost-popover-name');
const costPopoverBody = document.getElementById('cost-popover-body');

// read = window carriage, write = cache toll, generation = output (receipt-exact).
const COST_SPINE = [
  { key: 'read', label: 'read · carriage', color: '#61afef' },
  { key: 'write', label: 'write · cache toll', color: '#e5c07b' },
  { key: 'generation', label: 'generation · output', color: '#98c379' },
];
// content_carriage_est apportions the READ dollars to content (estimate).
const COST_CONTENT = [
  { key: 'conversation', label: 'conversation', color: '#61afef' },
  { key: 'preamble', label: 'preamble', color: '#98c379' },
  { key: 'thinking', label: 'thinking', color: '#c678dd' },
];

function closeCostPopover() { costPopover.classList.add('hidden'); costPopover.dataset.name = ''; }

function costStackBlock(title, badge, defs, vals, total) {
  const rows = defs.map(d => ({ d, v: vals[d.key] || 0 })).filter(x => x.v > 0);
  const bar = rows.map(x => `<span style="width:${(total > 0 ? x.v / total * 100 : 0).toFixed(2)}%;background:${x.d.color}"></span>`).join('');
  const legend = rows.map(x => {
    const pct = total > 0 ? Math.round(x.v / total * 100) : 0;
    return `<span><span class="ck" style="background:${x.d.color}"></span>${esc(x.d.label)} <span class="cv">${fmtUsd(x.v)} · ${pct}%</span></span>`;
  }).join('');
  return `<div class="cost-sec-title"><span>${title}${badge}</span><span class="ctx-line-total">${fmtUsd(total)}</span></div>`
    + `<div class="cost-bar">${bar}</div><div class="cost-legend">${legend}</div>`;
}

// Cumulative-cost line chart: one line per spine bucket over request index.
// read towers and bends super-linearly; write/generation stay near the floor —
// that contrast is the point. Colors match the spine legend above.
function svgCostChart(reqs, defs) {
  const W = 600, H = 150, pl = 6, pr = 6, pt = 10, pb = 14;
  const n = reqs.length;
  const cum = {}; const run = {};
  defs.forEach(d => { cum[d.key] = []; run[d.key] = 0; });
  reqs.forEach(r => defs.forEach(d => { run[d.key] += (r[d.key + '_usd'] || 0); cum[d.key].push(run[d.key]); }));
  let maxY = 0;
  defs.forEach(d => { const last = cum[d.key][n - 1] || 0; if (last > maxY) maxY = last; });
  maxY = maxY || 1;
  const X = i => pl + (n <= 1 ? 0 : (i / (n - 1)) * (W - pl - pr));
  const Y = v => H - pb - (v / maxY) * (H - pt - pb);
  const paths = defs.map(d => {
    const pts = cum[d.key].map((v, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ');
    return `<path d="${pts}" fill="none" stroke="${d.color}" stroke-width="1.5"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative cost by type over requests">`
    + `<line x1="${pl}" y1="${H - pb}" x2="${W - pr}" y2="${H - pb}" stroke="#444" stroke-width="1"/>`
    + paths
    + `<text x="${pl}" y="${pt}" font-size="9" fill="#888">${esc(fmtUsd(maxY))}</text>`
    + `<text x="${pl}" y="${H - 3}" font-size="9" fill="#888">req 1</text>`
    + `<text x="${W - pr}" y="${H - 3}" font-size="9" fill="#888" text-anchor="end">req ${n}</text>`
    + `</svg>`;
}

function renderCostTimeline(d, base, sid) {
  const s = d && d.series;
  const link = (base && sid)
    ? `<span class="px-link-ext" data-url="${esc(base + '/_timeline?session=' + encodeURIComponent(sid))}" title="Open in a clodex window (⌘-click for browser)">Open full dashboard →</span>`
    : '';
  if (!s || !Array.isArray(s.requests) || !s.requests.length) {
    return `<div class="cost-note">No per-request cost series yet — give the session a turn or two.</div>${link}`;
  }
  const st = s.spine_totals || {};
  const total = (st.read || 0) + (st.write || 0) + (st.generation || 0);
  const reqs = s.requests;
  const cc = s.content_carriage_est || {};
  const ccTotal = (cc.preamble || 0) + (cc.conversation || 0) + (cc.thinking || 0);
  return `<div class="cost-head"><b>${fmtUsd(total)}</b> over <b>${s.count != null ? s.count : reqs.length}</b> requests · main line</div>`
    + costStackBlock('Cost by type', '', COST_SPINE, st, total)
    + `<div class="cost-sec-title"><span>Cumulative cost · req 1 → ${reqs.length}</span></div>`
    + `<div class="cost-chart">${svgCostChart(reqs, COST_SPINE)}</div>`
    + costStackBlock('What read pays to carry', ' <span class="ctx-est">~est</span>', COST_CONTENT, cc, ccTotal)
    + `<div class="cost-note">Preamble = system + tools + agents + skills + CLAUDE.md, the fixed tax trimmed via 🛠 / 🧩 / 🤖. Conversation (incl. tool results) is the tail that grows with session depth.</div>`
    + link;
}

async function openCostPopover(name, anchor) {
  const p = (proxyState.get(name) || {}).payload;
  const base = p && p.base, sid = p && p.sessionId;
  costPopoverName.textContent = name;
  costPopover.dataset.name = name;
  costPopoverBody.innerHTML = '<div class="cost-note">Loading cost timeline…</div>';
  costPopover.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const w = costPopover.offsetWidth;
  costPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  costPopover.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  const res = await window.api.getProxyReport(name, { detail: true });
  if (costPopover.dataset.name !== name || costPopover.classList.contains('hidden')) return;
  if (!res || !res.ok) {
    costPopoverBody.innerHTML = `<div class="cost-note">${esc(res && res.error ? res.error : 'Cost timeline unavailable')}</div>`;
    return;
  }
  try { costPopoverBody.innerHTML = renderCostTimeline(res.data, base, sid); }
  catch (e) { costPopoverBody.innerHTML = `<div class="cost-note">Could not render: ${esc(String((e && e.message) || e))}</div>`; }
}

costPopoverBody.addEventListener('click', (e) => {
  const ext = e.target.closest('[data-url]');
  if (!ext || !ext.dataset.url) return;
  // Same as the bar's wirescope link: plain click → in-app theme-chromed
  // window, ⌘/Ctrl-click → system browser.
  if (e.metaKey || e.ctrlKey) {
    window.api.openExternal(ext.dataset.url);
  } else {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg');
    window.api.openWirescope(ext.dataset.url, bg);
  }
});
document.addEventListener('mousedown', (e) => {
  if (costPopover.classList.contains('hidden')) return;
  if (costPopover.contains(e.target)) return;
  if (e.target.closest('[data-act="cost"]')) return; // toggle handled by the bar
  closeCostPopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !costPopover.classList.contains('hidden')) closeCostPopover();
});

// Always-reachable close buttons (a tall popover can put outside-click/Escape
// out of a user's reach — the ✕ never moves).
document.getElementById('tools-popover-close').addEventListener('click', closeToolsPopover);
document.getElementById('skills-popover-close').addEventListener('click', closeSkillsPopover);
document.getElementById('ctx-popover-close').addEventListener('click', closeContextPopover);
document.getElementById('cost-popover-close').addEventListener('click', closeCostPopover);

// ── Session report (wirescope /_report, report_version 1) ─────────────
// wirescope owns every number (pricing, cache math, thresholds, verdict
// score) — disk-based so it reads the full session capture, even on ended
// sessions. We only turn its structured findings into prose and assert the
// invariants it ships. Schema locked with wirescope; bump on report_version.
const reportOverlay = document.getElementById('report-overlay');
const reportNameEl = document.getElementById('report-name');
const reportBody = document.getElementById('report-body');

function closeReportPanel() { reportOverlay.classList.add('hidden'); reportOverlay.dataset.name = ''; }

function fmtUsd(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '$0';
  if (n >= 100) return '$' + n.toFixed(0);
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(n >= 0.1 ? 3 : 4);
}
function fmtDur(s) {
  if (!s) return '';
  if (s >= 3600) return (s / 3600).toFixed(1) + 'h';
  if (s >= 60) return Math.round(s / 60) + 'm';
  return Math.round(s) + 's';
}
function shortTs(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
  if (!m) return iso || '';
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m[2] - 1] || m[2];
  return `${mon} ${+m[3]} ${m[4]}:${m[5]}`;
}

// Stable colors shared by each stacked bar and its legend.
const REP_BUCKET_COLOR = {
  cache_read: '#61afef', cache_write_initial: '#56b6c2',
  cache_write_rewrite: '#e5c07b', uncached_input: '#e06c75', output: '#98c379',
};
const REP_BUCKET_LABEL = {
  cache_read: 'Cache read', cache_write_initial: 'Cache write (initial)',
  cache_write_rewrite: 'Cache write (rewrite)', uncached_input: 'Uncached input',
  output: 'Output',
};
const REP_CAT_COLOR = {
  system: '#61afef', claudemd: '#e5c07b', useremail: '#c678dd',
  skills: '#56b6c2', tools: '#98c379',
};

async function openReportPanel(name) {
  reportNameEl.textContent = name;
  reportOverlay.dataset.name = name;
  reportBody.innerHTML = '<div class="rep-note">Analyzing session capture…</div>';
  reportOverlay.classList.remove('hidden');
  const res = await window.api.getProxyReport(name);
  // Bail if the modal was closed/retargeted while the scan was in flight.
  if (reportOverlay.dataset.name !== name || reportOverlay.classList.contains('hidden')) return;
  if (!res || !res.ok) {
    reportBody.innerHTML = `<div class="rep-note">${esc(res && res.error ? res.error : 'Report unavailable')}</div>`;
    return;
  }
  try { reportBody.innerHTML = renderReport(res.data); }
  catch (e) { reportBody.innerHTML = `<div class="rep-note">Could not render report: ${esc(String((e && e.message) || e))}</div>`; }
}

function renderReport(d) {
  // Forward-compatible: render every field we understand, ignore the rest.
  // v1 = no `waste` section (renderWaste degrades to ''); v2 adds it; v3 made
  // carriage per-request; v4 scoped carriage waste to subagents (see
  // renderFindings). Unknown-but-newer reports still render their known fields.
  if (!d || typeof d.report_version !== 'number' || d.report_version < 1) {
    return `<div class="rep-note">Unsupported report${d ? ' (version ' + esc(String(d.report_version)) + ')' : ''}. Update Clodex.</div>`;
  }
  return [
    renderVerdict(d),
    renderCostDecomp(d.cost_decomposition),
    renderWaste(d.waste),
    renderTokenDecomp(d.token_decomposition),
    renderFindings(d.findings || []),
    renderInvariants(d),
  ].join('');
}

// "What was avoidable" (report_version >= 2) — the reclaimable subset of cost,
// aggregated by type, priced as the real net saving. Distinct question from
// cost_decomposition ("where every dollar went"): this is the consolidated
// headline that matches verdict.reclaimable_usd_total by construction. Compact
// rollup here; the per-line levers live in the detailed findings below.
// claudemd_carriage / useremail_carriage are subagent-scoped from v4 on (a
// subagent's inherited context, reclaimable via omit-on-spawn). Main-line
// carriage is informational, not waste — see renderFindings / renderInfoFinding.
const WASTE_LABELS = {
  cold_cache: 'Cold cache (re-writes)',
  deadweight_tools: 'Unused tools',
  deadweight_skills: 'Unused skills',
  claudemd_carriage: 'CLAUDE.md carried to subagents',
  useremail_carriage: 'User email carried to subagents',
};
function renderWaste(w) {
  if (!w || !Array.isArray(w.by_type) || !w.by_type.length) return '';
  const rows = w.by_type.map((t) => {
    const conf = t.confidence || 'medium';
    const meta = [`<span class="rep-conf rep-conf-${esc(conf)}">${esc(conf)}</span>`];
    if (t.items) meta.push(`<span>${t.items} item${t.items === 1 ? '' : 's'}</span>`);
    if (t.tokens) meta.push(`<span>${fmtTokens(t.tokens)} tok</span>`);
    return `<div class="rep-find"><div class="rep-find-top">` +
      `<span class="rep-find-title">${esc(WASTE_LABELS[t.type] || t.type)}</span>` +
      `<span class="rep-find-usd">${fmtUsd(t.usd)}</span></div>` +
      `<div class="rep-find-meta">${meta.join('')}</div></div>`;
  }).join('');
  return `<div class="rep-sec"><div class="rep-sec-head">What was avoidable — ${fmtUsd(w.total_usd)}` +
    (typeof w.pct_of_session === 'number' ? ` (${w.pct_of_session}% of session)` : '') +
    `</div>${rows}</div>`;
}

function renderVerdict(d) {
  const v = d.verdict || {};
  const rating = v.rating || 'unknown';
  const score = typeof v.score === 'number' ? v.score : '—';
  const sc = d.scope || {};
  const subs = (sc.agents || []).filter((a) => a.line === 'subagent');
  const span = (sc.first_ts && sc.last_ts) ? ` · ${esc(shortTs(sc.first_ts))} → ${esc(shortTs(sc.last_ts))}` : '';
  const scope = `${sc.requests || 0} requests · ${sc.turns || 0} turns` +
    (subs.length ? ` · ${subs.length} subagent line${subs.length === 1 ? '' : 's'}` : '') +
    (sc.models && sc.models.length ? ` · ${esc(sc.models.join(', '))}` : '') + span;
  return `<div class="rep-verdict">` +
    `<div class="rep-score rep-rating-${esc(rating)}"><span class="n">${score}</span><span class="l">${esc(rating)}</span></div>` +
    `<div class="rep-verdict-text">` +
    `<div class="rep-headline">${esc(v.headline || '')}</div>` +
    `<div class="rep-reclaim">Reclaimable: <b>${fmtUsd(v.reclaimable_usd_total)}</b>` +
    (typeof v.reclaimable_pct === 'number' ? ` (${v.reclaimable_pct}% of spend)` : '') +
    (v.confidence ? ` · ${esc(v.confidence)} confidence` : '') + `</div></div></div>` +
    `<div class="rep-scope">${scope}</div>`;
}

function renderCostDecomp(c) {
  if (!c || !Array.isArray(c.by_bucket)) return '';
  const total = c.total_usd || 0;
  const bars = c.by_bucket.map((b) =>
    `<i style="width:${Math.max(0.5, b.pct || 0)}%;background:${REP_BUCKET_COLOR[b.bucket] || '#888'}" ` +
    `title="${esc(REP_BUCKET_LABEL[b.bucket] || b.bucket)} ${fmtUsd(b.usd)}"></i>`).join('');
  const legend = c.by_bucket.map((b) =>
    `<div class="rep-leg-row"><span class="rep-leg-sw" style="background:${REP_BUCKET_COLOR[b.bucket] || '#888'}"></span>` +
    `<span class="rep-leg-name">${esc(REP_BUCKET_LABEL[b.bucket] || b.bucket)}</span>` +
    `<span class="rep-leg-nums">${fmtUsd(b.usd)} · ${b.pct}%</span></div>`).join('');
  // cache_misses is a localised drill-down of the cache_write_rewrite bucket
  // (already counted in by_bucket per the schema invariant) — render as a
  // sub-note, NEVER as an added segment.
  let miss = '';
  const m = c.cache_misses;
  if (m && m.count > 0) {
    const causes = Object.entries(m.by_cause || {}).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ');
    const biggest = (m.events || []).slice().sort((a, b) => (b.usd || 0) - (a.usd || 0))[0];
    const big = biggest && biggest.idle_gap_s
      ? ` — biggest a ${fmtDur(biggest.idle_gap_s)} gap (${fmtUsd(biggest.usd)})` : '';
    miss = `<div class="rep-sub">↳ <b>${m.count} cache miss${m.count === 1 ? '' : 'es'}</b> ` +
      `(${fmtUsd(m.usd)}${m.where ? ', ' + esc(m.where) : ''})${causes ? ' — ' + esc(causes) : ''}${big}. ` +
      `Re-wrote a preamble that had gone cold — keep-warm avoids it.</div>`;
  }
  return `<div class="rep-sec"><div class="rep-sec-head">Where the ${fmtUsd(total)} went</div>` +
    `<div class="rep-stack">${bars}</div><div class="rep-legend">${legend}</div>${miss}</div>`;
}

// report_version 3 renamed the carriage fields per-turn → per-request (the
// prefix is re-sent on every wire request, not every human turn — and turns
// now means genuine user prompts). Read the v3 name, fall back to the v2 name
// so we render v2 and v3 proxies identically through the rollout.
function vget(obj, v3key, v2key) {
  if (!obj) return undefined;
  return obj[v3key] != null ? obj[v3key] : obj[v2key];
}

function renderTokenDecomp(t) {
  if (!t || !t.preamble) return '';
  const p = t.preamble;
  const perReq = p.tokens_per_request != null; // v3 unit
  const unit = perReq ? '/req' : '/turn';
  const per = vget(p, 'tokens_per_request', 'tokens_per_turn') || 0;
  const resent = vget(p, 'requests_resent', 'turns_resent') || 0;
  const unused = vget(p, 'unused_tokens_per_request', 'unused_tokens_per_turn') || 0;
  const cats = (p.by_category || [])
    .map((c) => ({ category: c.category, v: vget(c, 'tokens_per_request', 'tokens_per_turn') || 0 }))
    .filter((c) => c.v > 0);
  const bars = cats.map((c) =>
    `<i style="width:${Math.max(0.5, per ? (c.v / per) * 100 : 0)}%;background:${REP_CAT_COLOR[c.category] || '#888'}" ` +
    `title="${esc(ctxCatLabel(c.category))} ${fmtTokens(c.v)}${unit}"></i>`).join('');
  const legend = cats.map((c) =>
    `<div class="rep-leg-row"><span class="rep-leg-sw" style="background:${REP_CAT_COLOR[c.category] || '#888'}"></span>` +
    `<span class="rep-leg-name">${esc(ctxCatLabel(c.category))}</span>` +
    `<span class="rep-leg-nums">${fmtTokens(c.v)}${unit}</span></div>`).join('');
  const sub = `<div class="rep-sub">${fmtTokens(per)}${unit} re-sent ${resent}× = ` +
    `${fmtTokens(p.total_resent_tokens || 0)} total` +
    (unused ? ` · <b>${fmtTokens(unused)}${unit} never used</b>` : '') +
    (p.stable === false ? ' · estimate' : '') + `</div>`;
  return `<div class="rep-sec"><div class="rep-sec-head">Your request preamble (reloaded every ${perReq ? 'request' : 'turn'})</div>` +
    `<div class="rep-stack">${bars}</div><div class="rep-legend">${legend}</div>${sub}</div>`;
}

// report_version 4 made claudemd/useremail carriage SUBAGENT-scoped: the
// `*_carriage` waste types now only come from a subagent's inherited context
// (reclaimable via omit-on-spawn). Main-line carriage instead surfaces as
// informational `main_*_carriage` findings — additive:false, reclaimable_usd:0
// — so the report no longer mislabels intentional main-agent CLAUDE.md as waste.
const isMainCarriage = (f) => /^main_[a-z]+_carriage$/.test(f.category || '');

function renderFindings(findings) {
  if (!findings.length) return '';
  const additive = findings.filter((f) => f.additive !== false);
  const nonAdditive = findings.filter((f) => f.additive === false);
  const info = nonAdditive.filter(isMainCarriage);          // v4 informational
  const heuristic = nonAdditive.filter((f) => !isMainCarriage(f));
  let html = `<div class="rep-sec"><div class="rep-sec-head">Recommendations</div>`;
  html += additive.length
    ? additive.map(renderFinding).join('')
    : '<div class="rep-note">No reclaimable waste found — this session is lean.</div>';
  if (heuristic.length) {
    html += `<div class="rep-group collapsed">` +
      `<div class="rep-group-head" data-act="rep-toggle">▸ ${heuristic.length} possible (heuristic, not scored)</div>` +
      heuristic.map(renderFinding).join('') + `</div>`;
  }
  if (info.length) {
    html += `<div class="rep-group collapsed">` +
      `<div class="rep-group-head" data-act="rep-toggle">▸ ${info.length} informational (main-line context, not reclaimable)</div>` +
      info.map(renderInfoFinding).join('') + `</div>`;
  }
  return html + `</div>`;
}

// v4 main-line carriage: factual, not waste. Render dimmed and with NO $ — and
// deliberately do NOT surface reclaimable_tokens_per_request: on these findings
// it carries the carried prefix size (e.g. 2237), not a saving, so the standard
// renderFinding's "/req" meta would re-imply the very waste v4 stopped claiming.
// The hypothetical evidence.carriage_usd_if_omittable is likewise not shown as $.
function renderInfoFinding(f) {
  const meta = [];
  if (f.requests != null) meta.push(`over ${f.requests} request${f.requests === 1 ? '' : 's'}`);
  return `<div class="rep-find low">` +
    `<div class="rep-find-top"><span class="rep-find-title">${esc(f.title || f.category || '')}</span></div>` +
    (f.detail ? `<div class="rep-find-detail">${esc(f.detail)}</div>` : '') +
    (f.lever ? `<div class="rep-lever">${esc(f.lever)}</div>` : '') +
    `<div class="rep-find-meta"><span class="rep-conf rep-conf-low">info</span>` +
    meta.map((mm) => `<span>${esc(mm)}</span>`).join('') + `</div></div>`;
}

function renderFinding(f) {
  const conf = f.confidence || 'medium';
  const ev = f.evidence || {};
  const meta = [];
  const reclaimPer = vget(f, 'reclaimable_tokens_per_request', 'reclaimable_tokens_per_turn');
  if (reclaimPer) meta.push(`${fmtTokens(reclaimPer)}${f.reclaimable_tokens_per_request != null ? '/req' : '/turn'}`);
  // v3 split the old per-finding `turns` count by type: requests (carriage),
  // events (cache misses), occurrences (low-conf heuristics).
  if (f.requests != null) meta.push(`over ${f.requests} requests`);
  else if (f.events != null) meta.push(`${f.events} event${f.events === 1 ? '' : 's'}`);
  else if (f.occurrences != null) meta.push(`${f.occurrences}×`);
  else if (f.turns != null) meta.push(`over ${f.turns} turns`);
  if (ev.loaded != null && ev.used != null) meta.push(`${ev.used}/${ev.loaded} used`);
  return `<div class="rep-find${conf === 'low' ? ' low' : ''}">` +
    `<div class="rep-find-top"><span class="rep-find-title">${esc(f.title || f.category || '')}</span>` +
    (f.reclaimable_usd ? `<span class="rep-find-usd">${fmtUsd(f.reclaimable_usd)}</span>` : '') + `</div>` +
    (f.detail ? `<div class="rep-find-detail">${esc(f.detail)}</div>` : '') +
    (f.lever ? `<div class="rep-lever">${esc(f.lever)}</div>` : '') +
    `<div class="rep-find-meta"><span class="rep-conf rep-conf-${esc(conf)}">${esc(conf)}</span>` +
    meta.map((mm) => `<span>${esc(mm)}</span>`).join('') + `</div></div>`;
}

function renderInvariants(d) {
  // wirescope guarantees these; we re-assert so a regression surfaces loudly
  // rather than as silently contradictory numbers in the render.
  const issues = [];
  const c = d.cost_decomposition;
  if (c && Array.isArray(c.by_bucket) && typeof (d.totals && d.totals.est_usd) === 'number') {
    const sum = c.by_bucket.reduce((a, b) => a + (b.usd || 0), 0);
    if (Math.abs(sum - d.totals.est_usd) > 0.01) issues.push('cost buckets don’t sum to total');
  }
  const t = d.token_decomposition && d.token_decomposition.preamble;
  const unusedPer = vget(t, 'unused_tokens_per_request', 'unused_tokens_per_turn');
  if (t && Array.isArray(d.findings) && unusedPer != null) {
    // The preamble is the main line's; subagent deadweight has its own per-unit
    // budget and must not count against it (schema invariant is main-scoped).
    // Same identity in v2 (_per_turn) and v3 (_per_request).
    const dead = d.findings
      .filter((f) => /^deadweight_/.test(f.category || '') && f.line === 'main')
      .reduce((a, f) => a + (vget(f, 'reclaimable_tokens_per_request', 'reclaimable_tokens_per_turn') || 0), 0);
    if (Math.abs(dead - unusedPer) > 1) issues.push('unused-preamble ≠ deadweight findings');
  }
  // v2: the waste rollup is the reclaimable subset and must equal the verdict's
  // headline number by construction.
  if (d.waste && typeof d.waste.total_usd === 'number' && typeof (d.verdict && d.verdict.reclaimable_usd_total) === 'number') {
    if (Math.abs(d.waste.total_usd - d.verdict.reclaimable_usd_total) > 0.01) issues.push('waste total ≠ verdict reclaimable');
  }
  if (issues.length) return `<div class="rep-inv bad">⚠ Consistency check failed: ${esc(issues.join('; '))}</div>`;
  return `<div class="rep-inv">Internally consistent · basis: ${esc((d.totals && d.totals.basis) || d.basis || 'on-disk capture')}</div>`;
}

document.getElementById('report-close').addEventListener('click', closeReportPanel);
reportOverlay.addEventListener('mousedown', (e) => { if (e.target === reportOverlay) closeReportPanel(); });
reportBody.addEventListener('click', (e) => {
  const tog = e.target.closest('[data-act="rep-toggle"]');
  if (!tog) return;
  const g = tog.closest('.rep-group');
  if (!g) return;
  const collapsed = g.classList.toggle('collapsed');
  tog.textContent = (collapsed ? '▸ ' : '▾ ') + tog.textContent.replace(/^[▸▾]\s*/, '');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !reportOverlay.classList.contains('hidden')) closeReportPanel();
});

window.api.onSessionMention((name, mtype /* 'dm' */) => {
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
  entry.className = 'ipc-entry';

  const fromBadge = `<span class="ipc-from">${esc(msg.from)}</span>`;
  const arrow = `<span class="ipc-arrow">→</span>`;
  const targetBadge = `<span class="ipc-to">${esc(msg.to)}</span>`;
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

// ---------------------------------------------------------------------------
// Spawn diagnostics banner — surfaces a broken-install warning (the usual
// cause of "posix_spawnp failed.") so Finder-launched users who never see
// stdout still get a pointer to `npx electron-rebuild`.
// ---------------------------------------------------------------------------

const diagBanner = document.getElementById('diag-banner');
const diagText = document.getElementById('diag-text');
let diagDetails = '';

async function refreshDiagBanner() {
  try {
    const d = await window.api.getDiagnostics();
    if (d && d.warning) {
      diagText.textContent = d.warning;
      diagDetails = `${d.warning}\n${d.summary}\nhelper=${d.helperPath}`;
      diagBanner.classList.remove('hidden');
    } else {
      diagBanner.classList.add('hidden');
    }
  } catch { /* diagnostics are best-effort */ }
}

// Clicking copies the full details so users can paste them into a bug report.
diagBanner.addEventListener('click', () => {
  if (!diagDetails) return;
  navigator.clipboard.writeText(diagDetails).then(() => {
    const prev = diagText.textContent;
    diagText.textContent = 'Copied diagnostics to clipboard';
    setTimeout(() => { diagText.textContent = prev; }, 1500);
  }).catch(() => {});
});

refreshDiagBanner();

// Tray-triggered actions
window.api.onRequestSwitchSession((name) => switchSession(name));
window.api.onRequestOpenNewDialog(() => openDialog());
window.api.onRequestOpenAgentsDrawer((name) => openAgentsDrawer(name));
window.api.onRequestOpenPromptsDrawer(() => openPromptsDrawer());
window.api.onRequestOpenIpcLog(() => {
  if (ipcLog.classList.contains('collapsed')) toggleIpcLog();
});

// ---------------------------------------------------------------------------
// Preferences dialog
// ---------------------------------------------------------------------------

const prefsOverlay = document.getElementById('prefs-overlay');
const prefsClaudeBox = document.getElementById('prefs-claude-components');
const prefsClaudeCmd = document.getElementById('prefs-claude-sl-cmd');
const prefsCodexBox = document.getElementById('prefs-codex-components');
const prefsProxyEnabled = document.getElementById('prefs-proxy-enabled');
const prefsDisableDesignMcp = document.getElementById('prefs-disable-design-mcp');
const prefsCompactOnResume = document.getElementById('prefs-compact-on-resume');
const prefsToolsRow = document.getElementById('prefs-tools-row');
const prefsToolsList = document.getElementById('prefs-tools-list');
wireBulkToggles(prefsToolsRow, prefsToolsList);
const wsDot = document.getElementById('ws-dot');
const wsStatusText = document.getElementById('ws-status-text');
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

// Read-only proxy health line under the Traffic optimization toggle. The
// proxy lifecycle is fully Clodex-managed (autostart on launch/settings-save,
// vendored source, managed venv) so there is deliberately NO start/stop/port/
// dir UI — status is the only surface. Power users: wirescopeDir/wirescopePort
// in ui-settings.json still override the bundled copy (no UI on purpose).
const WS_DOT = { managed: '#3fb950', external: '#58a6ff', starting: '#d29922', installing: '#d29922', stopped: '#888', error: '#f85149' };

function renderWsStatus(st) {
  const err = st && st.error;
  let color = WS_DOT[st ? st.state : 'stopped'] || '#888';
  let text;
  if (st && st.state === 'managed') {
    text = `Active${st.version ? ' — ' + st.version : ''}`;
  } else if (st && st.state === 'external') {
    text = `Active — using the proxy already running on this machine${st.version ? ' (' + st.version + ')' : ''}`;
  } else if (st && st.state === 'installing') {
    text = 'Setting up — installing the Python environment (first run only)…';
  } else if (st && st.state === 'starting') {
    text = 'Starting…';
  } else if (err) {
    text = err;
    color = WS_DOT.error;
  } else {
    text = prefsProxyEnabled.checked ? 'Not running' : 'Off';
  }
  wsDot.style.background = color;
  wsStatusText.textContent = text;
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
  prefsDisableDesignMcp.checked = s.disableClaudeDesignMcp !== false;
  prefsCompactOnResume.checked = !!s.compactOnResume;
  // Global default tool-deny set (cwd-independent, so no lower-layer provenance).
  // Unchecked = denied by default for new sessions.
  claudeToolsCache = s.claudeTools || [];
  renderToolChecklist(prefsToolsList, new Set(s.defaultToolDeny || []), {});
  prefsOverlay.classList.remove('hidden');
  refreshWsStatus();
  if (wsPollTimer) clearInterval(wsPollTimer);
  wsPollTimer = setInterval(refreshWsStatus, 1500);
}

function closePrefs() {
  prefsOverlay.classList.add('hidden');
  if (wsPollTimer) { clearInterval(wsPollTimer); wsPollTimer = null; }
}

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
    disableClaudeDesignMcp: prefsDisableDesignMcp.checked,
    compactOnResume: prefsCompactOnResume.checked,
  });
  // Default tool denies live in a separate store (the "*" agent-default), so
  // persist them via their own setter. collectToolChecklist returns the
  // unchecked (= denied) tools.
  await window.api.setDefaultToolDeny(collectToolChecklist(prefsToolsList));
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
const argsSystemPrompt = document.getElementById('args-system-prompt');
const argsAppendRow = document.getElementById('args-append-row');
const argsAppendList = document.getElementById('args-append-list');
const argsAppendSection = document.getElementById('args-append-section');
const argsAgentsRow = document.getElementById('args-agents-row');
const argsAgentsList = document.getElementById('args-agents-list');
const argsBuiltinsList = document.getElementById('args-builtins-list');
const argsToolsRow = document.getElementById('args-tools-row');
const argsToolsList = document.getElementById('args-tools-list');
const argsToolsSection = document.getElementById('args-tools-section');
const argsOtherSection = document.getElementById('args-other-section');
wireBulkToggles(argsToolsRow, argsToolsList);
let argsEditingName = null;

argsProxyMode.addEventListener('change', () => {
  argsProxyUrl.style.display = argsProxyMode.value === 'custom' ? '' : 'none';
  if (argsProxyMode.value === 'custom') argsProxyUrl.focus();
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
  promptLibCache = {
    system: (promptLib || []).filter(p => p.kind === 'system'),
    append: (promptLib || []).filter(p => p.kind === 'append'),
  };
  argsEditingName = name;
  argsTarget.textContent = `${name} (${res.type}) — new settings apply on next spawn.`;
  argsInput.value = (res.extraArgs || []).map(a => /\s/.test(a) ? `"${a}"` : a).join(' ');
  const isAgent = res.type === 'claude' || res.type === 'codex';
  argsProxyRow.style.display = isAgent ? '' : 'none';
  setProxyControls(argsProxyMode, argsProxyUrl, res.proxy, settings?.proxyUrl);
  labelProxyDefault(argsProxyMode, settings);
  // Prompt rows drive the save-time collect logic via their display; the
  // accordion sections that wrap them are toggled per type so inapplicable
  // sections don't show as empty boxes. Sections start collapsed each open.
  argsPromptRow.style.display = isAgent ? '' : 'none';
  argsAppendRow.style.display = isAgent ? '' : 'none';
  argsAppendSection.style.display = isAgent ? '' : 'none';
  fillSystemPromptSelect(argsSystemPrompt, res.systemPromptFile || '');
  renderAppendChecklist(argsAppendList, new Set(res.appendPromptFiles || []));
  // Custom subagents + tools — Claude-only.
  const isClaude = res.type === 'claude';
  argsAgentsRow.style.display = isClaude ? '' : 'none';
  argsOtherSection.style.display = isClaude ? '' : 'none';
  renderAgentChecklist(argsAgentsList, new Set(res.agents || []));
  renderBuiltinChecklist(argsBuiltinsList, new Set(res.denyBuiltins || []));
  argsToolsRow.style.display = isClaude ? '' : 'none';
  argsToolsSection.style.display = isClaude ? '' : 'none';
  claudeToolsCache = settings?.claudeTools || [];
  renderToolChecklist(argsToolsList, new Set(res.disabledTools || []), res.effectiveTools || {});
  for (const sec of [argsAppendSection, argsToolsSection, argsOtherSection]) sec.open = false;
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
  const promptsHidden = argsPromptRow.style.display === 'none';
  const systemPromptFile = promptsHidden ? null : (argsSystemPrompt.value || null);
  const appendPromptFiles = promptsHidden ? [] : collectAppendChecklist(argsAppendList);
  const agents = argsAgentsRow.style.display === 'none' ? [] : collectAgentChecklist(argsAgentsList);
  const denyBuiltins = argsAgentsRow.style.display === 'none'
    ? [] : collectBuiltinChecklist(argsBuiltinsList);
  const disabledTools = argsToolsRow.style.display === 'none' ? [] : collectToolChecklist(argsToolsList);
  const name = argsEditingName;
  // Snapshot metadata from the current sidebar entry so we can re-render it
  // after the kill+respawn wipes it via session-exit.
  const existing = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  const snapType = existing ? existing.querySelector('.session-type')?.textContent : null;
  const snapCwd = existing ? existing.dataset.cwd : null;
  closeArgsDialog();
  // systemPrompt (legacy inline) passes undefined so a pre-library inline body
  // survives; disabledSkills/injectSkills likewise (handler preserves on undefined).
  const res = await window.api.setSessionArgs(name, parsed, restart, proxy, undefined, agents, denyBuiltins, disabledTools, undefined, undefined, systemPromptFile, appendPromptFiles);
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
const promptKind = document.getElementById('prompt-kind');
const promptName = document.getElementById('prompt-name');
const promptBody = document.getElementById('prompt-body');
const promptSave = document.getElementById('prompt-save');
const promptCancel = document.getElementById('prompt-cancel');
const promptDelete = document.getElementById('prompt-delete');
const promptsNew = document.getElementById('prompts-new');
const promptsClose = document.getElementById('prompts-close');

// {kind, name} of the prompt being edited (its filename identity is locked while
// editing — rename = delete + new), or null when authoring a new one.
let editingPrompt = null;

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
      <div class="prompt-item-title">${esc(p.name)} <span class="prompt-kind-badge">${esc(p.kind)}</span></div>
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
    editingPrompt = { kind: prompt.kind, name: prompt.name };
    promptEditorTitle.textContent = 'Edit Prompt';
    promptKind.value = prompt.kind;
    promptKind.disabled = true; // kind+name = the file identity; locked while editing
    promptName.value = prompt.name;
    promptName.readOnly = true;
    promptBody.value = prompt.body;
    promptDelete.style.display = '';
  } else {
    editingPrompt = null;
    promptEditorTitle.textContent = 'New Prompt';
    promptKind.value = 'append';
    promptKind.disabled = false;
    promptName.value = '';
    promptName.readOnly = false;
    promptBody.value = '';
    promptDelete.style.display = 'none';
  }
  promptEditor.classList.remove('hidden');
  setTimeout(() => (editingPrompt ? promptBody : promptName).focus(), 50);
}

function closePromptEditor() {
  promptEditor.classList.add('hidden');
  editingPrompt = null;
}

promptsClose.addEventListener('click', closePromptsDrawer);
promptsNew.addEventListener('click', () => openPromptEditor(null));

promptSave.addEventListener('click', async () => {
  const kind = promptKind.value;
  const name = promptName.value.trim();
  const body = promptBody.value;
  if (!name || !body.trim()) return;
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
    promptName.style.borderColor = '#e94560';
    return;
  }
  promptName.style.borderColor = '';
  const res = await window.api.savePrompt(kind, name, body);
  if (res && res.ok === false) { alert(`Failed: ${res.error || 'unknown error'}`); return; }
  closePromptEditor();
  refreshPromptsList();
});

promptCancel.addEventListener('click', closePromptEditor);
promptDelete.addEventListener('click', async () => {
  if (!editingPrompt) return;
  if (!confirm(`Delete prompt "${editingPrompt.name}"?`)) return;
  await window.api.removePrompt(editingPrompt.kind, editingPrompt.name);
  closePromptEditor();
  refreshPromptsList();
});

// Prevent keyboard shortcuts from firing inside the editor
promptName.addEventListener('keydown', (e) => e.stopPropagation());
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

function openAgentsDrawer(name) {
  agentsDrawer.classList.remove('hidden');
  refreshAgentsList();
  // Deep-link from the Agents menu: ':new' opens a blank editor, any other
  // name jumps straight into that type's editor.
  if (name === ':new') openAgentEditor(null);
  else if (name) openAgentEditor({ name });
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
// Skill library — custom skills stored as ~/.clodex/skills/*.md, injected per
// session via --plugin-dir. Mirrors the agents drawer.
// ---------------------------------------------------------------------------

const skillsDrawer = document.getElementById('skills-drawer');
const skillsListEl = document.getElementById('skills-list');
const skillsEmpty = document.getElementById('skills-empty');
const skillEditor = document.getElementById('skill-editor');
const skillEditorTitle = document.getElementById('skill-editor-title');
const skillNameInput = document.getElementById('skill-name');
const skillContent = document.getElementById('skill-content');
const skillSave = document.getElementById('skill-save');
const skillCancel = document.getElementById('skill-cancel');
const skillDelete = document.getElementById('skill-delete');
const skillsNew = document.getElementById('skills-new');
const skillsClose = document.getElementById('skills-close');

let editingSkillName = null;

async function refreshSkillsLibList() {
  const items = await window.api.listSkillLib();
  skillLibCache = items || [];
  skillsListEl.innerHTML = '';
  if (!items || items.length === 0) {
    skillsEmpty.style.display = '';
    return;
  }
  skillsEmpty.style.display = 'none';
  for (const s of items) {
    const el = document.createElement('div');
    el.className = 'prompt-item';
    el.innerHTML = `
      <div class="prompt-item-title">${esc(s.name)}</div>
      <div class="prompt-item-preview">${esc(s.description || '(no description)')}</div>
      <div class="prompt-item-actions">
        <button data-action="edit">Edit</button>
      </div>
    `;
    el.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
      e.stopPropagation();
      openSkillEditor(s);
    });
    el.addEventListener('click', () => openSkillEditor(s));
    skillsListEl.appendChild(el);
  }
}

function openSkillsDrawer(name) {
  skillsDrawer.classList.remove('hidden');
  refreshSkillsLibList();
  if (name === ':new') openSkillEditor(null);
  else if (name) openSkillEditor({ name });
}
function closeSkillsDrawer() {
  skillsDrawer.classList.add('hidden');
}

async function openSkillEditor(skill = null) {
  if (skill) {
    editingSkillName = skill.name;
    skillEditorTitle.textContent = 'Edit Skill';
    skillNameInput.value = skill.name;
    skillContent.value = (await window.api.getSkillLib(skill.name)) || '';
    skillDelete.style.display = '';
  } else {
    editingSkillName = null;
    skillEditorTitle.textContent = 'New Skill';
    skillNameInput.value = '';
    skillContent.value = '---\ndescription: When to use this skill — be specific so the model picks it at the right moment.\n---\nStep-by-step instructions for the model.';
    skillDelete.style.display = 'none';
  }
  skillNameInput.style.borderColor = '';
  skillEditor.classList.remove('hidden');
  setTimeout(() => skillNameInput.focus(), 50);
}
function closeSkillEditor() {
  skillEditor.classList.add('hidden');
  editingSkillName = null;
}

skillsClose.addEventListener('click', closeSkillsDrawer);
skillsNew.addEventListener('click', () => openSkillEditor(null));

skillSave.addEventListener('click', async () => {
  const name = skillNameInput.value.trim();
  const content = skillContent.value;
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
    skillNameInput.style.borderColor = '#e94560';
    return;
  }
  const res = await window.api.saveSkillLib(name, content);
  if (!res || !res.ok) {
    alert(`Failed: ${res && res.error ? res.error : 'unknown error'}`);
    return;
  }
  // Rename: a changed Name field writes a new file — drop the old one.
  if (editingSkillName && editingSkillName !== name) {
    await window.api.removeSkillLib(editingSkillName);
  }
  closeSkillEditor();
  refreshSkillsLibList();
});

skillCancel.addEventListener('click', closeSkillEditor);
skillDelete.addEventListener('click', async () => {
  if (!editingSkillName) return;
  if (!confirm(`Delete skill "${editingSkillName}"?`)) return;
  await window.api.removeSkillLib(editingSkillName);
  closeSkillEditor();
  refreshSkillsLibList();
});

skillNameInput.addEventListener('keydown', (e) => e.stopPropagation());
skillContent.addEventListener('keydown', (e) => e.stopPropagation());
skillNameInput.addEventListener('input', () => { skillNameInput.style.borderColor = ''; });

window.api.onRequestOpenSkillsDrawer((name) => openSkillsDrawer(name));

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
