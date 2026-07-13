const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SearchAddon } = require('@xterm/addon-search');
const { PendingInput } = require('../peer-input-queue');
const { versionSeverity, updateApplies, releaseAgeInfo } = require('../proxy-util');
const { STRIP_LEVELS, SEV_LINE, CTX_CAT_LABELS, COST_SPINE, COST_CONTENT, BUST_FAULT, REP_BUCKET_COLOR, REP_BUCKET_LABEL, REP_CAT_COLOR } = require('./lib/constants');
const { esc, shortPath, baseName, fmtTokens, fmtCountdown, fmtMinutes, fmtAgo, fmtUsd, fmtDur, shortTs, fmtBustTokens, fmtBytes } = require('./lib/format');
const { renderDiffHtml, costStackBlock, svgCostChart, bustRow } = require('./lib/render-html');
const { splitModelArg, withModelArg } = require('./lib/args-model');
const { renderAppendChecklist, collectAppendChecklist, renderAgentChecklist, collectAgentChecklist, renderExecChecklist, collectExecChecklist, renderIntentChecklist, collectIntentChecklist, renderBuiltinChecklist, collectBuiltinChecklist, renderInjectChecklist, collectInjectChecklist, renderToolChecklist, collectToolChecklist, renderSkillChecklist, collectSkillChecklist, setChecklistAll, wireBulkToggles, setPromptLibCache, setAgentLibCache, setSkillLibCache, setExecLibCache, setClaudeToolsCache, setDefaultToolDenyCache, getPromptLibCache, getSkillLibCache, getDefaultToolDenyCache } = require('./lib/checklists');
const { autoEnabledFor, reconcilePartialSelection } = require('../scope-util');
const { createIpcLog } = require('./ipc-log');
const { createInboxDrawer } = require('./inbox-drawer');
const { createTermSearch } = require('./term-search');
const { initBanners } = require('./banners');
const { initThemes } = require('./themes');
const { initLibraryDrawers } = require('./library-drawers');
const { initSubagentPopover } = require('./subagent-popover');
const { initSessionHovercard } = require('./session-hovercard');
const { initReportPanel } = require('./popovers/report-panel');
const { initCostPopover } = require('./popovers/cost-popover');
const { initBustPopover } = require('./popovers/bust-popover');
const { initFilesPopover } = require('./popovers/files-popover');
const { initChecklistPopovers } = require('./popovers/checklist-popovers');
const { initContextPopover } = require('./popovers/context-popover');
const { initSessionMenus } = require('./popovers/session-menus');
const { initPeersUi } = require('./peers-ui');

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
const inputModel = document.getElementById('input-model');
const modelRow = document.getElementById('model-row');
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
const btnCreate = document.getElementById('btn-create');
const dialogTitle = document.getElementById('dialog-title');
const nameFieldLabel = document.getElementById('name-field-label');

// New Session dialog doubles as the Templates library editor (F4a): 'create'
// spawns a session, 'template' saves a template (no spawn). editingTemplateId is
// the id being edited in template-mode (null = New). templatesDrawerRefresh is
// the open Templates drawer's list-refresh, captured from initLibraryDrawers so
// a dialog-side save repaints it.
let dialogMode = 'create';
let editingTemplateId = null;
let templatesDrawerRefresh = null;

// A real in-app text-input modal — window.prompt() is a no-op in Electron. Used
// by the session-menu "Export as Template" (no dialog open) and the dialog's own
// "Save as Template" button. Resolves the entered string, or null on cancel.
function promptText(title, initial = '') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'prompt-modal-overlay';
    overlay.innerHTML = `
      <div class="prompt-modal">
        <h3></h3>
        <input type="text" spellcheck="false">
        <div class="dialog-actions">
          <div style="flex:1;"></div>
          <button class="secondary" data-act="cancel" type="button">Cancel</button>
          <button data-act="ok" type="button">OK</button>
        </div>
      </div>`;
    overlay.querySelector('h3').textContent = title;
    const input = overlay.querySelector('input');
    input.value = initial;
    document.body.appendChild(overlay);
    const done = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('[data-act="ok"]').addEventListener('click', () => done(input.value));
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => done(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keep global shortcuts / the dialog's Enter handler out
      if (e.key === 'Enter') done(input.value);
      else if (e.key === 'Escape') done(null);
    });
    setTimeout(() => input.focus(), 50);
  });
}

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

// Type chip glyph — the tinted square at the row's left edge ([data-type]
// picks the tint in CSS; unknown types fall back to the bash grey). A claude
// session routed to a cloud backend shows its backend letter instead of 'A'
// (B = AWS Bedrock, V = GCP Vertex) — it's still an Anthropic model, so the
// chip keeps its claude tint; only the glyph differs.
function typeGlyph(type, backend) {
  if (backend === 'bedrock') return 'B';
  if (backend === 'vertex') return 'V';
  return { claude: 'A', codex: 'C', bash: '›_', remote: '@' }[type]
    || (type ? type[0].toUpperCase() : '?');
}

// Local session rows stay contiguous ABOVE the peer block: renderPeers removes
// and re-appends every [data-peer-ui] header/row at the END of sessionList, so
// a new local row appended naively lands BELOW the peers (the interleaving bug).
// Anchor before the first peer element instead; no peer block → append as before.
// Stable under re-render — renderPeers re-appends the peer block at the end, so
// locals stay above.
function insertLocalSessionRow(item) {
  const firstPeer = sessionList.querySelector('[data-peer-ui]');
  if (firstPeer) sessionList.insertBefore(item, firstPeer);
  else sessionList.appendChild(item);
}

// Add a sidebar entry for a session that failed to restore
function addFailedSessionToSidebar(entry) {
  const item = document.createElement('div');
  item.className = 'session-item failed';
  item.dataset.name = entry.name;
  item.dataset.cwd = entry.cwd || '';
  item.dataset.type = entry.type;
  item.dataset.failed = '1';
  // The hover card (session-hovercard.js) shows the restore error + type/cwd —
  // no title attributes on the row; the small close control keeps its own.
  if (entry.error) item.dataset.error = entry.error;
  if (entry.backend) item.dataset.backend = entry.backend;
  const displayName = entry.label || entry.name;
  item.innerHTML = `
    <span class="session-chip" data-type="${esc(entry.type)}"${entry.backend ? ` data-backend="${esc(entry.backend)}"` : ''}>${typeGlyph(entry.type, entry.backend)}</span>
    <div class="session-info">
      <div class="session-name">${esc(displayName)}</div>
      <div class="session-meta">
        <span class="session-failed-label">failed — click to retry</span>
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
    addSessionToSidebar(entry.name, entry.type, entry.cwd, entry.label, entry.backend || null);
    switchSession(entry.name);
  });

  item.querySelector('.session-close').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm(`Forget session "${entry.name}"? It isn't running — this just removes the saved entry.`)) {
      await window.api.forgetSession(entry.name);
      item.remove();
    }
  });

  insertLocalSessionRow(item);
}

function addSessionToSidebar(name, type, cwd, label, backend = null) {
  const item = document.createElement('div');
  item.className = 'session-item';
  item.dataset.name = name;
  item.dataset.cwd = cwd || '';
  item.dataset.type = type;
  if (backend) item.dataset.backend = backend;
  const displayName = label || name;
  // Second line shows the cwd basename only; type + full path (and the live
  // stats) live in the hover card (session-hovercard.js), so the row carries
  // no title attributes — only the small click controls (✉ flush, × kill)
  // keep native tooltips.
  const cwdLabel = cwd ? esc(baseName(cwd)) : '';
  item.innerHTML = `
    <span class="session-chip" data-type="${esc(type)}"${backend ? ` data-backend="${esc(backend)}"` : ''}>${typeGlyph(type, backend)}</span>
    <div class="session-info">
      <div class="session-name">${esc(displayName)}</div>
      <div class="session-meta">
        ${cwdLabel ? `<span class="session-cwd">${cwdLabel}</span>` : ''}
        <span class="session-badges">
          ${type === 'claude' ? '<span class="session-pending" title="Parked messages waiting — click to deliver now"></span>' : ''}
          <span class="session-warm"></span>
          <span class="session-ctx"></span>
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

  // Click the ✉ parked-message chip to flush that session's queue NOW (operator
  // override). stopPropagation so it doesn't also switch sessions.
  const pendingEl = item.querySelector('.session-pending');
  if (pendingEl) {
    pendingEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      const r = await window.api.flushPending(name);
      if (r && r.ok === false && r.reason === 'dialog-blocked') {
        pendingEl.title = 'Blocked on a permission dialog — answer it first, then flush';
      }
    });
  }

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

  insertLocalSessionRow(item);
}

// Handle context menu actions from main process
// Restart a session and re-create its sidebar tab + terminal. Snapshots sidebar
// metadata first because the kill+respawn wipes the tab via session-exit (same
// dance as the Edit Session save path).
function restartSessionWithReattach(name) {
  const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  const snapType = item ? item.dataset.type || null : null;
  const snapCwd = item ? item.dataset.cwd : null;
  const snapBackend = item ? item.dataset.backend || null : null;
  return window.api.restartSession(name).then((res) => {
    if (!res || !res.ok) {
      alert(`Restart failed: ${res && res.error ? res.error : 'unknown error'}`);
      return;
    }
    if (snapType) {
      createTerminal(name);
      // The respawn recomputed backend authoritatively; prefer it over the row
      // snapshot so a pre-detection session's chip heals on restart.
      addSessionToSidebar(name, snapType, snapCwd, null, res.backend ?? snapBackend);
      switchSession(name);
    }
  });
}

window.api.onSessionContextAction(({ action, name, type, cwd, backend }) => {
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
        addSessionToSidebar(name, type, cwd, null, backend || null);
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
    case 'exportTemplate': {
      // Snapshot this session's config into a named, reusable template (spawnable
      // by name via [agent:spawn … template:Y] or the New Session dropdown).
      promptText(`Export "${name}" as a template`, name).then((tn) => {
        if (!tn) return;
        tn = tn.trim();
        if (!/^[a-zA-Z0-9._-]{1,64}$/.test(tn)) {
          alert('Template name must be 1–64 chars: letters, digits, . _ -');
          return;
        }
        window.api.exportTemplate(name, tn).then((res) => {
          if (!res || !res.ok) {
            alert(`Export as template failed: ${res && res.error ? res.error : 'unknown error'}`);
          }
        });
      });
      break;
    }
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

function removeSession(name, { keepPersisted = false } = {}) {
  const s = sessions.get(name);
  if (s) {
    if (s.peer) {
      // Detach (main forgets both peerAttached + peerControlled durably); keep
      // the local control mirror in step so a re-added tab starts read-only.
      // keepPersisted (peers-ui's soft shed on a disable-driven peer-removed)
      // skips the durable detach so the paused peer's attachment survives for
      // re-enable — the local mirror is still cleared so it comes back read-only.
      if (!keepPersisted) window.api.peerDetach(s.peer.id, s.peer.name);
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

// skipAsyncRefresh: when a template is being applied, the caller re-renders the
// skill/inject/tool checklists itself with the template's captured sets — so
// suppress the default (empty-set) async renders here to avoid a last-write-wins
// race between the two. Also skips resetting extraArgs (the template supplies it).
function applyTypeDefaults({ skipAsyncRefresh = false } = {}) {
  const type = inputType.value;
  if (!skipAsyncRefresh) inputArgs.value = DEFAULT_ARGS[type] || '';
  argsHint.textContent = ARGS_HINTS[type] || '';
  // Prompt refs ARE template fields (library-file references), so authoring mode
  // shows them; only resume/fork stays hidden (runtime-only, still punted).
  const authoring = dialogMode === 'template';
  const supportsSystemPrompt = type === 'claude' || type === 'codex';
  // Model is a projection of extraArgs' --model token — agent-only (both claude
  // and codex take --model), hidden for bash. Clear on type-change alongside the
  // args reset (gated so a template-apply's captured model survives).
  if (modelRow) modelRow.style.display = supportsSystemPrompt ? '' : 'none';
  if (!skipAsyncRefresh) inputModel.value = '';
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
  if (claudeOnly && !skipAsyncRefresh) { refreshNewSessionSkills(); refreshNewSessionInjectSkills(); refreshNewSessionExecCommands(); refreshNewSessionIntents(); refreshNewSessionTools(); }
  const agentType = type === 'claude' || type === 'codex';
  // Resume/fork is runtime-only — hidden while authoring a template.
  resumeRow.style.display = (agentType && !authoring) ? '' : 'none';
  if (!agentType) {
    inputResume.value = '';
    inputFork.checked = false;
  }
  // Proxy routing only makes sense for agent types — and it IS a template field,
  // so it stays visible in template-authoring mode.
  proxyRow.style.display = agentType ? '' : 'none';
  if (!agentType) {
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
// Exec-command grant checklist (Claude only) — which registered commands this
// seat may run. Shares the new-session/edit dialogs; the registry lives in the
// Exec Commands drawer.
const inputExecList = document.getElementById('input-exec-list');
// Per-session intent gate checklist (Claude only) — which `[agent:…]` verbs this
// seat may EMIT. Lives beside exec in the New/template dialog's Other section.
const inputIntentList = document.getElementById('input-intent-list');

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
// Auto-compact opt-out (Claude only; agent-type field). Checked = default ON, so
// collectFormConfig OMITS the key; unchecked writes `autoCompact: false` — the same
// 1:1 key-presence↔opt-out mapping export uses (ipc-handlers.js exportFromSession).
const inputAutoCompact = document.getElementById('input-auto-compact');
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

// Exec-command grant checklist for the currently-entered config (Claude only).
// Seeds the cache from the registry then renders with the enabled grant set.
async function refreshNewSessionExecCommands(enabledSet = new Set()) {
  if (inputType.value !== 'claude') return;
  setExecLibCache((await window.api.listExecCommands()) || []);
  renderExecChecklist(inputExecList, enabledSet);
}

// Intent-gate checklist for the currently-entered config (Claude only). Static
// catalog — no cache/IPC — so this is synchronous, unlike the exec refresh. The
// arg is the raw persisted `intents` value (array, or undefined = the all-enabled
// default → every box checked); renderIntentChecklist reads it via intentEnabled.
function refreshNewSessionIntents(intentsList) {
  if (inputType.value !== 'claude') return;
  renderIntentChecklist(inputIntentList, intentsList);
}

// Populate the new-session Skills checklist for the currently-entered cwd. The
// catalog (known built-ins + whatever a lower settings layer for that cwd
// disables) and provenance both depend on cwd, so this re-runs when cwd changes.
async function refreshNewSessionSkills(disabledSet = new Set()) {
  if (inputType.value !== 'claude') return;
  const cwd = expandPath(inputCwd.value.trim()) || homeDir;
  const res = await window.api.getSkillCatalogFor(cwd);
  if (!res || !res.ok) { renderSkillChecklist(inputSkillsList, [], disabledSet); return; }
  renderSkillChecklist(inputSkillsList, res.names || [], disabledSet,
    res.effective || {}, { skillsLocked: res.skillsLocked, canReenable: res.canReenable });
}
// Tool provenance for the new-session dialog — same cwd-dependence as skills: a
// lower settings layer for the chosen cwd may already deny tools, shown
// read-only here. claudeToolsCache is seeded from getSettings in openDialog.
async function refreshNewSessionTools(disabledSet = null) {
  if (inputType.value !== 'claude') return;
  const cwd = expandPath(inputCwd.value.trim()) || homeDir;
  const res = await window.api.getToolCatalogFor(cwd);
  // Default: pre-uncheck the global default deny set so a fresh session inherits
  // the shared, lean tools loadout out of the box (still editable here per
  // session). A template supplies its OWN captured disabled set instead.
  const disabled = disabledSet || new Set(getDefaultToolDenyCache());
  renderToolChecklist(inputToolsList, disabled, (res && res.ok && res.effective) || {});
}

async function openDialog() {
  editingTemplateId = null;
  setDialogMode('create'); // reset chrome if the last use was a template edit
  sessionCounter++;
  inputName.value = `session-${sessionCounter}`;
  inputType.value = 'claude';
  inputCwd.value = homeDir;
  inputTemplate.value = '';
  inputSystemPrompt.value = '';
  inputResume.value = '';
  inputFork.checked = false;
  if (inputStripLevel) inputStripLevel.value = '0'; // default off each open
  if (inputAutoCompact) inputAutoCompact.checked = true; // default ON (opt-out unchecked)
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
  refreshNewSessionExecCommands();
  refreshNewSessionIntents();
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

inputType.addEventListener('change', () => applyTypeDefaults());
// cwd drives the skill catalog's provenance (which lower-layer settings apply),
// so re-fetch when it changes.
// Bare refs would leak the DOM Event into the first (data) param — disabledSet —
// which then throws `.has is not a function` mid-render and blanks the checklist.
inputCwd.addEventListener('change', () => refreshNewSessionSkills());
inputCwd.addEventListener('change', () => refreshNewSessionTools());

inputProxyMode.addEventListener('change', () => {
  inputProxyUrl.style.display = inputProxyMode.value === 'custom' ? '' : 'none';
  if (inputProxyMode.value === 'custom') inputProxyUrl.focus();
});

// Apply a template's values to the form when selected. A template carries the
// full config subset, so the dialog Create threads it through session:create
// verbatim (no silent partial-apply footgun): type/cwd/args plus the Claude-only
// agent/tool/skill gating, strip level, and proxy. Prompt refs are NOT in a
// template (F6), so the prompt controls are left at their current values.
inputTemplate.addEventListener('change', async () => {
  const id = inputTemplate.value;
  if (!id) return;
  const list = await window.api.listTemplates();
  const t = list.find(x => x.id === id);
  if (!t) return;
  inputType.value = t.type;
  inputCwd.value = t.cwd || homeDir;
  {
    const { model, rest } = splitModelArg(t.extraArgs || []);
    inputModel.value = model;
    inputArgs.value = rest.join(' ');
  }
  argsHint.textContent = ARGS_HINTS[t.type] || '';
  // Fix section show/hide for the type WITHOUT firing the default empty-set
  // async renders — we render the rich checklists below with the template's own
  // captured sets, and a competing default render would race them.
  applyTypeDefaults({ skipAsyncRefresh: true });
  if (t.type === 'claude') {
    renderAgentChecklist(inputAgentsList, new Set(t.agents || []));
    await refreshNewSessionExecCommands(new Set(t.execCommands || []));
    refreshNewSessionIntents(t.intents);
    renderBuiltinChecklist(inputBuiltinsList, new Set(t.denyBuiltins || []));
    await refreshNewSessionTools(new Set(t.disabledTools || []));
    await refreshNewSessionSkills(new Set(t.disabledSkills || []));
    await refreshNewSessionInjectSkills(new Set(t.injectSkills || []));
    if (inputStripLevel) inputStripLevel.value = String(t.stripLevel || 0);
    // Same opt-out prefill as openTemplateEditor — the dropdown-apply path also
    // ignored t.autoCompact before U9 (silent-drop twin), fixed here.
    if (inputAutoCompact) inputAutoCompact.checked = !(t.autoCompact === false);
  }
  // Proxy is an agent-type field; reflect the template's tri-state choice.
  if (t.type === 'claude' || t.type === 'codex') {
    setProxyControls(inputProxyMode, inputProxyUrl, t.proxy ?? null, inputProxyUrl.value);
  }
});

btnTemplateDelete.addEventListener('click', async () => {
  const id = inputTemplate.value;
  if (!id) return;
  await window.api.removeTemplate(id);
  await refreshTemplatesDropdown();
  inputTemplate.value = '';
});

btnSaveTemplate.addEventListener('click', async () => {
  const templateName = await promptText('Save as Template', '');
  if (!templateName) return;
  const name = templateName.trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
    alert('Template name must be 1–64 chars: letters, digits, . _ -');
    return;
  }
  // Full config (F2 fix — the old path saved only type/cwd/args, silently
  // dropping proxy/agents/tools/skills/strip). Name-keyed so re-saving a name
  // overwrites rather than duplicating.
  const res = await window.api.saveTemplateByName({ name, ...collectFormConfig() });
  await refreshTemplatesDropdown();
  if (res && res.template) inputTemplate.value = res.template.id;
  if (templatesDrawerRefresh) templatesDrawerRefresh();
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

// The config subset a template captures — the single source shared by session
// creation (doCreate) and every template save path (F2 fix: the old quick-save
// snapshotted only type/cwd/args and silently dropped the rest). Runtime-only
// bits (resume/fork, prompt refs) are NOT here — doCreate adds those itself.
function collectFormConfig() {
  const type = inputType.value;
  const agentType = type === 'claude' || type === 'codex';
  // Intent allowlist: null when every box is checked (the all-enabled default) —
  // spread conditionally so an all-enabled config carries NO `intents` key, exactly
  // like exportFromSession's opt-out omission (never freeze `[]` = "everything
  // gated" onto a seat that meant "all on"). Present only when ≥1 intent is off.
  const intents = type === 'claude' ? collectIntentChecklist(inputIntentList) : null;
  // Auto-compact opt-out: Claude-only (its checkbox lives in the claude-only
  // Other section). Checked = default = OMIT the key; unchecked = write `false`;
  // NEVER `true` — key presence maps 1:1 to the opt-out, matching export
  // (ipc-handlers.js exportFromSession). Conditional-spread like `intents` so an
  // all-default config carries no key.
  const autoCompactOff = type === 'claude' && inputAutoCompact && !inputAutoCompact.checked;
  // NOTE (maintained-list coupling): the keys this returns are the EDITOR_OWNED
  // set in stores.js `save()` — the dialog fully controls them, so an OMITTED
  // owned key on save means "removed", not "preserve the stored value". Keep the
  // two lists in sync: a new conditionally-omitted key here (like intents /
  // autoCompact) MUST also be in EDITOR_OWNED or merge-preserve will resurrect it.
  return {
    type,
    cwd: expandPath(inputCwd.value.trim()) || homeDir,
    extraArgs: withModelArg(parseArgs(inputArgs.value || ''), inputModel.value),
    proxy: agentType ? proxyValueFromControls(inputProxyMode, inputProxyUrl) : null,
    agents: type === 'claude' ? collectAgentChecklist(inputAgentsList) : [],
    execCommands: type === 'claude' ? collectExecChecklist(inputExecList) : [],
    ...(Array.isArray(intents) ? { intents } : {}),
    ...(autoCompactOff ? { autoCompact: false } : {}),
    denyBuiltins: type === 'claude' ? collectBuiltinChecklist(inputBuiltinsList) : [],
    disabledTools: type === 'claude' ? collectToolChecklist(inputToolsList) : [],
    disabledSkills: type === 'claude' ? collectSkillChecklist(inputSkillsList) : [],
    injectSkills: type === 'claude' ? collectInjectChecklist(inputInjectSkillsList) : [],
    stripLevel: type === 'claude' ? (Number(inputStripLevel && inputStripLevel.value) || 0) : 0,
    // Prompt refs are library-file references (system replaces, appends compose)
    // — captured for BOTH agent types so a codex template round-trips. The
    // legacy inline body is NEVER captured (F2 guard): doCreate passes param-7
    // systemPromptBody=null, sourced independently of cfg.
    systemPromptFile: agentType ? (inputSystemPrompt.value || null) : null,
    appendPromptFiles: agentType ? collectAppendChecklist(inputAppendList) : [],
  };
}

async function doCreate() {
  const name = inputName.value.trim();
  const cfg = collectFormConfig();
  const { type, cwd, extraArgs, proxy, agents, execCommands, denyBuiltins,
          disabledTools, disabledSkills, injectSkills, stripLevel,
          systemPromptFile, appendPromptFiles, intents } = cfg;

  // Prompts are referenced by library file now (system replaces, appends
  // compose), sourced through cfg (single capture path). The legacy inline body
  // is NEVER authored at create — param 7 stays null, independent of cfg (F2).
  const supportsPrompts = type === 'claude' || type === 'codex';
  const systemPromptBody = null;

  if (!name) return;
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
    inputName.style.borderColor = '#e94560';
    return;
  }

  const resumeId = supportsPrompts ? inputResume.value.trim() || null : null;
  const fork = supportsPrompts ? inputFork.checked : false;

  closeDialog();

  if (typeof proxy === 'string') window.api.setSettings({ proxyUrl: proxy }); // remember last used
  const result = await window.api.createSession(name, type, cwd, extraArgs, systemPromptBody, resumeId, fork, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, stripLevel, systemPromptFile, appendPromptFiles, execCommands, intents);
  if (!result.ok) {
    console.error('Failed to create session:', result.error);
    alert(`Failed to create session: ${result.error || 'unknown error'}`);
    refreshDiagBanner(); // a posix_spawnp failure usually means a broken install
    return;
  }

  createTerminal(name);
  addSessionToSidebar(name, type, cwd, null, (result.session && result.session.backend) || null);
  switchSession(name);
}

// The dialog's primary action depends on which mode it was opened in: create a
// session, or save a template (no spawn).
function submitDialog() {
  if (dialogMode === 'template') saveTemplateFromForm();
  else doCreate();
}

document.getElementById('btn-new').addEventListener('click', openDialog);
document.getElementById('btn-cancel').addEventListener('click', closeDialog);
btnCreate.addEventListener('click', submitDialog);

document.getElementById('btn-browse').addEventListener('click', async () => {
  const dir = await window.api.selectDirectory();
  if (dir) { inputCwd.value = dir; refreshNewSessionSkills(); refreshNewSessionTools(); }
});

// Enter to submit (Escape no longer closes — only Cancel button does)
dialogOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitDialog();
});

// --- Templates library editing: the New Session dialog doubles as the template
// editor (F4a — a template IS this form's config; no duplicate control set). ---

// Toggle the dialog's chrome between session-create and template-authoring.
// applyTypeDefaults also reads dialogMode to keep prompt/resume rows hidden while
// authoring even when the type changes.
function setDialogMode(mode) {
  dialogMode = mode;
  const authoring = mode === 'template';
  dialogTitle.textContent = authoring ? (editingTemplateId ? 'Edit Template' : 'New Template') : 'New Session';
  nameFieldLabel.textContent = authoring ? 'Template name' : 'Name';
  btnCreate.textContent = authoring ? 'Save Template' : 'Create';
  // The spawn-from-a-template dropdown and the quick "Save as Template" button
  // are create-mode affordances; in template-mode you're already editing one.
  btnSaveTemplate.style.display = authoring ? 'none' : '';
  if (authoring) templateRow.style.display = 'none'; // create-mode: refreshTemplatesDropdown owns it
}

// Open the dialog as a template editor. tpl = null → blank "New Template"; a
// template object → prefilled "Edit Template" keyed to its id.
async function openTemplateEditor(tpl = null) {
  editingTemplateId = tpl ? tpl.id : null;
  inputType.value = (tpl && tpl.type) || 'claude';
  inputName.value = (tpl && tpl.name) || '';
  inputCwd.value = (tpl && tpl.cwd) || homeDir;
  {
    const { model, rest } = splitModelArg((tpl && tpl.extraArgs) || []);
    inputModel.value = model;
    inputArgs.value = rest.join(' ');
  }
  argsHint.textContent = ARGS_HINTS[inputType.value] || '';
  if (inputStripLevel) inputStripLevel.value = String((tpl && tpl.stripLevel) || 0);
  // Opt-out prefill: unchecked ONLY when the template captured autoCompact:false;
  // absent/true → checked (the default). Mirrors collectFormConfig's key mapping.
  if (inputAutoCompact) inputAutoCompact.checked = !(tpl && tpl.autoCompact === false);
  for (const sec of [toolsSection, skillsSection, otherSection]) { if (sec) sec.open = false; }
  setDialogMode('template');
  // Fix section show/hide for the type without firing the default empty-set async
  // renders — we render the rich checklists below from the template's own sets.
  applyTypeDefaults({ skipAsyncRefresh: true });
  const settings = await window.api.getSettings();
  setClaudeToolsCache(settings?.claudeTools || []);
  setDefaultToolDenyCache(settings?.defaultToolDeny || []);
  setAgentLibCache((await window.api.listAgents()) || []);
  // Prompt refs are agent-type (claude||codex), NOT claude-only — load the
  // library and prefill the system dropdown + append checklist so a codex
  // template round-trips its prompts too. fillSystemPromptSelect falls back to
  // '' when the ref's file is gone (graceful in the UI, like the spawn path).
  const agentType = inputType.value === 'claude' || inputType.value === 'codex';
  if (agentType) {
    await loadPromptLib();
    fillSystemPromptSelect(inputSystemPrompt, (tpl && tpl.systemPromptFile) || '');
    renderAppendChecklist(inputAppendList, new Set((tpl && tpl.appendPromptFiles) || []));
  }
  if (inputType.value === 'claude') {
    renderAgentChecklist(inputAgentsList, new Set((tpl && tpl.agents) || []));
    await refreshNewSessionExecCommands(new Set((tpl && tpl.execCommands) || []));
    refreshNewSessionIntents(tpl && tpl.intents);
    renderBuiltinChecklist(inputBuiltinsList, new Set((tpl && tpl.denyBuiltins) || []));
    await refreshNewSessionTools(new Set((tpl && tpl.disabledTools) || []));
    await refreshNewSessionSkills(new Set((tpl && tpl.disabledSkills) || []));
    await refreshNewSessionInjectSkills(new Set((tpl && tpl.injectSkills) || []));
  }
  setProxyControls(inputProxyMode, inputProxyUrl, (tpl && tpl.proxy) ?? null, settings?.proxyUrl);
  labelProxyDefault(inputProxyMode, settings);
  inputName.style.borderColor = '';
  dialogOverlay.classList.remove('hidden');
  setTimeout(() => inputName.select(), 50);
}

// Save the form as a template (template-mode primary action). New / quick-save
// are name-keyed upserts; Edit renames in place on the known id, blocking a
// rename that would collide with a DIFFERENT template's name (F3 edge — a nudge
// rather than silently merging the other one away).
async function saveTemplateFromForm() {
  const name = inputName.value.trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
    inputName.style.borderColor = '#e94560';
    return;
  }
  const cfg = collectFormConfig();
  if (editingTemplateId) {
    const list = await window.api.listTemplates();
    const clash = list.find(t => t.id !== editingTemplateId && (t.name || '').toLowerCase() === name.toLowerCase());
    if (clash) { inputName.style.borderColor = '#e94560'; return; }
    await window.api.saveTemplate({ ...cfg, id: editingTemplateId, name }); // rename-in-place
  } else {
    await window.api.saveTemplateByName({ ...cfg, name });
  }
  closeDialog();
  await refreshTemplatesDropdown();
  if (templatesDrawerRefresh) templatesDrawerRefresh();
}

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
    // Message rides the dataset for the hover card (no native title on rows).
    el.dataset.attentionMsg = attn.message || '';
  } else {
    delete el.dataset.attention;
    delete el.dataset.attentionMsg;
  }
});

// ---------------------------------------------------------------------------
// Peered Clodexes — core-side anchor only. The peer RUNTIME (sidebar rows,
// peer bar, control, event subscriptions, peer popovers) lives in peers-ui.js;
// what stays here is the shared state below (injected into the module by
// reference) plus the peers-SETUP dialog further down — connection config,
// which reads these Maps directly. Protocol/reconnect logic is main-process
// (peer-client.js). A peer being offline is normal — render calm, never error.
// ---------------------------------------------------------------------------

const peerStatuses = new Map(); // peerId -> status from peer-state events
const peerTunnels = new Map();  // peerId -> managed-tunnel status (may lag peerStatuses)
// Our own app version, cached once for the peer identity "outdated" hint (a peer
// reporting a different version in its hello). null until fetched / if it fails.
let ourAppVersion = null;
window.api.getVersion().then((v) => { ourAppVersion = v || null; }).catch(() => {});

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

// Parked-DM count badge (✉N). Fed by the main-process pending-count poll (deltas
// only) and seeded from session:list on first paint. Click-to-flush is wired in
// addSessionToSidebar; this just paints the count. Hidden at 0 via :empty CSS.
function applyPendingBadge(name, count) {
  const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (!el) return;
  const badge = el.querySelector('.session-pending');
  if (!badge) return;
  badge.textContent = count > 0 ? `✉${count}` : '';
  badge.title = count > 0
    ? `${count} parked message${count === 1 ? '' : 's'} waiting — click to deliver now`
    : 'Parked messages waiting — click to deliver now';
}

window.api.onPendingCount((msg) => {
  if (msg && typeof msg.name === 'string') applyPendingBadge(msg.name, msg.count || 0);
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
  return item ? (item.dataset.type || null) : null;
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
  if (type === 'claude' || type === 'codex') {
    // Touched-files feed stays a STANDALONE button — it's live status (count +
    // unseen accent latch), not a launcher. Fed by the wire (Claude); a Codex
    // session only gets it once something lands in its feed (no Codex tap yet).
    const nFiles = (filesState.get(activeSession) || []).length;
    if (type === 'claude' || nFiles > 0) {
      const label = nFiles > 0 ? `📄 ${nFiles} file${nFiles === 1 ? '' : 's'}` : '📄 files';
      // Unseen-changes latch: accent-lit from the moment a touch lands until
      // the popover is opened — a count silently ticking is too easy to miss.
      const unseen = filesUnseen.has(activeSession) ? ' px-files-new' : '';
      btns.push(`<button class="px-action${unseen}" data-act="files" title="Files this agent's tools touched — click to view or diff">${label}</button>`);
    }
    // Everything else (tools/skills/agents/intents/edit/history/reload) collapses
    // behind ONE button + a dropdown — the bar is out of width even at max, and
    // these are seldom-clicked launchers. Entries are type-conditioned by the
    // session-actions leaf; the menu's onPick routes back to the openers below.
    btns.push('<button class="px-action" data-act="session-menu" title="Session actions — tools, skills, agents, intents, settings, history, reload">⚙ session ▾</button>');
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
      const remaining = p.warmth.remaining_s != null ? p.warmth.remaining_s - ageMs / 1000 : null;
      if (ageMs > PROXY_POLL_MS * 4) {
        badge.textContent = '?'; badge.dataset.state = 'stale';
      } else if (p.warmth.state === 'warm' && remaining != null && remaining > 0) {
        badge.textContent = fmtMinutes(remaining);
        // Under 5 minutes the pill turns red — cache expiry is imminent.
        badge.dataset.state = remaining < 300 ? 'low' : 'warm';
      } else {
        badge.textContent = 'cold'; badge.dataset.state = 'cold';
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

// --- Session-row hover card ----------------------------------------------------
// Self-contained island (session-hovercard.js): replaces the sidebar rows'
// native title tooltips with a styled card fed by the rows' datasets plus the
// same live maps the badges paint from. Nothing comes back — it owns its DOM
// node and listeners entirely.
initSessionHovercard({
  sessionList, proxyState, ctxPct, ctxTokens,
  proxyPollMs: PROXY_POLL_MS, typeGlyph,
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
      if (action.dataset.act === 'files') openFilesPopover(activeSession, action);
      else if (action.dataset.act === 'session-menu') {
        // Toggle the consolidated launcher menu. onPick routes the chosen entry
        // to its opener — the openers span two islands + a core dialog, so the
        // core owns this dispatch (the menu island stays opener-agnostic).
        if (isSessionMenuOpen()) closeSessionMenu();
        else openSessionMenu(action, sessionTypeOf(activeSession), (act, anchor) => routeSessionAction(act, anchor));
      }
      else if (action.dataset.act === 'strip-menu') {
        if (isStripMenuOpen()) closeStripMenu();
        else openStripMenu(action, Number(action.dataset.level) || 0);
      }
      return;
    }
    const btn = e.target.closest('.px-hold');
    if (!btn || !activeSession || btn.dataset.act !== 'warm-menu') return;
    if (isWarmMenuOpen()) closeWarmMenu();
    else openWarmMenu(btn, btn.dataset.held === '1');
  });
})();

// --- Session-action dropdown menus: keep-warm / strip-level / history ---
// Self-contained island (popovers/session-menus.js). No popoverApi — local
// session actions via window.api; the bar's ⚙ actions call the returned openers,
// and isWarmMenuOpen/isStripMenuOpen back the toggle dispatch.
const {
  openWarmMenu, closeWarmMenu, isWarmMenuOpen,
  openStripMenu, closeStripMenu, isStripMenuOpen,
  openSessionMenu, closeSessionMenu, isSessionMenuOpen,
  openHistoryMenu, doHardRestart,
} = initSessionMenus({
  getActiveSession: () => activeSession, proxyState, sessionList,
  createTerminal, addSessionToSidebar, switchSession,
});

// Route a consolidated-menu pick to its opener. Kept in the core because the
// openers span two islands (checklist-popovers + session-menus) plus the core
// Edit dialog; the menu island stays opener-agnostic (it just emits the act).
// `anchor` is the ⚙ button, so the launched popover positions over the bar.
function routeSessionAction(act, anchor) {
  if (!activeSession) return;
  if (act === 'tools') openToolsPopover(activeSession, anchor);
  else if (act === 'skills') openSkillsPopover(activeSession, anchor);
  else if (act === 'agents') openAgentsPopover(activeSession, anchor);
  else if (act === 'intents') openIntentsPopover(activeSession, anchor);
  else if (act === 'edit') openArgsDialog(activeSession);
  else if (act === 'history') openHistoryMenu(activeSession, anchor);
  else if (act === 'reload') doHardRestart(activeSession);
}

// --- Quick config-editor popovers: Tools / Skills / Agents ---
// Self-contained island (popovers/checklist-popovers.js). No popoverApi — these
// edit local session config via window.api; the ctx popover's manage links and
// the bar's ⚙ actions call the returned openers. Tools/Agents are local-only;
// Skills also accepts a peer source (used by peers-ui for Edit Skills on a row).
const { openToolsPopover, openSkillsPopover, openAgentsPopover, openIntentsPopover } = initChecklistPopovers({
  sessionList, createTerminal, addSessionToSidebar, switchSession,
});

// --- Context-breakdown popover — self-contained island (popovers/context-popover.js).
// The core popover plumbing it shares stays here: popoverApi (the local-vs-peer
// data seam every popover reads through) and ctxCatLabel (category labels, also
// used by the report island). initContextPopover() is called after report init
// below — the ctx body links out to the report panel.

// Unknown future categories collapse to "other" (forward-compatible per the
// wirescope contract).
const ctxCatLabel = (c) => CTX_CAT_LABELS[c] || 'other';


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


// ── Cost-over-time popover — self-contained island (popovers/cost-popover.js).
// Data via popoverApi(name).report({detail}); proxyState carries the live poll
// payload (base/sessionId) for the dashboard link.
const { openCostPopover } = initCostPopover({ popoverApi, proxyState });


// ── Cache-bust inspector — self-contained island (popovers/bust-popover.js).
// Data via popoverApi(name).bust(); proxyState carries base/sessionId.
const { openBustPopover } = initBustPopover({ popoverApi, proxyState });

// ── Touched files popover + file-peek — self-contained island
// (popovers/files-popover.js). Owns its onSessionFiles/onSessionFileView
// subscriptions; peek/diff data via popoverApi; the bar's file count/unseen
// state (filesState/filesUnseen/peerFilesCount) + renderProxyBar are core,
// injected by reference; getActiveSession reads the live active tab.
const { openFilesPopover, openFilePeek, isFilesPopoverForKey } = initFilesPopover({
  popoverApi, filesState, filesUnseen, peerFilesCount, renderProxyBar,
  getActiveSession: () => activeSession,
});

// ── Session report (wirescope /_report) — self-contained island
// (popovers/report-panel.js). Consumes the capture through popoverApi;
// ctxCatLabel is the shared category-label helper (also used by ctx).
const { openReportPanel } = initReportPanel({ popoverApi, ctxCatLabel });

// Context-breakdown popover island (popovers/context-popover.js). Wired here,
// after report + checklist inits, because its body links to the report panel
// and the manage-tools/skills popovers — it needs their openers.
const { openContextPopover } = initContextPopover({
  popoverApi, ctxCatLabel, openReportPanel, openToolsPopover, openSkillsPopover,
  proxyState, sessionTypeOf,
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

// Operator inbox drawer + sidebar unread badge (inbox-drawer.js). Self-contained
// — driven by the `notify` ipc broadcast and its own window.api queries, so it
// takes no core state.
createInboxDrawer();

// ---------------------------------------------------------------------------
// Peered Clodexes — self-contained subsystem (peers-ui.js). Owns the peer bar,
// per-peer visibility/control mirrors, the restore/settle machinery, the
// peer-select + peer-info popovers, and every onPeer* subscription + seed. Core
// injects the sessions Map + sidebar/terminal spine; the six handles it still
// calls come back destructured. peerStatuses/peerTunnels (read by the peers-
// setup dialog) stay core, injected by reference; activeSession/ourAppVersion/
// deployLineHandlers are read through getters (reassignable / defined below).
const {
  typeToTakeControl, renderPeerBar, forgetControlMirror,
  openPeerSession, peerDisplayHost, peerHideFromList,
} = initPeersUi({
  sessions, sessionList, getActiveSession: () => activeSession,
  createTerminal, switchSession, removeSession, updateSidebarActive,
  showToast, appendIpcEntry, remeasureReadonlyPeer,
  peerStatuses, peerTunnels, getOurAppVersion: () => ourAppVersion,
  getDeployLineHandlers: () => deployLineHandlers,
  proxyState, ctxPct, ctxTokens, peerFilesCount, filesUnseen,
  applyCtxBadge, applyWarmBadge, renderProxyBar,
  openFilePeek, isFilesPopoverForKey,
  // Edit Session on a peer row reuses the local dialog with a peer data source
  // (hoisted function decl, so referenced above its definition).
  openArgsDialog,
  // Edit Skills on a peer row reuses the local Skills popover with a peer source.
  openSkillsPopover,
});

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

function refitActiveTerminal() {
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
}

const resizeObserver = new ResizeObserver(refitActiveTerminal);
resizeObserver.observe(terminalContainer);

// View-menu zoom changed this window's zoom factor: the container's CSS-pixel
// geometry moved under xterm, so refit through the same path resize uses.
window.api.onZoomNudge(refitActiveTerminal);

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
const argsModel = document.getElementById('args-model');
const argsModelRow = document.getElementById('args-model-row');
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
const argsIntentsList = document.getElementById('args-intents-list');
const argsIntentsSection = document.getElementById('args-intents-section');
const argsExecList = document.getElementById('args-exec-list');
const argsExecSection = document.getElementById('args-exec-section');
wireBulkToggles(argsToolsRow, argsToolsList);
let argsEditingName = null;
// Non-null when the open dialog targets a PEER session: a { fetch, save,
// onRestarted } source (built by peers-ui) that swaps the data layer while the
// dialog DOM stays identical. Null = the local session path (default).
let argsEditingSource = null;
// Scoped-checklist Save inputs for the args-dialog agents list: persisted set,
// rendered (in-scope) names, and auto-included names — so save reconciles instead
// of dropping an out-of-scope persisted agent (and never persists an auto one).
let argsAgentsPersisted = [];
let argsAgentsRendered = [];
let argsAgentsAuto = [];

argsProxyMode.addEventListener('change', () => {
  argsProxyUrl.style.display = argsProxyMode.value === 'custom' ? '' : 'none';
  if (argsProxyMode.value === 'custom') argsProxyUrl.focus();
});

// Edit Session dialog. `argsSource` (peers-ui's peer descriptor) swaps the data
// layer only — fetch the args + catalogs, save the patch, and reattach after a
// restart. Null = the local session path: fetch the four local sources, save via
// setSessionArgs, re-home the tab on restart. The dialog DOM is identical either
// way; a peer edit populates its checklists from the BOX catalogs in the response,
// never the local libraries (the box's agents/prompts/tools are the truth for its
// sessions), and rows with no box catalog fall back to empty, not local data.
async function openArgsDialog(name, argsSource = null) {
  let res, settings, promptLib, agentLib;
  if (argsSource) {
    const r = await argsSource.fetch();
    if (!r || !r.ok) { alert(r && r.error ? r.error : 'Session not found.'); return; }
    ({ res, settings, promptLib, agentLib } = r);
  } else {
    [res, settings, promptLib] = await Promise.all([
      window.api.getSessionArgs(name),
      window.api.getSettings(),
      window.api.listPrompts(),
    ]);
    if (!res || !res.ok) { alert('Session not found in persistence.'); return; }
    // Agents come SCOPE-FILTERED from getSessionArgs (res.agentCatalog), same as
    // the peer path pulls the box's filtered catalog — never the unscoped library.
    agentLib = res.agentCatalog || [];
  }
  argsEditingSource = argsSource;
  setAgentLibCache(agentLib || []);
  setPromptLibCache({
    system: (promptLib || []).filter(p => p.kind === 'system'),
    append: (promptLib || []).filter(p => p.kind === 'append'),
  });
  argsEditingName = name;
  argsTarget.textContent = `${name} (${res.type}) — new settings apply on next spawn.`;
  {
    const { model, rest } = splitModelArg(res.extraArgs || []);
    argsModel.value = model;
    argsInput.value = rest.map(a => /\s/.test(a) ? `"${a}"` : a).join(' ');
  }
  const isAgent = res.type === 'claude' || res.type === 'codex';
  if (argsModelRow) argsModelRow.style.display = isAgent ? '' : 'none';
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
  // Scope: `sessions:`-scoped agents render auto (checked+disabled `· auto`); the
  // agentLib carries frontmatter meta both locally (readSessionArgs.agentCatalog)
  // and over the wire (the box's catalog), so autoEnabledFor resolves either way.
  const argsAuto = new Set(autoEnabledFor(agentLib || [], name));
  renderAgentChecklist(argsAgentsList, new Set(res.agents || []), argsAuto);
  argsAgentsPersisted = res.agents || [];
  argsAgentsRendered = (agentLib || []).map((a) => a.name);
  argsAgentsAuto = [...argsAuto];
  renderBuiltinChecklist(argsBuiltinsList, new Set(res.denyBuiltins || []));
  argsToolsRow.style.display = isClaude ? '' : 'none';
  argsToolsSection.style.display = isClaude ? '' : 'none';
  setClaudeToolsCache(settings?.claudeTools || []);
  renderToolChecklist(argsToolsList, new Set(res.disabledTools || []), res.effectiveTools || {});
  // Intents gate — Claude-only, mirroring the New-Session/template checklist. Prefill
  // from the seat's persisted allowlist: res.intents is the raw value (null = all
  // enabled → every box checked; array = membership), read straight into the shared
  // widget. Editing here OWNS intents (the save patch carries the result).
  argsIntentsSection.style.display = isClaude ? '' : 'none';
  renderIntentChecklist(argsIntentsList, res.intents);
  // Exec grants — Claude-only AND LOCAL-only. A peer edit can neither read the box's
  // grants (readSessionArgs strips them at the wire) nor set them (the save omits the
  // key), so hide the whole section on a peer row: never rendered, collected, or sent.
  // Locally, fill the grant checklist from the exec registry, prechecking this seat's
  // persisted grants. res.execCommands is [] on a peer row (stripped) but the section
  // is hidden there regardless.
  const isExecEditable = isClaude && !argsSource;
  argsExecSection.style.display = isExecEditable ? '' : 'none';
  if (isExecEditable) {
    setExecLibCache((await window.api.listExecCommands()) || []);
    renderExecChecklist(argsExecList, new Set(res.execCommands || []));
  }
  for (const sec of [argsAppendSection, argsToolsSection, argsOtherSection, argsExecSection, argsIntentsSection]) sec.open = false;
  argsRestart.checked = false;
  argsOverlay.classList.remove('hidden');
  setTimeout(() => argsInput.focus(), 50);
}

function closeArgsDialog() {
  argsOverlay.classList.add('hidden');
  argsEditingName = null;
  argsEditingSource = null;
}

document.getElementById('btn-args-cancel').addEventListener('click', closeArgsDialog);
document.getElementById('btn-args-save').addEventListener('click', async () => {
  if (!argsEditingName) return closeArgsDialog();
  const parsed = withModelArg(parseArgs(argsInput.value || ''), argsModel.value);
  const restart = argsRestart.checked;
  const proxy = argsProxyRow.style.display === 'none'
    ? null : proxyValueFromControls(argsProxyMode, argsProxyUrl);
  const promptsHidden = argsPromptRow.style.display === 'none';
  const systemPromptFile = promptsHidden ? null : (argsSystemPrompt.value || null);
  const appendPromptFiles = promptsHidden ? [] : collectAppendChecklist(argsAppendList);
  // Reconcile the scoped agents checklist: keep an out-of-scope persisted agent
  // (never rendered) and exclude auto-included ones from the persisted set.
  const agents = argsAgentsRow.style.display === 'none' ? [] : reconcilePartialSelection(
    argsAgentsPersisted, argsAgentsRendered, collectAgentChecklist(argsAgentsList), argsAgentsAuto);
  const denyBuiltins = argsAgentsRow.style.display === 'none'
    ? [] : collectBuiltinChecklist(argsBuiltinsList);
  const disabledTools = argsToolsRow.style.display === 'none' ? [] : collectToolChecklist(argsToolsList);
  // Intents: this dialog OWNS the gate now (Claude-only section). collect returns
  // null when every box is checked (clear the gate / stay all-enabled) or the
  // enabled subset (incl [] = everything gated, a real value). Non-Claude sessions
  // carry no gate, so null there matches the always-null create-time default — same
  // clear-on-hidden shape as the sibling tools/agents fields above. Both are explicit
  // values that OVERWRITE (the U9 lesson live: an owned key all-checked clears, it
  // doesn't preserve); undefined-preserve is reserved for a patch that omits intents.
  const intents = argsIntentsSection.style.display === 'none' ? null : collectIntentChecklist(argsIntentsList);
  // Exec grants: LOCAL-only. The section is shown ONLY for a local Claude edit, so a
  // hidden section means either a peer row or a non-Claude/non-owning edit — in every
  // such case the grants must be left UNTOUCHED, which the positional local call and
  // the peer patch express differently: the local path passes the collected array (or,
  // when hidden, omits it below); the peer path never carries the key at all.
  const execCommandsGrant = argsExecSection.style.display === 'none' ? undefined : collectExecChecklist(argsExecList);
  const name = argsEditingName;
  // Capture the peer source before closeArgsDialog() clears it (the save runs
  // after the dialog closes).
  const source = argsEditingSource;
  // Snapshot metadata from the current sidebar entry so we can re-render it
  // after the kill+respawn wipes it via session-exit. (Local path only — a peer
  // restart reattaches through its own source.onRestarted.)
  const existing = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  const snapType = existing ? existing.dataset.type || null : null;
  const snapCwd = existing ? existing.dataset.cwd : null;
  const snapBackend = existing ? existing.dataset.backend || null : null;
  closeArgsDialog();
  // systemPrompt (legacy inline) passes undefined so a pre-library inline body
  // survives; disabledSkills/injectSkills likewise (handler preserves on undefined).
  const res = source
    ? await source.save({
        // Peer save NEVER carries execCommands — exec grants are local-only, so the
        // key is omitted entirely (not even []) so a peer edit can't clear the box's
        // grants. remote-wiring strips it belt-and-suspenders regardless.
        extraArgs: parsed, restart, proxy, systemPrompt: undefined, agents, denyBuiltins,
        disabledTools, disabledSkills: undefined, injectSkills: undefined, systemPromptFile, appendPromptFiles, intents,
      })
    : await window.api.setSessionArgs(name, parsed, restart, proxy, undefined, agents, denyBuiltins, disabledTools, undefined, undefined, systemPromptFile, appendPromptFiles, intents, execCommandsGrant);
  if (!res || !res.ok) {
    alert(`Failed: ${res && res.error ? res.error : 'unknown error'}`);
    return;
  }
  if (res.restarted) {
    if (source) source.onRestarted();
    else if (snapType) {
      createTerminal(name);
      addSessionToSidebar(name, snapType, snapCwd, null, res.backend ?? snapBackend);
      switchSession(name);
    }
  }
});

// ---------------------------------------------------------------------------
// Library drawers (prompts / agents / skills)
// ---------------------------------------------------------------------------

// Moved to library-drawers.js AS-IS (not de-duped — see that file's header).
// FLAG: takes getActiveSession (prompt inject) + the checklists cache setters.
// The templates drawer reuses the New Session dialog as its editor, so it calls
// back into the core's openTemplateEditor; the core keeps the drawer's list
// refresh so a dialog-side save repaints the open drawer.
({ refreshTemplatesList: templatesDrawerRefresh } = initLibraryDrawers({
  getActiveSession: () => activeSession,
  setAgentLibCache, setSkillLibCache,
  openTemplateEditor,
}));

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
    addSessionToSidebar(entry.name, entry.type, entry.cwd, entry.label, entry.backend || null);
    // Seed the dot from the reattach snapshot — activity/attention events
    // fired while this window was detached were dropped, and the next live
    // event may be a turn away.
    const item = sessionList.querySelector(`[data-name="${CSS.escape(entry.name)}"]`);
    if (item) {
      if (entry.activity) item.dataset.activity = entry.activity;
      if (entry.attention) {
        item.dataset.attention = entry.attention.kind;
        item.dataset.attentionMsg = entry.attention.message || '';
      }
    }
    if (entry.replay) terminal.write(entry.replay);
    if (typeof entry.ctx === 'number') { ctxPct.set(entry.name, entry.ctx); applyCtxBadge(entry.name, entry.ctx); }
    if (typeof entry.ctxTok === 'number' && typeof entry.ctxSize === 'number' && entry.ctxSize > 0) {
      ctxTokens.set(entry.name, { used: entry.ctxTok, size: entry.ctxSize });
    }
    if (entry.proxy) { proxyState.set(entry.name, { payload: entry.proxy, at: Date.now() }); applyWarmBadge(entry.name); }
    if (typeof entry.pendingCount === 'number') applyPendingBadge(entry.name, entry.pendingCount);
    if (!firstHealthy) firstHealthy = entry.name;
  }
  if (firstHealthy) switchSession(firstHealthy);
  // Focus the first restored session
  switchSession(restored[0].name);
})();
