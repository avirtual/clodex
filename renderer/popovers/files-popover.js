const { esc, fmtAgo } = require('../lib/format');

function initFilesPopover({ popoverApi, filesState, filesUnseen, peerFilesCount, renderProxyBar, getActiveSession, sidePane }) {
  // ── Touched files (wire file-tool observer) ────────────────────────────
  // The files this agent's Edit/Write/NotebookEdit calls were aimed at, as
  // clickable rows: row → read-only peek with a Diff view (git is the truth for
  // what actually changed — the feed only records the aim). Fed live via
  // session-files pushes; pulled fresh on popover open so a detached-window gap
  // loses nothing. Facts only — no client-side classification.
  const filesPopover = document.getElementById('files-popover');
  const filesPopoverName = document.getElementById('files-popover-name');
  const filesPopoverBody = document.getElementById('files-popover-body');
  const cwdByName = new Map();

  window.api.onSessionFiles((name, files) => {
    filesState.set(name, files || []);
    sidePane.noteFiles(name, files || []);
    // Live-refresh whatever is showing: the bar button's count, and the open
    // popover's rows (dataset.name pins which session it is showing).
    const watching = !filesPopover.classList.contains('hidden') && filesPopover.dataset.name === name;
    // Latch the unseen highlight unless the user is looking at the rows right
    // now. Set BEFORE the bar re-render so the rebuilt button picks it up.
    if (!watching) filesUnseen.add(name);
    if (name === getActiveSession()) {
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
    const cwd = cwdByName.get(name) || '';
    const outside = (f) => !!cwd && !f.path.startsWith(cwd + '/');
    const rows = files.map((f) => {
      const inCwd = !!cwd && f.path.startsWith(cwd + '/');
      const rel = inCwd ? f.path.slice(cwd.length + 1) : f.path;
      const base = rel.split('/').pop();
      const dir = rel.slice(0, rel.length - base.length);
      const badges = []; // aim-count + subagent provenance, not change size
      if (f.count > 1) badges.push(`<span class="file-badge" title="Touched ${f.count} times">×${f.count}</span>`);
      if (f.sub) badges.push('<span class="file-badge file-badge-sub" title="Touched via a subagent">sub</span>');
      return `<div class="file-row${outside(f) ? ' file-row-out' : ''}" data-path="${esc(f.path)}" title="${esc(f.path)} — click to view / diff">`
        + `<span class="file-row-main"><span class="file-row-dir">${esc(dir)}</span><span class="file-row-name">${esc(base)}</span>${badges.join('')}</span>`
        + `<span class="file-row-meta">${esc(f.tool)} · ${fmtAgo(f.ts)}</span>`
        + `</div>`;
    }).join('');
    filesPopoverBody.innerHTML = `<div class="file-rows">${rows}</div>`
      + (files.some(outside)
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
    if (res.cwd) cwdByName.set(name, res.cwd);
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
  filesPopoverBody.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.file-row');
    if (!row || !row.dataset.path) return;
    sidePane.open(filesPopover.dataset.name, { kind: 'file', path: row.dataset.path });
  });
  document.addEventListener('mousedown', (e) => {
    if (filesPopover.classList.contains('hidden')) return;
    if (filesPopover.contains(e.target)) return;
    if (e.target.closest('[data-act="files"]')) return; // toggle handled by the bar
    if (e.target.closest('#side-pane')) return;
    closeFilesPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !filesPopover.classList.contains('hidden')) closeFilesPopover();
  });
  document.getElementById('files-popover-close').addEventListener('click', closeFilesPopover);

  async function openFilePeek(name, filePath, forceTab = null, line = null, keepHistory = false, pushedBy = null) {
    sidePane.open(name, { kind: 'file', path: filePath }, { line, view: forceTab, pushedBy });
  }
  window.api.onSessionFileView((name, filePath) => { openFilePeek(name, filePath, null, null, false, name); });

  // The peer subsystem needs to know whether the files popover is currently
  // showing a given session's rows (onPeerTelemetry suppresses the unseen latch
  // while the user is "seeing" it) without touching the private DOM handle.
  function isFilesPopoverForKey(key) {
    return !filesPopover.classList.contains('hidden') && filesPopover.dataset.name === key;
  }

  function forget(name) { cwdByName.delete(name); }

  return { openFilesPopover, openFilePeek, isFilesPopoverForKey, forget };
}

module.exports = { initFilesPopover };
