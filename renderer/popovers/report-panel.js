// popovers/report-panel.js — the session deep-dive report modal (wirescope
// /_report). A read-only overlay: openReportPanel(name) pulls the structured
// capture through popoverApi(name).report() and renders it as prose + charts;
// every number is wirescope's, we only narrate and assert the invariants it
// ships. Self-contained island — its DOM handles and dismiss wiring live here;
// renderer.js keeps only the returned opener (the ctx popover's "report" link
// calls it). ctxCatLabel is the one shared helper, injected from renderer.js.
//
// ── Session report (wirescope /_report, report_version 5) ─────────────
// wirescope owns every number (pricing, cache math, thresholds, verdict
// score) — disk-based so it reads the full session capture, even on ended
// sessions. We only turn its structured findings into prose and assert the
// invariants it ships. Schema locked with wirescope; bump on report_version.

const { esc, fmtTokens, fmtUsd, fmtDur, shortTs, fmtAgo } = require('../lib/format');
const { REP_BUCKET_COLOR, REP_BUCKET_LABEL, REP_CAT_COLOR } = require('../lib/constants');

function initReportPanel({ popoverApi, ctxCatLabel }) {
  const reportOverlay = document.getElementById('report-overlay');
  const reportNameEl = document.getElementById('report-name');
  const reportBody = document.getElementById('report-body');
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
  let reportSeq = 0;

  function closeReportPanel() { reportOverlay.classList.add('hidden'); reportOverlay.dataset.name = ''; }

  async function openReportPanel(name) {
    reportNameEl.textContent = name;
    reportOverlay.dataset.name = name;
    reportBody.innerHTML = '<div class="rep-note">Analyzing session capture…</div>';
    reportOverlay.classList.remove('hidden');
    const my = ++reportSeq;
    const res = await popoverApi(name).report();
    // Bail if the modal was closed/retargeted while the scan was in flight.
    if (my !== reportSeq || reportOverlay.dataset.name !== name || reportOverlay.classList.contains('hidden')) return;
    if (!res || !res.ok) {
      reportBody.innerHTML = `<div class="rep-note">${esc(res && res.error ? res.error : 'Report unavailable')}</div>`;
      return;
    }
    const stale = res.stale
      ? `<div class="rep-note">showing the last successful report (${esc(fmtAgo(res.at || Date.now()))})${res.error ? ' — ' + esc(String(res.error)) : ''}</div>`
      : '';
    try { reportBody.innerHTML = stale + renderReport(res.data); }
    catch (e) { reportBody.innerHTML = `<div class="rep-note">Could not render report: ${esc(String((e && e.message) || e))}</div>`; }
  }

  function renderReport(d) {
    // Forward-compatible: render every field we understand, ignore the rest.
    // v1 = no `waste` section; v2 adds it; v3 made carriage per-request; v4
    // scoped carriage waste to subagents (renderFindings); v5 split agents[]
    // side-calls out of `requests` into `sidecalls`. Newer reports still render.
    if (!d || typeof d.report_version !== 'number' || d.report_version < 1) {
      return `<div class="rep-note">Unsupported report${d ? ' (version ' + esc(String(d.report_version)) + ')' : ''}. Update Clodex.</div>`;
    }
    return [
      renderVerdict(d),
      renderCostDecomp(d.cost_decomposition),
      renderWaste(d.waste),
      renderTokenDecomp(d.token_decomposition),
      renderFindings(d.findings || []),
      renderInvariants(d),
    ].join('');
  }

  // "What was avoidable" (report_version >= 2) — the reclaimable subset of cost,
  // aggregated by type, priced as the real net saving. Distinct question from
  // cost_decomposition ("where every dollar went"): this is the consolidated
  // headline that matches verdict.reclaimable_usd_total by construction. Compact
  // rollup here; the per-line levers live in the detailed findings below.
  // claudemd_carriage / useremail_carriage are subagent-scoped from v4 on (a
  // subagent's inherited context, reclaimable via omit-on-spawn). Main-line
  // carriage is informational, not waste — see renderFindings / renderInfoFinding.
  const WASTE_LABELS = {
    cold_cache: 'Cold cache (re-writes)',
    deadweight_tools: 'Unused tools',
    deadweight_skills: 'Unused skills',
    claudemd_carriage: 'CLAUDE.md carried to subagents',
    useremail_carriage: 'User email carried to subagents',
  };
  function renderWaste(w) {
    if (!w || !Array.isArray(w.by_type) || !w.by_type.length) return '';
    const rows = w.by_type.map((t) => {
      const conf = t.confidence || 'medium';
      const meta = [`<span class="rep-conf rep-conf-${esc(conf)}">${esc(conf)}</span>`];
      if (num(t.items)) meta.push(`<span>${num(t.items)} item${t.items === 1 ? '' : 's'}</span>`);
      if (t.tokens) meta.push(`<span>${fmtTokens(t.tokens)} tok</span>`);
      return `<div class="rep-find"><div class="rep-find-top">` +
        `<span class="rep-find-title">${esc(WASTE_LABELS[t.type] || t.type)}</span>` +
        `<span class="rep-find-usd">${fmtUsd(t.usd)}</span></div>` +
        `<div class="rep-find-meta">${meta.join('')}</div></div>`;
    }).join('');
    return `<div class="rep-sec"><div class="rep-sec-head">What was avoidable — ${fmtUsd(w.total_usd)}` +
      (typeof w.pct_of_session === 'number' ? ` (${w.pct_of_session}% of session)` : '') +
      `</div>${rows}</div>`;
  }

  function renderVerdict(d) {
    const v = d.verdict || {};
    const rating = v.rating || 'unknown';
    const score = typeof v.score === 'number' ? v.score : '—';
    const sc = d.scope || {};
    const subs = (sc.agents || []).filter((a) => a.line === 'subagent');
    const span = (sc.first_ts && sc.last_ts) ? ` · ${esc(shortTs(sc.first_ts))} → ${esc(shortTs(sc.last_ts))}` : '';
    const sideLines = (sc.agents || []).filter((a) => typeof a.sidecalls === 'number');
    const sideCalls = sideLines.reduce((n, a) => n + a.sidecalls, 0);
    const scope = `${num(sc.requests)} requests${sideLines.length ? ` (${sideCalls} side-calls)` : ''} · ${num(sc.turns)} turns` +
      (subs.length ? ` · ${subs.length} subagent line${subs.length === 1 ? '' : 's'}` : '') +
      (sc.models && sc.models.length ? ` · ${esc(sc.models.join(', '))}` : '') + span;
    return `<div class="rep-verdict">` +
      `<div class="rep-score rep-rating-${esc(rating)}"><span class="n">${score}</span><span class="l">${esc(rating)}</span></div>` +
      `<div class="rep-verdict-text">` +
      `<div class="rep-headline">${esc(v.headline || '')}</div>` +
      `<div class="rep-reclaim">Reclaimable: <b>${fmtUsd(v.reclaimable_usd_total)}</b>` +
      (typeof v.reclaimable_pct === 'number' ? ` (${v.reclaimable_pct}% of spend)` : '') +
      (v.confidence ? ` · ${esc(v.confidence)} confidence` : '') + `</div></div></div>` +
      `<div class="rep-scope">${scope}</div>`;
  }

  function renderCostDecomp(c) {
    if (!c || !Array.isArray(c.by_bucket)) return '';
    const total = c.total_usd || 0;
    const bars = c.by_bucket.map((b) =>
      `<i style="width:${Math.max(0.5, b.pct || 0)}%;background:${REP_BUCKET_COLOR[b.bucket] || '#888'}" ` +
      `title="${esc(REP_BUCKET_LABEL[b.bucket] || b.bucket)} ${fmtUsd(b.usd)}"></i>`).join('');
    const legend = c.by_bucket.map((b) =>
      `<div class="rep-leg-row"><span class="rep-leg-sw" style="background:${REP_BUCKET_COLOR[b.bucket] || '#888'}"></span>` +
      `<span class="rep-leg-name">${esc(REP_BUCKET_LABEL[b.bucket] || b.bucket)}</span>` +
      `<span class="rep-leg-nums">${fmtUsd(b.usd)} · ${num(b.pct)}%</span></div>`).join('');
    // cache_misses is a localised drill-down of the cache_write_rewrite bucket
    // (already counted in by_bucket per the schema invariant) — render as a
    // sub-note, NEVER as an added segment.
    let miss = '';
    const m = c.cache_misses;
    if (m && m.count > 0) {
      const causes = Object.entries(m.by_cause || {}).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ');
      const biggest = (m.events || []).slice().sort((a, b) => (b.usd || 0) - (a.usd || 0))[0];
      const big = biggest && biggest.idle_gap_s
        ? ` — biggest a ${fmtDur(biggest.idle_gap_s)} gap (${fmtUsd(biggest.usd)})` : '';
      miss = `<div class="rep-sub">↳ <b>${m.count} cache miss${m.count === 1 ? '' : 'es'}</b> ` +
        `(${fmtUsd(m.usd)}${m.where ? ', ' + esc(m.where) : ''})${causes ? ' — ' + esc(causes) : ''}${big}. ` +
        `Re-wrote a preamble that had gone cold — keep-warm avoids it.</div>`;
    }
    return `<div class="rep-sec"><div class="rep-sec-head">Where the ${fmtUsd(total)} went</div>` +
      `<div class="rep-stack">${bars}</div><div class="rep-legend">${legend}</div>${miss}</div>`;
  }

  // report_version 3 renamed the carriage fields per-turn → per-request (the
  // prefix is re-sent on every wire request, not every human turn — and turns
  // now means genuine user prompts). Read the v3 name, fall back to the v2 name
  // so we render v2 and v3 proxies identically through the rollout.
  function vget(obj, v3key, v2key) {
    if (!obj) return undefined;
    return obj[v3key] != null ? obj[v3key] : obj[v2key];
  }

  function renderTokenDecomp(t) {
    if (!t || !t.preamble) return '';
    const p = t.preamble;
    const perReq = p.tokens_per_request != null; // v3 unit
    const unit = perReq ? '/req' : '/turn';
    const per = vget(p, 'tokens_per_request', 'tokens_per_turn') || 0;
    const resent = vget(p, 'requests_resent', 'turns_resent') || 0;
    const unused = vget(p, 'unused_tokens_per_request', 'unused_tokens_per_turn') || 0;
    const cats = (p.by_category || [])
      .map((c) => ({ category: c.category, v: vget(c, 'tokens_per_request', 'tokens_per_turn') || 0 }))
      .filter((c) => c.v > 0);
    const bars = cats.map((c) =>
      `<i style="width:${Math.max(0.5, per ? (c.v / per) * 100 : 0)}%;background:${REP_CAT_COLOR[c.category] || '#888'}" ` +
      `title="${esc(ctxCatLabel(c.category))} ${fmtTokens(c.v)}${unit}"></i>`).join('');
    const legend = cats.map((c) =>
      `<div class="rep-leg-row"><span class="rep-leg-sw" style="background:${REP_CAT_COLOR[c.category] || '#888'}"></span>` +
      `<span class="rep-leg-name">${esc(ctxCatLabel(c.category))}</span>` +
      `<span class="rep-leg-nums">${fmtTokens(c.v)}${unit}</span></div>`).join('');
    const sub = `<div class="rep-sub">${fmtTokens(per)}${unit} re-sent ${num(resent)}× = ` +
      `${fmtTokens(p.total_resent_tokens || 0)} total` +
      (unused ? ` · <b>${fmtTokens(unused)}${unit} never used</b>` : '') +
      (p.stable === false ? ' · estimate' : '') + `</div>`;
    return `<div class="rep-sec"><div class="rep-sec-head">Your request preamble (reloaded every ${perReq ? 'request' : 'turn'})</div>` +
      `<div class="rep-stack">${bars}</div><div class="rep-legend">${legend}</div>${sub}</div>`;
  }

  // report_version 4 made claudemd/useremail carriage SUBAGENT-scoped: the
  // `*_carriage` waste types now only come from a subagent's inherited context
  // (reclaimable via omit-on-spawn). Main-line carriage instead surfaces as
  // informational `main_*_carriage` findings — additive:false, reclaimable_usd:0
  // — so the report no longer mislabels intentional main-agent CLAUDE.md as waste.
  const isMainCarriage = (f) => /^main_[a-z]+_carriage$/.test(f.category || '');

  function renderFindings(findings) {
    if (!findings.length) return '';
    const additive = findings.filter((f) => f.additive !== false);
    const nonAdditive = findings.filter((f) => f.additive === false);
    const info = nonAdditive.filter(isMainCarriage);          // v4 informational
    const heuristic = nonAdditive.filter((f) => !isMainCarriage(f));
    let html = `<div class="rep-sec"><div class="rep-sec-head">Recommendations</div>`;
    html += additive.length
      ? additive.map(renderFinding).join('')
      : '<div class="rep-note">No reclaimable waste found — this session is lean.</div>';
    if (heuristic.length) {
      html += `<div class="rep-group collapsed">` +
        `<div class="rep-group-head" data-act="rep-toggle">▸ ${heuristic.length} possible (heuristic, not scored)</div>` +
        heuristic.map(renderFinding).join('') + `</div>`;
    }
    if (info.length) {
      html += `<div class="rep-group collapsed">` +
        `<div class="rep-group-head" data-act="rep-toggle">▸ ${info.length} informational (main-line context, not reclaimable)</div>` +
        info.map(renderInfoFinding).join('') + `</div>`;
    }
    return html + `</div>`;
  }

  // v4 main-line carriage: factual, not waste. Render dimmed and with NO $ — and
  // deliberately do NOT surface reclaimable_tokens_per_request: on these findings
  // it carries the carried prefix size (e.g. 2237), not a saving, so the standard
  // renderFinding's "/req" meta would re-imply the very waste v4 stopped claiming.
  // The hypothetical evidence.carriage_usd_if_omittable is likewise not shown as $.
  function renderInfoFinding(f) {
    const meta = [];
    if (f.requests != null) meta.push(`over ${f.requests} request${f.requests === 1 ? '' : 's'}`);
    return `<div class="rep-find low">` +
      `<div class="rep-find-top"><span class="rep-find-title">${esc(f.title || f.category || '')}</span></div>` +
      (f.detail ? `<div class="rep-find-detail">${esc(f.detail)}</div>` : '') +
      (f.lever ? `<div class="rep-lever">${esc(f.lever)}</div>` : '') +
      `<div class="rep-find-meta"><span class="rep-conf rep-conf-low">info</span>` +
      meta.map((mm) => `<span>${esc(mm)}</span>`).join('') + `</div></div>`;
  }

  function renderFinding(f) {
    const conf = f.confidence || 'medium';
    const ev = f.evidence || {};
    const meta = [];
    const reclaimPer = vget(f, 'reclaimable_tokens_per_request', 'reclaimable_tokens_per_turn');
    if (reclaimPer) meta.push(`${fmtTokens(reclaimPer)}${f.reclaimable_tokens_per_request != null ? '/req' : '/turn'}`);
    // v3 split the old per-finding `turns` count by type: requests (carriage),
    // events (cache misses), occurrences (low-conf heuristics).
    if (f.requests != null) meta.push(`over ${f.requests} requests`);
    else if (f.events != null) meta.push(`${f.events} event${f.events === 1 ? '' : 's'}`);
    else if (f.occurrences != null) meta.push(`${f.occurrences}×`);
    else if (f.turns != null) meta.push(`over ${f.turns} turns`);
    if (ev.loaded != null && ev.used != null) meta.push(`${ev.used}/${ev.loaded} used`);
    return `<div class="rep-find${conf === 'low' ? ' low' : ''}">` +
      `<div class="rep-find-top"><span class="rep-find-title">${esc(f.title || f.category || '')}</span>` +
      (f.reclaimable_usd ? `<span class="rep-find-usd">${fmtUsd(f.reclaimable_usd)}</span>` : '') + `</div>` +
      (f.detail ? `<div class="rep-find-detail">${esc(f.detail)}</div>` : '') +
      (f.lever ? `<div class="rep-lever">${esc(f.lever)}</div>` : '') +
      `<div class="rep-find-meta"><span class="rep-conf rep-conf-${esc(conf)}">${esc(conf)}</span>` +
      meta.map((mm) => `<span>${esc(mm)}</span>`).join('') + `</div></div>`;
  }

  function renderInvariants(d) {
    // wirescope guarantees these; we re-assert so a regression surfaces loudly
    // rather than as silently contradictory numbers in the render.
    const issues = [];
    const c = d.cost_decomposition;
    if (c && Array.isArray(c.by_bucket) && typeof (d.totals && d.totals.est_usd) === 'number') {
      const sum = c.by_bucket.reduce((a, b) => a + (b.usd || 0), 0);
      if (Math.abs(sum - d.totals.est_usd) > 0.01) issues.push('cost buckets don’t sum to total');
    }
    const t = d.token_decomposition && d.token_decomposition.preamble;
    const unusedPer = vget(t, 'unused_tokens_per_request', 'unused_tokens_per_turn');
    if (t && Array.isArray(d.findings) && unusedPer != null) {
      // The preamble is the main line's; subagent deadweight has its own per-unit
      // budget and must not count against it (schema invariant is main-scoped).
      // Same identity in v2 (_per_turn) and v3 (_per_request).
      const dead = d.findings
        .filter((f) => /^deadweight_/.test(f.category || '') && f.line === 'main')
        .reduce((a, f) => a + (vget(f, 'reclaimable_tokens_per_request', 'reclaimable_tokens_per_turn') || 0), 0);
      if (Math.abs(dead - unusedPer) > 1) issues.push('unused-preamble ≠ deadweight findings');
    }
    // v2: the waste rollup is the reclaimable subset and must equal the verdict's
    // headline number by construction.
    if (d.waste && typeof d.waste.total_usd === 'number' && typeof (d.verdict && d.verdict.reclaimable_usd_total) === 'number') {
      if (Math.abs(d.waste.total_usd - d.verdict.reclaimable_usd_total) > 0.01) issues.push('waste total ≠ verdict reclaimable');
    }
    if (issues.length) return `<div class="rep-inv bad">⚠ Consistency check failed: ${esc(issues.join('; '))}</div>`;
    return `<div class="rep-inv">Internally consistent · basis: ${esc((d.totals && d.totals.basis) || d.basis || 'on-disk capture')}</div>`;
  }

  document.getElementById('report-close').addEventListener('click', closeReportPanel);
  reportOverlay.addEventListener('mousedown', (e) => { if (e.target === reportOverlay) closeReportPanel(); });
  reportBody.addEventListener('click', (e) => {
    const tog = e.target.closest('[data-act="rep-toggle"]');
    if (!tog) return;
    const g = tog.closest('.rep-group');
    if (!g) return;
    const collapsed = g.classList.toggle('collapsed');
    tog.textContent = (collapsed ? '▸ ' : '▾ ') + tog.textContent.replace(/^[▸▾]\s*/, '');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !reportOverlay.classList.contains('hidden')) closeReportPanel();
  });

  return { openReportPanel };
}

module.exports = { initReportPanel };
