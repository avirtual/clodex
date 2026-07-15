// popovers/bust-popover.js — the cache-bust inspector (wirescope /_bust),
// opened from the bar's 💥 chip. Turn-by-turn cache-divergence forensics:
// when the prefix broke, how big the rewrite was, what changed. Self-contained
// island: DOM handles + dismiss wiring live here; data comes through
// popoverApi(name).bust(); proxyState is the live poll-payload Map (base/
// sessionId). openExternal/openWirescope are window.api shell actions.
//
// DOM-bound, so no unit tests per the R1 rule — move-only fidelity is the guarantee.

const { esc, fmtAgo } = require('../lib/format');
const { bustRow } = require('../lib/render-html');

// The bust_summary's age triad (wirescope /_status → shaped `p.busts`). first_ts
// (v0.6.33+) is the set-once epoch of the session's FIRST real bust; last_ts (=
// last_bust.ts) the most recent — both SQLite REAL epoch SECONDS, so age goes
// through fmtAgo(sec*1000) and the absolute stamp renders LOCAL wall time. Answers
// Bogdan's papercut ("8 busted caches, which was first/last, minutes or days ago").
// Degrades: first_ts null (pre-migration rows) → last+age only; no last ts at all
// → nothing (older proxy, today's display).
function absStamp(sec) {
  try {
    return new Date(sec * 1000).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return ''; }
}
function bustTriad(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const last = typeof summary.last_ts === 'number' ? summary.last_ts
    : (summary.last_bust && typeof summary.last_bust.ts === 'number' ? summary.last_bust.ts : null);
  if (last == null) return '';                       // no epoch → older proxy, no triad
  const age = fmtAgo(last * 1000);
  const absLast = absStamp(last);
  const first = typeof summary.first_ts === 'number' ? summary.first_ts : null;
  if (first != null && first < last) {
    const absFirst = absStamp(first);
    return `<div class="bust-span" title="First bust ${esc(absFirst)} · last bust ${esc(absLast)}">`
      + `First ${esc(absFirst)} → last ${esc(absLast)} · <b>${esc(age)}</b></div>`;
  }
  return `<div class="bust-span" title="Last bust ${esc(absLast)}">Last bust ${esc(absLast)} · <b>${esc(age)}</b></div>`;
}

function initBustPopover({ popoverApi, proxyState }) {
  // ── Cache-bust inspector (wirescope /_bust) ───────────────────────────
  // Turn-by-turn cache-divergence forensics: WHEN the prefix broke, HOW big the
  // re-write was, and WHAT changed (the locus). Opened from the 💥 bar chip.
  // wirescope classifies; we render. `fault`/`fix_hint` per transition arrive in
  // v0.6.20+ — rendered when present, gracefully absent on v0.6.19 (locus.label
  // alone still answers "what changed on this turn").
  const bustPopover = document.getElementById('bust-popover');
  const bustPopoverName = document.getElementById('bust-popover-name');
  const bustPopoverBody = document.getElementById('bust-popover-body');

  function closeBustPopover() { bustPopover.classList.add('hidden'); bustPopover.dataset.name = ''; }

  function renderBustSeries(d, base, sid, summary) {
    // Age triad from the /_status bust_summary (proxyState), NOT the /_bust series
    // — the summary is what carries first_ts/last_ts. Prepended to whichever body
    // branch renders below, so recency shows even when nothing genuine remains.
    const triad = bustTriad(summary);
    const busts = Array.isArray(d && d.busts) ? d.busts : [];
    const nT = d && d.count != null ? d.count : null;
    const link = (base && sid)
      ? `<span class="px-link-ext" data-url="${esc(`${base}/_session?session=${encodeURIComponent(sid)}`)}" title="Open the session in the wirescope navigator (⌘-click for browser)">Open navigator →</span>`
      : '';
    // Genuine busts (content / environment) are the investigation; the fault:self
    // microbusts are the designed per-turn strip cost — collapsed to one muted
    // line, not listed row-by-row (they're identical and expected). Matches the
    // chip, which counts genuine only.
    const genuine = busts.filter((t) => t.fault !== 'self');
    const designed = busts.filter((t) => t.fault === 'self');
    if (!genuine.length) {
      const only = designed.length
        ? `<div class="cost-note">No genuine cache busts — the ${designed.length} recorded event${designed.length === 1 ? ' is' : 's are'} the designed per-turn strip cost (thinking falling behind the boundary), not a cache problem.</div>`
        : `<div class="cost-note">No cache busts recorded${nT != null ? ` across ${nT} turn transition${nT === 1 ? '' : 's'}` : ''} — the prefix stayed warm.</div>`;
      return triad + only + link;
    }
    const nStatic = d.n_static_prefix_busts != null ? d.n_static_prefix_busts : null;
    const head = `<div class="cost-head"><b>${genuine.length}</b> genuine cache-bust${genuine.length === 1 ? '' : 's'}`
      + (nT != null ? ` over <b>${nT}</b> transitions` : '')
      + (nStatic ? ` · <b>${nStatic}</b> touched the static prefix` : '')
      + `</div>`;
    // Newest first — the operator usually cares about what just broke.
    const rows = genuine.slice().reverse().map((t) => bustRow(t, base, sid)).join('');
    const designedNote = designed.length
      ? `<div class="cost-note">+ ${designed.length} designed strip-cost microbust${designed.length === 1 ? '' : 's'} (fault:self) — expected every turn, not shown.</div>`
      : '';
    const note = '<div class="cost-note">Amber = a real injected-prefix change worth fixing (model swap, date rollover, CLAUDE.md edit). Dim = expected (idle cold cache, or a one-time deploy tax that self-heals).</div>';
    return triad + head + `<div class="bust-list">${rows}</div>` + designedNote + note + link;
  }

  async function openBustPopover(name, anchor) {
    const p = (proxyState.get(name) || {}).payload;
    const base = p && p.base, sid = p && p.sessionId;
    const summary = p && p.busts;   // /_status bust_summary — carries the age triad
    bustPopoverName.textContent = name;
    bustPopover.dataset.name = name;
    bustPopoverBody.innerHTML = '<div class="cost-note">Loading cache-bust forensics…</div>';
    bustPopover.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const w = bustPopover.offsetWidth;
    bustPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    bustPopover.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
    const res = await popoverApi(name).bust();
    if (bustPopover.dataset.name !== name || bustPopover.classList.contains('hidden')) return;
    if (!res || !res.ok) {
      bustPopoverBody.innerHTML = `<div class="cost-note">${esc(res && res.error ? res.error : 'Cache-bust forensics unavailable')}</div>`;
      return;
    }
    try { bustPopoverBody.innerHTML = renderBustSeries(res.data, base, sid, summary); }
    catch (e) { bustPopoverBody.innerHTML = `<div class="cost-note">Could not render: ${esc(String((e && e.message) || e))}</div>`; }
  }

  bustPopoverBody.addEventListener('click', (e) => {
    const ext = e.target.closest('[data-url]');
    if (!ext || !ext.dataset.url) return;
    if (e.metaKey || e.ctrlKey) {
      window.api.openExternal(ext.dataset.url);
    } else {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg');
      window.api.openWirescope(ext.dataset.url, bg);
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (bustPopover.classList.contains('hidden')) return;
    if (bustPopover.contains(e.target)) return;
    if (e.target.closest('[data-act="bust"]')) return; // toggle handled by the bar
    closeBustPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !bustPopover.classList.contains('hidden')) closeBustPopover();
  });
  document.getElementById('bust-popover-close').addEventListener('click', closeBustPopover);

  return { openBustPopover };
}

module.exports = { initBustPopover };
