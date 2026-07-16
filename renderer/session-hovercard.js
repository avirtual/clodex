// session-hovercard.js — custom hover card for sidebar session rows, replacing
// the rows' native title tooltips (macOS-rendered: slow, unstylable). One
// shared fixed-position node reused across rows, pointer-events:none so it can
// never intercept interaction, and killed on any mousedown / scroll / keydown
// so it cannot overlap or outlive a dialog or popover opening (popovers ride
// z-index 200/300; the card stays below even the 50-tier panels at 49).
//
// Content is read fresh from the hovered row's datasets (name/type/cwd/
// failed/error/attention/attentionMsg/remoteControl) plus the same live maps
// the badges paint from (proxyState / ctxPct / ctxTokens), re-rendered every
// second while visible so the warmth countdown ticks. A row removed from the
// DOM mid-hover hides the card on the next tick.
//
// DOM-bound, so no unit tests per the R1 rule.

const { esc, fmtCountdown, fmtTokens } = require('./lib/format');
const { turnLine, reqLine, costLine } = require('./lib/turn-stat');

function initSessionHovercard({ sessionList, proxyState, ctxPct, ctxTokens, proxyPollMs, typeGlyph }) {
  const HOVER_DELAY_MS = 350;
  const TICK_MS = 1000;

  const card = document.createElement('div');
  card.id = 'session-hovercard';
  card.hidden = true;
  document.body.appendChild(card);

  let timer = null;   // pending show
  let current = null; // row the visible card describes
  let tick = null;    // live re-render interval

  // Warmth line, mirroring applyWarmBadge's classification but with the exact
  // countdown (the badge rounds to minutes). null → no live warmth to show.
  function warmthRow(name) {
    const st = proxyState.get(name);
    const p = st && st.payload;
    if (!p || !p.linked || !p.warmth) return null;
    const ageMs = Date.now() - st.at;
    if (ageMs > proxyPollMs * 4) return { state: 'stale', text: '? (telemetry stale)' };
    const remaining = p.warmth.remaining_s != null ? p.warmth.remaining_s - ageMs / 1000 : null;
    if (p.warmth.state === 'warm' && remaining != null && remaining > 0) {
      return { state: remaining < 300 ? 'low' : 'warm', text: `warm · ${fmtCountdown(remaining)} left` };
    }
    return { state: 'cold', text: 'cold' };
  }

  // Context line, same degradation ladder as the proxy bar: wire tokens →
  // side-channel tokens (+window size when known) → bare % → message count.
  function contextText(name, p) {
    const pct = ctxPct.get(name);
    const sc = ctxTokens.get(name);
    const wireTok = p && p.context && typeof p.context.inputTokens === 'number' ? p.context.inputTokens : null;
    const usedTok = wireTok != null ? wireTok : (sc && sc.used > 0 ? sc.used : null);
    const sizeTok = sc && sc.size > 0 ? sc.size : null;
    if (usedTok != null && usedTok > 0) {
      if (sizeTok) return `${fmtTokens(usedTok)}/${fmtTokens(sizeTok)} (${Math.round((usedTok / sizeTok) * 100)}%)`;
      return fmtTokens(usedTok);
    }
    if (typeof pct === 'number' && pct > 0) return `${pct}%`;
    if (p && p.context && p.context.messages != null) return `${p.context.messages} msg`;
    return null;
  }

  function statRow(label, value, attrs = '') {
    return `<div class="hc-row"><span class="hc-k">${label}</span><span class="hc-v"${attrs}>${value}</span></div>`;
  }

  function render(item) {
    const name = item.dataset.name || '';
    const type = item.dataset.type || '?';
    const backend = item.dataset.backend || null;
    const cwd = item.dataset.cwd || '';
    const failed = item.dataset.failed === '1';
    const nameEl = item.querySelector('.session-name');
    const display = (nameEl && nameEl.textContent) || name;
    // A local row whose display text differs from the internal name is renamed;
    // peer rows always differ (display carries @host, dataset carries @peerId).
    const renamed = type !== 'remote' && !failed && display !== name;

    const parts = [];
    parts.push(`<div class="hovercard-head">
      <span class="session-chip" data-type="${esc(type)}"${backend ? ` data-backend="${esc(backend)}"` : ''}>${typeGlyph(type, backend)}</span>
      <div class="hovercard-title">
        <div class="hovercard-name">${esc(display)}</div>
        ${renamed ? `<div class="hovercard-sub">internal name: ${esc(name)}</div>` : ''}
      </div>
    </div>`);
    parts.push(`<div class="hovercard-where"><span class="hovercard-type">${esc(type)}${backend ? ` · ${esc(backend)}` : ''}</span>${cwd ? `<span class="hovercard-path">${esc(cwd)}</span>` : ''}</div>`);

    if (failed) {
      parts.push(`<div class="hovercard-note hc-error">Restore failed: ${esc(item.dataset.error || 'unknown error')}</div>`);
      parts.push('<div class="hovercard-hint">click to retry · × forgets the saved entry</div>');
      return parts.join('');
    }

    const st = proxyState.get(name);
    const p = st && st.payload;
    const rows = [];
    // Live thinking duration off the row's stamp (set on the ENTRY into
    // thinking) — no threshold here, unlike the badge: once you're hovering
    // you asked, so even "thinking · 4s" is the answer.
    if (item.dataset.activity === 'thinking' && item.dataset.thinkingSince) {
      const s = Math.max(0, Math.round((Date.now() - Number(item.dataset.thinkingSince)) / 1000));
      const txt = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
      rows.push(statRow('thinking', esc(txt)));
    }
    const warm = warmthRow(name);
    if (warm) rows.push(statRow('cache', esc(warm.text), ` data-state="${warm.state}"`));
    const ctx = contextText(name, p && p.linked ? p : null);
    if (ctx) rows.push(statRow('context', esc(ctx)));
    if (p && p.linked) {
      if (p.model) rows.push(statRow('model', esc(p.model)));
      const cl = costLine(p);
      if (cl) rows.push(statRow('cost', cl));
      const act = [];
      // Live turn count leads, cumulative in parens — shared decision with the
      // statusbar (turn-stat.js). No tooltips here; a hovercard IS the tooltip.
      const tl = turnLine(p);
      if (tl) act.push(tl);
      const rl = reqLine(p);
      if (rl) act.push(rl);
      if (act.length) rows.push(statRow('activity', act.join(' · ')));
    }
    if (rows.length) parts.push(`<div class="hovercard-stats">${rows.join('')}</div>`);

    if (item.dataset.attention) {
      parts.push(`<div class="hovercard-note hc-attn">⚠ ${esc(item.dataset.attentionMsg || 'Needs your attention')}</div>`);
    }
    if (p && p.linked && p.refusals > 0) {
      parts.push(`<div class="hovercard-note hc-error">⚠ ${p.refusals} refusal${p.refusals === 1 ? '' : 's'}</div>`);
    }
    if (item.dataset.remoteControl) {
      parts.push(`<div class="hovercard-note hc-attn">Remote control: ${esc(item.dataset.remoteControl)}</div>`);
    }

    if (type === 'remote') parts.push('<div class="hovercard-hint">click to attach</div>');
    else parts.push('<div class="hovercard-hint">double-click the name to rename</div>');
    return parts.join('');
  }

  // Beside the row, clamped to the viewport. Left clamp only matters in a
  // pathologically narrow window — the card then overlaps the row, which is
  // fine (it's pointer-transparent).
  function position(item) {
    const r = item.getBoundingClientRect();
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    card.style.left = `${Math.round(Math.min(r.right + 8, window.innerWidth - w - 8))}px`;
    card.style.top = `${Math.round(Math.min(Math.max(8, r.top), Math.max(8, window.innerHeight - h - 8)))}px`;
  }

  function hide() {
    if (tick) { clearInterval(tick); tick = null; }
    current = null;
    card.hidden = true;
  }

  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function hideAll() {
    if (!timer && !current) return;
    cancel();
    hide();
  }

  function show(item) {
    timer = null;
    current = item;
    card.innerHTML = render(item);
    card.hidden = false;
    position(item);
    tick = setInterval(() => {
      if (!current || !current.isConnected) { hide(); return; }
      card.innerHTML = render(current);
      position(current);
    }, TICK_MS);
  }

  sessionList.addEventListener('mouseover', (e) => {
    const item = e.target.closest ? e.target.closest('.session-item') : null;
    if (item === current) return;
    cancel();
    if (!item) { hide(); return; } // header / child rows / gaps
    if (item.querySelector('.rename-input')) { hide(); return; }
    // A small in-row control with its own data-tip (close ×, pending chip) owns
    // the hover — defer to tooltip.js so the two never stack on the same spot.
    if (e.target.closest && e.target.closest('[data-tip]')) { hide(); return; }
    hide();
    timer = setTimeout(() => show(item), HOVER_DELAY_MS);
  });

  sessionList.addEventListener('mouseout', (e) => {
    const to = e.relatedTarget;
    if (to && to.closest && to.closest('.session-item')) return; // row→row: mouseover handles the switch
    hideAll();
  });

  // Any press, scroll or key kills the card — this is what guarantees it never
  // overlaps a popover/dialog being opened (all open paths start with one of
  // these) and never outlives a Cmd+W'd row.
  document.addEventListener('mousedown', hideAll, true);
  document.addEventListener('scroll', hideAll, true);
  document.addEventListener('keydown', hideAll, true);
}

module.exports = { initSessionHovercard };
