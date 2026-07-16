// pot-drawer.js — the "boiling pot": a left-side drawer ranking the files where
// token CARRIAGE concentrates across every agent (docs/boiling-pot-plan.md).
// Opened from the View menu ("Boiling Pot…"); a global, cross-agent report you
// study, not a glance-value badge — so it's a drawer, pulled fresh on open
// (window.api.potSnapshot), never a live feed.
//
// FRAMING (operator, verbatim): we rank by tokens CARRIED into expensive
// contexts, not read COUNT. A file walked slice-by-slice accumulates carriage
// across many distinct ranges (segments) — that walking is the grok-skill
// targeting signal, NOT redundancy. `~tokens` is a RANKING approximation
// (bytes/4, line-slice estimated), never a billing number — the legend says so.
// Tier-1 data is all local, so the drawer renders wire-off. The tier-2
// redundancy columns (redundantReads/redundantTokens) arrive later from the
// wirescope /_pot join and are rendered ONLY when non-null.
//
// FACTORY (inbox-drawer's genus, not the CRUD library drawers): self-contained,
// the only cross-boundary reach is window.api, so no core state is injected.
// DOM-bound, so no unit tests per the R1 rule — leak-scanned like every island.

const { esc, baseName, shortPath, fmtTokens } = require('./lib/format');

function createPotDrawer() {
  const drawer = document.getElementById('pot-drawer');
  const listEl = document.getElementById('pot-list');
  const emptyEl = document.getElementById('pot-empty');
  const refreshBtn = document.getElementById('pot-refresh');
  const closeBtn = document.getElementById('pot-close');

  // A tier-2 column is live only once at least one row carries a non-null value
  // (all-or-nothing, like sinceCompact) — so the whole redundancy column appears
  // together with the wirescope join, or not at all.
  function hasRedundancy(files) {
    return files.some((f) => f && (f.redundantReads != null || f.redundantTokens != null));
  }

  async function renderList() {
    let snap = { window: null, files: [] };
    try { snap = await window.api.potSnapshot(10); } catch { /* empty → explainer */ }
    const files = (snap && Array.isArray(snap.files)) ? snap.files : [];
    listEl.innerHTML = '';
    if (files.length === 0) {
      emptyEl.style.display = '';
      return;
    }
    emptyEl.style.display = 'none';
    const showRedundant = hasRedundancy(files);
    listEl.classList.toggle('has-redundant', showRedundant);
    const head = document.createElement('div');
    head.className = 'pot-row pot-head';
    head.innerHTML = `
      <span class="pot-file">File</span>
      <span class="pot-num" title="Distinct Read calls over the window">reads</span>
      <span class="pot-num" title="Edit/Write touches over the window">edits</span>
      <span class="pot-num" title="Tokens carried into context — a RANKING approximation (bytes/4, line-slice estimated), not a billing number">~tokens</span>
      <span class="pot-num" title="Distinct read ranges — a file walked slice-by-slice accumulates segments (the walking signal)">segments</span>
      ${showRedundant ? '<span class="pot-num" title="Tokens re-carried by same-range re-reads (wirescope tier 2)">redundant</span>' : ''}
    `;
    listEl.appendChild(head);
    for (const f of files) {
      const el = document.createElement('div');
      el.className = 'pot-row';
      const redCell = showRedundant
        ? `<span class="pot-num">${f.redundantTokens != null ? esc(fmtTokens(f.redundantTokens)) : '—'}</span>`
        : '';
      el.innerHTML = `
        <span class="pot-file" title="${esc(f.file || '')}">
          <span class="pot-base">${esc(baseName(f.file))}</span>
          <span class="pot-dir">${esc(shortPath(f.file))}</span>
        </span>
        <span class="pot-num">${esc(String(f.reads || 0))}</span>
        <span class="pot-num">${esc(String(f.edits || 0))}</span>
        <span class="pot-num pot-carriage">${esc(fmtTokens(f.approxReadTokens || 0))}</span>
        <span class="pot-num">${esc(String(f.segments || 0))}</span>
        ${redCell}
      `;
      listEl.appendChild(el);
    }
  }

  function openDrawer() {
    drawer.classList.remove('hidden');
    renderList();
  }
  function closeDrawer() {
    drawer.classList.add('hidden');
  }

  if (window.api.onRequestOpenBoilingPot) window.api.onRequestOpenBoilingPot(openDrawer);
  closeBtn.addEventListener('click', closeDrawer);
  refreshBtn.addEventListener('click', renderList);

  return { openDrawer, closeDrawer };
}

module.exports = { createPotDrawer };
