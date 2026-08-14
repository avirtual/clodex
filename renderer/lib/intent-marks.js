'use strict';

// intent-marks.js — decide which rendered terminal rows carry an emitted
// `[agent:…]` intent, and whether each one will actually FIRE.
//
// The grammar is intent-scanner's own, never a private copy. A mark is
// BELIEVED: one that promises a turn which never happens costs a session, so a
// regex free to drift from the real scan is worse than no mark at all.

const { cleanLine, parseIntent, fencedLines, looksLikeIntent } = require('../../intent-scanner');

// Bounded rescan window, against re-deriving the whole scrollback per write.
// It exceeds the configured scrollback, so the window starts at row 0; raising
// scrollback past it lets the window open mid-fence, reading that fence as
// closed. Pinned in intent-marks.test.js.
const SCAN_ROWS = 2000;

// xterm sets `isWrapped` on the CONTINUATION row; the head reads false. A head
// absorbs rows until the next unwrapped one, so the grammar sees the line the
// agent wrote, not a cell-width slice. A window opening mid-wrap reads a
// continuation as a head — a truncated line that fails to parse, the safe way.
function logicalLines(rows) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    let end = i;
    while (end + 1 < rows.length && rows[end + 1].isWrapped) end += 1;
    let text = '';
    for (let k = i; k <= end; k += 1) text += rows[k].text;
    out.push({ start: i, end, text });
    i = end + 1;
  }
  return out;
}

// 'fire' | 'inert' | null. null = leave it alone: an escape is deliberate
// QUOTING, and marking what someone wrote ABOUT an intent defeats finding the
// one that fired.
//
// The gate is looksLikeIntent — intent-scanner's own near-miss predicate, which
// anchors the bracket to the START of the cleaned line. A `.includes('[agent:')`
// gate marked every sentence an agent wrote ABOUT an intent: measured over 206
// rows of real output, 23 of 23 inert marks were mid-line prose and none was a
// line-start near-miss, so the mark was mostly noise. Widening this back to a
// substring test brings that back, and also starts marking `\[agent:…]`, whose
// backslash survives cleanLine and is what keeps the escape unmarked here.
function classifyText(raw) {
  if (!looksLikeIntent(raw)) return null;
  // No second copy of the near-miss rule: parseIntent returning null IS the
  // near miss, and a private guard would be free to disagree with the scan
  // this predicts.
  return parseIntent(raw) ? 'fire' : 'inert';
}

// The `[agent:…]` token inside one row's text, as { offset, length } in STRING
// offsets — the caller owns the offset→column mapping, which is not the same
// number on a row carrying double-width characters.
//
// Read on the HEAD row alone, never the joined logical line, so a token split
// across a wrap boundary yields the head-row remainder and the mark clips there
// instead of spilling. Bracket token only: the closing `]` is included, a
// same-line dm body is not — the body is the operator's own prose and tinting
// it is what this scoping exists to stop.
//
// null = the token does not start on this row at all (the bracket itself was
// split by the wrap). The caller decides what an unlocatable span means; it
// must not guess a column from a match it did not find.
function intentSpan(text) {
  const at = text.indexOf('[agent:');
  if (at < 0) return null;
  const close = text.indexOf(']', at);
  return { offset: at, length: (close < 0 ? text.length : close + 1) - at };
}

// rows: [{ text, isWrapped }] in buffer order. Returns marks anchored to the
// HEAD row of each logical line, as offsets into `rows`.
function classifyRows(rows) {
  const lines = logicalLines(rows);
  const fenced = fencedLines(lines.map((l) => cleanLine(l.text)));
  const marks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    const kind = classifyText(lines[i].text);
    if (!kind) continue;
    const { start, end } = lines[i];
    marks.push({ start, end, kind, span: intentSpan(rows[start].text) });
  }
  return marks;
}

module.exports = { classifyRows, classifyText, intentSpan, logicalLines, SCAN_ROWS };
