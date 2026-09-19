// popovers/cost-popover.js — the cost summary popover, opened from the bar's
// ~$N cost segment. Self-contained island: DOM handles + dismiss wiring live
// here; session data comes through popoverApi(name).report({detail}); proxyState
// is the live poll-payload Map (base/sessionId for the dashboard link).
// openExternal/openWirescope are window.api shell actions (external-link, not
// the local-vs-peer data seam).
//
// The painters are DOM-bound, so no unit tests per the R1 rule; the reduction in
// renderer/lib/cost-report-view.js is tested.

const { esc, fmtUsd, fmtAgo } = require('../lib/format');
const { costStackBlock } = require('../lib/render-html');
const { COST_BUCKETS } = require('../lib/constants');
const { costByLine } = require('../lib/cost-by-line');
const { costReportModel } = require('../lib/cost-report-view');

function initCostPopover({ popoverApi, proxyState, barPopovers }) {
  // --- Cost summary popover ------------------------------------------------
  // Fetched WITHOUT detail=1: the per-request `series` is megabytes and 50s of
  // proxy work on a long session, so the popover always timed out to show a
  // chart nobody could read. The per-request timeline is the dashboard link now.
  const costPopover = document.getElementById('cost-popover');
  const costPopoverName = document.getElementById('cost-popover-name');
  const costPopoverBody = document.getElementById('cost-popover-body');

  function closeCostPopover() { costPopover.classList.add('hidden'); costPopover.dataset.name = ''; }
  const closeSiblings = barPopovers.register('cost', closeCostPopover);

  function renderCostSummary(d, base, sid, stale) {
    const m = costReportModel(d);
    const link = (base && sid)
      ? `<span class="px-link-ext" data-url="${esc(base + '/_timeline?session=' + encodeURIComponent(sid))}" title="Open in a clodex window (⌘-click for browser)">Open full dashboard →</span>`
      : '';
    let html = '';
    if (stale) {
      html += `<div class="cost-note cost-stale">showing the last successful report (${esc(stale.age)})`
        + `${stale.error ? ' — ' + esc(stale.error) : ''}</div>`;
    }
    if (m.allTime.usd != null || m.allTime.requests != null) {
      const usd = m.allTime.usd != null ? `<b>${fmtUsd(m.allTime.usd)}</b> all-time` : 'All-time';
      const reqs = m.allTime.requests != null ? ` over <b>${m.allTime.requests}</b> requests` : '';
      html += `<div class="cost-head">${usd}${reqs} · the bar's chip is scoped separately — hover it</div>`;
    }
    if (m.headline) html += `<div class="cost-head-line">${esc(m.headline)}</div>`;
    if (m.reclaimable && m.reclaimable.usd != null) {
      html += `<div class="cost-note">Reclaimable: <b>${fmtUsd(m.reclaimable.usd)}</b>`
        + (m.reclaimable.pct != null ? ` (${esc(String(m.reclaimable.pct))}% of spend)` : '') + `</div>`;
    }
    if (m.buckets.length) {
      const vals = {}; let total = 0;
      for (const b of m.buckets) { vals[b.bucket] = b.usd || 0; total += b.usd || 0; }
      html += costStackBlock('Cost by bucket', '', COST_BUCKETS, vals, total);
    }
    if (m.waste.length) {
      const rows = m.waste.map((w) =>
        `<div class="cost-line-row"><span class="cost-line-label">${esc(w.type)}`
        + (w.lever ? ` <span class="cost-waste-lever">${esc(w.lever)}</span>` : '')
        + `</span><span class="cost-line-usd">${w.usd != null ? fmtUsd(w.usd) : '—'}</span></div>`).join('');
      html += `<div class="cost-sec-title"><span>Where it was wasted</span></div>`
        + `<div class="cost-line-list">${rows}</div>`;
    }
    if (!html.trim()) html = '<div class="cost-note">No cost summary yet — give the session a turn or two.</div>';
    return html + link;
  }

  // Per-line cost attribution (wirescope v0.6.22+ cost_by_line). Sourced from the
  // LIVE status payload, not the report, so it's free (rides the poll). Answers
  // "where did a fan-out run's cost actually go" that the single whole-tree
  // number couldn't. Which cost object those figures come from is the leaf's
  // call (renderer/lib/cost-by-line.js — the scope pick is the whole reason it
  // exists); this is the HTML for its model. Sorted by cost desc; unbilled subs
  // listed muted.
  function renderCostByLine(p) {
    const model = costByLine(p);
    if (!model) return '';
    const body = model.rows.map((r) => {
      const cls = r.main ? 'cost-line-main' : '';
      if (r.usd == null) {
        return `<div class="cost-line-row ${cls}"><span class="cost-line-label">${esc(r.label)}</span>`
          + `<span class="cost-line-usd cost-line-unbilled">unbilled</span></div>`;
      }
      const pct = r.pct != null ? ` · ${r.pct}%` : '';
      return `<div class="cost-line-row ${cls}"><span class="cost-line-label">${esc(r.label)}</span>`
        + `<span class="cost-line-usd">${fmtUsd(r.usd)}<span class="cost-line-pct">${pct}</span></span></div>`;
    }).join('');
    const totalTxt = model.total != null ? fmtUsd(model.total) : '';
    return `<div class="cost-sec-title"><span>By line</span><span class="ctx-line-total">${totalTxt}</span></div>`
      + `<div class="cost-line-list">${body}</div>`
      // "this run" is stated unconditionally, and is true in BOTH directions:
      // the leaf picks the poll's per-registration figure under the overlay and
      // `p.cost` — which IS that same run figure on a raw poll — without it. An
      // unlabeled total here read as the bar's all-time one next to it, which is
      // the confusion the three-scopes ruling exists to prevent.
      + `<div class="cost-note">Whole-tree estimate for this run, split across the main line and its subagents. Shares ride the live poll (no extra fetch).</div>`;
  }

  async function openCostPopover(name, anchor) {
    closeSiblings();
    const p = (proxyState.get(name) || {}).payload;
    const base = p && p.base, sid = p && p.sessionId;
    costPopoverName.textContent = name;
    costPopover.dataset.name = name;
    costPopoverBody.innerHTML = '<div class="cost-note">Loading cost summary…</div>';
    costPopover.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const w = costPopover.offsetWidth;
    costPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    costPopover.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
    const res = await popoverApi(name).report({ detail: false });
    if (costPopover.dataset.name !== name || costPopover.classList.contains('hidden')) return;
    if (!res || !res.ok) {
      costPopoverBody.innerHTML = `<div class="cost-note">${esc(res && res.error ? res.error : 'Cost summary unavailable')}</div>`;
      return;
    }
    const stale = res.stale ? { age: fmtAgo(res.at || Date.now()), error: res.error } : null;
    // Prepend the live per-line attribution (free — from the poll payload) above
    // the report-driven summary. Re-read the payload post-await so the shares
    // are as fresh as the poll allows.
    const pNow = (proxyState.get(name) || {}).payload;
    try { costPopoverBody.innerHTML = renderCostByLine(pNow) + renderCostSummary(res.data, base, sid, stale); }
    catch (e) { costPopoverBody.innerHTML = `<div class="cost-note">Could not render: ${esc(String((e && e.message) || e))}</div>`; }
  }

  costPopoverBody.addEventListener('click', (e) => {
    const ext = e.target.closest('[data-url]');
    if (!ext || !ext.dataset.url) return;
    // Same as the bar's wirescope link: plain click → in-app theme-chromed
    // window, ⌘/Ctrl-click → system browser.
    if (e.metaKey || e.ctrlKey) {
      window.api.openExternal(ext.dataset.url);
    } else {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg');
      window.api.openWirescope(ext.dataset.url, bg);
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (costPopover.classList.contains('hidden')) return;
    if (costPopover.contains(e.target)) return;
    if (e.target.closest('[data-act="cost"]')) return; // toggle handled by the bar
    closeCostPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !costPopover.classList.contains('hidden')) closeCostPopover();
  });
  // Always-reachable close button — the ✕ stays put when a tall popover
  // pushes outside-click/Escape out of reach.
  document.getElementById('cost-popover-close').addEventListener('click', closeCostPopover);

  return { openCostPopover };
}

module.exports = { initCostPopover };
