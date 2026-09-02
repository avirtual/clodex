const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SearchAddon } = require('@xterm/addon-search');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const { isExternallyOpenable } = require('../external-link');
// Both halves of the surfacing gate answer through this one predicate. The web
// bundle freezes PLUGIN_CAPABILITIES at build time, which is the copy shape
// `intents:catalog` exists to avoid — safe here only because the bundle ships
// its own engine built from the same tree, and a PEER row carries no
// pluginGrants at all, so a scoped plugin fails closed across that seam rather
// than reading a stale vocabulary.
const { pluginReaches } = require('../plugin-api');
const { clampSidebarWidth, SIDEBAR_WIDTH_DEFAULT } = require('../sidebar-width');
const { mergeMeta } = require('../meta-tiers');
const { PendingInput } = require('../peer-input-queue');
const { versionSeverity, updateApplies, releaseAgeInfo, quotaChip, shapeQuota, pickQuota } = require('../proxy-util');
const { STRIP_LEVELS, SEV_LINE, CTX_CAT_LABELS, COST_SPINE, COST_CONTENT, BUST_FAULT, REP_BUCKET_COLOR, REP_BUCKET_LABEL, REP_CAT_COLOR } = require('./lib/constants');
const { esc, shortPath, baseName, fmtTokens, fmtCountdown, fmtMinutes, fmtAgo, fmtUsd, fmtDur, shortTs, fmtBustTokens, fmtBytes } = require('./lib/format');
const { renderDiffHtml, costStackBlock, svgCostChart, bustRow } = require('./lib/render-html');
const { scanPaths } = require('./lib/path-scan');
const { matchGutterRow, findGutterFile } = require('./lib/gutter-scan');

// How far above a gutter row to look for its `Update(file)` header. The search
// stops at the first row that is not part of the block, so this is only a bound
// on a pathological run, not the usual cost.
const GUTTER_HEADER_SCAN = 400;
const { splitModelArg, withModelArg } = require('./lib/args-model');
const { expandTeamRoot, usesTeamRoot } = require('../team-root-expand');
const { altChordAction } = require('./lib/web-shortcuts');
const { createMirrorLatch } = require('./lib/mirror-latch');
const { createMicHandoff } = require('./lib/mic-handoff');
const { attentionNotice, mentionNotice, badgeTitle, createWebNotifier } = require('./lib/web-notify');
const { detectNotice: sandboxDetectNotice, sandboxActionGate, sandboxGateTreatment, boxRowStartGated, statusNotice: sandboxStatusNotice, openUrl: sandboxOpenUrl, portsLineText: sandboxPortsLineText } = require('./lib/sandbox-view');
const { newSessionToolGate, installSessionParams, newSessionOverlayPlan, shouldRaiseOverlay } = require('./lib/tool-gate');
const { bumpDefaultName, teamNamePrefill } = require('./lib/name-suggest');
const { prefsGate } = require('./lib/prefs-gate');
const { planNewSession } = require('./lib/focus-policy');
const { parseEnvLines, formatEnvLines } = require('./lib/env-edit');
const { isToolInstallSession } = require('../tool-doctor');
const { SANDBOX_PLACEMENT_CWD, showPlacementSelector, nextCwd: placementNextCwd, richFieldsGreyed } = require('./lib/placement');
const { dropText } = require('./lib/drop-paths');
const { turnSeg, reqSeg, costSeg } = require('./lib/turn-stat');
const { renderAppendChecklist, collectAppendChecklist, renderAgentChecklist, collectAgentChecklist, renderExecChecklist, collectExecChecklist, renderIntentChecklist, collectIntentChecklist, renderBuiltinChecklist, collectBuiltinChecklist, renderInjectChecklist, collectInjectChecklist, renderToolChecklist, collectToolChecklist, renderSkillChecklist, collectSkillChecklist, setChecklistAll, wireBulkToggles, setPromptLibCache, setAgentLibCache, setSkillLibCache, setExecLibCache, setIntentCatalogCache, setClaudeToolsCache, setDefaultToolDenyCache, getPromptLibCache, getSkillLibCache, getDefaultToolDenyCache } = require('./lib/checklists');
const { autoEnabledFor, reconcilePartialSelection } = require('../scope-util');
const { parseSkillFrontmatter } = require('../skills-util');
const skillAutoSet = (skillLib, session) => new Set(autoEnabledFor(
  (skillLib || []).map((s) => ({ name: s.name, meta: parseSkillFrontmatter(s.content || '').meta })), session));
const { createDrawerHost } = require('./drawer-host');
const { createIpcLog } = require('./ipc-log');
const { createInboxDrawer } = require('./inbox-drawer');
const { createVoiceCore, createVoiceControl } = require('./voice-control');
const { createTermSearch } = require('./term-search');
const { createIntentHighlight } = require('./intent-highlight');
const { createVoiceSubmitWatcher } = require('./voice-submit-watcher');
const {
  DEFAULT_SUBMIT_PHRASE, readVoiceSubmitSettings, resolveTriggerKey,
} = require('./lib/voice-submit');
const { initBanners } = require('./banners');
const { initThemes } = require('./themes');
const { initLibraryDrawers } = require('./library-drawers');
const { createActivityTab } = require('./activity-tab');
const { createCtlTab } = require('./ctl-tab');
const { createTermTab } = require('./term-tab');
const { classifySubagent } = require('./lib/subagent-policy');
const { initSessionHovercard } = require('./session-hovercard');
const { initTooltips } = require('./tooltip');
const { initReportPanel } = require('./popovers/report-panel');
const { initCostPopover } = require('./popovers/cost-popover');
const { initBustPopover } = require('./popovers/bust-popover');
const { initSessionInfoPopover } = require('./popovers/session-info-popover');
const { initFilesPopover } = require('./popovers/files-popover');
const { initVoicePopover } = require('./popovers/voice-popover');
const { initSelectionPopover } = require('./popovers/selection-popover');
const { initChecklistPopovers } = require('./popovers/checklist-popovers');
const { initTeamRolesPopover } = require('./popovers/team-roles-popover');
const { initContextPopover } = require('./popovers/context-popover');
const { initSessionMenus } = require('./popovers/session-menus');
const { initPeersUi } = require('./peers-ui');
const { initPluginHost } = require('./plugin-host');


const sessions = new Map(); // name -> { terminal, fitAddon, wrapperEl }
let activeSession = null;

const { currentXtermTheme } = initThemes({ sessions });

(function initSidebarResize() {
  const resizer = document.getElementById('sidebar-resizer');
  if (!resizer) return;
  const root = document.documentElement;
  const LS_KEY = 'clodex-sidebar-width';

  const applyWidth = (px) => root.style.setProperty('--sidebar-width', clampSidebarWidth(px) + 'px');
  const persist = (px) => {
    const w = clampSidebarWidth(px);
    try { localStorage.setItem(LS_KEY, String(w)); } catch {}
    try { window.api.setSettings({ sidebarWidth: w }); } catch {}
  };

  window.api.getSettings().then((s) => {
    if (s && typeof s.sidebarWidth === 'number') {
      applyWidth(s.sidebarWidth);
      try { localStorage.setItem(LS_KEY, String(clampSidebarWidth(s.sidebarWidth))); } catch {}
    }
  }).catch(() => {});

  let dragging = false;
  let pendingPx = null;
  let rafId = 0;
  const flush = () => { rafId = 0; if (pendingPx != null) applyWidth(pendingPx); };

  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    resizer.classList.add('dragging');
    try { resizer.setPointerCapture(e.pointerId); } catch {}
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    pendingPx = e.clientX;
    if (!rafId) rafId = requestAnimationFrame(flush);
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    try { resizer.releasePointerCapture(e.pointerId); } catch {}
    document.body.style.userSelect = '';
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    const finalPx = pendingPx != null ? pendingPx : e.clientX;
    pendingPx = null;
    applyWidth(finalPx);
    persist(finalPx);
  };
  resizer.addEventListener('pointerup', endDrag);
  resizer.addEventListener('pointercancel', endDrag);

  resizer.addEventListener('dblclick', () => {
    applyWidth(SIDEBAR_WIDTH_DEFAULT);
    persist(SIDEBAR_WIDTH_DEFAULT);
  });
})();

const sessionList = document.getElementById('session-list');
const terminalContainer = document.getElementById('terminal-container');
const emptyState = document.getElementById('empty-state');
const dialogOverlay = document.getElementById('dialog-overlay');
const inputName = document.getElementById('input-name');
const inputType = document.getElementById('input-type');
const inputCwd = document.getElementById('input-cwd');
const inputArgs = document.getElementById('input-args');
const inputEnv = document.getElementById('input-env');
const envHint = document.getElementById('env-hint');

function renderEnvHint(textarea, hint) {
  if (!textarea || !hint) return;
  const { skipped } = parseEnvLines(textarea.value || '');
  if (!skipped.length) { hint.style.display = 'none'; hint.textContent = ''; return; }
  hint.style.display = '';
  hint.style.color = 'var(--warn, #d9a55b)';
  hint.textContent = `Ignored ${skipped.length} line${skipped.length > 1 ? 's' : ''}: ${skipped.map((s) => s.reason).join('; ')}`;
}
function refreshEnvHint() { renderEnvHint(inputEnv, envHint); }
if (inputEnv) inputEnv.addEventListener('input', refreshEnvHint);
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
const inputWorktree = document.getElementById('input-worktree');
const inputWorktreeBranch = document.getElementById('input-worktree-branch');
const inputWorktreeBase = document.getElementById('input-worktree-base');
const worktreeBaseList = document.getElementById('worktree-base-list');
const worktreeFields = document.getElementById('worktree-fields');
const worktreeRow = document.getElementById('worktree-row');
const cwdSuggestionsList = document.getElementById('cwd-suggestions');
const teamRow = document.getElementById('team-row');
const teamToggle = document.getElementById('input-team-toggle');
const teamToggleLabel = document.getElementById('team-toggle-label');
const teamFields = document.getElementById('team-fields');
const teamCreateFields = document.getElementById('team-create-fields');
const teamJoinFields = document.getElementById('team-join-fields');
const teamNameInput = document.getElementById('input-team-name');
const teamRoleSelect = document.getElementById('input-team-role');
const teamRolePromptRow = document.getElementById('team-role-prompt-row');
const teamRolePromptSelect = document.getElementById('input-team-role-prompt');
let dialogTeamMode = null;   // 'create' | 'join' | null (not an agent / authoring)
let dialogTeamName = null;   // resolved team name in join mode
let dialogTeamNames = [];    // existing team names, for the create dup pre-check
let dialogReservedNames = new Set(); // globally taken session names (live + persisted/archived), for the auto-suffix — Task 15
let lastTeamAutoName = null; // the last <team>-<role> suggestion we wrote to inputName
const placementRow = document.getElementById('placement-row');
const inputPlacement = document.getElementById('input-placement');
const placementHint = document.getElementById('placement-hint');
const PLACEMENT_RICH_ROW_IDS = [
  'system-prompt-row', 'append-prompts-row', 'tools-section', 'skills-section', 'other-section', 'proxy-row',
];

const PLACEMENT_HINT_OLD_BOX = 'This sandbox is running an older Clodex that can’t configure skills, prompts, tools, proxy, or intents at create — set them from the session once it’s running, or update the sandbox.';
const PLACEMENT_HINT_CATALOGS_UNAVAILABLE = 'Couldn’t load the sandbox’s skills/agents/tools catalogs — configure this session from the sandbox once it’s running.';
const PLACEMENT_HINT_BOX_OFFLINE = 'This sandbox isn’t running — start it from the Sandboxes panel, then pick it here.';
let placementCatalogToken = 0;
let dialogHostSettings = null;
let dialogHostAgentLib = null;

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

let dialogMode = 'create';
let editingTemplateId = null;
let templatesDrawerRefresh = null;

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

const homeDir = require('os').homedir();
inputCwd.value = homeDir;


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

sidebarHeader.addEventListener('dblclick', (e) => {
  const target = e.target.closest('#workspace-name');
  if (target) startWorkspaceRename();
});

window.api.onRequestRenameWorkspace(() => startWorkspaceRename());


function typeGlyph(type, backend) {
  if (backend === 'bedrock') return 'B';
  if (backend === 'vertex') return 'V';
  return { claude: 'A', codex: 'C', bash: '›_', remote: '@' }[type]
    || (type ? type[0].toUpperCase() : '?');
}

// Local rows must stay contiguous ABOVE the peer block: the peer block is re-appended
// at the END of sessionList on every peer render, so appending a new local row naively
// lands it BELOW the peers.
function insertLocalSessionRow(item) {
  const firstPeer = sessionList.querySelector('[data-peer-ui]');
  if (firstPeer) sessionList.insertBefore(item, firstPeer);
  else sessionList.appendChild(item);
}

function addFailedSessionToSidebar(entry) {
  const item = document.createElement('div');
  item.className = 'session-item failed';
  item.dataset.name = entry.name;
  item.dataset.cwd = entry.cwd || '';
  item.dataset.type = entry.type;
  item.dataset.failed = '1';
  if (entry.team) item.dataset.team = entry.team; // group-by-project team key
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

  item.addEventListener('click', async (e) => {
    if (e.target.closest('.session-close')) return;
    const res = await window.api.retrySpawnSession(entry.name);
    if (!res.ok) {
      alert(`Retry failed: ${res.error}`);
      return;
    }
    item.remove();
    createTerminal(entry.name);
    addSessionToSidebar(entry.name, entry.type, entry.cwd, entry.label, entry.backend || null, entry.team || null, entry.noWire === true);
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

function addArchivedSessionToSidebar(entry) {
  if (sessionList.querySelector(`[data-name="${CSS.escape(entry.name)}"]`)) return;
  const item = document.createElement('div');
  item.className = 'session-item archived';
  item.dataset.name = entry.name;
  item.dataset.cwd = entry.cwd || '';
  item.dataset.type = entry.type;
  if (entry.backend) item.dataset.backend = entry.backend;
  if (entry.team) item.dataset.team = entry.team; // group-by-project team key
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

  item.addEventListener('click', async (e) => {
    if (e.target.closest('.session-close')) return;
    await window.api.unarchiveSession(entry.name);
    const res = await window.api.retrySpawnSession(entry.name);
    if (!res || !res.ok) { alert(`Resume failed: ${(res && res.error) || 'unknown error'}`); return; }
    item.remove();
    sidebarMeta.delete(entry.name);
    createTerminal(entry.name);
    addSessionToSidebar(entry.name, entry.type, entry.cwd, entry.label, entry.backend || null, entry.team || null, entry.noWire === true);
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
    team: item.dataset.team || null, // carry the group-by-project key onto the archived row
    archivedAt: Date.now(),
    createdAt: meta.createdAt || null,
  });
  const res = await window.api.archiveSession(name);
  if (!res || !res.ok) {
    archivingSessions.delete(name);
    showToast(`Archive failed: ${(res && res.error) || 'unknown error'}`, { kind: 'error', duration: 10000, name });
  }
}

async function deleteSessionRow(name) {
  if (!(await window.api.confirmKill(name))) return;
  const res = await window.api.killSession(name);
  if (res && res.error) {
    showToast(`Worktree removal failed: ${res.error}`, { kind: 'warn', duration: 12000, name });
  }
}

function addSessionToSidebar(name, type, cwd, label, backend = null, team = null, noWire = false) {
  const item = document.createElement('div');
  item.className = 'session-item';
  item.dataset.name = name;
  item.dataset.cwd = cwd || '';
  item.dataset.type = type;
  if (backend) item.dataset.backend = backend;
  if (team) item.dataset.team = team;
  // Wire-off seats lose warmth, wire telemetry and protocol-accurate activity, so
  // the row must say so without opening settings — those badges simply never
  // populate, which is indistinguishable from an idle session otherwise. (Touched
  // files are NOT lost: the JsonlWatcher feeds the same sink. What goes is
  // subagent attribution on the edits.)
  if (noWire) item.dataset.noWire = '1';
  const displayName = label || name;
  const cwdLabel = cwd ? esc(baseName(cwd)) : '';
  item.innerHTML = `
    <span class="session-chip" data-type="${esc(type)}"${backend ? ` data-backend="${esc(backend)}"` : ''}>${typeGlyph(type, backend)}</span>
    <div class="session-info">
      <div class="session-name">${esc(displayName)}</div>
      <div class="session-meta">
        ${cwdLabel ? `<span class="session-cwd">${cwdLabel}</span>` : ''}
        <span class="session-badges">
          ${noWire ? '<span class="session-nowire" data-tip="Wire off — no ANTHROPIC_BASE_URL: no tee, no warmth/wire telemetry. Intents and touched files still work; subagent attribution does not.">⊘</span>' : ''}
          ${type === 'claude' ? '<span class="session-pending" data-tip="Parked messages waiting — click to deliver now"></span>' : ''}
          <span class="session-think"></span>
          <span class="session-warm"></span>
          <span class="session-ctx"></span>
        </span>
      </div>
    </div>
    <button class="session-info-btn" data-tip="Session info — cost, compactions, activity">i</button>
    <button class="session-close" data-tip="Archive session">&times;</button>
  `;

  item.addEventListener('click', (e) => {
    if (e.target.closest('.session-close')) return;
    if (e.target.closest('.session-info-btn')) return;
    if (e.target.closest('.rename-input')) return;
    switchSession(name);
  });

  item.querySelector('.session-info-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openSessionInfoPopover(name, item);
  });

  item.querySelector('.session-close').addEventListener('click', (e) => {
    e.stopPropagation();
    archiveSessionRow(name);
  });

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

  const nameEl = item.querySelector('.session-name');
  nameEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(item, nameEl, name);
  });

  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.api.showSessionContextMenu(name, cwd || '');
  });

  insertLocalSessionRow(item);
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
  const snapTeam = item ? item.dataset.team || null : null; // cwd is unchanged by a restart → team persists
  const snapNoWire = item ? item.dataset.noWire === '1' : false; // spawn-time config, unchanged by a restart
  return window.api.restartSession(name).then((res) => {
    if (!res || !res.ok) {
      alert(`Restart failed: ${res && res.error ? res.error : 'unknown error'}`);
      return;
    }
    if (snapType) {
      createTerminal(name);
      addSessionToSidebar(name, snapType, snapCwd, null, res.backend ?? snapBackend, snapTeam, snapNoWire);
      switchSession(name);
    }
  });
}

window.api.onSessionContextAction(({ action, name, type, cwd, backend, noWire, disposition, background }) => {
  switch (action) {
    case 'editArgs':
      openArgsDialog(name);
      break;
    case 'restart':
      restartSessionWithReattach(name);
      break;
    case 'reattach':
      if (type) {
        createTerminal(name);
        addSessionToSidebar(name, type, cwd, null, backend || null, null, noWire === true);
        // `background` marks the agent-initiated emitters (ticket seat, spawn
        // intent, reviewer). The reload respawn sends no flag and keeps focus.
        switchToNewSession(name, { agentInitiated: background === true });
      }
      break;
    case 'promptsChanged':
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
    case 'retired': {
      // Main-side team-retire. disposition 'discard' (ephemeral seat): main already dropped
      // the record, so do NOT stash — onSessionExit removes the row like a delete. 'archive'
      // (or an older core omitting the field): this signal arrives BEFORE the exit, so stash
      // the row identity like archiveSessionRow (minus the API call) and onSessionExit rebuilds it.
      if (disposition === 'discard') break;
      const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
      if (!item) break;
      const nameEl = item.querySelector('.session-name');
      const displayed = nameEl ? nameEl.textContent : name;
      const meta = sidebarMeta.get(name) || {};
      archivingSessions.set(name, {
        name,
        type: item.dataset.type,
        cwd: item.dataset.cwd || '',
        label: displayed && displayed !== name ? displayed : null,
        backend: item.dataset.backend || null,
        team: item.dataset.team || null, // carry the group-by-project key onto the archived row
        archivedAt: Date.now(),
        createdAt: meta.createdAt || null,
      });
      break;
    }
    case 'export':
      window.api.exportSessionMarkdown(name).then((res) => {
        if (!res.ok && res.error !== 'cancelled') {
          console.error('Export failed:', res.error);
        }
      });
      break;
    case 'exportTemplate': {
      promptText(`Export "${name}" as a template`, name).then((tn) => {
        if (!tn) return;
        tn = tn.trim();
        if (!/^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/.test(tn)) {
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
  sessionList.querySelectorAll(`.session-child[data-parent="${CSS.escape(name)}"]`).forEach((c) => c.remove());
  // The parent is gone, so its feeds can never update again — this is what
  // bounds the drawer's retained history against a long-lived window.
  dropActivityFeeds(name);
  sidebarMeta.delete(name);
  if (typeof refreshSidebarView === 'function') refreshSidebarView();
}

function updateSidebarActive() {
  for (const el of sessionList.querySelectorAll('.session-item')) {
    el.classList.toggle('active', el.dataset.name === activeSession);
  }
}


let sidebarView = { group: 'none', sort: 'recency', status: 'all', activity: 'all', search: '' };
const sidebarMeta = new Map();
const collapsedGroups = new Set(); // group keys the user collapsed

const sbSearch = document.getElementById('sidebar-search');
const sbGroup = document.getElementById('sidebar-group');
const sbSort = document.getElementById('sidebar-sort');
const sbStatus = document.getElementById('sidebar-status');
const sbActivity = document.getElementById('sidebar-activity');

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

const TEAM_GROUP_PREFIX = '▸ ';

function groupFor(item) {
  const meta = sidebarMeta.get(item.dataset.name) || {};
  switch (sidebarView.group) {
    case 'project': {
      const team = item.dataset.team || meta.team;
      return team ? `${TEAM_GROUP_PREFIX}${team}` : projectLabel(item.dataset.cwd);
    }
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

function rowPasses(item) {
  const meta = sidebarMeta.get(item.dataset.name) || {};
  const archived = item.classList.contains('archived');
  if (sidebarView.status === 'active' && archived) return false;
  if (sidebarView.status === 'archived' && !archived) return false;
  if (sidebarView.activity !== 'all' && !archived) {
    const ts = meta.lastActivityTs || meta.createdAt;
    const maxMs = Number(sidebarView.activity) * 86400000;
    if (!ts || (Date.now() - ts) > maxMs) return false;
  }
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

function refreshSidebarView() {
  const firstPeer = sessionList.querySelector('[data-peer-ui]');
  const rows = [...sessionList.querySelectorAll('.session-item')].filter(
    (el) => !el.dataset.peerUi && !el.classList.contains('peer-item') && !el.classList.contains('session-child'));
  sessionList.querySelectorAll('.session-group-header, .session-empty-note').forEach((el) => el.remove());

  for (const el of rows) {
    applyPrBadge(el);
    pluginBar.applyRowBadges(el); // no-op while no plugin registers a rowBadge
    const pass = rowPasses(el);
    el.style.display = pass ? '' : 'none';
    sessionList.querySelectorAll(`.session-child[data-parent="${CSS.escape(el.dataset.name)}"]`)
      .forEach((c) => { c.style.display = pass ? '' : 'none'; });
  }
  const visible = rows.filter((el) => el.style.display !== 'none');

  const childrenOf = (name) =>
    [...sessionList.querySelectorAll(`.session-child[data-parent="${CSS.escape(name)}"]`)];

  const place = (el, anchor) => {
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
  chip.setAttribute('data-tip', `PR ${state}${meta.branch ? ` · ${meta.branch}` : ''}`);
}

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
  if (key.startsWith(TEAM_GROUP_PREFIX)) {
    h.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openTeamRolesPopover(key.slice(TEAM_GROUP_PREFIX.length), h);
    });
  }
  return h;
}

let metaRefreshInFlight = false;
async function refreshSidebarMeta({ includePr = true } = {}) {
  if (metaRefreshInFlight) return;
  metaRefreshInFlight = true;
  try {
    const res = await window.api.sidebarMeta({ includePr });
    if (res && res.ok && res.meta) {
      for (const [name, m] of Object.entries(res.meta)) {
        sidebarMeta.set(name, mergeMeta(sidebarMeta.get(name), m));
      }
    }
  } catch {} finally { metaRefreshInFlight = false; }
  refreshSidebarView();
}

function onViewControlChange() {
  sidebarView = {
    group: sbGroup.value, sort: sbSort.value,
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

async function initSidebarView() {
  try {
    const res = await window.api.getSidebarView();
    if (res && res.ok && res.view) {
      const v = { ...res.view };
      // One-time migration: normalize a persisted 'active' status to 'all'. The
      // statusMigrated marker makes it fire ONCE per workspace, so a deliberate
      // later Active choice survives.
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
  setInterval(() => refreshSidebarMeta({ includePr: false }), 30000);
}

function webAttentionCount() {
  return sessionList.querySelectorAll('.session-item[data-attention]').length;
}

function updateWindowTitle() {
  const n = sessions.size;
  const base = n === 0 ? 'Clodex'
    : n === 1 ? 'Clodex (1 session)'
    : `Clodex (${n} sessions)`;
  document.title = window.__CLODEX_WEB__ ? badgeTitle(base, webAttentionCount()) : base;
}


// Pull a filesystem path out of an OSC 8 URI. Returns null for anything that
// isn't file://, so http links keep flowing to the browser.
function filePathFromUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  try { return decodeURIComponent(new URL(uri).pathname) || null; } catch { return null; }
}

function createTerminal(name, peer = null) {
  const terminal = new Terminal({
    fontSize: 13,
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
    theme: currentXtermTheme(),
    cursorBlink: true,
    allowProposedApi: true,
    // OSC 8 hyperlinks, when a CLI emits them: the URI carries an ALREADY
    // ABSOLUTE path even where the display text is shortened, so it needs no
    // resolution and is strictly better than the text scan below. Kept as the
    // preferred route even though the Claude CLI is not currently observed to
    // reach it — a CLI that does emit them gets exact paths for free.
    linkHandler: {
      activate: (event, text) => {
        const p = filePathFromUri(text);
        if (!p) return;
        openFilePeek(name, p, 'file');
      },
    },
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  // Make http/https URLs in terminal output clickable → system browser (Task
  // 16 / GH#6). Custom handler (not the addon's default window.open, which this
  // nodeIntegration renderer must never expose) gated by the shared scheme
  // filter; the addon still underlines/hovers only what it recognizes as a URL.
  const webLinksAddon = new WebLinksAddon((event, uri) => {
    if (isExternallyOpenable(uri)) window.api.openExternal(uri);
  });
  terminal.loadAddon(webLinksAddon);

  // Click a `path:line` in the terminal → peek that file at that line, plus the
  // line numbers in an edit tool's gutter, which name a line but not a file (the
  // file is in the `Update(...)` header above — gutter-scan.js walks up to it).
  // The CLI is never told about the click: xterm owns the rendered buffer here,
  // so the hit-test and the text are entirely local.
  //
  // Text-shaped, NOT OSC 8 — the CLI's hyperlinks do not survive to us, so a
  // scan of the buffer line is what there is. It is therefore SPECULATIVE: a
  // token that looks like a path underlines whether or not it names a file, and
  // the resolve on activate is what decides. Statting during provideLinks would
  // mean sync fs on every hover of every line.
  //
  // xterm ranges are 1-BASED and INCLUSIVE at both ends; scanPaths returns
  // 0-based half-open offsets. Both conversions below are that difference.
  // Read a logical line as text. A row xterm WRAPPED is a continuation of the
  // row above it, not a line of its own — walking rows naively would read the
  // tail of a wrapped edit as a fresh line and find gutter numbers mid-sentence.
  const rowText = (row) => {
    const l = terminal.buffer.active.getLine(row);
    return l ? l.translateToString(true) : null;
  };
  const isWrapped = (row) => {
    const l = terminal.buffer.active.getLine(row);
    return !!(l && l.isWrapped);
  };

  terminal.registerLinkProvider({
    provideLinks: (y, cb) => {
      const line = terminal.buffer.active.getLine(y - 1);
      if (!line) return cb(undefined);
      const raw = line.translateToString(true);
      const hits = scanPaths(raw);

      // A gutter number, linked to the file its tool-call header names. Only on
      // an unwrapped row: a continuation row's leading digits are content.
      // Appended to the path hits rather than replacing them — a gutter row can
      // also CONTAIN a path, and both should stay clickable.
      const g = !line.isWrapped ? matchGutterRow(raw) : null;
      if (g) {
        const above = [];
        for (let r = y - 2; r >= 0 && above.length < GUTTER_HEADER_SCAN; r -= 1) {
          if (isWrapped(r)) continue; // a wrapped tail belongs to the row above it
          const t = rowText(r);
          if (t == null) break;
          above.push(t);
        }
        const owner = findGutterFile(above);
        if (owner) {
          hits.push({
            start: g.start, end: g.end, text: String(g.line),
            path: owner.path, line: g.line,
          });
        }
      }

      if (!hits.length) return cb(undefined);
      cb(hits.map((h) => ({
        range: { start: { x: h.start + 1, y }, end: { x: h.end, y } },
        text: h.text,
        activate: async () => {
          const res = await window.api.fileResolve(name, h.path, null)
            .catch((e) => ({ ok: false, error: String(e) }));
          if (!res || !res.ok) {
            // The link is speculative (scanned, never statted), so a miss is an
            // ordinary outcome — but a SILENT one is indistinguishable from a
            // broken click, which reads as the feature not working at all.
            showToast((res && res.error) || `Can't find "${h.path}"`, { kind: 'warn', duration: 4000 });
            return;
          }
          openFilePeek(name, res.path, 'file', h.line);
        },
      })));
    },
  });

  const intentHighlight = createIntentHighlight(terminal);

  // Local Claude seats only: a peer's composer is on the other machine, and the
  // erase-then-Enter shape is verified against the Claude CLI's input box alone
  // — in a bash seat Enter RUNS the line rather than sending a message, so the
  // consequence of a false fire is not the same and the widening needs its own
  // decision. The type is resolved at FIRE time rather than here: the sidebar
  // row this reads may not exist yet while the terminal is being built.
  const voiceSubmit = peer ? null : createVoiceSubmitWatcher(terminal, {
    // Gated on the ACTIVE session, not merely a live one. Dictation only ever
    // reaches the focused composer, so a background seat's watcher can never
    // help and can only misfire — and an agent seat parked at its own composer
    // with injected text is exactly the shape the prompt check accepts.
    getConfig: () => (voiceSubmitConfig.enabled
      && name === activeSession
      && sessionTypeOf(name) === 'claude'
      ? voiceSubmitConfig : null),
    getAttention: () => {
      const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
      // A row that is GONE is not a row without a dialog. Reporting 'permission'
      // makes the missing-row case decline, matching the throw path in the
      // watcher — the interlock's failures all have to land on the safe side.
      return el ? (el.dataset.attention || null) : 'permission';
    },
    write: (data) => window.api.writeToSession(name, data),
    // Both read through voiceCore, which already polls the CLI's config for the
    // bar button — a second reader here would be a second copy of a box-wide
    // value, which voice-control.js's header rules out.
    // The FILE-backed mode, not snapshot().mode: that one prefers a PENDING
    // pick, so a queued `/voice tap` the CLI has not run yet would make the
    // re-arm act as though tap were already live.
    getVoiceMode: () => {
      const { state } = voiceCore.snapshot();
      return (state && state.effective) || null;
    },
    getTriggerKey: () => resolveTriggerKey(voiceCore.triggerBinding()),
    // A `send`, so this returns immediately and the erase/Enter that follow it
    // are never waiting on the proxy.
    markVoiceOrigin: () => window.api.markVoiceOrigin(name),
    unmarkVoiceOrigin: () => window.api.unmarkVoiceOrigin(name),
    // Deliberately NOT gated on voiceSubmitConfig.enabled, which getConfig above
    // requires: he dictates into claude seats whether or not hands-free submit
    // is switched on, and the quiet-gate protection is owed to him either way.
    // Still the ACTIVE seat only — dictation reaches the focused composer, so a
    // background seat's indicator is not him speaking into it.
    recorderScope: () => name === activeSession && sessionTypeOf(name) === 'claude',
    // Box-wide and read fresh per attempt, never captured: the flag flips
    // mid-wait, which is the entire point of the deferral.
    getSpeakerBusy: () => speakerBusy,
    // Does THIS seat hold the microphone? Compared against main's box-wide
    // name, never against `activeSession`, which is this window's own answer
    // and true of one seat in every window that is open.
    isMicTarget: () => micTargetMirror.read() === name,
    // Is Clodex frontmost? Read fresh per attempt and never captured, for the
    // same reason as the speaker flag: he alt-tabs away DURING the settle
    // window, and that is the case this exists to catch.
    isAppFocused: () => appFocusedMirror.read(),
    noteVoiceRecording: () => window.api.noteVoiceRecording(name),
    noteVoiceDraft: () => window.api.noteVoiceDraft(name),
  });

  const searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);
  searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
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

  // onData ALSO fires for mouse/scroll reports and terminal query replies (the Claude pane
  // enables mouse tracking), so typeToTakeControl gates on isHumanPtyInput.
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
    // Typing is evidence the draft was NOT dictated, and this is the only place
    // that sees it: the recording indicator can be lit through an ordinary typed
    // turn (t571's re-arm writes the trigger character at every turn end), so
    // without this the operator's exact typed words submit marked as spoken.
    if (voiceSubmit) voiceSubmit.noteInput(data);
    window.api.writeToSession(name, data);
  });

  sessions.set(name, { terminal, fitAddon, searchAddon, intentHighlight, voiceSubmit, wrapperEl, peer });
  updateWindowTitle();
  return { terminal, fitAddon, searchAddon, wrapperEl };
}

// Electron 32+ removed File.path, so host paths resolve via webUtils.getPathForFile —
// desktop-only (window.require is undefined in the web bundle). The document-level
// preventDefault is required: a drop that misses this handler navigates to file://.
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
    showToast(`"${activeSession}" runs on a peer — its filesystem doesn’t have this file.`, { kind: 'peer-ui' });
    return;
  }
  const { webUtils } = window.require('electron');
  const style = sessionTypeOf(activeSession) === 'claude' ? 'claude' : 'shell';
  const text = dropText(files.map((f) => {
    try { return webUtils.getPathForFile(f); } catch { return null; }
  }), style);
  if (!text) return;
  window.api.writeToSession(activeSession, text);
  entry.terminal.focus();
});

// Read-only peer re-measure: xterm holds stale char metrics when its pane was
// visibility:hidden, so fit() forces a re-measure, then resize back to the owner's
// canonical letterbox. INVARIANT: pushes nothing upstream — read-only tabs have no
// onResize→peerResize wiring, so the fit()'s dims never leave the viewer.
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

  if (isSearchOpen()) closeSearch();
  // No subagent teardown here on purpose: the Activity feed survives a session
  // switch. The popover this replaced had to close (it was anchored to a row);
  // surviving the switch is the drawer's whole point.

  const wasActive = activeSession;
  activeSession = name;
  reportFocusedSession();
  // An armed drawer selection is registered on ONE session's wirescope route, so
  // leaving that session has to take it back — the drawer cannot see this
  // switch, and a peek left behind rides a request the operator is no longer
  // watching. Not on first activation (nothing was armed yet).
  if (wasActive && wasActive !== name) drawerHost.onSessionChanged();
  // Unconditional: the FIRST activation takes the branch above's else, and the
  // seat it lands on may be one the terminal cannot serve. Idempotent, so the
  // switch path calling both is a repeated read and nothing more.
  else drawerHost.syncSeatAvailability();

  // Toggle visibility — use visibility so xterm can still measure
  for (const [n, s] of sessions) {
    s.wrapperEl.classList.toggle('visible', n === name);
  }

  updateSidebarActive();
  emptyState.style.display = 'none';

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

  const entry = sessions.get(name);
  const { fitAddon, terminal } = entry;
  requestAnimationFrame(() => {
    if (entry.peer) {
      if (entry.peer.controlled) {
        fitAddon.fit();
        window.api.peerResize(entry.peer.id, entry.peer.name, terminal.cols, terminal.rows);
      } else {
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

// The activation step for a session that has just been CREATED — never for a
// switch the operator asked for, which is always honoured.
//
// Not focusing still leaves the sidebar row, so a background seat is visible
// and one click away; the only thing withheld is the keyboard.
async function switchToNewSession(name, { agentInitiated = false } = {}) {
  const { focus } = await planNewSession({
    name, focused: activeSession, agentInitiated,
    queryDraftOpen: window.api.draftOpen ? (n) => window.api.draftOpen(n) : null,
  });
  // Re-checked because the query above yields: the new session may have died
  // between the decision and here.
  if (!sessions.has(name)) return false;
  if (focus) { switchSession(name); return true; }
  // Measured but not focused. switchSession does this as part of activating,
  // so a background seat would otherwise sit at xterm's 80x24 default against
  // a 120x30 PTY and wrap every line wrong until first clicked.
  fitSessionInBackground(name);
  return false;
}

// The measurement half of switchSession's rAF, without the activation. Safe on
// a hidden wrapper: `.terminal-wrapper` hides with `visibility`, which keeps
// its layout box, and that is exactly why `display:none` must never be used.
function fitSessionInBackground(name) {
  const entry = sessions.get(name);
  if (!entry) return;
  const { fitAddon, terminal } = entry;
  requestAnimationFrame(() => {
    // The session can die inside the frame; a disposed terminal throws here.
    if (!sessions.has(name)) return;
    try {
      if (entry.peer) {
        if (entry.peer.controlled) {
          fitAddon.fit();
          window.api.peerResize(entry.peer.id, entry.peer.name, terminal.cols, terminal.rows);
        } else {
          remeasureReadonlyPeer(entry);
        }
        return;
      }
      fitAddon.fit();
      window.api.resizeSession(name, terminal.cols, terminal.rows);
    } catch {}
  });
}

function removeSession(name, { keepPersisted = false } = {}) {
  const s = sessions.get(name);
  if (s) {
    if (s.peer) {
      if (!keepPersisted) window.api.peerDetach(s.peer.id, s.peer.name);
      forgetControlMirror(s.peer.id, s.peer.name);
    }
    // Before the terminal: its decorations hold markers that the terminal owns,
    // and disposing them afterwards throws on the marker lookup.
    if (s.intentHighlight) s.intentHighlight.dispose();
    if (s.voiceSubmit) s.voiceSubmit.dispose();
    s.terminal.dispose();
    s.wrapperEl.remove();
    sessions.delete(name);
  }
  drawerHost.forgetSession(name);
  removeSessionFromSidebar(name);
  updateWindowTitle();
  proxyState.delete(name);
  // The removed session may have been the freshest quota carrier — without this
  // the readout keeps showing a figure sourced from a payload nothing holds.
  refreshQuotaChip();
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
      // Main's record has to go too, or an external voice tap keeps aiming at
      // the seat that just went away.
      reportFocusedSession();
      emptyState.style.display = '';
      renderProxyBar();
    }
  }
}


let sessionCounter = 0;

// skipAsyncRefresh: when a template is being applied, the caller re-renders the
// skill/inject/tool checklists itself with the template's captured sets — so
// suppress the default (empty-set) async renders here to avoid a last-write-wins
// race between the two. Also skips resetting extraArgs (the template supplies it).
function applyTypeDefaults({ skipAsyncRefresh = false } = {}) {
  const type = inputType.value;
  if (!skipAsyncRefresh) inputArgs.value = DEFAULT_ARGS[type] || '';
  argsHint.textContent = ARGS_HINTS[type] || '';
  const authoring = dialogMode === 'template';
  const supportsSystemPrompt = type === 'claude' || type === 'codex';
  if (modelRow) modelRow.style.display = supportsSystemPrompt ? '' : 'none';
  if (!skipAsyncRefresh) inputModel.value = '';
  systemPromptRow.style.display = supportsSystemPrompt ? '' : 'none';
  if (appendPromptsRow) appendPromptsRow.style.display = supportsSystemPrompt ? '' : 'none';
  if (!supportsSystemPrompt) inputSystemPrompt.value = '';
  const claudeOnly = type === 'claude';
  for (const sec of [toolsSection, skillsSection, otherSection]) {
    if (sec) sec.style.display = claudeOnly ? '' : 'none';
  }
  if (claudeOnly && !skipAsyncRefresh) { refreshNewSessionSkills(); refreshNewSessionInjectSkills(); refreshNewSessionExecCommands(); refreshNewSessionIntents(); refreshNewSessionTools(); }
  const agentType = type === 'claude' || type === 'codex';
  resumeRow.style.display = (agentType && !authoring) ? '' : 'none';
  if (!agentType) {
    inputResume.value = '';
    inputFork.checked = false;
  }
  proxyRow.style.display = agentType ? '' : 'none';
  if (!agentType) {
    inputProxyMode.value = '';
    inputProxyUrl.style.display = 'none';
  }
  if (currentPlacement() !== 'host') applySandboxState();
  if (worktreeRow) {
    worktreeRow.style.display = 'none';
    if (inputWorktree) inputWorktree.checked = false;
    if (worktreeFields) worktreeFields.style.display = 'none';
    if (!authoring) refreshWorktreeForCwd();
  }
  if (teamRow) {
    teamRow.style.display = 'none';
    if (teamToggle) teamToggle.checked = false;
    if (teamFields) teamFields.style.display = 'none';
    lastTeamAutoName = null;
    if (!authoring) refreshTeamForCwd();
  }
}

let lastToolCheck = null;
const newSessionToolNotice = document.getElementById('new-session-tool-notice');

let overlayDismissed = false;
const toolOverlay = document.getElementById('new-session-tool-overlay');
const toolOverlayHeadline = document.getElementById('tool-overlay-headline');
const toolOverlayRemedy = document.getElementById('tool-overlay-remedy');
const toolOverlayActions = document.getElementById('tool-overlay-actions');
const toolOverlayDismiss = document.getElementById('tool-overlay-dismiss');

function applyNewSessionToolOverlay(plan) {
  if (!toolOverlay) return;
  if (!shouldRaiseOverlay(plan, overlayDismissed)) {
    toolOverlay.classList.add('hidden');
    return;
  }
  toolOverlayHeadline.textContent = plan.headline;
  toolOverlayRemedy.textContent = plan.tools.length > 1
    ? 'Install one below to start agent sessions. Clodex runs the official installer in a visible terminal so you can watch it and answer any prompt.'
    : `Clodex will run the official ${plan.tools[0].tool} installer in a visible terminal — watch it and answer any prompt it raises.`;
  toolOverlayActions.textContent = '';
  for (const entry of plan.tools) {
    if (!entry.install) continue;
    const col = document.createElement('div');
    col.className = 'tool-overlay-tool';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tool-install-btn';
    btn.textContent = entry.install.label;
    btn.title = `Run: ${entry.install.command}`;
    btn.addEventListener('click', () => openInstallSession(entry.install));
    col.appendChild(btn);
    const cmd = document.createElement('code');
    cmd.className = 'tool-overlay-cmd';
    cmd.textContent = entry.install.command;
    col.appendChild(cmd);
    toolOverlayActions.appendChild(col);
  }
  toolOverlay.classList.remove('hidden');
}

if (toolOverlayDismiss) {
  toolOverlayDismiss.addEventListener('click', () => {
    overlayDismissed = true;
    if (toolOverlay) toolOverlay.classList.add('hidden');
  });
}

function applyNewSessionToolGate(gate) {
  if (!newSessionToolNotice) return;
  if (gate.disabled) {
    renderSandboxNotice(newSessionToolNotice, gate.notice);
    if (gate.install) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool-install-btn';
      btn.textContent = gate.install.label;
      btn.title = `Run: ${gate.install.command}`;
      btn.addEventListener('click', () => openInstallSession(gate.install));
      newSessionToolNotice.appendChild(btn);
    }
    newSessionToolNotice.classList.remove('hidden');
    btnCreate.disabled = true;
    btnCreate.title = gate.notice ? gate.notice.text : '';
  } else {
    newSessionToolNotice.classList.add('hidden');
    btnCreate.disabled = false;
    btnCreate.title = '';
  }
}

async function openInstallSession(install) {
  const params = installSessionParams(install, homeDir);
  if (!params) return;
  closeDialog();
  if (sessions.has(params.name)) { switchSession(params.name); return; }
  const result = await window.api.createSession(
    params.name, params.type, params.cwd, [], null, null, false, null,
    [], [], [], [], [], undefined, null, [], [], null,
  );
  if (!result || !result.ok) {
    alert(`Couldn't start the installer: ${(result && result.error) || 'unknown error'}`);
    return;
  }
  createTerminal(params.name);
  addSessionToSidebar(params.name, params.type, params.cwd, null,
    (result.session && result.session.backend) || null, null);
  // Manual like the dialog's create, and subject to the same draft veto — the
  // rule is about what the operator is typing, not about who spawned what.
  await switchToNewSession(params.name, { agentInitiated: false });
  // Run the install line via the inject-queue (quiet-gate + atomic Ctrl-U/Enter),
  // the same path operator app-panel messages take — a bash PTY is ready almost
  // immediately, but going through the queue keeps the write atomic and gated.
  window.api.injectPrompt(params.name, params.command);
}

async function refreshNewSessionToolGate() {
  const typeAtCall = dialogMode === 'template' ? 'bash' : inputType.value;
  applyNewSessionToolGate(newSessionToolGate(typeAtCall, lastToolCheck));
  applyNewSessionToolOverlay(newSessionOverlayPlan(typeAtCall, lastToolCheck));
  let check = null;
  try { check = await window.api.toolsCheck(); } catch { check = null; }
  lastToolCheck = check;
  const typeNow = dialogMode === 'template' ? 'bash' : inputType.value;
  applyNewSessionToolGate(newSessionToolGate(typeNow, check));
  applyNewSessionToolOverlay(newSessionOverlayPlan(typeNow, check));
}

function greyRichFields(grey, hintText = null) {
  for (const id of PLACEMENT_RICH_ROW_IDS) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('placement-greyed', grey);
  }
  if (grey && hintText) placementHint.textContent = hintText;
  placementHint.style.display = grey ? '' : 'none';
}

function currentPlacement() {
  return placementRow.style.display !== 'none' ? (inputPlacement.value || 'host') : 'host';
}

function boxHasCreate2(boxId) {
  const st = peerStatuses.get(boxId);
  return !!(st && st.online && Array.isArray(st.caps) && st.caps.includes('create2'));
}

function boxPeerOnline(boxId) {
  const st = peerStatuses.get(boxId);
  return !!(st && st.online);
}

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

async function applyPlacement() {
  const placement = currentPlacement();
  inputCwd.value = placementNextCwd(placement, inputCwd.value.trim(), homeDir);
  refreshTeamForCwd();
  if (placement !== 'host') { await applySandboxState(); return; }
  greyRichFields(false);
  await restoreHostCatalogs();
}

async function applySandboxState() {
  const placement = currentPlacement();
  if (placement === 'host') { greyRichFields(false); return; }
  let dockerDetect = null;
  try { dockerDetect = await window.api.sandboxDetect(placement); } catch { dockerDetect = null; }
  if (currentPlacement() !== placement) return;   // user flipped during the probe
  const dockerGate = sandboxActionGate(dockerDetect);
  if (!dockerGate.running) { greyRichFields(true, dockerGate.reason); return; }
  if (!boxPeerOnline(placement)) { greyRichFields(true, PLACEMENT_HINT_BOX_OFFLINE); return; }
  if (richFieldsGreyed(placement, boxHasCreate2(placement))) {
    greyRichFields(true, PLACEMENT_HINT_OLD_BOX);
    return;
  }
  const token = ++placementCatalogToken;
  let res;
  try { res = await window.api.peerCatalogs(placement); }
  catch { res = null; }
  if (token !== placementCatalogToken || currentPlacement() !== placement) return;
  if (!res || res.ok === false || !res.catalogs) {
    greyRichFields(true, PLACEMENT_HINT_CATALOGS_UNAVAILABLE);
    return;
  }
  populateChecklistsFromCatalogs(res.catalogs);
  greyRichFields(false);
}

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
  refreshNewSessionIntents();       // served by the LOCAL engine, box-independent (as the static catalog was)
  setPromptLibCache({
    system: (cat.prompts || []).filter((p) => p.kind === 'system'),
    append: (cat.prompts || []).filter((p) => p.kind === 'append'),
  });
  fillSystemPromptSelect(inputSystemPrompt, '');
  renderAppendChecklist(inputAppendList, new Set());
  setProxyControls(inputProxyMode, inputProxyUrl, null, cat.proxyUrl);
}

async function restoreHostCatalogs() {
  populateHostCatalogs(dialogHostSettings, dialogHostAgentLib);
  // The prompt-lib cache holds box truth too after a Sandbox stint —
  // populateHostCatalogs doesn't cover it (openDialog loads prompts through the
  // separate refreshSystemPromptDropdown), so reload the Mac's library here or the
  // dropdown/append checklist keep showing the box's prompts labeled as host's.
  // A selected box-only prompt ref falls back to (CLI default), gracefully.
  await refreshSystemPromptDropdown();
  // The skill-lib cache has the identical exposure and is NOT gracefully
  // degrading: populateChecklistsFromCatalogs seeds it from the box, and a
  // ticked box-only skill is skipped at spawn without a word, so the operator
  // is told nothing. refreshNewSessionSkills does not cover this one — that
  // renders the per-cwd availability list, a different cache from the inject
  // library.
  await refreshNewSessionInjectSkills();
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
  selectEl.value = current && getPromptLibCache().system.some(p => p.name === current) ? current : '';
}

async function refreshSystemPromptDropdown() {
  await loadPromptLib();
  fillSystemPromptSelect(inputSystemPrompt, inputSystemPrompt.value);
  renderAppendChecklist(inputAppendList, new Set());
}

async function refreshTemplatesDropdown() {
  const list = await window.api.listTemplates();
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

const agentsRow = document.getElementById('agents-row');
const inputAgentsList = document.getElementById('input-agents-list');
const inputBuiltinsList = document.getElementById('input-builtins-list');
const inputExecList = document.getElementById('input-exec-list');
const inputIntentList = document.getElementById('input-intent-list');

const toolsRow = document.getElementById('tools-row');
const inputToolsList = document.getElementById('input-tools-list');
const skillsRow = document.getElementById('skills-row');
const inputSkillsList = document.getElementById('input-skills-list');
wireBulkToggles(toolsRow, inputToolsList);
wireBulkToggles(skillsRow, inputSkillsList);
const injectSkillsRow = document.getElementById('inject-skills-row');
const inputInjectSkillsList = document.getElementById('input-inject-skills-list');
const stripRow = document.getElementById('strip-row');
const inputStripLevel = document.getElementById('input-strip-level');
const inputAutoCompact = document.getElementById('input-auto-compact');
const inputNoWire = document.getElementById('input-no-wire');
const toolsSection = document.getElementById('tools-section');
const skillsSection = document.getElementById('skills-section');
const otherSection = document.getElementById('other-section');
const envSection = document.getElementById('env-section');

async function refreshNewSessionInjectSkills(enabledSet = new Set()) {
  if (inputType.value !== 'claude') return;
  setSkillLibCache((await window.api.listSkillLib()) || []);
  renderInjectChecklist(inputInjectSkillsList, enabledSet);
}

async function refreshNewSessionExecCommands(enabledSet = new Set()) {
  if (inputType.value !== 'claude') return;
  setExecLibCache((await window.api.listExecCommands()) || []);
  renderExecChecklist(inputExecList, enabledSet);
}

async function refreshNewSessionIntents(intentsList) {
  if (inputType.value !== 'claude') return;
  setIntentCatalogCache((await window.api.getIntentCatalog()) || []);
  renderIntentChecklist(inputIntentList, intentsList);
}

async function refreshNewSessionSkills(disabledSet = new Set()) {
  if (inputType.value !== 'claude') return;
  const cwd = expandPath(inputCwd.value.trim()) || homeDir;
  const res = await window.api.getSkillCatalogFor(cwd);
  if (!res || !res.ok) { renderSkillChecklist(inputSkillsList, [], disabledSet); return; }
  renderSkillChecklist(inputSkillsList, res.names || [], disabledSet,
    res.effective || {}, { skillsLocked: res.skillsLocked, canReenable: res.canReenable });
}
async function refreshNewSessionTools(disabledSet = null) {
  if (inputType.value !== 'claude') return;
  const cwd = expandPath(inputCwd.value.trim()) || homeDir;
  const res = await window.api.getToolCatalogFor(cwd);
  const disabled = disabledSet || new Set(getDefaultToolDenyCache());
  renderToolChecklist(inputToolsList, disabled, (res && res.ok && res.effective) || {});
}

if (inputWorktree) {
  inputWorktree.addEventListener('change', () => {
    worktreeFields.style.display = inputWorktree.checked ? '' : 'none';
    if (inputWorktree.checked) inputWorktreeBranch.focus();
  });
}

let worktreeInfoToken = 0;
async function refreshWorktreeForCwd() {
  if (!worktreeRow) return;
  const authoring = dialogMode === 'template';
  const cwd = expandPath(inputCwd.value.trim()) || homeDir;
  const token = ++worktreeInfoToken;
  const info = await window.api.worktreeInfo(cwd);
  if (token !== worktreeInfoToken) return; // a newer cwd won the race
  const isRepo = info && info.ok && info.isRepo;
  worktreeRow.style.display = (isRepo && !authoring) ? '' : 'none';
  if (!isRepo || authoring) {
    if (inputWorktree) inputWorktree.checked = false;
    if (worktreeFields) worktreeFields.style.display = 'none';
    return;
  }
  worktreeBaseList.textContent = '';
  for (const b of (info.branches || [])) {
    const opt = document.createElement('option');
    opt.value = b;
    worktreeBaseList.appendChild(opt);
  }
  inputWorktreeBase.placeholder = info.defaultBranch ? `${info.defaultBranch} (default)` : '(default branch)';
}


function slugifyTeamName(s) {
  const slug = String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return slug || 'team';
}
function pathBasename(p) {
  return String(p || '').replace(/\/+$/, '').split('/').pop() || '';
}
function sessionNameTaken(name) {
  if (dialogReservedNames.has(name)) return true;
  return !!sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
}
function roleKeyForJoin() {
  if (!teamRoleSelect || teamRoleSelect.value === 'hand') return 'hand';
  const p = (teamRolePromptSelect && teamRolePromptSelect.value) || '';
  const key = p.replace(/^clodex-team-/, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return key || 'member';
}

let teamForCwdToken = 0;
async function refreshTeamForCwd() {
  if (!teamRow) return;
  const authoring = dialogMode === 'template';
  const type = inputType.value;
  const agentType = type === 'claude' || type === 'codex';
  const hide = () => {
    teamRow.style.display = 'none';
    if (teamToggle) teamToggle.checked = false;
    if (teamFields) teamFields.style.display = 'none';
    dialogTeamMode = null;
    dialogTeamName = null;
  };
  if (!agentType || authoring || currentPlacement() !== 'host') { hide(); return; }
  const cwd = expandPath(inputCwd.value.trim()) || homeDir;
  const token = ++teamForCwdToken;
  let res;
  try { res = await window.api.teamForCwd(cwd); } catch { res = null; }
  if (token !== teamForCwdToken) return; // a newer cwd won the race
  teamRow.style.display = '';
  if (res && res.team) {
    dialogTeamMode = 'join';
    dialogTeamName = res.team;
    if (teamToggleLabel) teamToggleLabel.textContent = `Join team ${res.team}`;
    if (teamCreateFields) teamCreateFields.style.display = 'none';
    if (teamJoinFields) teamJoinFields.style.display = '';
    await populateTeamRolePrompts();
    if (teamRolePromptRow) teamRolePromptRow.style.display = teamRoleSelect.value === 'custom' ? '' : 'none';
    if (teamToggle && teamToggle.checked) updateTeamJoinNameSuggestion();
  } else {
    dialogTeamMode = 'create';
    dialogTeamName = null;
    if (teamToggleLabel) teamToggleLabel.textContent = 'Create a team here — this session becomes its lead.';
    if (teamJoinFields) teamJoinFields.style.display = 'none';
    if (teamCreateFields) teamCreateFields.style.display = '';
    try { const r = await window.api.teamNames(); dialogTeamNames = (r && r.names) || []; } catch { dialogTeamNames = []; }
    if (teamNameInput && !teamNameInput.value.trim()) {
      teamNameInput.value = dedupeTeamName(slugifyTeamName(pathBasename(cwd)));
    }
  }
}

function dedupeTeamName(base) {
  if (!dialogTeamNames.includes(base)) return base;
  let n = 2;
  while (dialogTeamNames.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

async function populateTeamRolePrompts() {
  if (!teamRolePromptSelect) return;
  let res;
  try { res = await window.api.teamRolePrompts(); } catch { res = null; }
  const prompts = (res && res.prompts) || [];
  teamRolePromptSelect.innerHTML = '';
  for (const name of prompts) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    teamRolePromptSelect.appendChild(opt);
  }
}

function updateTeamJoinNameSuggestion() {
  if (dialogTeamMode !== 'join' || !dialogTeamName) return;
  if (inputName.value && inputName.value !== lastTeamAutoName) return; // user-owned
  const base = `${dialogTeamName}-${roleKeyForJoin()}`;
  let name = base;
  let n = 2;
  while (sessionNameTaken(name)) name = `${base}-${n++}`;
  inputName.value = name;
  lastTeamAutoName = name;
}

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

async function openDialog(prefill = null) {
  editingTemplateId = null;
  overlayDismissed = false; // fresh open re-checks: the prominence overlay may re-raise
  if (toolOverlay) toolOverlay.classList.add('hidden');
  setDialogMode('create'); // reset chrome if the last use was a template edit
  sessionCounter++;
  const defaultName = `session-${sessionCounter}`;
  inputName.value = (prefill && prefill.name) || defaultName;
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
  if (teamToggle) teamToggle.checked = false;
  if (teamNameInput) teamNameInput.value = '';
  if (teamRoleSelect) teamRoleSelect.value = 'hand';
  if (teamFields) teamFields.style.display = 'none';
  dialogTeamMode = null;
  dialogTeamName = null;
  lastTeamAutoName = null;
  refreshCwdSuggestions();
  if (inputStripLevel) inputStripLevel.value = '0'; // default off each open
  if (inputAutoCompact) inputAutoCompact.checked = true; // default ON (opt-out unchecked)
  if (inputNoWire) inputNoWire.checked = false; // default wired each open
  // Reset placement to Host BEFORE applyTypeDefaults so a stale box value from a
  // prior open can't trip the type-change → applySandboxState hook during open
  // (which would fire a spurious catalog fetch). The options + placementRow
  // visibility are (re)built below once the box registry lands.
  inputPlacement.value = 'host';
  for (const sec of [toolsSection, skillsSection, otherSection, envSection]) {
    if (sec) sec.open = false;
  }
  if (inputEnv) inputEnv.value = ''; // per-session env starts empty each open
  refreshEnvHint();
  applyTypeDefaults();
  inputName.style.borderColor = '';
  const [, , settings, agentLib, boxes, reserved] = await Promise.all([
    refreshTemplatesDropdown(),
    refreshSystemPromptDropdown(),
    window.api.getSettings(),
    window.api.listAgents(),
    window.api.sandboxListBoxes(),
    window.api.reservedSessionNames(),
  ]);
  dialogReservedNames = new Set((reserved && reserved.names) || []);
  if (!prefill && inputName.value === defaultName) {
    inputName.value = bumpDefaultName(defaultName, dialogReservedNames);
  }
  dialogHostSettings = settings;
  dialogHostAgentLib = agentLib || [];
  populateHostCatalogs(settings, dialogHostAgentLib);
  populatePlacementOptions(boxes);
  inputPlacement.value = 'host';
  placementRow.style.display = showPlacementSelector(boxes) ? '' : 'none';
  greyRichFields(false);
  if (prefill && prefill.resumeId) dialogTitle.textContent = 'Adopt Session';
  dialogOverlay.classList.remove('hidden');
  refreshNewSessionToolGate();
  setTimeout(() => inputName.select(), 50);
}

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
  setProxyControls(inputProxyMode, inputProxyUrl, null, settings?.lastCustomProxyUrl || settings?.proxyUrl);
  labelProxyDefault(inputProxyMode, settings);
}

inputType.addEventListener('change', () => applyTypeDefaults());
inputType.addEventListener('change', () => refreshNewSessionToolGate());
inputPlacement.addEventListener('change', () => applyPlacement());
// cwd drives the skill catalog's provenance (which lower-layer settings apply),
// so re-fetch when it changes.
// Bare refs would leak the DOM Event into the first (data) param — disabledSet —
// which then throws `.has is not a function` mid-render and blanks the checklist.
inputCwd.addEventListener('change', () => refreshNewSessionSkills());
inputCwd.addEventListener('change', () => refreshNewSessionTools());
inputCwd.addEventListener('change', () => refreshWorktreeForCwd());
inputCwd.addEventListener('change', () => refreshTeamForCwd());

if (teamToggle) {
  teamToggle.addEventListener('change', () => {
    if (teamFields) teamFields.style.display = teamToggle.checked ? '' : 'none';
    if (teamToggle.checked && dialogTeamMode === 'join') updateTeamJoinNameSuggestion();
  });
}
if (teamRoleSelect) {
  teamRoleSelect.addEventListener('change', () => {
    if (teamRolePromptRow) teamRolePromptRow.style.display = teamRoleSelect.value === 'custom' ? '' : 'none';
    updateTeamJoinNameSuggestion();
  });
}
if (teamRolePromptSelect) {
  teamRolePromptSelect.addEventListener('change', () => updateTeamJoinNameSuggestion());
}

inputProxyMode.addEventListener('change', () => {
  inputProxyUrl.style.display = inputProxyMode.value === 'custom' ? '' : 'none';
  if (inputProxyMode.value === 'custom') inputProxyUrl.focus();
});

// A template's cwd may be "${TEAM_ROOT}" — that is what makes a shipped team
// template portable. Resolve it against the team owning the cwd the dialog is
// ALREADY on (the operator's context: the project they were last in, or the
// prefill), which is the GUI's analogue of the spawn intent's spawner team.
//
// On an unresolved root the literal token STAYS in the field, next to a toast.
// Substituting homeDir (or anything else) here would boot the seat in a tree
// that is not the team's and look entirely successful; the visible token
// refuses to spawn instead. Only the dropdown expands — openTemplateEditor must
// keep the literal so authoring round-trips.
//
// Returns the refusal as `warn` rather than toasting it: this function awaits,
// so by the time it returns the operator may have selected another template,
// and a toast fired here would name one they have already moved off. The caller
// shows it after its staleness guard.
async function cwdFromTemplate(t) {
  const raw = (t && t.cwd) || '';
  if (!raw) return { cwd: homeDir };
  if (!usesTeamRoot(raw)) return { cwd: raw };
  const here = expandPath(inputCwd.value.trim()) || homeDir;
  let root = '';
  try { root = (await window.api.teamForCwd(here))?.root || ''; } catch { root = ''; }
  const r = expandTeamRoot(raw, root);
  if (!r.ok) return { cwd: raw, warn: `Template "${t.name || ''}": ${r.reason}` };
  return { cwd: r.value };
}

inputTemplate.addEventListener('change', async () => {
  const id = inputTemplate.value;
  if (!id) return;
  const list = await window.api.listTemplates();
  const t = list.find(x => x.id === id);
  if (!t) return;
  // Resolve the cwd BEFORE writing any field: it may await an IPC round-trip,
  // and a second template picked during that window would otherwise interleave
  // — this handler's fields half-applied, then the older one's cwd landing on
  // top of the newer one's.
  //
  // The guard below only covers the cwd round-trip. The checklist refreshes
  // further down await too, so a superseded selection can still land its
  // checklist state after a newer one's; closing that needs a generation token
  // threaded through every refresh, not another re-check here.
  const resolved = await cwdFromTemplate(t);
  if (inputTemplate.value !== id) return; // a newer template won the race
  if (resolved.warn) showToast(resolved.warn, { kind: 'warn', duration: 12000 });
  inputType.value = t.type;
  inputCwd.value = resolved.cwd;
  {
    const { model, rest } = splitModelArg(t.extraArgs || []);
    inputModel.value = model;
    inputArgs.value = rest.join(' ');
  }
  argsHint.textContent = ARGS_HINTS[t.type] || '';
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
    if (inputAutoCompact) inputAutoCompact.checked = !(t.autoCompact === false);
    if (inputNoWire) inputNoWire.checked = t.noWire === true;
  }
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
  if (!/^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/.test(name)) {
    alert('Template name must be 1–64 chars: letters, digits, . _ -');
    return;
  }
  const res = await window.api.saveTemplateByName({ name, ...collectFormConfig() });
  await refreshTemplatesDropdown();
  if (res && res.template) inputTemplate.value = res.template.id;
  if (templatesDrawerRefresh) templatesDrawerRefresh();
});

function closeDialog() {
  dialogOverlay.classList.add('hidden');
}

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

function collectFormConfig() {
  const type = inputType.value;
  const agentType = type === 'claude' || type === 'codex';
  const intents = type === 'claude' ? collectIntentChecklist(inputIntentList) : null;
  const autoCompactOff = type === 'claude' && inputAutoCompact && !inputAutoCompact.checked;
  const noWireOn = type === 'claude' && inputNoWire && inputNoWire.checked;
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
    ...(noWireOn ? { noWire: true } : {}),
    denyBuiltins: type === 'claude' ? collectBuiltinChecklist(inputBuiltinsList) : [],
    disabledTools: type === 'claude' ? collectToolChecklist(inputToolsList) : [],
    disabledSkills: type === 'claude' ? collectSkillChecklist(inputSkillsList) : [],
    injectSkills: type === 'claude' ? collectInjectChecklist(inputInjectSkillsList) : [],
    stripLevel: type === 'claude' ? (Number(inputStripLevel && inputStripLevel.value) || 0) : 0,
    systemPromptFile: agentType ? (inputSystemPrompt.value || null) : null,
    appendPromptFiles: agentType ? collectAppendChecklist(inputAppendList) : [],
  };
}

function collectDialogEnv() {
  const { env } = parseEnvLines(inputEnv ? inputEnv.value : '');
  return Object.keys(env).length ? env : null;
}

async function doCreate() {
  const name = inputName.value.trim();
  const cfg = collectFormConfig();
  const { type, cwd, extraArgs, proxy, agents, execCommands, denyBuiltins,
          disabledTools, disabledSkills, injectSkills, stripLevel,
          systemPromptFile, appendPromptFiles, intents, noWire } = cfg;
  const env = collectDialogEnv();

  const supportsPrompts = type === 'claude' || type === 'codex';
  const systemPromptBody = null;

  if (!name) return;
  if (!/^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/.test(name)) {
    inputName.style.borderColor = '#e94560';
    return;
  }
  // An unexpanded ${TEAM_ROOT} reaching here means the dropdown could not
  // resolve it and left the literal in the field. It would still fail — as a
  // directory named "${TEAM_ROOT}" on the sandbox path, or at spawn on the host
  // — but refusing at the dialog keeps the correction where the operator can
  // make it, with the field still populated.
  if (usesTeamRoot(cwd)) {
    inputCwd.style.borderColor = '#e94560';
    showToast('This template\'s ${TEAM_ROOT} could not be resolved — type the project directory, '
      + 'or open the dialog from a session inside the team.', { kind: 'warn', duration: 12000 });
    return;
  }

  const resumeId = supportsPrompts ? inputResume.value.trim() || null : null;
  const fork = supportsPrompts ? inputFork.checked : false;

  const placement = currentPlacement();
  if (placement !== 'host') {
    const boxId = placement;
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
    await ensurePeerSessionVisible(boxId, res.name || name);
    openPeerSession(boxId, res.name || name);
    const boxSt = peerStatuses.get(boxId);
    const boxLabel = (boxSt && boxSt.label) || boxId;
    showToast(`Created "${res.name || name}" (${res.type || type}) in ${boxLabel}.`, { kind: 'peer-ui' });
    for (const w of (res.warnings || [])) showToast(w, { kind: 'warn', duration: 15000 });
    return;
  }

  // Opt-in git worktree: create it FIRST (off the entered cwd's repo), then spawn
  // the session in the new worktree instead. Done before closeDialog so a failure
  // can surface with the dialog still open for correction.
  let spawnCwd = cwd;
  let worktree = null;
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

  window.api.noteCwd(cwd);

  closeDialog();

  // Remember the last custom URL as a prefill ONLY — never touch the global
  // proxyUrl (that would rewrite ANTHROPIC_BASE_URL for default-proxy spawns and
  // could abandon the managed wirescope when the port stops matching).
  if (typeof proxy === 'string') window.api.setSettings({ lastCustomProxyUrl: proxy });
  const teamOn = teamToggle && teamToggle.checked && teamRow && teamRow.style.display !== 'none';
  const seatParams = { name, type, cwd: spawnCwd, extraArgs, systemPromptBody, resumeId, fork, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, stripLevel, systemPromptFile, appendPromptFiles, execCommands, intents, env, noWire: noWire === true };
  let result;
  if (teamOn && dialogTeamMode === 'create') {
    const teamName = slugifyTeamName(teamNameInput.value.trim() || pathBasename(cwd));
    result = await window.api.teamCreate({ teamName, ...seatParams });
  } else if (teamOn && dialogTeamMode === 'join') {
    const role = roleKeyForJoin();
    const prompt = (teamRoleSelect && teamRoleSelect.value === 'hand') ? null : ((teamRolePromptSelect && teamRolePromptSelect.value) || null);
    result = await window.api.teamJoin({ team: dialogTeamName, role, prompt, ...seatParams });
  } else {
    result = await window.api.createSession(name, type, spawnCwd, extraArgs, systemPromptBody, resumeId, fork, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, stripLevel, systemPromptFile, appendPromptFiles, execCommands, intents, env, noWire === true);
  }
  if (!result.ok) {
    console.error('Failed to create session:', result.error);
    alert(`Create session failed: ${result.error || 'unknown error'}`);
    refreshDiagBanner(); // a posix_spawnp failure usually means a broken install
    return;
  }

  if (worktree) window.api.markSessionWorktree(name, worktree);

  createTerminal(name);
  addSessionToSidebar(name, type, spawnCwd, null, (result.session && result.session.backend) || null, (result.session && result.session.team) || null, (result.session && result.session.noWire) === true);
  // Manual, so it focuses as it always has — unless the operator has a line
  // open in the session they were on, which vetoes regardless of provenance.
  await switchToNewSession(name, { agentInitiated: false });

  const warnings = (result.session && result.session.warnings) || [];
  for (const w of warnings) showToast(w, { kind: 'warn', duration: 15000, name });
}

function submitDialog() {
  if (dialogMode === 'template') saveTemplateFromForm();
  else doCreate();
}

document.getElementById('btn-new').addEventListener('click', () => openDialog());
document.getElementById('btn-new-sandbox').addEventListener('click', () => openSandboxDialog());
document.getElementById('btn-add-peer').addEventListener('click', () => openPeersDialog());
document.getElementById('btn-cancel').addEventListener('click', closeDialog);
btnCreate.addEventListener('click', submitDialog);

document.getElementById('btn-browse').addEventListener('click', async () => {
  const dir = await window.api.selectDirectory();
  if (!dir) return;
  if (currentPlacement() !== 'host') {
    await pickSandboxCwd(dir);
    return;
  }
  inputCwd.value = dir;
  refreshNewSessionSkills();
  refreshNewSessionTools();
  refreshWorktreeForCwd();
});

async function pickSandboxCwd(hostDir) {
  const t = await window.api.sandboxTranslatePath(hostDir, currentPlacement());
  if (t && t.container) { inputCwd.value = t.container; return; }
  showToast(`"${hostDir}" isn't reachable in the sandbox — type a container path, or mount the folder from the Sandboxes panel.`, { kind: 'warn', duration: 9000 });
}

dialogOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitDialog();
});


function setDialogMode(mode) {
  dialogMode = mode;
  const authoring = mode === 'template';
  dialogTitle.textContent = authoring ? (editingTemplateId ? 'Edit Template' : 'New Template') : 'New Session';
  nameFieldLabel.textContent = authoring ? 'Template name' : 'Name';
  btnCreate.textContent = authoring ? 'Save Template' : 'Create';
  btnSaveTemplate.style.display = authoring ? 'none' : '';
  if (authoring) {
    templateRow.style.display = 'none'; // create-mode: refreshTemplatesDropdown owns it
    placementRow.style.display = 'none';
    greyRichFields(false);
    applyNewSessionToolGate({ ok: true, disabled: false, notice: null });
  }
}

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
  if (inputAutoCompact) inputAutoCompact.checked = !(tpl && tpl.autoCompact === false);
  if (inputNoWire) inputNoWire.checked = (tpl && tpl.noWire) === true;
  for (const sec of [toolsSection, skillsSection, otherSection]) { if (sec) sec.open = false; }
  setDialogMode('template');
  applyTypeDefaults({ skipAsyncRefresh: true });
  const settings = await window.api.getSettings();
  setClaudeToolsCache(settings?.claudeTools || []);
  setDefaultToolDenyCache(settings?.defaultToolDeny || []);
  setAgentLibCache((await window.api.listAgents()) || []);
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
  setProxyControls(inputProxyMode, inputProxyUrl, (tpl && tpl.proxy) ?? null, settings?.lastCustomProxyUrl || settings?.proxyUrl);
  labelProxyDefault(inputProxyMode, settings);
  inputName.style.borderColor = '';
  dialogOverlay.classList.remove('hidden');
  setTimeout(() => inputName.select(), 50);
}

async function saveTemplateFromForm() {
  const name = inputName.value.trim();
  if (!/^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/.test(name)) {
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


window.api.onPtyData((name, data) => {
  const s = sessions.get(name);
  if (s) s.terminal.write(data);
});

window.api.onSessionExit((name, code, meta) => {
  // Invalidate the tool cache FIRST (awaited) so the re-probe sees the fresh PATH, not the
  // stale cache. Must stay BEFORE the archivedEntry early return below: closing the installer
  // tab stamps archivingSessions, so the natural end gesture would otherwise skip the bust.
  if (isToolInstallSession(name)) {
    (async () => {
      try { await window.api.invalidateToolCache(); } catch {}
      if (!dialogOverlay.classList.contains('hidden')) refreshNewSessionToolGate();
    })();
  }
  const archivedEntry = archivingSessions.get(name);
  removeSession(name);
  if (archivedEntry) {
    archivingSessions.delete(name);
    addArchivedSessionToSidebar(archivedEntry);
    refreshSidebarView();
    return;
  }
  // Deliberate exits (expected:true) and clean self-exits stay silent. AGENT-ONLY on
  // purpose: intent-spawned bash that fast-fails at code≠0 would otherwise storm toasts.
  // Every exit still lands in the IPC log, so narrowing the toast hides nothing.
  if (meta && meta.agentType && !meta.expected && (code !== 0 || meta.signal)) {
    if (meta.missingTool) {
      showToast(
        `${name} couldn't start: the \`${meta.missingTool}\` CLI wasn't found on PATH. Install it and try again.`,
        { kind: 'error', duration: 15000 },
      );
    } else {
      const why = meta.signal ? `signal ${meta.signal}` : `code ${code}`;
      showToast(`${name} exited unexpectedly (${why}).`, { kind: 'error', duration: 15000 });
    }
  }
});

window.api.onSelectionSent((name) => drawerHost.onSelectionSent(name));

window.api.onSessionActivity((name, state, turnEnd) => {
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
  // AFTER the dataset write, because the watcher's own permission interlock
  // reads this row back.
  const sess = sessions.get(name);
  if (sess && sess.voiceSubmit) sess.voiceSubmit.noteActivity(state, turnEnd === true);
  sidebarMeta.set(name, { ...(sidebarMeta.get(name) || {}), lastActivityTs: Date.now() });
  scheduleSidebarRelayout();
});

window.api.onSessionAttention((name, attn) => {
  const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (!el) return;
  if (attn) {
    el.dataset.attention = attn.kind;
    el.dataset.attentionMsg = attn.message || '';
    if (window.__CLODEX_WEB__ && !document.hasFocus()) webNotifier.raise(attentionNotice(name, attn));
  } else {
    delete el.dataset.attention;
    delete el.dataset.attentionMsg;
  }
  if (window.__CLODEX_WEB__) updateWindowTitle();
});


const peerStatuses = new Map(); // peerId -> status from peer-state events
const peerTunnels = new Map();  // peerId -> managed-tunnel status (may lag peerStatuses)
const peerWebTunnels = new Map();
let ourAppVersion = null;
window.api.getVersion().then((v) => { ourAppVersion = v || null; }).catch(() => {});

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

function applyPendingBadge(name, count) {
  const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (!el) return;
  const badge = el.querySelector('.session-pending');
  if (!badge) return;
  badge.textContent = count > 0 ? `✉${count}` : '';
  badge.dataset.tip = count > 0
    ? `${count} parked message${count === 1 ? '' : 's'} waiting — click to deliver now`
    : 'Parked messages waiting — click to deliver now';
  if (count > 0) {
    window.api.peekPending(name).then((items) => {
      if (!Array.isArray(items) || items.length === 0) return;
      if (!badge.textContent) return;
      const shown = items.slice(0, 5)
        .map((m) => `• ${m.from}: ${m.snippet || '(no preview)'}`);
      const total = Math.max(count, items.length);
      const more = Math.max(0, total - shown.length);
      const lines = [
        `${total} parked message${total === 1 ? '' : 's'} — click to deliver now:`,
        ...shown,
      ];
      if (more > 0) lines.push(`…and ${more} more`);
      badge.dataset.tip = lines.join('\n');
    }).catch(() => { /* keep the plain count tip */ });
  }
}

window.api.onPendingCount((msg) => {
  if (msg && typeof msg.name === 'string') applyPendingBadge(msg.name, msg.count || 0);
});

function applyTicketBadge(name, ticket) {
  const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (!el) return;
  if (ticket) el.dataset.ticket = ticket;
  else delete el.dataset.ticket;
}

window.api.onSessionTicket((msg) => {
  if (msg && typeof msg.name === 'string') applyTicketBadge(msg.name, msg.ticket || null);
});

const peerFilesCount = new Map();

const PROXY_POLL_MS = 5000;
const proxyState = new Map(); // name -> { payload, at }
const filesState = new Map();
const filesUnseen = new Set();

function sessionTypeOf(name) {
  const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  return item ? (item.dataset.type || null) : null;
}
function activeIsAgent() {
  const t = activeSession ? sessionTypeOf(activeSession) : null;
  return t === 'claude' || t === 'codex';
}
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
function activePeerQueryable() {
  const entry = activeSession ? sessions.get(activeSession) : null;
  if (!entry || !entry.peer) return false;
  const st = peerStatuses.get(entry.peer.id);
  return !!(st && st.online && Array.isArray(st.caps) && st.caps.includes('query'));
}
function activePeerConfigurable() {
  const entry = activeSession ? sessions.get(activeSession) : null;
  if (!entry || !entry.peer) return false;
  const st = peerStatuses.get(entry.peer.id);
  if (!st || !st.online || !Array.isArray(st.caps) || !st.caps.includes('args')) return false;
  const type = (st.sessions || []).find((s) => s.name === entry.peer.name)?.type;
  return !type || type === 'claude' || type === 'codex';
}

// Which SESSION-SCOPED plugins may draw for a given session (t190). Answered
// off sidebarMeta, which already carries a per-row read on a timer — the
// sidebar paints every session at once, so a single active-session answer would
// be the wrong shape for row badges.
//
// A plugin absent from `scopedPluginIds` is GLOBAL (or does not exist) and
// always reaches: this must fail toward today's behaviour, because the set
// arrives asynchronously and an empty one during startup would otherwise blank
// every plugin's UI for a frame.
let scopedPluginIds = new Set();
function pluginReachesSession(pluginId, sessionName) {
  if (!scopedPluginIds.has(pluginId)) return true;
  const grants = (sidebarMeta.get(sessionName) || {}).pluginGrants;
  // The engine's own predicate, not a local re-derivation: it matches whole
  // tokens against the capability vocabulary, where the split-on-':' this used
  // to do read a colon-less "demoX" as plugin "demo" (indexOf -1 → slice(0,-1)).
  // Both halves must answer the same question the same way or the renderer hides
  // what the engine allows, or worse.
  return pluginReaches(pluginId, grants);
}

const pluginBar = initPluginHost({
  getActiveSession: () => activeSession,
  sessionTypeOf, activeIsAgent, activePeerQueryable, activePeerConfigurable,
  scheduleSidebarRelayout,
  getWorkspaceId: () => currentWorkspaceId,
  listSessions: () => window.api.listSessions(),
  openPath: (p) => window.api.fileOpen(p),
  showToast,
  selectDirectory: () => window.api.selectDirectory(),
  pluginReachesSession,
});

async function activatePluginRenderer(id) {
  let reported = false;
  try {
    const info = await window.api.pluginInvoke('_host', 'renderer.info', [id]);
    if (!info || !info.ok || !info.rendererPath) return false;
    const mod = requirePluginRenderer(info.rendererPath, id);
    if (!mod) return false;
    pluginBar.activate(id, mod, {
      invoke: (pid, method, args) => window.api.pluginInvoke(pid, method, args),
      css: info.css,
    });
    reported = true;
    // Report the OUTCOME, not just the failure: a success is what clears a
    // stale strike, and "consecutive" only means anything if success counts.
    try { await window.api.pluginInvoke('_host', 'renderer.report', [id, true]); } catch {}
    return true;
  } catch (e) {
    console.error(`[plugin:${id}] renderer activation failed`, e);
    if (!reported) {
      try { await window.api.pluginInvoke('_host', 'renderer.report', [id, false, String((e && e.message) || e)]); } catch {}
    }
    return false;
  }
}

// require() of an absolute path works only because contextIsolation is off by design here.
// The web bundle cannot, so it resolves through the build-generated id→module registry.
function requirePluginRenderer(rendererPath, id) {
  const reg = window.__CLODEX_PLUGIN_REGISTRY__;
  if (reg && typeof reg.get === 'function') return reg.get(id) || null;
  if (window.__CLODEX_WEB__ || !window.require) return null;
  return window.require(rendererPath);
}

// Which installed plugins declare `scope: "session"`. Separated from the load
// loop because a plugin enabled mid-run must update it without re-activating
// every other plugin.
// null (never []) on a failed read, and every caller must skip ACTIVATION on it:
// the set is left as it was, so a plugin activated against a stale set would draw
// unscoped on every session until some later refresh happened to fix it. Not
// drawing at all is the recoverable half of that.
async function refreshScopedPluginIds() {
  let catalog = null;
  try { catalog = await window.api.pluginCatalog(); } catch { return null; }
  scopedPluginIds = new Set((catalog || []).filter((p) => p && p.scope === 'session').map((p) => p.id));
  return catalog || [];
}

async function loadPluginRenderers() {
  if (!window.api.pluginCatalog) return;
  // Recorded BEFORE activation: a scoped plugin's first paint can happen inside
  // activate(), and a set filled afterwards would let it draw once on every
  // session regardless of grants.
  const catalog = await refreshScopedPluginIds();
  for (const p of catalog || []) {
    if (!p || !p.enabled) continue;
    await activatePluginRenderer(p.id);
  }
}
loadPluginRenderers();

if (window.api.onPluginEvent) {
  window.api.onPluginEvent((pluginId, topic, payload) => {
    if (pluginId === '_host' && topic === 'plugin-state' && payload && payload.id) {
      // A plugin enabled mid-run has never been through loadPluginRenderers, so
      // its scope would be unknown and it would draw unscoped until restart.
      if (payload.enabled) {
        refreshScopedPluginIds().then((c) => { if (c) activatePluginRenderer(payload.id); });
      }
      else pluginBar.dispose(payload.id);
      if (pluginsOverlay && !pluginsOverlay.classList.contains('hidden')) renderPluginsDialog();
      return;
    }
    if (pluginId !== '_host') pluginBar.deliverEvent(pluginId, topic, payload);
  });
}

// Assigned when the voice popover island is initialised, far below. A direct
// reference to that const would be a TDZ throw: renderSessionActions is hoisted
// and the bar can be painted by a restore before the island exists.
let voiceBarActionHtml = () => '';

function renderSessionActions(holdHtml = '') {
  const el = document.getElementById('proxy-actions');
  if (!el) return;
  const type = activeSession ? sessionTypeOf(activeSession) : null;
  const btns = [];
  if (type === 'claude' || type === 'codex') {
    const nFiles = (filesState.get(activeSession) || []).length;
    if (type === 'claude' || nFiles > 0) {
      const label = nFiles > 0 ? `📄 ${nFiles} file${nFiles === 1 ? '' : 's'}` : '📄 files';
      const unseen = filesUnseen.has(activeSession) ? ' px-files-new' : '';
      btns.push(`<button class="px-action${unseen}" data-act="files" data-tip="Files this agent's tools touched — click to view or diff">${label}</button>`);
    }
    // Claude only: Codex has no `/voice`, so the button would name a setting
    // that seat cannot have.
    if (type === 'claude') btns.push(voiceBarActionHtml());
    btns.push('<button class="px-action" data-act="session-menu" data-tip="Session actions — tools, skills, agents, intents, settings, history, reload">⚙ session ▾</button>');
  }
  if (activePeerQueryable()) {
    const nFiles = peerFilesCount.has(activeSession)
      ? peerFilesCount.get(activeSession)
      : (filesState.get(activeSession) || []).length;
    const label = nFiles > 0 ? `📄 ${nFiles} file${nFiles === 1 ? '' : 's'}` : '📄 files';
    const unseen = filesUnseen.has(activeSession) ? ' px-files-new' : '';
    btns.push(`<button class="px-action${unseen}" data-act="files" data-tip="Files this agent's tools touched (on its own machine) — click to view or diff">${label}</button>`);
  }
  if (activePeerConfigurable()) {
    btns.push('<button class="px-action" data-act="peer-edit" data-tip="Edit this remote session\'s settings (args, prompts, tools, skills…)">⚙ Edit Session</button>');
  }
  el.innerHTML = btns.join('') + pluginBar.statusBarHtml() + (holdHtml || '');
}

function renderProxyBar() {
  const bar = document.getElementById('proxy-bar');
  if (!bar) return;
  const main = document.getElementById('main');
  const tele = document.getElementById('proxy-telemetry');
  renderSessionActions();
  const st = activeSession ? proxyState.get(activeSession) : null;
  if (!st || !st.payload) {
    if (activeIsAgent() || activePeerQueryable() || activePeerConfigurable() || pluginBar.hasVisibleContribution()) {
      bar.style.display = '';
      if (main) main.classList.add('has-proxy-bar');
      tele.className = '';
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
  const ctxUtil = !!(p.capabilities && p.capabilities.context_utilization);
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
    // esc(): p.context arrives from a peer's HTTP body (peer-client JSON.parse
    // -> peerProxyView, which passes context through by reference) and the
    // guard above is `!= null`, which a string satisfies. Unescaped here is
    // local code execution, not XSS — the renderer has require().
    segs.push(`<span class="px-seg${ctxCls}"${ctxAttr} data-tip="${ctxTip || 'Messages in context'}">🧠 ${esc(p.context.messages)} msg</span>`);
  }
  const tSeg = turnSeg(p);
  if (tSeg) segs.push(`<span class="px-seg" data-tip="${esc(tSeg.tip)}">${esc(tSeg.text)}</span>`);
  const rSeg = reqSeg(p);
  if (rSeg) segs.push(`<span class="px-seg" data-tip="${esc(rSeg.tip)}">${esc(rSeg.text)}</span>`);
  // Warmth is Claude-only signal (a prompt-cache pinger). We have none for Codex,
  // so a codex tab used to show a permanent "❄️ cold" that is noise, not truth —
  // drop the seg for codex rather than assert a warmth state we can't observe.
  if (p.warmth && sessionTypeOf(activeSession) !== 'codex') {
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
    const timeline = !!(p.capabilities && p.capabilities.context_timeline && p.base && p.sessionId)
      || peerQueries.includes('cost');
    if (timeline) {
      segs.push(`<span class="px-seg px-cost px-ctx-btn" data-act="cost" data-tip="${esc(cSeg.tip)} — click for the over-time breakdown">${esc(cSeg.text)}</span>`);
    } else {
      segs.push(`<span class="px-seg px-cost" data-tip="${esc(cSeg.tip)} (wirescope)">${esc(cSeg.text)}</span>`);
    }
  } else if (sc && typeof sc.cost === 'number' && sc.cost > 0) {
    const costTxt = sc.cost >= 1 ? sc.cost.toFixed(2) : sc.cost.toFixed(4);
    segs.push(`<span class="px-seg px-cost" data-tip="Cost so far, reported by the CLI (no wirescope — no live breakdown)">~$${costTxt}</span>`);
  }
  if (p.refusals > 0) segs.push(`<span class="px-seg px-refusal">⚠ ${p.refusals}</span>`);
  // Report GENUINE busts only: exclude fault:self entirely (the per-turn thinking-strip
  // microbusts every active session makes by construction) and subtract each class's
  // restart_between (the one-time proxy-restart re-cache tax) — real = count − restart_between.
  // No chip at all when nothing genuine remains, which is every steady session by design.
  const bsum = p.busts;
  if (bsum && Array.isArray(bsum.classes)) {
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
  renderSessionActions(buildProxyExtras(p));
}

// VISIBILITY of these two controls is gated on advertised capability + persisted state;
// ACTIONABILITY (enabled vs disabled) on the live link. Gating presence on the link makes
// the strip button vanish on every blip, and on a downgraded capability probe —
// strip_thinking.available is a static deployment property, latched main-side per base,
// so a probe that omits it must not retract the button.
function buildProxyExtras(p) {
  const actionable = !!(p.linked && p.base && p.sessionId);

  let holdHtml = '';
  if (p.capabilities && p.capabilities.hold) {
    if (actionable && p.hold) {
      // `until` re-anchors to the last real turn, so this slides forward as the
      // session is used — it's "stays warm ~N more hours if idle", not a fixed
      // countdown. pingable=false → armed but waiting for the next turn to fire.
      // A perpetual hold has no deadline: it must never borrow the countdown
      // branch, which would render `until` (null) as a remaining time.
      const always = !!p.hold.always;
      const untilS = typeof p.hold.until === 'number' ? p.hold.until : null;
      const remH = untilS != null ? Math.max(0, (untilS - Date.now() / 1000) / 3600) : null;
      const remTxt = remH == null ? '' : (remH < 1 ? ` ~${Math.round(remH * 60)}m` : ` ~${remH.toFixed(1)}h`);
      const pending = p.pingable === false;
      const label = pending ? '🔒 armed' : (always ? '🔒 held always' : `🔒 held${remTxt}`);
      const tip = pending
        ? 'Armed — starts keeping warm after the next turn. Click to change or stop.'
        : (always
          ? 'Keeping cache warm indefinitely — no deadline, and it re-arms itself after a restart. Click to change or stop.'
          : 'Keeping cache warm. Click to change or stop.');
      holdHtml = `<button class="px-hold" data-act="warm-menu" data-held="1" data-tip="${tip}">${label}</button>`;
    } else if (actionable) {
      holdHtml = `<button class="px-hold" data-act="warm-menu" data-tip="Keep prompt cache warm">🔥 keep warm</button>`;
    } else {
      holdHtml = `<button class="px-hold" disabled data-tip="Keep prompt cache warm — waiting for a live proxy session">🔥 keep warm</button>`;
    }
  }

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

function applyWarmBadge(name) {
  const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (!el) return;
  const badge = el.querySelector('.session-warm');
  const st = proxyState.get(name);
  const p = st && st.payload;
  const isCodex = el.dataset.type === 'codex';

  if (badge) {
    if (isCodex || !p || !p.linked || !p.warmth) {
      badge.textContent = '';
      badge.dataset.state = '';
    } else {
      const ageMs = Date.now() - st.at;
      const remaining = p.warmth.remaining_s != null ? p.warmth.remaining_s - ageMs / 1000 : null;
      if (ageMs > PROXY_POLL_MS * 4) {
        badge.textContent = '?'; badge.dataset.state = 'stale';
      } else if (p.warmth.state === 'warm' && remaining != null && remaining > 0) {
        badge.textContent = fmtMinutes(remaining);
        badge.dataset.state = remaining < 300 ? 'low' : 'warm';
      } else {
        badge.textContent = 'cold'; badge.dataset.state = 'cold';
      }
    }
  }
  el.dataset.refusal = (p && p.linked && p.refusals > 0) ? '1' : '';
}

// The plan quota is the ACCOUNT's, so the drawer bar shows one readout for the
// window, not one per session. Two sources feed it: our own wire's response
// headers (`wire-quota`, turn-frequency, preferred) and the wirescope poller's
// `/_status` block, kept as the fallback for sessions not routed through our
// wire. `pickQuota` holds the whole selection rule — including the void-on-roll
// check that needs the absolute reset — so it can be unit-tested; this function
// only gathers the candidates.
//
// No session-type filter here, and none is needed: a codex turn carries no
// ratelimit headers, so a codex seat contributes no reading by construction.
let wireQuota = null; // { quota, at } — window-wide, not per session
function refreshQuotaChip() {
  const entries = [];
  if (wireQuota) entries.push({ ...wireQuota, source: 'wire' });
  for (const [, st] of proxyState) {
    if (!st || !st.payload || !st.payload.quota) continue;
    entries.push({ quota: st.payload.quota, at: st.at || 0, source: 'wirescope' });
  }
  // Client-side age, not just the server's age_s: if the source stops
  // delivering, age_s freezes at whatever it last said and the chip would keep
  // claiming freshness it does not have. Re-run every second from the interval
  // below so a dead source visibly dims instead of lying quietly.
  const picked = pickQuota(entries);
  drawerHost.setQuota(picked ? quotaChip(picked.quota, picked.clientAgeS) : null);
}

window.api.onSessionProxy((name, payload) => {
  proxyState.set(name, { payload, at: Date.now() });
  applyWarmBadge(name);
  applySubagents(name);
  refreshQuotaChip();
  // The drawer's chip strip is window-wide, so it re-reads all of proxyState
  // rather than this one payload — no argument to pass.
  refreshActivityChips();
  if (name === activeSession) renderProxyBar();
});

// Account plan quota off our own wire. The capability gate `shapeQuota` applies
// to a wirescope payload is about a proxy too old to compute the block; our own
// wire computes it or sends nothing at all, so the capability is satisfied by
// the message existing.
window.api.onWireQuota((snapshot) => {
  const shaped = shapeQuota(snapshot, { quota: true });
  if (shaped) wireQuota = { quota: shaped, at: Date.now() };
  refreshQuotaChip();
});

// The broadcast above fires only on a forwarded turn, so a reading restored
// from disk needs this pull to reach a window opened before the first turn —
// which is the blank-at-launch case the persistence exists to fix. `at` is the
// reading's OWN age, not now: stamping it now would render a reading from last
// week at full confidence.
if (window.api.getWireQuota) {
  window.api.getWireQuota().then((snapshot) => {
    const shaped = shapeQuota(snapshot, { quota: true });
    if (!shaped) return;
    const ageMs = (shaped.ageS || 0) * 1000;
    const at = Date.now() - ageMs;
    // A turn can complete inside this round trip — plausible on a restart with
    // active seats — and the broadcast it fires is fresher than what we asked
    // for. Assigning unconditionally would put the restored reading back until
    // the next turn.
    if (!wireQuota || wireQuota.at < at) wireQuota = { quota: shaped, at };
    refreshQuotaChip();
  }).catch(() => { /* no wire, no reading — the chip's normal empty state */ });
}

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

// Task/background subagents share the parent's session_id on the wire, so they arrive in
// the parent's payload.subagents. Whether one is live/done/dropped is POLICY (there is no
// wire signal for "subagent done") and it lives in lib/subagent-policy.js — the drawer's
// Activity chips classify through the same copy, so the two surfaces cannot disagree.

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

  const live = [];
  for (const s of subs) {
    const state = classifySubagent(s, ageS);
    if (state) live.push({ s, state });
  }

  const existing = subagentRows(name);
  if (!live.length) { existing.forEach((el) => el.remove()); return; }

  // Reconcile by key: update in place where possible so a row's identity (and
  // its click handler) survives a re-render, append the rest after the parent.
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
        openActivityFeed(name, s.key, s.label || s.key);
      });
    }
    row.dataset.state = state;
    const costTxt = (typeof s.estUsd === 'number') ? `~${fmtUsd(s.estUsd)}` : '';
    row.title = `${s.label || s.key}${s.model ? ' · ' + s.model : ''}`
      + `${s.requests ? ' · ' + s.requests + ' turn' + (s.requests === 1 ? '' : 's') : ''}`
      + `${costTxt ? ' · ' + costTxt : ''}\nClick for live activity`;
    row.querySelector('.child-label').textContent = s.label || s.key;
    row.querySelector('.child-meta').textContent =
      [s.requests ? `${s.requests}` : '', costTxt].filter(Boolean).join(' · ');
    if (anchor.nextSibling !== row) anchor.after(row);
    anchor = row;
  }
  existing.forEach((el) => { if (!seen.has(el.dataset.key)) el.remove(); });
  // A sub that ages out of the sidebar does NOT close its Activity feed: the
  // captured history is the reason the drawer replaced the popover, and the
  // chip stays (styled `ended`) for as long as it holds turns.
}


initSessionHovercard({
  sessionList, proxyState, ctxPct, ctxTokens,
  proxyPollMs: PROXY_POLL_MS, typeGlyph,
});

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

// Scoped to kept-warm holds (ttl_s > the horizon): a plain ~5-min Anthropic cache has a
// lifetime no longer than the horizon, so this would fire the instant it warms.
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
    const entry = sessions.get(name);
    const disp = entry && entry.peer
      ? `${entry.peer.name}@${peerDisplayHost(peerStatuses.get(entry.peer.id))}`
      : name;
    showToast(`${disp}: cache going cold in ~${mins} min.`, { kind: 'warm', name });
  }
}

setInterval(() => {
  for (const name of proxyState.keys()) { applyWarmBadge(name); checkWarmthCooldown(name); }
  for (const el of sessionList.querySelectorAll('.session-item[data-thinking-since]')) applyThinkBadge(el);
  tickProxyBar();
  // Staleness is time-based, so it has to be re-evaluated on the clock rather
  // than only when a payload arrives — the case it exists for is payloads
  // NOT arriving.
  refreshQuotaChip();
}, 1000);

(() => {
  const bar = document.getElementById('proxy-bar');
  if (!bar) return;
  bar.addEventListener('click', async (e) => {
    const link = e.target.closest('.px-link');
    if (link && link.dataset.url) {
      e.preventDefault();
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
    // Plugin segments (namespaced data-act on a .px-seg) — checked before the
    // .px-action chain because a plugin segment is a span, not a button.
    const pluginSeg = e.target.closest('.px-seg.px-plugin[data-act]');
    if (pluginSeg && pluginBar.handleBarClick(pluginSeg.dataset.act, pluginSeg)) return;
    const action = e.target.closest('.px-action');
    if (action && activeSession) {
      // Plugin acts are namespaced "<pluginId>:<id>", so a colon is by
      // construction a plugin's — core acts never contain one.
      if (action.dataset.act.includes(':')) {
        pluginBar.handleBarClick(action.dataset.act, action);
        return;
      }
      if (action.dataset.act === 'files') openFilesPopover(activeSession, action);
      else if (action.dataset.act === 'voice') openVoicePopover(action);
      else if (action.dataset.act === 'peer-edit') {
        openPeerArgs(activeSession);
      }
      else if (action.dataset.act === 'session-menu') {
        if (isSessionMenuOpen()) closeSessionMenu();
        else openSessionMenu(action, sessionTypeOf(activeSession), (act, anchor) => routeSessionAction(act, anchor),
          pluginBar.menuEntriesFor(sessionTypeOf(activeSession)));
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

const {
  openWarmMenu, closeWarmMenu, isWarmMenuOpen,
  openStripMenu, closeStripMenu, isStripMenuOpen,
  openSessionMenu, closeSessionMenu, isSessionMenuOpen,
  openHistoryMenu, doHardRestart,
} = initSessionMenus({
  getActiveSession: () => activeSession, proxyState, sessionList,
  createTerminal, addSessionToSidebar, switchSession,
});

function routeSessionAction(act, anchor) {
  if (!activeSession) return;
  if (act.includes(':') && pluginBar.handleMenuPick(act, activeSession, anchor)) return;
  if (act === 'tools') openToolsPopover(activeSession, anchor);
  else if (act === 'skills') openSkillsPopover(activeSession, anchor);
  else if (act === 'agents') openAgentsPopover(activeSession, anchor);
  else if (act === 'intents') openIntentsPopover(activeSession, anchor);
  else if (act === 'edit') openArgsDialog(activeSession);
  else if (act === 'history') openHistoryMenu(activeSession, anchor);
  else if (act === 'reload') doHardRestart(activeSession);
}

const { openToolsPopover, openSkillsPopover, openAgentsPopover, openIntentsPopover } = initChecklistPopovers({
  sessionList, createTerminal, addSessionToSidebar, switchSession,
});

const { openTeamRolesPopover } = initTeamRolesPopover({ promptText, openSessionDialog: openDialog });

// Create Team… (t288) — a team with NO seat behind it, which is why it goes
// through teamCreateBare rather than the new-session dialog's teamCreate (that
// one writes the manifest and spawns the lead indivisibly).
//
// Validation is NOT duplicated here: createTeam refuses a bad name, a relative
// root, a duplicate name and an already-owned root with readable messages, and
// it is the writer that actually enforces them — a second copy in the dialog
// would drift from it silently. The dialog shows what the backend said.
function openCreateTeamDialog() {
  // A menu item can be clicked while its dialog is already up (the native menu
  // stays live), and each open appends its own overlay — stacked modals whose
  // hidden copies keep taking Enter. Re-focus the live one instead.
  const live = document.querySelector('.team-create-overlay');
  if (live) {
    // Only pull focus in from OUTSIDE — a second menu click while the operator is
    // mid-word in the name field must not yank them back to the root field.
    if (!live.contains(document.activeElement)) {
      const f = live.querySelector('[data-f="root"]');
      if (f) f.focus();
    }
    // Resolves null, which the caller cannot tell apart from Cancel. Harmless
    // because the only caller (the Teams menu listener) ignores the result — a
    // future caller that acts on the resolution needs a distinguishable value.
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'prompt-modal-overlay team-create-overlay';
    overlay.innerHTML = `
      <div class="prompt-modal">
        <h3>Create Team</h3>
        <div class="team-create-field">
          <label>Root directory (absolute)</label>
          <input type="text" data-f="root" spellcheck="false" placeholder="/Users/you/projects/thing">
        </div>
        <div class="team-create-field">
          <label>Team name</label>
          <input type="text" data-f="name" spellcheck="false">
        </div>
        <div class="team-create-error hidden"></div>
        <div class="dialog-actions">
          <div style="flex:1;"></div>
          <button class="secondary" data-act="cancel" type="button">Cancel</button>
          <button data-act="ok" type="button">Create</button>
        </div>
      </div>`;
    const rootInput = overlay.querySelector('[data-f="root"]');
    const nameInput = overlay.querySelector('[data-f="name"]');
    const errEl = overlay.querySelector('.team-create-error');
    document.body.appendChild(overlay);

    // The name follows the root's basename until the operator takes it over —
    // after that a further root edit must not overwrite what they typed.
    let nameTouched = false;
    nameInput.addEventListener('input', () => { nameTouched = true; });
    rootInput.addEventListener('input', () => {
      if (nameTouched) return;
      const base = pathBasename(rootInput.value.trim());
      // dedupe lives in teamNamePrefill (it clamps AFTER the suffix); this dialog
      // only supplies the slug and the taken set.
      nameInput.value = base ? teamNamePrefill(slugifyTeamName(base), dialogTeamNames) : '';
    });

    const done = (val) => { overlay.remove(); resolve(val); };
    const submit = async () => {
      errEl.classList.add('hidden');
      const res = await window.api.teamCreateBare({
        name: nameInput.value.trim(),
        root: rootInput.value.trim(),
      });
      if (!res || !res.ok) {
        errEl.textContent = (res && res.error) || 'could not create the team';
        errEl.classList.remove('hidden');
        return;
      }
      done(res.team);
      // Land somewhere useful: the new team's roles popover, the surface the
      // operator came here to reach, rather than a dismissed dialog.
      openTeamRolesPopover(nameInput.value.trim(), null);
    };
    overlay.querySelector('[data-act="ok"]').addEventListener('click', submit);
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => done(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });
    for (const inp of [rootInput, nameInput]) {
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation(); // keep global shortcuts out, like promptText
        if (e.key === 'Enter') submit();
        else if (e.key === 'Escape') done(null);
      });
    }
    // dedupeTeamName reads the same dialogTeamNames the new-session dialog fills;
    // refresh it here so a duplicate suffix reflects teams created since.
    window.api.teamNames()
      .then((r) => { dialogTeamNames = (r && r.names) || []; })
      .catch(() => {});
    setTimeout(() => rootInput.focus(), 50);
  });
}

// The Teams menu's two menu→renderer requests. The popover and the create dialog
// are renderer DOM the main process cannot reach, so the menu can only ask.
window.api.onRequestOpenTeamRoles((name) => openTeamRolesPopover(name, null));
window.api.onRequestOpenTeamCreate(() => openCreateTeamDialog());


const ctxCatLabel = (c) => CTX_CAT_LABELS[c] || 'other';


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


const { openCostPopover } = initCostPopover({ popoverApi, proxyState });

// Sidebar-row ⓘ. Anchored to the row rather than the proxy bar, so it works for
// any row — including one that isn't the active session.
const { openSessionInfoPopover } = initSessionInfoPopover({ sessionList });


const { openBustPopover } = initBustPopover({ popoverApi, proxyState });

const { openFilesPopover, openFilePeek, isFilesPopoverForKey } = initFilesPopover({
  popoverApi, filesState, filesUnseen, peerFilesCount, renderProxyBar, showToast,
  getActiveSession: () => activeSession,
});

const { openReportPanel } = initReportPanel({ popoverApi, ctxCatLabel });

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
  if (window.__CLODEX_WEB__ && !document.hasFocus()) webNotifier.raise(mentionNotice(name, mtype));
});


// The drawer host and its tenants. The register() calls ARE the tenant
// registry — order here is registration order, not tab order (drawer-host
// sorts by its frozen id list).
// refitActiveTerminal is a hoisted declaration below — passed by reference so
// the drawer refits through the SAME peer-aware path as every other caller.
// Assigned just below, and crossed as a lazy call rather than a value: the host
// is built before the popover that owns the badge, and capturing here would
// freeze the no-op.
let refreshSelectionBadge = () => {};
const drawerHost = createDrawerHost({
  refitActiveTerminal,
  getActiveSession: () => activeSession,
  // The seat axis for `availableFor`. Routed through sessionTypeOf so the
  // sidebar's `dataset.type` has exactly one reader.
  getSeatType: () => (activeSession ? sessionTypeOf(activeSession) : null),
  onArmChanged: () => refreshSelectionBadge(),
});

const { openSelectionPopover, refreshSelectionBadge: doRefreshSelectionBadge } = initSelectionPopover({
  getActiveSession: () => activeSession,
});
refreshSelectionBadge = doRefreshSelectionBadge;
const { appendIpcEntry } = createIpcLog({ host: drawerHost });
// Registered after the log, so the log stays the boot-active tab (drawer-host
// activates the first registration); the strip's ORDER is the host's frozen id
// list, not this. The three handles are called from event handlers only, so
// this may sit below their call sites.
const {
  openActivityFeed, refreshChips: refreshActivityChips, dropParent: dropActivityFeeds,
} = createActivityTab({ host: drawerHost, proxyState, proxyPollMs: PROXY_POLL_MS });

createCtlTab({ host: drawerHost });

// The workbench shell takes the session terminals' theme, read per-mount so a
// theme switch before first open is picked up.
// getSeatType duplicates the drawerHost dep above rather than being read back
// off the host: the tab needs the type AND the peer's shell capability
// together, and a tenant reaching into its host for one of its own inputs is
// the coupling drawer-host's injection seam exists to avoid.
// getSeatShellCap: the active seat's peer box advertises `shell`. A non-peer
// seat answers false and termBackendFor never consults it.
createTermTab({
  host: drawerHost,
  xtermTheme: currentXtermTheme,
  getActiveSession: () => activeSession,
  getSeatType: () => (activeSession ? sessionTypeOf(activeSession) : null),
  getSeatShellCap: () => {
    const entry = activeSession ? sessions.get(activeSession) : null;
    const st = entry && entry.peer ? peerStatuses.get(entry.peer.id) : null;
    return !!(st && st.online && (st.caps || []).includes('shell'));
  },
});

createInboxDrawer({ openFilePeek, showToast });

const voiceCore = createVoiceCore({ showToast });

// Cached because the watcher consults it on every quiet-window expiry, per
// terminal — an invoke per tick would put IPC on a timer. Refreshed by the two
// events that can change it: Preferences saving, and this window loading.
let voiceSubmitConfig = {
  enabled: false, composition: false, rearm: false, phrase: DEFAULT_SUBMIT_PHRASE,
};
async function refreshVoiceSubmitConfig() {
  try { voiceSubmitConfig = readVoiceSubmitSettings(await window.api.getSettings()); } catch {}
}
refreshVoiceSubmitConfig();
// A second workspace window would otherwise hold the config it loaded with —
// including the OFF direction — until it reloaded. Focus is the same moment
// voice-control.js re-reads the mode for the same reason.
window.addEventListener('focus', () => { refreshVoiceSubmitConfig(); });

// Whether a spoken reply is playing, box-wide. Main owns the `say` child and
// pushes both edges, so this is a mirror of a value that lives elsewhere and
// never a reading taken here.
//
// ONE flag for every terminal, matching the thing it describes: there is a
// single audio output, so a narration started by any seat is one every seat's
// re-arm has to wait out — a per-terminal copy would let a background seat arm
// its microphone into the same room.
//
// Starts false. A window opened mid-narration re-arms as it does today until
// the next edge arrives, which is the same direction every other absent-evidence
// gate here takes: a missed deferral costs one narration the operator can stop,
// a stuck one silences the feature.
let speakerBusy = false;
window.api.onSpeakerBusy((busy) => { speakerBusy = busy === true; });

// Which seat holds the microphone, box-wide. A mirror of main's value like
// `speakerBusy` above, and never a reading taken here: `activeSession` is this
// WINDOW's answer, and two windows each have one — which is precisely how a
// background seat's re-arm put a second live recorder in the room.
//
// Starts null, so every seat declines until main has spoken. The opposite
// default would arm every seat in a window that had not yet heard, which is the
// bug; a seat that declines for one poll costs the operator one repeated tap.
const micTargetMirror = createMirrorLatch(null, {
  normalize: (name) => (typeof name === 'string' ? name : null),
});
// The broadcast also STOPS a recorder on the seat that just lost the
// microphone: the mirror alone only stops it re-ARMING, which left a live
// recorder in the window he switched away from.
const noteMicTarget = createMicHandoff({
  mirror: micTargetMirror,
  // Resolved at call time against this window's own map, so a seat in another
  // window resolves to nothing here and is stopped by its own window's handler.
  watcherFor: (name) => {
    const entry = name ? sessions.get(name) : null;
    return (entry && entry.voiceSubmit) || null;
  },
});
window.api.onMicTarget((name) => noteMicTarget(name));
// A window that opened or reloaded mid-dictation missed the broadcast, and the
// target does not move again while he keeps talking to the seat he picked. The
// latch is what keeps this late answer from overwriting a fresher one.
window.api.micTarget().then((name) => micTargetMirror.pull(name)).catch(() => {});

// Is CLODEX the frontmost application? A second condition on the automatic
// re-arm, independent of the target: the operator browsed the web with Clodex
// behind it, an agent's turn ended, the re-arm fired, and the CLI transcribed
// the VIDEO he was watching into that seat's composer.
//
// Main's answer, never `document.hasFocus()`, which answers about this WINDOW:
// a window can be the focused window of an application that is itself behind a
// browser — precisely the case that recorded.
//
// Starts false, like the target: before the host has reported, no seat arms.
const appFocusedMirror = createMirrorLatch(false, { normalize: (on) => on === true });
window.api.onAppFocused((on) => appFocusedMirror.note(on));
window.api.appFocused().then((on) => appFocusedMirror.pull(on)).catch(() => {});

// Tell main which seat the operator is looking at.
//
// ALSO ON WINDOW FOCUS, not on session switch alone, and that is what makes it
// correct with several workspace windows open: each window reports its own
// active seat, main keeps the LAST report, and moving between windows without
// switching seats inside either one would otherwise leave the record pointing
// into the window he just left.
function reportFocusedSession() {
  try { window.api.noteFocusedSession(activeSession); } catch {}
}
window.addEventListener('focus', reportFocusedSession);
// No eval-time report: an unconditional one would send a null that clears
// whatever another workspace window just recorded.

// An outside script asked for the recorder on this seat (a Voice Control wake
// word, over the agent socket). Main routed it here because only this side can
// read the recording indicator; the watcher makes the decision and owns the
// polarity rule that an unreadable screen writes nothing.
//
// voiceCore must be REFRESHED before the arm, since the watcher's own mode gate
// reads it and its reading is a 15s POLL — without this the core still reports
// `hold` and `tapTrigger` writes NOTHING.
//
// UNCONDITIONALLY, not only when `modeSettling`. The stale read is not caused by
// this tap's write: a `/voice tap` typed straight into a terminal leaves the file
// already on tap, so main writes nothing and reports no settle, and a core that
// has not polled since still says `hold` — no byte, which is the symptom this
// whole path exists to remove. It costs one already-live IPC on a path that may
// be about to wait a second and a half anyway.
//
// `modeSettling` says the mode was set to `tap` too recently for the CLI to have
// observed it — by THIS tap or by one moments before it — so the watcher owes it
// a settle delay before its key is worth writing. That delay cannot cover the
// poll above: it is sized to the CLI's file watcher, a different clock.
window.api.onVoiceTap(async (name, modeSettling) => {
  try { await voiceCore.refresh(); } catch { /* the watcher's own gate still declines on a stale read */ }
  const sess = sessions.get(name);
  if (sess && sess.voiceSubmit) await sess.voiceSubmit.externalTap(modeSettling);
});
const voiceControl = createVoiceControl({ core: voiceCore });

// Both halves resolve the ACTIVE seat's watcher at call time rather than
// closing over one: the popover outlives every session, and a captured watcher
// would report the recorder of a seat the operator left. A seat with no watcher
// (a peer, a bash shell, one still being built) reports out-of-scope and stops
// nothing, which is what those seats are.
function activeVoiceSubmit() {
  const entry = activeSession ? sessions.get(activeSession) : null;
  return (entry && entry.voiceSubmit) || null;
}

const { actionHtml: voiceActionHtml, openVoicePopover } = initVoicePopover({
  core: voiceCore,
  renderProxyBar,
  getRecorderReading: () => {
    const vs = activeVoiceSubmit();
    return vs ? vs.recorderReading() : 'out';
  },
  getRecorderCause: () => {
    const vs = activeVoiceSubmit();
    return vs ? vs.recorderCause() : null;
  },
  tapOffRecorder: () => {
    const vs = activeVoiceSubmit();
    return vs ? vs.tapOff() : false;
  },
});
voiceBarActionHtml = voiceActionHtml;
// The bar holds the core open for the life of the window: unlike the
// Preferences row, its label is on screen with no dialog to open, so the poll
// behind it must keep running. Preferences takes a second, refcounted hold
// while its dialog is up.
voiceCore.start();



const {
  typeToTakeControl, renderPeerBar, forgetControlMirror,
  openPeerSession, peerDisplayHost, peerHideFromList,
  ensurePeerSessionVisible, openPeerArgs,
} = initPeersUi({
  sessions, sessionList, getActiveSession: () => activeSession,
  createTerminal, switchSession, removeSession, updateSidebarActive,
  showToast, appendIpcEntry, remeasureReadonlyPeer,
  peerStatuses, peerTunnels, peerWebTunnels, getOurAppVersion: () => ourAppVersion,
  // Peer state changes the terminal tab's availability without a session
  // switch, which is the only thing the host re-asks on.
  syncSeatAvailability: () => drawerHost.syncSeatAvailability(),
  getDeployLineHandlers: () => deployLineHandlers,
  proxyState, ctxPct, ctxTokens, peerFilesCount, filesUnseen,
  applyCtxBadge, applyWarmBadge, renderProxyBar,
  openFilePeek, isFilesPopoverForKey,
  openArgsDialog,
  openSkillsPopover,
});


const { openSearch, closeSearch, isSearchOpen, setSearchInfo } =
  createTermSearch({ sessions, getActiveSession: () => activeSession });


function refitActiveTerminal() {
  if (!activeSession) return;
  const s = sessions.get(activeSession);
  if (!s) return;
  if (s.peer) {
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

window.api.onZoomNudge(refitActiveTerminal);


// Capture at document level (capture phase) so xterm doesn't swallow them
document.addEventListener('keydown', (e) => {
  if (!e.metaKey || e.altKey || e.ctrlKey) return;
  // Every chord below acts on the active SIDEBAR session, so focus inside the
  // drawer must not reach them — Cmd+W typed into a drawer tenant would
  // archive an unrelated session.
  if (drawerHost.hasFocus()) return;

  if (e.key === 't') {
    e.preventDefault();
    e.stopPropagation();
    if (dialogOverlay.classList.contains('hidden')) openDialog();
    return;
  }

  if (e.key === 'w') {
    e.preventDefault();
    e.stopPropagation();
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

  if (e.key === 'f' && !e.shiftKey) {
    if (activeSession) {
      e.preventDefault();
      e.stopPropagation();
      openSearch();
    }
    return;
  }

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

// Browser tabs reserve Cmd+T/W/1-9, so the web frontend mirrors them onto Alt. Classified
// by e.code in web-shortcuts.js (Option composes characters on macOS, so e.key is unusable).
// Same capture-phase + preventDefault so xterm never sees them. No-op in Electron.
document.addEventListener('keydown', (e) => {
  if (!window.__CLODEX_WEB__) return;
  const action = altChordAction(e);
  if (!action) return;
  if (drawerHost.hasFocus()) return; // same arbitration as the Cmd handler above
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



const { refreshDiagBanner } = initBanners({ openInstallSession });

window.api.onRequestSwitchSession((name) => switchSession(name));
window.api.onRequestOpenNewDialog(() => openDialog());

const discoveryOverlay = document.getElementById('discovery-overlay');
const discoveryList = document.getElementById('discovery-list');
const discoveryRefresh = document.getElementById('discovery-refresh');
const discoveryClose = document.getElementById('discovery-close');

function closeDiscovery() { discoveryOverlay.classList.add('hidden'); }

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

function adoptSession(rec) {
  closeDiscovery();
  const prefill = {
    name: suggestAdoptName(rec.cwd, rec.type),
    type: rec.type,
    cwd: rec.cwd || homeDir,
    resumeId: rec.sessionId,
  };
  if (!dialogOverlay.classList.contains('hidden')) {
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
const btnDiscover = document.getElementById('btn-discover');
if (btnDiscover) btnDiscover.addEventListener('click', () => openDiscovery());
const btnFindSession = document.getElementById('btn-find-session');
if (btnFindSession) btnFindSession.addEventListener('click', () => openDiscovery());


const prefsOverlay = document.getElementById('prefs-overlay');
const prefsClaudeBox = document.getElementById('prefs-claude-components');
const prefsClaudeCmd = document.getElementById('prefs-claude-sl-cmd');
const prefsCodexBox = document.getElementById('prefs-codex-components');
const prefsProxyEnabled = document.getElementById('prefs-proxy-enabled');
const prefsDisableDesignMcp = document.getElementById('prefs-disable-design-mcp');
const prefsCompactOnResume = document.getElementById('prefs-compact-on-resume');
const prefsContextHints = document.getElementById('prefs-context-hints');
const prefsSemanticHints = document.getElementById('prefs-semantic-hints');
const prefsSelectionHints = document.getElementById('prefs-selection-hints');
const prefsVoiceSubmit = document.getElementById('prefs-voice-submit');
const prefsVoiceSubmitComposition = document.getElementById('prefs-voice-submit-composition');
const prefsVoiceSubmitRearm = document.getElementById('prefs-voice-submit-rearm');
const prefsVoiceSubmitPhrase = document.getElementById('prefs-voice-submit-phrase');
const prefsSpeakReplies = document.getElementById('prefs-speak-replies');
const prefsSpeakVoice = document.getElementById('prefs-speak-voice');
const prefsSpeakRate = document.getElementById('prefs-speak-rate');
const prefsCtxNudge = document.getElementById('prefs-ctx-nudge');
const prefsCtxEscalate = document.getElementById('prefs-ctx-escalate');
const prefsCtxModels = document.getElementById('prefs-ctx-models');
const prefsTerminalReports = document.getElementById('prefs-terminal-reports');
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
const prefsPeerShell = document.getElementById('prefs-peer-shell');

const prefsEnvScope = document.getElementById('prefs-env-scope');
const prefsEnvList = document.getElementById('prefs-env-list');
const prefsEnvKey = document.getElementById('prefs-env-key');
const prefsEnvValue = document.getElementById('prefs-env-value');
const prefsEnvSecret = document.getElementById('prefs-env-secret');
const prefsEnvAdd = document.getElementById('prefs-env-add');
const prefsEnvState = document.getElementById('prefs-env-state');

function prefsEnvScopeArg() {
  return prefsEnvScope && prefsEnvScope.value === 'workspace'
    ? (currentWorkspaceId || 'default')
    : 'global';
}

function setPrefsEnvState(msg, kind) {
  if (!prefsEnvState) return;
  prefsEnvState.textContent = msg || '';
  prefsEnvState.style.color = kind === 'error' ? 'var(--warn, #d9a55b)' : 'var(--muted, #8b949e)';
}

async function refreshPrefsEnv() {
  if (!prefsEnvList) return;
  const scope = prefsEnvScopeArg();
  const res = await window.api.envScopesGet(scope);
  prefsEnvList.textContent = '';
  if (!res || res.ok === false) {
    setPrefsEnvState((res && res.error) || 'Environment scopes unavailable on this host.', 'error');
    return;
  }
  setPrefsEnvState('');
  const vars = res.vars || [];
  if (!vars.length) {
    const empty = document.createElement('span');
    empty.className = 'hint-text';
    empty.textContent = 'No variables set for this scope.';
    prefsEnvList.appendChild(empty);
    return;
  }
  for (const v of vars) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:4px;';
    const keyEl = document.createElement('code');
    keyEl.textContent = v.key;
    keyEl.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis;';
    const valEl = document.createElement('span');
    valEl.className = 'hint-text';
    valEl.style.cssText = 'flex:2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    valEl.textContent = v.secret ? '•••••••• (secret — set)' : String(v.value == null ? '' : v.value);
    const editBtn = document.createElement('button');
    editBtn.className = 'secondary';
    editBtn.type = 'button';
    editBtn.style.flex = 'none';
    editBtn.textContent = v.secret ? 'Replace' : 'Edit';
    editBtn.addEventListener('click', () => {
      prefsEnvKey.value = v.key;
      prefsEnvValue.value = v.secret ? '' : String(v.value == null ? '' : v.value);
      prefsEnvSecret.checked = !!v.secret;
      prefsEnvValue.focus();
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'secondary';
    delBtn.type = 'button';
    delBtn.style.flex = 'none';
    delBtn.textContent = '×';
    delBtn.title = `Delete ${v.key}`;
    delBtn.addEventListener('click', async () => {
      const r = await window.api.envScopesDelete(scope, v.key);
      if (!r || r.ok === false) { setPrefsEnvState((r && r.error) || 'Delete failed.', 'error'); return; }
      refreshPrefsEnv();
    });
    row.append(keyEl, valEl, editBtn, delBtn);
    prefsEnvList.appendChild(row);
  }
}

async function addPrefsEnvVar() {
  const key = (prefsEnvKey.value || '').trim();
  const value = prefsEnvValue.value || '';
  const secret = !!(prefsEnvSecret && prefsEnvSecret.checked);
  if (!key) { setPrefsEnvState('Enter a KEY first.', 'error'); return; }
  // A secret's value never round-trips into the field (Replace seeds it empty), so
  // an empty value on a secret set would silently blank the stored credential —
  // refuse it rather than overwrite the secret with "". A non-secret empty value
  // (KEY set to the empty string) is legitimate and allowed.
  if (secret && !value) { setPrefsEnvState('Enter the secret value to set or replace it (empty would blank it).', 'error'); return; }
  const res = await window.api.envScopesSet(prefsEnvScopeArg(), key, value, secret);
  if (!res || res.ok === false) { setPrefsEnvState((res && res.error) || 'Set failed.', 'error'); return; }
  prefsEnvKey.value = '';
  prefsEnvValue.value = '';
  if (prefsEnvSecret) prefsEnvSecret.checked = false;
  setPrefsEnvState(`Saved ${key}.`);
  refreshPrefsEnv();
}

if (prefsEnvAdd) prefsEnvAdd.addEventListener('click', addPrefsEnvVar);
if (prefsEnvScope) prefsEnvScope.addEventListener('change', () => { setPrefsEnvState(''); refreshPrefsEnv(); });

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

const WS_DOT = { managed: '#3fb950', external: '#58a6ff', starting: '#d29922', installing: '#d29922', stopped: '#888', error: '#f85149' };

function renderWsStatus(st) {
  if (wsRestartBusy) return; // hold the "Restarting…" line against the poll
  const err = st && st.error;
  let color = WS_DOT[st ? st.state : 'stopped'] || '#888';
  let text;
  if (st && st.state === 'managed') {
    text = `Active${st.version ? ' — ' + st.version : ''}`;
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

const peersListBox = document.getElementById('peers-list');
const peersOverlay = document.getElementById('peers-overlay');

const { parseDeployLine, classifyDeployFolder, classifyPeerDest } = require('../peer-deploy');
const deployLineHandlers = new Map(); // sshHost -> (line) => void
window.api.onPeerDeployLine((sshHost, line) => {
  const h = deployLineHandlers.get(sshHost);
  if (h) h(line);
});

function collapsePeerRow(wrap) {
  if (wrap._refreshSummary) wrap._refreshSummary();
  wrap.classList.add('collapsed');
}

function addPeerRow(peer, { expanded = false } = {}) {
  const emptyHint = peersListBox.querySelector('.peers-empty');
  if (emptyHint) emptyHint.remove();
  if (expanded) peersListBox.querySelectorAll('.peer-row-wrap').forEach((w) => collapsePeerRow(w));
  const wrap = document.createElement('div');
  wrap.className = expanded ? 'peer-row-wrap' : 'peer-row-wrap collapsed';
  const row = document.createElement('div');
  row.className = 'peer-row';
  row.dataset.peerId = peer.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
  const portVal = Number.isInteger(peer.remotePort) ? peer.remotePort : 7900;
  const liveSrc = (peer.id && peerStatuses.get(peer.id) && peerStatuses.get(peer.id).online)
    ? (peerStatuses.get(peer.id).srcDir || '') : '';
  const folderReported = !!(liveSrc && typeof liveSrc === 'string' && liveSrc.trim());
  const folderVal = folderReported
    ? liveSrc.trim()
    : ((typeof peer.deployFolder === 'string' && peer.deployFolder) ? peer.deployFolder : '~/wb-wrap-ui');
  const cloud = peerCloudDest(peer);
  const destVal = peer.sshHost || (cloud ? cloud.text : '') || peer.url || '';
  // Fields with NO input of their own (ssm region/profile, kubectl namespace/context, gcloud
  // zone/project, and every az field) are stashed on the row so collectPeers carries them
  // back on save — without this, opening the dialog and pressing Save silently erases them.
  row._cloudExtra = cloud ? { kind: cloud.kind, rest: cloud.rest } : null;
  row.innerHTML = `
    <input type="text" class="peer-row-label" placeholder="label (e.g. laptop2)" value="${esc(peer.label || '')}">
    <input type="text" class="peer-row-dest" placeholder="user@host / http://… / ssm:TARGET / k8s:svc/name / gcp:INSTANCE" value="${esc(destVal)}">
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
  const status = document.createElement('div');
  status.className = 'peer-row-status hidden';
  row.querySelector('.peer-row-remove').addEventListener('click', () => wrap.remove());
  row.querySelector('.peer-row-test').addEventListener('click', () => peerTestAndSetUp(row, status));
  const destInput = row.querySelector('.peer-row-dest');
  destInput.addEventListener('input', () => updatePeerDestBadge(row));
  updatePeerDestBadge(row); // reflect a pre-filled destination immediately
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
  const st = peer.id && peerStatuses.get(peer.id);
  if (st && st.online && st.version) {
    const capList = (st.caps || []).join(', ') || 'none';
    const sev = ourAppVersion ? versionSeverity(ourAppVersion, st.version) : 'unknown';
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

function peerRowDest(row) {
  const el = row.querySelector('.peer-row-dest');
  return el ? el.value.trim() : '';
}

// Duplicates the kind tables in stores.js (PEER_CLOUD_KINDS) and peer-tunnel.js (CLOUD_KINDS)
// on purpose: those are main-process modules and this decides only what the dialog SAYS.
// `cli` is named in the badge because "it needs that CLI on YOUR machine" is the misconfig
// a cloud destination invites.
// `az` is absent deliberately — it has no destination-field syntax, so it arrives by import
// and is carried through a save by _cloudExtra like any other unedited field.
const PEER_CLOUD_UI = {
  ssm:     { name: 'AWS SSM',   cli: 'aws',     field: 'target',   prefix: 'ssm:' },
  kubectl: { name: 'kubectl',   cli: 'kubectl', field: 'target',   prefix: 'k8s:' },
  gcloud:  { name: 'GCP IAP',   cli: 'gcloud',  field: 'instance', prefix: 'gcp:' },
};

function peerCloudDest(peer) {
  for (const kind of ['ssm', 'kubectl', 'gcloud', 'az']) {
    const block = peer && peer[kind];
    if (!block || typeof block !== 'object') continue;
    const ui = PEER_CLOUD_UI[kind];
    const shown = ui ? ui.field : null;
    const rest = {};
    for (const [k, v] of Object.entries(block)) if (k !== shown && v) rest[k] = v;
    return {
      kind, rest,
      text: (ui && block[ui.field]) ? `${ui.prefix}${block[ui.field]}` : '',
    };
  }
  return null;
}

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
  else if (PEER_CLOUD_UI[cls.kind]) {
    const ui = PEER_CLOUD_UI[cls.kind];
    badge.innerHTML = `<span class="peer-status-dim">→ ${esc(ui.name)} tunnel (needs the ${esc(ui.cli)} CLI locally)</span>`;
  } else badge.innerHTML = `<span class="peer-status-warn">${esc(cls.error)}</span>`;
}

function peerRowPort(row) {
  const el = row.querySelector('.peer-row-port');
  const raw = el ? el.value.trim() : '';
  return raw === '' ? NaN : parseInt(raw, 10);
}

function peerRowFolder(row) {
  const el = row.querySelector('.peer-row-folder');
  return el ? el.value.trim() : '';
}

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

async function peerTestAndSetUp(row, status) {
  const dest = classifyPeerDest(peerRowDest(row));
  if (dest.kind === 'empty') { renderPeerStatus(status, `<span class="peer-status-warn">Enter an ssh host or URL first (e.g. user@laptop2).</span>`); return; }
  if (dest.kind === 'error') { renderPeerStatus(status, `<span class="peer-status-warn">${esc(dest.error)}</span>`); return; }
  if (dest.kind === 'url') {
    renderPeerStatus(status, `<span class="peer-status-dim">Direct URL — nothing to install over ssh; Save and it connects.</span>`);
    return;
  }
  if (PEER_CLOUD_UI[dest.kind]) {
    const ui = PEER_CLOUD_UI[dest.kind];
    const vs = validatePeerRowInputs(row);
    if (!vs.ok) { renderPeerStatus(status, `<span class="peer-status-warn">${esc(vs.error)}</span>`); return; }
    renderPeerStatus(status,
      `<span class="peer-status-dim">${esc(ui.name)} tunnel — Test &amp; Set Up is ssh-only, because installing runs a shell and copies files over ssh and a port-forward carries neither.</span>` +
      `<div class="peer-status-note">Clodex must already be running on the target, listening on port ${esc(String(vs.port))}. Install it there yourself, then Save — the tunnel connects automatically. Needs the <code>${esc(ui.cli)}</code> CLI on THIS machine.</div>`);
    return;
  }
  const sshHost = dest.sshHost;
  const v = validatePeerRowInputs(row);
  if (!v.ok) { renderPeerStatus(status, `<span class="peer-status-warn">${esc(v.error)}</span>`); return; }
  const port = v.port;
  const testBtn = row.querySelector('.peer-row-test');
  testBtn.disabled = true;
  renderPeerStatus(status, `<span class="peer-status-dim">ssh <span class="peer-spin">…</span> connecting to ${esc(sshHost)}</span>`);
  const tokenEl = row.querySelector('.peer-row-token');
  const typedToken = tokenEl ? tokenEl.value.trim() : '';
  const probeOpts = { peerId: row.dataset.peerId };
  if (typedToken) probeOpts.token = typedToken;
  let res;
  try { res = await window.api.peerProbe(sshHost, port, probeOpts); }
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
  } else if (res.kind === 'auth-required') {
    if (res.tokenSent) {
      renderPeerStatus(status,
        `<span class="peer-status-ok">✓ ssh</span><span class="peer-status-warn"> · Clodex is running on 127.0.0.1:${port}, but it rejected that auth token.</span>` +
        `<div class="peer-status-note">Check the token below matches <code>CLODEX_REMOTE_TOKEN</code> on the peer, then Test again.</div>`);
    } else {
      renderPeerStatus(status,
        `<span class="peer-status-ok">✓ ssh</span><span class="peer-status-warn"> · something is answering on 127.0.0.1:${port} and requires an auth token — most likely a token-protected Clodex.</span>` +
        `<div class="peer-status-note">Enter the peer's <code>CLODEX_REMOTE_TOKEN</code> in the token field below, then Test again.</div>`);
    }
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
    if (!sudoCmds.length) tailBox.innerHTML = `<div class="peer-status-warn">Needs sudo on the peer — see the peer's terminal, then Test &amp; Set Up again.</div>`;
    appendDeployActions(tailBox, row, status, sshHost, port, null);
  } else {
    const why = res && res.timedOut ? 'timed out' : (res && res.error) ? res.error : `exit ${res ? res.code : '?'}`;
    const tail = res && res.stderr ? `<pre class="peer-status-pre">${esc(res.stderr)}</pre>` : '';
    tailBox.innerHTML = `<div class="peer-status-err">Install did not finish (${esc(String(why))}).</div>${tail}`;
    const logText = logLines.join('\n') + (res && res.stderr ? `\n\n[stderr]\n${res.stderr}` : '');
    appendDeployActions(tailBox, row, status, sshHost, port, logText);
  }
}

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

function collectPeers() {
  const out = [];
  for (const row of peersListBox.querySelectorAll('.peer-row')) {
    const destEl = row.querySelector('.peer-row-dest');
    if (destEl) destEl.classList.remove('invalid');
    let dest = classifyPeerDest(peerRowDest(row));
    // An unshowable cloud peer (az: no destination-field syntax) leaves the dest input blank,
    // so classifyPeerDest says 'empty'. Without rewriting it as a dest here the row would be
    // skipped — opening the dialog and pressing Save would silently delete every az peer.
    const unshowable = (dest.kind === 'empty' && row._cloudExtra && !PEER_CLOUD_UI[row._cloudExtra.kind])
      ? { kind: row._cloudExtra.kind, [row._cloudExtra.kind]: { ...row._cloudExtra.rest } }
      : null;
    if (unshowable) dest = unshowable;
    if (dest.kind === 'empty') continue;
    const label = row.querySelector('.peer-row-label').value.trim();
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
    const cloudBlock = (PEER_CLOUD_UI[dest.kind] || unshowable) ? dest[dest.kind] : null;
    const peer = {
      id: row.dataset.peerId,
      label: label || dest.sshHost || dest.url
        || (PEER_CLOUD_UI[dest.kind] && cloudBlock && cloudBlock[PEER_CLOUD_UI[dest.kind].field])
        || dest.kind,
    };
    if (dest.kind === 'ssh') peer.sshHost = dest.sshHost;
    else if (dest.kind === 'url') peer.url = dest.url;
    else if (cloudBlock) {
      // Carry back the stashed settings-file-only fields, but only when the KIND is unchanged:
      // retyping the destination as a different cloud would otherwise graft the old kind's
      // selectors onto the new block.
      const carried = (row._cloudExtra && row._cloudExtra.kind === dest.kind) ? row._cloudExtra.rest : {};
      peer[dest.kind] = { ...cloudBlock, ...carried };
    }
    peer.remotePort = v.port;
    if (v.folder) peer.deployFolder = v.folder;
    // Write-only token: a typed value SETS it, the clear checkbox sends '' to delete it, and a
    // blank field OMITS the key so the stored token carries forward (the dialog only ever
    // knows hasToken, never the value). Typed wins over clear if both are set.
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

const peersImportBox = document.getElementById('peers-import-box');

function closePeersImport() {
  peersImportBox.classList.add('hidden');
  peersImportBox.innerHTML = '';
}

async function openPeersImport() {
  peersImportBox.classList.remove('hidden');
  peersImportBox.innerHTML = '<span class="peer-status-dim">Reading clodexctl contexts…</span>';
  let res;
  try { res = await window.api.peerImportPreview(); }
  catch (e) { res = { ok: false, error: e && e.message ? e.message : String(e) }; }
  if (!res || !res.ok) {
    peersImportBox.innerHTML = `<span class="peer-status-err">${esc((res && res.error) || 'could not read the contexts file')}</span>`;
    return;
  }
  renderPeersImport(res);
}

function renderPeersImport(res) {
  const cands = Array.isArray(res.candidates) ? res.candidates : [];
  const addable = cands.filter((c) => c.action === 'add');
  const parts = [];
  parts.push(`<div class="peer-status-dim">${esc(res.file || 'contexts.json')}</div>`);
  for (const w of Array.isArray(res.warnings) ? res.warnings : []) {
    parts.push(`<div class="peer-status-warn">${esc(w)}</div>`);
  }
  if (cands.length === 0) {
    parts.push('<div class="peer-status-note">No contexts found. Add one with <code>clodexctl ctx add</code>.</div>');
  }
  for (const c of cands) {
    const tok = c.tokenState === 'set' ? 'token set' : 'no token';
    if (c.action === 'add') {
      parts.push(
        `<label class="peers-import-row">`
        + `<input type="checkbox" class="peers-import-check" data-name="${esc(c.name)}" checked>`
        + `<span class="peers-import-name">${esc(c.name)}</span>`
        + `<span class="peers-import-target">${esc(c.kind)} · ${esc(c.target)} · ${esc(tok)}</span>`
        + `</label>`,
      );
    } else {
      parts.push(
        `<div class="peers-import-row">`
        + `<span style="flex:0 0 14px"></span>`
        + `<span class="peers-import-name peer-status-dim">${esc(c.name)}</span>`
        + `<span class="peers-import-target">${esc(c.reason || 'skipped')}</span>`
        + `</div>`,
      );
    }
  }
  parts.push('<div class="peer-status-note">Importing COPIES the destination and its token. Editing the context later does not change the peer, and editing the peer does not change the context.</div>');
  parts.push(
    '<div class="peer-status-actions">'
    + `<button type="button" class="peers-import-go"${addable.length ? '' : ' disabled'}>Import ${addable.length || ''}</button>`
    + '<button type="button" class="secondary peers-import-cancel">Cancel</button>'
    + '</div>',
  );
  peersImportBox.innerHTML = parts.join('');
  peersImportBox.querySelector('.peers-import-cancel').addEventListener('click', closePeersImport);
  peersImportBox.querySelector('.peers-import-go').addEventListener('click', async () => {
    const names = [...peersImportBox.querySelectorAll('.peers-import-check')]
      .filter((el) => el.checked).map((el) => el.dataset.name);
    if (names.length === 0) return;
    peersImportBox.innerHTML = '<span class="peer-status-dim">Importing…</span>';
    let out;
    try { out = await window.api.peerImportApply(names); }
    catch (e) { out = { ok: false, error: e && e.message ? e.message : String(e) }; }
    if (!out || !out.ok) {
      peersImportBox.innerHTML = `<span class="peer-status-err">${esc((out && out.error) || 'import failed')}</span>`;
      return;
    }
    closePeersImport();
    await openPeersDialog();
    if (Array.isArray(out.rejected) && out.rejected.length) {
      peersImportBox.classList.remove('hidden');
      peersImportBox.innerHTML =
        `<span class="peer-status-warn">Imported ${out.imported.length}; `
        + `${esc(out.rejected.join(', '))} could not be saved as ${out.rejected.length === 1 ? 'a peer' : 'peers'}.</span>`;
    }
  });
}

document.getElementById('peers-import').addEventListener('click', () => {
  if (peersImportBox.classList.contains('hidden')) openPeersImport();
  else closePeersImport();
});

async function boxPeerIds() {
  try { return new Set(((await window.api.sandboxListBoxes()) || []).map((b) => b && b.id).filter(Boolean)); }
  catch { return new Set(); }
}

async function openPeersDialog() {
  const s = await window.api.getSettings();
  peersListBox.innerHTML = '';
  closePeersImport();   // never leave a stale preview from a previous open
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
  // Re-merge the managed box peers FRESH at write time, never from a dialog-open stash: a box
  // Rebuild since open re-registers its peer with a new url/token, and setSettings replaces the
  // whole peers array. Strip hasToken (derived); omitted tokens carry forward by id.
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

// Reads `plugins.status`, not `catalog()`: catalog lists what successfully registered, which
// by definition excludes the plugin you came here to fix.
// Toggling applies IMMEDIATELY (its own await, no Save button) — enable/disable tears down
// live DOM in every window, so a Cancel that silently left the plugin gone would be a lie.
const pluginsOverlay = document.getElementById('plugins-overlay');
const pluginsList = document.getElementById('plugins-list');

function closePluginsDialog() { pluginsOverlay.classList.add('hidden'); }

async function openPluginsDialog() {
  await renderPluginsDialog();
  pluginsOverlay.classList.remove('hidden');
}

async function renderPluginsDialog() {
  if (!pluginsList) return;
  let status = null;
  try { status = await window.api.pluginInvoke('_host', 'plugins.status'); } catch {}
  const plugins = (status && status.ok && status.plugins) || [];
  const problems = (status && status.ok && status.problems) || [];
  const shadowed = (status && status.ok && status.shadowed) || [];
  pluginsList.innerHTML = '';
  if (!plugins.length && !problems.length && !shadowed.length) {
    const empty = document.createElement('div');
    empty.className = 'plugin-row-note';
    empty.textContent = 'No plugins are installed.';
    pluginsList.appendChild(empty);
  }
  for (const p of plugins) {
    const row = document.createElement('div');
    row.className = 'plugin-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!p.enabled;
    cb.addEventListener('change', async () => {
      cb.disabled = true;
      try { await window.api.pluginSetEnabled(p.id, cb.checked); } catch {}
      cb.disabled = false;
      await renderPluginsDialog();
    });
    const body = document.createElement('div');
    body.className = 'plugin-row-body';
    const nameEl = document.createElement('div');
    nameEl.className = 'plugin-row-name';
    nameEl.textContent = p.name || p.id;
    if (p.version) {
      const v = document.createElement('span');
      v.className = 'plugin-row-version';
      v.textContent = `v${p.version}`;
      nameEl.appendChild(v);
    }
    body.appendChild(nameEl);
    if (p.description) {
      const d = document.createElement('div');
      d.className = 'plugin-row-note';
      d.textContent = p.description;
      body.appendChild(d);
    }
    if (p.verbConflict) {
      const n = document.createElement('div');
      n.className = 'plugin-row-note warn';
      n.textContent = `Not running: it uses the intent verb [agent:${p.verbConflict.verb}], which the "${p.verbConflict.heldBy}" plugin already registered. Two plugins cannot share a verb — disable one of them.`;
      body.appendChild(n);
    } else if (p.restartRequired) {
      // Node's require cache is keyed by path: the code in memory is the OLD code no matter
      // what the manifest beside it now says, and the version shown on this row comes from
      // that manifest — displaying it silently would claim an upgrade never performed.
      const n = document.createElement('div');
      n.className = 'plugin-row-note warn';
      const was = p.restartRequired.was ? `v${p.restartRequired.was}` : 'no version';
      const now = p.restartRequired.now ? `v${p.restartRequired.now}` : 'no version';
      n.textContent = p.restartRequired.dirChanged
        ? `Restart required: a different copy of this plugin (${now}) now wins, but the ${was} copy loaded at startup is still the one running.`
        : `Restart required: the files on disk changed (${was} → ${now}), but the ${was} code loaded at startup is still the one running. Quit and reopen Clodex to pick this up.`;
      body.appendChild(n);
    } else if (p.quarantined || p.failCount) {
      const n = document.createElement('div');
      n.className = 'plugin-row-note warn';
      n.textContent = p.quarantined
        ? `Disabled automatically: activate() threw on ${p.failCount} consecutive launches — ${p.lastError || 'unknown error'}`
        : `Failed to activate once (${p.lastError || 'unknown error'}) — one more and it will be held back.`;
      body.appendChild(n);
    }
    row.appendChild(cb);
    row.appendChild(body);
    if (p.quarantined) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'secondary';
      retry.textContent = 'Retry';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        let r = null;
        try { r = await window.api.pluginSetEnabled(p.id, true); } catch {}
        if (r && r.ok) showToast(`${p.name || p.id} activated.`, { kind: 'peer-ui' });
        else showToast(`${p.name || p.id} failed again: ${(r && r.error) || 'unknown error'}`, { kind: 'error', duration: 9000 });
        await renderPluginsDialog();
      });
      row.appendChild(retry);
    }
    pluginsList.appendChild(row);
    if (pluginBar.settingsSectionOwners().includes(p.id)) {
      pluginsList.appendChild(makePluginSettingsPanel(p, row));
    }
  }
  for (const pr of problems) {
    const row = document.createElement('div');
    row.className = 'plugin-row';
    const body = document.createElement('div');
    body.className = 'plugin-row-body';
    const nameEl = document.createElement('div');
    nameEl.className = 'plugin-row-name';
    nameEl.textContent = pr.dir;
    body.appendChild(nameEl);
    const n = document.createElement('div');
    n.className = 'plugin-row-note warn';
    n.textContent = `Not loaded: ${pr.why}`;
    body.appendChild(n);
    row.appendChild(body);
    pluginsList.appendChild(row);
  }
  // No toggle: the enabled flag is keyed by bare id and belongs to whichever copy WON, so a
  // checkbox here would toggle the other plugin.
  // The loser can be the BUILT-IN copy (a higher-versioned user copy supersedes it), so a user
  // plugin declaring version 99 wins forever. The row must name both versions or a user has no
  // way to work out why their update did nothing.
  for (const sh of shadowed) {
    const row = document.createElement('div');
    row.className = 'plugin-row';
    const body = document.createElement('div');
    body.className = 'plugin-row-body';
    const nameEl = document.createElement('div');
    nameEl.className = 'plugin-row-name';
    nameEl.textContent = sh.id;
    if (sh.rootLabel) {
      const r = document.createElement('span');
      r.className = 'plugin-row-version';
      r.textContent = sh.version ? `${sh.rootLabel} v${sh.version}` : sh.rootLabel;
      nameEl.appendChild(r);
    }
    body.appendChild(nameEl);
    const n = document.createElement('div');
    n.className = 'plugin-row-note warn';
    const mine = sh.version ? `v${sh.version}` : 'no version';
    const winner = sh.shadowedByLabel || sh.shadowedBy;
    const theirs = sh.shadowedByVersion ? `v${sh.shadowedByVersion}` : 'no version';
    if (sh.reason === 'superseded') {
      n.textContent = `Not running: this ${sh.rootLabel || sh.root} copy is ${mine} and the ${winner} copy is ${theirs} — the higher version wins.`;
    } else if (!sh.comparable) {
      n.textContent = `Not running: shadowed by the ${winner} copy (${theirs}). This copy's version (${sh.version ? JSON.stringify(sh.version) : 'missing'}) is not a plain number like 1.2.0, so it can never take over — fix the version to supersede it.`;
    } else {
      n.textContent = `Not running: shadowed by the ${winner} copy of the same id (${theirs}). This copy is ${mine}; a user copy only takes over when its version is higher.`;
    }
    body.appendChild(n);
    if (sh.dir) {
      const d = document.createElement('div');
      d.className = 'plugin-row-note';
      d.textContent = sh.dir;
      body.appendChild(d);
    }
    row.appendChild(body);
    pluginsList.appendChild(row);
  }
}

// A plugin's own settings live with the plugin, not in Preferences. The panel is INLINE under
// the row rather than a second overlay: #prefs-overlay and #plugins-overlay are siblings with no
// stacking manager, so a dialog opened over a dialog is a layering bug, and Escape would close
// the wrong one.
function makePluginSettingsPanel(p, row) {
  const panel = document.createElement('div');
  panel.className = 'plugin-settings-panel hidden';
  const sections = document.createElement('div');
  panel.appendChild(sections);
  const actions = document.createElement('div');
  actions.className = 'plugin-settings-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Save';
  actions.appendChild(save);
  panel.appendChild(actions);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'secondary';
  toggle.textContent = 'Settings';
  toggle.addEventListener('click', async () => {
    if (!panel.classList.contains('hidden')) {
      panel.classList.add('hidden');
      return;
    }
    let values = {};
    try {
      const r = await window.api.pluginInvoke('_host', 'settings.get', [p.id]);
      if (r && r.ok) values = r.values || {};
    } catch {}
    pluginBar.renderSectionsInto(p.id, sections, values);
    panel.classList.remove('hidden');
  });
  row.appendChild(toggle);

  save.addEventListener('click', async () => {
    const patch = pluginBar.collectSectionsFrom(p.id, sections);
    if (patch) {
      save.disabled = true;
      let r = null;
      try { r = await window.api.pluginInvoke('_host', 'settings.set', [p.id, patch]); } catch {}
      save.disabled = false;
      if (!r || !r.ok) {
        showToast(`Could not save ${p.name || p.id} settings: ${(r && r.error) || 'unknown error'}`, { kind: 'error' });
        return;
      }
    }
    panel.classList.add('hidden');
  });
  return panel;
}

// On web this is a DIFFERENT action, not a degraded one: revealing in a file manager would
// open the folder on the machine holding the browser, while the plugins live on the machine
// running the engine. So the browser shows the engine's path and listing instead.
const pluginsFolderPanel = document.getElementById('plugins-folder');

async function showPluginsFolderListing() {
  if (!pluginsFolderPanel) return;
  let r = null;
  try { r = await window.api.pluginInvoke('_host', 'plugins.listUserRoot'); } catch {}
  if (!r || !r.ok || !r.dir) {
    showToast(`Could not locate the plugins folder: ${(r && r.error) || 'unknown error'}`, { kind: 'error' });
    return;
  }
  pluginsFolderPanel.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'plugin-row-note';
  head.textContent = `Plugins folder on the Clodex host: ${r.dir}`;
  pluginsFolderPanel.appendChild(head);
  const body = document.createElement('div');
  body.className = 'plugin-row-note';
  if (r.entries === null) {
    body.classList.add('warn');
    body.textContent = `Could not read it: ${r.error || 'unknown error'}`;
  } else if (!r.entries.length) {
    body.textContent = 'Empty — drop a plugin directory here on the host, then Re-scan.';
  } else {
    body.textContent = r.entries.map((e) => (e.isDir ? `${e.name}/` : e.name)).join('   ');
  }
  pluginsFolderPanel.appendChild(body);
  pluginsFolderPanel.classList.remove('hidden');
}

document.getElementById('btn-plugins-reveal').addEventListener('click', async () => {
  if (window.__CLODEX_WEB__) { await showPluginsFolderListing(); return; }
  let r = null;
  try { r = await window.api.pluginInvoke('_host', 'plugins.userRoot'); } catch {}
  if (!r || !r.ok || !r.dir) {
    showToast(`Could not locate the plugins folder: ${(r && r.error) || 'unknown error'}`, { kind: 'error' });
    return;
  }
  try { await window.api.fileReveal(r.dir); } catch {}
});

if (window.__CLODEX_WEB__) {
  const revealBtn = document.getElementById('btn-plugins-reveal');
  if (revealBtn) {
    revealBtn.textContent = 'Show Plugins Folder';
    revealBtn.title = "Show the plugins folder on the machine running Clodex, and what is in it — a browser cannot open the host's file manager";
  }
}

document.getElementById('btn-plugins-rescan').addEventListener('click', async () => {
  const btn = document.getElementById('btn-plugins-rescan');
  btn.disabled = true;
  let r = null;
  try { r = await window.api.pluginInvoke('_host', 'plugins.rescan'); } catch {}
  btn.disabled = false;
  if (!r || !r.ok) {
    showToast(`Re-scan failed: ${(r && r.error) || 'unknown error'}`, { kind: 'error' });
    return;
  }
  const bits = [];
  if (r.added.length) bits.push(`${r.added.length} added`);
  if (r.removed.length) bits.push(`${r.removed.length} removed`);
  if (r.changed.length) bits.push(`${r.changed.length} changed (restart required)`);
  if (r.failed.length) bits.push(`${r.failed.length} failed`);
  showToast(bits.length ? `Re-scan: ${bits.join(', ')}.` : 'Re-scan: no changes.', {
    kind: r.failed.length ? 'error' : 'peer-ui',
  });
  await renderPluginsDialog();
});

document.getElementById('btn-plugins-close').addEventListener('click', closePluginsDialog);
pluginsOverlay.addEventListener('mousedown', (e) => { if (e.target === pluginsOverlay) closePluginsDialog(); });
window.api.onRequestOpenPluginsDialog(() => openPluginsDialog());

const sandboxOverlay = document.getElementById('sandbox-overlay');
const sbDockerRow = document.getElementById('sandbox-docker');
const sbStatusRow = document.getElementById('sandbox-status');
const sbWorkdir = document.getElementById('sandbox-workdir');
const sbAutoStart = document.getElementById('sandbox-autostart');
const sbToggleBtn = document.getElementById('btn-sandbox-toggle');
const sbRebuildBtn = document.getElementById('btn-sandbox-rebuild');
const sbOpenRow = document.getElementById('sandbox-open-row');
const sbOpenLink = document.getElementById('sandbox-open-link');
const sbPortsLine = document.getElementById('sandbox-ports-line');
const sbToken = document.getElementById('sandbox-token');
const sbTokenSave = document.getElementById('sandbox-token-save');
const sbTokenClear = document.getElementById('sandbox-token-clear');
const sbMountsList = document.getElementById('sandbox-mounts-list');
const sbMountsAdd = document.getElementById('sandbox-mounts-add');
const sbMountsRestart = document.getElementById('sandbox-mounts-restart');
const sbBoxList = document.getElementById('sandbox-box-list');
const sbBoxNewId = document.getElementById('sandbox-box-new-id');
const sbBoxCreate = document.getElementById('sandbox-box-create');
const sbBoxNew = document.getElementById('sandbox-box-new');   // the create-box row (dimmed while gated)
const sbDetail = document.getElementById('sandbox-detail');
const sbDetailLabel = document.getElementById('sandbox-detail-label');
const sbDeleteBtn = document.getElementById('btn-sandbox-delete');
let sbPollTimer = null;
let sbRunning = false;
let sbBusy = false;
// Init PESSIMISTIC (running:false) so the markup opens disabled: the docker probe can take
// seconds when the daemon is down, and an optimistic default would flash an enabled Start/
// Rebuild. The probe's catch{} falls back here, never to a stale good gate.
const SB_GATE_UNKNOWN = { running: false, notice: { kind: 'idle', text: 'Checking Docker…' }, reason: 'Checking Docker…' };
let sbGate = SB_GATE_UNKNOWN;
let sbEffectivePorts = null;
let sbCurrentBox = 'sandbox';
let sbBoxes = [];
let sbMounts = [];
let sbMountsDirty = false;

function renderSandboxNotice(row, notice) {
  row.innerHTML = '';
  const dot = document.createElement('span');
  dot.className = `sandbox-dot ${notice.kind}`;
  row.appendChild(dot);
  row.appendChild(document.createTextNode(notice.text));
}

function effectiveWebPort() {
  return (sbEffectivePorts && sbEffectivePorts.web) || 7810;
}

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
    // The live url deliberately does NOT go in `href` (t445): the click handler
    // routes through openExternal so the browser frontend can refuse a link that
    // points at the box's loopback, and a real href hands cmd-click and
    // middle-click a path straight around that gate. `title` carries the address
    // instead, for anyone who wants to read or copy it — the ports line above
    // shows the port number, not a url.
    sbOpenLink.title = sandboxOpenUrl(effectiveWebPort());
    sbOpenRow.classList.remove('hidden');
  } else {
    sbOpenRow.classList.add('hidden');
  }
}

function applyActionGate() {
  const t = sandboxGateTreatment(sbGate, sbRunning);
  sbToggleBtn.disabled = sbBusy || t.startDisabled;
  sbRebuildBtn.disabled = sbBusy || t.rebuildDisabled;
  sbBoxCreate.disabled = t.boxCreateDisabled;
  sbToggleBtn.title = t.startDisabled ? (t.reason || '') : '';
  sbRebuildBtn.title = t.rebuildDisabled ? (t.reason || '') : '';
  sbBoxCreate.title = t.boxCreateDisabled ? (t.reason || '') : '';
  sbToggleBtn.classList.toggle('sandbox-gated', t.dimStart);
  sbRebuildBtn.classList.toggle('sandbox-gated', t.dimRebuild);
  if (sbBoxNew) sbBoxNew.classList.toggle('sandbox-gated', t.dimBoxCreate);
  sbDockerRow.classList.toggle('sandbox-docker-banner', t.banner);
}

async function refreshSandboxStatus() {
  try {
    const [detect, status] = await Promise.all([
      window.api.sandboxDetect(sbCurrentBox),
      window.api.sandboxStatus(sbCurrentBox),
    ]);
    sbGate = sandboxActionGate(detect);
    renderSandboxNotice(sbDockerRow, sbGate.notice);
    const sn = sandboxStatusNotice(status && status.state);
    renderSandboxNotice(sbStatusRow, sn);
    // Update sbRunning BEFORE applyActionGate — the gate's Start-vs-Stop decision
    // reads sbRunning, and applying the gate on a stale value would mis-gate the
    // toggle right after a state flip (defect #1).
    if (!sbBusy) applySandboxRunning(sn.running, status && status.ports);
    applyActionGate();
    sbMountsRestart.classList.toggle('hidden', !(sbMountsDirty && sbRunning));
    const selRow = sbBoxList.querySelector('.sandbox-box-row.selected');
    if (selRow) {
      const dot = selRow.querySelector('.sandbox-dot');
      if (dot) dot.className = `sandbox-dot ${sn.kind}`;
      const tog = selRow.querySelector('.sandbox-box-toggle');
      if (tog && !sbBusy) {
        tog.textContent = sn.running ? 'Stop' : 'Start';
        const rowGated = boxRowStartGated(sbGate.running, sn.running);
        tog.disabled = rowGated;
        tog.classList.toggle('sandbox-gated', rowGated);
        tog.title = rowGated ? (sbGate.reason || '') : '';
      }
    }
  } catch {
    sbGate = SB_GATE_UNKNOWN;
    applyActionGate();
  }
}

function applyTokenState(hasToken) {
  sbToken.value = '';
  sbToken.placeholder = hasToken
    ? '•••••••• configured — paste a new token to replace'
    : 'Run `claude setup-token`, then paste the token here';
}

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

async function renderBoxList() {
  const boxes = sbBoxes;
  const [detect, notices] = await Promise.all([
    window.api.sandboxDetect(sbCurrentBox).catch(() => null),
    Promise.all(boxes.map((b) =>
      window.api.sandboxStatus(b.id).then((s) => sandboxStatusNotice(s && s.state)).catch(() => sandboxStatusNotice()))),
  ]);
  sbGate = sandboxActionGate(detect);
  applyActionGate();
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
    const rowStartGated = boxRowStartGated(sbGate.running, sn.running);
    tog.disabled = rowStartGated;
    tog.classList.toggle('sandbox-gated', rowStartGated);
    if (rowStartGated) tog.title = sbGate.reason || '';
    tog.addEventListener('click', (e) => { e.stopPropagation(); toggleBox(b.id, sn.running); });
    row.append(dot, label, tog);
    row.addEventListener('click', () => selectBox(b.id));
    sbBoxList.appendChild(row);
  });
}

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

function showDetail(show) { sbDetail.style.display = show ? '' : 'none'; }

async function selectBox(id) {
  if (sbBusy || id === sbCurrentBox) return;
  sbCurrentBox = id;
  await loadBoxDetail();
  await renderBoxList();
  await refreshSandboxStatus();
}

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
  if (sbPollTimer) clearInterval(sbPollTimer);
  sbPollTimer = setInterval(refreshSandboxStatus, 3000);
}

function closeSandboxDialog() {
  if (sbPollTimer) { clearInterval(sbPollTimer); sbPollTimer = null; }
  sandboxOverlay.classList.add('hidden');
}

// Ports are engine-managed and deliberately NOT collected: setConfig merges over the stored
// config, so the persisted port values survive only while this keeps omitting them.
function collectSandboxConfig() {
  return {
    workDir: sbWorkdir.value.trim() || null,
    autoStart: sbAutoStart.checked,
  };
}

const sbWorkdirPick = document.getElementById('sandbox-workdir-pick');
if (window.__CLODEX_WEB__) { sbWorkdirPick.classList.add('hidden'); sbMountsAdd.classList.add('hidden'); }
sbWorkdirPick.addEventListener('click', async () => {
  const dir = await window.api.selectDirectory();
  if (dir) sbWorkdir.value = dir;
});
document.getElementById('sandbox-workdir-clear').addEventListener('click', () => { sbWorkdir.value = ''; });

sbAutoStart.addEventListener('change', () => { window.api.sandboxSetConfig({ autoStart: sbAutoStart.checked }, sbCurrentBox); });

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
    applyActionGate();   // re-apply the docker gate (not a blanket enable)
    await refreshSandboxStatus();
  }
});

sbRebuildBtn.addEventListener('click', async () => {
  if (sbBusy) return;
  sbBusy = true;
  sbToggleBtn.disabled = true;
  sbRebuildBtn.disabled = true;
  sbRebuildBtn.textContent = 'Rebuilding…';
  try {
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
    sbRebuildBtn.textContent = 'Rebuild';
    applyActionGate();   // re-apply the docker gate (not a blanket enable)
    await refreshSandboxStatus();
  }
});

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
// fan → shim window.open) — and on web that fan is also the gate that refuses a
// box-loopback url, which is why the anchor carries no href to click around it.
sbOpenLink.addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal(sandboxOpenUrl(effectiveWebPort()));
});
// An anchor with no href does not synthesize a click on Enter, and role="button"
// promises Space as well — without this the control is announced as a button and
// is keyboard-dead.
sbOpenLink.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sbOpenLink.click(); }
});

document.getElementById('btn-sandbox-close').addEventListener('click', closeSandboxDialog);
sandboxOverlay.addEventListener('mousedown', (e) => { if (e.target === sandboxOverlay) closeSandboxDialog(); });
document.getElementById('btn-peers-sandbox').addEventListener('click', () => { closePeersDialog(); openSandboxDialog(); });
window.api.onRequestOpenSandboxDialog(() => openSandboxDialog());
window.api.onRequestOpenPeerSession((id, name) => openPeerSession(id, name));

// Which groups the operator left open. Every group ships CLOSED, so this is
// what stops a reopen from collapsing the section someone is working in.
// Collapsed groups keep their controls in the DOM, so Save is unaffected.
const PREFS_OPEN_KEY = 'clodex-prefs-open';
function prefsGroups() { return [...document.querySelectorAll('#prefs-dialog .prefs-group')]; }
function restorePrefsGroups() {
  let open = [];
  try { open = JSON.parse(localStorage.getItem(PREFS_OPEN_KEY) || '[]'); } catch {}
  if (!Array.isArray(open)) open = [];
  for (const g of prefsGroups()) g.open = open.includes(g.dataset.group);
}
for (const g of prefsGroups()) {
  g.addEventListener('toggle', () => {
    try {
      localStorage.setItem(PREFS_OPEN_KEY, JSON.stringify(
        prefsGroups().filter((x) => x.open).map((x) => x.dataset.group)));
    } catch {}
  });
}

// Grey out the toggles that cannot act, and say why.
function applyPrefsGate() {
  const gate = prefsGate({
    proxyEnabled: prefsProxyEnabled.checked,
    contextHints: prefsContextHints.checked,
  });
  for (const [key, el] of [
    ['compactOnResume', prefsCompactOnResume],
    ['contextHints', prefsContextHints],
    ['semanticHints', prefsSemanticHints],
  ]) {
    if (!el) continue;
    const g = gate[key];
    el.disabled = g.disabled;
    if (el.parentElement) el.parentElement.classList.toggle('dep-off', g.disabled);
    const why = document.getElementById(`${el.id}-why`);
    if (why) { why.textContent = g.reason; why.classList.toggle('shown', !!g.reason); }
  }
}

// The gate reads live checkbox state, so every master must re-run it on change
// — not only on open, or unticking the proxy would leave its dependants looking
// live until the dialog was reopened.
prefsProxyEnabled.addEventListener('change', applyPrefsGate);
prefsContextHints.addEventListener('change', applyPrefsGate);

const TERMINAL_REPORTS = ['off', 'asked', 'all'];

// The dialog's read of the tri-state. Falls back to 'off' rather than to the
// store's 'asked' default: this runs on whatever settings:get returned, and a
// value this function cannot recognise must not be redrawn as the state that
// grants the agent a capability. Save then writes back what is displayed.
function setTerminalReports(value) {
  if (!prefsTerminalReports) return;
  const want = TERMINAL_REPORTS.includes(value) ? value : 'off';
  for (const el of prefsTerminalReports.querySelectorAll('input[type="radio"]')) {
    el.checked = el.value === want;
  }
}

// Baseline only. The per-model rows are rendered read-only rather than left out:
// a surface that showed one pair while the code ran on another would read as the
// whole truth. Editing them is a settings-file edit, and the store's merge keeps
// such a row across a Save from here.
function setCtxThresholds(s) {
  const shipped = s.ctxThresholdDefaults || {};
  const base = shipped.default || {};
  const cur = (s.ctxReminderThresholds || {}).default;
  if (prefsCtxNudge) {
    prefsCtxNudge.placeholder = base.nudge != null ? String(base.nudge) : '';
    prefsCtxNudge.value = cur && Number.isInteger(cur.nudge) ? String(cur.nudge) : '';
  }
  if (prefsCtxEscalate) {
    prefsCtxEscalate.placeholder = base.escalate != null ? String(base.escalate) : '';
    prefsCtxEscalate.value = cur && Number.isInteger(cur.escalate) ? String(cur.escalate) : '';
  }
  if (!prefsCtxModels) return;
  const overrides = s.ctxReminderThresholds || {};
  const rows = (Array.isArray(shipped.models) ? shipped.models : []).map((m) => {
    const o = overrides[m.family];
    const v = o || m;
    return `${m.family}: ${v.nudge.toLocaleString()} / ${v.escalate.toLocaleString()}`
      + (o ? ' (your override)' : '');
  });
  prefsCtxModels.textContent = rows.length
    ? `Models with their own thresholds, which the baseline above does not change \u2014 ${rows.join('; ')}.`
    : '';
}

// The SAME store fields the voice popover writes, read here rather than
// mirrored into a second source of truth — the operator went looking in
// Settings first, and a copy that could disagree with the popover is worse than
// not having the row.
function setSpeakSettings(s) {
  if (prefsSpeakReplies) prefsSpeakReplies.checked = s.speakReplies === true;
  if (prefsSpeakRate && Number.isInteger(s.speakRate)) prefsSpeakRate.value = String(s.speakRate);
  if (!prefsSpeakVoice) return;
  // Rebuilt from what `say` reports installed on this box, plus the configured
  // name when the enumeration has not landed or does not contain it: an option
  // list missing the stored voice would show — and then SAVE — a different one.
  const names = (Array.isArray(s.speakVoices) ? s.speakVoices : []).map((v) => v.name);
  const want = typeof s.speakVoice === 'string' ? s.speakVoice : '';
  const opts = (names.includes(want) || !want ? names : [want, ...names])
    .map((n) => {
      const v = (s.speakVoices || []).find((x) => x.name === n);
      return `<option value="${esc(n)}"${n === want ? ' selected' : ''}>`
        + `${esc(v ? `${n} (${v.locale})` : n)}</option>`;
    });
  prefsSpeakVoice.innerHTML = opts.join('');
}

// Both boxes empty means "use what ships"; null is what the store drops. A pair
// is sent whole, so a nudge typed without an escalate cannot merge onto a stale
// escalate from a previous save.
function readCtxThresholdPair() {
  const n = prefsCtxNudge.value.trim();
  const e = prefsCtxEscalate.value.trim();
  if (!n && !e) return null;
  const nudge = Number(n);
  if (!Number.isInteger(nudge)) return null;
  const escalate = Number(e);
  return { nudge, escalate: Number.isInteger(escalate) ? escalate : 0 };
}

function readTerminalReports() {
  if (!prefsTerminalReports) return 'off';
  const picked = prefsTerminalReports.querySelector('input[type="radio"]:checked');
  return picked && TERMINAL_REPORTS.includes(picked.value) ? picked.value : 'off';
}

async function openPrefs() {
  const s = await window.api.getSettings();
  renderPrefsCheckboxes(prefsClaudeBox, s.claudeComponents, s.statusline.claude, CLAUDE_LABELS);
  prefsClaudeCmd.value = s.statusline.claudeCommand || '';
  renderPrefsCheckboxes(prefsCodexBox, s.codexComponents, s.statusline.codex, CODEX_LABELS);
  prefsProxyEnabled.checked = !!s.proxyEnabled;
  prefsDisableDesignMcp.checked = s.disableClaudeDesignMcp !== false;
  prefsCompactOnResume.checked = !!s.compactOnResume;
  prefsContextHints.checked = !!s.contextHints;
  if (prefsSemanticHints) prefsSemanticHints.checked = !!s.semanticHints;
  if (prefsSelectionHints) prefsSelectionHints.checked = !!s.selectionHints;
  if (prefsVoiceSubmit) prefsVoiceSubmit.checked = s.voiceSubmit === true;
  if (prefsVoiceSubmitComposition) prefsVoiceSubmitComposition.checked = s.voiceSubmitComposition === true;
  if (prefsVoiceSubmitRearm) prefsVoiceSubmitRearm.checked = s.voiceSubmitRearm === true;
  // The stored phrase, never the default, so an empty box is the operator
  // asking for the default back rather than a value they typed being hidden.
  if (prefsVoiceSubmitPhrase) prefsVoiceSubmitPhrase.value = s.voiceSubmitPhrase || '';
  setSpeakSettings(s);
  setCtxThresholds(s);
  setTerminalReports(s.terminalReports);
  if (prefsDiscoverOnStartup) prefsDiscoverOnStartup.checked = !!s.discoverOnStartup;
  restorePrefsGroups();
  applyPrefsGate();
  // Starts the island's poll and does the open-time read: the row lives in this
  // dialog, so the poll has nothing to serve while it is closed. Reading here
  // rather than trusting the 15s poll matters because a `/voice` typed in a
  // terminal would otherwise show stale for up to that long, on the one screen
  // that claims to say what the mode IS.
  voiceControl.start();
  prefsRemoteEnabled.checked = !!s.remoteEnabled;
  if (prefsPeerShell) prefsPeerShell.checked = !!s.peerShellEnabled;
  prefsRemoteToken.value = '';
  renderRemoteTokenState(!!s.remoteHasToken);
  if (prefsEnvScope) prefsEnvScope.value = 'global';
  if (prefsEnvKey) prefsEnvKey.value = '';
  if (prefsEnvValue) prefsEnvValue.value = '';
  if (prefsEnvSecret) prefsEnvSecret.checked = false;
  setPrefsEnvState('');
  refreshPrefsEnv();
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
  voiceControl.stop();
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
    contextHints: prefsContextHints.checked,
    semanticHints: prefsSemanticHints ? prefsSemanticHints.checked : false,
    selectionHints: prefsSelectionHints ? prefsSelectionHints.checked : false,
    voiceSubmit: prefsVoiceSubmit ? prefsVoiceSubmit.checked : false,
    voiceSubmitComposition: prefsVoiceSubmitComposition ? prefsVoiceSubmitComposition.checked : false,
    voiceSubmitRearm: prefsVoiceSubmitRearm ? prefsVoiceSubmitRearm.checked : false,
    voiceSubmitPhrase: prefsVoiceSubmitPhrase ? prefsVoiceSubmitPhrase.value.trim() : '',
    speakReplies: prefsSpeakReplies ? prefsSpeakReplies.checked : false,
    // Both omitted rather than sent blank when the control is missing: the store
    // treats an absent key as "keep the current value" and a blank/invalid one
    // as "reset to the default", so a Save from a dialog without these rows must
    // not silently overwrite what the popover set.
    ...(prefsSpeakVoice && prefsSpeakVoice.value ? { speakVoice: prefsSpeakVoice.value } : {}),
    ...(prefsSpeakRate && prefsSpeakRate.value ? { speakRate: Number(prefsSpeakRate.value) } : {}),
    // A blank pair sends `default: null`, which the store's sanitizer drops —
    // that is how the operator gets the shipped values back, and it is why this
    // key is not omitted when the boxes are empty the way speakVoice is.
    ...(prefsCtxNudge && prefsCtxEscalate ? { ctxReminderThresholds: { default: readCtxThresholdPair() } } : {}),
    terminalReports: readTerminalReports(),
    discoverOnStartup: prefsDiscoverOnStartup ? prefsDiscoverOnStartup.checked : false,
    remoteEnabled: prefsRemoteEnabled.checked,
  });
  await window.api.setDefaultToolDeny(collectToolChecklist(prefsToolsList));
  // The watchers read a cache, so without this the setting applies only at the
  // next window load — including the OFF direction.
  await refreshVoiceSubmitConfig();
  closePrefs();
});

// Applies ON CHANGE, not on Save, and deliberately does not ride the
// setSettings batch above. `peer:setShellAllowed` is what re-derives the wterm
// callbacks (which is what CLOSES shells a peer already has open), tells every
// other window, and writes the ops row; a plain settings write does none of
// that, so a revocation batched to Save would be on paper only. Immediate apply
// is already this group's contract — the token buttons beside it save on click.
if (prefsPeerShell) {
  prefsPeerShell.addEventListener('change', async () => {
    const on = prefsPeerShell.checked;
    // The toast is claimed only on `ok === true`, and the box reverts otherwise.
    // A failed invoke that still said "open remote shells were closed" would
    // tell the operator a revocation happened while the box kept serving.
    let res = null;
    try { res = await window.api.peerSetShellAllowed(on); } catch { res = null; }
    if (!res || res.ok !== true) {
      prefsPeerShell.checked = !on;
      showToast(on
        ? 'Could not turn terminal sharing on — it is still off.'
        : 'Could not turn terminal sharing off — this box is STILL serving shells.',
      { kind: 'warn' });
      return;
    }
    // Named at the moment of the decision rather than only in the hint text:
    // that this is one switch for every peer, and that it shares the operator's
    // own shell, is the pair of facts about this feature that can be got wrong.
    showToast(on
      ? 'Terminal sharing ON — any peer that can reach your tunnel can open a shell here.'
      : 'Terminal sharing off — open remote shells were closed.',
    { kind: on ? 'warm' : 'peer-ui' });
  });
  // The grant is box-wide, so another window (or the web surface) can change it
  // under an open Prefs dialog. The header chip self-heals on this broadcast;
  // without this the checkbox is a snapshot from the moment the dialog opened,
  // and ticking a stale box re-sends a value that is already set.
  window.api.onPeerShellAllowed(async () => {
    if (prefsOverlay.classList.contains('hidden')) return;
    try {
      const s = await window.api.getSettings();
      prefsPeerShell.checked = !!(s && s.peerShellEnabled);
    } catch {}
  });
}

prefsRemoteTokenSave.addEventListener('click', () => {
  const v = prefsRemoteToken.value.trim();
  if (!v) { showToast('Paste a token first (use Clear to remove).', { kind: 'warn' }); return; }
  saveRemoteToken(v);
});
prefsRemoteTokenClear.addEventListener('click', () => saveRemoteToken(''));

window.api.onRequestOpenPreferences(() => openPrefs());


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
const argsSkillsRow = document.getElementById('args-skills-row');
const argsSkillsList = document.getElementById('args-skills-list');
const argsSkillsSection = document.getElementById('args-skills-section');
const argsInjectSkillsSection = document.getElementById('args-inject-skills-section');
const argsInjectSkillsList = document.getElementById('args-inject-skills-list');
const argsEnvSection = document.getElementById('args-env-section');
const argsEnv = document.getElementById('args-env');
const argsEnvHint = document.getElementById('args-env-hint');
if (argsEnv) argsEnv.addEventListener('input', () => renderEnvHint(argsEnv, argsEnvHint));
wireBulkToggles(argsToolsRow, argsToolsList);
wireBulkToggles(argsSkillsRow, argsSkillsList);
let argsEditingName = null;
let argsEditingSource = null;
// Scoped-checklist Save inputs for the args-dialog agents list: persisted set,
// rendered (in-scope) names, and auto-included names — so save reconciles instead
// of dropping an out-of-scope persisted agent (and never persists an auto one).
let argsAgentsPersisted = [];
let argsAgentsRendered = [];
let argsAgentsAuto = [];
let argsSkillsInjectPersisted = [];
let argsSkillsInjectRendered = [];
let argsSkillsInjectAuto = [];

argsProxyMode.addEventListener('change', () => {
  argsProxyUrl.style.display = argsProxyMode.value === 'custom' ? '' : 'none';
  if (argsProxyMode.value === 'custom') argsProxyUrl.focus();
});

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
  setProxyControls(argsProxyMode, argsProxyUrl, res.proxy, settings?.lastCustomProxyUrl || settings?.proxyUrl);
  labelProxyDefault(argsProxyMode, settings);
  argsPromptRow.style.display = isAgent ? '' : 'none';
  argsAppendRow.style.display = isAgent ? '' : 'none';
  argsAppendSection.style.display = isAgent ? '' : 'none';
  fillSystemPromptSelect(argsSystemPrompt, res.systemPromptFile || '');
  renderAppendChecklist(argsAppendList, new Set(res.appendPromptFiles || []));
  const isClaude = res.type === 'claude';
  argsAgentsRow.style.display = isClaude ? '' : 'none';
  argsOtherSection.style.display = isClaude ? '' : 'none';
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
  argsIntentsSection.style.display = isClaude ? '' : 'none';
  // Named: a session-scoped plugin's verbs surface here only if THIS seat
  // granted the plugin. Passing no name would draw the un-granted catalog.
  setIntentCatalogCache((await window.api.getIntentCatalog(name)) || []);
  renderIntentChecklist(argsIntentsList, res.intents);
  const isExecEditable = isClaude && !argsSource;
  argsExecSection.style.display = isExecEditable ? '' : 'none';
  if (isExecEditable) {
    setExecLibCache((await window.api.listExecCommands()) || []);
    renderExecChecklist(argsExecList, new Set(res.execCommands || []));
  }
  const isSkillsEditable = isClaude && !!argsSource && !!skillCatalog;
  argsSkillsSection.style.display = isSkillsEditable ? '' : 'none';
  if (isSkillsEditable) {
    const sc = skillCatalog;
    renderSkillChecklist(argsSkillsList, sc.names || [], new Set(sc.disabledSkills || []),
      sc.effective || {}, { skillsLocked: sc.skillsLocked, canReenable: sc.canReenable, outOfScope: sc.outOfScope });
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
  const isEnvEditable = !argsSource;
  argsEnvSection.style.display = isEnvEditable ? '' : 'none';
  if (isEnvEditable) {
    argsEnv.value = formatEnvLines(res.env || {});
    renderEnvHint(argsEnv, argsEnvHint);
  } else {
    argsEnv.value = '';
    renderEnvHint(argsEnv, argsEnvHint);
  }
  for (const sec of [argsAppendSection, argsToolsSection, argsOtherSection, argsSkillsSection, argsExecSection, argsIntentsSection, argsEnvSection]) sec.open = false;
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
  const agents = argsAgentsRow.style.display === 'none' ? [] : reconcilePartialSelection(
    argsAgentsPersisted, argsAgentsRendered, collectAgentChecklist(argsAgentsList), argsAgentsAuto);
  const denyBuiltins = argsAgentsRow.style.display === 'none'
    ? [] : collectBuiltinChecklist(argsBuiltinsList);
  const disabledTools = argsToolsRow.style.display === 'none' ? [] : collectToolChecklist(argsToolsList);
  // This dialog OWNS the gate: collect returns null (every box checked → clear) or the enabled
  // subset ([] = everything gated, a real value). Both OVERWRITE; undefined-preserve is
  // reserved for a patch that omits intents entirely.
  const intents = argsIntentsSection.style.display === 'none' ? null : collectIntentChecklist(argsIntentsList);
  const execCommandsGrant = argsExecSection.style.display === 'none' ? undefined : collectExecChecklist(argsExecList);
  // LOCAL-only: a hidden section (peer row) leaves env untouched via `undefined`. Locally the
  // dialog OWNS env — an empty box is {}, a real clear, not a no-op.
  const env = argsEnvSection.style.display === 'none'
    ? undefined
    : parseEnvLines(argsEnv.value || '').env;
  const skillsShown = argsSkillsSection.style.display !== 'none';
  const disabledSkills = skillsShown ? collectSkillChecklist(argsSkillsList) : undefined;
  const injectSkills = !skillsShown || argsInjectSkillsSection.style.display === 'none'
    ? undefined
    : reconcilePartialSelection(argsSkillsInjectPersisted, argsSkillsInjectRendered,
        collectInjectChecklist(argsInjectSkillsList), argsSkillsInjectAuto);
  const name = argsEditingName;
  const source = argsEditingSource;
  const existing = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  const snapType = existing ? existing.dataset.type || null : null;
  const snapCwd = existing ? existing.dataset.cwd : null;
  const snapBackend = existing ? existing.dataset.backend || null : null;
  // The Edit dialog does not surface wire-off (it is spawn-time config, and
  // applySessionArgs replays the PERSISTED value), so the rebuilt row must carry
  // the flag forward or an unrelated edit silently un-marks a wire-off seat.
  const snapNoWire = existing ? existing.dataset.noWire === '1' : false;
  closeArgsDialog();
  // systemPrompt (legacy inline) passes undefined so a pre-library inline body
  // survives; disabledSkills/injectSkills likewise (handler preserves on undefined).
  const res = source
    ? await source.save({
            // Peer save NEVER carries execCommands: the key is omitted entirely (not even []),
            // so a peer edit cannot clear the box's grants. Skills DO travel, and the peer source
            // fresh-restarts on apply-now — a resume wouldn't re-read the roster.
        extraArgs: parsed, restart, proxy, systemPrompt: undefined, agents, denyBuiltins,
        disabledTools, disabledSkills, injectSkills, systemPromptFile, appendPromptFiles, intents,
      })
    : await window.api.setSessionArgs(name, parsed, restart, proxy, undefined, agents, denyBuiltins, disabledTools, undefined, undefined, systemPromptFile, appendPromptFiles, intents, execCommandsGrant, env);
  if (!res || !res.ok) {
    alert(`Save settings failed: ${res && res.error ? res.error : 'unknown error'}`);
    return;
  }
  if (res.restarted) {
    if (source) source.onRestarted();
    else if (snapType) {
      createTerminal(name);
      addSessionToSidebar(name, snapType, snapCwd, null, res.backend ?? snapBackend, null, snapNoWire);
      switchSession(name);
    }
  }
});


({ refreshTemplatesList: templatesDrawerRefresh } = initLibraryDrawers({
  getActiveSession: () => activeSession,
  setAgentLibCache, setSkillLibCache,
  openTemplateEditor,
}));


(async function restoreSessions() {
  const restored = await window.api.restoreSessions();
  if (!restored || restored.length === 0) { initSidebarView(); return; }

  let firstHealthy = null;
  for (const entry of restored) {
    if (entry.archived) {
      addArchivedSessionToSidebar(entry);
      continue;
    }
    if (entry.failed) {
      addFailedSessionToSidebar(entry);
      continue;
    }
    const { terminal, fitAddon } = createTerminal(entry.name);
    addSessionToSidebar(entry.name, entry.type, entry.cwd, entry.label, entry.backend || null, entry.team || null, entry.noWire === true);
    if (entry.createdAt) sidebarMeta.set(entry.name, { ...(sidebarMeta.get(entry.name) || {}), createdAt: entry.createdAt });
    const item = sessionList.querySelector(`[data-name="${CSS.escape(entry.name)}"]`);
    if (item) {
      if (entry.activity) {
        item.dataset.activity = entry.activity;
        if (entry.activity === 'thinking') item.dataset.thinkingSince = String(Date.now());
      }
      if (entry.attention) {
        item.dataset.attention = entry.attention.kind;
        item.dataset.attentionMsg = entry.attention.message || '';
      }
      if (entry.ticket) item.dataset.ticket = entry.ticket; // open ticket badge (Task 25)
    }
    try {
      fitAddon.fit();
      window.api.resizeSession(entry.name, terminal.cols, terminal.rows);
    } catch {}
    if (entry.replay) terminal.write(entry.replay);
    if (typeof entry.ctx === 'number') { ctxPct.set(entry.name, entry.ctx); applyCtxBadge(entry.name, entry.ctx); }
    if (typeof entry.ctxTok === 'number' && typeof entry.ctxSize === 'number' && entry.ctxSize > 0) {
      ctxTokens.set(entry.name, { used: entry.ctxTok, size: entry.ctxSize, cost: typeof entry.ctxCost === 'number' ? entry.ctxCost : null, model: entry.ctxModel || null });
    }
    if (entry.proxy) { proxyState.set(entry.name, { payload: entry.proxy, at: Date.now() }); applyWarmBadge(entry.name); }
    if (typeof entry.pendingCount === 'number') applyPendingBadge(entry.name, entry.pendingCount);
    if (!firstHealthy) firstHealthy = entry.name;
  }
  // Only a session with a terminal is switchable, and archived/failed entries
  // never get one — so the target is the first entry that built one, not
  // restored[0], which is commonly archived.
  if (firstHealthy) switchSession(firstHealthy);
  initSidebarView();
})();

// Opt-in startup discovery. Window gate: every restored workspace window loads this same
// script, so without the document.hasFocus() check all of them pop the picker at once.
(async function maybeDiscoverOnStartup() {
  try {
    if (!document.hasFocus()) return;
    const s = await window.api.getSettings();
    if (!s || !s.discoverOnStartup) return;
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
