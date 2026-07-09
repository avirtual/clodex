const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SearchAddon } = require('@xterm/addon-search');
const { PendingInput } = require('../peer-input-queue');
const { versionSeverity, updateApplies, releaseAgeInfo } = require('../proxy-util');
const { STRIP_LEVELS, SEV_LINE, CTX_CAT_LABELS, COST_SPINE, COST_CONTENT, BUST_FAULT, REP_BUCKET_COLOR, REP_BUCKET_LABEL, REP_CAT_COLOR } = require('./lib/constants');
const { esc, shortPath, fmtTokens, fmtCountdown, fmtAgo, fmtUsd, fmtDur, shortTs, fmtBustTokens, fmtBytes } = require('./lib/format');
const { renderDiffHtml, costStackBlock, svgCostChart, bustRow } = require('./lib/render-html');
const { renderAppendChecklist, collectAppendChecklist, renderAgentChecklist, collectAgentChecklist, renderBuiltinChecklist, collectBuiltinChecklist, renderInjectChecklist, collectInjectChecklist, renderToolChecklist, collectToolChecklist, renderSkillChecklist, collectSkillChecklist, setChecklistAll, wireBulkToggles, setPromptLibCache, setAgentLibCache, setSkillLibCache, setClaudeToolsCache, setDefaultToolDenyCache, getPromptLibCache, getSkillLibCache, getDefaultToolDenyCache } = require('./lib/checklists');
const { createIpcLog } = require('./ipc-log');
const { createTermSearch } = require('./term-search');
const { initBanners } = require('./banners');
const { initThemes } = require('./themes');
const { initLibraryDrawers } = require('./library-drawers');
const { initSubagentPopover } = require('./subagent-popover');

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
// FLAG: applyTheme live-swaps every open terminal's palette, so the island
// takes the sessions Map as a factory param. currentXtermTheme is destructured
// out for createSession to read at terminal creation.
const { currentXtermTheme } = initThemes({ sessions });

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

// Restart a PEER session in place and keep our attached tab live on the fresh
// process — the peer analogue of restartSessionWithReattach. The owner kills the
// old PTY (which sends an SSE `exit` that tears our tab down via onPeerExit, also
// fully detaching the peer-client attachment) and respawns the SAME name, so we
// re-open the attach afterward. The exit event and the restart ack race across
// two transports; the ack resolves only after the owner's respawn completes, and
// the exit (sent at kill time) normally lands first, so by the time we're here
// the tab is already gone. We still poll briefly for the teardown to settle
// before re-opening, so we never attach onto a tab the exit is about to remove.
// (If the exit is somehow missed, the stream-close reconnect in peer-client
// heals it instead — belt and suspenders.)
async function restartPeerSessionWithReattach(id, name, fresh) {
  const key = peerKey(id, name);
  const st = peerStatuses.get(id);
  const label = peerDisplayHost(st);
  const wasAttached = sessions.has(key);
  const res = await window.api.peerRestartSession(id, name, { fresh: !!fresh });
  if (!res || !res.ok) {
    showToast(`${fresh ? 'Reload' : 'Restart'} failed for "${name}" on ${label}: ${(res && res.error) || 'no response'}`, { kind: 'warm' });
    return;
  }
  showToast(`${fresh ? 'Reloaded' : 'Restarted'} "${name}" on ${label}.`, { kind: 'peer-ui' });
  if (!wasAttached) return;   // wasn't showing it — nothing to reattach
  let tries = 20;             // ~2s at 100ms — the exit-driven teardown window
  const reattach = () => {
    if (!sessions.has(key)) { openPeerSession(id, name); return; }
    if (tries-- <= 0) return; // teardown never came; auto-reconnect covers it
    setTimeout(reattach, 100);
  };
  reattach();
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
  if (isSubagentPopoverForParent(name)) closeSubagentPopover();
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

// peer (optional): { id, name, controlled } marks a terminal attached to a
// session on a peered Clodex — keystrokes go to the peer (only in control
// mode) and geometry follows the owner unless we hold control.
function createTerminal(name, peer = null) {
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
      if (resultCount === 0) setSearchInfo('no matches');
      else setSearchInfo(`${resultIndex + 1}/${resultCount}`);
    }
  });

  const wrapperEl = document.createElement('div');
  wrapperEl.className = 'terminal-wrapper';
  wrapperEl.dataset.name = name;
  terminalContainer.appendChild(wrapperEl);

  terminal.open(wrapperEl);

  // Send keystrokes to PTY. Peer terminals: pass through while holding control;
  // otherwise the first data-producing key auto-takes control (buffering what
  // you type during the acquire). onData only fires for actual input, so plain
  // clicks / scroll / copy never trigger it — passive browsing stays passive.
  terminal.onData((data) => {
    if (peer) {
      if (peer.controlled) {
        // If control landed via the owner's control-change broadcast before our
        // acquire promise resolved, the pending buffer may not have drained yet.
        // Flush it first so keystrokes never reorder around the flip.
        if (peer.pendingInput && peer.pendingInput.size) {
          const buffered = peer.pendingInput.drain();
          if (buffered) window.api.peerInput(peer.id, peer.name, buffered);
        }
        window.api.peerInput(peer.id, peer.name, data);
        return;
      }
      typeToTakeControl(name, data);
      return;
    }
    window.api.writeToSession(name, data);
  });

  sessions.set(name, { terminal, fitAddon, searchAddon, wrapperEl, peer });
  updateWindowTitle();
  return { terminal, fitAddon, searchAddon, wrapperEl };
}

// Read-only peer re-measure: xterm can hold stale char metrics when its pane
// was visibility:hidden (auto-restore attaches without switching) or when the
// pane geometry shifted while a reconnect replayed into an already-active tab.
// A fit() forces a re-measure against the now-visible pane, then we resize back
// to the canonical owner letterbox and repaint. INVARIANT: this pushes nothing
// upstream — read-only tabs have no onResize→peerResize wiring, so the fit()'s
// dims never leave the viewer; geometry authority stays with the owner. Shared
// by switchSession (on activate) and onPeerReplay (reconnect on the active tab)
// so the exact sequence can't drift between the two.
function remeasureReadonlyPeer(entry) {
  const { fitAddon, terminal } = entry;
  fitAddon.fit();
  if (entry.peer && entry.peer.cols && entry.peer.rows) {
    terminal.resize(entry.peer.cols, entry.peer.rows);
  }
  terminal.refresh(0, terminal.rows - 1);
}

function switchSession(name) {
  if (!sessions.has(name)) return;

  // Close search if open — decorations are per-terminal
  if (isSearchOpen()) closeSearch();
  if (isSubagentPopoverOpen()) closeSubagentPopover();

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

  renderPeerBar();

  // Fit and focus after becoming visible. Peer terminals in read-only mode
  // keep the owner's geometry (letterbox) — fitting would be a resize we
  // have no authority to send.
  const entry = sessions.get(name);
  const { fitAddon, terminal } = entry;
  requestAnimationFrame(() => {
    if (entry.peer) {
      if (entry.peer.controlled) {
        fitAddon.fit();
        window.api.peerResize(entry.peer.id, entry.peer.name, terminal.cols, terminal.rows);
      } else {
        // Read-only peer: replay/output can have been written while this
        // wrapper was visibility:hidden (auto-restore attaches without ever
        // switching here), so xterm holds stale char metrics and paints
        // garbled. Re-measure against the now-visible pane. Runs on every switch
        // (idempotent) to cover a pane resized while the tab was hidden.
        remeasureReadonlyPeer(entry);
      }
      terminal.focus();
      return;
    }
    fitAddon.fit();
    window.api.resizeSession(name, terminal.cols, terminal.rows);
    terminal.focus();
  });
}

function removeSession(name) {
  const s = sessions.get(name);
  if (s) {
    if (s.peer) {
      // Detach (main forgets both peerAttached + peerControlled durably); keep
      // the local control mirror in step so a re-added tab starts read-only.
      window.api.peerDetach(s.peer.id, s.peer.name);
      forgetControlMirror(s.peer.id, s.peer.name);
    }
    s.terminal.dispose();
    s.wrapperEl.remove();
    sessions.delete(name);
  }
  removeSessionFromSidebar(name);
  updateWindowTitle();
  proxyState.delete(name);
  ctxPct.delete(name);
  ctxTokens.delete(name);
  filesState.delete(name);
  filesUnseen.delete(name);
  peerFilesCount.delete(name);

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

async function loadPromptLib() {
  const all = await window.api.listPrompts();
  setPromptLibCache({
    system: all.filter(p => p.kind === 'system'),
    append: all.filter(p => p.kind === 'append'),
  });
}

function fillSystemPromptSelect(selectEl, current) {
  while (selectEl.options.length > 1) selectEl.remove(1);
  for (const p of getPromptLibCache().system) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    selectEl.appendChild(opt);
  }
  // A persisted ref whose file was deleted falls back to (CLI default).
  selectEl.value = current && getPromptLibCache().system.some(p => p.name === current) ? current : '';
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

async function refreshNewSessionInjectSkills(enabledSet = new Set()) {
  if (inputType.value !== 'claude') return;
  setSkillLibCache((await window.api.listSkillLib()) || []);
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
  renderToolChecklist(inputToolsList, new Set(getDefaultToolDenyCache()), (res && res.ok && res.effective) || {});
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
  setAgentLibCache(agentLib || []);
  renderAgentChecklist(inputAgentsList, new Set());
  renderBuiltinChecklist(inputBuiltinsList, new Set());
  setClaudeToolsCache(settings?.claudeTools || []);
  setDefaultToolDenyCache(settings?.defaultToolDeny || []);
  renderToolChecklist(inputToolsList, new Set(getDefaultToolDenyCache()));
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

// Needs-attention badge: the session's CLI is blocked on the human (permission
// dialog / unknown notification). attn is {kind, message, ts} or null; main
// owns set/clear (keystroke or turn resume clears it there).
window.api.onSessionAttention((name, attn) => {
  const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (!el) return;
  if (attn) {
    el.dataset.attention = attn.kind;
    el.title = attn.message || 'Needs your attention';
  } else {
    delete el.dataset.attention;
    el.removeAttribute('title');
  }
});

// ---------------------------------------------------------------------------
// Peered Clodexes — sessions running on another machine's Clodex, reached
// through its remote server (loopback + SSH tunnel/tailnet). This side is a
// thin adapter: all protocol/reconnect logic lives in main's peer-client.js.
// A peer being offline is normal (laptops sleep) — render calm, never error.
// ---------------------------------------------------------------------------

const peerStatuses = new Map(); // peerId -> status from peer-state events
const peerTunnels = new Map();  // peerId -> managed-tunnel status (may lag peerStatuses)
// Our own app version, cached once for the peer identity "outdated" hint (a peer
// reporting a different version in its hello). null until fetched / if it fails.
let ourAppVersion = null;
window.api.getVersion().then((v) => { ourAppVersion = v || null; }).catch(() => {});
// Cached GitHub release list ([{tag, published_at}] newest-first) for the peer
// identity popover's best-effort age/behind line. Seeded once and refreshed
// when a popover opens; empty until the first fetch / when offline. The popover
// never blocks on this — it renders from whatever is cached at open time.
let releasesCache = [];
window.api.getReleases().then((r) => { releasesCache = Array.isArray(r) ? r : []; }).catch(() => {});
const peerBar = document.getElementById('peer-bar');
// Per-peer visibility selection mirrored from main (peer:visible). No entry for
// a peer ⇒ show all its sessions; an array (possibly empty) restricts to those
// names. Kept authoritative-enough for rendering by updating from setVisible
// responses; seeded once at startup.
let peerVisibleMap = {};

// Whether a peer session should be listed under the current selection. No map
// entry ⇒ everything shows; otherwise only names in the array. Attachment
// overrides this at the call site (an open tab always renders).
function peerNameVisible(id, name) {
  const sel = peerVisibleMap[id];
  return !Array.isArray(sel) || sel.includes(name);
}

// '@' can't appear in local session names, so keys never collide with them.
function peerKey(id, name) { return `${name}@${id}`; }

function peerDisplayHost(st) { return (st && (st.host || st.label)) || 'peer'; }

function renderPeers() {
  sessionList.querySelectorAll('[data-peer-ui]').forEach((el) => el.remove());
  for (const [id, st] of peerStatuses) {
    const header = document.createElement('div');
    header.className = 'peer-header';
    header.dataset.peerUi = '1';
    // Offline + a managed tunnel that is itself down usually just means the
    // other laptop is asleep; ssh's last stderr line rides the tooltip so a
    // real misconfig (rejected key, unknown host) is diagnosable.
    const tun = peerTunnels.get(id);
    let stateText = st.online ? '' : 'offline';
    if (!st.online && tun && tun.state === 'down') {
      stateText = 'tunnel down';
      if (tun.error) header.title = tun.error;
    }
    // Identity surfacing: an online peer's hello carries version + caps (+ os).
    // Show them in the header tooltip; the version delta tints the peer NAME
    // (below) rather than adding state text — the old 'newer'/'outdated' strings
    // pushed the action icons past the sidebar edge. Severity-driven so the name,
    // the ⓘ icon, and the popover all ride the same class.
    let sev = 'unknown';
    if (st.online && st.version) {
      const capList = (st.caps || []).join(', ') || 'none';
      header.title = `Clodex v${st.version} · caps: ${capList}${st.platform ? ` · ${st.platform}` : ''}`;
      if (ourAppVersion) sev = versionSeverity(ourAppVersion, st.version);
    }
    // Tint the name only when the peer is genuinely BEHIND us (patch/minor/major
    // climb yellow→orange→red). current/newer/unknown leave the name at its
    // normal color — a dim tint on a bold label reads as disabled, and an
    // up-to-date (or ahead) peer's name must never render dimmer than a session
    // row. The ⓘ icon still carries the full-range sev tint (dim suits icon chrome).
    const nameSev = (sev === 'patch' || sev === 'minor' || sev === 'major') ? ` peer-sev-${sev}` : '';
    // Right-aligned host action strip mirrors the header context menu: ＋ new
    // session (create-capable peers only), ↻ restart Clodex, ◎ choose visible
    // sessions (the old ⋯ opener). The first two need the peer online; the eye
    // works offline too (you can still curate which open tabs show).
    const hostLabel = peerDisplayHost(st);
    const canCreate = peerSupportsCreate(st);
    const off = st.online ? '' : 'disabled';
    header.innerHTML = `<span class="peer-dot ${st.online ? 'online' : ''}"></span>` +
      `<span class="peer-label${nameSev}">${esc(hostLabel)}</span>` +
      `<span class="peer-state">${esc(stateText)}</span>` +
      `<span class="peer-actions">` +
        (canCreate ? `<button class="peer-select peer-new" title="New Session on ${esc(hostLabel)}…" aria-label="New Session on ${esc(hostLabel)}" ${off}>&#65291;</button>` : '') +
        `<button class="peer-select peer-restart" title="Restart Clodex on ${esc(hostLabel)}" aria-label="Restart Clodex on ${esc(hostLabel)}" ${off}>&#8635;</button>` +
        `<button class="peer-select peer-eye" title="Choose which sessions to show" aria-label="Choose which sessions to show">&#9678;</button>` +
        // ⓘ identity: version/caps/age + Update. Only when the hello gives us an
        // identity to show (online + version) — nothing to surface otherwise.
        ((st.online && st.version) ? `<button class="peer-select peer-info peer-sev-${sev}" title="Peer identity & version" aria-label="Peer identity">&#9432;</button>` : '') +
      `</span>`;
    header.querySelector('.peer-eye').addEventListener('click', (e) => {
      e.stopPropagation();
      openPeerSelectPopover(id, e.currentTarget);
    });
    const infoBtn = header.querySelector('.peer-info');
    if (infoBtn) infoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPeerInfoPopover(id, e.currentTarget);
    });
    const newBtn = header.querySelector('.peer-new');
    if (newBtn) newBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPeerSessionDialog(id, hostLabel);
    });
    header.querySelector('.peer-restart').addEventListener('click', (e) => {
      e.stopPropagation();
      restartPeerHost(id, hostLabel);
    });
    // Right-click the peer header: host-level actions (today just remote
    // restart). Restart is host-scoped, so it lives here, not on a session row.
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.api.showPeerHeaderMenu({
        id, label: peerDisplayHost(st), online: !!st.online,
        canCreate: peerSupportsCreate(st),
        // sev is in scope from this row's identity block; main gates the Update
        // item on it (updateApplies) so we don't offer a pointless restart to a
        // same-version or ahead peer. 'unknown' (offline / unparseable) keeps it.
        sev,
      });
    });
    sessionList.appendChild(header);

    // Online: the peer's live session list. Offline: only tabs we already
    // have open (so they stay reachable), dimmed.
    // Visibility filter: hide names the user deselected — but an ATTACHED tab
    // always renders (never an invisible open terminal). Offline rows are all
    // attached, so attached-wins covers them; we still run peerNameVisible for
    // uniform shape.
    const rows = (st.online
      ? (st.sessions || []).map((s) => ({ name: s.name, cwd: s.cwd, activity: s.activity, stats: s.stats }))
      : [...sessions.entries()]
          .filter(([, e]) => e.peer && e.peer.id === id)
          .map(([, e]) => ({ name: e.peer.name, cwd: '', activity: 'idle' })))
      .filter((s) => peerNameVisible(id, s.name) || sessions.has(peerKey(id, s.name)));
    for (const s of rows) {
      const key = peerKey(id, s.name);
      const item = document.createElement('div');
      item.className = 'session-item peer-item' + (st.online ? '' : ' peer-offline');
      item.dataset.peerUi = '1';
      item.dataset.name = key;
      item.dataset.activity = s.activity || 'idle';
      if (sessions.has(key)) item.classList.add('attached');
      const shortCwd = s.cwd ? s.cwd.replace(/^\/Users\/[^/]+/, '~') : '';
      item.innerHTML = `
        <span class="session-dot"></span>
        <div class="session-info">
          <div class="session-name" title="${esc(s.name)} on ${esc(peerDisplayHost(st))}">${esc(s.name)}<span class="peer-suffix">@${esc(peerDisplayHost(st))}</span></div>
          <div class="session-meta">
            <span class="session-type">remote</span>
            ${shortCwd ? `<span class="session-cwd" title="${esc(s.cwd)}">${esc(shortCwd)}</span>` : ''}
            <span class="session-badges">
              <span class="session-warm" title="Prompt-cache warmth (time to expiry)"></span>
              <span class="session-ctx" title="Context used"></span>
            </span>
          </div>
        </div>` +
        // Close (detach) only makes sense for an attached tab; unattached rows
        // get no X (it was a dead affordance before).
        (sessions.has(key) ? '<button class="session-close" title="Detach">&times;</button>' : '');
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('session-close')) return;
        openPeerSession(id, s.name);
      });
      // Right-click: native peer-flavored menu (Attach / Take·Release control /
      // Detach / Hide). State is read from entry.peer here — the SAME source the
      // peer bar renders from — so the two control paths can't drift.
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const entry = sessions.get(key);
        window.api.showPeerContextMenu({
          id, name: s.name,
          online: !!st.online,
          attached: sessions.has(key),
          controlled: !!(entry && entry.peer && entry.peer.controlled),
          holder: (entry && entry.peer && entry.peer.holder) || null,
          canCreate: peerSupportsCreate(st),
          hostLabel: peerDisplayHost(st),
          type: s.type || null,   // gates the bash-meaningless fresh-reload item
        });
      });
      const closeBtn = item.querySelector('.session-close');
      if (closeBtn) closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // X means "gone": detach AND drop from the visibility selection, so the
        // row leaves the list (same end state as "Hide from list"). The
        // keep-browsing case lives on the context menu ("Detach (keep listed)").
        if (sessions.has(key)) peerHideFromList(id, s.name);
      });
      sessionList.appendChild(item);
      // Badges survive the row rebuild: attached rows are owned by the live
      // telemetry stream (peer-telemetry keeps the maps fresh), unattached
      // ones by the coarser stats riding the peer's session list.
      if (!sessions.has(key) && s.stats && typeof s.stats.ctxPct === 'number') {
        ctxPct.set(key, s.stats.ctxPct);
      }
      const pct = ctxPct.get(key);
      if (typeof pct === 'number') applyCtxBadge(key, pct);
      applyWarmBadge(key);
    }
  }
  updateSidebarActive();
}

// Create the terminal + attach the peer stream, without stealing focus. Used
// both by openPeerSession (user click) and the startup auto-restore.
function attachPeerSession(id, name) {
  const key = peerKey(id, name);
  if (sessions.has(key)) return;
  createTerminal(key, { id, name, controlled: false, cols: null, rows: null, holder: null });
  window.api.peerAttach(id, name);
  renderPeers();
}

function openPeerSession(id, name) {
  attachPeerSession(id, name);
  switchSession(peerKey(id, name));
}

// One-shot auto-reattach of peer tabs persisted from the previous app run.
// Seeded once at startup (peer:attachedNames); each peer's names are consumed
// as its live session list arrives. Present names attach and drop from the
// pending set; a name still missing once the peer has settled online is
// genuinely gone and gets forgotten from persistence. Consuming per-name is
// the "one shot": an attached-then-closed tab leaves the pending set, so a
// later offline/online blip can't resurrect it.
const peerRestorePending = new Map(); // peerId -> Set<name> awaiting restore
const peerRestoreSweep = new Set();   // peerId -> settle sweep already scheduled
// The first online peer-state fires before the peer's session list is fetched
// (peer-client sets online, then refreshes), so a name missing on that event
// may just be un-fetched. Give the refresh a beat before declaring it dead.
const PEER_RESTORE_SETTLE_MS = 6000;

// Local mirror of ui-settings.peerControlled, seeded at startup and kept in
// lockstep with the durable store (which main writes inside peer:control /
// peer:detach). Read on every reattach replay to decide whether to auto-re-take
// control — covers both an app restart and a box restart/update, since both
// funnel a fresh replay through onPeerReplay.
let peerControlledMap = {};
function peerControlledHas(id, name) {
  return Array.isArray(peerControlledMap[id]) && peerControlledMap[id].includes(name);
}
function rememberControlMirror(id, name) {
  const list = Array.isArray(peerControlledMap[id]) ? peerControlledMap[id] : [];
  if (!list.includes(name)) peerControlledMap[id] = [...list, name];
}
function forgetControlMirror(id, name) {
  if (!Array.isArray(peerControlledMap[id])) return;
  const list = peerControlledMap[id].filter((n) => n !== name);
  if (list.length) peerControlledMap[id] = list; else delete peerControlledMap[id];
}
// A restore re-acquire found the session held by someone else: drop the mirror
// AND tell main to forget the durable claim, so the stale claim never re-fires.
function dropPersistedControl(id, name) {
  forgetControlMirror(id, name);
  window.api.peerForgetControlled(id, name);
}

function maybeRestorePeer(id) {
  const pending = peerRestorePending.get(id);
  if (!pending || !pending.size) { peerRestorePending.delete(id); return; }
  const st = peerStatuses.get(id);
  if (!st || !st.online) return;       // wait for the peer to wake
  const live = new Set((st.sessions || []).map((s) => s.name));
  for (const name of [...pending]) {
    if (live.has(name)) { attachPeerSession(id, name); pending.delete(name); }
  }
  if (!pending.size) { peerRestorePending.delete(id); return; }
  // Names still missing: schedule one settle sweep. Live sessions that land in
  // the interim get attached on the next peer-state; whatever's still missing
  // while the peer is online after the sweep is forgotten.
  if (peerRestoreSweep.has(id)) return;
  peerRestoreSweep.add(id);
  setTimeout(() => {
    peerRestoreSweep.delete(id);
    const left = peerRestorePending.get(id);
    if (!left || !left.size) { peerRestorePending.delete(id); return; }
    const cur = peerStatuses.get(id);
    if (!cur || !cur.online) return;   // can't verify while offline — retry on next wake
    peerRestorePending.delete(id);
    const liveNow = new Set((cur.sessions || []).map((s) => s.name));
    for (const name of left) {
      if (liveNow.has(name)) attachPeerSession(id, name);
      else window.api.peerForgetAttached(id, name);
    }
  }, PEER_RESTORE_SETTLE_MS);
}

// Control-mode strip above the terminal for the active peer session:
// read-only by default, explicit Take control to type (and gain resize
// authority); never both hidden and a peer tab active.
function renderPeerBar() {
  if (!peerBar) return;
  const main = document.getElementById('main');
  const entry = activeSession ? sessions.get(activeSession) : null;
  if (!entry || !entry.peer) {
    peerBar.classList.add('hidden');
    if (main) main.classList.remove('has-peer-bar');
    return;
  }
  if (main) main.classList.add('has-peer-bar');
  const st = peerStatuses.get(entry.peer.id);
  const online = !!(st && st.online);
  const host = peerDisplayHost(st);
  let stateText, btn = '';
  if (!online) {
    stateText = 'peer offline — reconnecting when it wakes';
  } else if (entry.peer.controlled) {
    stateText = 'you are in control';
    btn = '<button id="peer-control-btn" class="controlling">Release control</button>';
  } else if (entry.peer.holder) {
    stateText = `controlled by ${esc(entry.peer.holder)}`;
    btn = '<button id="peer-control-btn">Take control</button>';
  } else {
    stateText = 'read-only';
    btn = '<button id="peer-control-btn">Take control</button>';
  }
  const errText = entry.peer.controlError
    ? `<span class="peer-bar-error">${esc(entry.peer.controlError)}</span>` : '';
  peerBar.innerHTML =
    `<span class="peer-bar-name">${esc(entry.peer.name)}@${esc(host)}</span>` +
    `<span class="peer-bar-state">${stateText}</span>${errText}${btn}`;
  peerBar.classList.remove('hidden');
  const b = document.getElementById('peer-control-btn');
  if (b) b.addEventListener('click', togglePeerControl);
}

function togglePeerControl() {
  const entry = activeSession ? sessions.get(activeSession) : null;
  if (!entry || !entry.peer) return;
  applyPeerControl(entry, !entry.peer.controlled);
}

// First data-producing keystroke in a read-only peer tab = intent to type.
// Buffer the keystroke and, if no acquire is already in flight, kick one; the
// buffered keys flush in order once control is granted. onData while the acquire
// is pending appends to the same queue (no second acquire) via the in-flight
// guard inside PendingInput.
function typeToTakeControl(key, data) {
  const entry = sessions.get(key);
  if (!entry || !entry.peer || entry.peer.controlled) return;
  // Offline peer: nothing to acquire (the bar already says "reconnecting"); a
  // peerControl would just fail. Drop the keystroke silently.
  const st = peerStatuses.get(entry.peer.id);
  if (!st || !st.online) return;
  if (!entry.peer.pendingInput) entry.peer.pendingInput = new PendingInput();
  const kick = entry.peer.pendingInput.offer(data);
  if (kick) applyPeerControl(entry, true, { flush: true });
}

// Acquire/release control on a specific peer entry — shared by the peer-bar
// button, the row context menu, type-to-take, and the restore re-acquire, so
// all drive the same state transition. `flush` (type-to-take only) flushes the
// pending-input queue on success and drops it on failure.
async function applyPeerControl(entry, on, { flush = false, dropOnFail = false } = {}) {
  const { id: peerId, name: peerName } = entry.peer;
  // Coalesce concurrent takes on the same entry (type-to-take vs a reattach
  // re-acquire firing together): the in-flight one owns the outcome.
  if (on && entry.peer._acquiring) return;
  // Any fresh attempt clears a stale error banner.
  clearPeerControlError(entry.peer);
  if (on) entry.peer._acquiring = true;
  let res;
  // try/catch/finally: an invoke rejection must land in the normal failure
  // branch below (banner + pendingInput.reset) — letting it propagate would
  // skip the reset and wedge pendingInput.acquiring true, the same silent
  // type-to-take deadlock the unconditional reset exists to prevent. The
  // finally keeps the coalesce guard from wedging either way.
  try {
    res = await window.api.peerControl(peerId, peerName, on);
  } catch (e) {
    res = { ok: false, error: (e && e.message) || 'control request failed' };
  } finally {
    if (on) entry.peer._acquiring = false;
  }
  if (on) {
    if (res && res.ok) {
      entry.peer.controlled = true;
      // Control mode carries resize authority: fit to our pane and push it.
      entry.fitAddon.fit();
      window.api.peerResize(peerId, peerName, entry.terminal.cols, entry.terminal.rows);
      entry.terminal.focus();
      // Flush anything typed during the acquire, in order.
      if (entry.peer.pendingInput) {
        const buffered = entry.peer.pendingInput.drain();
        if (buffered) window.api.peerInput(peerId, peerName, buffered);
      }
      rememberControlMirror(peerId, peerName);   // main persisted via peer:control
    } else {
      // Acquire failed or (with the pre-fix socket-starvation bug) timed out.
      // Never silent: show a transient banner instead of snapping back to a
      // "Take control" button that looks like nothing happened.
      setPeerControlError(entry.peer, (res && res.error) || 'could not take control');
      // Reset UNCONDITIONALLY (not just on flush): a keystroke can land during a
      // restore re-acquire (flush:false) via the coalesce guard, setting
      // pendingInput.acquiring=true. If THIS failing call doesn't clear it,
      // acquiring stays true forever and every later keystroke buffers with
      // kick=false, silently killing type-to-take on the tab. Mirrors the
      // success path's unconditional drain.
      if (entry.peer.pendingInput) entry.peer.pendingInput.reset(); // drop buffer
      // Restore re-acquire that lost to another holder: drop the stale claim so
      // it doesn't retry-loop on every future reconnect.
      if (dropOnFail) dropPersistedControl(peerId, peerName);
    }
  } else {
    entry.peer.controlled = false;
    forgetControlMirror(peerId, peerName);       // main forgot via peer:control
  }
  renderPeerBar();
}

// Row context-menu actions from main. Verbs mirror the peer-bar's state
// transitions plus attach/detach/hide; taking control from an unattached row
// attaches first so it's one gesture.
// Host-level remote restart of the whole Clodex on a peer box. Shared by the
// header ↻ icon and the right-click header menu's 'restart' action so the
// confirm → fire → toast flow can't drift. `label` is the peer's display host.
// The peer drops offline and the existing reconnect/auto-reattach brings it
// back — no special reconnect logic. Failures (connection/timeout) surface as a
// calm toast, never a retry. Authority is the tunnel (settled model); the
// confirm is the intentionality gate.
async function restartPeerHost(id, label) {
  const okToGo = await window.api.confirmPeerRestart(label);
  if (!okToGo) return;
  await doPeerRestart(id, label);
}

// Restart core minus its own confirm — shared by the header ↻ (which confirms)
// and the update-in-place flow (which already confirmed the whole update, so a
// second dialog on success would be redundant).
async function doPeerRestart(id, label) {
  const res = await window.api.peerRestart(id);
  if (res && res.ok) {
    showToast(`Restarting Clodex on ${label} — it will reconnect shortly.`, { kind: 'peer-ui' });
  } else {
    showToast(`Restart failed on ${label}: ${(res && res.error) || 'no response'}`, { kind: 'warm' });
  }
}

// "Update Clodex on <box>…": re-run the idempotent deploy script over ssh, then
// restart the box on ::done so it picks up the new build. Progress surface is
// deliberately small: a start toast, a completion/failure toast, and the stderr
// tail in the ipc-log on failure (the peers dialog's live step-list is for the
// install-from-scratch wizard; a header-menu update has no row to stream into).
async function updatePeerHost(id, label, sshHost, port, folder) {
  const go = await window.api.confirmPeerUpdate(label);
  if (!go) return;
  showToast(`Updating Clodex on ${label} — this can take a few minutes.`, { kind: 'peer-ui' });
  let sawDone = false;
  const failReasons = [];
  deployLineHandlers.set(sshHost, (line) => {
    const ev = parseDeployLine(line);
    if (ev.type === 'done') sawDone = true;
    else if (ev.type === 'fail') failReasons.push(ev.reason ? `${ev.name} — ${ev.reason}` : ev.name);
  });
  let res;
  // folder reuses the peer's persisted deployFolder (main resolved it from
  // config) so an update targets the same install dir as the original deploy.
  try { res = await window.api.peerDeploy(sshHost, { port, folder }); }
  catch (e) { res = { ok: false, error: (e && e.message) || 'deploy failed' }; }
  deployLineHandlers.delete(sshHost);
  if (res && res.ok && sawDone) {
    showToast(`Clodex updated on ${label} — restarting to apply.`, { kind: 'peer-ui' });
    await doPeerRestart(id, label);
    return;
  }
  const why = res && res.needSudo ? 'needs sudo on the box'
    : res && res.timedOut ? 'timed out'
    : failReasons.length ? failReasons.join('; ')
    : (res && res.error) ? res.error
    : `exit ${res ? res.code : '?'}`;
  showToast(`Update failed on ${label}: ${why}`, { kind: 'warm' });
  const detail = (res && res.stderr) ? res.stderr : (res && res.error) || 'no detail';
  appendIpcEntry({ from: 'deploy', to: label, body: `update failed (${why})\n${detail}` });
}

window.api.onPeerContextAction(async ({ action, id, name, sshHost, port, folder }) => {
  const key = peerKey(id, name);
  switch (action) {
    case 'attach':
      openPeerSession(id, name);
      break;
    case 'takeControl': {
      if (!sessions.has(key)) openPeerSession(id, name); else switchSession(key);
      const entry = sessions.get(key);
      if (entry && entry.peer && !entry.peer.controlled) await applyPeerControl(entry, true);
      break;
    }
    case 'releaseControl': {
      const entry = sessions.get(key);
      if (entry && entry.peer && entry.peer.controlled) await applyPeerControl(entry, false);
      break;
    }
    case 'detach':
      if (sessions.has(key)) { removeSession(key); renderPeers(); }
      break;
    case 'hide':
      await peerHideFromList(id, name);
      break;
    case 'restart':
      // Host-level remote restart. `name` carries the peer's display label here
      // (the header menu has no session). Shared with the header ↻ icon.
      await restartPeerHost(id, name || 'peer');
      break;
    case 'newSession':
      // `name` carries the peer's display label here (header menu, no session).
      openPeerSessionDialog(id, name || 'peer');
      break;
    case 'update':
      // Host-level in-place update — re-run the deploy script over ssh, restart
      // on success. `name` is the display label; sshHost/port/folder ride the
      // message (main resolved them from the peer config, url-only peers never
      // get here).
      await updatePeerHost(id, name || 'peer', sshHost, port, folder);
      break;
    case 'restartRemote':
      // Plain host-level restart of a peer SESSION (--resume, keeps history).
      // No confirm — parity with the local plain restart.
      await restartPeerSessionWithReattach(id, name, false);
      break;
    case 'reloadRemote': {
      // Fresh reload of a peer session (new conversation, re-reads skills). Native
      // confirm mirroring doHardRestart — this drops the live conversation.
      const st = peerStatuses.get(id);
      const label = peerDisplayHost(st);
      if (!await window.api.confirmPeerReload(name, label)) break;
      await restartPeerSessionWithReattach(id, name, true);
      break;
    }
    case 'killRemote': {
      // Destructive host-level kill on the peer. Native confirm (intentionality),
      // then the endpoint; the owner's notifySessions fan-out refreshes the list,
      // so no local list surgery — just report the ack. Detach our local tab if
      // we had one open (the session it mirrored is gone).
      const st = peerStatuses.get(id);
      const label = peerDisplayHost(st);
      const okToGo = await window.api.confirmPeerKill(name, label);
      if (!okToGo) break;
      const res = await window.api.peerKillSession(id, name);
      if (res && res.ok) {
        const key = peerKey(id, name);
        if (sessions.has(key)) removeSession(key);
        showToast(`Killed "${name}" on ${label}.`, { kind: 'peer-ui' });
      } else {
        showToast(`Kill failed for "${name}" on ${label}: ${(res && res.error) || 'no response'}`, { kind: 'warm' });
      }
      break;
    }
  }
});

// New-session-on-a-peer dialog. Minimal (name/type/cwd) — the full new-session
// dialog's fields (prompts/skills/tools/agents/dir-picker) are local-only and
// don't travel to a remote fs. Errors surface INLINE (the owner's create ack is
// the only signal — the viewer can't see the box's dialogs). On success the
// owner's notifySessions refreshes the peer's session list; we just close.
let peerSessionDialogTarget = null; // { id, label }
function openPeerSessionDialog(id, label) {
  peerSessionDialogTarget = { id, label };
  const overlay = document.getElementById('peer-session-overlay');
  document.getElementById('peer-session-title').textContent = `New Session on ${label}`;
  document.getElementById('peer-input-name').value = '';
  document.getElementById('peer-input-type').value = 'claude';
  document.getElementById('peer-input-cwd').value = '';
  const err = document.getElementById('peer-session-error');
  err.style.display = 'none';
  err.textContent = '';
  overlay.classList.remove('hidden');
  document.getElementById('peer-input-name').focus();
}
function closePeerSessionDialog() {
  peerSessionDialogTarget = null;
  document.getElementById('peer-session-overlay').classList.add('hidden');
}
async function submitPeerSessionDialog() {
  if (!peerSessionDialogTarget) return;
  const { id, label } = peerSessionDialogTarget;
  const err = document.getElementById('peer-session-error');
  const showErr = (m) => { err.textContent = m; err.style.display = 'block'; };
  const name = document.getElementById('peer-input-name').value.trim();
  const type = document.getElementById('peer-input-type').value;
  const cwd = document.getElementById('peer-input-cwd').value.trim();
  if (!name) return showErr('Name is required.');
  if (!cwd) return showErr('Working directory is required.');
  const btn = document.getElementById('peer-session-create');
  btn.disabled = true;
  const res = await window.api.peerCreateSession(id, { name, type, cwd });
  btn.disabled = false;
  if (res && res.ok) {
    closePeerSessionDialog();
    showToast(`Created "${res.name}" (${res.type}) on ${label}.`, { kind: 'peer-ui' });
    // The owner's notifySessions fan-out refreshes the list; no local surgery.
  } else {
    showErr((res && res.error) || 'create failed — no response');
  }
}
document.getElementById('peer-session-cancel').addEventListener('click', closePeerSessionDialog);
document.getElementById('peer-session-create').addEventListener('click', submitPeerSessionDialog);
document.getElementById('peer-session-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'peer-session-overlay') closePeerSessionDialog();
});
document.getElementById('peer-session-dialog').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); submitPeerSessionDialog(); }
  else if (e.key === 'Escape') { e.preventDefault(); closePeerSessionDialog(); }
});

// Remove one session from the peer's visible selection (context-menu "Hide from
// list"). Mirrors the peer-select popover's semantics: no selection yet ⇒
// materialize an explicit all-known-minus-this list; an existing selection ⇒
// drop the name. Pairs with Apply-detaches — a hidden attached tab is detached
// too, so "hidden" always means "gone from the sidebar".
async function peerHideFromList(id, name) {
  const st = peerStatuses.get(id);
  const sel = peerVisibleMap[id];
  let next;
  if (Array.isArray(sel)) {
    next = sel.filter((n) => n !== name);
  } else {
    const liveNames = st && st.online ? (st.sessions || []).map((s) => s.name) : [];
    const attachedNames = [...sessions.entries()]
      .filter(([, e]) => e.peer && e.peer.id === id).map(([, e]) => e.peer.name);
    next = [...new Set([...liveNames, ...attachedNames])].filter((n) => n !== name);
  }
  const res = await window.api.peerSetVisible(id, next);
  if (res && res.ok) peerVisibleMap = res.peerVisible || {};
  const key = peerKey(id, name);
  if (sessions.has(key)) removeSession(key);
  renderPeers();
}

// Transient control-error banner on a peer entry. Auto-clears so it never
// sticks past the moment; re-renders the bar if the session is still active.
function setPeerControlError(peer, msg) {
  peer.controlError = msg;
  clearTimeout(peer.controlErrorTimer);
  peer.controlErrorTimer = setTimeout(() => {
    peer.controlError = null;
    peer.controlErrorTimer = null;
    const cur = activeSession ? sessions.get(activeSession) : null;
    if (cur && cur.peer === peer) renderPeerBar();
  }, 4000);
}

function clearPeerControlError(peer) {
  peer.controlError = null;
  clearTimeout(peer.controlErrorTimer);
  peer.controlErrorTimer = null;
}

window.api.onPeerState((id, status) => {
  peerStatuses.set(id, status);
  renderPeers();
  renderPeerBar();
  maybeRestorePeer(id);
});

window.api.onPeerActivity((id, name, state) => {
  const el = sessionList.querySelector(`[data-name="${CSS.escape(peerKey(id, name))}"]`);
  if (el) el.dataset.activity = state;
});

// Fresh replay = fresh terminal: raw-byte history is not exact terminal
// state, so reset before applying (also runs after every reconnect).
window.api.onPeerReplay((id, name, info) => {
  const entry = sessions.get(peerKey(id, name));
  if (!entry) return;
  entry.peer.cols = info.cols; entry.peer.rows = info.rows;
  entry.peer.holder = info.holder || null;
  entry.peer.controlled = false;   // control never survives a (re)attach
  entry.terminal.reset();
  if (info.cols && info.rows) entry.terminal.resize(info.cols, info.rows);
  if (info.data && info.data.length) entry.terminal.write(info.data);
  renderPeerBar();
  // Reconnect replay into the ALREADY-active tab fires no switchSession, so the
  // one place that re-measures a read-only peer never runs — a pane whose
  // geometry shifted during the offline window keeps a stale letterbox until
  // the next manual switch heals it. Re-measure here too when this is the
  // active tab (inactive tabs are covered by the switch-on-activate path).
  if (peerKey(id, name) === activeSession && !entry.peer.controlled) {
    remeasureReadonlyPeer(entry);
  }
  // Control persistence: this reattach replay just reset us to read-only. If the
  // tab is persisted as controlled, re-take control now that the replay has
  // settled — covers an app restart (restored attach → first replay) AND a box
  // restart/update (reconnect replay on an already-open tab). On failure
  // (held by someone else) applyPeerControl shows the banner and dropOnFail
  // sheds the stale claim so it never retry-loops.
  if (peerControlledHas(id, name) && !entry.peer.controlled) {
    applyPeerControl(entry, true, { dropOnFail: true });
  }
});

window.api.onPeerData((id, name, data) => {
  const entry = sessions.get(peerKey(id, name));
  if (entry) entry.terminal.write(data);
});

// Owner PTY resized: follow its geometry live so new output stops rendering
// into a stale letterbox. Owner geometry is canonical even in control mode —
// a controlling viewer's own resize echoes back the same (or PTY-clamped) dims,
// and applying them is an idempotent resize-in-place, never a feedback loop
// (viewers push geometry only on explicit fit, not on an applied resize).
window.api.onPeerResize((id, name, geom) => {
  const entry = sessions.get(peerKey(id, name));
  if (!entry || !entry.peer) return;
  if (!(geom.cols > 0 && geom.rows > 0)) return;
  entry.peer.cols = geom.cols; entry.peer.rows = geom.rows;
  if (entry.terminal.cols !== geom.cols || entry.terminal.rows !== geom.rows) {
    entry.terminal.resize(geom.cols, geom.rows);
  }
});

// Owner-initiated UI mirroring: the owner surfaced a session-scoped component
// (a remote agent's [agent:file view], today) and wants attached viewers to
// render their own copy. The event carries only a small {kind, args} trigger —
// content is pulled locally through popoverApi (the query RPC), so it stays on
// the owner's vetted path. Kinds are dispatched through a registry so new
// mirrorable components are one entry, not new plumbing.
//
// Intrusiveness gate: a remote agent must NOT be able to slam a full-screen
// modal over whatever the operator is doing in another tab. So a mirrored
// component renders immediately ONLY when its peer tab is the active one;
// otherwise it becomes an unobtrusive, session-scoped toast whose click
// switches to that tab and then renders. `present` is the "act now" path,
// `announce` the deferred one — every kind supplies both.
const PEER_UI_KINDS = {
  fileView: {
    label: 'shared a file',
    detail: (args) => (args && args.path ? args.path.split('/').pop() : 'a file'),
    present: (key, args) => { if (args && args.path) openFilePeek(key, args.path); },
  },
};

window.api.onPeerUi((id, name, evt) => {
  const key = peerKey(id, name);
  if (!sessions.has(key)) return;             // only attached viewers act
  const spec = evt && PEER_UI_KINDS[evt.kind];
  if (!spec) return;                          // unknown/stale kind — ignore gracefully
  const args = evt.args || {};
  if (activeSession === key) { spec.present(key, args); return; }
  // Not looking at that tab: announce, don't intrude. Click switches + renders.
  const disp = `${name}@${peerDisplayHost(peerStatuses.get(id))}`;
  showToast(`${disp}: ${spec.label} — ${spec.detail(args)}`, {
    kind: 'peer-ui',
    onClick: () => { if (sessions.has(key)) { switchSession(key); spec.present(key, args); } },
  });
});

// Status-bar telemetry for an attached peer session, streamed from the
// owner's poll (plus a seed frame right behind the replay). Feeding it into
// proxyState / the ctx maps under the peer key makes renderProxyBar, the
// warmth badge, and the 1s countdown tick render it natively. The owner
// ships an info-only view (no base/capabilities/sessionId), so every
// owner-local control (keep-warm, strip, popovers, wirescope link) degrades
// to plain text here instead of firing at endpoints that only exist on the
// owner's machine. Partial frames: {proxy} rides the poll, {ctx} the
// statusline side-channel — merge, don't replace.
window.api.onPeerTelemetry((id, name, tele) => {
  const key = peerKey(id, name);
  if (!sessions.has(key)) return;
  if (tele.proxy) {
    proxyState.set(key, { payload: tele.proxy, at: Date.now() });
    applyWarmBadge(key);
  }
  if (tele.ctx && typeof tele.ctx.pct === 'number') {
    ctxPct.set(key, tele.ctx.pct);
    if (tele.ctx.tok > 0 && tele.ctx.size > 0) {
      ctxTokens.set(key, { used: tele.ctx.tok, size: tele.ctx.size });
    }
    applyCtxBadge(key, tele.ctx.pct);
  }
  // Touched-files count: owner pushes this only when the count changes (and
  // seeds it once on attach). Latch the unseen highlight only on an INCREASE
  // over a known prior count — the attach seed sets the baseline silently, a
  // later bump lights the badge. Suppressed while its popover is open (that's
  // "seeing" it). Mirrors the local session-files path.
  let filesGrew = false;
  if (tele.files && typeof tele.files.count === 'number') {
    const prev = peerFilesCount.get(key);
    peerFilesCount.set(key, tele.files.count);
    const watching = !filesPopover.classList.contains('hidden') && filesPopover.dataset.name === key;
    if (prev !== undefined && tele.files.count > prev && !watching) {
      filesUnseen.add(key);
      filesGrew = true;
    }
  }
  if (key === activeSession) {
    renderProxyBar();
    // One-shot pulse on the freshly-rebuilt button (imperative, dies with the
    // node) — same treatment as an arriving local file touch.
    if (filesGrew) {
      const btn = document.querySelector('#proxy-actions [data-act="files"]');
      if (btn) btn.classList.add('px-files-flash');
    }
  }
});

window.api.onPeerControlChange((id, name, holder) => {
  const entry = sessions.get(peerKey(id, name));
  if (!entry) return;
  const st = peerStatuses.get(id);
  entry.peer.holder = holder;
  // Our client label on that peer is `peer:<label>` (peer-client.js).
  const mine = !!(holder && st && holder === `peer:${st.label}`);
  entry.peer.controlled = mine;
  renderPeerBar();
});

window.api.onPeerExit((id, name) => {
  removeSession(peerKey(id, name));
  renderPeers();
});

window.api.onPeerTunnel((id, status) => {
  peerTunnels.set(id, status);
  renderPeers();
});

window.api.onPeerRemoved((id) => {
  peerStatuses.delete(id);
  peerTunnels.delete(id);
  for (const [key, entry] of [...sessions.entries()]) {
    if (entry.peer && entry.peer.id === id) removeSession(key);
  }
  renderPeers();
});

// Owner side: one of OUR sessions is being viewed/driven from a peer —
// flag its tab so remote control is never silent.
window.api.onSessionPeerControl((name, holder) => {
  const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (!el) return;
  if (holder) {
    el.dataset.remoteControl = holder;
    el.title = `Remote control: ${holder}`;
  } else {
    delete el.dataset.remoteControl;
    el.removeAttribute('title');
  }
});

// Seed peer list on startup (peer-state events keep it fresh afterwards).
window.api.peerList().then((statuses) => {
  for (const st of statuses || []) {
    peerStatuses.set(st.id, st);
    if (st.tunnel) peerTunnels.set(st.id, st.tunnel);
  }
  if (peerStatuses.size) renderPeers();
}).catch(() => {});

// Seed the one-shot restore map from persisted attachments. peer-state events
// may land before or after this resolves: if before, the peer is already in
// peerStatuses and we kick its restore here; if after, its peer-state handler
// finds the seeded pending entry. Either order restores exactly once.
window.api.peerAttachedNames().then((map) => {
  for (const [id, names] of Object.entries(map || {})) {
    if (Array.isArray(names) && names.length) peerRestorePending.set(id, new Set(names));
  }
  for (const id of [...peerRestorePending.keys()]) maybeRestorePeer(id);
}).catch(() => {});

// Seed the per-peer visibility selection; peer-state events after this just
// re-render against the local copy (kept fresh from peerSetVisible responses).
window.api.peerVisible().then((map) => {
  peerVisibleMap = map || {};
  if (peerStatuses.size) renderPeers();
}).catch(() => {});

// Seed the control-restore mirror. Kept fresh locally from applyPeerControl /
// removeSession; on each reattach replay a persisted entry auto-re-takes.
window.api.peerControlledNames().then((map) => {
  peerControlledMap = map || {};
}).catch(() => {});

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

// Peer touched-files count shadow: peer key -> count. Fed by the owner's
// telemetry frames (count-only; the full list stays pull-on-demand via the
// query endpoint). Lets a remote tab's 📄N badge tick live instead of only
// updating when the popover is opened. Local sessions read the count off
// filesState directly; peer tabs prefer this shadow.
const peerFilesCount = new Map();

// --- Proxy telemetry status bar (wirescope pull) --------------------------
// The main process polls the proxy and pushes a per-session payload. We show
// the ACTIVE session's line in a strip under the terminal, ticking the cache
// countdown locally between polls and degrading honestly (~/grey/"stale")
// when polls stop arriving so it never fakes precision.
const PROXY_POLL_MS = 5000;
const proxyState = new Map(); // name -> { payload, at }
// Touched-files feed: name -> [{ path, tool, ts, count, sub }] newest-first
// (main.js session ring, pushed on every observed file-tool call; pulled fresh
// when the Files popover opens, so a detached-window gap loses nothing).
const filesState = new Map();
// Sessions whose feed grew since the popover was last opened — drives the
// files button's unseen-changes highlight (cleared on open, never on poll).
const filesUnseen = new Set();

// Type of a session, read from its sidebar tab (the renderer's source for it).
function sessionTypeOf(name) {
  const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  return item ? (item.querySelector('.session-type')?.textContent || null) : null;
}
function activeIsAgent() {
  const t = activeSession ? sessionTypeOf(activeSession) : null;
  return t === 'claude' || t === 'codex';
}
// Attached peer tab whose owner serves the popover query endpoint — such a
// tab gets the status bar (for the files button) even with no telemetry.
function activePeerQueryable() {
  const entry = activeSession ? sessions.get(activeSession) : null;
  if (!entry || !entry.peer) return false;
  const st = peerStatuses.get(entry.peer.id);
  return !!(st && st.online && Array.isArray(st.caps) && st.caps.includes('query'));
}

// Peer advertises remote session create/kill (the 'create' cap covers both).
// Older peers 501 the endpoints, so the viewer hides the affordances.
function peerSupportsCreate(st) {
  return !!(st && Array.isArray(st.caps) && st.caps.includes('create'));
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
    // Touched-files feed. Fed by the wire (Claude); a Codex session only gets
    // the button once something lands in its feed (no Codex tap yet).
    const nFiles = (filesState.get(activeSession) || []).length;
    if (type === 'claude' || nFiles > 0) {
      const label = nFiles > 0 ? `📄 ${nFiles} file${nFiles === 1 ? '' : 's'}` : '📄 files';
      // Unseen-changes latch: accent-lit from the moment a touch lands until
      // the popover is opened — a count silently ticking is too easy to miss.
      const unseen = filesUnseen.has(activeSession) ? ' px-files-new' : '';
      btns.push(`<button class="px-action${unseen}" data-act="files" title="Files this agent's tools touched — click to view or diff">${label}</button>`);
    }
    btns.push('<button class="px-action" data-act="history" title="Past conversations — resume an earlier session">🕘 history</button>');
    btns.push('<button class="px-action" data-act="reload" title="Hard restart: reload tools/skills/settings from disk in a fresh conversation (the CLI only reads them at launch — /clear and --resume don\'t). The current conversation stays in 🕘 history.">🔄 reload</button>');
    btns.push('<button class="px-action" data-act="edit" title="Edit session settings">⚙ edit</button>');
  }
  // Peer tabs (type "remote"): the touched-files popup is the one action that
  // works across the link — served by the owner's query endpoint. Everything
  // else on this bar is owner-local machinery.
  if (activePeerQueryable()) {
    // Prefer the live count-shadow (fed by the owner's telemetry frames) over
    // filesState, which is only populated when the popover pulls the full list.
    const nFiles = peerFilesCount.has(activeSession)
      ? peerFilesCount.get(activeSession)
      : (filesState.get(activeSession) || []).length;
    const label = nFiles > 0 ? `📄 ${nFiles} file${nFiles === 1 ? '' : 's'}` : '📄 files';
    // Same unseen latch as local sessions: a count silently ticking on a
    // remote agent is exactly what Bogdan couldn't see without clicking.
    const unseen = filesUnseen.has(activeSession) ? ' px-files-new' : '';
    btns.push(`<button class="px-action${unseen}" data-act="files" title="Files this agent's tools touched (on its own machine) — click to view or diff">${label}</button>`);
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
    if (activeIsAgent() || activePeerQueryable()) {
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
  // Peer payloads carry no capabilities/base/sessionId (deliberate — no
  // reach-back); `queries` is the owner's advertisement of which popovers
  // its query endpoint can answer, so those chips stay clickable remotely.
  const peerQueries = Array.isArray(p.queries) ? p.queries : [];
  const ctxClickable = !!(p.linked && p.capabilities &&
    (p.capabilities.context_composition || p.capabilities.context_view || ctxUtil))
    || peerQueries.includes('ctx');
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
    const timeline = !!(p.capabilities && p.capabilities.context_timeline && p.base && p.sessionId)
      || peerQueries.includes('cost');
    if (timeline) {
      segs.push(`<span class="px-seg px-cost px-ctx-btn" data-act="cost" title="Cost over time — click for the breakdown">~$${costTxt}</span>`);
    } else {
      segs.push(`<span class="px-seg px-cost" title="wirescope cost estimate">~$${costTxt}</span>`);
    }
  }
  if (p.refusals > 0) segs.push(`<span class="px-seg px-refusal">⚠ ${p.refusals}</span>`);
  // Cache-bust chip: report GENUINE busts only. Two classes of noise are
  // subtracted, per settled policy (07-06), so the number the operator sees is
  // exactly "cache breaks worth a look":
  //   1. fault:self — the per-turn thinking-strip microbusts (a settled turn's
  //      cached thinking falling behind the last-user boundary each turn). A
  //      DESIGN DECISION, every active session makes them by construction —
  //      excluded entirely, not merely calmed.
  //   2. restart_between — busts that straddled a proxy restart = the one-time
  //      deploy/upgrade re-cache tax (wirescope v0.6.21+ attributes these per
  //      class). Self-inflicted and self-healing, so subtracted per class:
  //      real = count − restart_between.
  // What remains is genuine: `content` (a real injected-prefix change — model
  // swap, midnight date rollover, a CLAUDE.md edit → amber) and `environment`
  // (idle-cold cache → calm, a real cache event but nothing changed). No chip at
  // all when nothing genuine remains, which is every steady session by design.
  // wirescope classifies + attributes; we just subtract + render. Clickable into
  // the per-turn inspector when we can reach /_bust (base + live sessionId).
  const bsum = p.busts;
  if (bsum && Array.isArray(bsum.classes)) {
    // real busts per class, deploy-tax removed; drop the designed self microbusts.
    const real = (c) => Math.max(0, (c.count || 0) - (c.restart_between || 0));
    const genuine = bsum.classes.filter((c) => c && c.fault && c.fault !== 'self');
    const genuineCount = genuine.reduce((n, c) => n + real(c), 0);
    if (genuineCount > 0) {
      const contentCls = genuine.filter((c) => c.fault === 'content' && real(c) > 0);
      const contentCount = contentCls.reduce((n, c) => n + real(c), 0);
      const loud = contentCount > 0;
      const clickable = !!(p.base && p.sessionId) || peerQueries.includes('bust');
      const cls = `px-seg px-bust${loud ? ' px-bust-loud' : ''}${clickable ? ' px-ctx-btn' : ''}`;
      const tip = loud
        ? `${contentCount} genuine cache-bust${contentCount === 1 ? '' : 's'} from a real prefix change — ${esc((contentCls[0] && contentCls[0].fix_hint) || 'inspect what changed')}.${clickable ? ' Click to inspect.' : ''}`
        : `${genuineCount} cache-bust${genuineCount === 1 ? '' : 's'} from the cache going cold — expected, nothing changed.${clickable ? ' Click to inspect.' : ''}`;
      const attrs = clickable ? ' data-act="bust"' : '';
      segs.push(`<span class="${cls}"${attrs} title="${tip}">💥 ${genuineCount}</span>`);
    }
  }
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
    // Per-subagent cost share (wirescope v0.6.22+ est_usd) rides the poll we
    // already make — null (never 0) = unbilled/pre-.22, so only show it when
    // present. In the meta it sits after the turn count: "3 · ~$0.42".
    const costTxt = (typeof s.estUsd === 'number') ? `~${fmtUsd(s.estUsd)}` : '';
    row.title = `${s.label || s.key}${s.model ? ' · ' + s.model : ''}`
      + `${s.requests ? ' · ' + s.requests + ' turn' + (s.requests === 1 ? '' : 's') : ''}`
      + `${costTxt ? ' · ' + costTxt : ''}\nClick for live activity`;
    row.querySelector('.child-label').textContent = s.label || s.key;
    row.querySelector('.child-meta').textContent =
      [s.requests ? `${s.requests}` : '', costTxt].filter(Boolean).join(' · ');
    // Keep DOM order matching proxy order, right after the running anchor.
    if (anchor.nextSibling !== row) anchor.after(row);
    anchor = row;
  }
  // Drop rows whose subagent vanished from the renderable set.
  existing.forEach((el) => { if (!seen.has(el.dataset.key)) el.remove(); });

  // If a popover is open for this parent and its row aged out, close it.
  const openKey = subagentPopoverKeyForParent(name);
  if (openKey && !seen.has(openKey)) {
    closeSubagentPopover();
  }
}

// --- Subagent live-activity popover ------------------------------------------
// Self-contained island (subagent-popover.js). applySubagents/subagentRows
// above stay here — core tab rendering — and reach it via these handles.
const {
  openSubagentPopover, closeSubagentPopover,
  isSubagentPopoverForParent, isSubagentPopoverOpen, subagentPopoverKeyForParent,
} = initSubagentPopover();

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
  // Clicking the body runs opts.onClick if given (it owns the action), else the
  // session-scoped default: jump to opts.name's session.
  if (opts.onClick || opts.name) {
    el.classList.add('toast-clickable');
    el.addEventListener('click', () => {
      if (opts.onClick) opts.onClick();
      else if (sessions.has(opts.name)) switchSession(opts.name);
      dismiss();
    });
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
    // Peer keys are name@<uuid> — show name@host instead (the key still
    // rides the toast payload for click-to-switch).
    const entry = sessions.get(name);
    const disp = entry && entry.peer
      ? `${entry.peer.name}@${peerDisplayHost(peerStatuses.get(entry.peer.id))}`
      : name;
    showToast(`${disp}: cache going cold in ~${mins} min`, { kind: 'warm', name });
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
    const bustSeg = e.target.closest('[data-act="bust"]');
    if (bustSeg && activeSession) { openBustPopover(activeSession, bustSeg); return; }
    const action = e.target.closest('.px-action');
    if (action && activeSession) {
      if (action.dataset.act === 'edit') openArgsDialog(activeSession);
      else if (action.dataset.act === 'tools') openToolsPopover(activeSession, action);
      else if (action.dataset.act === 'skills') openSkillsPopover(activeSession, action);
      else if (action.dataset.act === 'agents') openAgentsPopover(activeSession, action);
      else if (action.dataset.act === 'files') openFilesPopover(activeSession, action);
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
  // Auto-compact-before-cold lives here because it's the OTHER answer to the
  // same moment as keep-warm: the cache is about to expire. Default on; the
  // authoritative state rides the poll payload (main-side persistence).
  const acOn = proxyState.get(activeSession)?.payload?.autoCompact !== false;
  items.push('<div class="warm-menu-label">When cache is about to cool</div>');
  items.push(`<button class="warm-item warm-autocompact" data-act="autocompact" title="With no keep-warm hold and over 100k context, Clodex runs /compact just before the cache expires — compacting while warm re-reads the context at cache prices instead of paying a full cold re-write later.">Auto-compact: ${acOn ? 'on' : 'off'}</button>`);
  warmMenu.innerHTML = items.join('');
  warmMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('.warm-item');
    if (!item || !activeSession) return;
    const name = activeSession;
    closeWarmMenu();
    if (item.dataset.act === 'autocompact') {
      await window.api.setAutoCompact(name, !acOn);
      // Optimistic: the poll confirms within 5s, but a re-open shouldn't lie.
      const st = proxyState.get(name);
      if (st && st.payload) st.payload.autoCompact = !acOn;
    } else if (item.dataset.act === 'off') await doWarmHold(name, { off: true });
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
  setClaudeToolsCache(settings?.claudeTools || []);
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

// --- Per-peer session visibility popover ---------------------------------
// Clones the tools-popover idiom: a checklist of the peer's sessions, checked =
// currently shown. No map entry ⇒ every session shown (all checked). Applying
// with every LIVE name checked and no known-but-gone name unchecked collapses
// back to show-all (peerSetVisible null); otherwise the checked set is stored.
// Gone names (in the map but not currently live) are listed dimmed so a
// temporarily-down session isn't silently dropped just by opening + applying.
const peerSelectPopover = document.getElementById('peer-select-popover');
const peerSelectPopoverName = document.getElementById('peer-select-popover-name');
const peerSelectList = document.getElementById('peer-select-list');
wireBulkToggles(peerSelectPopover, peerSelectList);

function closePeerSelectPopover() {
  peerSelectPopover.classList.add('hidden');
  peerSelectPopover.dataset.peerId = '';
}

function openPeerSelectPopover(id, anchorBtn) {
  const st = peerStatuses.get(id);
  const sel = peerVisibleMap[id]; // undefined ⇒ show all
  const liveNames = st && st.online ? (st.sessions || []).map((s) => s.name) : [];
  // Known-but-not-live names to preserve: selection entries + our attached tabs
  // for this peer that aren't in the live list. Offline peers have no live list,
  // so everything we know rides this path.
  const known = new Set(liveNames);
  const gone = [];
  const fromSel = Array.isArray(sel) ? sel : [];
  const fromAttached = [...sessions.entries()]
    .filter(([, e]) => e.peer && e.peer.id === id)
    .map(([, e]) => e.peer.name);
  for (const name of [...fromSel, ...fromAttached]) {
    if (!known.has(name)) { known.add(name); gone.push(name); }
  }
  peerSelectList.innerHTML = '';
  const rows = [
    ...liveNames.map((name) => ({ name, gone: false })),
    ...gone.map((name) => ({ name, gone: true })),
  ];
  if (!rows.length) {
    peerSelectList.innerHTML = '<span class="hint-text">No sessions known for this peer yet.</span>';
  }
  for (const r of rows) {
    const row = document.createElement('label');
    row.className = 'agent-check' + (r.gone ? ' peer-select-gone' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = r.name;
    cb.checked = peerNameVisible(id, r.name);
    cb.dataset.gone = r.gone ? '1' : '';
    const txt = document.createElement('span');
    txt.innerHTML = `<strong>${esc(r.name)}</strong>${r.gone ? ' <span class="skill-src">(gone)</span>' : ''}`;
    row.appendChild(cb);
    row.appendChild(txt);
    peerSelectList.appendChild(row);
  }
  peerSelectPopoverName.textContent = peerDisplayHost(st);
  peerSelectPopover.dataset.peerId = id;
  peerSelectPopover.classList.remove('hidden');
  // Anchor above the button, clamped to the viewport (mirrors tools popover).
  const rect = anchorBtn.getBoundingClientRect();
  const w = peerSelectPopover.offsetWidth;
  peerSelectPopover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - w - 8))}px`;
  peerSelectPopover.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
}

document.getElementById('peer-select-popover-close').addEventListener('click', closePeerSelectPopover);
document.getElementById('peer-select-popover-cancel').addEventListener('click', closePeerSelectPopover);
document.getElementById('peer-select-popover-apply').addEventListener('click', async () => {
  const id = peerSelectPopover.dataset.peerId;
  if (!id) return closePeerSelectPopover();
  const boxes = [...peerSelectList.querySelectorAll('input[type="checkbox"]')];
  const checked = boxes.filter((cb) => cb.checked).map((cb) => cb.value);
  // Collapse to show-all only when nothing is excluded: every box checked AND
  // no gone-name was unchecked (an unchecked gone-name is a real exclusion).
  const allChecked = boxes.every((cb) => cb.checked);
  closePeerSelectPopover();
  const res = await window.api.peerSetVisible(id, allChecked ? null : checked);
  if (res && res.ok) peerVisibleMap = res.peerVisible || {};
  else peerVisibleMap = (await window.api.peerVisible().catch(() => peerVisibleMap)) || peerVisibleMap;
  // Apply is authoritative for attached tabs too: any session excluded by this
  // selection that's currently open gets detached (same path as the X — removeSession
  // forgets persistence + re-homes focus if it was active). This deliberately
  // overrides the attached-always-wins RENDER rule, but only for an explicit
  // Apply exclusion; a tab that becomes attached by other means (auto-reattach
  // of a later-unchecked name) still renders, since nothing re-runs this.
  for (const [key, entry] of [...sessions.entries()]) {
    if (entry.peer && entry.peer.id === id && !peerNameVisible(id, entry.peer.name)) {
      removeSession(key);
    }
  }
  renderPeers();
});
// Dismiss on outside click / Escape.
document.addEventListener('mousedown', (e) => {
  if (peerSelectPopover.classList.contains('hidden')) return;
  if (peerSelectPopover.contains(e.target)) return;
  if (e.target.closest('.peer-eye')) return; // the opener handles itself
  closePeerSelectPopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !peerSelectPopover.classList.contains('hidden')) closePeerSelectPopover();
});

// --- Peer identity popover (the ⓘ icon) ----------------------------------
// Read-only surface: peer version vs ours, platform, caps, a severity line, and
// a best-effort "released N days ago · N behind" pulled from the cached release
// list (omitted entirely when the version isn't a published release / no cache).
// The Update button reuses the header-menu deploy flow (sshHost + online gated),
// resolved from config via peer:deployConfig. Never blocks on a fetch.
const peerInfoPopover = document.getElementById('peer-info-popover');
const peerInfoPopoverName = document.getElementById('peer-info-popover-name');
const peerInfoBody = document.getElementById('peer-info-body');
const peerInfoUpdateBtn = document.getElementById('peer-info-update');

function closePeerInfoPopover() {
  peerInfoPopover.classList.add('hidden');
  peerInfoPopover.dataset.peerId = '';
  peerInfoUpdateBtn.classList.add('hidden');
  peerInfoUpdateBtn.onclick = null;
}

function openPeerInfoPopover(id, anchorBtn) {
  const st = peerStatuses.get(id);
  if (!st) return;
  const label = peerDisplayHost(st);
  peerInfoPopoverName.textContent = label;
  const sev = (ourAppVersion && st.version) ? versionSeverity(ourAppVersion, st.version) : 'unknown';
  const capList = (st.caps || []).join(', ') || 'none';
  const rows = [];
  rows.push(`<div class="peer-info-line"><span class="peer-info-key">Version</span> Clodex v${esc(st.version || '?')}${ourAppVersion ? ` <span class="peer-status-dim">(you run v${esc(ourAppVersion)})</span>` : ''}</div>`);
  if (st.platform) rows.push(`<div class="peer-info-line"><span class="peer-info-key">Platform</span> ${esc(st.platform)}</div>`);
  rows.push(`<div class="peer-info-line"><span class="peer-info-key">Caps</span> ${esc(capList)}</div>`);
  if (SEV_LINE[sev]) rows.push(`<div class="peer-info-line peer-sev-${sev}">${esc(SEV_LINE[sev])}</div>`);
  // Best-effort age line from the cached release list; omitted whole when the
  // peer's version isn't a known published release (dev build / empty cache).
  const age = releaseAgeInfo(st.version, releasesCache);
  if (age) {
    const bits = [];
    if (age.ageDays != null) bits.push(`released ${age.ageDays} day${age.ageDays === 1 ? '' : 's'} ago`);
    if (age.behind > 0) bits.push(`${age.behind} release${age.behind === 1 ? '' : 's'} behind`);
    if (bits.length) rows.push(`<div class="peer-info-line peer-status-dim">${esc(bits.join(' · '))}</div>`);
  }
  peerInfoBody.innerHTML = rows.join('');
  peerInfoPopover.dataset.peerId = id;
  peerInfoPopover.classList.remove('hidden');
  // Anchor above the button, clamped to the viewport (mirrors the eye popover).
  const rect = anchorBtn.getBoundingClientRect();
  const w = peerInfoPopover.offsetWidth;
  peerInfoPopover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - w - 8))}px`;
  peerInfoPopover.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
  // Update button: online + ssh-reachable only (the exact header-menu gate).
  // Resolved async from config; if the peer is url-only it stays hidden. Guard
  // against a stale resolve landing after the popover was closed/retargeted.
  peerInfoUpdateBtn.classList.add('hidden');
  peerInfoUpdateBtn.onclick = null;
  // Hidden when the peer isn't behind us: same-version or ahead has nothing to
  // gain from our deploy (the script pulls latest master). Kept for
  // patch/minor/major and 'unknown' (dev/unparseable — can't rule it out).
  if (st.online && updateApplies(sev)) {
    window.api.peerDeployConfig(id).then((cfg) => {
      if (!cfg || !cfg.sshHost) return;
      if (peerInfoPopover.classList.contains('hidden') || peerInfoPopover.dataset.peerId !== String(id)) return;
      peerInfoUpdateBtn.classList.remove('hidden');
      peerInfoUpdateBtn.onclick = () => {
        closePeerInfoPopover();
        updatePeerHost(id, label, cfg.sshHost, cfg.port, cfg.folder);
      };
    }).catch(() => {});
  }
  // Refresh the release cache in the background for next time (never awaited).
  window.api.getReleases().then((r) => { if (Array.isArray(r)) releasesCache = r; }).catch(() => {});
}

document.getElementById('peer-info-popover-close').addEventListener('click', closePeerInfoPopover);
document.getElementById('peer-info-popover-done').addEventListener('click', closePeerInfoPopover);
document.addEventListener('mousedown', (e) => {
  if (peerInfoPopover.classList.contains('hidden')) return;
  if (peerInfoPopover.contains(e.target)) return;
  if (e.target.closest('.peer-info')) return; // the opener handles itself
  closePeerInfoPopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !peerInfoPopover.classList.contains('hidden')) closePeerInfoPopover();
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
  setSkillLibCache(res.skillLib || []);
  if (getSkillLibCache().length) {
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
  setAgentLibCache(res.agents || []);
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

// Popover data router: local sessions fetch through their own IPC handlers,
// peer sessions through the owner's query endpoint (peer:query → one
// kind-dispatched RPC). Same response shapes either way, so every popover's
// render code is shared — only this fetch seam knows the difference.
function popoverApi(name) {
  const entry = sessions.get(name);
  if (entry && entry.peer) {
    const q = (kind, args) => window.api.peerQuery(entry.peer.id, entry.peer.name, kind, args);
    return {
      remote: true,
      ctx: () => q('ctx'),               // utilization opt-in is the owner's call
      report: (opts) => q('report', opts),
      bust: () => q('bust'),
      files: () => q('files'),
      peek: (p) => q('filePeek', { path: p }),
      diff: (p) => q('fileDiff', { path: p }),
    };
  }
  return {
    remote: false,
    ctx: (opts) => window.api.getProxyContext(name, opts),
    report: (opts) => window.api.getProxyReport(name, opts),
    bust: () => window.api.getProxyBust(name),
    files: () => window.api.sessionFiles(name),
    peek: (p) => window.api.filePeek(p),
    diff: (p) => window.api.fileDiff(name, p),
  };
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
  const pl = proxyState.get(name)?.payload || {};
  const caps = pl.capabilities || {};
  const peerQueries = Array.isArray(pl.queries) ? pl.queries : [];
  const wantUtil = !!(caps.context_utilization || caps.context_skills);
  const res = await popoverApi(name).ctx({ utilization: wantUtil });
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
  if (caps.context_report || peerQueries.includes('report')) {
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

function closeCostPopover() { costPopover.classList.add('hidden'); costPopover.dataset.name = ''; }

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

// Per-line cost attribution (wirescope v0.6.22+ cost_by_line). Sourced from the
// LIVE status payload — cost.usd (whole tree), cost.mainUsd (main line's own
// share), subagents[].estUsd (each sub's share) — not the report, so it's free
// (rides the poll). Answers "where did a fan-out run's cost actually go" that
// the single whole-tree number couldn't. Rendered only when the capability is
// advertised and at least one line carries a billed share (null = unbilled/
// pre-.22, NEVER treated as $0). Sorted by cost desc; unbilled subs listed muted.
function renderCostByLine(p) {
  if (!p || !p.capabilities || !p.capabilities.cost_by_line || !p.cost) return '';
  const whole = typeof p.cost.usd === 'number' ? p.cost.usd : null;
  const main = typeof p.cost.mainUsd === 'number' ? p.cost.mainUsd : null;
  const subs = Array.isArray(p.subagents) ? p.subagents : [];
  const billedSubs = subs.filter((s) => typeof s.estUsd === 'number');
  if (main == null && !billedSubs.length) return ''; // nothing attributed yet
  const pct = (v) => (whole && whole > 0 && typeof v === 'number') ? ` · ${Math.round((v / whole) * 100)}%` : '';
  const rows = [];
  if (main != null) {
    rows.push({ label: 'Main line', usd: main, cls: 'cost-line-main' });
  }
  for (const s of subs) {
    rows.push({ label: s.label || s.key, usd: (typeof s.estUsd === 'number' ? s.estUsd : null), cls: '' });
  }
  // Billed rows sorted high→low; unbilled (null) sink to the bottom.
  rows.sort((a, b) => (b.usd == null ? -1 : b.usd) - (a.usd == null ? -1 : a.usd));
  const body = rows.map((r) => {
    if (r.usd == null) {
      return `<div class="cost-line-row ${r.cls}"><span class="cost-line-label">${esc(r.label)}</span>`
        + `<span class="cost-line-usd cost-line-unbilled">unbilled</span></div>`;
    }
    return `<div class="cost-line-row ${r.cls}"><span class="cost-line-label">${esc(r.label)}</span>`
      + `<span class="cost-line-usd">${fmtUsd(r.usd)}<span class="cost-line-pct">${pct(r.usd)}</span></span></div>`;
  }).join('');
  const totalTxt = whole != null ? fmtUsd(whole) : '';
  return `<div class="cost-sec-title"><span>By line</span><span class="ctx-line-total">${totalTxt}</span></div>`
    + `<div class="cost-line-list">${body}</div>`
    + `<div class="cost-note">Whole-tree estimate split across the main line and its subagents. Shares ride the live poll (no extra fetch).</div>`;
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
  const res = await popoverApi(name).report({ detail: true });
  if (costPopover.dataset.name !== name || costPopover.classList.contains('hidden')) return;
  if (!res || !res.ok) {
    costPopoverBody.innerHTML = `<div class="cost-note">${esc(res && res.error ? res.error : 'Cost timeline unavailable')}</div>`;
    return;
  }
  // Prepend the live per-line attribution (free — from the poll payload) above
  // the report-driven main-line timeline. Re-read the payload post-await so the
  // shares are as fresh as the poll allows.
  const pNow = (proxyState.get(name) || {}).payload;
  try { costPopoverBody.innerHTML = renderCostByLine(pNow) + renderCostTimeline(res.data, base, sid); }
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

// ── Cache-bust inspector (wirescope /_bust) ───────────────────────────
// Turn-by-turn cache-divergence forensics: WHEN the prefix broke, HOW big the
// re-write was, and WHAT changed (the locus). Opened from the 💥 bar chip.
// wirescope classifies; we render. `fault`/`fix_hint` per transition arrive in
// v0.6.20+ — rendered when present, gracefully absent on v0.6.19 (locus.label
// alone still answers "what changed on this turn").
const bustPopover = document.getElementById('bust-popover');
const bustPopoverName = document.getElementById('bust-popover-name');
const bustPopoverBody = document.getElementById('bust-popover-body');

function closeBustPopover() { bustPopover.classList.add('hidden'); bustPopover.dataset.name = ''; }

function renderBustSeries(d, base, sid) {
  const busts = Array.isArray(d && d.busts) ? d.busts : [];
  const nT = d && d.count != null ? d.count : null;
  const link = (base && sid)
    ? `<span class="px-link-ext" data-url="${esc(`${base}/_session?session=${encodeURIComponent(sid)}`)}" title="Open the session in the wirescope navigator (⌘-click for browser)">Open navigator →</span>`
    : '';
  // Genuine busts (content / environment) are the investigation; the fault:self
  // microbusts are the designed per-turn strip cost — collapsed to one muted
  // line, not listed row-by-row (they're identical and expected). Matches the
  // chip, which counts genuine only.
  const genuine = busts.filter((t) => t.fault !== 'self');
  const designed = busts.filter((t) => t.fault === 'self');
  if (!genuine.length) {
    const only = designed.length
      ? `<div class="cost-note">No genuine cache busts — the ${designed.length} recorded event${designed.length === 1 ? ' is' : 's are'} the designed per-turn strip cost (thinking falling behind the boundary), not a cache problem.</div>`
      : `<div class="cost-note">No cache busts recorded${nT != null ? ` across ${nT} turn transition${nT === 1 ? '' : 's'}` : ''} — the prefix stayed warm.</div>`;
    return only + link;
  }
  const nStatic = d.n_static_prefix_busts != null ? d.n_static_prefix_busts : null;
  const head = `<div class="cost-head"><b>${genuine.length}</b> genuine cache-bust${genuine.length === 1 ? '' : 's'}`
    + (nT != null ? ` over <b>${nT}</b> transitions` : '')
    + (nStatic ? ` · <b>${nStatic}</b> touched the static prefix` : '')
    + `</div>`;
  // Newest first — the operator usually cares about what just broke.
  const rows = genuine.slice().reverse().map((t) => bustRow(t, base, sid)).join('');
  const designedNote = designed.length
    ? `<div class="cost-note">+ ${designed.length} designed strip-cost microbust${designed.length === 1 ? '' : 's'} (fault:self) — expected every turn, not shown.</div>`
    : '';
  const note = '<div class="cost-note">Amber = a real injected-prefix change worth fixing (model swap, date rollover, CLAUDE.md edit). Dim = expected (idle cold cache, or a one-time deploy tax that self-heals).</div>';
  return head + `<div class="bust-list">${rows}</div>` + designedNote + note + link;
}

async function openBustPopover(name, anchor) {
  const p = (proxyState.get(name) || {}).payload;
  const base = p && p.base, sid = p && p.sessionId;
  bustPopoverName.textContent = name;
  bustPopover.dataset.name = name;
  bustPopoverBody.innerHTML = '<div class="cost-note">Loading cache-bust forensics…</div>';
  bustPopover.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const w = bustPopover.offsetWidth;
  bustPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  bustPopover.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  const res = await popoverApi(name).bust();
  if (bustPopover.dataset.name !== name || bustPopover.classList.contains('hidden')) return;
  if (!res || !res.ok) {
    bustPopoverBody.innerHTML = `<div class="cost-note">${esc(res && res.error ? res.error : 'Cache-bust forensics unavailable')}</div>`;
    return;
  }
  try { bustPopoverBody.innerHTML = renderBustSeries(res.data, base, sid); }
  catch (e) { bustPopoverBody.innerHTML = `<div class="cost-note">Could not render: ${esc(String((e && e.message) || e))}</div>`; }
}

bustPopoverBody.addEventListener('click', (e) => {
  const ext = e.target.closest('[data-url]');
  if (!ext || !ext.dataset.url) return;
  if (e.metaKey || e.ctrlKey) {
    window.api.openExternal(ext.dataset.url);
  } else {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg');
    window.api.openWirescope(ext.dataset.url, bg);
  }
});
document.addEventListener('mousedown', (e) => {
  if (bustPopover.classList.contains('hidden')) return;
  if (bustPopover.contains(e.target)) return;
  if (e.target.closest('[data-act="bust"]')) return; // toggle handled by the bar
  closeBustPopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !bustPopover.classList.contains('hidden')) closeBustPopover();
});
document.getElementById('bust-popover-close').addEventListener('click', closeBustPopover);

// ── Touched files (wire file-tool observer) ────────────────────────────
// The files this agent's Edit/Write/NotebookEdit calls were aimed at, as
// clickable rows: row → read-only peek with a Diff view (git is the truth for
// what actually changed — the feed only records the aim). Fed live via
// session-files pushes; pulled fresh on popover open so a detached-window gap
// loses nothing. Facts only — no client-side classification.
const filesPopover = document.getElementById('files-popover');
const filesPopoverName = document.getElementById('files-popover-name');
const filesPopoverBody = document.getElementById('files-popover-body');

window.api.onSessionFiles((name, files) => {
  filesState.set(name, files || []);
  // Live-refresh whatever is showing: the bar button's count, and the open
  // popover's rows (dataset.name pins which session it is showing).
  const watching = !filesPopover.classList.contains('hidden') && filesPopover.dataset.name === name;
  // Latch the unseen highlight unless the user is looking at the rows right
  // now. Set BEFORE the bar re-render so the rebuilt button picks it up.
  if (!watching) filesUnseen.add(name);
  if (name === activeSession) {
    renderProxyBar();
    // One-shot pulse on the freshly-rebuilt button, so the arrival moment
    // catches the eye. Imperative (not part of the button markup) on purpose:
    // the bar is rebuilt on every proxy poll, and a class-borne animation
    // would replay on each rebuild — this one dies with the node, once.
    if (!watching) {
      const btn = document.querySelector('#proxy-actions [data-act="files"]');
      if (btn) btn.classList.add('px-files-flash');
    }
  }
  if (watching) renderFilesRows(name);
});

function closeFilesPopover() { filesPopover.classList.add('hidden'); filesPopover.dataset.name = ''; }

function renderFilesRows(name) {
  const files = filesState.get(name) || [];
  if (!files.length) {
    filesPopoverBody.innerHTML = '<div class="cost-note">No file edits observed yet — rows appear as the agent\'s file tools run.</div>';
    return;
  }
  const cwd = filesPopover.dataset.cwd || '';
  const rows = files.map((f) => {
    const inCwd = cwd && f.path.startsWith(cwd + '/');
    const rel = inCwd ? f.path.slice(cwd.length + 1) : f.path;
    const base = rel.split('/').pop();
    const dir = rel.slice(0, rel.length - base.length);
    const badges = []; // aim-count + subagent provenance, not change size
    if (f.count > 1) badges.push(`<span class="file-badge" title="Touched ${f.count} times">×${f.count}</span>`);
    if (f.sub) badges.push('<span class="file-badge file-badge-sub" title="Touched via a subagent">sub</span>');
    return `<div class="file-row${inCwd ? '' : ' file-row-out'}" data-path="${esc(f.path)}" title="${esc(f.path)} — click to view / diff">`
      + `<span class="file-row-main"><span class="file-row-dir">${esc(dir)}</span><span class="file-row-name">${esc(base)}</span>${badges.join('')}</span>`
      + `<span class="file-row-meta">${esc(f.tool)} · ${fmtAgo(f.ts)}</span>`
      + `</div>`;
  }).join('');
  filesPopoverBody.innerHTML = `<div class="file-rows">${rows}</div>`
    + (files.some((f) => !(cwd && f.path.startsWith(cwd + '/')))
      ? '<div class="cost-note">Dimmed rows are outside the session\'s working directory.</div>' : '');
}

async function openFilesPopover(name, anchor) {
  // Toggle off if re-clicking while open for the same session.
  if (!filesPopover.classList.contains('hidden') && filesPopover.dataset.name === name) {
    return closeFilesPopover();
  }
  // Anchor geometry BEFORE the latch-clear below: renderProxyBar rebuilds the
  // bar and DETACHES the clicked button, and a detached node's rect is all
  // zeros — which positioned the popover above the viewport top (the
  // "3 clicks to open" bug: off-screen open → toggle close → real open).
  // The rebuild only recolors the button, so the pre-rebuild rect is right.
  const r = anchor.getBoundingClientRect();
  filesPopoverName.textContent = name;
  filesPopover.dataset.name = name;
  filesPopover.dataset.cwd = '';
  // Opening IS seeing — drop the unseen latch and unlight the button.
  if (filesUnseen.delete(name)) renderProxyBar();
  filesPopoverBody.innerHTML = '<div class="cost-note">Loading…</div>';
  filesPopover.classList.remove('hidden');
  const w = filesPopover.offsetWidth;
  filesPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  filesPopover.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  const res = await popoverApi(name).files().catch(() => null);
  if (filesPopover.dataset.name !== name || filesPopover.classList.contains('hidden')) return;
  if (!res || !res.ok) {
    filesPopoverBody.innerHTML = `<div class="cost-note">${esc((res && res.error) || 'Session not running')}</div>`;
    return;
  }
  filesPopover.dataset.cwd = res.cwd || '';
  filesState.set(name, res.files || []);
  // Reconcile the peer count-shadow to the authoritative list length so the
  // badge and the rows can't drift after an open (no-op for local sessions).
  if (peerFilesCount.has(name)) peerFilesCount.set(name, (res.files || []).length);
  renderFilesRows(name);
}

filesPopoverBody.addEventListener('click', (e) => {
  const row = e.target.closest('.file-row');
  if (!row || !row.dataset.path) return;
  openFilePeek(filesPopover.dataset.name, row.dataset.path);
});
document.addEventListener('mousedown', (e) => {
  if (filesPopover.classList.contains('hidden')) return;
  if (filesPopover.contains(e.target)) return;
  if (e.target.closest('[data-act="files"]')) return; // toggle handled by the bar
  if (e.target.closest('#file-peek-overlay')) return; // peek opened from a row stays modal
  closeFilesPopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !filesPopover.classList.contains('hidden')
      && filePeekOverlay.classList.contains('hidden')) closeFilesPopover();
});
document.getElementById('files-popover-close').addEventListener('click', closeFilesPopover);

// --- File peek: read-only Diff / File viewer -----------------------------
// Diff is HEAD-relative git truth fetched fresh on every open; File is the
// current on-disk bytes (size-capped, binary-sniffed). Viewing only — editing
// belongs to a real editor, one click away on the Open button.
const filePeekOverlay = document.getElementById('file-peek-overlay');
const filePeekPath = document.getElementById('file-peek-path');
const filePeekBody = document.getElementById('file-peek-body');
const filePeekTabDiff = document.getElementById('file-peek-tab-diff');
const filePeekTabFile = document.getElementById('file-peek-tab-file');
let filePeek = null; // { path, tab, diffRes, peekRes }

function closeFilePeek() { filePeekOverlay.classList.add('hidden'); filePeek = null; }

function renderFilePeek() {
  if (!filePeek) return;
  const { tab, diffRes, peekRes } = filePeek;
  filePeekTabDiff.classList.toggle('active', tab === 'diff');
  filePeekTabFile.classList.toggle('active', tab === 'file');
  const diffOk = !!(diffRes && diffRes.ok);
  filePeekTabDiff.disabled = !diffOk;
  filePeekTabDiff.title = diffOk ? 'Uncommitted changes (git, vs HEAD)' : ((diffRes && diffRes.error) || 'Diff unavailable');
  if (tab === 'diff') {
    if (!diffOk) {
      filePeekBody.innerHTML = `<div class="cost-note">${esc((diffRes && diffRes.error) || 'Diff unavailable')}</div>`;
    } else if (diffRes.untracked) {
      filePeekBody.innerHTML = '<div class="cost-note">New file — not tracked by git yet. The File tab shows its full contents.</div>';
    } else if (!diffRes.diff.trim()) {
      filePeekBody.innerHTML = '<div class="cost-note">No uncommitted changes — what the agent touched here is already committed (or was reverted).</div>';
    } else {
      filePeekBody.innerHTML = `<div class="file-peek-pre">${renderDiffHtml(diffRes.diff)}</div>`;
    }
    return;
  }
  if (!peekRes || !peekRes.ok) {
    filePeekBody.innerHTML = `<div class="cost-note">${esc((peekRes && peekRes.error) || 'File unavailable')}</div>`;
  } else if (peekRes.binary) {
    filePeekBody.innerHTML = `<div class="cost-note">Binary file (${peekRes.size} bytes) — use Open.</div>`;
  } else {
    const note = peekRes.truncated
      ? `<div class="cost-note">Showing the first ${Math.round(peekRes.content.length / 1024)}KB of ${Math.round(peekRes.size / 1024)}KB.</div>` : '';
    filePeekBody.innerHTML = `${note}<div class="file-peek-pre">${esc(peekRes.content).split('\n').map((l) => `<div class="diff-line diff-ctx">${l || ' '}</div>`).join('')}</div>`;
  }
}

async function openFilePeek(name, filePath) {
  const api = popoverApi(name);
  filePeek = { path: filePath, tab: 'diff', diffRes: null, peekRes: null };
  filePeekPath.textContent = filePath;
  filePeekPath.title = filePath;
  // A remote file has no local path to hand to an editor — Open is owner-only.
  document.getElementById('file-peek-open').style.display = api.remote ? 'none' : '';
  filePeekBody.innerHTML = '<div class="cost-note">Loading…</div>';
  filePeekOverlay.classList.remove('hidden');
  const [diffRes, peekRes] = await Promise.all([
    api.diff(filePath).catch((e) => ({ ok: false, error: String(e) })),
    api.peek(filePath).catch((e) => ({ ok: false, error: String(e) })),
  ]);
  if (!filePeek || filePeek.path !== filePath) return; // closed / retargeted mid-fetch
  filePeek.diffRes = diffRes;
  filePeek.peekRes = peekRes;
  // Default to the view with something to say: a real diff → Diff; untracked,
  // clean, or no git → File.
  filePeek.tab = (diffRes && diffRes.ok && !diffRes.untracked && diffRes.diff.trim()) ? 'diff' : 'file';
  renderFilePeek();
}

filePeekTabDiff.addEventListener('click', () => { if (filePeek) { filePeek.tab = 'diff'; renderFilePeek(); } });
filePeekTabFile.addEventListener('click', () => { if (filePeek) { filePeek.tab = 'file'; renderFilePeek(); } });
document.getElementById('file-peek-open').addEventListener('click', () => {
  if (filePeek) window.api.fileOpen(filePeek.path);
});
document.getElementById('file-peek-close').addEventListener('click', closeFilePeek);
// [agent:file view] — main already vetted the path and focused this window;
// reuse the touched-files peek modal wholesale (diff tab included, since the
// name pins the git cwd).
window.api.onSessionFileView((name, filePath) => { openFilePeek(name, filePath); });
filePeekOverlay.addEventListener('mousedown', (e) => { if (e.target === filePeekOverlay) closeFilePeek(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !filePeekOverlay.classList.contains('hidden')) closeFilePeek();
});

// ── Session report (wirescope /_report, report_version 1) ─────────────
// wirescope owns every number (pricing, cache math, thresholds, verdict
// score) — disk-based so it reads the full session capture, even on ended
// sessions. We only turn its structured findings into prose and assert the
// invariants it ships. Schema locked with wirescope; bump on report_version.
const reportOverlay = document.getElementById('report-overlay');
const reportNameEl = document.getElementById('report-name');
const reportBody = document.getElementById('report-body');

function closeReportPanel() { reportOverlay.classList.add('hidden'); reportOverlay.dataset.name = ''; }

async function openReportPanel(name) {
  reportNameEl.textContent = name;
  reportOverlay.dataset.name = name;
  reportBody.innerHTML = '<div class="rep-note">Analyzing session capture…</div>';
  reportOverlay.classList.remove('hidden');
  const res = await popoverApi(name).report();
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

// Owns its DOM, counters, and IPC subscription (incl. onRequestOpenIpcLog).
// FLAG: toggleIpcLog refits the active terminal, so the island takes core state
// — `sessions` (the live Map) and getActiveSession (activeSession is a
// reassignable let) — as factory params. `appendIpcEntry` is the only handle
// renderer.js keeps (for the synthetic deploy-failure line).
const { appendIpcEntry } = createIpcLog({ sessions, getActiveSession: () => activeSession });

// ---------------------------------------------------------------------------
// Terminal search (Cmd+F)
// ---------------------------------------------------------------------------

// FLAG: search drives the active terminal, so the island takes core state —
// `sessions` + getActiveSession (activeSession is a reassignable let) — as
// factory params. openSearch/closeSearch are destructured out so their call
// sites stay identical; isSearchOpen/setSearchInfo front the two spots that
// reached the island's DOM directly (switch-session teardown + createSession's
// result callback).
const { openSearch, closeSearch, isSearchOpen, setSearchInfo } =
  createTermSearch({ sessions, getActiveSession: () => activeSession });

// ---------------------------------------------------------------------------
// Resize handling
// ---------------------------------------------------------------------------

const resizeObserver = new ResizeObserver(() => {
  if (!activeSession) return;
  const s = sessions.get(activeSession);
  if (!s) return;
  if (s.peer) {
    // Read-only peer view: owner geometry is canonical, never fit.
    if (s.peer.controlled) {
      s.fitAddon.fit();
      window.api.peerResize(s.peer.id, s.peer.name, s.terminal.cols, s.terminal.rows);
    }
    return;
  }
  s.fitAddon.fit();
  window.api.resizeSession(activeSession, s.terminal.cols, s.terminal.rows);
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
      const entry = sessions.get(target);
      if (entry && entry.peer) {
        // Same gesture as the X: "gone" = detach + drop from the visibility
        // selection (the session keeps running on its owner regardless).
        peerHideFromList(entry.peer.id, entry.peer.name);
      } else {
        window.api.confirmKill(target).then((ok) => {
          if (ok) window.api.killSession(target);
        });
      }
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
// Banners (update + spawn diagnostics)
// ---------------------------------------------------------------------------

// Self-contained (window.api / navigator only). refreshDiagBanner is
// destructured out for createSession's spawn-error path to re-run.
const { refreshDiagBanner } = initBanners();

// Tray-triggered actions (the drawer-open handlers live in library-drawers.js)
window.api.onRequestSwitchSession((name) => switchSession(name));
window.api.onRequestOpenNewDialog(() => openDialog());

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
const wsRestartBtn = document.getElementById('ws-restart-btn');
const wsLogsBlock = document.getElementById('ws-logs-block');
const wsLogsSize = document.getElementById('ws-logs-size');
const wsLogsAge = document.getElementById('ws-logs-age');
const wsLogsClearBtn = document.getElementById('ws-logs-clear-btn');
const prefsRemoteEnabled = document.getElementById('prefs-remote-enabled');
const remoteDot = document.getElementById('remote-dot');
const remoteStatusText = document.getElementById('remote-status-text');
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
  if (wsRestartBusy) return; // hold the "Restarting…" line against the poll
  const err = st && st.error;
  let color = WS_DOT[st ? st.state : 'stopped'] || '#888';
  let text;
  if (st && st.state === 'managed') {
    text = `Active${st.version ? ' — ' + st.version : ''}`;
    // stale = running version differs from the bundled snapshot (normally
    // auto-cleared at launch; this is the manual path if that was missed).
    if (st.stale) {
      text += ' — update ready, restart to apply';
      color = WS_DOT.starting;
    }
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
  // Restart applies only to a Clodex-managed instance (external ones belong
  // to whoever started them; main-side restart() enforces this too).
  wsRestartBtn.style.display = (st && st.state === 'managed' && !wsRestartBusy) ? '' : 'none';
}

let wsRestartBusy = false;
wsRestartBtn.addEventListener('click', async () => {
  if (wsRestartBusy) return;
  wsRestartBusy = true;
  wsRestartBtn.style.display = 'none';
  wsDot.style.background = WS_DOT.starting;
  wsStatusText.textContent = 'Restarting…';
  try {
    const res = await window.api.wirescopeRestart();
    if (res && res.ok === false && res.error) wsStatusText.textContent = res.error;
  } catch {}
  wsRestartBusy = false;
  refreshWsStatus();
});

let wsPollTimer = null;
async function refreshWsStatus() {
  try { renderWsStatus(await window.api.wirescopeStatus()); } catch {}
  try { renderRemoteStatus(await window.api.remoteStatus()); } catch {}
}

// Capture-log size readout + Clear button with an age picker. Sourced entirely
// from wirescope's /_prune (no client-side du). A non-ok GET = older proxy
// without the endpoint → hide the block (presence IS the capability). The total
// comes from GET; the "reclaimable" teaser + button state follow the selected
// age via a dry-run POST preview (the fixed GET cutoffs only cover 30/180/7d).
// The Clear action is always tier=receipts scope=all — billing receipts kept,
// only /_bust forensics for old sessions + the probe bucket dropped; recent/
// warm/held skipped server-side regardless of the age chosen.
let wsLogsTotalBytes = 0;
let wsLogsPreviewSeq = 0;
function wsSelectedAge() { return wsLogsAge.value || '30d'; }
function wsAgeLabel() {
  const opt = wsLogsAge.options[wsLogsAge.selectedIndex];
  return opt ? opt.textContent.trim() : wsSelectedAge();
}

async function refreshWsLogs() {
  let res;
  try { res = await window.api.wirescopePruneInfo(); } catch { res = null; }
  if (!res || !res.ok || !res.data) { wsLogsBlock.style.display = 'none'; return; }
  wsLogsBlock.style.display = '';
  wsLogsTotalBytes = res.data.total_bytes || 0;
  await previewWsLogs();
}

// Dry-run the selected age to show exactly what a Clear would reclaim, and
// enable the button only when there's something to collect. Seq-guarded so a
// fast picker change can't render a stale preview.
async function previewWsLogs() {
  const seq = ++wsLogsPreviewSeq;
  wsLogsClearBtn.disabled = true;
  wsLogsSize.textContent = `Capture logs: ${fmtBytes(wsLogsTotalBytes)} — checking…`;
  let pv;
  try {
    pv = await window.api.wirescopePrune({ olderThan: wsSelectedAge(), tier: 'receipts', scope: 'all', dryRun: true });
  } catch { pv = null; }
  if (seq !== wsLogsPreviewSeq) return; // superseded
  let line = `Capture logs: ${fmtBytes(wsLogsTotalBytes)}`;
  if (pv && pv.ok && pv.data && pv.data.bytes_reclaimed > 0) {
    line += ` — ${fmtBytes(pv.data.bytes_reclaimed)} reclaimable`;
    wsLogsClearBtn.disabled = false;
  } else if (pv && pv.ok) {
    line += ' — nothing to clear at this age';
  } else {
    line += (pv && pv.error) ? ` — ${pv.error}` : ' — preview failed';
  }
  wsLogsSize.textContent = line;
}

wsLogsAge.addEventListener('change', previewWsLogs);

let wsLogsClearBusy = false;
wsLogsClearBtn.addEventListener('click', async () => {
  if (wsLogsClearBusy) return;
  const older = wsSelectedAge();
  wsLogsClearBusy = true;
  wsLogsClearBtn.disabled = true;
  try {
    // Fresh dry-run for the exact numbers in the confirm (age may differ from
    // the last preview if the poll refreshed in between).
    const pv = await window.api.wirescopePrune({ olderThan: older, tier: 'receipts', scope: 'all', dryRun: true });
    if (!pv || !pv.ok || !pv.data) {
      wsLogsSize.textContent = (pv && pv.error) ? `Error: ${pv.error}` : 'Preview failed';
      return;
    }
    const p = pv.data;
    if (!(p.bytes_reclaimed > 0)) { await previewWsLogs(); return; }
    const kept = p.skipped ? p.skipped.recent : 0;
    const ok = confirm(
      `Clear capture logs older than ${wsAgeLabel()}?\n\n` +
      `Reclaims ${fmtBytes(p.bytes_reclaimed)} (${p.files_deleted} files) from ${p.sessions_pruned} sessions.\n\n` +
      `Billing/cost history is preserved — only detailed request forensics are removed. ` +
      `Active, warm, and recent sessions are untouched${kept ? ` (${kept} kept)` : ''}.`
    );
    if (!ok) return;
    wsLogsSize.textContent = `Capture logs: ${fmtBytes(wsLogsTotalBytes)} — clearing…`;
    const r = await window.api.wirescopePrune({ olderThan: older, tier: 'receipts', scope: 'all' });
    if (!r || !r.ok || !r.data) {
      wsLogsSize.textContent = (r && r.error) ? `Error: ${r.error}` : 'Clear failed';
      return;
    }
  } catch (e) {
    wsLogsSize.textContent = `Error: ${(e && e.message) || e}`;
  } finally {
    wsLogsClearBusy = false;
  }
  await refreshWsLogs();
});

function renderRemoteStatus(st) {
  if (!st) return;
  if (st.running) {
    remoteDot.style.background = '#3fb950';
    remoteStatusText.textContent = `Serving on http://127.0.0.1:${st.port}`;
  } else if (st.error) {
    remoteDot.style.background = '#f85149';
    remoteStatusText.textContent = st.error;
  } else {
    remoteDot.style.background = '#888';
    remoteStatusText.textContent = prefsRemoteEnabled.checked ? 'Not running' : 'Off';
  }
}

// Peers editor rows: label + url + remove. IDs stay stable across edits so
// main can reconcile connections instead of restarting them all.
// Peer add/edit/remove now lives in its own dialog (opened from Window > Peers >
// Manage Peered Clodexes…), not Preferences — keeps the prefs dialog lean.
const peersListBox = document.getElementById('peers-list');
const peersOverlay = document.getElementById('peers-overlay');

// Deploy-line router: main streams `peer-deploy-line` (sshHost, line) globally
// as the deploy script runs; each in-flight wizard registers a handler keyed by
// its ssh host so concurrent deploys never cross wires.
const { parseDeployLine, classifyDeployFolder, classifyPeerDest } = require('../peer-deploy');
const deployLineHandlers = new Map(); // sshHost -> (line) => void
window.api.onPeerDeployLine((sshHost, line) => {
  const h = deployLineHandlers.get(sshHost);
  if (h) h(line);
});

function addPeerRow(peer) {
  const wrap = document.createElement('div');
  wrap.className = 'peer-row-wrap';
  const row = document.createElement('div');
  row.className = 'peer-row';
  row.dataset.peerId = peer.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
  // Port + folder are OVERRIDES, pre-filled with the real defaults (7900 and the
  // deploy script's own $HOME/wb-wrap-ui clone dir). Left as-is they reproduce
  // today's behavior; the operator changes them only when a box needs a
  // different port or install location. They wrap to a second line via the
  // full-width break so the primary inputs stay uncrowded.
  const portVal = Number.isInteger(peer.remotePort) ? peer.remotePort : 7900;
  // Folder pre-fill precedence: the box's LIVE self-reported install dir wins
  // over a persisted deployFolder (a stale guess must not shadow live truth —
  // Bogdan's settings may still carry a polluted ~/wb-wrap-ui for a mac that
  // actually runs from ~/projects/clodex), which wins over the default. When the
  // value came from the live report we surface a dim inline hint below.
  const liveSrc = (peer.id && peerStatuses.get(peer.id) && peerStatuses.get(peer.id).online)
    ? (peerStatuses.get(peer.id).srcDir || '') : '';
  const folderReported = !!(liveSrc && typeof liveSrc === 'string' && liveSrc.trim());
  const folderVal = folderReported
    ? liveSrc.trim()
    : ((typeof peer.deployFolder === 'string' && peer.deployFolder) ? peer.deployFolder : '~/wb-wrap-ui');
  // One smart destination field: ssh host / IP / alias, OR an http(s):// URL. The
  // scheme prefix disambiguates (classifyPeerDest), so no protocol dropdown. The
  // settings schema is unchanged — a classified 'ssh' saves peer.sshHost and a
  // 'url' saves peer.url; only the input surface collapses. Pre-fill from the
  // stored sshHost, falling back to url for a legacy url-only peer.
  const destVal = peer.sshHost || peer.url || '';
  row.innerHTML = `
    <input type="text" class="peer-row-label" placeholder="label (e.g. laptop2)" value="${esc(peer.label || '')}">
    <input type="text" class="peer-row-dest" placeholder="user@host, IP, or ssh alias — or http://… for direct" value="${esc(destVal)}">
    <button type="button" class="secondary peer-row-test" title="Test the ssh host and check for Clodex; offer to install if absent">Test &amp; Set Up</button>
    <button type="button" class="secondary peer-row-remove" title="Remove peer">&times;</button>
    <div class="peer-row-break"></div>
    <span class="peer-row-dest-badge hidden"></span>
    <label class="peer-row-advlabel">port</label>
    <input type="text" class="peer-row-port" title="Peer protocol port on the box (default 7900)" value="${esc(String(portVal))}">
    <label class="peer-row-advlabel">folder</label>
    <input type="text" class="peer-row-folder" title="Install/clone dir on the box — ~/… (home-relative) or /abs (default ~/wb-wrap-ui)" value="${esc(folderVal)}">
    ${folderReported ? `<span class="peer-row-folder-hint peer-status-dim">folder reported by the box</span>` : ''}`;
  // Status/progress area (probe result → install offer → deploy step list).
  // Below the inputs so it can grow without reflowing the row.
  const status = document.createElement('div');
  status.className = 'peer-row-status hidden';
  row.querySelector('.peer-row-remove').addEventListener('click', () => wrap.remove());
  row.querySelector('.peer-row-test').addEventListener('click', () => peerTestAndSetUp(row, status));
  // Live destination detection badge (→ ssh tunnel / → direct / inline error).
  const destInput = row.querySelector('.peer-row-dest');
  destInput.addEventListener('input', () => updatePeerDestBadge(row));
  updatePeerDestBadge(row); // reflect a pre-filled destination immediately
  wrap.appendChild(row);
  wrap.appendChild(status);
  peersListBox.appendChild(wrap);
  // If this peer is already connected, show its live identity passively (version
  // + caps from the hello we already have) — the same facts Test would surface,
  // without a round-trip, and with an "outdated" nudge on a version mismatch.
  const st = peer.id && peerStatuses.get(peer.id);
  if (st && st.online && st.version) {
    const capList = (st.caps || []).join(', ') || 'none';
    const sev = ourAppVersion ? versionSeverity(ourAppVersion, st.version) : 'unknown';
    // A peer behind us gets the "outdated" nudge; one ahead reads "newer" (we're
    // the stale one). current/unknown add nothing.
    const delta = (sev === 'patch' || sev === 'minor' || sev === 'major')
      ? `<span class="peer-status-warn"> · outdated (you run v${esc(ourAppVersion)})</span>`
      : sev === 'newer'
        ? `<span class="peer-status-dim"> · newer than you (v${esc(ourAppVersion)})</span>`
        : '';
    renderPeerStatus(status,
      `<span class="peer-status-ok">✓ Clodex v${esc(st.version)}</span>` +
      `<span class="peer-status-dim"> · caps: ${esc(capList)}${st.platform ? ` · ${esc(st.platform)}` : ''}</span>${delta}`);
  }
}

// Raw destination string from a row's single smart input (trimmed).
function peerRowDest(row) {
  const el = row.querySelector('.peer-row-dest');
  return el ? el.value.trim() : '';
}

// Live "what will this become?" badge under the destination input. Dim for the
// two happy paths (→ ssh tunnel / → direct), warn-colored inline text for a bad
// value, and hidden when empty. Read-only feedback — the authoritative
// validation runs in collectPeers on Save.
function updatePeerDestBadge(row) {
  const badge = row.querySelector('.peer-row-dest-badge');
  if (!badge) return;
  const cls = classifyPeerDest(peerRowDest(row));
  if (cls.kind === 'empty') {
    badge.className = 'peer-row-dest-badge hidden';
    badge.textContent = '';
    return;
  }
  badge.className = 'peer-row-dest-badge';
  if (cls.kind === 'ssh') badge.innerHTML = '<span class="peer-status-dim">→ ssh tunnel</span>';
  else if (cls.kind === 'url') badge.innerHTML = '<span class="peer-status-dim">→ direct (no tunnel)</span>';
  else badge.innerHTML = `<span class="peer-status-warn">${esc(cls.error)}</span>`;
}

// Per-peer remote port, read live from the row's port input. Returns NaN for a
// blank/non-numeric field so callers can validate; a valid 1..65535 int passes.
function peerRowPort(row) {
  const el = row.querySelector('.peer-row-port');
  const raw = el ? el.value.trim() : '';
  return raw === '' ? NaN : parseInt(raw, 10);
}

// Per-peer deploy folder override (raw operator string, ~/… or /abs). '' = the
// field is blank → deploy falls back to the script's own default.
function peerRowFolder(row) {
  const el = row.querySelector('.peer-row-folder');
  return el ? el.value.trim() : '';
}

// Validate a row's port + folder together, marking the offending input and
// returning the first error (or null when both are fine). port defaults are
// applied by the caller; here we only reject an explicitly-bad value.
function validatePeerRowInputs(row) {
  const portEl = row.querySelector('.peer-row-port');
  const folderEl = row.querySelector('.peer-row-folder');
  if (portEl) portEl.classList.remove('invalid');
  if (folderEl) folderEl.classList.remove('invalid');
  const port = peerRowPort(row);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    if (portEl) portEl.classList.add('invalid');
    return { ok: false, error: 'Port must be a number from 1 to 65535.' };
  }
  const cls = classifyDeployFolder(peerRowFolder(row));
  if (!cls.ok) {
    if (folderEl) folderEl.classList.add('invalid');
    return { ok: false, error: cls.error };
  }
  return { ok: true, port, folder: peerRowFolder(row) };
}

// "Test & Set Up": probe the box (ssh + curl hello on the box, no tunnel), then
// render one of four outcomes. hello-ok = ready to save; no-listener = offer an
// install; not-clodex / ssh-fail = diagnostics. The wizard is an OFFER — Save
// still works whether or not you ever click Test.
async function peerTestAndSetUp(row, status) {
  const dest = classifyPeerDest(peerRowDest(row));
  if (dest.kind === 'empty') { renderPeerStatus(status, `<span class="peer-status-warn">Enter an ssh host or URL first (e.g. user@laptop2).</span>`); return; }
  if (dest.kind === 'error') { renderPeerStatus(status, `<span class="peer-status-warn">${esc(dest.error)}</span>`); return; }
  if (dest.kind === 'url') {
    // Probe + deploy are ssh-only; a direct URL peer just connects on Save.
    renderPeerStatus(status, `<span class="peer-status-dim">Direct URL — nothing to install over ssh; Save and it connects.</span>`);
    return;
  }
  const sshHost = dest.sshHost;
  const v = validatePeerRowInputs(row);
  if (!v.ok) { renderPeerStatus(status, `<span class="peer-status-warn">${esc(v.error)}</span>`); return; }
  const port = v.port;
  const testBtn = row.querySelector('.peer-row-test');
  testBtn.disabled = true;
  renderPeerStatus(status, `<span class="peer-status-dim">ssh <span class="peer-spin">…</span> connecting to ${esc(sshHost)}</span>`);
  let res;
  try { res = await window.api.peerProbe(sshHost, port); }
  catch (e) { res = { kind: 'ssh-fail', stderr: (e && e.message) || 'probe failed' }; }
  testBtn.disabled = false;
  if (!res) { renderPeerStatus(status, `<span class="peer-status-warn">No response from probe.</span>`); return; }
  if (res.kind === 'hello-ok') {
    const caps = (res.caps || []).join(', ') || 'none';
    const plat = res.platform ? ` · ${esc(res.platform)}` : '';
    renderPeerStatus(status,
      `<span class="peer-status-ok">✓ ssh · Clodex v${esc(res.version || '?')}</span>` +
      `<span class="peer-status-dim"> · caps: ${esc(caps)}${plat}</span>` +
      `<div class="peer-status-note">Ready — click Save to add this peer.</div>`);
  } else if (res.kind === 'no-listener') {
    renderPeerStatus(status,
      `<span class="peer-status-ok">✓ ssh</span><span class="peer-status-dim"> · no Clodex answering on 127.0.0.1:${port}</span>` +
      `<div class="peer-status-actions"><button type="button" class="peer-install-btn">Install Clodex on this box</button></div>`);
    status.querySelector('.peer-install-btn').addEventListener('click', () => peerRunDeploy(row, status, sshHost, port));
  } else if (res.kind === 'not-clodex') {
    renderPeerStatus(status,
      `<span class="peer-status-ok">✓ ssh</span><span class="peer-status-warn"> · something is answering on 127.0.0.1:${port}, but it isn't Clodex.</span>` +
      `<div class="peer-status-note">Pick a different port, or free that one on the box.</div>`);
  } else { // ssh-fail
    renderPeerStatus(status,
      `<span class="peer-status-err">✗ ssh could not connect.</span>` +
      (res.stderr ? `<pre class="peer-status-pre">${esc(res.stderr)}</pre>` : '') +
      `<div class="peer-status-note">Check key-based ssh works from a terminal (<code>ssh ${esc(sshHost)}</code>), and that Remote Login is enabled on the box.</div>`);
  }
}

// Install/update Clodex on the box: stream the deploy script's ::marker lines
// into a live step list. Terminal states: ::done (success → save hint),
// ::need-sudo (copyable commands + re-run), or a ::fail / non-zero exit.
async function peerRunDeploy(row, status, sshHost, port) {
  const folder = peerRowFolder(row);   // '' → box uses the script default clone dir
  const steps = new Map();   // name -> { el, state }
  const sudoCmds = [];
  const logLines = [];       // raw ::marker stream, replayed to a fix agent on failure
  let sawDone = false;
  renderPeerStatus(status,
    `<div class="peer-status-dim">Installing Clodex on ${esc(sshHost)} — this can take a few minutes on first run.</div>` +
    `<div class="peer-deploy-steps"></div>` +
    `<div class="peer-deploy-tail"></div>`);
  const stepsBox = status.querySelector('.peer-deploy-steps');
  const tailBox = status.querySelector('.peer-deploy-tail');
  const stepEl = (name) => {
    let s = steps.get(name);
    if (!s) {
      const el = document.createElement('div');
      el.className = 'peer-deploy-step';
      el.innerHTML = `<span class="peer-deploy-mark">…</span> <span class="peer-deploy-name">${esc(name)}</span> <span class="peer-deploy-reason"></span>`;
      stepsBox.appendChild(el);
      s = { el, state: 'run' };
      steps.set(name, s);
    }
    return s;
  };
  deployLineHandlers.set(sshHost, (line) => {
    logLines.push(line);
    const ev = parseDeployLine(line);
    if (ev.type === 'step') { stepEl(ev.name); }
    else if (ev.type === 'ok') { const s = stepEl(ev.name); s.state = 'ok'; s.el.querySelector('.peer-deploy-mark').textContent = '✓'; s.el.classList.add('ok'); }
    else if (ev.type === 'fail') {
      const s = stepEl(ev.name); s.state = 'fail';
      s.el.querySelector('.peer-deploy-mark').textContent = '✗';
      s.el.querySelector('.peer-deploy-reason').textContent = ev.reason ? `— ${ev.reason}` : '';
      s.el.classList.add('fail');
    }
    else if (ev.type === 'need-sudo') { tailBox.innerHTML = `<div class="peer-status-warn">Needs sudo: ${esc(ev.what)}</div>`; }
    else if (ev.type === 'sudo-cmd') {
      sudoCmds.push(ev.command);
      tailBox.innerHTML =
        `<div class="peer-status-warn">Run these on the box, then click Test &amp; Set Up again:</div>` +
        `<pre class="peer-status-pre peer-sudo-cmds">${esc(sudoCmds.join('\n'))}</pre>`;
    }
    else if (ev.type === 'done') { sawDone = true; }
  });
  let res;
  try { res = await window.api.peerDeploy(sshHost, { port, folder }); }
  catch (e) { res = { ok: false, error: (e && e.message) || 'deploy failed' }; }
  deployLineHandlers.delete(sshHost);
  if (res && res.ok && sawDone) {
    tailBox.innerHTML = `<div class="peer-status-ok">✓ Clodex is running on ${esc(sshHost)}. Click Save to add the peer — the tunnel connects automatically.</div>`;
  } else if (res && res.needSudo) {
    // The sudo commands are already shown from the ::sudo-cmd lines; just anchor the retry.
    if (!sudoCmds.length) tailBox.innerHTML = `<div class="peer-status-warn">Needs sudo on the box — see the box's terminal, then Test &amp; Set Up again.</div>`;
    appendDeployActions(tailBox, row, status, sshHost, port, null);
  } else {
    const why = res && res.timedOut ? 'timed out' : (res && res.error) ? res.error : `exit ${res ? res.code : '?'}`;
    const tail = res && res.stderr ? `<pre class="peer-status-pre">${esc(res.stderr)}</pre>` : '';
    tailBox.innerHTML = `<div class="peer-status-err">Install did not finish (${esc(String(why))}).</div>${tail}`;
    // Real failure (not need-sudo): offer an agent to untangle it, plus Re-test.
    // The agent gets the full ::marker stream + the stderr tail as its briefing.
    const logText = logLines.join('\n') + (res && res.stderr ? `\n\n[stderr]\n${res.stderr}` : '');
    appendDeployActions(tailBox, row, status, sshHost, port, logText);
  }
}

// Terminal-state action row for the deploy wizard: always a Re-test (re-runs the
// probe, same as Test & Set Up), and — when a real failure gives us a log — a
// "Fix with an agent" offer that spins up a briefed local Claude session.
function appendDeployActions(tailBox, row, status, sshHost, port, logText) {
  const actions = document.createElement('div');
  actions.className = 'peer-status-actions';
  if (logText != null) {
    const fix = document.createElement('button');
    fix.type = 'button';
    fix.className = 'peer-fix-btn';
    fix.textContent = 'Fix with an agent…';
    fix.addEventListener('click', async () => {
      const label = row.querySelector('.peer-row-label').value.trim() || sshHost;
      const go = await window.api.confirmDeployFix(sshHost);
      if (!go) return;
      const res = await window.api.peerDeployFix(sshHost, port, label, logText);
      if (res && res.ok) {
        showToast(`Opened agent session "${res.name}" to fix ${label}.`, { kind: 'peer-ui' });
      } else {
        showToast(`Could not open a fix session: ${(res && res.error) || 'no response'}`, { kind: 'warm' });
      }
    });
    actions.appendChild(fix);
  }
  const retest = document.createElement('button');
  retest.type = 'button';
  retest.className = 'secondary peer-retest-btn';
  retest.textContent = 'Re-test';
  retest.addEventListener('click', () => peerTestAndSetUp(row, status));
  actions.appendChild(retest);
  tailBox.appendChild(actions);
}

function renderPeerStatus(status, html) {
  status.innerHTML = html;
  status.classList.remove('hidden');
}

// Gather + validate every peer row. Returns { ok:true, peers } or, on the first
// bad port/folder, { ok:false, error, row } after marking the offending input
// and surfacing the message in that row's status panel (so Save can bail).
function collectPeers() {
  const out = [];
  for (const row of peersListBox.querySelectorAll('.peer-row')) {
    const destEl = row.querySelector('.peer-row-dest');
    if (destEl) destEl.classList.remove('invalid');
    const dest = classifyPeerDest(peerRowDest(row));
    if (dest.kind === 'empty') continue;
    const label = row.querySelector('.peer-row-label').value.trim();
    // A malformed destination now errors inline (marks the input, keeps the
    // dialog open) instead of silently vanishing on Save — and one input can
    // only be ssh XOR url, so the old sshHost-wins shadowing is gone.
    if (dest.kind === 'error') {
      if (destEl) destEl.classList.add('invalid');
      const status = row.parentElement && row.parentElement.querySelector('.peer-row-status');
      if (status) renderPeerStatus(status, `<span class="peer-status-warn">${esc(dest.error)}</span>`);
      return { ok: false, error: dest.error, row };
    }
    const v = validatePeerRowInputs(row);
    if (!v.ok) {
      const status = row.parentElement && row.parentElement.querySelector('.peer-row-status');
      if (status) renderPeerStatus(status, `<span class="peer-status-warn">${esc(v.error)}</span>`);
      return { ok: false, error: v.error, row };
    }
    const peer = { id: row.dataset.peerId, label: label || dest.sshHost || dest.url };
    if (dest.kind === 'ssh') peer.sshHost = dest.sshHost;
    else if (dest.kind === 'url') peer.url = dest.url;
    // Port + folder are settings-file-only overrides (like wirescopePort): carry
    // the row's validated values through the save. A folder equal to the default
    // pre-fill still round-trips harmlessly (main re-validates at deploy time).
    peer.remotePort = v.port;
    if (v.folder) peer.deployFolder = v.folder;
    out.push(peer);
  }
  return { ok: true, peers: out };
}

document.getElementById('peers-add').addEventListener('click', () => addPeerRow({}));

async function openPeersDialog() {
  const s = await window.api.getSettings();
  peersListBox.innerHTML = '';
  for (const p of s.peers || []) addPeerRow(p);
  peersOverlay.classList.remove('hidden');
}

function closePeersDialog() { peersOverlay.classList.add('hidden'); }

document.getElementById('btn-peers-cancel').addEventListener('click', closePeersDialog);
document.getElementById('btn-peers-save').addEventListener('click', async () => {
  const collected = collectPeers();
  if (!collected.ok) return;   // invalid port/folder — inline error already shown, keep the dialog open
  await window.api.setSettings({ peers: collected.peers });
  closePeersDialog();
});
peersOverlay.addEventListener('mousedown', (e) => { if (e.target === peersOverlay) closePeersDialog(); });
window.api.onRequestOpenPeersDialog(() => openPeersDialog());
// Window > Peers > <peer> > <session>: attach in this (focused) window.
window.api.onRequestOpenPeerSession((id, name) => openPeerSession(id, name));

async function openPrefs() {
  const s = await window.api.getSettings();
  renderPrefsCheckboxes(prefsClaudeBox, s.claudeComponents, s.statusline.claude, CLAUDE_LABELS);
  prefsClaudeCmd.value = s.statusline.claudeCommand || '';
  renderPrefsCheckboxes(prefsCodexBox, s.codexComponents, s.statusline.codex, CODEX_LABELS);
  prefsProxyEnabled.checked = !!s.proxyEnabled;
  prefsDisableDesignMcp.checked = s.disableClaudeDesignMcp !== false;
  prefsCompactOnResume.checked = !!s.compactOnResume;
  prefsRemoteEnabled.checked = !!s.remoteEnabled;
  // Global default tool-deny set (cwd-independent, so no lower-layer provenance).
  // Unchecked = denied by default for new sessions.
  setClaudeToolsCache(s.claudeTools || []);
  renderToolChecklist(prefsToolsList, new Set(s.defaultToolDeny || []), {});
  prefsOverlay.classList.remove('hidden');
  refreshWsStatus();
  refreshWsLogs();
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
    remoteEnabled: prefsRemoteEnabled.checked,
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
  setAgentLibCache(agentLib || []);
  setPromptLibCache({
    system: (promptLib || []).filter(p => p.kind === 'system'),
    append: (promptLib || []).filter(p => p.kind === 'append'),
  });
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
  setClaudeToolsCache(settings?.claudeTools || []);
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
// Library drawers (prompts / agents / skills)
// ---------------------------------------------------------------------------

// Moved to library-drawers.js AS-IS (not de-duped — see that file's header).
// FLAG: takes getActiveSession (prompt inject) + the checklists cache setters.
initLibraryDrawers({
  getActiveSession: () => activeSession,
  setAgentLibCache, setSkillLibCache,
});

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
    // Seed the dot from the reattach snapshot — activity/attention events
    // fired while this window was detached were dropped, and the next live
    // event may be a turn away.
    const item = sessionList.querySelector(`[data-name="${CSS.escape(entry.name)}"]`);
    if (item) {
      if (entry.activity) item.dataset.activity = entry.activity;
      if (entry.attention) {
        item.dataset.attention = entry.attention.kind;
        item.title = entry.attention.message || 'Needs your attention';
      }
    }
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
