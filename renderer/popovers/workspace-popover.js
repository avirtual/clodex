// workspace-popover.js — one floating "Workspace" popover: Files (lazy tree +
// editor), Source Control (git status/stage/discard/commit/branch/remote), and
// Worktrees, for a chosen session. Everything scopes to the SELECTED session's
// working directory (dropdown at the top; default = active session), resolved
// server-side by name via the fs:/scm:/worktree: IPC. Those refuse peer/remote
// sessions, so the dropdown lists only LOCAL sessions with a cwd — this is
// local-session data and talks to window.api directly (no popoverApi peer seam).
//
// Modeled on the file-peek modal: centered overlay, one open at a time. The
// editor/diff area on the right is SHARED — the Files tab edits files there; the
// Source tab renders per-file diffs there (read-only). The Worktrees tab has no
// editor and fills the width.
//
// Factory: initWorkspacePopover({ getActiveSession, showToast }).
// Returns { openWorkspace, closeWorkspace }. Owns its own DOM + IPC.

const { renderDiffHtml } = require('../lib/render-html');

function initWorkspacePopover({ getActiveSession, showToast }) {
  const $ = (id) => document.getElementById(id);
  const api = window.api;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const toast = (msg) => { if (showToast) showToast(msg, { kind: 'error' }); else alert(msg); };

  const overlay = $('workspace-overlay');
  const bodyEl = overlay.querySelector('.workspace-body');
  const sessionSel = $('workspace-session');
  const tabs = { files: $('workspace-tab-files'), scm: $('workspace-tab-scm'), worktrees: $('workspace-tab-worktrees') };
  const panels = { files: $('ws-files-panel'), scm: $('ws-scm-panel'), worktrees: $('ws-worktrees-panel') };

  let curTab = 'files';
  let selName = null; // selected session name (scope)

  // =========================================================================
  // Session dropdown (local sessions with a cwd; peer/remote excluded).
  // Fetched from the main process at open: the renderer's own sessions Map is
  // terminal plumbing (no cwd), while manager.list() is the record of truth
  // and local-only by construction — peer sessions never enter it.
  // =========================================================================
  let sessionCache = [];
  async function fetchSessions() {
    try {
      const list = await api.listSessions();
      sessionCache = (Array.isArray(list) ? list : [])
        .filter((s) => s && s.cwd)
        .map((s) => ({ name: s.name, label: s.name, cwd: s.cwd }))
        .sort((a, b) => a.label.localeCompare(b.label));
    } catch { sessionCache = []; }
  }
  function localSessions() {
    return sessionCache;
  }

  function populateSessions() {
    const list = localSessions();
    sessionSel.innerHTML = '';
    if (!list.length) {
      selName = null;
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = 'No local sessions';
      sessionSel.appendChild(opt);
      sessionSel.disabled = true;
      return;
    }
    sessionSel.disabled = false;
    const active = getActiveSession && getActiveSession();
    if (!list.some((s) => s.name === selName)) {
      selName = list.some((s) => s.name === active) ? active : list[0].name;
    }
    for (const s of list) {
      const opt = document.createElement('option');
      opt.value = s.name; opt.textContent = s.label;
      if (s.name === selName) opt.selected = true;
      sessionSel.appendChild(opt);
    }
  }

  const activeName = () => selName;
  const curCwd = () => {
    const s = localSessions().find((x) => x.name === selName);
    return s ? s.cwd : '';
  };

  sessionSel.addEventListener('change', () => {
    selName = sessionSel.value || null;
    resetEditor();
    refreshTab();
  });

  // =========================================================================
  // Shared editor / diff area
  // =========================================================================
  const edPath = $('ws-editor-path');
  const edDirty = $('ws-dirty');
  const edSave = $('ws-save');
  const edTextarea = $('ws-textarea');
  const edDiff = $('ws-diff');
  const edNote = $('ws-editor-note');
  const edPlaceholder = $('ws-editor-placeholder');

  let editingRel = null;      // rel path of the file open for editing, or null
  let editingBaseline = '';

  function setEditorDirty(dirty) {
    edDirty.classList.toggle('hidden', !dirty);
    edSave.disabled = !dirty;
  }

  // Collapse the shared area to a single visible child.
  function showEditorOnly(which) {
    edTextarea.classList.toggle('hidden', which !== 'text');
    edDiff.classList.toggle('hidden', which !== 'diff');
    edNote.classList.toggle('hidden', which !== 'note');
    edPlaceholder.classList.toggle('hidden', which !== 'placeholder');
  }

  function resetEditor() {
    editingRel = null;
    editingBaseline = '';
    edPath.textContent = '';
    edSave.disabled = true;
    edSave.classList.remove('hidden');
    edDirty.classList.add('hidden');
    showEditorOnly('placeholder');
  }

  // Guard against dropping unsaved edits.
  function confirmDiscardEdit() {
    if (editingRel && !edSave.disabled) {
      return confirm('Discard unsaved changes to the open file?');
    }
    return true;
  }

  async function openInEditor(name, rel) {
    if (!confirmDiscardEdit()) return;
    const res = await api.fsRead(name, rel);
    edPath.textContent = rel;
    edSave.classList.remove('hidden');
    if (!res || !res.ok) {
      edNote.textContent = res && res.binary ? 'Binary file — not shown.'
        : res && res.tooBig ? `File too large to edit (${res.size} bytes).`
        : `Can't open: ${(res && res.error) || 'unknown'}`;
      editingRel = null;
      setEditorDirty(false);
      showEditorOnly('note');
      return;
    }
    edTextarea.value = res.content;
    editingRel = rel;
    editingBaseline = res.content;
    setEditorDirty(false);
    showEditorOnly('text');
    for (const r of $('ws-tree').querySelectorAll('.explorer-row')) {
      r.classList.toggle('selected', r.dataset.rel === rel);
    }
  }

  // Read-only diff view (Source tab). Save is not applicable here.
  function showDiff(pathLabel, diffText, emptyNote) {
    editingRel = null;
    editingBaseline = '';
    edPath.textContent = pathLabel;
    edDirty.classList.add('hidden');
    edSave.disabled = true;
    edSave.classList.add('hidden');
    if (!diffText || !diffText.trim()) {
      edNote.textContent = emptyNote || '(no textual diff)';
      showEditorOnly('note');
      return;
    }
    edDiff.innerHTML = renderDiffHtml(diffText);
    showEditorOnly('diff');
  }

  edTextarea.addEventListener('input', () => {
    if (editingRel == null) return;
    setEditorDirty(edTextarea.value !== editingBaseline);
  });
  edSave.addEventListener('click', async () => {
    const name = activeName();
    if (!name || editingRel == null) return;
    const res = await api.fsWrite(name, editingRel, edTextarea.value);
    if (!res || !res.ok) { toast(`Save failed: ${(res && res.error) || 'unknown'}`); return; }
    editingBaseline = edTextarea.value;
    setEditorDirty(false);
  });
  edTextarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (!edSave.disabled) edSave.click(); }
  });

  // =========================================================================
  // Files tab — lazy tree
  // =========================================================================
  const tree = $('ws-tree');
  const filesScope = $('ws-files-scope');
  const filesEmpty = $('ws-files-empty');
  const expExpanded = new Set();

  async function renderExplorer() {
    const name = activeName();
    if (!name) { tree.innerHTML = ''; filesScope.textContent = ''; filesEmpty.classList.remove('hidden'); return; }
    filesScope.textContent = curCwd();
    const rootRes = await api.fsList(name, '');
    if (!rootRes || !rootRes.ok) {
      tree.innerHTML = '';
      filesEmpty.textContent = rootRes && rootRes.error === 'remote'
        ? 'This is a remote session — the file explorer only works on local sessions.'
        : `Not available: ${(rootRes && rootRes.error) || 'unknown'}`;
      filesEmpty.classList.remove('hidden');
      return;
    }
    filesEmpty.classList.add('hidden');
    tree.innerHTML = '';
    await renderDirInto(tree, name, '', 0);
  }

  async function renderDirInto(container, name, rel, depth) {
    const res = await api.fsList(name, rel);
    if (!res || !res.ok) return;
    for (const ent of res.entries) {
      const row = document.createElement('div');
      row.className = 'explorer-row';
      row.style.paddingLeft = `${10 + depth * 14}px`;
      row.dataset.rel = ent.rel;
      row.dataset.type = ent.type;
      const isOpen = ent.type === 'dir' && expExpanded.has(ent.rel);
      row.innerHTML = `<span class="explorer-twisty">${ent.type === 'dir' ? (isOpen ? '▾' : '▸') : ''}</span>`
        + `<span class="explorer-icon">${ent.type === 'dir' ? '📁' : '📄'}</span>`
        + `<span class="explorer-name">${esc(ent.name)}</span>`;
      if (ent.rel === editingRel) row.classList.add('selected');
      container.appendChild(row);
      row.addEventListener('click', async () => {
        if (ent.type === 'dir') {
          if (expExpanded.has(ent.rel)) expExpanded.delete(ent.rel); else expExpanded.add(ent.rel);
          renderExplorer();
        } else {
          openInEditor(name, ent.rel);
        }
      });
      if (isOpen) await renderDirInto(container, name, ent.rel, depth + 1);
    }
  }

  $('ws-files-refresh').addEventListener('click', () => renderExplorer());

  // =========================================================================
  // Source control tab
  // =========================================================================
  const scmChanges = $('ws-changes');
  const scmEmpty = $('ws-scm-empty');
  const scmBranchSel = $('ws-branch-select');
  const scmAheadBehind = $('ws-aheadbehind');
  const scmCommitMsg = $('ws-commit-msg');
  const scmCommitBtn = $('ws-commit-btn');
  let scmSelectedFile = null;

  const STATUS_CLASS = { M: 'modified', A: 'added', D: 'deleted', R: 'modified', C: 'modified', '?': 'untracked' };
  const statusChar = (f) => f.untracked ? '?' : (f.staged ? f.x : f.y);

  async function renderScm() {
    const name = activeName();
    if (!name) { scmChanges.innerHTML = ''; scmEmpty.classList.remove('hidden'); return; }
    const res = await api.scmStatus(name);
    if (!res || !res.ok) {
      scmChanges.innerHTML = '';
      scmEmpty.textContent = res && res.error === 'remote'
        ? 'This is a remote session — source control only works on local sessions.'
        : (res && res.error) || 'Not a git repository.';
      scmEmpty.classList.remove('hidden');
      scmBranchSel.innerHTML = '';
      scmAheadBehind.textContent = '';
      return;
    }
    scmEmpty.classList.add('hidden');
    scmAheadBehind.textContent = `${res.branch || '(detached)'}${res.ahead ? ` ↑${res.ahead}` : ''}${res.behind ? ` ↓${res.behind}` : ''}`;
    await renderBranchOptions(name, res.branch);
    renderChanges(name, res.files || []);
    scmCommitBtn.disabled = !(res.files || []).some((f) => f.staged);
  }

  async function renderBranchOptions(name, current) {
    const br = await api.scmBranches(name);
    scmBranchSel.innerHTML = '';
    if (!br || !br.ok) return;
    for (const b of br.local) {
      const opt = document.createElement('option');
      opt.value = b; opt.textContent = b;
      if (b === (current || br.current)) opt.selected = true;
      scmBranchSel.appendChild(opt);
    }
  }

  function renderChanges(name, files) {
    scmChanges.innerHTML = '';
    const staged = files.filter((f) => f.staged);
    const unstaged = files.filter((f) => !f.staged);
    const group = (label, list, isStaged) => {
      if (!list.length) return;
      const head = document.createElement('div');
      head.className = 'scm-group-label';
      head.innerHTML = `<span>${label} (${list.length})</span>`;
      const btn = document.createElement('button');
      btn.textContent = isStaged ? 'Unstage all' : 'Stage all';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const paths = list.map((f) => f.path);
        const r = isStaged ? await api.scmUnstage(name, paths) : await api.scmStage(name, paths);
        if (!r || !r.ok) toast(`Failed: ${(r && r.error) || 'unknown'}`);
        renderScm();
      });
      head.appendChild(btn);
      scmChanges.appendChild(head);
      for (const f of list) scmChanges.appendChild(fileRow(name, f, isStaged));
    };
    group('Staged', staged, true);
    group('Changes', unstaged, false);
  }

  function fileRow(name, f, isStaged) {
    const row = document.createElement('div');
    row.className = 'scm-file';
    if (scmSelectedFile === f.path) row.classList.add('selected');
    const ch = statusChar(f);
    row.innerHTML = `<span class="scm-file-status ${STATUS_CLASS[ch] || ''}">${ch}</span>`
      + `<span class="scm-file-name" title="${esc(f.path)}">${esc(f.path)}</span>`;
    const actions = document.createElement('span');
    actions.className = 'scm-file-actions';
    const mkBtn = (label, title, fn) => {
      const b = document.createElement('button'); b.textContent = label; b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); actions.appendChild(b);
    };
    if (isStaged) {
      mkBtn('−', 'Unstage', async () => { await api.scmUnstage(name, f.path); renderScm(); });
    } else {
      mkBtn('+', 'Stage', async () => { await api.scmStage(name, f.path); renderScm(); });
      mkBtn('⨯', 'Discard changes', async () => {
        if (!confirm(`Discard changes to ${f.path}? This can't be undone.`)) return;
        await api.scmDiscard(name, f.path, { untracked: f.untracked }); renderScm();
      });
    }
    row.appendChild(actions);
    row.addEventListener('click', () => {
      scmSelectedFile = f.path;
      for (const r of scmChanges.querySelectorAll('.scm-file')) r.classList.remove('selected');
      row.classList.add('selected');
      showScmDiff(name, f, isStaged);
    });
    return row;
  }

  // Click a changed file → show its diff in the SHARED editor/diff area.
  async function showScmDiff(name, f, isStaged) {
    const res = await api.scmDiff(name, f.path, { staged: isStaged });
    if (!res || !res.ok) { showDiff(f.path, '', `diff failed: ${(res && res.error) || 'unknown'}`); return; }
    showDiff(f.path, res.diff, f.untracked ? '(untracked — open it in the Files tab to view)' : '(no textual diff)');
  }

  scmBranchSel.addEventListener('change', async () => {
    const name = activeName(); if (!name) return;
    const r = await api.scmCheckout(name, scmBranchSel.value, {});
    if (!r || !r.ok) toast(`Checkout failed: ${(r && r.error) || 'unknown'}`);
    renderScm();
  });
  scmCommitBtn.addEventListener('click', async () => {
    const name = activeName(); if (!name) return;
    const msg = scmCommitMsg.value.trim();
    if (!msg) { scmCommitMsg.focus(); return; }
    const r = await api.scmCommit(name, msg, {});
    if (!r || !r.ok) { toast(`Commit failed: ${(r && r.error) || 'unknown'}`); return; }
    scmCommitMsg.value = '';
    renderScm();
  });
  const remoteBtn = (id, op) => $(id).addEventListener('click', async () => {
    const name = activeName(); if (!name) return;
    const r = await api.scmRemote(name, op);
    if (r && r.error) toast(`git ${op} failed: ${r.error}`);
    else if (showToast) showToast(`git ${op}: ${(r && r.output) || 'done'}`, { kind: 'info' });
    renderScm();
  });
  remoteBtn('ws-fetch', 'fetch');
  remoteBtn('ws-pull', 'pull');
  remoteBtn('ws-push', 'push');
  $('ws-newbranch').addEventListener('click', async () => {
    const name = activeName(); if (!name) return;
    const branch = prompt('New branch name (created from current HEAD):');
    if (!branch) return;
    const r = await api.scmCheckout(name, branch.trim(), { create: true });
    if (!r || !r.ok) { toast(`Create branch failed: ${(r && r.error) || 'unknown'}`); return; }
    renderScm();
  });
  $('ws-scm-refresh').addEventListener('click', () => renderScm());

  // =========================================================================
  // Worktrees tab
  // =========================================================================
  const wtList = $('ws-worktrees-list');
  const wtEmpty = $('ws-worktrees-empty');
  const wtNewBranch = $('ws-worktree-branch');
  const wtNewBase = $('ws-worktree-base');
  const wtBaseList = $('ws-worktree-base-list');

  async function renderWorktrees() {
    const name = activeName();
    if (!name) { wtList.innerHTML = ''; wtEmpty.classList.remove('hidden'); return; }
    const res = await api.worktreeList(name);
    if (!res || !res.ok) {
      wtList.innerHTML = '';
      wtEmpty.textContent = res && res.error === 'remote'
        ? 'This is a remote session — worktree management only works on local sessions.'
        : (res && res.error) || 'Not a git repository.';
      wtEmpty.classList.remove('hidden');
      return;
    }
    wtEmpty.classList.add('hidden');
    wtList.innerHTML = '';
    for (const w of res.worktrees) wtList.appendChild(worktreeRow(name, w));
    const br = await api.scmBranches(name);
    wtBaseList.innerHTML = '';
    if (br && br.ok) for (const b of br.local) { const o = document.createElement('option'); o.value = b; wtBaseList.appendChild(o); }
  }

  function worktreeRow(name, w) {
    const row = document.createElement('div');
    row.className = 'worktree-item';
    const meta = document.createElement('div');
    meta.className = 'worktree-meta';
    meta.innerHTML = `<div class="worktree-branch">${esc(w.branch || (w.detached ? `(detached ${w.head})` : '(no branch)'))}${w.isMain ? ' <span class="worktree-main-badge">main</span>' : ''}</div>`
      + `<div class="worktree-path" title="${esc(w.path)}">${esc(w.path)}</div>`;
    row.appendChild(meta);
    const openBtn = document.createElement('button');
    openBtn.textContent = 'Open';
    openBtn.title = 'Reveal in Finder';
    openBtn.addEventListener('click', () => api.fileOpen(w.path));
    row.appendChild(openBtn);
    if (!w.isMain) {
      const rm = document.createElement('button');
      rm.textContent = 'Remove';
      rm.addEventListener('click', async () => {
        if (!confirm(`Remove worktree at ${w.path}? (git worktree remove --force)`)) return;
        const r = await api.worktreeRemove(w.path);
        if (!r || !r.ok) { toast(`Remove failed: ${(r && r.error) || 'unknown'}`); return; }
        renderWorktrees();
      });
      row.appendChild(rm);
    }
    return row;
  }

  $('ws-worktree-add').addEventListener('click', async () => {
    const name = activeName(); if (!name) return;
    const branch = wtNewBranch.value.trim();
    if (!branch) { wtNewBranch.focus(); return; }
    const wl = await api.worktreeList(name);
    if (!wl || !wl.ok) { toast('Not a git repository.'); return; }
    const base = wtNewBase.value.trim() || null;
    const r = await api.createWorktree(wl.repo, branch, { base });
    if (!r || !r.ok) { toast(`Create worktree failed: ${(r && r.error) || 'unknown'}`); return; }
    wtNewBranch.value = ''; wtNewBase.value = '';
    renderWorktrees();
  });
  $('ws-worktrees-refresh').addEventListener('click', () => renderWorktrees());

  // =========================================================================
  // Tabs + open/close
  // =========================================================================
  function refreshTab() {
    if (curTab === 'files') renderExplorer();
    else if (curTab === 'scm') renderScm();
    else if (curTab === 'worktrees') renderWorktrees();
  }

  function setTab(tab) {
    // Leaving the Files editor with unsaved edits → confirm.
    if (curTab === 'files' && tab !== 'files' && !confirmDiscardEdit()) return;
    curTab = tab;
    for (const k of Object.keys(tabs)) {
      tabs[k].classList.toggle('active', k === tab);
      panels[k].classList.toggle('hidden', k !== tab);
    }
    // Worktrees fills the width; Files/Source share the editor/diff area.
    const showEditor = tab !== 'worktrees';
    $('ws-editor').classList.toggle('hidden', !showEditor);
    bodyEl.classList.toggle('worktrees-mode', tab === 'worktrees');
    refreshTab();
  }

  for (const k of Object.keys(tabs)) tabs[k].addEventListener('click', () => setTab(k));

  async function openWorkspace(tab) {
    await fetchSessions();
    populateSessions();
    resetEditor();
    overlay.classList.remove('hidden');
    setTab(tab || 'files');
  }
  function closeWorkspace() { overlay.classList.add('hidden'); }

  $('workspace-close').addEventListener('click', () => closeWorkspace());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeWorkspace(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeWorkspace();
  });

  return { openWorkspace, closeWorkspace };
}

module.exports = { initWorkspacePopover };
