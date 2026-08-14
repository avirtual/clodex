// intent-highlight.js — mark emitted `[agent:…]` intents in a session terminal
// and tick them in the scrollbar lane. One instance per terminal.

// RECONCILE, don't append. Decorations are push-based (unlike the pull-based
// link provider next door) and the CLI repaints its live tail, so the set is
// re-derived and diffed each pass: an unchanged row KEEPS its decoration,
// stopping the ruler flickering while a turn streams.

const { classifyRows, SCAN_ROWS } = require('./lib/intent-marks');

// Coalesce bursts: one agent turn arrives as many writes. A frame of latency
// is invisible against a mark whose whole purpose is to be found later.
const DEBOUNCE_MS = 80;

const RULER_VAR = { fire: '--accent', inert: '--warn' };

function createIntentHighlight(terminal, { getVar } = {}) {
  // marker.line, NOT the line captured at paint time: scrollback trim shifts
  // every absolute index down, so a stored key silently rots once the buffer
  // fills. xterm maintains marker.line across the trim, so it is the only
  // identity that stays true.
  let shown = [];
  let timer = null;
  let disposed = false;

  const readVar = getVar || ((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim());

  // The ruler tick is canvas-drawn, so it cannot take a CSS var — it is read
  // out of the theme at paint time instead of hardcoded. Two of the four
  // themes are light-ground, and a hue tuned on the dark one vanishes there.
  const rulerColor = (kind) => readVar(RULER_VAR[kind]) || '#888888';

  function paint(line, kind) {
    const buf = terminal.buffer.active;
    const marker = terminal.registerMarker(line - (buf.baseY + buf.cursorY));
    if (!marker) return null;
    const decoration = terminal.registerDecoration({
      marker,
      // Bottom layer, full width: a wash BEHIND the row, so its own colours
      // and selection survive.
      width: terminal.cols,
      layer: 'bottom',
      overviewRulerOptions: { color: rulerColor(kind), position: 'right' },
    });
    if (!decoration) { marker.dispose(); return null; }
    decoration.onRender((el) => {
      el.classList.add('intent-mark', `intent-mark-${kind}`);
    });
    // cols is frozen into the decoration at registration, so it is carried here
    // to detect the resize that stranded it.
    return { marker, decoration, cols: terminal.cols };
  }

  function reconcile() {
    timer = null;
    if (disposed) return;
    const buf = terminal.buffer.active;
    // While the alternate buffer is active it IS buffer.active and reads
    // empty, so a pass landing here would find nothing and dispose every real
    // mark on the normal buffer. Markers survive the swap untouched; waiting
    // costs nothing.
    if (buf.type !== 'normal') return;

    const total = buf.length;
    const from = Math.max(0, total - SCAN_ROWS);
    const rows = [];
    for (let y = from; y < total; y += 1) {
      const l = buf.getLine(y);
      // Trim every row, continuations included. A wrapped row is full to
      // `cols`, so there is no real trailing space for this to eat. Switching
      // continuations to translateToString(false) to "preserve" one is wrong:
      // where a double-width char cannot fit the last cell, xterm leaves that
      // cell EMPTY, and the untrimmed form materializes it as a space that was
      // never typed — measured injecting `[agent:dm  一bob]` at cols=11.
      rows.push({ text: l ? l.translateToString(true) : '', isWrapped: !!(l && l.isWrapped) });
    }

    const want = new Map();
    for (const m of classifyRows(rows)) want.set(from + m.start, m.kind);

    const kept = [];
    for (const cur of shown) {
      // A trimmed-out row self-disposes its marker; reap the entry with it.
      if (cur.marker.isDisposed) { cur.decoration.dispose(); continue; }
      const line = cur.marker.line;
      // Only lines inside the window were re-derived, so one above it is kept
      // rather than read as "no longer wanted".
      if (line < from) { kept.push(cur); continue; }
      // A stale width is repainted like a changed kind: keeping the row would
      // otherwise leave the wash stopping short of a widened terminal.
      if (want.get(line) === cur.kind && cur.cols === terminal.cols) {
        want.delete(line);
        kept.push(cur);
        continue;
      }
      cur.decoration.dispose();
      cur.marker.dispose();
    }
    for (const [line, kind] of want) {
      const made = paint(line, kind);
      if (made) kept.push({ ...made, kind });
    }
    shown = kept;
  }

  const schedule = () => {
    if (disposed || timer) return;
    timer = setTimeout(reconcile, DEBOUNCE_MS);
  };

  const subs = [terminal.onWriteParsed(schedule), terminal.onResize(schedule)];

  return {
    refresh: schedule,
    count: () => shown.length,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const s of subs) s.dispose();
      for (const { decoration, marker } of shown) {
        decoration.dispose();
        if (!marker.isDisposed) marker.dispose();
      }
      shown = [];
    },
  };
}

module.exports = { createIntentHighlight };
