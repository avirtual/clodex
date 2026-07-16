// workspace-panes.js — the three docked "workspace" panes: file Explorer +
// editor, Source Control (git), and Worktree management. All three scope to the
// ACTIVE session's working directory (resolved server-side by the scm:/fs:/
// worktree: IPC from the session name), and only one is open at a time (they
// share the docked-drawer slot left of the terminal, like the library drawers).
//
// Factory: initWorkspacePanes({ getActiveSession, onSessionChanged }). Returns
// { refreshOpenPane } so the core can nudge whichever pane is open when the
// active session changes. Owns its own DOM + IPC; no bundler (nodeIntegration).

const { renderDiffHtml } = require('../lib/render-html');

function initWorkspacePanes({ getActiveSession }) {
  const $ = (id) => document.getElementById(id);
  const api = window.api;

  // --- shared open/close (mutual exclusion) --------------------------------
  const drawers = {
    explorer: $('explorer-drawer'),
    scm: $('scm-drawer'),
    worktrees: $('worktrees-drawer'),
  };
  const footBtns = {
    explorer: $('explorer-open'),
    scm: $('scm-open'),
    worktrees: $('worktrees-open'),
  };
  let openPane = null;

  function closeAll() {
    for (const k of Object.keys(drawers)) {
      drawers[k].classList.add('hidden');
      if (footBtns[k]) footBtns[k].classList.remove('active');
    }
    openPane = null;
  }
  function openPaneNamed(name) {
    if (openPane === name) { closeAll(); return; } // toggle off
    closeAll();
    drawers[name].classList.remove('hidden');
    if (footBtns[name]) footBtns[name].classList.add('active');
    openPane = name;
    refreshOpenPane();
  }

  // Escape-safe HTML for user/file text.
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // The active session name, or null. Panes need a local (non-peer) session; the
  // IPC returns error:'remote' for peers, which we surface as a notice.
  const activeName = () => getActiveSession && getActiveSession();

  // =========================================================================
  // Explorer + editor
  // =========================================================================
  const expTree = $('explorer-tree');
  const expEmpty = $('explorer-empty');
  const expScope = $('explorer-scope');
  const expEditor = $('explorer-editor');
  const expPath = $('explorer-editor-path');
  const expTextarea = $('explorer-textarea');
  const expSave = $('explorer-save');
  const expDirty = $('explorer-dirty');
  const expNote = $('explorer-editor-note');

  const expExpanded = new Set(); // rel dirs currently expanded
  let expEditingRel = null;
  let expEditingBaseline = '';

  function setEditorDirty(dirty) {
    expDirty.classList.toggle('hidden', !dirty);
    expSave.disabled = !dirty;
  }

  async function renderExplorer() {
    const name = activeName();
    if (!name) { expTree.innerHTML = ''; expEmpty.classList.remove('hidden'); expScope.textContent = ''; return; }
    expScope.textContent = '…';
    const rootRes = await api.fsList(name, '');
    if (!rootRes || !rootRes.ok) {
      expTree.innerHTML = '';
      expEmpty.textContent = rootRes && rootRes.error === 'remote'
        ? 'This is a remote session — the file explorer only works on local sessions.'
        : `Not available: ${(rootRes && rootRes.error) || 'unknown'}`;
      expEmpty.classList.remove('hidden');
      expScope.textContent = '';
      return;
    }
    expEmpty.classList.add('hidden');
    expScope.textContent = '';
    expTree.innerHTML = '';
    await renderDirInto(expTree, name, '', 0);
  }

  // Render a directory's entries into `container` at indent `depth`, expanding
  // any dirs in expExpanded recursively.
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
      if (ent.rel === expEditingRel) row.classList.add('selected');
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

  async function openInEditor(name, rel) {
    if (expEditingRel && !expSave.disabled) {
      if (!confirm('Discard unsaved changes to the open file?')) return;
    }
    const res = await api.fsRead(name, rel);
    expEditor.classList.remove('hidden');
    expPath.textContent = rel;
    if (!res || !res.ok) {
      expTextarea.value = '';
      expTextarea.style.display = 'none';
      expNote.classList.remove('hidden');
      expNote.textContent = res && res.binary ? 'Binary file — not shown.'
        : res && res.tooBig ? `File too large to edit (${res.size} bytes).`
        : `Can't open: ${(res && res.error) || 'unknown'}`;
      expEditingRel = null;
      setEditorDirty(false);
      return;
    }
    expNote.classList.add('hidden');
    expTextarea.style.display = '';
    expTextarea.value = res.content;
    expEditingRel = rel;
    expEditingBaseline = res.content;
    setEditorDirty(false);
    // Reflect selection in the tree.
    for (const r of expTree.querySelectorAll('.explorer-row')) {
      r.classList.toggle('selected', r.dataset.rel === rel);
    }
  }

  expTextarea.addEventListener('input', () => {
    if (expEditingRel == null) return;
    setEditorDirty(expTextarea.value !== expEditingBaseline);
  });
  expSave.addEventListener('click', async () => {
    const name = activeName();
    if (!name || expEditingRel == null) return;
    const res = await api.fsWrite(name, expEditingRel, expTextarea.value);
    if (!res || !res.ok) { alert(`Save failed: ${(res && res.error) || 'unknown'}`); return; }
    expEditingBaseline = expTextarea.value;
    setEditorDirty(false);
    // A save changes git status; if the SCM pane is open next it'll refresh.
  });
  // Cmd/Ctrl+S saves when the editor has focus.
  expTextarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (!expSave.disabled) expSave.click(); }
  });

  $('explorer-refresh').addEventListener('click', () => renderExplorer());
  $('explorer-close').addEventListener('click', () => closeAll());
  footBtns.explorer.addEventListener('click', () => openPaneNamed('explorer'));

  // =========================================================================
  // Source control
  // =========================================================================
  const scmChanges = $('scm-changes');
  const scmEmpty = $('scm-empty');
  const scmBranchSel = $('scm-branch-select');
  const scmAheadBehind = $('scm-aheadbehind');
  const scmCommitMsg = $('scm-commit-msg');
  const scmCommitBtn = $('scm-commit-btn');
  const scmRemoteOut = $('scm-remote-out');
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
        if (!r || !r.ok) alert(`Failed: ${(r && r.error) || 'unknown'}`);
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
        if (!confirm(`Discard changes to ${f.path}? This cannot be undone.`)) return;
        await api.scmDiscard(name, f.path, { untracked: f.untracked }); renderScm();
      });
    }
    row.appendChild(actions);
    row.addEventListener('click', () => { scmSelectedFile = f.path; showScmDiff(name, f, isStaged); });
    return row;
  }

  // Show a file's diff inline in the pane's output area, using the shared diff
  // renderer (same coloring as the file-peek modal). Untracked files have no
  // diff — the note points the user to Explorer to view the contents.
  async function showScmDiff(name, f, isStaged) {
    const res = await api.scmDiff(name, f.path, { staged: isStaged });
    scmRemoteOut.classList.remove('hidden');
    if (!res || !res.ok) { scmRemoteOut.textContent = `diff failed: ${(res && res.error) || 'unknown'}`; return; }
    if (!res.diff || !res.diff.trim()) {
      scmRemoteOut.textContent = f.untracked ? '(untracked — open it in Explorer to view)' : '(no textual diff)';
      return;
    }
    scmRemoteOut.innerHTML = renderDiffHtml(res.diff);
    for (const r of scmChanges.querySelectorAll('.scm-file')) r.classList.remove('selected');
  }

  scmBranchSel.addEventListener('change', async () => {
    const name = activeName(); if (!name) return;
    const r = await api.scmCheckout(name, scmBranchSel.value, {});
    if (!r || !r.ok) alert(`Checkout failed: ${(r && r.error) || 'unknown'}`);
    renderScm();
  });
  scmCommitBtn.addEventListener('click', async () => {
    const name = activeName(); if (!name) return;
    const msg = scmCommitMsg.value.trim();
    if (!msg) { scmCommitMsg.focus(); return; }
    const r = await api.scmCommit(name, msg, {});
    if (!r || !r.ok) { alert(`Commit failed: ${(r && r.error) || 'unknown'}`); return; }
    scmCommitMsg.value = '';
    renderScm();
  });
  const remoteBtn = (id, op) => $(id).addEventListener('click', async () => {
    const name = activeName(); if (!name) return;
    scmRemoteOut.classList.remove('hidden');
    scmRemoteOut.textContent = `git ${op}…`;
    const r = await api.scmRemote(name, op);
    scmRemoteOut.textContent = (r && (r.output || r.error)) || `git ${op} done`;
    renderScm();
  });
  remoteBtn('scm-fetch', 'fetch');
  remoteBtn('scm-pull', 'pull');
  remoteBtn('scm-push', 'push');
  $('scm-newbranch').addEventListener('click', async () => {
    const name = activeName(); if (!name) return;
    const branch = prompt('New branch name (created from current HEAD):');
    if (!branch) return;
    const r = await api.scmCheckout(name, branch.trim(), { create: true });
    if (!r || !r.ok) { alert(`Create branch failed: ${(r && r.error) || 'unknown'}`); return; }
    renderScm();
  });
  $('scm-refresh').addEventListener('click', () => renderScm());
  $('scm-close').addEventListener('click', () => closeAll());
  footBtns.scm.addEventListener('click', () => openPaneNamed('scm'));

  // =========================================================================
  // Worktrees
  // =========================================================================
  const wtList = $('worktrees-list');
  const wtEmpty = $('worktrees-empty');
  const wtNewBranch = $('worktree-new-branch');
  const wtNewBase = $('worktree-new-base');
  const wtBaseList = $('worktree-pane-base-list');

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
    // Populate base-branch autocomplete from repoInfo (via worktree:info on cwd
    // isn't reachable by name; the branch list from scm:branches is fine).
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
    // Open: reveal the worktree dir in the OS file manager (reuse file:open).
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
        if (!r || !r.ok) { alert(`Remove failed: ${(r && r.error) || 'unknown'}`); return; }
        renderWorktrees();
      });
      row.appendChild(rm);
    }
    return row;
  }

  $('worktree-add-btn').addEventListener('click', async () => {
    const name = activeName(); if (!name) return;
    const branch = wtNewBranch.value.trim();
    if (!branch) { wtNewBranch.focus(); return; }
    // worktree:create takes a repo cwd (not a session name). worktreeList already
    // resolved the active session's repo root server-side, so reuse it as the cwd.
    const wl = await api.worktreeList(name);
    if (!wl || !wl.ok) { alert('Not a git repo'); return; }
    const base = wtNewBase.value.trim() || null;
    const r = await api.createWorktree(wl.repo, branch, { base });
    if (!r || !r.ok) { alert(`Create worktree failed: ${(r && r.error) || 'unknown'}`); return; }
    wtNewBranch.value = ''; wtNewBase.value = '';
    renderWorktrees();
  });
  $('worktrees-refresh').addEventListener('click', () => renderWorktrees());
  $('worktrees-close').addEventListener('click', () => closeAll());
  footBtns.worktrees.addEventListener('click', () => openPaneNamed('worktrees'));

  // --- refresh dispatch ----------------------------------------------------
  function refreshOpenPane() {
    if (openPane === 'explorer') renderExplorer();
    else if (openPane === 'scm') renderScm();
    else if (openPane === 'worktrees') renderWorktrees();
  }

  // Menu-driven opens (View menu → request-open-*).
  if (api.onRequestOpenExplorer) api.onRequestOpenExplorer(() => openPaneNamed('explorer'));
  if (api.onRequestOpenScm) api.onRequestOpenScm(() => openPaneNamed('scm'));
  if (api.onRequestOpenWorktrees) api.onRequestOpenWorktrees(() => openPaneNamed('worktrees'));

  return { refreshOpenPane, closeAll };
}

module.exports = { initWorkspacePanes };
