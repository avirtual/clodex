'use strict';

// The PAINTED intent mark, replayed through a real xterm rather than reasoned
// about. What earns a real terminal here is the column mapping: a decoration
// asserted only to EXIST passes for a span sitting on the wrong cells, and the
// wrong cells are the whole defect — a string offset is not a buffer column the
// moment a row carries a double-width character.
//
// Bytes go in the way the PTY sends them (write + its parse callback), so the
// buffer under test is the one xterm actually built: its own wrapping, its own
// cell widths, its own trailing-empty handling.

const { test } = require('node:test');
const assert = require('node:assert');

const { Terminal } = require('@xterm/xterm');
const { createIntentHighlight } = require('../renderer/intent-highlight');

const RULER = '#abcdef';

// registerDecoration is delegated to the real terminal and its options
// recorded — the assertions are on what xterm was actually asked to paint. The
// alternative (an API for the island to report its own spans) would let the
// island agree with itself while painting somewhere else.
function harness({ cols = 40, rows = 10 } = {}) {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  const painted = [];
  const real = terminal.registerDecoration.bind(terminal);
  terminal.registerDecoration = (opts) => {
    painted.push(opts);
    return real(opts);
  };
  const highlight = createIntentHighlight(terminal, { getVar: () => RULER });
  const write = (data) => new Promise((r) => terminal.write(data, r));
  // The island debounces writes by DEBOUNCE_MS (80).
  const settle = () => new Promise((r) => setTimeout(r, 200));
  return { terminal, painted, highlight, write, settle };
}

async function paintOnce(data, opts) {
  const h = harness(opts);
  await h.write(data);
  await h.settle();
  return h;
}

test('the mark covers the [agent:…] token and stops there', async () => {
  const { painted, highlight } = await paintOnce('[agent:who] and then some prose\r\n');
  assert.strictEqual(highlight.count(), 1);
  assert.strictEqual(painted.length, 1);
  // `[agent:who]` is 11 cells at column 0. Not `cols`: an intent starts its own
  // line, so a full-width wash paints mostly empty terminal.
  assert.strictEqual(painted[0].x, 0);
  assert.strictEqual(painted[0].width, 11);
  highlight.dispose();
});

test('a same-line dm body is left untinted', async () => {
  const { painted, highlight } = await paintOnce('[agent:dm bob] hello there\r\n');
  // Through the closing bracket, not into the body: the body is the operator's
  // own prose, and tinting it is what the scoping exists to stop.
  assert.deepStrictEqual(
    { x: painted[0].x, width: painted[0].width },
    { x: 0, width: '[agent:dm bob]'.length },
  );
  highlight.dispose();
});

test('a double-width char inside the token widens the span by CELLS, not by string length', async () => {
  // The bug class this test exists for. `一` is ONE string index and TWO cells,
  // so a span measured off string offsets stops one cell short of the closing
  // bracket — it paints `[agent:dm 一bob` and leaves the `]` bare.
  const line = '[agent:dm 一bob] body';
  const { painted, highlight } = await paintOnce(`${line}\r\n`);
  assert.strictEqual(line.indexOf(']') + 1, 15, 'the naive answer this must not give');
  assert.deepStrictEqual({ x: painted[0].x, width: painted[0].width }, { x: 0, width: 16 });
  highlight.dispose();
});

test('an emoji inside the token narrows it by cells, the other direction of the same mismatch', async () => {
  // A surrogate pair is TWO string indices in ONE cell, so string offsets
  // overshoot here exactly as they undershot above — a span one cell too wide,
  // reaching into the body. One rule (walk the cells) covers both; an
  // off-by-one fudge on either would break the other.
  const line = '[agent:dm 👍bob] x';
  const { painted, highlight } = await paintOnce(`${line}\r\n`);
  assert.strictEqual(line.indexOf(']') + 1, 16, 'the naive answer this must not give');
  assert.deepStrictEqual({ x: painted[0].x, width: painted[0].width }, { x: 0, width: 15 });
  highlight.dispose();
});

test('decoration and indentation ahead of the token are not covered by the mark', async () => {
  // These still FIRE — the scanner strips them — so the row is marked; the mark
  // just points at the bracket rather than at the bullet.
  const { painted, highlight } = await paintOnce('  • [agent:who]\r\n');
  assert.strictEqual(highlight.count(), 1);
  assert.deepStrictEqual({ x: painted[0].x, width: painted[0].width }, { x: 4, width: 11 });
  highlight.dispose();
});

test('the overview-ruler tick stays line-granular and themed', async () => {
  const { painted, highlight } = await paintOnce('[agent:who]\r\n');
  // The tick is what solves finding an intent without scrolling: the ruler lane
  // is line-granular by construction, so the span scoping above must not have
  // reached it, and the colour must still come from the theme at paint time.
  assert.deepStrictEqual(painted[0].overviewRulerOptions, { color: RULER, position: 'right' });
  assert.strictEqual(painted[0].layer, 'bottom');
  highlight.dispose();
});

test('an intent whose token is split by the wrap takes ONE mark, clipped to the head row', async () => {
  // cols=10 cuts `[agent:dm bob]` in half. Decision: one decoration on the head
  // row, clipped, rather than a second on the continuation — the mark is
  // anchored to the logical line's head row, and a second decoration means a
  // second marker and a second tick in the ruler for one intent.
  const { painted, highlight } = await paintOnce('[agent:dm bob] body\r\n', { cols: 10 });
  assert.strictEqual(highlight.count(), 1);
  assert.strictEqual(painted.length, 1);
  assert.deepStrictEqual({ x: painted[0].x, width: painted[0].width }, { x: 0, width: 10 });
  highlight.dispose();
});

test('an unlocatable token falls back to the full-row wash rather than a guessed column', async () => {
  // cols=5 splits the bracket ITSELF ('[agen' / 't:who' / ']'), so the head row
  // holds no `[agent:` to locate. The line still fires, so it must stay marked
  // — and the whole row is the honest mark exactly where a column would
  // otherwise be invented.
  const { painted, highlight } = await paintOnce('[agent:who]\r\n', { cols: 5 });
  assert.strictEqual(highlight.count(), 1);
  assert.deepStrictEqual({ x: painted[0].x, width: painted[0].width }, { x: 0, width: 5 });
  highlight.dispose();
});

test('a span stranded by a resize is repainted, not kept', async () => {
  // x/width are frozen into the decoration at registration while reconcile
  // deliberately KEEPS unchanged rows. A reflow moves the token, so the kept
  // decoration would sit over the wrong cells — pinned because nothing on
  // screen would say so.
  const h = harness({ cols: 10 });
  await h.write('[agent:dm bob] body\r\n');
  await h.settle();
  assert.deepStrictEqual({ x: h.painted[0].x, width: h.painted[0].width }, { x: 0, width: 10 });

  h.terminal.resize(40, 10);
  await h.settle();
  assert.strictEqual(h.highlight.count(), 1, 'still exactly one mark after the reflow');
  const last = h.painted[h.painted.length - 1];
  // Unclipped now that the whole token fits one row.
  assert.deepStrictEqual({ x: last.x, width: last.width }, { x: 0, width: '[agent:dm bob]'.length });
  h.highlight.dispose();
});

test('prose that merely mentions an intent paints nothing', async () => {
  // The part-1 gate, seen from the paint side: this is what the operator was
  // watching turn into a mosaic.
  const h = harness();
  await h.write('I will emit [agent:who] shortly\r\nsee [agent:dm bob] for the form\r\n[agent:who]\r\n');
  await h.settle();
  // ENTER: the real intent on the third row IS painted, so the two absences are
  // absences in a buffer that was actually scanned.
  assert.strictEqual(h.painted.length, 1);
  assert.strictEqual(h.terminal.buffer.active.getLine(2).translateToString(true), '[agent:who]');
  h.highlight.dispose();
});
