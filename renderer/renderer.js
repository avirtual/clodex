const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SearchAddon } = require('@xterm/addon-search');
const { PendingInput } = require('../peer-input-queue');
const { versionSeverity, updateApplies, releaseAgeInfo } = require('../proxy-util');
const { STRIP_LEVELS, SEV_LINE, CTX_CAT_LABELS, COST_SPINE, COST_CONTENT, BUST_FAULT, REP_BUCKET_COLOR, REP_BUCKET_LABEL, REP_CAT_COLOR } = require('./lib/constants');
const { esc, shortPath, baseName, fmtTokens, fmtCountdown, fmtMinutes, fmtAgo, fmtUsd, fmtDur, shortTs, fmtBustTokens, fmtBytes } = require('./lib/format');
const { renderDiffHtml, costStackBlock, svgCostChart, bustRow } = require('./lib/render-html');
const { splitModelArg, withModelArg } = require('./lib/args-model');
const { altChordAction } = require('./lib/web-shortcuts');
const { attentionNotice, mentionNotice, badgeTitle, createWebNotifier } = require('./lib/web-notify');
const { detectNotice: sandboxDetectNotice, statusNotice: sandboxStatusNotice, openUrl: sandboxOpenUrl, portsLineText: sandboxPortsLineText } = require('./lib/sandbox-view');
const { SANDBOX_PLACEMENT_CWD, showPlacementSelector, nextCwd: placementNextCwd, richFieldsGreyed } = require('./lib/placement');
const { dropText } = require('./lib/drop-paths');
const { turnSeg, reqSeg, costSeg } = require('./lib/turn-stat');
const { renderAppendChecklist, collectAppendChecklist, renderAgentChecklist, collectAgentChecklist, renderExecChecklist, collectExecChecklist, renderIntentChecklist, collectIntentChecklist, renderBuiltinChecklist, collectBuiltinChecklist, renderInjectChecklist, collectInjectChecklist, renderToolChecklist, collectToolChecklist, renderSkillChecklist, collectSkillChecklist, setChecklistAll, wireBulkToggles, setPromptLibCache, setAgentLibCache, setSkillLibCache, setExecLibCache, setClaudeToolsCache, setDefaultToolDenyCache, getPromptLibCache, getSkillLibCache, getDefaultToolDenyCache } = require('./lib/checklists');
const { autoEnabledFor, reconcilePartialSelection } = require('../scope-util');
const { parseSkillFrontmatter } = require('../skills-util');
// `sessions:`-scoped skills are auto-injected for a matching session (checked +
// disabled in the inject list). Mirrors checklist-popovers' local helper so the
// Edit Session dialog's peer skills section marks them the same way.
const skillAutoSet = (skillLib, session) => new Set(autoEnabledFor(
  (skillLib || []).map((s) => ({ name: s.name, meta: parseSkillFrontmatter(s.content || '').meta })), session));
const { createIpcLog } = require('./ipc-log');
const { createInboxDrawer } = require('./inbox-drawer');
const { createPotDrawer } = require('./pot-drawer');
const { createTermSearch } = require('./term-search');
const { initBanners } = require('./banners');
const { initThemes } = require('./themes');
const { initLibraryDrawers } = require('./library-drawers');
const { initSubagentPopover } = require('./subagent-popover');
const { initSessionHovercard } = require('./session-hovercard');
const { initTooltips } = require('./tooltip');
const { initReportPanel } = require('./popovers/report-panel');
const { initCostPopover } = require('./popovers/cost-popover');
const { initBustPopover } = require('./popovers/bust-popover');
const { initFilesPopover } = require('./popovers/files-popover');
const { initChecklistPopovers } = require('./popovers/checklist-popovers');
const { initContextPopover } = require('./popovers/context-popover');
const { initSessionMenus } = require('./popovers/session-menus');
const { initPeersUi } = require('./peers-ui');
const { initWorkbenchPopover } = require('./popovers/workbench-popover');

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
// Opt-in git worktree (New Session dialog): the row reveals only inside a git
// repo, and the branch/base fields only once the box is checked. cwdSuggestionsList
// backs the working-directory MRU datalist.
const inputWorktree = document.getElementById('input-worktree');
const inputWorktreeBranch = document.getElementById('input-worktree-branch');
const inputWorktreeBase = document.getElementById('input-worktree-base');
const worktreeBaseList = document.getElementById('worktree-base-list');
const worktreeFields = document.getElementById('worktree-fields');
const worktreeRow = document.getElementById('worktree-row');
const cwdSuggestionsList = document.getElementById('cwd-suggestions');
// New Session placement selector (docs/sandbox-plan.md M3; N boxes in M6b P3) —
// Host + one entry per registered sandbox box. The selected <option>'s value is the
// placement: 'host' or a box id.
const placementRow = document.getElementById('placement-row');
const inputPlacement = document.getElementById('input-placement');
const placementHint = document.getElementById('placement-hint');
// The rich fields greyed for sandbox placement (skills/prompts/tools/proxy/
// intents/exec don't cross the create-on-peer wire until M5). Resolved by id at
// call time — some of these row/section consts are declared later in the file.
const PLACEMENT_RICH_ROW_IDS = [
  'system-prompt-row', 'append-prompts-row', 'tools-section', 'skills-section', 'other-section', 'proxy-row',
];

// Placement hint copy (M5). The greyed state means different things now: an old
// (non-create2) box can't take the rich fields at all; a create2 box CAN but its
// catalogs momentarily failed to load. Wrong-catalog is worse than no-catalog, so
// a fetch failure greys with the "unavailable" hint rather than showing the Mac's
// libraries as if they were the box's.
const PLACEMENT_HINT_OLD_BOX = 'This sandbox is running an older Clodex that can’t configure skills, prompts, tools, proxy, or intents at create — set them from the session once it’s running, or update the sandbox.';
const PLACEMENT_HINT_CATALOGS_UNAVAILABLE = 'Couldn’t load the sandbox’s skills/agents/tools catalogs — configure this session from the sandbox once it’s running.';
// A box that's in the registry but not running (no online peer). Nothing to fetch
// and create is blocked with a clear error — tell the user to start it first.
const PLACEMENT_HINT_BOX_OFFLINE = 'This sandbox isn’t running — start it from the Sandboxes panel, then pick it here.';
// Monotonic guard so a slow peerCatalogs() response that lands after the user has
// flipped back to Host (or re-flipped) is discarded instead of clobbering the UI.
let placementCatalogToken = 0;
// Host catalogs captured at dialog open, so a flip back from Sandbox restores the
// Mac's libraries without a re-fetch race (setAgentLibCache et al. are swapped to
// box truth while on Sandbox).
let dialogHostSettings = null;
let dialogHostAgentLib = null;

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
    newSpan.dataset.tip = 'Double-click to rename workspace';
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
    <button class="session-close" data-tip="Forget session">&times;</button>
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

// A lightweight ARCHIVED placeholder row (no terminal, no live PTY). Clicking it
// resumes the session (unarchive → resume-spawn); the ✕ deletes it for good.
// Mirrors the failed-row gesture. Seeds sidebarMeta so the status filter, sort,
// and grouping see it — its archivedAt doubles as the recency stand-in.
function addArchivedSessionToSidebar(entry) {
  if (sessionList.querySelector(`[data-name="${CSS.escape(entry.name)}"]`)) return;
  const item = document.createElement('div');
  item.className = 'session-item archived';
  item.dataset.name = entry.name;
  item.dataset.cwd = entry.cwd || '';
  item.dataset.type = entry.type;
  if (entry.backend) item.dataset.backend = entry.backend;
  const displayName = entry.label || entry.name;
  item.innerHTML = `
    <span class="session-chip" data-type="${esc(entry.type)}"${entry.backend ? ` data-backend="${esc(entry.backend)}"` : ''}>${typeGlyph(entry.type, entry.backend)}</span>
    <div class="session-info">
      <div class="session-name">${esc(displayName)}</div>
      <div class="session-meta">
        <span class="session-archived-label">archived — click to resume</span>
      </div>
    </div>
    <button class="session-close" data-tip="Delete archived session">&times;</button>
  `;

  // Click (except close) resumes: clear the archive stamp FIRST so the resume's
  // own upsert doesn't re-inherit it, then spawn from the persisted entry.
  item.addEventListener('click', async (e) => {
    if (e.target.closest('.session-close')) return;
    await window.api.unarchiveSession(entry.name);
    const res = await window.api.retrySpawnSession(entry.name);
    if (!res || !res.ok) { alert(`Resume failed: ${(res && res.error) || 'unknown error'}`); return; }
    item.remove();
    sidebarMeta.delete(entry.name);
    createTerminal(entry.name);
    addSessionToSidebar(entry.name, entry.type, entry.cwd, entry.label, entry.backend || null);
    if (entry.createdAt) sidebarMeta.set(entry.name, { ...(sidebarMeta.get(entry.name) || {}), createdAt: entry.createdAt });
    switchSession(entry.name);
    refreshSidebarView();
  });

  item.querySelector('.session-close').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm(`Delete archived session "${displayName}"? It isn't running — this just removes the saved entry.`)) {
      await window.api.forgetSession(entry.name);
      item.remove();
      sidebarMeta.delete(entry.name);
      refreshSidebarView();
    }
  });

  insertLocalSessionRow(item);
  sidebarMeta.set(entry.name, {
    ...(sidebarMeta.get(entry.name) || {}),
    lastActivityTs: entry.archivedAt || null,
    createdAt: entry.createdAt || null,
    archivedAt: entry.archivedAt || null,
  });
}

// The reshaped ✕ / ⌘W gesture: archive (stop the PTY, keep the record) and swap
// the live row for an archived placeholder. The swap can't happen synchronously
// — archiveSession triggers a session-exit — so we stash the row's identity here
// and let onSessionExit rebuild it as archived (staying silent; an archive exit
// is expected). Peer rows never reach here (they detach/hide instead).
const archivingSessions = new Map(); // name -> { name, type, cwd, label, backend, archivedAt, createdAt }
async function archiveSessionRow(name) {
  const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (!item) return;
  const nameEl = item.querySelector('.session-name');
  const displayed = nameEl ? nameEl.textContent : name;
  const meta = sidebarMeta.get(name) || {};
  archivingSessions.set(name, {
    name,
    type: item.dataset.type,
    cwd: item.dataset.cwd || '',
    label: displayed && displayed !== name ? displayed : null,
    backend: item.dataset.backend || null,
    archivedAt: Date.now(),
    createdAt: meta.createdAt || null,
  });
  const res = await window.api.archiveSession(name);
  if (!res || !res.ok) {
    archivingSessions.delete(name);
    showToast(`Archive failed: ${(res && res.error) || 'unknown error'}`, { kind: 'error', duration: 10000, name });
  }
}

// The reshaped right-click "Delete Session…": confirm (worktree-aware, native),
// then delete. session:kill removes the record + any worktree checkout (awaited
// main-side); a worktree-removal failure comes back on { error } to toast while
// the row still goes (session-exit removes it).
async function deleteSessionRow(name) {
  if (!(await window.api.confirmKill(name))) return;
  const res = await window.api.killSession(name);
  if (res && res.error) {
    showToast(`Worktree removal failed: ${res.error}`, { kind: 'warn', duration: 12000, name });
  }
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
  // no title attributes — the small click controls (✉ flush, × kill) carry
  // data-tip like the rest of the sidebar (tooltip.js), not native titles.
  const cwdLabel = cwd ? esc(baseName(cwd)) : '';
  item.innerHTML = `
    <span class="session-chip" data-type="${esc(type)}"${backend ? ` data-backend="${esc(backend)}"` : ''}>${typeGlyph(type, backend)}</span>
    <div class="session-info">
      <div class="session-name">${esc(displayName)}</div>
      <div class="session-meta">
        ${cwdLabel ? `<span class="session-cwd">${cwdLabel}</span>` : ''}
        <span class="session-badges">
          ${type === 'claude' ? '<span class="session-pending" data-tip="Parked messages waiting — click to deliver now"></span>' : ''}
          <span class="session-think"></span>
          <span class="session-warm"></span>
          <span class="session-ctx"></span>
        </span>
      </div>
    </div>
    <button class="session-close" data-tip="Archive session">&times;</button>
  `;

  item.addEventListener('click', (e) => {
    if (e.target.closest('.session-close')) return;
    if (e.target.closest('.rename-input')) return;
    switchSession(name);
  });

  // ✕ archives now (instant, resumable) — delete moved to the right-click menu.
  item.querySelector('.session-close').addEventListener('click', (e) => {
    e.stopPropagation();
    archiveSessionRow(name);
  });

  // Click the ✉ parked-message chip to flush that session's queue NOW (operator
  // override). stopPropagation so it doesn't also switch sessions.
  const pendingEl = item.querySelector('.session-pending');
  if (pendingEl) {
    pendingEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      const r = await window.api.flushPending(name);
      if (r && r.ok === false && r.reason === 'dialog-blocked') {
        pendingEl.dataset.tip = 'Blocked on a permission dialog — answer it first, then flush';
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
  // A freshly-created session is active NOW — seed its meta so recency sort
  // places it correctly before the next meta poll, then re-lay-out the block so
  // grouping/sorting/filtering apply immediately.
  sidebarMeta.set(name, { ...(sidebarMeta.get(name) || {}), lastActivityTs: Date.now() });
  scheduleSidebarRelayout();
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
    case 'kill': // right-click "Delete Session…" — the real delete (confirm + worktree)
      deleteSessionRow(name);
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
  sidebarMeta.delete(name);
  if (typeof refreshSidebarView === 'function') refreshSidebarView();
}

function updateSidebarActive() {
  for (const el of sessionList.querySelectorAll('.session-item')) {
    el.classList.toggle('active', el.dataset.name === activeSession);
  }
}

// ---------------------------------------------------------------------------
// Sidebar view: group / sort / filter / search
// ---------------------------------------------------------------------------
// The row ELEMENTS are still created by addSessionToSidebar (so xterm state,
// event listeners, and live badges survive); this engine only reorders them,
// toggles their visibility, and inserts group headers — never destroys a live
// row. Archive-backed rows are a later (kill-flow) slice; the status filter
// tolerates their absence (nothing is archived yet, so active/all coincide).

// Current view state; loaded from the workspace store on boot, persisted on
// every change. Defaults: recency sort, no grouping, ALL statuses — archived
// rows must be visible-dimmed by default so ✕/⌘W reads as archive (a dimmed
// row in place), never as a silent delete. 'Active' is the opt-in hide.
let sidebarView = { group: 'none', sort: 'recency', status: 'all', activity: 'all', search: '' };
// name -> { lastActivityTs, createdAt, branch, prState, prNumber }
const sidebarMeta = new Map();
const collapsedGroups = new Set(); // group keys the user collapsed

const sbSearch = document.getElementById('sidebar-search');
const sbGroup = document.getElementById('sidebar-group');
const sbSort = document.getElementById('sidebar-sort');
const sbStatus = document.getElementById('sidebar-status');
const sbActivity = document.getElementById('sidebar-activity');

// Project label for a cwd: repo/dir basename, with its parent for context.
function projectLabel(cwd) {
  if (!cwd) return '(no directory)';
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length <= 1) return cwd;
  return parts.slice(-2).join('/');
}

function stateOf(item) {
  if (item.dataset.attention) return 'needs attention';
  const a = item.dataset.activity;
  if (a === 'thinking' || a === 'working') return 'working';
  if (item.classList.contains('archived')) return 'archived';
  return 'idle';
}

function dateBucket(ts) {
  if (!ts) return 'Unknown';
  const days = (Date.now() - ts) / 86400000;
  if (days < 1) return 'Today';
  if (days < 2) return 'Yesterday';
  if (days < 7) return 'This week';
  if (days < 30) return 'This month';
  return 'Older';
}

const DATE_ORDER = ['Today', 'Yesterday', 'This week', 'This month', 'Older', 'Unknown'];
const STATE_ORDER = ['needs attention', 'working', 'idle', 'archived'];
const PR_ORDER = ['open', 'merged', 'closed', 'none', 'no PR / unknown'];

// The group key + display label a row falls into for the current group mode.
function groupFor(item) {
  const meta = sidebarMeta.get(item.dataset.name) || {};
  switch (sidebarView.group) {
    case 'project': return projectLabel(item.dataset.cwd);
    case 'state': return stateOf(item);
    case 'date': return dateBucket(meta.lastActivityTs || meta.createdAt);
    case 'pr': return meta.prState ? meta.prState : 'no PR / unknown';
    default: return null;
  }
}

function groupSortIndex(mode, key) {
  const order = mode === 'date' ? DATE_ORDER : mode === 'state' ? STATE_ORDER : mode === 'pr' ? PR_ORDER : null;
  if (!order) return 0;
  const i = order.indexOf(key);
  return i === -1 ? order.length : i;
}

// Does a row pass the current status/activity/search filters?
function rowPasses(item) {
  const meta = sidebarMeta.get(item.dataset.name) || {};
  const archived = item.classList.contains('archived');
  if (sidebarView.status === 'active' && archived) return false;
  if (sidebarView.status === 'archived' && !archived) return false;
  // Last-activity window (skip for archived — they have no live activity).
  if (sidebarView.activity !== 'all' && !archived) {
    const ts = meta.lastActivityTs || meta.createdAt;
    const maxMs = Number(sidebarView.activity) * 86400000;
    if (!ts || (Date.now() - ts) > maxMs) return false;
  }
  // Search over name, cwd, branch.
  const q = sidebarView.search.trim().toLowerCase();
  if (q) {
    const hay = `${item.dataset.name} ${item.dataset.cwd || ''} ${meta.branch || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function rowSortValue(item) {
  const meta = sidebarMeta.get(item.dataset.name) || {};
  switch (sidebarView.sort) {
    case 'created': return meta.createdAt || 0;
    case 'alpha': return item.dataset.name.toLowerCase();
    default: return meta.lastActivityTs || meta.createdAt || 0; // recency
  }
}

function compareRows(a, b) {
  const va = rowSortValue(a), vb = rowSortValue(b);
  if (sidebarView.sort === 'alpha') return String(va).localeCompare(String(vb));
  return vb - va; // recency/created: newest first
}

// The one place that lays out the local session block. Reads every non-peer,
// non-child .session-item, applies filter/sort/group, and re-inserts them
// (with group headers) ABOVE the peer block. Child subagent rows ride with
// their parent. Idempotent and safe to call on any state change.
function refreshSidebarView() {
  const firstPeer = sessionList.querySelector('[data-peer-ui]');
  // Collect local top-level rows (exclude peer rows + subagent children).
  const rows = [...sessionList.querySelectorAll('.session-item')].filter(
    (el) => !el.dataset.peerUi && !el.classList.contains('peer-item') && !el.classList.contains('session-child'));
  // Remove any prior group headers / empty note.
  sessionList.querySelectorAll('.session-group-header, .session-empty-note').forEach((el) => el.remove());

  // Partition into visible / hidden by filter, and paint each row's PR badge.
  for (const el of rows) {
    applyPrBadge(el);
    const pass = rowPasses(el);
    el.style.display = pass ? '' : 'none';
    // Hide a row's subagent children with it.
    sessionList.querySelectorAll(`.session-child[data-parent="${CSS.escape(el.dataset.name)}"]`)
      .forEach((c) => { c.style.display = pass ? '' : 'none'; });
  }
  const visible = rows.filter((el) => el.style.display !== 'none');

  // childrenOf: subagent rows to re-attach right after each parent.
  const childrenOf = (name) =>
    [...sessionList.querySelectorAll(`.session-child[data-parent="${CSS.escape(name)}"]`)];

  const place = (el, anchor) => {
    // Insert el (and its children) before `anchor` (or before the peer block).
    const ref = anchor || firstPeer || null;
    if (ref) sessionList.insertBefore(el, ref); else sessionList.appendChild(el);
    for (const c of childrenOf(el.dataset.name)) {
      if (ref) sessionList.insertBefore(c, ref); else sessionList.appendChild(c);
    }
  };

  if (!visible.length) {
    const note = document.createElement('div');
    note.className = 'session-empty-note';
    note.textContent = rows.length ? 'No sessions match the current filter.' : 'No sessions yet.';
    if (firstPeer) sessionList.insertBefore(note, firstPeer); else sessionList.appendChild(note);
    return;
  }

  if (sidebarView.group === 'none') {
    for (const el of visible.sort(compareRows)) place(el, firstPeer);
    return;
  }

  // Group: bucket, then order groups, then rows within each group.
  const groups = new Map(); // key -> rows[]
  for (const el of visible) {
    const key = groupFor(el) || '(other)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(el);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = groupSortIndex(sidebarView.group, a), ib = groupSortIndex(sidebarView.group, b);
    if (ia !== ib) return ia - ib;
    return String(a).localeCompare(String(b));
  });
  for (const key of keys) {
    const header = makeGroupHeader(key, groups.get(key).length);
    if (firstPeer) sessionList.insertBefore(header, firstPeer); else sessionList.appendChild(header);
    const collapsed = collapsedGroups.has(key);
    for (const el of groups.get(key).sort(compareRows)) {
      place(el, firstPeer);
      if (collapsed) {
        el.style.display = 'none';
        childrenOf(el.dataset.name).forEach((c) => { c.style.display = 'none'; });
      }
    }
  }
}

// Paint the PR-status chip + branch tooltip onto a row from its meta. Shown for
// open/merged/closed (a real PR); hidden for none/unknown so the row stays lean.
// The chip lives in .session-badges (created by addSessionToSidebar).
function applyPrBadge(item) {
  const badges = item.querySelector('.session-badges');
  if (!badges) return;
  const meta = sidebarMeta.get(item.dataset.name) || {};
  let chip = badges.querySelector('.session-pr');
  const state = meta.prState;
  if (!state || state === 'none') { if (chip) chip.remove(); return; }
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'session-pr';
    badges.appendChild(chip);
  }
  chip.classList.remove('open', 'merged', 'closed');
  if (state === 'open' || state === 'merged' || state === 'closed') chip.classList.add(state);
  chip.textContent = meta.prNumber ? `#${meta.prNumber}` : state;
  // data-tip (not native title) — the sidebar tooltip mechanism (tooltip.js) is
  // body-delegated, so this dynamically-added chip is picked up automatically.
  chip.setAttribute('data-tip', `PR ${state}${meta.branch ? ` · ${meta.branch}` : ''}`);
}

// Debounced re-layout — activity events can arrive in bursts; coalesce them so
// grouping/sorting recomputes at most ~4×/sec instead of per event.
let relayoutTimer = null;
function scheduleSidebarRelayout() {
  if (relayoutTimer) return;
  relayoutTimer = setTimeout(() => { relayoutTimer = null; refreshSidebarView(); }, 250);
}

function makeGroupHeader(key, count) {
  const h = document.createElement('div');
  h.className = 'session-group-header';
  if (collapsedGroups.has(key)) h.classList.add('collapsed');
  h.dataset.groupKey = key;
  const caret = document.createElement('span');
  caret.className = 'session-group-caret';
  caret.textContent = '▾';
  const title = document.createElement('span');
  title.className = 'session-group-title';
  title.textContent = key;
  const cnt = document.createElement('span');
  cnt.className = 'session-group-count';
  cnt.textContent = String(count);
  h.append(caret, title, cnt);
  h.addEventListener('click', () => {
    if (collapsedGroups.has(key)) collapsedGroups.delete(key); else collapsedGroups.add(key);
    refreshSidebarView();
  });
  return h;
}

// Pull fresh meta (timestamps + PR status) for this workspace and re-render.
// includePr:false for cheap timestamp-only refreshes (the periodic poll).
let metaRefreshInFlight = false;
async function refreshSidebarMeta({ includePr = true } = {}) {
  if (metaRefreshInFlight) return;
  metaRefreshInFlight = true;
  try {
    const res = await window.api.sidebarMeta({ includePr });
    if (res && res.ok && res.meta) {
      for (const [name, m] of Object.entries(res.meta)) {
        sidebarMeta.set(name, { ...(sidebarMeta.get(name) || {}), ...m });
      }
    }
  } catch {} finally { metaRefreshInFlight = false; }
  refreshSidebarView();
}

// Persist + apply a view change from the toolbar controls.
function onViewControlChange() {
  sidebarView = {
    group: sbGroup.value, sort: sbSort.value,
    // Guarded read: sbStatus is the Active/Archived/All select; the fallback
    // preserves the current value if the control is ever absent.
    status: sbStatus ? sbStatus.value : sidebarView.status,
    activity: sbActivity.value,
    search: sbSearch.value,
  };
  window.api.setSidebarView(sidebarView);
  refreshSidebarView();
}
if (sbGroup) sbGroup.addEventListener('change', onViewControlChange);
if (sbSort) sbSort.addEventListener('change', onViewControlChange);
if (sbStatus) sbStatus.addEventListener('change', () => { onViewControlChange(); refreshSidebarMeta(); });
if (sbActivity) sbActivity.addEventListener('change', onViewControlChange);
if (sbSearch) sbSearch.addEventListener('input', onViewControlChange);

// Load persisted view state + do the first meta fetch. Called from the restore
// bootstrap once rows exist.
async function initSidebarView() {
  try {
    const res = await window.api.getSidebarView();
    if (res && res.ok && res.view) {
      const v = { ...res.view };
      // One-time migration: 'active' was the OLD default and hides archived
      // rows, which made the reshaped ✕/⌘W read as a silent delete (the dimmed
      // archived row was filtered out). The default is now 'all'; normalize a
      // persisted 'active' that predates this change. The statusMigrated marker
      // makes it fire ONCE per workspace, so a future DELIBERATE Active choice
      // survives (persisted after the marker is set). Persist here (a load-time
      // migration write, same pattern as persistence._load's workspaceId fill).
      if (!v.statusMigrated) {
        if (v.status === 'active') v.status = 'all';
        window.api.setSidebarView({ status: v.status, statusMigrated: true });
      }
      delete v.statusMigrated; // marker stays in the store, not in live view state
      sidebarView = { ...sidebarView, ...v };
    }
  } catch {}
  if (sbGroup) sbGroup.value = sidebarView.group;
  if (sbSort) sbSort.value = sidebarView.sort;
  if (sbStatus) sbStatus.value = sidebarView.status;
  if (sbActivity) sbActivity.value = sidebarView.activity;
  if (sbSearch) sbSearch.value = sidebarView.search || '';
  await refreshSidebarMeta();
  // Periodic timestamp refresh so recency sort + activity filter stay live.
  setInterval(() => refreshSidebarMeta({ includePr: false }), 30000);
}

// Number of sessions currently flagged needs-attention — derived from the same
// dataset the sidebar badge uses, so the title count can never drift from it.
function webAttentionCount() {
  return sessionList.querySelectorAll('.session-item[data-attention]').length;
}

function updateWindowTitle() {
  const n = sessions.size;
  const base = n === 0 ? 'Clodex'
    : n === 1 ? 'Clodex (1 session)'
    : `Clodex (${n} sessions)`;
  // Browser tabs have no dock/taskbar badge, so a hidden tab surfaces pending
  // attention through a "(N)" title prefix. Desktop is unchanged — the ternary
  // yields the same three base strings.
  document.title = window.__CLODEX_WEB__ ? badgeTitle(base, webAttentionCount()) : base;
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
  // you type during the acquire). onData ALSO fires for mouse/scroll reports
  // (the Claude pane enables mouse tracking) and terminal query replies, so
  // typeToTakeControl gates on isHumanPtyInput — passive browsing stays passive.
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

// ── Drag-drop a file onto the active session: type its shell-quoted path at
// the prompt (iTerm behavior). Desktop-only — browsers don't expose host paths
// on dropped Files; Electron 32+ removed File.path, so resolution goes through
// webUtils.getPathForFile. window.require (nodeIntegration) is the electron
// access: esbuild leaves it alone, so the web bundle sees undefined and the
// handler degrades to a toast. Document-level preventDefault first — without it
// a drop that misses the handler navigates the whole window to file://.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
terminalContainer.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  if (!files.length || !activeSession) return;
  if (window.__CLODEX_WEB__ || !window.require) {
    showToast('Dropping files needs the desktop app — browsers don’t expose file paths.', { kind: 'peer-ui' });
    return;
  }
  const entry = sessions.get(activeSession);
  if (!entry) return;
  if (entry.peer) {
    // A host path means nothing inside a peer/sandbox filesystem — typing it
    // would just plant a broken path at the remote prompt.
    showToast(`"${activeSession}" runs on a peer — its filesystem doesn’t have this file.`, { kind: 'peer-ui' });
    return;
  }
  const { webUtils } = window.require('electron');
  // Claude sessions get @-mention form (CLI attaches the file itself — no agent
  // Read round-trip); bash/codex get shell-quoted paths.
  const style = sessionTypeOf(activeSession) === 'claude' ? 'claude' : 'shell';
  const text = dropText(files.map((f) => {
    try { return webUtils.getPathForFile(f); } catch { return null; }
  }), style);
  if (!text) return;
  window.api.writeToSession(activeSession, text);
  entry.terminal.focus();
});

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
  // A type change reset (and, for Claude, re-fetched from HOST sources) the rich
  // rows. If placement is a box, re-apply the sandbox state so box catalogs
  // (create2) or the greyed state (non-create2/offline) win over the host defaults
  // just rendered. No cwd mutation here — that's applyPlacement's job.
  if (currentPlacement() !== 'host') applySandboxState();
  // Worktree is runtime-only (a concrete checkout, not reusable config) AND
  // repo-only — refreshWorktreeForCwd owns its visibility (hidden here first so a
  // non-repo / template-authoring open never flashes the row).
  if (worktreeRow) {
    worktreeRow.style.display = 'none';
    if (inputWorktree) inputWorktree.checked = false;
    if (worktreeFields) worktreeFields.style.display = 'none';
    if (!authoring) refreshWorktreeForCwd();
  }
}

// Grey (disable + dim) or restore the rich rows for the current placement. When
// greyed, `hintText` (if given) replaces the default hint copy so the reason is
// specific (old box vs catalogs-unavailable). For a create2 sandbox the fields
// are live (not greyed) and carry box-truth catalogs.
function greyRichFields(grey, hintText = null) {
  for (const id of PLACEMENT_RICH_ROW_IDS) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('placement-greyed', grey);
  }
  if (grey && hintText) placementHint.textContent = hintText;
  placementHint.style.display = grey ? '' : 'none';
}

// Placement is only meaningful in create mode (templates are host-authored). When
// the selector is hidden it always reads 'host'; otherwise it's the selected
// <option>'s value — 'host' or a box id.
function currentPlacement() {
  return placementRow.style.display !== 'none' ? (inputPlacement.value || 'host') : 'host';
}

// Does the given box's peer advertise the M5 `create2` capability (full-param
// create + /api/catalogs)? Same peerStatuses + caps.includes() precedent as
// peerSupportsArgs/activePeerConfigurable. Offline or old box → false → greyed.
function boxHasCreate2(boxId) {
  const st = peerStatuses.get(boxId);
  return !!(st && st.online && Array.isArray(st.caps) && st.caps.includes('create2'));
}

// Is the given box's peer registered AND online? A box can be in the registry but
// stopped (no peer / offline peer) — create must not fire at a dead peer.
function boxPeerOnline(boxId) {
  const st = peerStatuses.get(boxId);
  return !!(st && st.online);
}

// Rebuild the placement <select> from the box registry: "This Mac" first, then one
// option per box (label shown, box id carried as the value). Called at each open so
// a created/deleted box is reflected. An offline box still gets an option (its
// (stopped) suffix flags it) — create pre-checks the peer and errors clearly.
function populatePlacementOptions(boxes) {
  inputPlacement.innerHTML = '';
  const host = document.createElement('option');
  host.value = 'host';
  host.textContent = 'This Mac';
  inputPlacement.appendChild(host);
  for (const b of (boxes || [])) {
    if (!b || !b.id) continue;
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = boxPeerOnline(b.id) ? (b.label || b.id) : `${b.label || b.id} (stopped)`;
    inputPlacement.appendChild(opt);
  }
}

// Apply a placement change: swap the cwd default (without clobbering a typed path)
// then apply the sandbox state. Flipping back to Host restores the Mac's catalogs
// (they were swapped to box truth while on a box).
async function applyPlacement() {
  const placement = currentPlacement();
  inputCwd.value = placementNextCwd(placement, inputCwd.value.trim(), homeDir);
  if (placement !== 'host') { await applySandboxState(); return; }
  greyRichFields(false);
  await restoreHostCatalogs();
}

// Grey/un-grey the rich fields for the CURRENT placement and, for a create2
// sandbox, swap the checklists to the box's catalogs. No cwd mutation — safe to
// call from a type change (which re-rendered host catalogs and must be corrected).
// Non-create2 sandbox → M3 greyed. create2 sandbox → fetch box catalogs, render
// them, un-grey; a fetch failure greys with the unavailable hint (never render the
// Mac's libraries as if they were the box's). Stale responses are guarded.
async function applySandboxState() {
  const placement = currentPlacement();
  if (placement === 'host') { greyRichFields(false); return; }
  // Box placement. An offline box has no catalogs to fetch and create will be
  // blocked — grey with a start-it-first hint rather than the old-box copy.
  if (!boxPeerOnline(placement)) { greyRichFields(true, PLACEMENT_HINT_BOX_OFFLINE); return; }
  // The grey decision lives in the tested placement leaf: host never greys, a
  // non-create2 box does (old box), a create2 box doesn't (fields live).
  if (richFieldsGreyed(placement, boxHasCreate2(placement))) {
    greyRichFields(true, PLACEMENT_HINT_OLD_BOX);
    return;
  }
  // Box + create2: fetch the box's catalogs and render the fields from them.
  const token = ++placementCatalogToken;
  let res;
  try { res = await window.api.peerCatalogs(placement); }
  catch { res = null; }
  // Discard if the user flipped away (or to another box) while the fetch was in flight.
  if (token !== placementCatalogToken || currentPlacement() !== placement) return;
  if (!res || res.ok === false || !res.catalogs) {
    greyRichFields(true, PLACEMENT_HINT_CATALOGS_UNAVAILABLE);
    return;
  }
  populateChecklistsFromCatalogs(res.catalogs);
  greyRichFields(false);
}

// Populate the dialog's checklists from a peer's box-truth catalogs (M5) — the
// same cache setters + render functions openDialog uses for host catalogs, but
// fed the box's agents/prompts/skills/tools instead of the Mac's. Checked sets
// start empty (a fresh sandbox create begins from the box's defaults, like host).
// The disable-skills checklist and tool provenance have no session-less box source
// (they're cwd/roster-scoped, resolved box-side at spawn), so they render flat.
function populateChecklistsFromCatalogs(cat) {
  setAgentLibCache(cat.agents || []);
  renderAgentChecklist(inputAgentsList, new Set());
  setSkillLibCache(cat.skills || []);
  renderInjectChecklist(inputInjectSkillsList, new Set());
  renderSkillChecklist(inputSkillsList, [], new Set());
  setClaudeToolsCache(cat.claudeTools || []);
  renderToolChecklist(inputToolsList, new Set());
  renderBuiltinChecklist(inputBuiltinsList, new Set());
  refreshNewSessionExecCommands();  // exec grants never cross, but the box has its own
  refreshNewSessionIntents();       // static catalog, box-independent
  setPromptLibCache({
    system: (cat.prompts || []).filter((p) => p.kind === 'system'),
    append: (cat.prompts || []).filter((p) => p.kind === 'append'),
  });
  fillSystemPromptSelect(inputSystemPrompt, '');
  renderAppendChecklist(inputAppendList, new Set());
  setProxyControls(inputProxyMode, inputProxyUrl, null, cat.proxyUrl);
}

// Restore the Mac's catalogs after a flip back to Host (the caches hold box truth
// while on Sandbox). Re-uses the captured open-time host settings/agentLib so
// there's no re-fetch race; the cwd-scoped skill/tool provenance re-fetches (as it
// does on any cwd change).
async function restoreHostCatalogs() {
  populateHostCatalogs(dialogHostSettings, dialogHostAgentLib);
  // The prompt-lib cache holds box truth too after a Sandbox stint —
  // populateHostCatalogs doesn't cover it (openDialog loads prompts through the
  // separate refreshSystemPromptDropdown), so reload the Mac's library here or the
  // dropdown/append checklist keep showing the box's prompts labeled as host's.
  // A selected box-only prompt ref falls back to (CLI default), gracefully.
  await refreshSystemPromptDropdown();
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

// The branch/base fields only matter once the worktree box is checked.
if (inputWorktree) {
  inputWorktree.addEventListener('change', () => {
    worktreeFields.style.display = inputWorktree.checked ? '' : 'none';
    if (inputWorktree.checked) inputWorktreeBranch.focus();
  });
}

// Git repo detection for the current cwd — reveals the worktree row only inside
// a repo and populates the base-branch autocomplete + default. A token guards
// against a slower earlier cwd's response landing after a newer one.
let worktreeInfoToken = 0;
async function refreshWorktreeForCwd() {
  if (!worktreeRow) return;
  const authoring = dialogMode === 'template';
  const cwd = expandPath(inputCwd.value.trim()) || homeDir;
  const token = ++worktreeInfoToken;
  const info = await window.api.worktreeInfo(cwd);
  if (token !== worktreeInfoToken) return; // a newer cwd won the race
  const isRepo = info && info.ok && info.isRepo;
  // Worktrees are runtime-only (hidden in template authoring) AND repo-only.
  worktreeRow.style.display = (isRepo && !authoring) ? '' : 'none';
  if (!isRepo || authoring) {
    if (inputWorktree) inputWorktree.checked = false;
    if (worktreeFields) worktreeFields.style.display = 'none';
    return;
  }
  // Populate the base-branch datalist (default first) and seed the placeholder.
  worktreeBaseList.textContent = '';
  for (const b of (info.branches || [])) {
    const opt = document.createElement('option');
    opt.value = b;
    worktreeBaseList.appendChild(opt);
  }
  inputWorktreeBase.placeholder = info.defaultBranch ? `${info.defaultBranch} (default)` : '(default branch)';
}

// Working Directory datalist: recently-picked dirs (MRU) first, then the most-
// popular cwds across live sessions (labelled with their session count). Deduped
// so a dir that's both recent and active shows once.
async function refreshCwdSuggestions() {
  if (!cwdSuggestionsList) return;
  const res = await window.api.cwdSuggestions();
  if (!res || !res.ok) return;
  cwdSuggestionsList.textContent = '';
  const seen = new Set();
  const add = (value, label) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    const opt = document.createElement('option');
    opt.value = value;
    if (label) opt.label = label;
    cwdSuggestionsList.appendChild(opt);
  };
  for (const c of (res.recent || [])) add(c, 'recent');
  for (const p of (res.popular || [])) add(p.cwd, `${p.count} active session${p.count === 1 ? '' : 's'}`);
}

// prefill (optional): seed the dialog for adopting an existing session —
// { name, type, cwd, resumeId }. Everything else stays at the normal new-session
// defaults, so the operator can still pick tools/prompts/proxy before Create runs
// the SAME create() path (resumeId set = resume the conversation).
async function openDialog(prefill = null) {
  editingTemplateId = null;
  setDialogMode('create'); // reset chrome if the last use was a template edit
  sessionCounter++;
  inputName.value = (prefill && prefill.name) || `session-${sessionCounter}`;
  inputType.value = (prefill && prefill.type) || 'claude';
  inputCwd.value = (prefill && prefill.cwd) || homeDir;
  inputTemplate.value = '';
  inputSystemPrompt.value = '';
  inputResume.value = (prefill && prefill.resumeId) || '';
  inputFork.checked = false;
  if (inputWorktree) {
    inputWorktree.checked = false;
    inputWorktreeBranch.value = '';
    inputWorktreeBranch.style.borderColor = '';
    inputWorktreeBase.value = '';
    if (worktreeFields) worktreeFields.style.display = 'none';
  }
  refreshCwdSuggestions();
  if (inputStripLevel) inputStripLevel.value = '0'; // default off each open
  if (inputAutoCompact) inputAutoCompact.checked = true; // default ON (opt-out unchecked)
  // Reset placement to Host BEFORE applyTypeDefaults so a stale box value from a
  // prior open can't trip the type-change → applySandboxState hook during open
  // (which would fire a spurious catalog fetch). The options + placementRow
  // visibility are (re)built below once the box registry lands.
  inputPlacement.value = 'host';
  // Collapse the advanced accordions each open so the dialog starts short.
  for (const sec of [toolsSection, skillsSection, otherSection]) {
    if (sec) sec.open = false;
  }
  applyTypeDefaults();
  inputName.style.borderColor = '';
  const [, , settings, agentLib, boxes] = await Promise.all([
    refreshTemplatesDropdown(),
    refreshSystemPromptDropdown(),
    window.api.getSettings(),
    window.api.listAgents(),
    window.api.sandboxListBoxes(),
  ]);
  // Capture the host catalogs so a flip box→Host restores them without a re-fetch
  // race (M5 swaps the caches to box truth while on a box).
  dialogHostSettings = settings;
  dialogHostAgentLib = agentLib || [];
  populateHostCatalogs(settings, dialogHostAgentLib);
  // Placement selector: rebuild its options from the box registry (Host + one per
  // box), shown ONLY when at least one box is registered (zero noise otherwise).
  // Default Host; a fresh open never inherits a stale grey.
  populatePlacementOptions(boxes);
  inputPlacement.value = 'host';
  placementRow.style.display = showPlacementSelector(boxes) ? '' : 'none';
  greyRichFields(false);
  // Adopting an existing session: retitle so it's clear this resumes a
  // conversation rather than starting fresh. Purely cosmetic — the Resume field
  // carries the id and drives the behavior.
  if (prefill && prefill.resumeId) dialogTitle.textContent = 'Adopt Session';
  dialogOverlay.classList.remove('hidden');
  setTimeout(() => inputName.select(), 50);
}

// Populate the dialog's checklists + proxy from the Mac's catalogs (host
// settings/agent-library). Shared by openDialog and the Sandbox→Host restore, so
// the host path has one source of truth. cwd-scoped skill/tool provenance
// re-fetches (refreshNewSessionSkills/Tools) as it does on any cwd change.
function populateHostCatalogs(settings, agentLib) {
  setAgentLibCache(agentLib || []);
  renderAgentChecklist(inputAgentsList, new Set());
  refreshNewSessionExecCommands();
  refreshNewSessionIntents();
  renderBuiltinChecklist(inputBuiltinsList, new Set());
  setClaudeToolsCache(settings?.claudeTools || []);
  setDefaultToolDenyCache(settings?.defaultToolDeny || []);
  renderToolChecklist(inputToolsList, new Set(getDefaultToolDenyCache()));
  refreshNewSessionSkills();
  refreshNewSessionTools();
  setProxyControls(inputProxyMode, inputProxyUrl, null, settings?.proxyUrl);
  labelProxyDefault(inputProxyMode, settings);
}

inputType.addEventListener('change', () => applyTypeDefaults());
inputPlacement.addEventListener('change', () => applyPlacement());
// cwd drives the skill catalog's provenance (which lower-layer settings apply),
// so re-fetch when it changes.
// Bare refs would leak the DOM Event into the first (data) param — disabledSet —
// which then throws `.has is not a function` mid-render and blanks the checklist.
inputCwd.addEventListener('change', () => refreshNewSessionSkills());
inputCwd.addEventListener('change', () => refreshNewSessionTools());
// A cwd change may cross a repo boundary — re-detect so the worktree row
// reveals/hides. Change-only (matches the skill/tool refreshes above) so a path
// field doesn't shell out to git on every keystroke.
inputCwd.addEventListener('change', () => refreshWorktreeForCwd());

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

  // Box placement: route the create through THAT box's peer instead of the local
  // engine. The peer owner fans the new session back into the sidebar's peer
  // section, so there's no local terminal/sidebar surgery to do. When the box
  // advertises create2 (M5) the full cfg crosses the wire (same collectFormConfig
  // path as host); an older box takes only the bare {name,type,cwd} (its rich
  // fields were greyed and never collected). systemPromptBody stays null (F2);
  // execCommands are stripped client-side in peer-client (grants never cross).
  const placement = currentPlacement();
  if (placement !== 'host') {
    const boxId = placement;
    // Guard: don't fire a create at a stopped box — peerCreateSession would fail
    // obscurely at a dead peer. Keep the dialog open with a clear, actionable error.
    if (!boxPeerOnline(boxId)) {
      alert(`The "${boxId}" sandbox isn't running — start it from the Sandboxes panel first.`);
      return;
    }
    closeDialog();
    const spec = boxHasCreate2(boxId)
      ? {
          name, type, cwd, extraArgs, resumeId, fork, proxy, agents, denyBuiltins,
          disabledTools, disabledSkills, injectSkills, stripLevel,
          systemPromptFile, appendPromptFiles,
          ...(Array.isArray(intents) ? { intents } : {}),
        }
      : { name, type, cwd };
    const res = await window.api.peerCreateSession(boxId, spec);
    if (!res || res.ok === false) {
      alert(`Create sandbox session failed: ${(res && res.error) || 'unknown error'}`);
      return;
    }
    // If the box peer's visible set was materialized (a row hidden earlier), the new
    // session isn't in the whitelist and would land invisible — ensure it shows,
    // then open it: a box placement gives the same land-in-the-session parity a
    // local create does (createTerminal + switchSession).
    await ensurePeerSessionVisible(boxId, res.name || name);
    openPeerSession(boxId, res.name || name);
    // Name the sandbox by its friendly label (peer status carries it), not the raw
    // box id — parity with the "Created sandbox …" toast in the Sandboxes panel.
    const boxSt = peerStatuses.get(boxId);
    const boxLabel = (boxSt && boxSt.label) || boxId;
    showToast(`Created "${res.name || name}" (${res.type || type}) in ${boxLabel}.`, { kind: 'peer-ui' });
    // Non-fatal spawn warnings from the box (e.g. an injected skill references a
    // subagent the box hasn't enabled) — same ack shape + toast path as a local
    // create (slice 2 forwards create()'s warnings[] over the wire).
    for (const w of (res.warnings || [])) showToast(w, { kind: 'warn', duration: 15000 });
    return;
  }

  // Opt-in git worktree: create it FIRST (off the entered cwd's repo), then spawn
  // the session in the new worktree instead. Done before closeDialog so a failure
  // can surface with the dialog still open for correction.
  let spawnCwd = cwd;
  let worktree = null;
  // Only worktree-backed when the row is visible (i.e. cwd is a git repo) AND
  // checked — the row hides itself outside a repo, so a stale checked state can't
  // fire a worktree in a non-repo dir.
  if (inputWorktree && inputWorktree.checked && worktreeRow && worktreeRow.style.display !== 'none') {
    const branch = inputWorktreeBranch.value.trim();
    if (!branch) {
      inputWorktreeBranch.style.borderColor = '#e94560';
      return;
    }
    const base = inputWorktreeBase.value.trim() || null; // null → repo default branch
    const wt = await window.api.createWorktree(cwd, branch, { base });
    if (!wt || !wt.ok) {
      showToast(`Worktree creation failed: ${(wt && wt.error) || 'unknown error'}`, { kind: 'error', duration: 10000 });
      return;
    }
    spawnCwd = wt.path;
    worktree = { path: wt.path, branch: wt.branch, base: wt.base || null, repo: wt.repo };
  }

  // Remember the chosen source dir (the repo/cwd the user picked, not the derived
  // worktree path) for the Working Directory MRU.
  window.api.noteCwd(cwd);

  closeDialog();

  if (typeof proxy === 'string') window.api.setSettings({ proxyUrl: proxy }); // remember last used
  const result = await window.api.createSession(name, type, spawnCwd, extraArgs, systemPromptBody, resumeId, fork, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, stripLevel, systemPromptFile, appendPromptFiles, execCommands, intents);
  if (!result.ok) {
    console.error('Failed to create session:', result.error);
    alert(`Create session failed: ${result.error || 'unknown error'}`);
    refreshDiagBanner(); // a posix_spawnp failure usually means a broken install
    return;
  }

  // Stamp worktree provenance onto the persisted entry (a later teardown can use
  // it to offer removing the checkout).
  if (worktree) window.api.markSessionWorktree(name, worktree);

  createTerminal(name);
  addSessionToSidebar(name, type, spawnCwd, null, (result.session && result.session.backend) || null);
  switchSession(name);

  // Non-fatal spawn warnings (e.g. an injected skill references a subagent this
  // session hasn't enabled) — the session is already live; these just surface a
  // config foot-gun that would otherwise fail silently at delegation time.
  const warnings = (result.session && result.session.warnings) || [];
  for (const w of warnings) showToast(w, { kind: 'warn', duration: 15000, name });
}

// The dialog's primary action depends on which mode it was opened in: create a
// session, or save a template (no spawn).
function submitDialog() {
  if (dialogMode === 'template') saveTemplateFromForm();
  else doCreate();
}

// Arrow-wrapped: a bare `openDialog` reference would pass the click MouseEvent as
// the prefill arg (openDialog(prefill) now takes one), mis-seeding the dialog.
document.getElementById('btn-new').addEventListener('click', () => openDialog());
// Sidebar-header toolbar siblings of + (new session): new sandbox opens the
// sandbox panel (P2's box list owns creation — no inline create flow), add peer
// opens the peers-SETUP dialog. Both are just openers; Cmd+T still maps to +.
document.getElementById('btn-new-sandbox').addEventListener('click', () => openSandboxDialog());
document.getElementById('btn-add-peer').addEventListener('click', () => openPeersDialog());
document.getElementById('btn-cancel').addEventListener('click', closeDialog);
btnCreate.addEventListener('click', submitDialog);

document.getElementById('btn-browse').addEventListener('click', async () => {
  const dir = await window.api.selectDirectory();
  if (!dir) return;
  // Box placement: the picker returns a HOST folder but the box takes a container
  // path. Translate it against THAT box's live config; if the box can't see the
  // folder, tell the user rather than writing a wrong path. Typed paths are left
  // untouched (power users / web frontend enter a container path directly).
  if (currentPlacement() !== 'host') {
    await pickSandboxCwd(dir);
    return;
  }
  inputCwd.value = dir;
  refreshNewSessionSkills();
  refreshNewSessionTools();
  refreshWorktreeForCwd();
});

// Translate a picked HOST folder to the box's container path and fill the cwd
// field. Reachable (under the box workDir or a configured mount) → fill silently.
// Unreachable → leave the field as-is and tell the user, rather than writing a
// wrong container path. (The mount-into-the-shared-box + restart flow was
// superseded by M6b's per-project boxes — a folder the shared box can't see will
// find-or-create its OWN box; that lands in the M6b work.)
async function pickSandboxCwd(hostDir) {
  const t = await window.api.sandboxTranslatePath(hostDir, currentPlacement());
  if (t && t.container) { inputCwd.value = t.container; return; }
  showToast(`"${hostDir}" isn't reachable in the sandbox — type a container path, or mount the folder from the Sandboxes panel.`, { kind: 'warn', duration: 9000 });
}

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
  if (authoring) {
    templateRow.style.display = 'none'; // create-mode: refreshTemplatesDropdown owns it
    // Placement is a create-time choice; templates are host-authored. Hide the
    // selector and drop any grey so the full field set is editable.
    placementRow.style.display = 'none';
    greyRichFields(false);
  }
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

window.api.onSessionExit((name, code, meta) => {
  // Archive in flight (✕ / ⌘W): this exit IS the archive. Drop the live tab +
  // terminal, then rebuild the row as an archived placeholder in place — no app
  // restart needed — and stay silent (an archive exit is expected).
  const archivedEntry = archivingSessions.get(name);
  removeSession(name);
  if (archivedEntry) {
    archivingSessions.delete(name);
    addArchivedSessionToSidebar(archivedEntry);
    refreshSidebarView();
    return;
  }
  // Deliberate exits (user kill, restart, app quit) arrive expected:true and
  // stay silent, as does a clean self-exit (code 0, no signal — the user typed
  // `exit`/quit in the pane they were looking at). What's left is the session
  // dying on its own: without this toast the tab just vanished, and a crash
  // was indistinguishable from a clean quit. AGENT-ONLY: the toast means
  // "something you rely on died while you weren't looking" — a bash pane is
  // usually one the operator is looking AT, and intent-spawned bash that
  // fast-fails at code≠0 would otherwise storm toasts. Every exit still lands in
  // the IPC log (main-side, all types) — narrowing the toast hides nothing.
  if (meta && meta.agentType && !meta.expected && (code !== 0 || meta.signal)) {
    const why = meta.signal ? `signal ${meta.signal}` : `code ${code}`;
    showToast(`${name} exited unexpectedly (${why}).`, { kind: 'error', duration: 15000 });
  }
});

window.api.onSessionActivity((name, state) => {
  const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (!el) return;
  // Thinking-duration stamp: the amber dot alone makes a 3s turn and a wedged
  // agent look identical. Stamp the ENTRY into thinking (not every repeat
  // event) so the badge tick + hover card can show elapsed time; any other
  // state clears both.
  if (state === 'thinking') {
    if (el.dataset.activity !== 'thinking') el.dataset.thinkingSince = String(Date.now());
  } else if (el.dataset.thinkingSince) {
    delete el.dataset.thinkingSince;
    applyThinkBadge(el);
  }
  el.dataset.activity = state;
  // Activity bumps recency + the "working/idle" state group. Seed the meta and
  // re-lay-out (debounced) so recency sort + state grouping stay live between the
  // periodic meta polls.
  sidebarMeta.set(name, { ...(sidebarMeta.get(name) || {}), lastActivityTs: Date.now() });
  scheduleSidebarRelayout();
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
    // !document.hasFocus() mirrors the desktop's !owningWin.isFocused() gate on
    // notifyOS — a tab the human is looking at doesn't need an OS notification.
    if (window.__CLODEX_WEB__ && !document.hasFocus()) webNotifier.raise(attentionNotice(name, attn));
  } else {
    delete el.dataset.attention;
    delete el.dataset.attentionMsg;
  }
  // The needs-attention set/clear changed the tab-title badge count (web-gated
  // inside; a no-op on desktop).
  if (window.__CLODEX_WEB__) updateWindowTitle();
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
const ctxTokens = new Map(); // name -> { used, size, cost, model }

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

window.api.onSessionCtx((name, pct, tok, size, cost, modelName) => {
  ctxPct.set(name, pct);
  if (typeof tok === 'number' && typeof size === 'number' && size > 0) {
    ctxTokens.set(name, { used: tok, size, cost: typeof cost === 'number' ? cost : null, model: modelName || null });
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
  badge.dataset.tip = count > 0
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
// Minimal telemetry line built purely from the CLI statusline side-channel
// (ctxPct/ctxTokens), for a session with NO wirescope payload — a Bedrock/Vertex
// session or any un-proxied one. Without this the proxy-bar's no-payload branch
// blanks the whole line even though the sidebar ctx badge (same side-channel)
// shows data. No clickable popovers (those need the wire), just ctx + cost text.
function sideChannelSegs(name) {
  const segs = [];
  const pct = ctxPct.get(name);
  const sc = ctxTokens.get(name); // { used, size, cost, model }
  if (sc && sc.model) segs.push(`<span class="px-seg">${esc(sc.model)}</span>`);
  const usedTok = sc && sc.used > 0 ? sc.used : null;
  const sizeTok = sc && sc.size > 0 ? sc.size : null;
  if (usedTok != null) {
    const heavy = usedTok >= CTX_HEAVY_TOKENS ? ' px-ctx-heavy' : usedTok >= CTX_WARN_TOKENS ? ' px-ctx-warn' : '';
    if (sizeTok) {
      const p2 = Math.round((usedTok / sizeTok) * 100);
      segs.push(`<span class="px-seg${heavy}" data-tip="Context: tokens used / window size">🧠 ${fmtTokens(usedTok)}/${fmtTokens(sizeTok)} (${p2}%)</span>`);
    } else {
      segs.push(`<span class="px-seg${heavy}" data-tip="Context tokens used">🧠 ${fmtTokens(usedTok)}</span>`);
    }
  } else if (typeof pct === 'number' && pct > 0) {
    segs.push(`<span class="px-seg" data-tip="Context window used">🧠 ${pct}%</span>`);
  }
  if (sc && typeof sc.cost === 'number' && sc.cost > 0) {
    const costTxt = sc.cost >= 1 ? sc.cost.toFixed(2) : sc.cost.toFixed(4);
    segs.push(`<span class="px-seg px-cost" data-tip="Cost so far, reported by the CLI (no wirescope — no live breakdown)">~$${costTxt}</span>`);
  }
  return segs;
}
// Attached peer tab whose owner serves the popover query endpoint — such a
// tab gets the status bar (for the files button) even with no telemetry.
function activePeerQueryable() {
  const entry = activeSession ? sessions.get(activeSession) : null;
  if (!entry || !entry.peer) return false;
  const st = peerStatuses.get(entry.peer.id);
  return !!(st && st.online && Array.isArray(st.caps) && st.caps.includes('query'));
}
// Attached peer AGENT tab whose owner advertises remote config editing (the 'args'
// cap) — such a tab gets a `⚙ Edit session` button on the proxy bar that opens the
// shared Edit Session dialog (with Skills folded in as a peer-only section), served
// by peers-ui's openPeerArgs. Gated to agent sessions so a remote bash tab doesn't
// sprout a config button.
function activePeerConfigurable() {
  const entry = activeSession ? sessions.get(activeSession) : null;
  if (!entry || !entry.peer) return false;
  const st = peerStatuses.get(entry.peer.id);
  if (!st || !st.online || !Array.isArray(st.caps) || !st.caps.includes('args')) return false;
  const type = (st.sessions || []).find((s) => s.name === entry.peer.name)?.type;
  return !type || type === 'claude' || type === 'codex';
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
      btns.push(`<button class="px-action${unseen}" data-act="files" data-tip="Files this agent's tools touched — click to view or diff">${label}</button>`);
    }
    // Everything else (tools/skills/agents/intents/edit/history/reload) collapses
    // behind ONE button + a dropdown — the bar is out of width even at max, and
    // these are seldom-clicked launchers. Entries are type-conditioned by the
    // session-actions leaf; the menu's onPick routes back to the openers below.
    btns.push('<button class="px-action" data-act="session-menu" data-tip="Session actions — tools, skills, agents, intents, settings, history, reload">⚙ session ▾</button>');
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
    btns.push(`<button class="px-action${unseen}" data-act="files" data-tip="Files this agent's tools touched (on its own machine) — click to view or diff">${label}</button>`);
  }
  // Peer config: a single button opening the Edit Session dialog for the REMOTE
  // session (Skills fold in there as a peer-only section), served by peers-ui's
  // openPeerArgs through the existing peer data source.
  if (activePeerConfigurable()) {
    btns.push('<button class="px-action" data-act="peer-edit" data-tip="Edit this remote session\'s settings (args, prompts, tools, skills…)">⚙ Edit Session</button>');
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
    if (activeIsAgent() || activePeerQueryable() || activePeerConfigurable()) {
      bar.style.display = '';
      if (main) main.classList.add('has-proxy-bar');
      tele.className = '';
      // No wirescope payload (Bedrock/Vertex or un-proxied): fall back to the
      // CLI statusline side-channel so the line shows ctx + cost instead of
      // going blank. Empty for a non-claude/no-data tab.
      tele.innerHTML = activeIsAgent() ? sideChannelSegs(activeSession).join('<span class="px-sep">·</span>') : '';
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
      segs.push(`<span class="px-seg${heavy}${ctxCls}"${ctxAttr} data-tip="${ctxTip || 'Context: tokens used / window size'}">🧠 ${fmtTokens(usedTok)}/${fmtTokens(sizeTok)} (${p2}%)</span>`);
    } else {
      segs.push(`<span class="px-seg${heavy}${ctxCls}"${ctxAttr} data-tip="${ctxTip || 'Context tokens used'}">🧠 ${fmtTokens(usedTok)}</span>`);
    }
  } else if (typeof pct === 'number' && pct > 0) {
    segs.push(`<span class="px-seg${ctxCls}"${ctxAttr} data-tip="${ctxTip || 'Context window used'}">🧠 ${pct}%</span>`);
  } else if (p.context && p.context.messages != null) {
    segs.push(`<span class="px-seg${ctxCls}"${ctxAttr} data-tip="${ctxTip || 'Messages in context'}">🧠 ${p.context.messages} msg</span>`);
  }
  // Turn count: the LIVE number (turns in context, resets at compact) leads;
  // the cumulative total rides the tooltip. Decision shared with the hovercard
  // via turn-stat.js.
  const tSeg = turnSeg(p);
  if (tSeg) segs.push(`<span class="px-seg" data-tip="${esc(tSeg.tip)}">${esc(tSeg.text)}</span>`);
  // API roundtrips — the truer "how busy" gauge than turns (one prompt fans out
  // into many tool-loop roundtrips; ~8× is typical). Live-first like the turn
  // seg: prefers wirescope's since_compact rollup (p.sinceCompact, shape frozen
  // 07-15 — flips automatically once the proxy release vendors), cumulative in
  // the tooltip; degrades to the cumulative count on older proxies.
  const rSeg = reqSeg(p);
  if (rSeg) segs.push(`<span class="px-seg" data-tip="${esc(rSeg.tip)}">${esc(rSeg.text)}</span>`);
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
  const cSeg = costSeg(p);
  if (cSeg) {
    // Live-first cost via the shared turn-stat leaf: since-compact spend leads,
    // the cumulative figure rides the tooltip (same policy as turn/req segs).
    // When wirescope advertises the cost-over-time timeline, the cost number
    // opens a native breakdown popover (read-carriage vs output, cumulative),
    // which itself links out to the full /_timeline dashboard. Stays plain text
    // otherwise, so a pre-deploy/standalone session just shows the estimate.
    const timeline = !!(p.capabilities && p.capabilities.context_timeline && p.base && p.sessionId)
      || peerQueries.includes('cost');
    if (timeline) {
      segs.push(`<span class="px-seg px-cost px-ctx-btn" data-act="cost" data-tip="${esc(cSeg.tip)} — click for the over-time breakdown">${esc(cSeg.text)}</span>`);
    } else {
      segs.push(`<span class="px-seg px-cost" data-tip="${esc(cSeg.tip)} (wirescope)">${esc(cSeg.text)}</span>`);
    }
  } else if (sc && typeof sc.cost === 'number' && sc.cost > 0) {
    // Wire-off fallback (Bedrock/Vertex or no proxy): the wirescope cost
    // telemetry above is dark, so show the CLI's own running total from the ctx
    // side-channel. No time-series, so it's plain text — no breakdown popover.
    const costTxt = sc.cost >= 1 ? sc.cost.toFixed(2) : sc.cost.toFixed(4);
    segs.push(`<span class="px-seg px-cost" data-tip="Cost so far, reported by the CLI (no wirescope — no live breakdown)">~$${costTxt}</span>`);
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
      segs.push(`<span class="${cls}"${attrs} data-tip="${tip}">💥 ${genuineCount}</span>`);
    }
  }
  if (p.base && p.sessionId) {
    const url = `${p.base}/_session?session=${encodeURIComponent(p.sessionId)}`;
    segs.push(`<a class="px-seg px-link" data-url="${esc(url)}" data-tip="Open this session's wirescope page in a clodex window (⌘-click for browser)">🔍 wirescope</a>`);
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
      holdHtml = `<button class="px-hold" data-act="warm-menu" data-held="1" data-tip="${tip}">${label}</button>`;
    } else if (actionable) {
      holdHtml = `<button class="px-hold" data-act="warm-menu" data-tip="Keep prompt cache warm">🔥 keep warm</button>`;
    } else {
      holdHtml = `<button class="px-hold" disabled data-tip="Keep prompt cache warm — waiting for a live proxy session">🔥 keep warm</button>`;
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
    stripHtml = `<button class="px-action px-strip${lvl > 0 ? ' is-on' : ''}"${actionable ? '' : ' disabled'} data-act="strip-menu" data-level="${lvl}" data-tip="${esc(tip)}">${label}</button>`;
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

// Thinking-duration badge — the wedge tell Bogdan asked for mid-debug: the
// amber dot pulses identically for a 3s turn and a permanently-stuck agent.
// Quiet for the first 2 minutes (normal turns stay badge-free), then shows
// elapsed minutes; at 10 minutes the pill shifts to the error tint — long
// enough that "is it wedged?" is a fair question, without claiming it IS
// (deep Fable turns can run that long legitimately). Driven off the row's
// thinkingSince stamp (set on the ENTRY into thinking in onSessionActivity),
// ticked by the shared 1s interval below.
const THINK_BADGE_MS = 2 * 60 * 1000;
const THINK_LONG_MS = 10 * 60 * 1000;
function applyThinkBadge(el) {
  const badge = el.querySelector('.session-think');
  if (!badge) return;
  const since = Number(el.dataset.thinkingSince || 0);
  const elapsed = since ? Date.now() - since : 0;
  if (el.dataset.activity !== 'thinking' || elapsed < THINK_BADGE_MS) {
    badge.textContent = '';
    badge.dataset.state = '';
    return;
  }
  badge.textContent = `${Math.floor(elapsed / 60000)}m`;
  badge.dataset.state = elapsed >= THINK_LONG_MS ? 'long' : 'on';
}

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

// Shared attr-driven tooltip for the sidebar's small icon chrome (tooltip.js).
// Elements opt in with data-tip="…"; the rich per-row card above stays the
// authority for session rows and defers wherever a data-tip child is hovered.
initTooltips();

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
    showToast(`${disp}: cache going cold in ~${mins} min.`, { kind: 'warm', name });
  }
}

// Tick live countdowns once a second: the active session's bar plus every
// tab's warmth badge. Uses the light text-only update so keep-warm buttons
// aren't rebuilt out from under the cursor.
setInterval(() => {
  for (const name of proxyState.keys()) { applyWarmBadge(name); checkWarmthCooldown(name); }
  for (const el of sessionList.querySelectorAll('.session-item[data-thinking-since]')) applyThinkBadge(el);
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
      else if (action.dataset.act === 'peer-edit') {
        // Peer proxy-bar config button — opens the shared Edit Session dialog with a
        // peer data source (peers-ui owns the source; the dialog DOM is identical).
        openPeerArgs(activeSession);
      }
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
  // A mention is transient (the pulse, not a persistent fact), so it raises an
  // OS notification but does NOT bump the title badge — the notification is the
  // signal a hidden tab needs. Focus gate as at the attention site.
  if (window.__CLODEX_WEB__ && !document.hasFocus()) webNotifier.raise(mentionNotice(name, mtype));
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

// Boiling-pot drawer (pot-drawer.js). Self-contained — a global, cross-agent
// file-heat ranking pulled fresh on open via window.api.potSnapshot; no core
// state. Sidebar-footer button next to Inbox.
createPotDrawer();

// Workbench popover — one floating surface (Files / Source Control / Worktrees)
// for a chosen session (popovers/workbench-popover.js). Scopes to the SELECTED
// session's cwd (its own dropdown, default = active), resolved server-side by the
// fs:/scm:/worktree: IPC. Opened from the toolbar button + the View-menu event.
const { openWorkbench } = initWorkbenchPopover({
  getActiveSession: () => activeSession,
  showToast,
});
const btnWorkbench = document.getElementById('btn-workbench');
if (btnWorkbench) btnWorkbench.addEventListener('click', () => openWorkbench());
if (window.api.onRequestOpenWorkbench) window.api.onRequestOpenWorkbench(() => openWorkbench());

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
  ensurePeerSessionVisible, openPeerArgs,
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

  // Cmd+W — archive active session (or close dialog if open). ✕'s twin.
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
        archiveSessionRow(target);
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

// Browser-only Alt shortcuts — a tab's chrome reserves Cmd+T/W/1-9, so the
// desktop Cmd chords above silently fail in a browser. The web frontend mirrors
// them onto Alt: Alt+T new, Alt+W close, Alt+1..9 switch, Alt+Shift+] / [ cycle
// (classified by e.code in web-shortcuts.js, since Option composes characters on
// macOS). Same capture-phase + preventDefault/stopPropagation so xterm never sees
// them. No-op in Electron, where window.__CLODEX_WEB__ is undefined.
document.addEventListener('keydown', (e) => {
  if (!window.__CLODEX_WEB__) return;
  const action = altChordAction(e);
  if (!action) return;
  e.preventDefault();
  e.stopPropagation();

  if (action.type === 'new') {
    if (dialogOverlay.classList.contains('hidden')) openDialog();
    return;
  }

  if (action.type === 'close') {
    if (!dialogOverlay.classList.contains('hidden')) {
      closeDialog();
    } else if (activeSession) {
      const target = activeSession;
      const entry = sessions.get(target);
      if (entry && entry.peer) {
        peerHideFromList(entry.peer.id, entry.peer.name);
      } else {
        archiveSessionRow(target);
      }
    }
    return;
  }

  if (action.type === 'switch') {
    const items = Array.from(sessionList.querySelectorAll('.session-item'));
    if (items[action.index]) switchSession(items[action.index].dataset.name);
    return;
  }

  if (action.type === 'cycle') {
    const items = Array.from(sessionList.querySelectorAll('.session-item'));
    if (items.length === 0) return;
    const cur = items.findIndex(it => it.dataset.name === activeSession);
    const next = action.dir === 'next'
      ? (cur + 1) % items.length
      : (cur - 1 + items.length) % items.length;
    switchSession(items[next].dataset.name);
  }
}, true);

// Browser-only OS notifications — the desktop gets these natively via main's
// notifyOS; a tab raises `new Notification()` off the attention/mention events
// (wired at their onSession* handlers). Ask for permission on the first user
// gesture, since Chrome gates requestPermission behind one (a no-op in Electron).
const webNotifier = createWebNotifier();
if (window.__CLODEX_WEB__) {
  const askOnce = () => {
    webNotifier.ensurePermission();
    document.removeEventListener('pointerdown', askOnce, true);
    document.removeEventListener('keydown', askOnce, true);
  };
  document.addEventListener('pointerdown', askOnce, true);
  document.addEventListener('keydown', askOnce, true);
}

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
// Discover Sessions dialog — adopt claude/codex sessions started outside clodex
// ---------------------------------------------------------------------------
const discoveryOverlay = document.getElementById('discovery-overlay');
const discoveryList = document.getElementById('discovery-list');
const discoveryRefresh = document.getElementById('discovery-refresh');
const discoveryClose = document.getElementById('discovery-close');

function closeDiscovery() { discoveryOverlay.classList.add('hidden'); }

// A short, unique clodex session name derived from a cwd's basename (or type).
function suggestAdoptName(cwd, type) {
  const base = (cwd && cwd.split('/').filter(Boolean).pop()) || type;
  let name = String(base).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 48) || type;
  if (!sessions.has(name)) return name;
  for (let i = 2; i < 100; i++) { const c = `${name}-${i}`; if (!sessions.has(c)) return c; }
  return `${name}-${Date.now().toString(36)}`;
}

function relTime(ts) {
  if (!ts) return '';
  const ms = Date.now() - (typeof ts === 'number' ? ts : Date.parse(ts));
  if (!(ms >= 0)) return '';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

// Adopt = fill the New Session dialog (already open behind the picker) with the
// chosen session's type/cwd/id and a suggested name, then return to it. The
// operator customizes tools/prompts/proxy/etc. and hits Create, which runs the
// normal create() path (resumeId set → resumes the conversation). If the dialog
// wasn't already open (Find opened straight from a fresh state), open it
// pre-filled instead.
function adoptSession(rec) {
  closeDiscovery();
  const prefill = {
    name: suggestAdoptName(rec.cwd, rec.type),
    type: rec.type,
    cwd: rec.cwd || homeDir,
    resumeId: rec.sessionId,
  };
  if (!dialogOverlay.classList.contains('hidden')) {
    // Dialog is open — fill it in place without resetting the operator's other
    // choices. Type change drives the type-dependent sections (skills/tools/…).
    inputName.value = prefill.name;
    if (inputType.value !== prefill.type) { inputType.value = prefill.type; applyTypeDefaults(); }
    inputCwd.value = prefill.cwd;
    inputResume.value = prefill.resumeId;
    inputFork.checked = false;
    refreshNewSessionSkills();
    refreshNewSessionTools();
    refreshWorktreeForCwd();
    dialogTitle.textContent = 'Adopt Session';
    setTimeout(() => inputName.select(), 50);
  } else {
    openDialog(prefill);
  }
}

function renderDiscovery(res) {
  discoveryList.textContent = '';
  const disk = (res && res.disk) || [];
  const live = (res && res.live) || [];
  if (!disk.length && !live.length) {
    const empty = document.createElement('div');
    empty.className = 'discovery-empty';
    empty.textContent = 'No adoptable sessions found. Everything on this machine is already managed by Clodex.';
    discoveryList.appendChild(empty);
    return;
  }
  const addGroupHead = (text) => {
    const h = document.createElement('div');
    h.className = 'discovery-group-head';
    h.textContent = text;
    discoveryList.appendChild(h);
  };
  const addItem = (rec, { liveBadge = false } = {}) => {
    const item = document.createElement('div');
    item.className = 'discovery-item';
    const meta = document.createElement('div');
    meta.className = 'discovery-meta';
    const title = document.createElement('div');
    title.className = 'discovery-title';
    title.textContent = rec.title || rec.cwd || rec.sessionId;
    const sub = document.createElement('div');
    sub.className = 'discovery-sub';
    const bits = [rec.type];
    if (rec.cwd) bits.push(rec.cwd);
    if (rec.turns) bits.push(`${rec.turns} turns`);
    const when = relTime(rec.lastActive || rec.mtime);
    if (when) bits.push(when);
    sub.textContent = bits.join(' · ');
    meta.appendChild(title);
    meta.appendChild(sub);
    item.appendChild(meta);
    if (liveBadge || rec.liveInCwd) {
      const badge = document.createElement('span');
      badge.className = 'discovery-live-badge';
      badge.textContent = 'live';
      badge.title = 'A Claude/Codex process is running in this directory right now';
      item.appendChild(badge);
    }
    const btn = document.createElement('button');
    btn.textContent = 'Adopt…';
    btn.addEventListener('click', () => adoptSession(rec));
    item.appendChild(btn);
    discoveryList.appendChild(item);
  };

  if (disk.length) {
    addGroupHead(`Recent conversations (${disk.length})`);
    for (const rec of disk) addItem(rec);
  }
  // Live foreign processes whose transcript wasn't in the disk list (e.g. a
  // brand-new session with no cwd match). Adopting needs a sessionId, which the
  // process lens doesn't carry — so these are informational unless matched.
  const unmatchedLive = live.filter((p) => p.cwd && !disk.some((d) => d.cwd === p.cwd));
  if (unmatchedLive.length) {
    addGroupHead(`Running now, no resumable transcript found (${unmatchedLive.length})`);
    for (const p of unmatchedLive) {
      const item = document.createElement('div');
      item.className = 'discovery-item';
      const meta = document.createElement('div');
      meta.className = 'discovery-meta';
      const title = document.createElement('div');
      title.className = 'discovery-title';
      title.textContent = p.cwd || `pid ${p.pid}`;
      const sub = document.createElement('div');
      sub.className = 'discovery-sub';
      sub.textContent = `${p.type} · pid ${p.pid}`;
      meta.appendChild(title); meta.appendChild(sub);
      item.appendChild(meta);
      const badge = document.createElement('span');
      badge.className = 'discovery-live-badge';
      badge.textContent = 'live';
      badge.title = 'A Claude/Codex process is running in this directory right now';
      item.appendChild(badge);
      discoveryList.appendChild(item);
    }
  }
}

async function openDiscovery() {
  discoveryOverlay.classList.remove('hidden');
  discoveryList.textContent = '';
  const scanning = document.createElement('div');
  scanning.className = 'discovery-empty';
  scanning.textContent = 'Scanning…';
  discoveryList.appendChild(scanning);
  const res = await window.api.discoverSessions({});
  renderDiscovery(res);
}

if (discoveryRefresh) discoveryRefresh.addEventListener('click', () => openDiscovery());
if (discoveryClose) discoveryClose.addEventListener('click', () => closeDiscovery());
if (discoveryOverlay) discoveryOverlay.addEventListener('click', (e) => { if (e.target === discoveryOverlay) closeDiscovery(); });
window.api.onRequestOpenDiscovery(() => openDiscovery());
// Sidebar-toolbar entry — same action as File ▸ Discover Sessions…; the sidebar
// is where sessions live, and the dialog's "Find…" sits below the fold.
const btnDiscover = document.getElementById('btn-discover');
if (btnDiscover) btnDiscover.addEventListener('click', () => openDiscovery());
// "Find…" next to the Resume field opens the picker on top of the New Session
// dialog; adopting a row fills this dialog's fields in place.
const btnFindSession = document.getElementById('btn-find-session');
if (btnFindSession) btnFindSession.addEventListener('click', () => openDiscovery());

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
const prefsDiscoverOnStartup = document.getElementById('prefs-discover-on-startup');
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
const prefsRemoteToken = document.getElementById('prefs-remote-token');
const prefsRemoteTokenSave = document.getElementById('prefs-remote-token-save');
const prefsRemoteTokenClear = document.getElementById('prefs-remote-token-clear');
const prefsRemoteTokenState = document.getElementById('prefs-remote-token-state');

// Reflect the write-only token state (a derived boolean — the value never leaves
// main). Called on prefs-open and after every set/clear.
function renderRemoteTokenState(hasToken) {
  prefsRemoteTokenState.textContent = hasToken
    ? 'A token is configured ✓ — paste a new one to replace it, or Clear to remove.'
    : 'No token set — phone access is open to anyone who can reach the port.';
  prefsRemoteTokenState.style.color = hasToken ? 'var(--ok, #3fb950)' : 'var(--warn, #d9a55b)';
}

async function saveRemoteToken(value) {
  const res = await window.api.remoteSetToken(value);
  if (!res || res.ok === false) {
    showToast(`Update token failed: ${(res && res.error) || 'unknown error'}`, { kind: 'error' });
    return;
  }
  prefsRemoteToken.value = '';
  renderRemoteTokenState(!!res.hasToken);
  // The server was torn down + rebuilt with the new gate; reflect it now rather
  // than waiting for the 1.5s poll tick.
  refreshWsStatus();
  showToast(res.hasToken ? 'Phone-access token saved.' : 'Phone-access token cleared.', { kind: res.hasToken ? 'warm' : 'peer-ui' });
}
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

// Fold a peer row back to its one-line summary, refreshing that summary from the
// row's live inputs first so an edited label/host is reflected while collapsed.
function collapsePeerRow(wrap) {
  if (wrap._refreshSummary) wrap._refreshSummary();
  wrap.classList.add('collapsed');
}

function addPeerRow(peer, { expanded = false } = {}) {
  // Drop the "No peers yet." placeholder the moment a real row appears.
  const emptyHint = peersListBox.querySelector('.peers-empty');
  if (emptyHint) emptyHint.remove();
  // Accordion: only one row's full config surface is open at a time. A row added
  // expanded (Add Peer) collapses every existing row first; the dialog's initial
  // load renders all rows collapsed (one line each).
  if (expanded) peersListBox.querySelectorAll('.peer-row-wrap').forEach((w) => collapsePeerRow(w));
  const wrap = document.createElement('div');
  wrap.className = expanded ? 'peer-row-wrap' : 'peer-row-wrap collapsed';
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
    <input type="text" class="peer-row-port" title="Peer protocol port on the remote machine (default 7900)" value="${esc(String(portVal))}">
    <label class="peer-row-advlabel">folder</label>
    <input type="text" class="peer-row-folder" title="Install/clone dir on the peer — ~/… (home-relative) or /abs (default ~/wb-wrap-ui)" value="${esc(folderVal)}">
    <label class="peer-row-advlabel">token</label>
    <input type="password" class="peer-row-token" autocomplete="off" spellcheck="false" title="Operator auth token for a tokened remote wire (CLODEX_REMOTE_TOKEN on the peer). Write-only: leave blank to keep the stored one." placeholder="${peer.hasToken ? 'set — blank keeps' : 'optional'}">
    ${peer.hasToken ? `<label class="peer-row-cleartoken" title="Delete the stored token on save"><input type="checkbox" class="peer-row-token-clear"> clear</label>` : ''}
    ${folderReported ? `<span class="peer-row-folder-hint peer-status-dim">folder reported by the peer</span>` : ''}`;
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
  // Collapsed one-liner header: a disclosure caret, the peer's label/host, and a
  // dim live-status note. Clicking it toggles the row's full config surface below
  // (accordion — see collapsePeerRow/expandPeerRow). Refreshed from the live
  // inputs whenever the row collapses so an edited label shows when folded.
  const summary = document.createElement('div');
  summary.className = 'peer-row-summary';
  summary.innerHTML =
    `<span class="peer-row-caret">&#9654;</span>` +
    `<span class="peer-row-summary-label"></span>` +
    `<span class="peer-row-summary-status peer-status-dim"></span>`;
  function refreshSummary() {
    const lbl = row.querySelector('.peer-row-label').value.trim() || peerRowDest(row) || 'New peer';
    summary.querySelector('.peer-row-summary-label').textContent = lbl;
    const st = peer.id && peerStatuses.get(peer.id);
    const statEl = summary.querySelector('.peer-row-summary-status');
    if (st && st.online) statEl.textContent = st.version ? `online · v${st.version}` : 'online';
    else if (peer.id) statEl.textContent = 'offline';
    else statEl.textContent = '';
  }
  wrap._refreshSummary = refreshSummary;
  refreshSummary();
  summary.addEventListener('click', () => {
    if (wrap.classList.contains('collapsed')) {
      peersListBox.querySelectorAll('.peer-row-wrap').forEach((w) => collapsePeerRow(w));
      wrap.classList.remove('collapsed');
    } else {
      collapsePeerRow(wrap);
    }
  });
  wrap.appendChild(summary);
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
      `<div class="peer-status-actions"><button type="button" class="peer-install-btn">Install Clodex on this peer</button></div>`);
    status.querySelector('.peer-install-btn').addEventListener('click', () => peerRunDeploy(row, status, sshHost, port));
  } else if (res.kind === 'not-clodex') {
    renderPeerStatus(status,
      `<span class="peer-status-ok">✓ ssh</span><span class="peer-status-warn"> · something is answering on 127.0.0.1:${port}, but it isn't Clodex.</span>` +
      `<div class="peer-status-note">Pick a different port, or free that one on the peer.</div>`);
  } else { // ssh-fail
    renderPeerStatus(status,
      `<span class="peer-status-err">✗ ssh could not connect.</span>` +
      (res.stderr ? `<pre class="peer-status-pre">${esc(res.stderr)}</pre>` : '') +
      `<div class="peer-status-note">Check key-based ssh works from a terminal (<code>ssh ${esc(sshHost)}</code>), and that Remote Login is enabled on the peer.</div>`);
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
        `<div class="peer-status-warn">Run these on the peer, then click Test &amp; Set Up again:</div>` +
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
    if (!sudoCmds.length) tailBox.innerHTML = `<div class="peer-status-warn">Needs sudo on the peer — see the peer's terminal, then Test &amp; Set Up again.</div>`;
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
        showToast(`Open fix session failed: ${(res && res.error) || 'no response'}`, { kind: 'warm' });
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
    // Operator auth token — write-only (docs/remote-auth-plan.md §4). A typed
    // value SETS it; the "clear" checkbox sends '' to delete it; leaving the field
    // blank OMITS the key so sanitizePeers carries the stored token forward (the
    // dialog only ever knows hasToken, never the value). Typed value wins over the
    // clear box if both are somehow set.
    const tokenInput = row.querySelector('.peer-row-token');
    const clearBox = row.querySelector('.peer-row-token-clear');
    const typed = tokenInput ? tokenInput.value.trim() : '';
    if (typed) peer.token = typed;
    else if (clearBox && clearBox.checked) peer.token = '';
    out.push(peer);
  }
  return { ok: true, peers: out };
}

document.getElementById('peers-add').addEventListener('click', () => addPeerRow({}, { expanded: true }));

// Managed boxes register themselves as peers (sandbox.js registerPeer), but they
// have their own management surface (the Sandboxes panel) and must NOT be
// double-managed in this dialog. They're filtered out of the row list for display
// only; Save re-fetches and re-merges them fresh at WRITE time (see the save
// handler) — never from a dialog-open snapshot, because a box Rebuild between open
// and Save re-registers the box with a fresh url/token that a stale stash would
// clobber (same whole-array-round-trip lesson as the whitelist store).
async function boxPeerIds() {
  try { return new Set(((await window.api.sandboxListBoxes()) || []).map((b) => b && b.id).filter(Boolean)); }
  catch { return new Set(); }
}

async function openPeersDialog() {
  const s = await window.api.getSettings();
  peersListBox.innerHTML = '';
  const boxIds = await boxPeerIds();
  const peers = s.peers || [];
  const genuine = peers.filter((p) => !(p && boxIds.has(p.id)));
  for (const p of genuine) addPeerRow(p);
  if (genuine.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint-text peers-empty';
    empty.textContent = 'No peers yet.';
    peersListBox.appendChild(empty);
  }
  peersOverlay.classList.remove('hidden');
}

function closePeersDialog() { peersOverlay.classList.add('hidden'); }

document.getElementById('btn-peers-cancel').addEventListener('click', closePeersDialog);
document.getElementById('btn-peers-save').addEventListener('click', async () => {
  const collected = collectPeers();
  if (!collected.ok) return;   // invalid port/folder — inline error already shown, keep the dialog open
  // Re-merge the managed box peers FRESH at write time (never from a dialog-open
  // stash): a box Rebuild since open bumps its ports and re-registers the peer with
  // a new url/token, and setSettings replaces the whole peers array, so a stale
  // snapshot here would overwrite that fresh entry. Re-fetch settings + the box-id
  // set now; carry the box entries through untouched (hasToken is the derived
  // getSettings shape — strip it; tokens round-trip via sanitizePeers' omit-carries-
  // forward-by-id path).
  const fresh = await window.api.getSettings();
  const boxIds = await boxPeerIds();
  const boxPeers = (fresh.peers || [])
    .filter((p) => p && boxIds.has(p.id))
    .map(({ hasToken, ...rest }) => rest);
  await window.api.setSettings({ peers: [...collected.peers, ...boxPeers] });
  closePeersDialog();
});
peersOverlay.addEventListener('mousedown', (e) => { if (e.target === peersOverlay) closePeersDialog(); });
window.api.onRequestOpenPeersDialog(() => openPeersDialog());

// ── Managed Docker sandbox dialog (docs/sandbox-plan.md M2) ─────────────────
const sandboxOverlay = document.getElementById('sandbox-overlay');
const sbDockerRow = document.getElementById('sandbox-docker');
const sbStatusRow = document.getElementById('sandbox-status');
const sbWorkdir = document.getElementById('sandbox-workdir');
const sbAutoStart = document.getElementById('sandbox-autostart');
const sbToggleBtn = document.getElementById('btn-sandbox-toggle');
const sbRebuildBtn = document.getElementById('btn-sandbox-rebuild');
const sbOpenRow = document.getElementById('sandbox-open-row');
const sbOpenLink = document.getElementById('sandbox-open-link');
// Effective-ports line: shown only while running (what the box IS listening on).
// Ports have no editable field — engine-managed, settings-file-only (M6b bug #4).
const sbPortsLine = document.getElementById('sandbox-ports-line');
const sbToken = document.getElementById('sandbox-token');
const sbTokenSave = document.getElementById('sandbox-token-save');
const sbTokenClear = document.getElementById('sandbox-token-clear');
const sbMountsList = document.getElementById('sandbox-mounts-list');
const sbMountsAdd = document.getElementById('sandbox-mounts-add');
const sbMountsRestart = document.getElementById('sandbox-mounts-restart');
// M6b P2: box list + create/delete controls. The detail fields above are now
// scoped to sbCurrentBox — every sandbox IPC call threads it as the boxId.
const sbBoxList = document.getElementById('sandbox-box-list');
const sbBoxNewId = document.getElementById('sandbox-box-new-id');
const sbBoxCreate = document.getElementById('sandbox-box-create');
const sbDetail = document.getElementById('sandbox-detail');
const sbDetailLabel = document.getElementById('sandbox-detail-label');
const sbDeleteBtn = document.getElementById('btn-sandbox-delete');
let sbPollTimer = null;
let sbRunning = false;
let sbBusy = false;
// The selected box's EFFECTIVE (last-generated, possibly bumped) host ports by
// role — status.ports while running, null when stopped. Both the Open-in-browser
// link and its click handler read the live web port from here, not the (disabled,
// possibly-stale) configured field. Bug #4: two boxes on the same configured port.
let sbEffectivePorts = null;
// The box the detail view is currently scoped to (default: the shared box), and
// the registry rows [{id,label}] backing the list.
let sbCurrentBox = 'sandbox';
let sbBoxes = [];
// M6a mounts editor: the live in-memory list (host + ro per row), and a flag set
// when the list is edited while the box is running — a bind only attaches at
// container create, so the change needs a restart to take effect.
let sbMounts = [];
let sbMountsDirty = false;

// Render a notice {kind,text} into a .sandbox-row as a colored dot + text.
function renderSandboxNotice(row, notice) {
  row.innerHTML = '';
  const dot = document.createElement('span');
  dot.className = `sandbox-dot ${notice.kind}`;
  row.appendChild(dot);
  row.appendChild(document.createTextNode(notice.text));
}

// The live web port to open: the effective (bumped) port when running, else the
// engine default (the link only shows while running, so effective is normally set).
// Keeps box 2's link off box 1's port (bug #4).
function effectiveWebPort() {
  return (sbEffectivePorts && sbEffectivePorts.web) || 7810;
}

// Reflect running/stopped into the button label, the Open-in-browser link, and the
// effective-ports line. `ports` is the effective per-role host ports from status
// (running only); ports have no editable field now — they're engine-managed and
// only ever surfaced here, as what the box IS listening on.
function applySandboxRunning(running, ports = null) {
  sbRunning = running;
  sbEffectivePorts = running ? (ports || null) : null;
  sbToggleBtn.textContent = running ? 'Stop' : 'Start';
  const portsLine = sandboxPortsLineText(sbEffectivePorts);
  if (running && portsLine) {
    sbPortsLine.textContent = portsLine;
    sbPortsLine.classList.remove('hidden');
  } else {
    sbPortsLine.classList.add('hidden');
  }
  if (running) {
    sbOpenLink.href = sandboxOpenUrl(effectiveWebPort());
    sbOpenRow.classList.remove('hidden');
  } else {
    sbOpenRow.classList.add('hidden');
  }
}

async function refreshSandboxStatus() {
  try {
    const [detect, status] = await Promise.all([
      window.api.sandboxDetect(sbCurrentBox),
      window.api.sandboxStatus(sbCurrentBox),
    ]);
    renderSandboxNotice(sbDockerRow, sandboxDetectNotice(detect));
    const sn = sandboxStatusNotice(status && status.state);
    renderSandboxNotice(sbStatusRow, sn);
    if (!sbBusy) applySandboxRunning(sn.running, status && status.ports);
    // The mounts restart-hint depends on running state — repaint it each poll.
    sbMountsRestart.classList.toggle('hidden', !(sbMountsDirty && sbRunning));
    // Keep the selected box's list row (dot + Start/Stop label) in step with the
    // detail poll, so the row reflects the same state without its own docker call.
    const selRow = sbBoxList.querySelector('.sandbox-box-row.selected');
    if (selRow) {
      const dot = selRow.querySelector('.sandbox-dot');
      if (dot) dot.className = `sandbox-dot ${sn.kind}`;
      const tog = selRow.querySelector('.sandbox-box-toggle');
      if (tog && !sbBusy) tog.textContent = sn.running ? 'Stop' : 'Start';
    }
  } catch { /* dialog closed mid-poll, or engine hiccup — next tick retries */ }
}

// The token field is WRITE-ONLY (docs/sandbox-plan.md M4): the value never
// crosses back out, so the field always opens blank and the placeholder is the
// only "configured" signal — a blank Save keeps whatever's already stored.
function applyTokenState(hasToken) {
  sbToken.value = '';
  sbToken.placeholder = hasToken
    ? '•••••••• configured — paste a new token to replace'
    : 'Run `claude setup-token`, then paste the token here';
}

// Render the mounts editor from sbMounts: one row per mount (host path + rw/ro
// toggle + remove), plus the running-restart hint. Pure DOM off the in-memory
// list — every mutation goes through persistMounts, which is the validation gate.
function renderMounts() {
  sbMountsList.innerHTML = '';
  for (let i = 0; i < sbMounts.length; i++) {
    const m = sbMounts[i];
    const row = document.createElement('div');
    row.className = 'sandbox-mount-row';
    const pathEl = document.createElement('span');
    pathEl.className = 'sandbox-mount-path';
    pathEl.textContent = m.host;
    pathEl.title = m.host;
    const roBtn = document.createElement('button');
    roBtn.type = 'button';
    roBtn.className = 'secondary sandbox-mount-mode';
    roBtn.textContent = m.ro ? 'read-only' : 'read-write';
    roBtn.title = 'Toggle whether agents can write to this folder';
    roBtn.addEventListener('click', () => persistMounts(sbMounts.map((x, j) => j === i ? { ...x, ro: !x.ro } : x)));
    const rmBtn = document.createElement('button');
    rmBtn.type = 'button';
    rmBtn.className = 'secondary sandbox-mount-remove';
    rmBtn.textContent = 'Remove';
    rmBtn.addEventListener('click', () => persistMounts(sbMounts.filter((_x, j) => j !== i)));
    row.append(pathEl, roBtn, rmBtn);
    sbMountsList.appendChild(row);
  }
  sbMountsRestart.classList.toggle('hidden', !(sbMountsDirty && sbRunning));
}

// Validate + persist a proposed mounts list through setConfig (the engine is the
// single validation authority — absolute/exists/no-shadow/no-dup). On success
// adopt the cleaned list the engine stored and re-render; on rejection keep the
// old list and toast the reason. A successful edit while running arms the
// restart-needed hint.
async function persistMounts(next) {
  const r = await window.api.sandboxSetConfig({ mounts: next }, sbCurrentBox);
  if (r && r.ok === false) {
    showToast(`Mount rejected: ${r.error || 'invalid folder'}`, { kind: 'error', duration: 9000 });
    renderMounts();   // repaint the unchanged list (e.g. reset a half-toggled control)
    return;
  }
  sbMounts = (r && r.mounts) ? r.mounts.map((m) => ({ host: m.host, ro: !!m.ro })) : next;
  if (sbRunning) sbMountsDirty = true;
  renderMounts();
}

sbMountsAdd.addEventListener('click', async () => {
  const dir = await window.api.selectDirectory();
  if (!dir) return;
  await persistMounts([...sbMounts, { host: dir, ro: false }]);
});

// Render the box list from sbBoxes: one row per registry box (status dot + label
// + inline Start/Stop), the current box highlighted. Each row's dot/toggle comes
// from that box's own compose status (fetched in parallel on render — not on the
// steady 3s poll, which only touches the selected box). Clicking a row selects it;
// the Start/Stop button toggles that box without selecting it.
async function renderBoxList() {
  const boxes = sbBoxes;
  const notices = await Promise.all(boxes.map((b) =>
    window.api.sandboxStatus(b.id).then((s) => sandboxStatusNotice(s && s.state)).catch(() => sandboxStatusNotice())));
  sbBoxList.innerHTML = '';
  if (boxes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint-text sandbox-box-empty';
    empty.textContent = 'No sandboxes yet — create one below.';
    sbBoxList.appendChild(empty);
    return;
  }
  boxes.forEach((b, i) => {
    const sn = notices[i];
    const row = document.createElement('div');
    row.className = 'sandbox-box-row' + (b.id === sbCurrentBox ? ' selected' : '');
    const dot = document.createElement('span');
    dot.className = `sandbox-dot ${sn.kind}`;
    const label = document.createElement('span');
    label.className = 'sandbox-box-label';
    label.textContent = b.label;
    label.title = b.id;
    const tog = document.createElement('button');
    tog.type = 'button';
    tog.className = 'secondary sandbox-box-toggle';
    tog.textContent = sn.running ? 'Stop' : 'Start';
    tog.addEventListener('click', (e) => { e.stopPropagation(); toggleBox(b.id, sn.running); });
    row.append(dot, label, tog);
    row.addEventListener('click', () => selectBox(b.id));
    sbBoxList.appendChild(row);
  });
}

// Load the detail fields for sbCurrentBox from its stored config. Every box is
// deletable (M6b P2, no shared-box special status); 'sandbox' is merely the
// default-created box name.
async function loadBoxDetail() {
  // Switching boxes: drop the previous box's effective ports so its link/hint can't
  // apply here — the next status poll (refreshSandboxStatus) repopulates them.
  sbEffectivePorts = null;
  const cfg = await window.api.sandboxGetConfig(sbCurrentBox);
  const box = sbBoxes.find((b) => b.id === sbCurrentBox);
  sbDetailLabel.textContent = (box && box.label) || sbCurrentBox;
  sbWorkdir.value = cfg.workDir || '';
  sbAutoStart.checked = !!cfg.autoStart;
  sbMounts = Array.isArray(cfg.mounts) ? cfg.mounts.map((m) => ({ host: m.host, ro: !!m.ro })) : [];
  sbMountsDirty = false;
  renderMounts();
  applyTokenState(!!cfg.hasToken);
}

// Show/hide the per-box detail surface. Hidden when the registry is empty (the
// user deleted every box) — only the create row remains.
function showDetail(show) { sbDetail.style.display = show ? '' : 'none'; }

// Switch the detail view to another box. No-op mid-lifecycle so a switch can't
// race an in-flight up/down/rebuild.
async function selectBox(id) {
  if (sbBusy || id === sbCurrentBox) return;
  sbCurrentBox = id;
  await loadBoxDetail();
  await renderBoxList();
  await refreshSandboxStatus();
}

// Start/Stop a box straight from its list row (no field persist — its config is
// already stored). Guarded by sbBusy like the detail lifecycle buttons.
async function toggleBox(id, running) {
  if (sbBusy) return;
  sbBusy = true;
  try {
    const r = running ? await window.api.sandboxDown(id) : await window.api.sandboxUp(id);
    if (!r || r.ok === false) {
      showToast(`Sandbox ${running ? 'stop' : 'start'} failed: ${(r && r.error) || 'unknown error'}`, { kind: 'error', duration: 12000 });
    }
  } catch (e) {
    showToast(`Sandbox ${running ? 'stop' : 'start'} failed: ${(e && e.message) || e}`, { kind: 'error', duration: 12000 });
  } finally {
    sbBusy = false;
    await renderBoxList();
    if (id === sbCurrentBox) await refreshSandboxStatus();
  }
}

async function openSandboxDialog() {
  sbBoxes = await window.api.sandboxListBoxes();
  if (!sbBoxes.some((b) => b.id === sbCurrentBox)) sbCurrentBox = (sbBoxes[0] && sbBoxes[0].id) || null;
  if (sbCurrentBox) { showDetail(true); await loadBoxDetail(); } else { showDetail(false); }
  await renderBoxList();
  sandboxOverlay.classList.remove('hidden');
  if (sbCurrentBox) await refreshSandboxStatus();
  // Poll compose ps only while the dialog is open (the peer row's dot is the
  // global indicator — no background polling). The poll touches the selected box
  // only; other rows refresh on list re-render (open/select/create/delete/toggle).
  if (sbPollTimer) clearInterval(sbPollTimer);
  sbPollTimer = setInterval(refreshSandboxStatus, 3000);
}

function closeSandboxDialog() {
  if (sbPollTimer) { clearInterval(sbPollTimer); sbPollTimer = null; }
  sandboxOverlay.classList.add('hidden');
}

// Persist the editable config from the fields (ports coerced; blank workDir =
// named volume). The engine's sanitizer is the backstop, but send clean values.
// The ports are engine-managed (no field) so they're NOT collected — setConfig
// merges over the stored config, so the persisted port values (or defaults) are
// preserved untouched. workDir + autoStart are the only GUI-editable config now.
function collectSandboxConfig() {
  return {
    workDir: sbWorkdir.value.trim() || null,
    autoStart: sbAutoStart.checked,
  };
}

// The work-folder picker is native on the desktop; on the web frontend the text
// field is the input surface (the degraded picker would confuse), so hide the
// button there.
const sbWorkdirPick = document.getElementById('sandbox-workdir-pick');
// The folder pickers are native (dialog.showOpenDialog); on the web frontend the
// degraded picker would confuse, so hide both add-by-folder affordances there
// (existing mount rows still render + toggle/remove — those need no picker).
if (window.__CLODEX_WEB__) { sbWorkdirPick.classList.add('hidden'); sbMountsAdd.classList.add('hidden'); }
sbWorkdirPick.addEventListener('click', async () => {
  const dir = await window.api.selectDirectory();
  if (dir) sbWorkdir.value = dir;
});
document.getElementById('sandbox-workdir-clear').addEventListener('click', () => { sbWorkdir.value = ''; });

// Persist autoStart the moment it's toggled — it's honored at next launch even
// if the user never clicks Start.
sbAutoStart.addEventListener('change', () => { window.api.sandboxSetConfig({ autoStart: sbAutoStart.checked }, sbCurrentBox); });

// Auth token — write-only paste + clear (M4). Save writes the 0600 auth.env;
// Clear deletes it. Neither reads a value back; the placeholder reflects state.
// The token applies on the next Start (the env_file line lands when compose is
// regenerated), so no restart is forced here.
sbTokenSave.addEventListener('click', async () => {
  const t = sbToken.value.trim();
  if (!t) { showToast('Paste a token first (or use Clear to remove it).', { kind: 'peer-ui' }); return; }
  const r = await window.api.sandboxSetToken(t, sbCurrentBox);
  if (!r || r.ok === false) {
    showToast(`Save token failed: ${(r && r.error) || 'unknown error'}`, { kind: 'error', duration: 8000 });
    return;
  }
  applyTokenState(true);
  showToast('Claude auth token saved — it applies on the next Start.', { kind: 'peer-ui' });
});
sbTokenClear.addEventListener('click', async () => {
  const r = await window.api.sandboxClearToken(sbCurrentBox);
  if (!r || r.ok === false) {
    showToast(`Clear token failed: ${(r && r.error) || 'unknown error'}`, { kind: 'error', duration: 8000 });
    return;
  }
  applyTokenState(false);
  showToast('Claude auth token cleared.', { kind: 'peer-ui' });
});

sbToggleBtn.addEventListener('click', async () => {
  if (sbBusy) return;
  sbBusy = true;
  const wasRunning = sbRunning;
  sbToggleBtn.disabled = true;
  sbRebuildBtn.disabled = true;
  sbToggleBtn.textContent = wasRunning ? 'Stopping…' : 'Starting…';
  try {
    // Persist the current field values before Start so the container comes up on
    // the configured ports/workdir; a Stop doesn't need them but a save is cheap.
    await window.api.sandboxSetConfig(collectSandboxConfig(), sbCurrentBox);
    const r = wasRunning ? await window.api.sandboxDown(sbCurrentBox) : await window.api.sandboxUp(sbCurrentBox);
    if (!r || r.ok === false) {
      showToast(`Sandbox ${wasRunning ? 'stop' : 'start'} failed: ${(r && r.error) || 'unknown error'}`, { kind: 'error', duration: 12000 });
    } else if (!wasRunning) {
      sbMountsDirty = false;   // a fresh Start created the container with current mounts
    }
  } catch (e) {
    showToast(`Sandbox ${wasRunning ? 'stop' : 'start'} failed: ${(e && e.message) || e}`, { kind: 'error', duration: 12000 });
  } finally {
    sbBusy = false;
    sbToggleBtn.disabled = false;
    sbRebuildBtn.disabled = false;
    await refreshSandboxStatus();
  }
});

// Rebuild the box on the current code (dev: image rebuild; packaged: image pull),
// then recreate the container. A build can take minutes, so both buttons lock and
// the label shows progress; the box --resumes its sessions so no confirm is needed.
sbRebuildBtn.addEventListener('click', async () => {
  if (sbBusy) return;
  sbBusy = true;
  sbToggleBtn.disabled = true;
  sbRebuildBtn.disabled = true;
  sbRebuildBtn.textContent = 'Rebuilding…';
  try {
    // Persist the current field values first so the rebuilt container comes up on
    // the configured ports/workdir, exactly like Start does.
    await window.api.sandboxSetConfig(collectSandboxConfig(), sbCurrentBox);
    const r = await window.api.sandboxRebuild(sbCurrentBox);
    if (!r || r.ok === false) {
      showToast(`Sandbox rebuild failed: ${(r && r.error) || 'unknown error'}`, { kind: 'error', duration: 12000 });
    } else {
      sbMountsDirty = false;   // rebuild recreated the container with current mounts
      showToast('Sandbox rebuilt on the current code.', { kind: 'peer-ui' });
    }
  } catch (e) {
    showToast(`Sandbox rebuild failed: ${(e && e.message) || e}`, { kind: 'error', duration: 12000 });
  } finally {
    sbBusy = false;
    sbToggleBtn.disabled = false;
    sbRebuildBtn.disabled = false;
    sbRebuildBtn.textContent = 'Rebuild';
    await refreshSandboxStatus();
  }
});

// Create a box: the engine gates the id (lowercase compose-charset) and mints a
// row from defaults. On success refresh the list and select the new box.
sbBoxCreate.addEventListener('click', async () => {
  if (sbBusy) return;
  const id = sbBoxNewId.value.trim();
  if (!id) { showToast('Enter a sandbox id first.', { kind: 'peer-ui' }); return; }
  const r = await window.api.sandboxCreateBox(id, id);
  if (!r || r.ok === false) {
    showToast(`Create sandbox failed: ${(r && r.error) || 'unknown error'}`, { kind: 'error', duration: 9000 });
    return;
  }
  sbBoxNewId.value = '';
  sbBoxes = await window.api.sandboxListBoxes();
  sbCurrentBox = r.box.id;
  showDetail(true);
  await loadBoxDetail();
  await renderBoxList();
  await refreshSandboxStatus();
  showToast(`Created sandbox "${r.box.label}".`, { kind: 'peer-ui' });
});
sbBoxNewId.addEventListener('keydown', (e) => { if (e.key === 'Enter') sbBoxCreate.click(); });

// Delete the current box: confirm (noting the left-behind volumes), then the
// engine stops the container, drops the peer row, and removes the registry row.
// Any box is deletable — 'sandbox' has no special status (M6b P2). Emptying the
// registry hides the detail surface until a box is created.
sbDeleteBtn.addEventListener('click', async () => {
  if (sbBusy || !sbCurrentBox) return;
  const box = sbBoxes.find((b) => b.id === sbCurrentBox);
  const label = (box && box.label) || sbCurrentBox;
  const ok = confirm(`Delete sandbox "${label}"? Its container is stopped and removed and it's dropped from the peer list. Its Docker volumes are LEFT BEHIND — reclaim them with \`docker volume rm\` if you want the data gone.`);
  if (!ok) return;
  sbBusy = true;
  sbDeleteBtn.disabled = true;
  try {
    const r = await window.api.sandboxDeleteBox(sbCurrentBox);
    if (!r || r.ok === false) {
      showToast(`Delete sandbox failed: ${(r && r.error) || 'unknown error'}`, { kind: 'error', duration: 9000 });
      return;
    }
    if (r.downError) showToast(`Sandbox "${label}" deleted, but stop reported: ${r.downError}`, { kind: 'warn', duration: 9000 });
    else showToast(`Sandbox "${label}" deleted (volumes left behind).`, { kind: 'peer-ui' });
    sbBoxes = await window.api.sandboxListBoxes();
    sbCurrentBox = (sbBoxes[0] && sbBoxes[0].id) || null;
  } finally {
    sbBusy = false;
    sbDeleteBtn.disabled = false;
    if (sbCurrentBox) { showDetail(true); await loadBoxDetail(); await renderBoxList(); await refreshSandboxStatus(); }
    else { showDetail(false); await renderBoxList(); }
  }
});

// Route through openExternal, not a target="_blank" anchor: the desktop has no
// setWindowOpenHandler, so _blank would open a chromeless BrowserWindow instead
// of the user's browser. openExternal degrades correctly on web (open-external
// fan → shim window.open).
sbOpenLink.addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal(sandboxOpenUrl(effectiveWebPort()));
});

document.getElementById('btn-sandbox-close').addEventListener('click', closeSandboxDialog);
sandboxOverlay.addEventListener('mousedown', (e) => { if (e.target === sandboxOverlay) closeSandboxDialog(); });
document.getElementById('btn-peers-sandbox').addEventListener('click', () => { closePeersDialog(); openSandboxDialog(); });
window.api.onRequestOpenSandboxDialog(() => openSandboxDialog());
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
  if (prefsDiscoverOnStartup) prefsDiscoverOnStartup.checked = !!s.discoverOnStartup;
  prefsRemoteEnabled.checked = !!s.remoteEnabled;
  prefsRemoteToken.value = '';
  renderRemoteTokenState(!!s.remoteHasToken);
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
    discoverOnStartup: prefsDiscoverOnStartup ? prefsDiscoverOnStartup.checked : false,
    remoteEnabled: prefsRemoteEnabled.checked,
  });
  // Default tool denies live in a separate store (the "*" agent-default), so
  // persist them via their own setter. collectToolChecklist returns the
  // unchecked (= denied) tools.
  await window.api.setDefaultToolDeny(collectToolChecklist(prefsToolsList));
  closePrefs();
});

// Phone-access token is managed OUT of the main Save flow — it lives write-only
// in <userData>/remote.env, not ui-settings, and applies immediately (the server
// rebuilds), so Save/Clear act on their own.
prefsRemoteTokenSave.addEventListener('click', () => {
  const v = prefsRemoteToken.value.trim();
  if (!v) { showToast('Paste a token first (use Clear to remove).', { kind: 'warn' }); return; }
  saveRemoteToken(v);
});
prefsRemoteTokenClear.addEventListener('click', () => saveRemoteToken(''));

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
// Skills section — PEER-only (a local edit keeps the standalone Skills popover on
// the ⚙ session menu). Folded here so a peer viewer edits every travelable setting
// from one dialog whose modal scrolls (the floating popover overflowed under the
// top chrome when anchored to the proxy bar).
const argsSkillsRow = document.getElementById('args-skills-row');
const argsSkillsList = document.getElementById('args-skills-list');
const argsSkillsSection = document.getElementById('args-skills-section');
const argsInjectSkillsSection = document.getElementById('args-inject-skills-section');
const argsInjectSkillsList = document.getElementById('args-inject-skills-list');
wireBulkToggles(argsToolsRow, argsToolsList);
wireBulkToggles(argsSkillsRow, argsSkillsList);
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
// Same scoped-checklist Save inputs for the peer skills inject list (mirrors the
// standalone Skills popover): persisted inject set, rendered names, auto-included.
let argsSkillsInjectPersisted = [];
let argsSkillsInjectRendered = [];
let argsSkillsInjectAuto = [];

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
  let res, settings, promptLib, agentLib, skillCatalog = null;
  if (argsSource) {
    const r = await argsSource.fetch();
    if (!r || !r.ok) { alert(r && r.error ? r.error : 'Session not found.'); return; }
    ({ res, settings, promptLib, agentLib, skillCatalog } = r);
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
  // Skills — PEER Claude only (a local edit uses the standalone popover). Rendered
  // from the box's skill catalog carried in the peer fetch; hidden (never collected
  // or sent) for a local edit or a non-Claude / catalog-less peer. Mirrors the
  // standalone Skills popover: a disable checklist + an optional library-inject
  // section shown only when the box's skill library is non-empty.
  const isSkillsEditable = isClaude && !!argsSource && !!skillCatalog;
  argsSkillsSection.style.display = isSkillsEditable ? '' : 'none';
  if (isSkillsEditable) {
    const sc = skillCatalog;
    renderSkillChecklist(argsSkillsList, sc.names || [], new Set(sc.disabledSkills || []),
      sc.effective || {}, { skillsLocked: sc.skillsLocked, canReenable: sc.canReenable });
    setSkillLibCache(sc.skillLib || []);
    if ((sc.skillLib || []).length) {
      const auto = skillAutoSet(sc.skillLib, name);
      renderInjectChecklist(argsInjectSkillsList, new Set(sc.injectSkills || []), auto);
      argsSkillsInjectPersisted = sc.injectSkills || [];
      argsSkillsInjectRendered = (sc.skillLib || []).map((s) => s.name);
      argsSkillsInjectAuto = [...auto];
      argsInjectSkillsSection.style.display = '';
    } else {
      argsInjectSkillsSection.style.display = 'none';
      argsSkillsInjectPersisted = []; argsSkillsInjectRendered = []; argsSkillsInjectAuto = [];
    }
  }
  for (const sec of [argsAppendSection, argsToolsSection, argsOtherSection, argsSkillsSection, argsExecSection, argsIntentsSection]) sec.open = false;
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
  // Skills — collected only when the peer-only section is shown; undefined otherwise
  // so the save preserves the persisted set (a hidden section = local edit or a
  // non-Claude peer, neither of which owns skills here). Inject is RECONCILED against
  // the scoped render (out-of-scope survivors kept, auto excluded), exactly like the
  // standalone popover; undefined when the library section is hidden.
  const skillsShown = argsSkillsSection.style.display !== 'none';
  const disabledSkills = skillsShown ? collectSkillChecklist(argsSkillsList) : undefined;
  const injectSkills = !skillsShown || argsInjectSkillsSection.style.display === 'none'
    ? undefined
    : reconcilePartialSelection(argsSkillsInjectPersisted, argsSkillsInjectRendered,
        collectInjectChecklist(argsInjectSkillsList), argsSkillsInjectAuto);
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
        // grants. remote-wiring strips it belt-and-suspenders regardless. Skills DO
        // travel now (peer-only section): disabledSkills/injectSkills carry the
        // collected values, and the peer source persists them + fresh-restarts on
        // apply-now (a resume wouldn't re-read the roster).
        extraArgs: parsed, restart, proxy, systemPrompt: undefined, agents, denyBuiltins,
        disabledTools, disabledSkills, injectSkills, systemPromptFile, appendPromptFiles, intents,
      })
    : await window.api.setSessionArgs(name, parsed, restart, proxy, undefined, agents, denyBuiltins, disabledTools, undefined, undefined, systemPromptFile, appendPromptFiles, intents, execCommandsGrant);
  if (!res || !res.ok) {
    alert(`Save settings failed: ${res && res.error ? res.error : 'unknown error'}`);
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
  if (!restored || restored.length === 0) { initSidebarView(); return; }

  let firstHealthy = null;
  for (const entry of restored) {
    if (entry.archived) {
      // Archived — no PTY; a lightweight placeholder that resumes on click.
      addArchivedSessionToSidebar(entry);
      continue;
    }
    if (entry.failed) {
      // Render as a ghost entry — no xterm, but visible in the sidebar so
      // the user can either retry it or forget it.
      addFailedSessionToSidebar(entry);
      continue;
    }
    const { terminal } = createTerminal(entry.name);
    addSessionToSidebar(entry.name, entry.type, entry.cwd, entry.label, entry.backend || null);
    if (entry.createdAt) sidebarMeta.set(entry.name, { ...(sidebarMeta.get(entry.name) || {}), createdAt: entry.createdAt });
    // Seed the dot from the reattach snapshot — activity/attention events
    // fired while this window was detached were dropped, and the next live
    // event may be a turn away.
    const item = sessionList.querySelector(`[data-name="${CSS.escape(entry.name)}"]`);
    if (item) {
      // A reattached thinking dot gets a fresh stamp — the true start was lost
      // with the detached window's events, so the badge undercounts rather
      // than guesses.
      if (entry.activity) {
        item.dataset.activity = entry.activity;
        if (entry.activity === 'thinking') item.dataset.thinkingSince = String(Date.now());
      }
      if (entry.attention) {
        item.dataset.attention = entry.attention.kind;
        item.dataset.attentionMsg = entry.attention.message || '';
      }
    }
    if (entry.replay) terminal.write(entry.replay);
    if (typeof entry.ctx === 'number') { ctxPct.set(entry.name, entry.ctx); applyCtxBadge(entry.name, entry.ctx); }
    if (typeof entry.ctxTok === 'number' && typeof entry.ctxSize === 'number' && entry.ctxSize > 0) {
      ctxTokens.set(entry.name, { used: entry.ctxTok, size: entry.ctxSize, cost: typeof entry.ctxCost === 'number' ? entry.ctxCost : null, model: entry.ctxModel || null });
    }
    if (entry.proxy) { proxyState.set(entry.name, { payload: entry.proxy, at: Date.now() }); applyWarmBadge(entry.name); }
    if (typeof entry.pendingCount === 'number') applyPendingBadge(entry.name, entry.pendingCount);
    if (!firstHealthy) firstHealthy = entry.name;
  }
  if (firstHealthy) switchSession(firstHealthy);
  // Focus the first restored session
  switchSession(restored[0].name);
  // Load persisted view state, fetch meta, and lay out the grouped/sorted list.
  initSidebarView();
})();

// Opt-in startup session discovery: if enabled, scan for adoptable external
// sessions once the app has settled and open the picker only when there's
// something to adopt. Gated on the preference (default off) so launch is silent
// unless the operator asked for it; File ▸ Discover Sessions… is always available
// regardless. Window gate: only the OS-focused window at launch runs this — every
// restored workspace window loads this same script, and without the gate all of
// them would pop the picker at once. document.hasFocus() is the codebase's
// established "is this the active window" idiom (see the notifier gates above).
(async function maybeDiscoverOnStartup() {
  try {
    if (!document.hasFocus()) return;
    const s = await window.api.getSettings();
    if (!s || !s.discoverOnStartup) return;
    // Let restore + reattach finish painting before we scan/prompt.
    await new Promise((r) => setTimeout(r, 1500));
    // Re-check focus after the settle delay — the operator may have clicked into
    // another window meanwhile; don't steal focus with an unexpected modal.
    if (!document.hasFocus()) return;
    const res = await window.api.discoverSessions({});
    const disk = (res && res.disk) || [];
    if (!disk.length) return;
    renderDiscovery(res);
    discoveryOverlay.classList.remove('hidden');
  } catch {}
})();
