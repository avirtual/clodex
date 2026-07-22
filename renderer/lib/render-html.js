// render-html.js — pure HTML-string builders for the renderer. Each takes plain
// data and returns a markup string; no DOM reads, no renderer state. Depends
// only on format.js (esc/fmtUsd/fmtBustTokens) and the BUST_FAULT table.
//
// esc is HTML-escaping via a detached DOM node, so EVERY builder here routes
// through the global `document` and cannot be called under node --test. Per the
// R1 rule ("anything needing a real DOM stays untested, no jsdom"), this module
// has no unit tests — move-only fidelity against the extracted bodies is the
// guarantee.

const { esc, fmtUsd, fmtBustTokens } = require('./format');
const { BUST_FAULT } = require('./constants');

function renderDiffHtml(diff) {
  return diff.split('\n').map((ln) => {
    let cls = 'diff-ctx';
    if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff ') || ln.startsWith('index ')) cls = 'diff-file';
    else if (ln.startsWith('@@')) cls = 'diff-hunk';
    else if (ln.startsWith('+')) cls = 'diff-add';
    else if (ln.startsWith('-')) cls = 'diff-del';
    return `<div class="diff-line ${cls}">${esc(ln) || ' '}</div>`;
  }).join('');
}

function costStackBlock(title, badge, defs, vals, total) {
  const rows = defs.map(d => ({ d, v: vals[d.key] || 0 })).filter(x => x.v > 0);
  const bar = rows.map(x => `<span style="width:${(total > 0 ? x.v / total * 100 : 0).toFixed(2)}%;background:${x.d.color}"></span>`).join('');
  const legend = rows.map(x => {
    const pct = total > 0 ? Math.round(x.v / total * 100) : 0;
    return `<span><span class="ck" style="background:${x.d.color}"></span>${esc(x.d.label)} <span class="cv">${fmtUsd(x.v)} · ${pct}%</span></span>`;
  }).join('');
  return `<div class="cost-sec-title"><span>${title}${badge}</span><span class="ctx-line-total">${fmtUsd(total)}</span></div>`
    + `<div class="cost-bar">${bar}</div><div class="cost-legend">${legend}</div>`;
}

// Cumulative-cost line chart: one line per spine bucket over request index.
// read towers and bends super-linearly; write/generation stay near the floor —
// that contrast is the point. Colors match the spine legend above.
function svgCostChart(reqs, defs) {
  const W = 600, H = 150, pl = 6, pr = 6, pt = 10, pb = 14;
  const n = reqs.length;
  const cum = {}; const run = {};
  defs.forEach(d => { cum[d.key] = []; run[d.key] = 0; });
  reqs.forEach(r => defs.forEach(d => { run[d.key] += (r[d.key + '_usd'] || 0); cum[d.key].push(run[d.key]); }));
  let maxY = 0;
  defs.forEach(d => { const last = cum[d.key][n - 1] || 0; if (last > maxY) maxY = last; });
  maxY = maxY || 1;
  const X = i => pl + (n <= 1 ? 0 : (i / (n - 1)) * (W - pl - pr));
  const Y = v => H - pb - (v / maxY) * (H - pt - pb);
  const paths = defs.map(d => {
    const pts = cum[d.key].map((v, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ');
    return `<path d="${pts}" fill="none" stroke="${d.color}" stroke-width="1.5"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative cost by type over requests">`
    + `<line x1="${pl}" y1="${H - pb}" x2="${W - pr}" y2="${H - pb}" stroke="#444" stroke-width="1"/>`
    + paths
    + `<text x="${pl}" y="${pt}" font-size="9" fill="#888">${esc(fmtUsd(maxY))}</text>`
    + `<text x="${pl}" y="${H - 3}" font-size="9" fill="#888">req 1</text>`
    + `<text x="${W - pr}" y="${H - 3}" font-size="9" fill="#888" text-anchor="end">req ${n}</text>`
    + `</svg>`;
}

// Per-row timestamp. /_bust entries carry `ts` as a zone-less ISO local-time
// string ("2026-07-22T20:59:42") — Date() parses that as local, which matches
// how the proxy stamped it. Absent/invalid (older proxy) → '' and the row
// renders without a stamp, same degrade posture as fault/fix_hint.
function fmtBustStamp(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return ''; }
}

// One transition row. Everything except fault/fix_hint is v0.6.19-present.
function bustRow(t, base, sid) {
  const sev = t.severity || (t.bust ? 'bust' : 'append');
  const loc = t.locus || {};
  // locus.label is wirescope's human string ("system[2] … +SHELL COMMANDS:",
  // "messages[0] claudeMd bundle changed"). Fall back to segment+index.
  const what = loc.label
    || (loc.segment ? `${loc.segment}${loc.index != null ? `[${loc.index}]` : ''} changed` : 'divergence');
  // A content-fault bust that straddles a proxy restart (restart_between) is the
  // benign deploy/upgrade tax — it self-heals next turn. Render it calm (env
  // treatment) + a heal badge, so a GUI-restart-to-upgrade doesn't read as a
  // real leak. A content bust WITHOUT restart_between is the actionable one.
  const deployTax = !!(t.restart_between && t.fault === 'content');
  const fault = t.fault && BUST_FAULT[deployTax ? 'environment' : t.fault];
  const faultBadge = fault ? `<span class="bust-badge ${fault.cls}">${esc(fault.label)}</span>` : '';
  const healBadge = deployTax ? '<span class="bust-badge bust-badge-heal">one-time deploy tax · self-heals</span>' : '';
  // fix_hint is wirescope's prose (v0.6.20+); suppress it for the deploy tax
  // (nothing to fix) — the heal badge already says all there is to say.
  const hint = (t.fix_hint && !deployTax) ? `<div class="bust-hint">${esc(t.fix_hint)}</div>` : '';
  const mag = `<span class="bust-mag">${fmtBustTokens(t.write_tokens)} tok rewritten${t.write_frac != null ? ` · ${Math.round(t.write_frac * 100)}%` : ''}</span>`;
  // Deep-link into wirescope's per-turn navigator (v0.6.20 adds bust-jump nav).
  const turnLink = (base && sid && t.i != null)
    ? `<span class="px-link-ext" data-url="${esc(`${base}/_session?session=${encodeURIComponent(sid)}&turn=${t.i}`)}" title="Open this turn in the wirescope navigator (⌘-click for browser)">turn ${t.i} →</span>`
    : `<span class="bust-turn-static">turn ${t.i != null ? t.i : '?'}</span>`;
  const stampStr = t.ts ? fmtBustStamp(t.ts) : '';
  const stamp = stampStr ? `<span class="bust-stamp">${esc(stampStr)}</span>` : '';
  return `<div class="bust-row bust-sev-${esc(sev)}">`
    + `<div class="bust-row-head"><span class="bust-what">${esc(what)}</span>${faultBadge}${healBadge}</div>`
    + `<div class="bust-row-meta"><span class="bust-sev">${esc(sev)}</span>${mag}${stamp}${turnLink}</div>`
    + hint
    + `</div>`;
}

module.exports = { renderDiffHtml, costStackBlock, svgCostChart, bustRow };

