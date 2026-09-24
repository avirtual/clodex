'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseTranscript } = require('../transcript-spike');
const { OUTPUT_LINE_CAP, renderTranscript, createLiveSplitView } = require('../renderer/live-split-view');

function fakeDoc() {
  return {
    createTextNode: (text) => ({ text, style: '' }),
    createElement: () => ({
      style: {},
      get text() { return this.textContent; },
      set innerHTML(v) { throw new Error(`innerHTML written: ${v}`); },
    }),
    createDocumentFragment: () => ({ kids: [], appendChild(n) { this.kids.push(n); return n; } }),
  };
}

function render(rows) {
  const pane = { replaceChildren(frag) { this.nodes = frag.kids; } };
  renderTranscript(fakeDoc(), pane, rows);
  return pane.nodes.map((n) => ({ text: n.text, style: n.style.cssText !== undefined ? n.style.cssText : n.style }));
}

const plain = (nodes) => nodes.map((n) => n.text).join('');
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'local-command-context.jsonl'), 'utf8');

test('the /context records become a command row then a command-output row rendered with their SGR styles', () => {
  const rows = parseTranscript(FIXTURE);
  assert.deepStrictEqual(rows.map((r) => r.kind), ['command', 'command-output']);
  assert.deepStrictEqual(rows[0], { kind: 'command', name: '/context', args: '' });
  const nodes = render(rows);
  assert.deepStrictEqual(nodes.slice(0, 5), [
    { text: '❯ /context', style: '' },
    { text: '\n', style: '' },
    { text: 'Context Usage', style: 'font-weight:bold' },
    { text: '\n', style: '' },
    { text: '⛁ ⛁ ⛁ ⛁ ⛁ ', style: 'color:rgb(153,153,153)' },
  ]);
  assert.strictEqual(plain(nodes).split('\n')[1], 'Context Usage');
  assert.doesNotMatch(plain(nodes), /\x1b/);
});

test('a command-output record with no command before it still renders after the text rows', () => {
  const rec = (o) => JSON.stringify(o);
  const rows = parseTranscript([
    rec({ type: 'user', message: { content: 'hi' } }),
    rec({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>Help dialog dismissed</local-command-stdout>' }),
  ].join('\n'));
  assert.deepStrictEqual(rows, ['❯ hi', { kind: 'command-output', text: 'Help dialog dismissed' }]);
  assert.strictEqual(plain(render(rows)), '❯ hi\nHelp dialog dismissed');
});

test('command args follow the name on the prompt line', () => {
  assert.strictEqual(plain(render([{ kind: 'command', name: '/model', args: 'opus' }])), '❯ /model opus');
});

test(`command output is capped at ${OUTPUT_LINE_CAP} lines per record with a count of the rest`, () => {
  const text = Array.from({ length: OUTPUT_LINE_CAP + 5 }, (_, i) => `\x1b[1mL${i}\x1b[22m`).join('\n');
  const lines = plain(render([{ kind: 'command-output', text }])).split('\n');
  assert.strictEqual(lines.length, OUTPUT_LINE_CAP + 1);
  assert.strictEqual(lines[OUTPUT_LINE_CAP - 1], `L${OUTPUT_LINE_CAP - 1}`);
  assert.strictEqual(lines[OUTPUT_LINE_CAP], '… 5 more lines');
  const exact = Array.from({ length: OUTPUT_LINE_CAP }, (_, i) => `L${i}`).join('\n');
  assert.strictEqual(plain(render([{ kind: 'command-output', text: exact }])).split('\n').length, OUTPUT_LINE_CAP);
});

test('markup characters in command output land as text content, never as HTML', () => {
  const nodes = render([{ kind: 'command-output', text: '\x1b[31m<img src=x onerror=1>&amp;\x1b[39m' }]);
  assert.deepStrictEqual(nodes, [{ text: '<img src=x onerror=1>&amp;', style: 'color:rgb(205,49,49)' }]);
});

function mountView(extra = {}) {
  const prevDoc = global.document;
  global.document = {
    ...fakeDoc(),
    createElement: () => ({
      style: {}, scrollTop: 0, clientHeight: 0, scrollHeight: 0,
      addEventListener() {}, remove() {}, replaceChildren() {},
    }),
  };
  const writes = [];
  const csi = {};
  const screen = [];
  const terminal = {
    rows: 4, cols: 20, element: null,
    buffer: { active: { type: 'normal', baseY: 0, cursorY: 1, viewportY: 0, getLine: (i) => (screen[i] == null ? null : { translateToString: () => screen[i] }) } },
    parser: {
      registerCsiHandler(id, cb) { csi[`${id.prefix}${id.final}`] = cb; return { dispose() {} }; },
    },
    onWriteParsed(cb) { writes.push(cb); return { dispose() {} }; },
    onResize() { return { dispose() {} }; },
    onScroll() { return { dispose() {} }; },
  };
  const calls = { pull: 0, unsubscribed: 0 };
  let listener = null;
  let rev = 0;
  const view = createLiveSplitView(terminal, { appendChild() {} }, {
    isEligible: () => true,
    pullTranscript: () => { calls.pull += 1; rev += 1; return { ok: true, rev, lines: [`r${rev}`] }; },
    now: () => 5000,
    seatName: 's1',
    onTranscriptChanged: (cb) => { listener = cb; return () => { calls.unsubscribed += 1; listener = null; }; },
    ...extra,
  });
  return {
    view, calls, csi,
    show: (rows) => { screen.length = 0; screen.push(...rows); },
    write: () => writes.forEach((cb) => cb()),
    change: (name) => listener && listener(name),
    hasListener: () => !!listener,
    restore: () => { global.document = prevDoc; },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

test('a transcript-changed push for the seat pulls inside the throttle window', async () => {
  const m = mountView();
  try {
    m.write();
    await settle();
    assert.strictEqual(m.calls.pull, 1);
    m.write();
    await settle();
    assert.strictEqual(m.calls.pull, 1);
    m.change('s1');
    await settle();
    assert.strictEqual(m.calls.pull, 2);
  } finally { m.view.dispose(); m.restore(); }
});

test('a transcript-changed push for another seat does not pull', async () => {
  const m = mountView();
  try {
    m.write();
    await settle();
    m.change('other');
    await settle();
    assert.strictEqual(m.calls.pull, 1);
  } finally { m.view.dispose(); m.restore(); }
});

test('dispose unsubscribes from transcript-changed', () => {
  const m = mountView();
  try {
    assert.strictEqual(m.hasListener(), true);
    m.view.dispose();
    assert.strictEqual(m.calls.unsubscribed, 1);
    assert.strictEqual(m.hasListener(), false);
  } finally { m.restore(); }
});

const RULE_ROW = '─'.repeat(20);
const ANCHORED = [RULE_ROW, '❯ ', '', ''];
const ANCHORED_TALL = [RULE_ROW, '❯ ', '  footer', ''];
const STREAMING = ['partial reply', '─────', '', ''];

async function mountSplit() {
  let t = 5000;
  const changes = [];
  const m = mountView({ now: () => t, onChange: (st) => changes.push({ ...st }) });
  m.show(ANCHORED);
  m.write();
  await settle();
  t += 250;
  m.write();
  assert.deepStrictEqual([m.view.state().mode, m.view.state().top, m.view.state().bottom], ['split', 0, 1]);
  changes.length = 0;
  return { ...m, changes, tick: (ms) => { t += ms; } };
}

test('a write parsed while the cursor is hidden is not evaluated; the frame close re-evaluates without a flicker', async () => {
  const m = await mountSplit();
  try {
    const before = m.view.state();
    assert.strictEqual(m.csi['?l']([25]), false);
    m.show(STREAMING);
    m.write();
    assert.deepStrictEqual(m.view.state(), before);
    assert.deepStrictEqual(m.changes, []);
    assert.strictEqual(m.csi['?h']([25]), false);
    m.show(ANCHORED_TALL);
    m.write();
    assert.deepStrictEqual([m.view.state().mode, m.view.state().bottom], ['split', 2]);
    assert.deepStrictEqual(m.changes.map((c) => c.mode), ['split']);
  } finally { m.view.dispose(); m.restore(); }
});

test('a chunk that both hides and shows the cursor evaluates at its parse end', async () => {
  const m = await mountSplit();
  try {
    m.csi['?l']([25]);
    m.csi['?h']([25]);
    m.show(ANCHORED_TALL);
    m.write();
    assert.deepStrictEqual(m.changes.map((c) => [c.mode, c.bottom]), [['split', 2]]);
  } finally { m.view.dispose(); m.restore(); }
});

test('a private mode other than 25 does not gate evaluation', async () => {
  const m = await mountSplit();
  try {
    m.csi['?l']([2004]);
    m.show(ANCHORED_TALL);
    m.write();
    assert.deepStrictEqual(m.changes.map((c) => [c.mode, c.bottom]), [['split', 2]]);
  } finally { m.view.dispose(); m.restore(); }
});

test('a transcript pull with a new rev while already available re-evaluates the split', async () => {
  const m = await mountSplit();
  try {
    m.show(ANCHORED_TALL);
    m.change('s1');
    await settle();
    assert.deepStrictEqual(m.changes.map((c) => [c.mode, c.bottom]), [['split', 2]]);
  } finally { m.view.dispose(); m.restore(); }
});

const CAPTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'cli-captures', 'a-seq-truncated.raw'), 'latin1');
const FRAMES = CAPTURE.split('\x1b[?25h');
const OPEN_ACROSS_LF = FRAMES.filter((seg) => {
  const hide = seg.lastIndexOf('\x1b[?25l');
  return hide >= 0 && seg.indexOf('\n', hide) >= 0;
});

test(`ENTER: the real capture splits into ${FRAMES.length} segments at ?25h, ${OPEN_ACROSS_LF.length} of them feed a line inside a hidden-cursor frame`, () => {
  assert.ok(FRAMES.length > 1);
  assert.ok(OPEN_ACROSS_LF.length >= 1);
});
