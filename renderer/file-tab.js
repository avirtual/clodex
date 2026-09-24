'use strict';

const { renderDiffHtml } = require('./lib/render-html');
const { scanPaths } = require('./lib/path-scan');
const { peekEditable } = require('./lib/side-pane-tabs');

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function button(doc, className, text, title) {
  const b = el(doc, 'button', className, text);
  b.type = 'button';
  if (title) b.title = title;
  return b;
}

function appendLinkified(doc, row, line) {
  const hits = scanPaths(line);
  let at = 0;
  for (const h of hits) {
    if (h.start > at) row.appendChild(doc.createTextNode(line.slice(at, h.start)));
    const span = el(doc, 'span', 'peek-path', h.text);
    span.dataset.path = h.path;
    if (h.line) span.dataset.goto = String(h.line);
    row.appendChild(span);
    at = h.end;
  }
  const rest = line.slice(at);
  if (rest || !hits.length) row.appendChild(doc.createTextNode(rest || ' '));
}

function createFileTab({ doc = document, filePath, editable, showOpen, on }) {
  const root = el(doc, 'div', 'side-tab-view side-file');
  const bar = el(doc, 'div', 'side-file-bar');
  const pathEl = el(doc, 'span', 'side-file-path', filePath);
  pathEl.title = filePath;
  const byEl = el(doc, 'span', 'side-file-by');
  byEl.hidden = true;
  const controls = el(doc, 'span', 'file-peek-controls');
  const diffBtn = button(doc, 'file-peek-tab', 'Diff');
  const fileBtn = button(doc, 'file-peek-tab', 'File');
  const editBtn = button(doc, 'file-peek-tab', 'Edit');
  const dirtyEl = el(doc, 'span', 'file-peek-dirty hidden', '•');
  dirtyEl.title = 'Unsaved changes';
  const saveBtn = button(doc, 'file-peek-open side-file-save hidden', 'Save', 'Save (Cmd+S)');
  const openBtn = button(doc, 'file-peek-open', 'Open', 'Open in the default editor');
  if (!showOpen) openBtn.style.display = 'none';
  controls.append(diffBtn, fileBtn, editBtn, dirtyEl, saveBtn, openBtn);
  bar.append(pathEl, byEl, controls);

  const banner = el(doc, 'div', 'side-file-banner hidden');
  const bannerText = el(doc, 'span', 'side-file-banner-text');
  const reloadBtn = button(doc, 'side-file-banner-act', 'Reload (discard yours)');
  const theirsBtn = button(doc, 'side-file-banner-act', 'Show their change');
  const keepBtn = button(doc, 'side-file-banner-act', 'Keep editing');
  banner.append(bannerText, reloadBtn, theirsBtn, keepBtn);

  const body = el(doc, 'div', 'side-file-body');
  body.appendChild(el(doc, 'div', 'cost-note', 'Loading…'));
  const editor = el(doc, 'textarea', 'side-file-editor hidden');
  editor.spellcheck = false;
  root.append(bar, banner, body, editor);

  let peekRes = null;
  let diffRes = null;
  let baseline = null;
  let dataRev = 0;
  let paintedKey = '';

  const canEdit = () => peekEditable(editable, peekRes);
  const isDirty = () => baseline != null && editor.value !== baseline;

  function renderDirty() {
    const d = isDirty();
    dirtyEl.classList.toggle('hidden', !d || editor.classList.contains('hidden'));
    saveBtn.disabled = !d;
  }

  function setData(nextPeek, nextDiff, { keepBuffer = false } = {}) {
    peekRes = nextPeek;
    diffRes = nextDiff;
    dataRev++;
    if (keepBuffer) return;
    if (canEdit()) {
      editor.value = peekRes.content;
      baseline = peekRes.content;
    } else {
      editor.value = '';
      baseline = null;
    }
  }

  function markSaved(text, res) {
    baseline = text;
    peekRes = { ...peekRes, content: text, size: res.size, mtime: res.mtime };
    dataRev++;
    renderDirty();
  }

  function setDiff(nextDiff) {
    diffRes = nextDiff;
    dataRev++;
  }

  function defaultView(forceView) {
    if (forceView === 'edit' && !canEdit()) return 'file';
    if (forceView) return forceView;
    return (diffRes && diffRes.ok && !diffRes.untracked && diffRes.diff.trim()) ? 'diff' : 'file';
  }

  function paintNote(text) {
    body.replaceChildren(el(doc, 'div', 'cost-note', text));
  }

  function paintDiff() {
    const diffOk = !!(diffRes && diffRes.ok);
    if (!diffOk) return paintNote((diffRes && diffRes.error) || 'Diff unavailable');
    if (diffRes.untracked) return paintNote('New file — not tracked by git yet. The File tab shows its full contents.');
    if (!diffRes.diff.trim()) return paintNote('No uncommitted changes — what the agent touched here is already committed (or was reverted).');
    const pre = el(doc, 'div', 'file-peek-pre');
    pre.innerHTML = renderDiffHtml(diffRes.diff, { lineNumbers: true });
    body.replaceChildren(pre);
  }

  function paintFile(tab) {
    if (tab.deleted) return paintNote('No longer on disk.');
    if (!peekRes || !peekRes.ok) return paintNote((peekRes && peekRes.error) || 'File unavailable');
    if (peekRes.binary) return paintNote(`Binary file (${peekRes.size} bytes) — use Open.`);
    const nodes = [];
    if (peekRes.truncated) {
      nodes.push(el(doc, 'div', 'cost-note',
        `Showing the first ${Math.round(peekRes.content.length / 1024)}KB of ${Math.round(peekRes.size / 1024)}KB.`));
    }
    const raw = peekRes.content.split('\n');
    const w = String(raw.length).length;
    const pre = el(doc, 'div', 'file-peek-pre');
    raw.forEach((l, i) => {
      const row = el(doc, 'div', `diff-line diff-ctx${tab.line === i + 1 ? ' peek-line-hit' : ''}`);
      row.dataset.line = String(i + 1);
      row.appendChild(el(doc, 'span', 'peek-ln', String(i + 1).padStart(w, ' ')));
      appendLinkified(doc, row, l);
      pre.appendChild(row);
    });
    nodes.push(pre);
    body.replaceChildren(...nodes);
  }

  function anchorLine() {
    const rows = body.querySelectorAll('.diff-line[data-line]');
    for (const r of rows) if (r.offsetTop + r.offsetHeight > body.scrollTop) return Number(r.dataset.line);
    return null;
  }

  function scrollToLine(n, block) {
    const row = body.querySelector(`.diff-line[data-line="${n}"]`);
    if (!row) return;
    if (block === 'top') body.scrollTop = row.offsetTop - body.offsetTop;
    else row.scrollIntoView({ block: 'center' });
  }

  function render(tab, { anchor = null } = {}) {
    const view = tab.view || 'file';
    const edit = view === 'edit';
    diffBtn.classList.toggle('active', view === 'diff');
    fileBtn.classList.toggle('active', view === 'file');
    editBtn.classList.toggle('active', edit);
    editBtn.style.display = canEdit() ? '' : 'none';
    const diffOk = !!(diffRes && diffRes.ok);
    diffBtn.disabled = !diffOk;
    diffBtn.title = diffOk ? 'Uncommitted changes (git, vs HEAD)' : ((diffRes && diffRes.error) || 'Diff unavailable');
    byEl.textContent = tab.pushedBy ? `pushed by ${tab.pushedBy}` : '';
    byEl.hidden = !tab.pushedBy;
    pathEl.textContent = tab.deleted ? `${filePath} (deleted)` : filePath;
    body.classList.toggle('hidden', edit);
    editor.classList.toggle('hidden', !edit);
    saveBtn.classList.toggle('hidden', !edit);
    banner.classList.toggle('hidden', !tab.banner);
    renderDirty();
    if (edit || (!peekRes && !diffRes)) return;
    const key = `${dataRev}|${view}|${tab.line}|${tab.deleted}`;
    if (key === paintedKey) return;
    paintedKey = key;
    if (view === 'diff') paintDiff();
    else paintFile(tab);
    if (view === 'file' && anchor != null) scrollToLine(anchor, 'top');
    else if (view === 'file' && tab.line) scrollToLine(tab.line, 'center');
  }

  function showBanner(seat, at) {
    const hh = String(at.getHours()).padStart(2, '0');
    const mm = String(at.getMinutes()).padStart(2, '0');
    bannerText.textContent = `${seat} changed this file at ${hh}:${mm} — `;
  }

  diffBtn.addEventListener('click', () => on.view('diff'));
  fileBtn.addEventListener('click', () => on.view('file'));
  editBtn.addEventListener('click', () => {
    if (!canEdit()) return;
    on.view('edit');
    editor.focus();
  });
  editor.addEventListener('input', () => { renderDirty(); on.dirty(isDirty()); });
  editor.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (!saveBtn.disabled) on.save(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); on.escape(); }
  });
  saveBtn.addEventListener('click', () => on.save());
  openBtn.addEventListener('click', () => on.open());
  reloadBtn.addEventListener('click', () => on.discard());
  theirsBtn.addEventListener('click', () => on.theirs());
  keepBtn.addEventListener('click', () => on.keep());
  body.addEventListener('click', (e) => {
    const link = e.target.closest('.peek-path');
    if (link) on.follow(link.dataset.path, link.dataset.goto ? Number(link.dataset.goto) : null);
  });

  return {
    el: root,
    canEdit,
    isDirty,
    getText: () => editor.value,
    setSaving: (busy) => { saveBtn.disabled = busy || !isDirty(); },
    setData,
    setDiff,
    markSaved,
    defaultView,
    anchorLine,
    render,
    showBanner,
  };
}

module.exports = { createFileTab };
