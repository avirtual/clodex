'use strict';
// selection-popover.js — the drawer's 📋 inspector: what is actually on its way
// to this agent. Opened from the drawer header.
//
// WHY IT READS THE PROXY AND NOT CLODEX'S OWN STATE: an arm can time out, be
// rolled back locally, and land on the proxy anyway (measured 2026-08-06 — the
// status line said nothing was armed while text rode the next request). An
// inspector built on the same memo as the status line would repeat its lie
// with more authority. So `drawer:inspectSelection` returns both claims and
// selection-view.js decides what to say about the difference.
//
// Fetched on OPEN, never polled: a background poll would cost a proxy round
// trip per session forever to answer a question nobody is asking, and the
// answer is only wanted at the moment of doubt.

const { esc } = require('../lib/format');
const { buildRows, liveCount } = require('../lib/selection-view');

function initSelectionPopover({ getActiveSession }) {
  const pop = document.getElementById('selection-popover');
  const nameEl = document.getElementById('selection-popover-name');
  const body = document.getElementById('selection-popover-body');
  const btn = document.getElementById('drawer-clipboard');
  const countEl = document.getElementById('drawer-clipboard-count');
  if (!pop || !btn) return { openSelectionPopover: () => {}, refreshSelectionBadge: () => {} };

  function close() { pop.classList.add('hidden'); pop.dataset.name = ''; }

  function render(data) {
    const { rows, note } = buildRows(data);
    if (!rows.length) return `<div class="sel-empty">${esc(note)}</div>`;
    return rows.map((r) => {
      const head = (r.title || r.meta)
        ? `<div class="sel-head"><span class="sel-title">${esc(r.title)}</span><span class="sel-meta">${esc(r.meta)}</span></div>`
        : '';
      const text = r.text ? `<div class="sel-text">${esc(r.text)}</div>` : '';
      const n = r.note ? `<div class="sel-note${r.warn ? ' warn' : ''}">${esc(r.note)}</div>` : '';
      return `<div class="sel-row sel-kind-${esc(r.kind)}">${head}${text}${n}</div>`;
    }).join('');
  }

  async function fetchFor(name) {
    if (!name || !window.api.drawerInspectSelection) return null;
    try { return await window.api.drawerInspectSelection(name); }
    catch { return null; }
  }

  const activeName = () => (getActiveSession ? getActiveSession() : null);
  let badgeFor = null;

  function clearBadge() { btn.classList.remove('live'); countEl.textContent = ''; badgeFor = null; }

  function paintBadge(name, data) {
    if (activeName() !== name) return;
    if (!data) { if (badgeFor !== name) clearBadge(); return; }
    const n = liveCount(data);
    btn.classList.toggle('live', n > 0);
    countEl.textContent = n > 0 ? String(n) : '';
    badgeFor = name;
  }

  async function refreshBadge() {
    const name = activeName();
    if (!name) { clearBadge(); return; }
    paintBadge(name, await fetchFor(name));
  }

  async function open() {
    const name = activeName();
    if (!name) return;
    if (pop.dataset.name === name && !pop.classList.contains('hidden')) { close(); return; }
    nameEl.textContent = name;
    pop.dataset.name = name;
    body.innerHTML = '<div class="sel-empty">Checking…</div>';
    pop.classList.remove('hidden');
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = `${Math.round(Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)))}px`;
    const data = await fetchFor(name);
    // The read is async and the operator can switch sessions or close meanwhile.
    if (pop.dataset.name !== name || pop.classList.contains('hidden')) return;
    body.innerHTML = data ? render(data) : '<div class="sel-empty">Could not read what is queued.</div>';
    // Opens UPWARD off the drawer header, which sits at the bottom of the
    // window, so the top is only knowable once the rows exist.
    pop.style.top = `${Math.round(Math.max(8, r.top - pop.offsetHeight - 8))}px`;
    paintBadge(name, data);
  }

  btn.addEventListener('click', open);
  document.addEventListener('mousedown', (e) => {
    if (pop.classList.contains('hidden')) return;
    if (pop.contains(e.target) || e.target.closest('#drawer-clipboard')) return;
    close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.classList.contains('hidden')) close();
  });
  document.getElementById('selection-popover-close').addEventListener('click', close);

  return { openSelectionPopover: open, closeSelectionPopover: close, refreshSelectionBadge: refreshBadge };
}

module.exports = { initSelectionPopover };
