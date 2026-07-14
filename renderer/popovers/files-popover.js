// popovers/files-popover.js — the touched-files popover + its file-peek
// overlay (read-only Diff / File viewer). Rows are the files this agent's
// Edit/Write calls aimed at; a row opens a HEAD-relative git diff or the
// on-disk bytes. Self-contained island: it OWNS its DOM handles, dismiss
// wiring, and its two live subscriptions (onSessionFiles push, onSessionFileView
// open-request). Peek/diff DATA comes through popoverApi(name).peek/.diff;
// window.api.fileOpen is a shell action (open in the real editor). The shared
// core state it maintains — filesState/filesUnseen/peerFilesCount (the bar's
// count + unseen badge) and renderProxyBar — is injected by reference, and
// getActiveSession reads the live active tab (a reassigned core let).
//
// DOM-bound, so no unit tests per the R1 rule — move-only fidelity is the guarantee.

const { esc, fmtAgo } = require('../lib/format');
const { renderDiffHtml } = require('../lib/render-html');

function initFilesPopover({ popoverApi, filesState, filesUnseen, peerFilesCount, renderProxyBar, getActiveSession }) {
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
    // The browser frontend (window.__CLODEX_WEB__) likewise has no external editor
    // to escape to, and the file is already shown in-page, so hide Open there too.
    document.getElementById('file-peek-open').style.display = (api.remote || window.__CLODEX_WEB__) ? 'none' : '';
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

  // The peer subsystem needs to know whether the files popover is currently
  // showing a given session's rows (onPeerTelemetry suppresses the unseen latch
  // while the user is "seeing" it) without touching the private DOM handle.
  function isFilesPopoverForKey(key) {
    return !filesPopover.classList.contains('hidden') && filesPopover.dataset.name === key;
  }

  return { openFilesPopover, openFilePeek, isFilesPopoverForKey };
}

module.exports = { initFilesPopover };
