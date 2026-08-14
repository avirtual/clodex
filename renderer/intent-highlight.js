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

  // A string offset is NOT a buffer column: a double-width char occupies two
  // cells and one string index, and a cell holding a surrogate pair or a
  // combining mark occupies one cell and several. So the columns are walked and
  // the string index accumulated from the cells themselves — `indexOf` as a
  // column is the bug this exists to avoid, and it misfires on any row carrying
  // CJK or emoji.
  //
  // A width-0 cell is the trailing half of a wide char: it renders nothing and
  // owns no string index. An EMPTY cell renders as the one space
  // translateToString gives it (rows are read trimmed-right, so the empties this
  // walk can reach are interior ones).
  function cellSpan(bufLine, { offset, length }) {
    const cols = bufLine.length;
    let idx = 0;
    let x = null;
    for (let i = 0; i < cols; i += 1) {
      const cell = bufLine.getCell(i);
      if (!cell) break;
      if (cell.getWidth() === 0) continue;
      if (x === null && idx >= offset) x = i;
      if (idx >= offset + length) return { x, width: i - x };
      idx += cell.getChars().length || 1;
    }
    return x === null ? null : { x, width: cols - x };
  }

  // Where the token WOULD be painted now, against where it is painted. Computed
  // rather than compared as offsets: the same string offset maps to a different
  // column once a wide char lands ahead of it.
  function sameSpan(line, span, cur) {
    const bufLine = terminal.buffer.active.getLine(line);
    const cells = (span && bufLine && cellSpan(bufLine, span)) || { x: 0, width: terminal.cols };
    return cells.x === cur.x && cells.width === cur.width;
  }

  function paint(line, kind, span) {
    const buf = terminal.buffer.active;
    const marker = terminal.registerMarker(line - (buf.baseY + buf.cursorY));
    if (!marker) return null;
    const bufLine = buf.getLine(line);
    // No locatable span — the bracket itself was split across the wrap — falls
    // back to the full-width wash rather than guessing a column. Marking the
    // whole row is the loud, correct-in-the-old-way answer; a span at a made-up
    // column points at the wrong text.
    const cells = (span && bufLine && cellSpan(bufLine, span)) || { x: 0, width: terminal.cols };
    const decoration = terminal.registerDecoration({
      marker,
      // Bottom layer: a wash BEHIND the row, so its own colours and selection
      // survive. Scoped to the token — an intent starts its own line, so a
      // full-width wash paints mostly empty terminal.
      x: cells.x,
      width: cells.width,
      // The ruler tick stays LINE-granular: one decoration is span-scoped on
      // screen and full-height in the ruler lane, and the tick is what solves
      // finding an intent without scrolling.
      layer: 'bottom',
      overviewRulerOptions: { color: rulerColor(kind), position: 'right' },
    });
    if (!decoration) { marker.dispose(); return null; }
    decoration.onRender((el) => {
      el.classList.add('intent-mark', `intent-mark-${kind}`);
    });
    // x/width are frozen into the decoration at registration while reconcile
    // deliberately KEEPS unchanged rows, so they are carried here to detect the
    // reflow or repaint that moved the token under a live decoration.
    return { marker, decoration, x: cells.x, width: cells.width };
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
    for (const m of classifyRows(rows)) want.set(from + m.start, m);

    const kept = [];
    for (const cur of shown) {
      // A trimmed-out row self-disposes its marker; reap the entry with it.
      if (cur.marker.isDisposed) { cur.decoration.dispose(); continue; }
      const line = cur.marker.line;
      // Only lines inside the window were re-derived, so one above it is kept
      // rather than read as "no longer wanted".
      if (line < from) { kept.push(cur); continue; }
      const m = want.get(line);
      // A stale span is repainted like a changed kind: x/width are frozen at
      // registration, so a row whose token moved (a resize reflow, a repaint of
      // the live tail) would otherwise keep a decoration over the wrong cells.
      if (m && m.kind === cur.kind && sameSpan(line, m.span, cur)) {
        want.delete(line);
        kept.push(cur);
        continue;
      }
      cur.decoration.dispose();
      cur.marker.dispose();
    }
    for (const [line, m] of want) {
      const made = paint(line, m.kind, m.span);
      if (made) kept.push({ ...made, kind: m.kind });
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
