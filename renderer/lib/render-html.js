// render-html.js — pure HTML-string builders for the renderer. Each takes plain
// data and returns a markup string; no DOM reads, no renderer state. Depends
// only on format.js (esc/fmtUsd/fmtBustTokens) and the BUST_FAULT table.
//
// esc is HTML-escaping via a detached DOM node, so EVERY builder here routes
// through the global `document`. Per the R1 rule ("anything needing a real DOM
// stays untested, no jsdom") this module was originally move-only and untested.
// `bustRow` since acquired real logic — a classification and an escaped diff
// block — so test/renderer-render-html.test.js covers it against the same
// minimal `global.document` stub other renderer tests already install; no jsdom.
// The rest of the file is still move-only fidelity.

const { esc, fmtUsd, fmtBustTokens } = require('./format');
const { BUST_FAULT } = require('./constants');

// A unified diff carries positions ONLY in its `@@ -a,b +c,d @@` headers; the
// body omits every unchanged line between hunks. So the gutter has to be
// replayed per line and re-seeded at each header — running one counter through
// the whole diff puts every hunk after the first off by the gap git dropped.
// Returns one entry per input line: a number to show, or null for lines that
// occupy no position in either file (headers, `\ No newline`).
function diffLineNumbers(lines) {
  let oldN = null; let newN = null;
  return lines.map((ln) => {
    if (ln.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
      oldN = m ? Number(m[1]) : null;
      newN = m ? Number(m[2]) : null;
      return null;
    }
    // Order matters: `---`/`+++` are file headers, not del/add lines, and they
    // appear before the first `@@` where the counters are still null anyway.
    if (oldN == null || ln.startsWith('+++') || ln.startsWith('---')
      || ln.startsWith('diff ') || ln.startsWith('index ') || ln.startsWith('\\') || ln === '') return null;
    if (ln.startsWith('+')) return newN++;
    if (ln.startsWith('-')) return oldN++;
    oldN++;
    return newN++;
  });
}

// `lineNumbers` adds the git-style gutter. Default off: this function is frozen
// into the plugin surface as `lib.renderDiffHtml` under `hostApi: "1"`, so a
// change to its default output is a change every conforming plugin sees.
function renderDiffHtml(diff, opts = {}) {
  const lines = diff.split('\n');
  const nums = opts.lineNumbers ? diffLineNumbers(lines) : null;
  const w = nums ? String(Math.max(1, ...nums.map(n => (n == null ? 0 : n)))).length : 0;
  return lines.map((ln, i) => {
    let cls = 'diff-ctx';
    if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff ') || ln.startsWith('index ')) cls = 'diff-file';
    else if (ln.startsWith('@@')) cls = 'diff-hunk';
    else if (ln.startsWith('+')) cls = 'diff-add';
    else if (ln.startsWith('-')) cls = 'diff-del';
    // The gutter is a blank of the same width on numberless lines, so the code
    // column stays aligned across hunk headers instead of stepping left.
    const gut = nums
      ? `<span class="peek-ln">${(nums[i] == null ? '' : String(nums[i])).padStart(w, ' ')}</span>`
      : '';
    return `<div class="diff-line ${cls}">${gut}${esc(ln) || ' '}</div>`;
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

// The contraction wirescope itself classifies a /compact on
// (warmth.BUST_COMPACT_MSG_RATIO, default 0.5) — the client-side twin, so the
// panel splits the population the same way the proxy's own counter does.
const BUST_COMPACT_MSG_RATIO = 0.5;

// Is this preamble bust the INHERENT rewrite a /compact causes, rather than a
// real change to the static bundle? The `preamble` class covers both, they cost
// the same and mean opposite things: a /compact writes its summary INTO
// messages[0], so it necessarily rewrites the preamble and there is nothing to
// fix; a preamble bust without one is an actionable edit to the injected bundle.
//
// Two signals, both required.
//
// WHAT moved: report.py's `_block_label` (:1020-1038) tags the diverging block
// inside messages[0] and the tag rides at the tail of `loc.label`. The
// vocabulary is closed, and every INJECTED static-context block gets a named tag
// (`claudeMd bundle`, `currentDate`, `system-reminder`, `thinking`,
// `tool_use:*`); only the operator's own prose falls through to the generic
// `text`. messages[0] IS that prose — the session's first user turn — and it
// cannot change mid-session by any mechanism except the thread being rewritten
// under it.
//
// HOW the thread moved: either the contraction above, or a pure tail append.
// `_text_first_diff` (report.py:980-990) returns i = len(old) when old is a
// prefix of new, so the 40-char windows satisfy `new.startsWith(old)` ONLY when
// text was appended at the END of the block — an insert anywhere earlier makes
// the two windows diverge at the offset. That is the second /compact shape: the
// local-command markers appended to messages[0], which moves the message count
// N -> N+1 and is therefore invisible to a count delta alone.
//
// Requiring both means mislabelling a real bust as inherent takes two
// independent signals to be wrong at once, and either clause failing on its own
// degrades to today's actionable row — the safe direction.
function isInherentCompact(t, loc) {
  if (t.class !== 'preamble') return false;
  const label = typeof loc.label === 'string' ? loc.label : '';
  if (!/\btext$/.test(label)) return false;
  const prev = t.prev_messages, cur = t.cur_messages;
  const collapsed = prev > 0 && cur != null && cur <= prev * BUST_COMPACT_MSG_RATIO;
  const o = typeof loc.old === 'string' ? loc.old : '';
  const n = typeof loc.new === 'string' ? loc.new : '';
  const appendedTail = !!o && n.length > o.length && n.startsWith(o);
  return collapsed || appendedTail;
}

// A transition that rewrote nothing AND has nothing to show. The /_bust series
// records every prefix divergence, including ones that cost zero tokens — an
// idle `lapse` row is the common case: the cache expired, so the next real turn
// necessarily re-wrote the prefix, and the transition is recorded against the
// moment of the lapse rather than against that turn. It carries no locus, no
// diff, and `0 tok rewritten · 0%`, which is the row contradicting itself: a
// FULL-REWRITE that rewrote nothing. Listing them buries the busts that did cost
// something, and the count in the header stops meaning "what this session paid".
//
// BOTH clauses are required, and the second is the one that keeps this honest.
// A zero-token row that DOES carry a locus still says WHAT changed (a CLAUDE.md
// edit, a model swap), and that is actionable whatever it cost — so it stays.
// Only a row that is simultaneously free and mute is hidden.
//
// `write_tokens == null` is NOT zero: an older proxy omits the field, and
// treating unknown as free would silently hide every row it emits. Same degrade
// posture as fault/fix_hint — unknown renders.
function isZeroCostBust(t) {
  if (!t || t.write_tokens !== 0) return false;
  const loc = t.locus || {};
  const o = typeof loc.old === 'string' ? loc.old : '';
  const n = typeof loc.new === 'string' ? loc.new : '';
  return !o && !n;
}

// A divergence snippet: raw request bytes, so esc() first, and only then swap
// the literal newlines the snippets routinely carry for a visible glyph — the
// window is cut by character offset, not by line, so a real break here would
// misrepresent a 40-char window as two rows of text.
function bustSnip(s) {
  return esc(s).replace(/\n/g, '<span class="bust-nl">⏎</span>');
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
  // A /compact's own rewrite of messages[0] gets the same treatment for the same
  // reason, and takes precedence: a compact that happens to straddle a restart is
  // still a compact, and only one badge should claim the row.
  const inherentCompact = isInherentCompact(t, loc);
  const deployTax = !inherentCompact && !!(t.restart_between && t.fault === 'content');
  const calm = inherentCompact || deployTax;
  const fault = t.fault && BUST_FAULT[calm ? 'environment' : t.fault];
  const faultBadge = fault ? `<span class="bust-badge ${fault.cls}">${esc(fault.label)}</span>` : '';
  const healBadge = inherentCompact
    ? '<span class="bust-badge bust-badge-heal">/compact rewrote messages[0] · inherent</span>'
    : deployTax ? '<span class="bust-badge bust-badge-heal">one-time deploy tax · self-heals</span>' : '';
  // fix_hint is wirescope's prose (v0.6.20+), and it is a STATIC per-class string
  // from the _BUST_FAULT table — not derived from this turn — so it says the same
  // generic "claudeMd / userEmail / … changed" for every preamble row. Suppress it
  // wherever there is nothing to fix (the deploy tax, an inherent compact); the
  // badge already says all there is to say, and the diff below says what moved.
  const hint = (t.fix_hint && !calm) ? `<div class="bust-hint">${esc(t.fix_hint)}</div>` : '';
  const mag = `<span class="bust-mag">${fmtBustTokens(t.write_tokens)} tok rewritten${t.write_frac != null ? ` · ${Math.round(t.write_frac * 100)}%` : ''}</span>`;
  // Deep-link into wirescope's per-turn navigator (v0.6.20 adds bust-jump nav).
  const turnLink = (base && sid && t.i != null)
    ? `<span class="px-link-ext" data-url="${esc(`${base}/_session?session=${encodeURIComponent(sid)}&turn=${t.i}`)}" title="Open this turn in the wirescope navigator (⌘-click for browser)">turn ${t.i} →</span>`
    : `<span class="bust-turn-static">turn ${t.i != null ? t.i : '?'}</span>`;
  const stampStr = t.ts ? fmtBustStamp(t.ts) : '';
  const stamp = stampStr ? `<span class="bust-stamp">${esc(stampStr)}</span>` : '';
  // The bytes that actually diverged: 40 chars each side of the first differing
  // character (report.py _BUST_SNIP), same -/+ shape the wirescope navigator
  // renders at views.py:733-735. The label alone says the prefix moved; only this
  // says WHAT moved it.
  //
  // Three shapes carry no text to show and must render exactly today's row: no
  // locus at all (the `lapse` class), a locus without the keys (`tools`, whose
  // roster change has no text offset), and a locus whose old/new are both empty
  // (`conversation`). Testing the strings covers all three.
  const oldSnip = typeof loc.old === 'string' ? loc.old : '';
  const newSnip = typeof loc.new === 'string' ? loc.new : '';
  // char_offset says how deep into the segment the change landed, which is what
  // determines how much of the window has to be re-written.
  const at = loc.char_offset != null ? `<span class="bust-at">@ char ${esc(String(loc.char_offset))}</span>` : '';
  const diff = (oldSnip || newSnip)
    ? `<div class="bust-diff">${at}`
      + `<div class="diff-line diff-del">- ${bustSnip(oldSnip)}</div>`
      + `<div class="diff-line diff-add">+ ${bustSnip(newSnip)}</div>`
      + `</div>`
    : '';
  return `<div class="bust-row bust-sev-${esc(sev)}">`
    + `<div class="bust-row-head"><span class="bust-what">${esc(what)}</span>${faultBadge}${healBadge}</div>`
    + `<div class="bust-row-meta"><span class="bust-sev">${esc(sev)}</span>${mag}${stamp}${turnLink}</div>`
    + hint
    + diff
    + `</div>`;
}

module.exports = { renderDiffHtml, costStackBlock, svgCostChart, bustRow, isZeroCostBust };

