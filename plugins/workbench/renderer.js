'use strict';
// plugins/workbench/renderer.js — the workbench pilot's RENDERER half
// (plugin-plan.md [internal design doc, not in this repo] §4, steps W1-W6). The whole "Workbench" surface: Files
// (lazy tree + editor), Source Control (git status/stage/discard/commit/branch/
// remote), and Worktrees, for a chosen session.
//
// Everything scopes to the SELECTED session's working directory (dropdown at the
// top; default = the ACTIVE session), resolved ENGINE-side by name through the
// plugin's own `fs.*` / `scm.*` / `wt.*` rows. Those refuse peer/remote sessions
// via the host's `fsScope` guarantee, so the dropdown lists only local sessions
// with a cwd.
//
// Modeled on the file-peek modal: centered overlay, one open at a time. The
// editor/diff area on the right is SHARED — the Files tab edits files there; the
// Source tab renders per-file diffs there (read-only). The Worktrees tab has no
// editor and fills the width.
//
// Activated ONCE PER BrowserWindow (§3.3 law 1): every piece of state below
// lives in this activation closure and dies with the window, and "disable" fans
// out across windows because the fan-out is the host's, not ours. The overlay
// CONTAINER is host-owned and removed wholesale on disable (MUST-FIX 6) — this
// file owns only its interior.
//
// No `window.api` anywhere in this file, ever — `rhost.invoke()` is the only
// door to the engine, and test/plugin-boundary.test.js enforces it. Escape and
// the one-open-at-a-time rule are the host surface's; drag stays here because it
// manipulates only our own modal.

// The interior of the host's overlay container. Cut verbatim out of
// renderer/index.html's `#workbench-overlay` block (W2) minus that block's outer
// backdrop div, which is now the host-created `.plugin-overlay` container.
const WORKBENCH_HTML = `
<div id="workbench-modal">
  <div class="workbench-topbar">
    <span class="workbench-title">Workbench</span>
    <select id="workbench-session" class="sidebar-select" data-tip="Session whose directory this workbench scopes to"></select>
    <div class="workbench-tabs">
      <button type="button" class="workbench-tab active" id="workbench-tab-files" data-tab="files">Files</button>
      <button type="button" class="workbench-tab" id="workbench-tab-scm" data-tab="scm">Source Control</button>
      <button type="button" class="workbench-tab" id="workbench-tab-worktrees" data-tab="worktrees">Worktrees</button>
    </div>
    <button type="button" class="popover-close" id="workbench-close" title="Close" aria-label="Close">&times;</button>
  </div>
  <div id="wb-root-indicator" class="wb-root-indicator hidden" role="button" tabindex="0"
       data-tip="Working outside the session directory — click to return to it"></div>
  <div class="workbench-body">
    <div class="workbench-left">
      <!-- Files: lazy tree -->
      <div id="wb-files-panel" class="workbench-panel">
        <div class="workbench-panel-bar">
          <span id="wb-files-scope" class="workbench-scope"></span>
          <button id="wb-files-up" type="button" data-tip="Browse the parent directory">Up</button>
          <button id="wb-files-goto" type="button" data-tip="Browse any folder — moves Source Control too">Go to Folder…</button>
          <button id="wb-files-refresh" type="button">Refresh</button>
        </div>
        <input type="text" id="wb-locate" class="sidebar-search wb-locate" placeholder="Go to file… (type to filter)" spellcheck="false" autocomplete="off">
        <div id="wb-locate-results" class="wb-locate-results hidden"></div>
        <div id="wb-tree" class="wb-tree"></div>
        <div id="wb-files-empty" class="hint hidden">No local session selected, or its directory isn't readable.</div>
      </div>
      <!-- Source control -->
      <div id="wb-scm-panel" class="workbench-panel hidden">
        <div class="wb-branchbar">
          <select id="wb-branch-select" class="sidebar-select" data-tip="Switch branch"></select>
          <span id="wb-aheadbehind" class="wb-aheadbehind"></span>
          <button id="wb-fetch" class="wb-remote-btn" data-tip="git fetch --all" type="button">⟳</button>
          <button id="wb-pull" class="wb-remote-btn" data-tip="git pull --ff-only" type="button">↓</button>
          <button id="wb-push" class="wb-remote-btn" data-tip="git push" type="button">↑</button>
          <button id="wb-newbranch" class="wb-remote-btn" data-tip="Create a new branch" type="button">+</button>
          <button id="wb-scm-refresh" class="wb-remote-btn" data-tip="Refresh" type="button">⟲</button>
        </div>
        <div id="wb-changes" class="wb-changes"></div>
        <div id="wb-commit-box" class="wb-commit-box">
          <textarea id="wb-commit-msg" class="wb-commit-msg" placeholder="Commit message (staged changes)" spellcheck="false" rows="2"></textarea>
          <button id="wb-commit-btn" type="button" disabled>Commit</button>
        </div>
        <div id="wb-scm-empty" class="hint hidden">No local session selected, or its directory isn't a git repository.</div>
      </div>
      <!-- Worktrees (full width; the shared editor hides for this tab) -->
      <div id="wb-worktrees-panel" class="workbench-panel hidden">
        <div class="workbench-panel-bar">
          <span class="workbench-scope">Worktrees for the repository at the active root</span>
          <button id="wb-worktrees-refresh" type="button">Refresh</button>
        </div>
        <div id="wb-worktrees-list" class="worktrees-list"></div>
        <div class="worktrees-add">
          <input type="text" id="wb-worktree-branch" class="sidebar-search" placeholder="new branch name" spellcheck="false" autocomplete="off">
          <input type="text" id="wb-worktree-base" class="sidebar-search" placeholder="base branch (optional)" spellcheck="false" autocomplete="off" list="wb-worktree-base-list">
          <datalist id="wb-worktree-base-list"></datalist>
          <button id="wb-worktree-add" type="button">Create Worktree</button>
        </div>
        <div id="wb-worktrees-empty" class="hint hidden">No local session selected, or its directory isn't a git repository.</div>
      </div>
    </div>
    <!-- Shared editor / diff area (Files edits here; Source shows diffs here) -->
    <div id="wb-editor" class="workbench-editor">
      <div class="wb-editor-bar">
        <span id="wb-editor-path" class="wb-editor-path"></span>
        <span id="wb-dirty" class="wb-dirty hidden" data-tip="Unsaved changes">●</span>
        <button id="wb-save" type="button" disabled>Save</button>
      </div>
      <textarea id="wb-textarea" class="wb-textarea hidden" spellcheck="false" wrap="off"></textarea>
      <div id="wb-diff" class="wb-diff hidden"></div>
      <div id="wb-editor-note" class="wb-editor-note hidden"></div>
      <div id="wb-editor-placeholder" class="wb-editor-placeholder">Select a file to view or edit.</div>
    </div>
  </div>
</div>`;

module.exports.activate = (rhost) => {
  // Assigned by wire() on first mount. The host calls `mount(el)` before the
  // first `onOpen`, so this is always set by the time it is read.
  let openFor = null;

  // The overlay surface. `mount` runs once, lazily, at first open; the container
  // it is handed is host-created and host-removed (MUST-FIX 6).
  const surface = rhost.ui.surfaces.overlay({
    id: 'main',
    mount(root) { wire(root, rhost); },
    onOpen(opts) { if (openFor) openFor(opts && opts.tab); },
  });

  function wire(rootEl, h) {
    const $ = (id) => rootEl.querySelector(`#${id}`);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const toast = (msg) => h.ui.showToast(msg, { kind: 'error' });

    rootEl.innerHTML = WORKBENCH_HTML;

    const modal = $('workbench-modal');
    const topbar = rootEl.querySelector('.workbench-topbar');
    const bodyEl = rootEl.querySelector('.workbench-body');
    const sessionSel = $('workbench-session');
    const tabs = { files: $('workbench-tab-files'), scm: $('workbench-tab-scm'), worktrees: $('workbench-tab-worktrees') };
    const panels = { files: $('wb-files-panel'), scm: $('wb-scm-panel'), worktrees: $('wb-worktrees-panel') };

    let curTab = 'files';
    let selName = null; // selected session name (scope)

    // =======================================================================
    // Session dropdown (local sessions with a cwd; peer/remote excluded).
    // Fetched from the engine at open: the renderer's own sessions Map is
    // terminal plumbing (no cwd), while the manager's record is the truth and
    // local-only by construction — peer sessions never enter it.
    //
    // WORKSPACE-SCOPED, never global. `rhost.sessions.listWorkspace(
    // rhost.workspaceId)` is the only accessor this half has, deliberately:
    // `listAll()` would silently turn a per-window dropdown into a
    // cross-workspace file READ/WRITE surface, and the engine's `fsScope`
    // would not catch it (it refuses peers, not foreign workspaces).
    // =======================================================================
    let sessionCache = [];
    async function fetchSessions() {
      try {
        const list = await h.sessions.listWorkspace(h.workspaceId);
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
      // Each open follows the ACTIVE session (the one you're looking at), not the
      // last dropdown pick — switching scope mid-open is what the dropdown is for.
      const active = h.sessions.active();
      if (list.some((s) => s.name === active)) selName = active;
      else if (!list.some((s) => s.name === selName)) selName = list[0].name;
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

    // =======================================================================
    // Selected worktree — the ACTIVE ROOT indicator
    // =======================================================================
    // The engine owns the selection (per session, in memory). This half only
    // reflects it, and never caches it: every open/refresh re-asks, so a
    // selection that died under us cannot leave a lying indicator on screen.
    //
    // Why the indicator is part of the feature and not decoration: because all
    // twelve fs./scm. rows follow the selection, `Commit` and `push` act on the
    // selected root. The failure this prevents is committing into a tree you
    // forgot you had selected — which is why the LABEL WORD is the engine's
    // `kind` and never a constant: a folder root the operator browsed to may be
    // an entirely different repository, and calling it "worktree" would describe
    // the one thing it is guaranteed not to be.
    const rootIndicator = $('wb-root-indicator');
    let activeRoot = null; // absolute path when a root is selected, else null

    // Every early return below leaves `activeRoot` set, so the Up button is
    // re-synced in a finally rather than at four return sites — one of which a
    // later edit would forget, leaving Up pointing at a root that moved.
    async function refreshRootIndicator() {
      try { await paintRootIndicator(); } finally { syncUpButton(); }
    }

    async function paintRootIndicator() {
      const name = activeName();
      if (!name) { activeRoot = null; rootIndicator.classList.add('hidden'); return; }
      const res = await h.invoke('wt.selected', name);
      if (!res || !res.ok) { activeRoot = null; rootIndicator.classList.add('hidden'); return; }
      if (res.dropped) toast('Selected root is gone — back to the session directory.');
      activeRoot = res.selected;
      if (!activeRoot) { rootIndicator.classList.add('hidden'); rootIndicator.textContent = ''; return; }
      const leaf = activeRoot.split('/').filter(Boolean).pop() || activeRoot;
      // Defaults to the LESS reassuring word on an unrecognised kind. Nothing
      // reaches that branch today, but a label whose job is to stop you
      // committing into the wrong tree must not under-state what it is showing.
      const label = res.kind === 'worktree' ? 'worktree' : 'folder';
      rootIndicator.innerHTML = `<span class="wb-root-label">${esc(label)}</span> ${esc(leaf)}`
        + `<span class="wb-root-reset">✕ session dir</span>`;
      rootIndicator.title = activeRoot;
      rootIndicator.classList.remove('hidden');
    }

    // Clear back to the session cwd, whichever kind is active: the engine keeps
    // ONE entry per session, so this one gesture cannot leave the other kind
    // standing. Also how you leave a root you no longer want.
    async function clearRoot() {
      const name = activeName(); if (!name) return;
      if (!confirmDiscardEdit()) return;
      await h.invoke('fs.setRoot', name, null);
      resetEditor();
      await refreshRootIndicator();
      refreshTab();
    }
    rootIndicator.addEventListener('click', clearRoot);
    rootIndicator.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clearRoot(); }
    });

    // Select a worktree as the active root. `wt.apply` both validates against
    // `wt.list` for this session and writes the selection — one row, so the
    // refusal of an arbitrary directory is the engine's, not this call site's.
    //
    // Selecting the MAIN worktree is how you get back to it explicitly; it is
    // still a real selection, not a clear, so the indicator stays truthful when
    // the session cwd is itself a non-main worktree.
    async function selectWorktree(name, worktreePath) {
      if (!confirmDiscardEdit()) return;
      const res = await h.invoke('wt.apply', name, worktreePath);
      if (!res || !res.ok) { toast(`Can't use that worktree: ${(res && res.error) || 'unknown'}`); return; }
      resetEditor();
      expExpanded.clear();
      await refreshRootIndicator();
      refreshTab();
    }

    // ── Browsing outside the session directory ─────────────────────────────
    // `fs.setRoot` validates the path engine-side; these two only supply one.
    // Both supply it from an operator gesture — a native pick, or Up from the
    // root already on screen — never from a path derived from untrusted input.
    // Up DOES compute its argument, and that is fine: the click is the gesture.
    // BOTH handles are captured BEFORE the web branch below removes them: `$`
    // queries the live tree, so a re-query after removal returns null and the
    // listener wiring throws — aborting the rest of wire() and leaving the whole
    // overlay unwired. Listeners on a detached node are harmless and never fire.
    const upBtn = $('wb-files-up');
    const gotoBtn = $('wb-files-goto');

    // Both browse controls are REMOVED on the web frontend, not disabled: the
    // engine's `fs.setRoot` is desktop-only by the surface gate (a web caller
    // able to repoint the root would turn the "any"-marked fs.list/fs.read into
    // an arbitrary-directory reader), so every click there fails into a toast.
    // The web dialog itself works — api-shim draws a type-a-path modal — which
    // is what makes a live-looking button here actively misleading.
    if (typeof window !== 'undefined' && window.__CLODEX_WEB__) {
      upBtn.remove();
      gotoBtn.remove();
    }

    // No require('path') in a renderer half — this file is web-bundled too.
    // Returns null AT the filesystem root, which is what disables the button;
    // POSIX dirname('/') === '/', and wiring that through would spin.
    const parentOf = (p) => {
      const s = String(p || '').replace(/\/+$/, '');
      const i = s.lastIndexOf('/');
      if (i < 0) return null;
      return i === 0 ? '/' : s.slice(0, i);
    };

    function syncUpButton() {
      // `isConnected` is false once the web branch above removed it. Assigning
      // to a detached node is harmless, but reading it here says so out loud so
      // the removal and this writer cannot drift apart.
      if (!upBtn.isConnected) return;
      const cur = activeRoot || curCwd();
      upBtn.disabled = !cur || !parentOf(cur);
    }

    // `confirmed` says the caller ALREADY asked about unsaved edits, so this must
    // not ask again. It defaults to false on purpose: a caller added later gets
    // the guard unless it opts out in a token visible at its own call site, so
    // the way to lose unsaved editor content is never silence.
    async function setFolderRoot(dir, { confirmed = false } = {}) {
      const name = activeName(); if (!name) return;
      if (!confirmed && !confirmDiscardEdit()) return;
      const res = await h.invoke('fs.setRoot', name, dir);
      if (!res || !res.ok) { toast(`Can't use that folder: ${(res && res.error) || 'unknown'}`); return; }
      resetEditor();
      expExpanded.clear();
      await refreshRootIndicator();
      refreshTab();
    }

    gotoBtn.addEventListener('click', async () => {
      if (!activeName()) return;
      // Ask about unsaved edits BEFORE the dialog, not after — a prompt raised
      // afterwards throws away a folder the operator has already picked. The
      // `confirmed` flag MOVES the guard here rather than adding a second one:
      // nothing between the two calls can dirty the editor, so asking again
      // would be the same modal twice for one click.
      if (!confirmDiscardEdit()) return;
      const dir = await h.ui.pickDirectory();
      if (!dir) return; // cancelled
      await setFolderRoot(dir, { confirmed: true });
    });

    upBtn.addEventListener('click', async () => {
      const parent = parentOf(activeRoot || curCwd());
      if (!parent) return;
      await setFolderRoot(parent);
    });

    sessionSel.addEventListener('change', () => {
      // Confirm before dropping unsaved edits, same as leaving the Files tab.
      // Restore the select to the still-current scope if the user cancels.
      if (!confirmDiscardEdit()) { sessionSel.value = selName || ''; return; }
      selName = sessionSel.value || null;
      resetEditor();
      // Each session carries its OWN worktree selection (engine-side, keyed by
      // name), so the indicator must re-resolve before the tab renders.
      locate.value = '';
      hideLocate();
      refreshRootIndicator().then(refreshTab);
    });

    // =======================================================================
    // Shared editor / diff area
    // =======================================================================
    const edPath = $('wb-editor-path');
    const edDirty = $('wb-dirty');
    const edSave = $('wb-save');
    const edTextarea = $('wb-textarea');
    const edDiff = $('wb-diff');
    const edNote = $('wb-editor-note');
    const edPlaceholder = $('wb-editor-placeholder');

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
      const res = await h.invoke('fs.read', name, rel);
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
      for (const r of $('wb-tree').querySelectorAll('.explorer-row')) {
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
      edDiff.innerHTML = h.lib.renderDiffHtml(diffText);
      showEditorOnly('diff');
    }

    edTextarea.addEventListener('input', () => {
      if (editingRel == null) return;
      setEditorDirty(edTextarea.value !== editingBaseline);
    });
    edSave.addEventListener('click', async () => {
      const name = activeName();
      if (!name || editingRel == null) return;
      const res = await h.invoke('fs.write', name, editingRel, edTextarea.value);
      if (!res || !res.ok) { toast(`Save failed: ${(res && res.error) || 'unknown'}`); return; }
      editingBaseline = edTextarea.value;
      setEditorDirty(false);
    });
    edTextarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (!edSave.disabled) edSave.click(); }
    });

    // =======================================================================
    // Files tab — lazy tree
    // =======================================================================
    const tree = $('wb-tree');
    const filesScope = $('wb-files-scope');
    const filesEmpty = $('wb-files-empty');
    const expExpanded = new Set();

    // =======================================================================
    // File locator — find-as-you-type over the active root
    // =======================================================================
    // Debounced, never per-keystroke: the walk is bounded engine-side
    // (fs-explorer.js MAX_VISIT / MAX_DEPTH / LOCATOR_SKIP) but a keystroke-rate
    // round trip would still be wasteful. Results replace the tree while the
    // field has text and restore it when cleared, so the tree is never lost.
    const locate = $('wb-locate');
    const locateResults = $('wb-locate-results');
    const LOCATE_DEBOUNCE_MS = 120;
    const LOCATE_CAP = 50;
    let locateTimer = null;
    let locateSeq = 0; // drop out-of-order responses

    function hideLocate() {
      locateResults.classList.add('hidden');
      locateResults.innerHTML = '';
      tree.classList.remove('hidden');
    }

    async function runLocate() {
      const name = activeName();
      const q = locate.value.trim();
      if (!name || !q) { hideLocate(); return; }
      const seq = ++locateSeq;
      const res = await h.invoke('fs.find', name, q, { cap: LOCATE_CAP });
      if (seq !== locateSeq) return; // a newer query already went out
      tree.classList.add('hidden');
      locateResults.classList.remove('hidden');
      locateResults.innerHTML = '';
      if (!res || !res.ok) {
        locateResults.innerHTML = `<div class="hint">${esc((res && res.error) || 'Search failed')}</div>`;
        return;
      }
      if (!res.matches.length) {
        locateResults.innerHTML = '<div class="hint">No matching files.</div>';
        return;
      }
      for (const m of res.matches) {
        const row = document.createElement('div');
        row.className = 'explorer-row wb-locate-row';
        row.dataset.rel = m.rel;
        const slash = m.rel.lastIndexOf('/');
        row.innerHTML = `<span class="wb-locate-name">${esc(m.name)}</span>`
          + (slash > 0 ? `<span class="wb-locate-dir">${esc(m.rel.slice(0, slash))}</span>` : '');
        row.addEventListener('click', () => openInEditor(name, m.rel));
        locateResults.appendChild(row);
      }
      if (res.truncated) {
        const more = document.createElement('div');
        more.className = 'hint';
        more.textContent = `Showing the first ${res.matches.length} — narrow the search for more.`;
        locateResults.appendChild(more);
      }
    }

    locate.addEventListener('input', () => {
      clearTimeout(locateTimer);
      locateTimer = setTimeout(runLocate, LOCATE_DEBOUNCE_MS);
    });
    locate.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && locate.value) {
        // Escape clears the search first; the host's own Escape closes the
        // overlay only once the field is empty.
        e.stopPropagation();
        locate.value = '';
        hideLocate();
        return;
      }
      if (e.key === 'Enter') {
        const first = locateResults.querySelector('.wb-locate-row');
        if (first) { const name = activeName(); if (name) openInEditor(name, first.dataset.rel); }
      }
    });

    async function renderExplorer() {
      const name = activeName();
      if (!name) { tree.innerHTML = ''; filesScope.textContent = ''; filesEmpty.classList.remove('hidden'); return; }
      // The ACTIVE root, not the session cwd: the tree below lists the active
      // root, and once a folder root can point into an unrelated repository a
      // bar naming the session directory is not merely imprecise, it names the
      // wrong tree in the one panel the browse feature lives in.
      filesScope.textContent = activeRoot || curCwd();
      const rootRes = await h.invoke('fs.list', name, '');
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
      const res = await h.invoke('fs.list', name, rel);
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

    // Re-ask the engine for the root before repainting: `fs.list` re-resolves
    // through effectiveRoot, so a root that died since the last wt.selected
    // would leave the scope bar naming it while the tree lists the session cwd.
    // Refresh is the button pressed precisely when something looks wrong.
    $('wb-files-refresh').addEventListener('click', () => refreshRootIndicator().then(renderExplorer));

    // =======================================================================
    // Source control tab
    // =======================================================================
    const scmChanges = $('wb-changes');
    const scmEmpty = $('wb-scm-empty');
    const scmBranchSel = $('wb-branch-select');
    const scmAheadBehind = $('wb-aheadbehind');
    const scmCommitMsg = $('wb-commit-msg');
    const scmCommitBtn = $('wb-commit-btn');
    let scmSelectedFile = null;

    const STATUS_CLASS = { M: 'modified', A: 'added', D: 'deleted', R: 'modified', C: 'modified', '?': 'untracked' };
    const statusChar = (f) => f.untracked ? '?' : (f.staged ? f.x : f.y);

    async function renderScm() {
      const name = activeName();
      if (!name) { scmChanges.innerHTML = ''; scmEmpty.classList.remove('hidden'); return; }
      const res = await h.invoke('scm.status', name);
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
      const br = await h.invoke('scm.branches', name);
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
          const r = isStaged ? await h.invoke('scm.unstage', name, paths) : await h.invoke('scm.stage', name, paths);
          if (!r || !r.ok) toast(`${isStaged ? 'Unstage' : 'Stage'} failed: ${(r && r.error) || 'unknown'}`);
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
        mkBtn('−', 'Unstage', async () => { await h.invoke('scm.unstage', name, f.path); renderScm(); });
      } else {
        mkBtn('+', 'Stage', async () => { await h.invoke('scm.stage', name, f.path); renderScm(); });
        mkBtn('⨯', 'Discard changes', async () => {
          if (!confirm(`Discard changes to ${f.path}? This can't be undone.`)) return;
          await h.invoke('scm.discard', name, f.path, { untracked: f.untracked }); renderScm();
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
      const res = await h.invoke('scm.diff', name, f.path, { staged: isStaged });
      if (!res || !res.ok) { showDiff(f.path, '', `diff failed: ${(res && res.error) || 'unknown'}`); return; }
      showDiff(f.path, res.diff, f.untracked ? '(untracked — open it in the Files tab to view)' : '(no textual diff)');
    }

    scmBranchSel.addEventListener('change', async () => {
      const name = activeName(); if (!name) return;
      const r = await h.invoke('scm.checkout', name, scmBranchSel.value, {});
      if (!r || !r.ok) toast(`Checkout failed: ${(r && r.error) || 'unknown'}`);
      renderScm();
    });
    scmCommitBtn.addEventListener('click', async () => {
      const name = activeName(); if (!name) return;
      const msg = scmCommitMsg.value.trim();
      if (!msg) { scmCommitMsg.focus(); return; }
      const r = await h.invoke('scm.commit', name, msg, {});
      if (!r || !r.ok) { toast(`Commit failed: ${(r && r.error) || 'unknown'}`); return; }
      scmCommitMsg.value = '';
      renderScm();
    });
    const remoteBtn = (id, op) => $(id).addEventListener('click', async () => {
      const name = activeName(); if (!name) return;
      const r = await h.invoke('scm.remote', name, op);
      if (r && r.error) toast(`git ${op} failed: ${r.error}`);
      else h.ui.showToast(`git ${op}: ${(r && r.output) || 'done'}`, { kind: 'info' });
      renderScm();
    });
    remoteBtn('wb-fetch', 'fetch');
    remoteBtn('wb-pull', 'pull');
    remoteBtn('wb-push', 'push');
    $('wb-newbranch').addEventListener('click', async () => {
      const name = activeName(); if (!name) return;
      const branch = prompt('New branch name (created from current HEAD):');
      if (!branch) return;
      const r = await h.invoke('scm.checkout', name, branch.trim(), { create: true });
      if (!r || !r.ok) { toast(`Create branch failed: ${(r && r.error) || 'unknown'}`); return; }
      renderScm();
    });
    $('wb-scm-refresh').addEventListener('click', () => renderScm());

    // =======================================================================
    // Worktrees tab
    // =======================================================================
    const wtList = $('wb-worktrees-list');
    const wtEmpty = $('wb-worktrees-empty');
    const wtNewBranch = $('wb-worktree-branch');
    const wtNewBase = $('wb-worktree-base');
    const wtBaseList = $('wb-worktree-base-list');

    async function renderWorktrees() {
      const name = activeName();
      if (!name) { wtList.innerHTML = ''; wtEmpty.classList.remove('hidden'); return; }
      const res = await h.invoke('wt.list', name);
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
      const br = await h.invoke('scm.branches', name);
      wtBaseList.innerHTML = '';
      if (br && br.ok) for (const b of br.local) { const o = document.createElement('option'); o.value = b; wtBaseList.appendChild(o); }
    }

    function worktreeRow(name, w) {
      const row = document.createElement('div');
      row.className = 'worktree-item';
      // Clicking the row SELECTS this worktree as the active root for every
      // Files/Source operation. The main worktree is selectable too — that is
      // how you get back to it.
      if (w.path === activeRoot) row.classList.add('selected');
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return; // Open/Remove keep their own jobs
        selectWorktree(name, w.path);
      });
      const meta = document.createElement('div');
      meta.className = 'worktree-meta';
      meta.innerHTML = `<div class="worktree-branch">${esc(w.branch || (w.detached ? `(detached ${w.head})` : '(no branch)'))}${w.isMain ? ' <span class="worktree-main-badge">main</span>' : ''}</div>`
        + `<div class="worktree-path" title="${esc(w.path)}">${esc(w.path)}</div>`;
      row.appendChild(meta);
      const openBtn = document.createElement('button');
      // Named "Reveal", not "Open": clicking the ROW is what opens a worktree in
      // the workbench now, so a button labelled "Open" beside it reads like the
      // primary action when it is the side one. This only hands the path to the
      // OS file manager.
      openBtn.textContent = 'Reveal';
      openBtn.title = 'Show this worktree in Finder';
      openBtn.addEventListener('click', () => h.ui.openPath(w.path));
      row.appendChild(openBtn);
      if (!w.isMain) {
        const rm = document.createElement('button');
        rm.textContent = 'Remove';
        rm.addEventListener('click', async () => {
          if (!confirm(`Remove worktree at ${w.path}? (git worktree remove --force)`)) return;
          const r = await h.invoke('wt.remove', w.path);
          if (!r || !r.ok) { toast(`Remove failed: ${(r && r.error) || 'unknown'}`); return; }
          // Removing the tree you were working in: the engine's use-time
          // re-validation would drop it anyway, but do it here too so the
          // indicator updates now rather than on the next operation.
          if (w.path === activeRoot) { await h.invoke('wt.apply', name, null); await refreshRootIndicator(); }
          renderWorktrees();
        });
        row.appendChild(rm);
      }
      return row;
    }

    $('wb-worktree-add').addEventListener('click', async () => {
      const name = activeName(); if (!name) return;
      const branch = wtNewBranch.value.trim();
      if (!branch) { wtNewBranch.focus(); return; }
      const wl = await h.invoke('wt.list', name);
      if (!wl || !wl.ok) { toast('Not a git repository.'); return; }
      const base = wtNewBase.value.trim() || null;
      const r = await h.invoke('wt.create', wl.repo, branch, { base });
      if (!r || !r.ok) { toast(`Create worktree failed: ${(r && r.error) || 'unknown'}`); return; }
      wtNewBranch.value = ''; wtNewBase.value = '';
      renderWorktrees();
    });
    $('wb-worktrees-refresh').addEventListener('click', () => renderWorktrees());

    // =======================================================================
    // Tabs + open
    // =======================================================================
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
      $('wb-editor').classList.toggle('hidden', !showEditor);
      bodyEl.classList.toggle('worktrees-mode', tab === 'worktrees');
      refreshTab();
    }

    for (const k of Object.keys(tabs)) tabs[k].addEventListener('click', () => setTab(k));

    // Reset drag offset AND any resized dimensions so each open starts fresh at
    // the default centered size (no persistence — keep it simple).
    function recenter() {
      modal.style.position = '';
      modal.style.left = '';
      modal.style.top = '';
      modal.style.margin = '';
      modal.style.width = '';
      modal.style.height = '';
    }

    // What the host's onOpen calls. The container is already visible by now (the
    // host unhides it, then calls onOpen), so this fills it in place.
    openFor = async (tab) => {
      await fetchSessions();
      populateSessions();
      resetEditor();
      locate.value = '';
      hideLocate();
      // Before the first render, so the tab paints against the right root and
      // the indicator is truthful from the very first frame.
      await refreshRootIndicator();
      recenter();
      setTab(tab || 'files');
    };

    // Drag by the topbar background only — never the session select, tabs, or
    // close button. Switches to position: fixed and clamps to the viewport.
    // Stays plugin-internal: it manipulates only our own modal.
    topbar.addEventListener('mousedown', (e) => {
      if (e.target !== topbar && !e.target.classList.contains('workbench-title')) return;
      const rect = modal.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const origLeft = rect.left, origTop = rect.top;
      modal.style.position = 'fixed';
      modal.style.margin = '0';
      // Freeze current size so switching to fixed doesn't re-resolve width:100%
      // against the viewport and jump on narrow screens.
      modal.style.width = `${rect.width}px`;
      modal.style.height = `${rect.height}px`;
      modal.style.left = `${origLeft}px`;
      modal.style.top = `${origTop}px`;
      const onMove = (ev) => {
        const w = modal.offsetWidth, ht = modal.offsetHeight;
        const nl = Math.max(0, Math.min(origLeft + ev.clientX - startX, window.innerWidth - w));
        const nt = Math.max(0, Math.min(origTop + ev.clientY - startY, window.innerHeight - ht));
        modal.style.left = `${nl}px`;
        modal.style.top = `${nt}px`;
      };
      const onUp = () => {
        h.removeEventListener(document, 'mousemove', onMove);
        h.removeEventListener(document, 'mouseup', onUp);
      };
      // Through the host's wrappers, not raw: these two live on `document`, so a
      // disable mid-drag would otherwise leave them firing forever.
      h.addEventListener(document, 'mousemove', onMove);
      h.addEventListener(document, 'mouseup', onUp);
      e.preventDefault();
    });

    // Escape and one-open-at-a-time are the host surface's (§2.6) — this half
    // installs no document-level key handler of its own.
    $('workbench-close').addEventListener('click', () => surface.close());
  }

  // §2.2 — the plugin's own entry point, replacing core's `#btn-workbench` and
  // the View ▸ Workbench menu item (both deleted in W4 along with the temporary
  // DOM-event bridge that stood in for them). The host renders the button into
  // `#sidebar-footer` with the same glyph+label structure as `#inbox-open`, and
  // removes it on disable — which is the point: the entry point now has the
  // same lifetime as the feature behind it, instead of outliving it as dead
  // chrome that opens nothing.
  rhost.ui.sidebar.footerButton({
    id: 'open',
    glyph: '◫',
    label: 'Workbench',
    tip: 'Workbench files, source control, and worktrees for a session',
    onClick: () => surface.open(),
  });
};

module.exports.deactivate = () => {
  // Nothing to do: the overlay container, its interior, the wrapped document
  // listeners and the injected <style> are all host-held and removed wholesale
  // (§3.1 law 3 / MUST-FIX 6).
};
