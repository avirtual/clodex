// popovers/files-popover.js — the touched-files popover + its file-peek
// overlay (Diff / File / Edit). Rows are the files this agent's
// Edit/Write calls aimed at; a row opens a HEAD-relative git diff, the
// on-disk bytes, or an editor over them. Self-contained island: it OWNS its DOM
// handles, dismiss wiring, and its two live subscriptions (onSessionFiles push,
// onSessionFileView open-request). Peek/diff DATA comes through
// popoverApi(name).peek/.diff; the SAVE goes straight to window.api.fileWrite
// and never through popoverApi, because that seam's peer branch is reads only.
// window.api.fileOpen is a shell action (open in the real editor). The shared
// core state it maintains — filesState/filesUnseen/peerFilesCount (the bar's
// count + unseen badge) and renderProxyBar — is injected by reference, and
// getActiveSession reads the live active tab (a reassigned core let).
//
// DOM-bound, so no unit tests per the R1 rule — move-only fidelity is the guarantee.

const { esc, fmtAgo } = require('../lib/format');
const { renderDiffHtml } = require('../lib/render-html');
const { scanPaths } = require('../lib/path-scan');
const { makeDraggable, resetDrag } = require('../lib/popover-drag');

function initFilesPopover({ popoverApi, filesState, filesUnseen, peerFilesCount, renderProxyBar, getActiveSession, showToast }) {
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

  // --- File peek: Diff / File / Edit ----------------------------------------
  // Diff is HEAD-relative git truth fetched fresh on every open; File is the
  // current on-disk bytes (size-capped, binary-sniffed); Edit is those same
  // bytes in a textarea, saved through file:write.
  //
  // Edit is OWNER-LOCAL and OFF for truncated or binary content — the tab hides
  // rather than disabling, because a Save that would write back a truncated view
  // deletes everything past the peek cap. The engine refuses it too
  // (file-edit.js); this is the affordance, not the guard.
  const filePeekOverlay = document.getElementById('file-peek-overlay');
  const filePeekModal = document.getElementById('file-peek-modal');
  const filePeekPath = document.getElementById('file-peek-path');
  const filePeekBody = document.getElementById('file-peek-body');
  const filePeekTabDiff = document.getElementById('file-peek-tab-diff');
  const filePeekTabFile = document.getElementById('file-peek-tab-file');
  const filePeekTabEdit = document.getElementById('file-peek-tab-edit');
  const filePeekEditor = document.getElementById('file-peek-editor');
  const filePeekSave = document.getElementById('file-peek-save');
  const filePeekDirty = document.getElementById('file-peek-dirty');
  const peekBackBtn = document.getElementById('file-peek-back');
  // { path, name, tab, diffRes, peekRes, line, baseline, mtime }
  let filePeek = null;
  // Where a path-click came FROM, so following one is not a dead end. Cleared
  // whenever the peek is opened from outside itself (a row, an intent, a
  // terminal click) — that is a new journey, not a step in the current one.
  let peekBack = [];

  const peekDirty = () => !!(filePeek && filePeek.baseline != null && filePeekEditor.value !== filePeek.baseline);

  function renderPeekDirty() {
    const d = peekDirty();
    filePeekDirty.classList.toggle('hidden', !d);
    filePeekSave.disabled = !d;
  }

  // Guard against dropping unsaved edits, same as the workbench editor's.
  function confirmDiscardPeekEdit() {
    if (!peekDirty()) return true;
    return confirm('Discard unsaved changes to this file?');
  }

  function closeFilePeek() {
    if (!confirmDiscardPeekEdit()) return;
    filePeekOverlay.classList.add('hidden');
    filePeek = null;
  }

  // Wrap path-shaped tokens in a clickable span. Speculative on purpose: this
  // does NOT stat, so a token that names nothing still renders as a link and
  // reports "can't find" on click. Statting every token in a 512KB file would be
  // thousands of sync fs calls per render; resolving one on click is one.
  function linkifyPaths(line) {
    const hits = scanPaths(line);
    if (!hits.length) return esc(line);
    let out = '';
    let at = 0;
    for (const h of hits) {
      out += esc(line.slice(at, h.start));
      out += `<span class="peek-path" data-path="${esc(h.path)}"${h.line ? ` data-goto="${h.line}"` : ''}>${esc(h.text)}</span>`;
      at = h.end;
    }
    return out + esc(line.slice(at));
  }

  // Editable = local session, and content we can round-trip without losing
  // bytes. Truncated content is the load-bearing one: saving the textarea would
  // write the head and drop the tail.
  function peekEditable() {
    const { peekRes, editable } = filePeek || {};
    return !!(editable && peekRes && peekRes.ok && !peekRes.binary && !peekRes.truncated);
  }

  function renderFilePeek() {
    if (!filePeek) return;
    const { tab, diffRes, peekRes } = filePeek;
    filePeekTabDiff.classList.toggle('active', tab === 'diff');
    filePeekTabFile.classList.toggle('active', tab === 'file');
    filePeekTabEdit.classList.toggle('active', tab === 'edit');
    filePeekTabEdit.style.display = peekEditable() ? '' : 'none';
    peekBackBtn.classList.toggle('hidden', peekBack.length === 0);
    filePeekBody.classList.toggle('hidden', tab === 'edit');
    filePeekEditor.classList.toggle('hidden', tab !== 'edit');
    filePeekSave.classList.toggle('hidden', tab !== 'edit');
    filePeekDirty.classList.toggle('hidden', tab !== 'edit' || !peekDirty());
    const diffOk = !!(diffRes && diffRes.ok);
    filePeekTabDiff.disabled = !diffOk;
    filePeekTabDiff.title = diffOk ? 'Uncommitted changes (git, vs HEAD)' : ((diffRes && diffRes.error) || 'Diff unavailable');
    if (tab === 'edit') {
      renderPeekDirty();
      return;
    }
    if (tab === 'diff') {
      if (!diffOk) {
        filePeekBody.innerHTML = `<div class="cost-note">${esc((diffRes && diffRes.error) || 'Diff unavailable')}</div>`;
      } else if (diffRes.untracked) {
        filePeekBody.innerHTML = '<div class="cost-note">New file — not tracked by git yet. The File tab shows its full contents.</div>';
      } else if (!diffRes.diff.trim()) {
        filePeekBody.innerHTML = '<div class="cost-note">No uncommitted changes — what the agent touched here is already committed (or was reverted).</div>';
      } else {
        // Numbered to match the File tab's gutter — switching tabs on the same
        // file should not change which column the code starts in.
        filePeekBody.innerHTML = `<div class="file-peek-pre">${renderDiffHtml(diffRes.diff, { lineNumbers: true })}</div>`;
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
      // Gutter width tracks the line count so it doesn't jump between files.
      // Scan the RAW line, escape per fragment: scanning escaped HTML would put
      // offsets in the wrong coordinate space (`&amp;` is 5 chars for 1) and
      // wrapping after escaping would inject markup into escaped text.
      const raw = peekRes.content.split('\n');
      const w = String(raw.length).length;
      const rows = raw.map((l, i) => {
        const n = String(i + 1).padStart(w, ' ');
        const hit = filePeek.line === i + 1 ? ' peek-line-hit' : '';
        return `<div class="diff-line diff-ctx${hit}" data-line="${i + 1}"><span class="peek-ln">${n}</span>${linkifyPaths(l) || ' '}</div>`;
      }).join('');
      filePeekBody.innerHTML = `${note}<div class="file-peek-pre">${rows}</div>`;
      if (filePeek.line) {
        const el = filePeekBody.querySelector(`.diff-line[data-line="${filePeek.line}"]`);
        if (el) el.scrollIntoView({ block: 'center' });
      }
    }
  }

  // forceTab pins the tab for callers that know which view they want (a click
  // on a `path:line` wants the file, not the diff); without it the tab is
  // chosen below by which view has something to say.
  // `keepHistory` distinguishes a step WITHIN a peek (following a path, going
  // back) from a fresh open by a row / intent / terminal click. Only the latter
  // resets the back stack — otherwise every navigation would erase its own trail.
  async function openFilePeek(name, filePath, forceTab = null, line = null, keepHistory = false) {
    if (!confirmDiscardPeekEdit()) return;
    if (!keepHistory) peekBack = [];
    const api = popoverApi(name);
    filePeek = {
      path: filePath, name, tab: 'diff', diffRes: null, peekRes: null, line,
      editable: !api.remote, baseline: null, mtime: null,
    };
    filePeekEditor.value = '';
    filePeekEditor.rows = 8;
    filePeekSave.disabled = true;
    filePeekPath.textContent = filePath;
    filePeekPath.title = filePath;
    // A remote file has no local path to hand to an editor — Open is owner-only.
    // The browser frontend (window.__CLODEX_WEB__) likewise has no external editor
    // to escape to, and the file is already shown in-page, so hide Open there too.
    document.getElementById('file-peek-open').style.display = (api.remote || window.__CLODEX_WEB__) ? 'none' : '';
    filePeekBody.innerHTML = '<div class="cost-note">Loading…</div>';
    // Re-anchor only when the peek was CLOSED. While it is open, the position is
    // the user's — following a path, going back, or opening another row should
    // not yank the modal out from under the pointer it was just moved away from.
    if (filePeekOverlay.classList.contains('hidden')) resetDrag(filePeekModal);
    filePeekOverlay.classList.remove('hidden');
    const [diffRes, peekRes] = await Promise.all([
      api.diff(filePath).catch((e) => ({ ok: false, error: String(e) })),
      api.peek(filePath).catch((e) => ({ ok: false, error: String(e) })),
    ]);
    if (!filePeek || filePeek.path !== filePath) return; // closed / retargeted mid-fetch
    filePeek.diffRes = diffRes;
    filePeek.peekRes = peekRes;
    // Seed the editor from the SAME read the File tab shows, and remember its
    // mtime — the save sends it back so a file the agent rewrote underneath us
    // is refused instead of silently overwritten.
    if (peekRes && peekRes.ok && !peekRes.binary && !peekRes.truncated) {
      filePeekEditor.value = peekRes.content;
      // Match the File tab's height: one row per rendered line. The floor keeps
      // a two-line file from collapsing to an unusable box; the ceiling only
      // bounds the flex basis, since the modal's max-height clamps it anyway.
      filePeekEditor.rows = Math.min(Math.max(peekRes.content.split('\n').length, 8), 400);
      filePeek.baseline = peekRes.content;
      filePeek.mtime = peekRes.mtime;
    }
    // Default to the view with something to say: a real diff → Diff; untracked,
    // clean, or no git → File.
    filePeek.tab = (forceTab === 'edit' && !peekEditable() ? 'file' : forceTab)
      || ((diffRes && diffRes.ok && !diffRes.untracked && diffRes.diff.trim()) ? 'diff' : 'file');
    renderFilePeek();
  }

  // Leaving Edit does NOT discard: the textarea keeps its bytes and the dirty
  // dot survives the round trip, so a glance at the Diff tab isn't a trap.
  filePeekTabDiff.addEventListener('click', () => { if (filePeek) { filePeek.tab = 'diff'; renderFilePeek(); } });
  filePeekTabFile.addEventListener('click', () => { if (filePeek) { filePeek.tab = 'file'; renderFilePeek(); } });
  filePeekTabEdit.addEventListener('click', () => {
    if (!filePeek || !peekEditable()) return;
    filePeek.tab = 'edit';
    renderFilePeek();
    filePeekEditor.focus();
  });
  filePeekEditor.addEventListener('input', renderPeekDirty);
  filePeekEditor.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (!filePeekSave.disabled) filePeekSave.click(); }
    // The overlay's Escape closes the peek; inside a dirty editor that reads as
    // a keystroke, not a dismissal, so stop it before the document handler.
    if (e.key === 'Escape' && peekDirty()) e.stopPropagation();
  });
  filePeekSave.addEventListener('click', async () => {
    if (!filePeek || !peekEditable()) return;
    const { path: p, name, mtime } = filePeek;
    const text = filePeekEditor.value;
    filePeekSave.disabled = true;
    const res = await window.api.fileWrite(name, p, text, mtime)
      .catch((e) => ({ ok: false, error: String(e) }));
    if (!filePeek || filePeek.path !== p) return; // closed / retargeted mid-save
    if (!res || !res.ok) {
      // Re-enable rather than clearing: the edit is still in the textarea and
      // still unsaved, so the button must stay live to try again.
      filePeekSave.disabled = false;
      showToast(`Save failed: ${(res && res.error) || 'unknown'}`, { kind: 'error', duration: 10000 });
      return;
    }
    filePeek.baseline = text;
    filePeek.mtime = res.mtime;
    // The Diff tab is now stale by exactly this save; refetch so switching to it
    // shows what was just written rather than the pre-save diff.
    filePeek.peekRes = { ...filePeek.peekRes, content: text, size: res.size, mtime: res.mtime };
    renderPeekDirty();
    const fresh = await popoverApi(name).diff(p).catch((e) => ({ ok: false, error: String(e) }));
    if (filePeek && filePeek.path === p) { filePeek.diffRes = fresh; renderFilePeek(); }
  });
  document.getElementById('file-peek-open').addEventListener('click', async () => {
    if (!filePeek) return;
    // shell.openPath resolves an error STRING on failure — close only on a
    // clean open; a failed one keeps the popover up (the only feedback we have).
    const err = await window.api.fileOpen(filePeek.path);
    if (!err) closeFilePeek();
  });
  // A path inside a peeked file resolves against THAT file's directory first
  // (baseDir), which is why the resolve call carries it — `../lib/format` in
  // renderer/popovers/x.js means renderer/lib/format, not <repo>/lib/format.
  filePeekBody.addEventListener('click', async (e) => {
    const el = e.target.closest('.peek-path');
    if (!el || !filePeek) return;
    const { name, path: from } = filePeek;
    const cut = from.lastIndexOf('/');
    const baseDir = cut > 0 ? from.slice(0, cut) : null; // no separator → no base to offer
    const res = await window.api.fileResolve(name, el.dataset.path, baseDir)
      .catch((err) => ({ ok: false, error: String(err) }));
    if (!res || !res.ok) {
      showToast((res && res.error) || `Can't find "${el.dataset.path}"`, { kind: 'warn', duration: 4000 });
      return;
    }
    peekBack.push({ path: from, line: filePeek.line, tab: filePeek.tab });
    openFilePeek(name, res.path, 'file', el.dataset.goto ? Number(el.dataset.goto) : null, true);
  });
  peekBackBtn.addEventListener('click', () => {
    const prev = peekBack.pop();
    if (!prev || !filePeek) return;
    openFilePeek(filePeek.name, prev.path, prev.tab, prev.line, true);
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
  // Draggable by its title bar (shared helper), so a peek can be moved off
  // whatever it is covering. The drag is a transform, which composes with the
  // overlay's flex centering and leaves the resize handle working. The helper
  // ignores mousedowns on title buttons, so the tabs keep their clicks.
  makeDraggable(filePeekModal);

  // The peer subsystem needs to know whether the files popover is currently
  // showing a given session's rows (onPeerTelemetry suppresses the unseen latch
  // while the user is "seeing" it) without touching the private DOM handle.
  function isFilesPopoverForKey(key) {
    return !filesPopover.classList.contains('hidden') && filesPopover.dataset.name === key;
  }

  return { openFilesPopover, openFilePeek, isFilesPopoverForKey };
}

module.exports = { initFilesPopover };
