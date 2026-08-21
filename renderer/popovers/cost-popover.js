// popovers/cost-popover.js — the cost-over-time popover (wirescope detail=1
// `series`), opened from the bar's ~$N cost segment. Renders the spine, a
// cumulative-cost chart, and the content split. Self-contained island: DOM
// handles + dismiss wiring live here; session data comes through
// popoverApi(name).report({detail}); proxyState is the live poll-payload Map
// (base/sessionId for the dashboard link). openExternal/openWirescope are
// window.api shell actions (external-link, not the local-vs-peer data seam).
//
// DOM-bound, so no unit tests per the R1 rule — move-only fidelity is the guarantee.

const { esc, fmtUsd } = require('../lib/format');
const { costStackBlock, svgCostChart } = require('../lib/render-html');
const { COST_SPINE, COST_CONTENT } = require('../lib/constants');
const { costByLine } = require('../lib/cost-by-line');

function initCostPopover({ popoverApi, proxyState }) {
  // --- Cost-over-time popover ----------------------------------------------
  // Native render of wirescope's detail=1 `series` (gated on context_timeline):
  // the exact spine (read/write/generation), a cumulative-cost line chart over
  // requests, and the ~est content split — plus a link out to the full
  // /_timeline HTML dashboard. Opened from the bar's ~$N cost segment.
  const costPopover = document.getElementById('cost-popover');
  const costPopoverName = document.getElementById('cost-popover-name');
  const costPopoverBody = document.getElementById('cost-popover-body');

  function closeCostPopover() { costPopover.classList.add('hidden'); costPopover.dataset.name = ''; }

  function renderCostTimeline(d, base, sid) {
    const s = d && d.series;
    const link = (base && sid)
      ? `<span class="px-link-ext" data-url="${esc(base + '/_timeline?session=' + encodeURIComponent(sid))}" title="Open in a clodex window (⌘-click for browser)">Open full dashboard →</span>`
      : '';
    if (!s || !Array.isArray(s.requests) || !s.requests.length) {
      return `<div class="cost-note">No per-request cost series yet — give the session a turn or two.</div>${link}`;
    }
    const st = s.spine_totals || {};
    const total = (st.read || 0) + (st.write || 0) + (st.generation || 0);
    const reqs = s.requests;
    const cc = s.content_carriage_est || {};
    const ccTotal = (cc.preamble || 0) + (cc.conversation || 0) + (cc.thinking || 0);
    return `<div class="cost-head"><b>${fmtUsd(total)}</b> over <b>${s.count != null ? s.count : reqs.length}</b> requests · main line</div>`
      + costStackBlock('Cost by type', '', COST_SPINE, st, total)
      + `<div class="cost-sec-title"><span>Cumulative cost · req 1 → ${reqs.length}</span></div>`
      + `<div class="cost-chart">${svgCostChart(reqs, COST_SPINE)}</div>`
      + costStackBlock('What read pays to carry', ' <span class="ctx-est">~est</span>', COST_CONTENT, cc, ccTotal)
      + `<div class="cost-note">Preamble = system + tools + agents + skills + CLAUDE.md, the fixed tax trimmed via 🛠 / 🧩 / 🤖. Conversation (incl. tool results) is the tail that grows with session depth.</div>`
      + link;
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
      + `<div class="cost-note">Whole-tree estimate split across the main line and its subagents. Shares ride the live poll (no extra fetch).</div>`;
  }

  async function openCostPopover(name, anchor) {
    const p = (proxyState.get(name) || {}).payload;
    const base = p && p.base, sid = p && p.sessionId;
    costPopoverName.textContent = name;
    costPopover.dataset.name = name;
    costPopoverBody.innerHTML = '<div class="cost-note">Loading cost timeline…</div>';
    costPopover.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const w = costPopover.offsetWidth;
    costPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    costPopover.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
    const res = await popoverApi(name).report({ detail: true });
    if (costPopover.dataset.name !== name || costPopover.classList.contains('hidden')) return;
    if (!res || !res.ok) {
      costPopoverBody.innerHTML = `<div class="cost-note">${esc(res && res.error ? res.error : 'Cost timeline unavailable')}</div>`;
      return;
    }
    // Prepend the live per-line attribution (free — from the poll payload) above
    // the report-driven main-line timeline. Re-read the payload post-await so the
    // shares are as fresh as the poll allows.
    const pNow = (proxyState.get(name) || {}).payload;
    try { costPopoverBody.innerHTML = renderCostByLine(pNow) + renderCostTimeline(res.data, base, sid); }
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
