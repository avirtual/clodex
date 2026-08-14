'use strict';

// intent-marks.js — decide which rendered terminal rows carry an emitted
// `[agent:…]` intent, and whether each one will actually FIRE.
//
// The grammar is intent-scanner's own, never a private copy. A mark is
// BELIEVED: one that promises a turn which never happens costs a session, so a
// regex free to drift from the real scan is worse than no mark at all.

const { cleanLine, parseIntent, fencedLines } = require('../../intent-scanner');

// Bounded rescan window. Fence state restarts at the window top, so a fence
// opened above it reads as closed — bounded staleness, against re-deriving a
// 50k-row scrollback on every write.
const SCAN_ROWS = 2000;

// xterm sets `isWrapped` on the CONTINUATION row; the head reads false. A head
// absorbs rows until the next unwrapped one, so the grammar sees the line the
// agent wrote, not a cell-width slice. A window opening mid-wrap reads a
// continuation as a head, yielding a truncated line that fails to parse —
// the safe direction.
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
function classifyText(raw) {
  if (!cleanLine(raw).includes('[agent:')) return null;
  // No escape or prose-before-bracket guard on purpose: parseIntent returns
  // `escape` for one and null for the other, and a second copy of a rule it
  // enforces would be free to disagree with the scan this predicts.
  const parsed = parseIntent(raw);
  if (!parsed) return 'inert';
  return parsed.type === 'escape' ? null : 'fire';
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
    if (kind) marks.push({ start: lines[i].start, end: lines[i].end, kind });
  }
  return marks;
}

module.exports = { classifyRows, classifyText, logicalLines, SCAN_ROWS };
