'use strict';
// session-info-popover.js — the sidebar row's ⓘ panel. Opened from the row's
// info button; fetches session:info on demand (the transcript scan streams tens
// of MB, so it must never ride the poll) and renders session-info-view's rows.
//
// Anchored to the ROW, not the proxy bar, so unlike cost/ctx it can be opened
// for a session that isn't active.
//
// DOM-bound, so no unit tests per the R1 rule — the number/label logic all lives
// in renderer/lib/session-info-view.js, which is tested.

const { esc } = require('../lib/format');
const { buildSections } = require('../lib/session-info-view');

function initSessionInfoPopover({ sessionList }) {
  const pop = document.getElementById('session-info-popover');
  const nameEl = document.getElementById('session-info-popover-name');
  const body = document.getElementById('session-info-popover-body');

  function close() { pop.classList.add('hidden'); pop.dataset.name = ''; }

  function renderSections(info) {
    const sections = buildSections(info);
    if (!sections.length) return '<div class="cost-note">Nothing recorded for this session yet.</div>';
    return sections.map((s) => {
      const rows = s.rows.map((r) => {
        const tip = r.tip ? ` data-tip="${esc(r.tip)}"` : '';
        return `<div class="si-row"${tip}><span class="si-k">${esc(r.k)}</span><span class="si-v">${esc(r.v)}</span></div>`;
      }).join('');
      return `<div class="si-sec"><div class="si-title">${esc(s.title)}</div>${rows}</div>`;
    }).join('');
  }

  async function open(name, anchor) {
    if (pop.dataset.name === name && !pop.classList.contains('hidden')) { close(); return; }
    nameEl.textContent = name;
    pop.dataset.name = name;
    body.innerHTML = '<div class="cost-note">Reading session history…</div>';
    pop.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = `${Math.round(Math.min(r.right + 8, window.innerWidth - w - 8))}px`;
    pop.style.top = `${Math.round(Math.max(8, Math.min(r.top, window.innerHeight - pop.offsetHeight - 8)))}px`;
    let res;
    try { res = await window.api.sessionInfo(name); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    // The scan is async and the operator can open another row meanwhile.
    if (pop.dataset.name !== name || pop.classList.contains('hidden')) return;
    if (!res || !res.ok) {
      body.innerHTML = `<div class="cost-note">${esc((res && res.error) || 'Session info unavailable')}</div>`;
      return;
    }
    try { body.innerHTML = renderSections(res.info); }
    catch (e) { body.innerHTML = `<div class="cost-note">Could not render: ${esc(String((e && e.message) || e))}</div>`; }
    // Re-clamp: the real height is only known once the rows exist.
    pop.style.top = `${Math.round(Math.max(8, Math.min(r.top, window.innerHeight - pop.offsetHeight - 8)))}px`;
  }

  document.addEventListener('mousedown', (e) => {
    if (pop.classList.contains('hidden')) return;
    if (pop.contains(e.target)) return;
    if (e.target.closest('.session-info-btn')) return; // toggle handled by the row
    close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.classList.contains('hidden')) close();
  });
  document.getElementById('session-info-popover-close').addEventListener('click', close);
  // A row removed or re-rendered under an open panel leaves it describing a
  // session that is gone.
  sessionList.addEventListener('scroll', () => { if (!pop.classList.contains('hidden')) close(); });

  return { openSessionInfoPopover: open, closeSessionInfoPopover: close };
}

module.exports = { initSessionInfoPopover };
