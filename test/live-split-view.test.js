'use strict';

const test = require('node:test');
const { mock } = test;
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseTranscript } = require('../transcript-spike');
const { renderTranscript, renderStatusChips, createLiveSplitView, modeBar } = require('../renderer/live-split-view');
const { OUTPUT_LINE_CAP } = require('../renderer/transcript-rows');
const { segmentsOf } = require('../transcript-records');
const { fakeDocument, textOf } = require('./lib/fake-dom');
const { fakeLine } = require('./lib/fake-cells');
const { createMenuMirror } = require('../renderer/lib/menu-mirror');
const { createSeatView, seatViewDeps, toggleSeatTerminal } = require('../renderer/lib/seat-view');

function fakeDoc() {
  return fakeDocument();
}

const leafOf = (n) => {
  const out = { text: n.nodeType === 3 ? n.data : n.textContent, style: n.style && n.style.cssText ? n.style.cssText : '' };
  if (n.className) out.cls = n.className;
  if (n.tag === 'a') out.href = n.dataset.path || n.dataset.url;
  return out;
};

let seq = 0;
const R = (o) => ({ id: `r${seq += 1}`, ts: null, turn: 1, ...o });
const out = (text) => R({ kind: 'command-output', text });
const prose = (text) => R({ kind: 'assistant', text });
const prompt = (text) => R({ kind: 'prompt', text, source: 'typed' });

function renderPane(records, ctx) {
  const doc = fakeDoc();
  const pane = doc.createElement('div');
  renderTranscript(doc, pane, records, ctx);
  return pane;
}

function rowNodes(records, ctx) {
  const pane = renderPane(records, ctx);
  return pane.childNodes.flatMap((turn) => turn.childNodes);
}

function renderNodes(records, ctx) {
  const rows = rowNodes(records, ctx);
  const body = (row) => (row.className.includes('tr-head') ? row.childNodes.find((k) => k.className === 'tr-head-text') : row);
  return rows.flatMap((row) => body(row).childNodes).flatMap((n) => (n.tag === 'p' ? n.childNodes : [n]));
}

function render(records, ctx) {
  return renderNodes(records, ctx).map(leafOf);
}

const plain = (nodes) => nodes.map((n) => n.text).join('');
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'local-command-context.jsonl'), 'utf8');

test('the /context records become a command row then a command-output row rendered with their SGR styles', () => {
  const rows = parseTranscript(FIXTURE);
  assert.deepStrictEqual(rows.map((r) => r.kind), ['command', 'command-output']);
  assert.deepStrictEqual([rows[0].name, rows[0].args], ['/context', '']);
  const [head, output] = rowNodes(rows);
  assert.deepStrictEqual(head.childNodes.map((n) => n.className), ['tr-head-text', 'tr-time']);
  assert.strictEqual(head.childNodes[0].textContent, '❯ /context');
  assert.deepStrictEqual([output.tag, output.className], ['pre', 'tr-row tr-output']);
  assert.deepStrictEqual(output.childNodes.slice(0, 3).map(leafOf), [
    { text: 'Context Usage', style: 'font-weight:bold' },
    { text: '\n', style: '' },
    { text: '⛁ ⛁ ⛁ ⛁ ⛁ ', style: 'color:rgb(153,153,153)' },
  ]);
  assert.doesNotMatch(output.textContent, /\x1b/);
});

test('command args follow the name on the command row', () => {
  assert.strictEqual(rowNodes([R({ kind: 'command', name: '/model', args: 'opus' })])[0].textContent, '❯ /model opus');
});

test(`command output is capped at ${OUTPUT_LINE_CAP} lines per record with a count of the rest`, () => {
  const text = Array.from({ length: OUTPUT_LINE_CAP + 5 }, (_, i) => `\x1b[1mL${i}\x1b[22m`).join('\n');
  const lines = plain(render([out(text)])).split('\n');
  assert.strictEqual(lines.length, OUTPUT_LINE_CAP + 1);
  assert.strictEqual(lines[OUTPUT_LINE_CAP - 1], `L${OUTPUT_LINE_CAP - 1}`);
  assert.strictEqual(lines[OUTPUT_LINE_CAP], '… 5 more lines');
  const exact = Array.from({ length: OUTPUT_LINE_CAP }, (_, i) => `L${i}`).join('\n');
  assert.strictEqual(plain(render([out(exact)])).split('\n').length, OUTPUT_LINE_CAP);
});

test('markup characters in command output land as text content, never as HTML', () => {
  const nodes = render([out('\x1b[31m<img src=x onerror=1>&amp;\x1b[39m')]);
  assert.deepStrictEqual(nodes, [{ text: '<img src=x onerror=1>&amp;', style: 'color:rgb(205,49,49)' }]);
});

const marked = (nodes) => nodes.filter((n) => n.cls);

test('a prose row marks each intent token and leaves the prose around it as plain text', () => {
  const nodes = render([prose('Reply\n[agent:dm bob] hi\n[agent:end]')]);
  assert.deepStrictEqual(marked(nodes), [
    { text: '[agent:dm bob]', style: '', cls: 'intent-mark intent-mark-fire' },
  ]);
  assert.strictEqual(plain(nodes), 'Reply\n[agent:dm bob] hi\n[agent:end]');
  assert.deepStrictEqual(nodes.filter((n) => !n.cls).map((n) => n.text).join('|'), 'Reply|\n| hi|\n|[agent:end]');
});

test('a start-of-line intent in a prose row or a prompt head is classified, not missed', () => {
  assert.deepStrictEqual(marked(render([prose('[agent:task list]')])), [{ text: '[agent:task list]', style: '', cls: 'intent-mark intent-mark-fire' }]);
  assert.deepStrictEqual(marked(render([prompt('[agent:task list]')])), [{ text: '[agent:task list]', style: '', cls: 'intent-mark intent-mark-fire' }]);
});

test('an intent inside a fence gets no mark', () => {
  assert.deepStrictEqual(marked(render([prose('```\n[agent:dm x]\n```')])), []);
});

function linkCtx(resolved) {
  const calls = { resolve: [], peek: [], toast: [], external: [] };
  return {
    calls,
    ctx: {
      seatName: 's1',
      resolveFile: (p) => { calls.resolve.push(p); return Promise.resolve(resolved); },
      openFilePeek: (...a) => calls.peek.push(a),
      toast: (...a) => calls.toast.push(a),
      openExternal: (u) => calls.external.push(u),
    },
  };
}

const click = (node) => {
  let prevented = 0;
  node.listeners.click({ preventDefault: () => { prevented += 1; } });
  return prevented;
};

const tick = () => new Promise((r) => setImmediate(r));

test('a file path renders as a link that resolves then peeks at the named line', async () => {
  const { calls, ctx } = linkCtx({ ok: true, path: '/abs/y.js' });
  const a = renderNodes([prose('see /Users/x/y.js:12 now')], ctx).find((n) => n.tag === 'a');
  assert.deepStrictEqual([a.className, a.href, a.textContent, a.dataset.path], ['pane-link', '#', '/Users/x/y.js:12', '/Users/x/y.js']);
  assert.strictEqual(click(a), 1);
  await tick();
  assert.deepStrictEqual(calls.resolve, ['/Users/x/y.js']);
  assert.deepStrictEqual(calls.peek, [['s1', '/abs/y.js', 'file', 12]]);
  assert.deepStrictEqual(calls.toast.length, 0);
});

test('a path that does not resolve toasts once and never peeks', async () => {
  const { calls, ctx } = linkCtx({ ok: false });
  const a = renderNodes([prose('see /Users/x/y.js:12 now')], ctx).find((n) => n.tag === 'a');
  click(a);
  await tick();
  assert.strictEqual(calls.toast.length, 1);
  assert.deepStrictEqual(calls.peek, []);
});

test('an https URL renders as a link that opens externally; a javascript: URL stays text', () => {
  const { calls, ctx } = linkCtx(null);
  const links = renderNodes([prose('at https://example.com and javascript://x')], ctx).filter((n) => n.tag === 'a');
  assert.deepStrictEqual(links.map((n) => n.dataset.url), ['https://example.com']);
  assert.strictEqual(click(links[0]), 1);
  assert.deepStrictEqual(calls.external, ['https://example.com']);
  assert.match(plain(render([prose('at https://example.com and javascript://x')])), / and javascript:\/\/x$/);
});

test('a link inside styled command output keeps its run style', () => {
  assert.deepStrictEqual(render([out('\x1b[1mopen /Users/x/y.js\x1b[22m')]), [
    { text: 'open ', style: 'font-weight:bold' },
    { text: '/Users/x/y.js', style: 'font-weight:bold', cls: 'pane-link', href: '/Users/x/y.js' },
  ]);
});

test('command output in the CLI echo colours takes the theme echo palette', () => {
  const echoText = '\x1b[48;2;240;240;240m\x1b[38;2;0;0;0m ls \x1b[49m\x1b[39m';
  const palette = { bg: '#102030', fg: '#aabbcc', prompt: '#445566' };
  assert.deepStrictEqual(render([out(echoText)], { echoPalette: palette }), [
    { text: ' ls ', style: 'color:rgb(170,187,204);background-color:rgb(16,32,48)' },
  ]);
  assert.deepStrictEqual(render([out(echoText)], { echoPalette: () => palette })[0].style, 'color:rgb(170,187,204);background-color:rgb(16,32,48)');
  assert.deepStrictEqual(render([out(echoText)])[0].style, 'color:rgb(0,0,0);background-color:rgb(240,240,240)');
});

function fakePane() {
  let height = 0;
  const pane = fakeDocument().createElement('div');
  Object.assign(pane, { top: 0, scrollHeight: 1000, handlers: {}, removed: 0, queued: 0 });
  Object.defineProperty(pane, 'clientHeight', { get: () => height });
  Object.defineProperty(pane, 'scrollTop', {
    get: () => pane.top,
    set: (v) => {
      const next = Math.max(0, Math.min(v, pane.scrollHeight - height));
      if (next !== pane.top) pane.queued += 1;
      pane.top = next;
    },
  });
  pane.addEventListener = (type, cb) => { pane.handlers[type] = cb; };
  pane.removeEventListener = (type, cb) => { if (pane.handlers[type] === cb) { delete pane.handlers[type]; pane.removed += 1; } };
  pane.flushScroll = () => {
    const n = pane.queued;
    pane.queued = 0;
    for (let i = 0; i < n; i += 1) if (pane.handlers.scroll) pane.handlers.scroll();
  };
  pane.userScroll = (v) => { pane.scrollTop = v; pane.flushScroll(); };
  pane.style = {};
  Object.defineProperty(pane.style, 'height', {
    get: () => `${height}px`,
    set: (v) => { height = parseInt(v, 10) || 0; pane.scrollTop = pane.top; },
  });
  return pane;
}

const ROW_PX = 20;
const WRAPPER_PX = 400;

function fakeTermElement(rows) {
  const screen = { offsetHeight: rows * ROW_PX, offsetTop: 0 };
  return { style: {}, offsetTop: 0, offsetHeight: rows * ROW_PX, querySelector: () => screen };
}

const HEAD = { id: 'p1', kind: 'prompt', ts: null, turn: 1, text: 'run it', source: 'typed' };
const recordsAt = (rev) => [HEAD, { id: 't1', kind: 'tool', ts: null, turn: 1, name: 'Bash', arg: 'make', state: rev > 1 ? 'ok' : 'pending', sum: rev > 1 ? { exit: 0, lines: rev, interrupted: false, background: false, persisted: null, only: null } : null }];

function findByClass(nodes, cls) {
  for (const n of nodes) {
    if (String(n.className || '').split(' ').includes(cls)) return n;
    const hit = findByClass(n.childNodes || [], cls);
    if (hit) return hit;
  }
  return null;
}

function mountView(extra = {}, { parser = true, geometry = false } = {}) {
  const prevDoc = global.document;
  const prevStyle = global.getComputedStyle;
  let pane = null;
  const doc = fakeDoc();
  global.document = {
    ...doc,
    createElement: (tag) => {
      if (pane) return doc.createElement(tag);
      pane = fakePane();
      return pane;
    },
  };
  global.getComputedStyle = () => ({ paddingTop: '0', paddingBottom: '0' });
  const writes = [];
  const csi = {};
  const screen = [];
  const screenCells = [];
  const scrolls = [];
  const terminal = {
    rows: 4, cols: 20, element: geometry ? fakeTermElement(4) : null,
    buffer: { active: { type: 'normal', baseY: 0, cursorY: 1, viewportY: 0, getLine: (i) => (screen[i] == null ? null : fakeLine(screen[i], screenCells[i] || [])) } },
    parser: parser ? {
      registerCsiHandler(id, cb) { csi[`${id.prefix}${id.final}`] = cb; return { dispose() {} }; },
    } : undefined,
    onWriteParsed(cb) { writes.push(cb); return { dispose() {} }; },
    onResize() { return { dispose() {} }; },
    onScroll(cb) { scrolls.push(cb); return { dispose() {} }; },
  };
  const calls = { pull: 0, unsubscribed: 0 };
  let listener = null;
  let rev = 0;
  const classes = new Set();
  const appended = [];
  const wrapper = { appendChild: (c) => appended.push(c), querySelector: (sel) => findByClass(appended, sel.slice(1)), style: {}, clientHeight: WRAPPER_PX, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } };
  const view = createLiveSplitView(terminal, wrapper, {
    isEligible: () => true,
    pullTranscript: () => { calls.pull += 1; rev += 1; return { ok: true, rev, records: recordsAt(rev) }; },
    now: () => 5000,
    seatName: 's1',
    onTranscriptChanged: (cb) => { listener = cb; return () => { calls.unsubscribed += 1; listener = null; }; },
    ...extra,
  });
  return {
    view, calls, csi, pane, terminal, wrapper, wrapperEl: wrapper, appended,
    show: (rows, cells = []) => { screen.length = 0; screen.push(...rows); screenCells.length = 0; screenCells.push(...cells); },
    scroll: () => scrolls.forEach((cb) => cb()),
    write: () => writes.forEach((cb) => cb()),
    change: (name) => listener && listener(name),
    hasListener: () => !!listener,
    restore: () => { global.document = prevDoc; global.getComputedStyle = prevStyle; },
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

test('a codex seat in the alternate buffer measures its composer and reaches split', async () => {
  let t = 5000;
  const m = mountView({ now: () => t, platform: () => 'codex' });
  try {
    m.terminal.buffer.active.type = 'alternate';
    m.show(['', '› Ask Codex', '', '  Context 0% used']);
    m.write();
    await settle();
    t += 250;
    m.write();
    assert.deepStrictEqual([m.view.state().mode, m.view.state().top, m.view.state().bottom], ['split', 1, 3]);
  } finally { m.view.dispose(); m.restore(); }
});

test('a seat with no platform getter measures as claude, so a codex composer stays full', async () => {
  let t = 5000;
  const m = mountView({ now: () => t });
  try {
    m.show(['', '› Ask Codex', '', '  status']);
    m.write();
    await settle();
    t += 250;
    m.write();
    assert.strictEqual(m.view.state().mode, 'full');
  } finally { m.view.dispose(); m.restore(); }
});

test('a running turn mirrors the CLI spinner above the anchor into the working row, and idle removes it', async () => {
  let t = 5000;
  const m = mountView({ now: () => t });
  try {
    m.terminal.buffer.active.cursorY = 2;
    m.show(['✻ Percolating… (7s · thinking)', RULE_ROW, '❯ ', '']);
    m.view.setTurnRunning('thinking', 1000);
    const row = () => m.pane.childNodes.find((n) => String(n.className).includes('tr-working'));
    assert.strictEqual(row().childNodes[1].textContent, 'Working');
    m.write();
    await settle();
    t += 250;
    m.write();
    assert.strictEqual(m.view.state().mode, 'split');
    assert.strictEqual(row().childNodes[1].textContent, 'Percolating… · thinking');
    assert.strictEqual(row().childNodes[2].textContent, '4s');
    m.view.setTurnRunning('attention', null);
    assert.strictEqual(row().childNodes[1].textContent, 'Waiting for you');
    m.view.setTurnRunning('idle', null);
    assert.strictEqual(row(), undefined);
  } finally { m.view.dispose(); m.restore(); }
});

async function mountSplit(opts, extra = {}) {
  let t = 5000;
  const changes = [];
  const m = mountView({ now: () => t, onChange: (st) => changes.push({ ...st }), ...extra }, opts);
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

test('a frame the CLI leaves with the cursor hidden still drops to full after the fallback and the exit settle', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let m = null;
  try {
    m = await mountSplit();
    m.csi['?l']([25]);
    m.show(STREAMING);
    m.write();
    assert.strictEqual(m.view.state().mode, 'split');
    m.tick(50);
    mock.timers.tick(50);
    assert.deepStrictEqual([m.view.state().mode, m.view.state().wakeAt], ['split', 5350]);
    m.tick(50);
    mock.timers.tick(50);
    assert.strictEqual(m.view.state().mode, 'full');
    assert.deepStrictEqual(m.changes.map((c) => c.mode), ['full']);
  } finally { if (m) { m.view.dispose(); m.restore(); } mock.timers.reset(); }
});

test('a terminal without a parser evaluates every write', async () => {
  const m = await mountSplit({ parser: false });
  try {
    m.show(ANCHORED_TALL);
    m.write();
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

const bottomOf = (pane) => pane.scrollHeight - pane.clientHeight;

test('ENTER: a transcript render with follow on scrolls the pane to the bottom', async () => {
  const m = await mountSplit({ geometry: true });
  try {
    m.pane.scrollHeight = 1200;
    m.change('s1');
    await settle();
    assert.strictEqual(m.pane.clientHeight, WRAPPER_PX - 2 * ROW_PX);
    assert.strictEqual(m.pane.scrollTop, bottomOf(m.pane));
  } finally { m.view.dispose(); m.restore(); }
});

test('a layout that shrinks the pane under a bottom-scrolled position keeps it at the bottom', async () => {
  const m = await mountSplit({ geometry: true });
  try {
    assert.strictEqual(m.pane.scrollTop, bottomOf(m.pane));
    m.show(ANCHORED_TALL);
    m.write();
    assert.strictEqual(m.pane.clientHeight, WRAPPER_PX - 3 * ROW_PX);
    assert.strictEqual(m.pane.scrollTop, bottomOf(m.pane));
  } finally { m.view.dispose(); m.restore(); }
});

test('scrolling the pane up releases follow, so a later render leaves scrollTop alone', async () => {
  const m = await mountSplit({ geometry: true });
  try {
    m.pane.userScroll(100);
    m.pane.scrollHeight = 1400;
    m.change('s1');
    await settle();
    assert.strictEqual(m.calls.pull, 2);
    assert.strictEqual(m.pane.scrollTop, 100);
  } finally { m.view.dispose(); m.restore(); }
});

test('scrolling back to within 4px of the bottom re-engages follow', async () => {
  const m = await mountSplit({ geometry: true });
  try {
    m.pane.userScroll(100);
    m.pane.userScroll(bottomOf(m.pane) - 3);
    m.pane.scrollHeight = 1400;
    m.change('s1');
    await settle();
    assert.strictEqual(m.pane.scrollTop, bottomOf(m.pane));
  } finally { m.view.dispose(); m.restore(); }
});

test('dispose removes the pane scroll listener', () => {
  const m = mountView();
  try {
    assert.strictEqual(typeof m.pane.handlers.scroll, 'function');
    m.view.dispose();
    assert.strictEqual(m.pane.removed, 1);
    assert.strictEqual(m.pane.handlers.scroll, undefined);
  } finally { m.restore(); }
});

test('the pane\'s own scroll to the bottom does not release follow when content grows before its scroll event lands', async () => {
  const m = await mountSplit({ geometry: true });
  try {
    m.pane.scrollHeight = 1200;
    m.change('s1');
    await settle();
    assert.strictEqual(m.pane.scrollTop, bottomOf(m.pane));
    assert.ok(m.pane.queued > 0);
    m.pane.scrollHeight = 1300;
    m.pane.flushScroll();
    m.pane.scrollHeight = 1400;
    m.change('s1');
    await settle();
    assert.strictEqual(m.pane.scrollTop, bottomOf(m.pane));
  } finally { m.view.dispose(); m.restore(); }
});

test('a render that replaces a changed row keeps the unchanged rows and leaves a scrolled-up pane where it was', async () => {
  const m = await mountSplit({ geometry: true });
  try {
    const turn = m.pane.childNodes[1];
    const [head, block] = turn.childNodes;
    const tool = block.childNodes[0];
    assert.strictEqual(tool.className, 'tr-row tr-tool tr-state-pending');
    m.pane.userScroll(100);
    m.pane.scrollHeight = 1400;
    m.change('s1');
    await settle();
    assert.strictEqual(m.pane.childNodes[1], turn);
    assert.strictEqual(turn.childNodes[0], head);
    assert.strictEqual(turn.childNodes[1], block);
    assert.notStrictEqual(block.childNodes[0], tool);
    assert.strictEqual(block.childNodes[0].className, 'tr-row tr-tool tr-state-ok');
    assert.strictEqual(m.pane.scrollTop, 100);
  } finally { m.view.dispose(); m.restore(); }
});

test('the pane leads with a Conversation / Internals mode control that stays first; Conversation hides injected rows and reports the choice', async () => {
  let current = 'internals';
  const reported = [];
  const recs = [HEAD, { id: 'n1', kind: 'notice', ts: null, turn: 1, level: 'info', text: 'filed' }];
  const m = mountView({ mode: () => current, onMode: (next) => reported.push(next), pullTranscript: () => ({ ok: true, rev: 1, records: recs }) });
  try {
    m.write();
    await settle();
    const [bar, turn] = m.pane.childNodes;
    assert.strictEqual(bar.className, 'transcript-bar');
    const control = bar.childNodes[1].childNodes[0];
    assert.strictEqual(control.className, 'transcript-mode');
    const [conv, internals] = control.childNodes;
    const pressed = () => control.childNodes.map((b) => [b.tag, b.type, b.textContent, b.getAttribute('aria-pressed')]);
    assert.deepStrictEqual(pressed(), [['button', 'button', 'Conversation', 'false'], ['button', 'button', 'Internals', 'true']]);
    const notice = () => turn.childNodes.find((n) => n.dataset.id === 'n1');
    assert.strictEqual(notice().className, 'tr-box');
    conv.listeners.click();
    assert.deepStrictEqual(reported, ['conversation']);
    assert.strictEqual(notice().className, 'tr-box tr-hidden');
    assert.deepStrictEqual(pressed().map((p) => p[3]), ['true', 'false']);
    internals.listeners.click();
    internals.listeners.click();
    assert.deepStrictEqual(reported, ['conversation', 'internals']);
    current = 'conversation';
    m.view.refresh();
    assert.deepStrictEqual([pressed().map((p) => p[3]), notice().className], [['true', 'false'], 'tr-box tr-hidden']);
  } finally { m.view.dispose(); m.restore(); }
});

test('each pull hands back the rev it last applied, and an unchanged answer leaves the pane untouched', async () => {
  const seen = [];
  const recs = [HEAD, { id: 'n1', kind: 'notice', ts: null, turn: 1, level: 'info', text: 'filed' }];
  const pullTranscript = (since) => { seen.push(since); return since === 7 ? { ok: true, rev: 7, unchanged: true } : { ok: true, rev: 7, records: recs }; };
  const m = mountView({ pullTranscript });
  try {
    m.write();
    await settle();
    const before = [...m.pane.childNodes];
    const turn = before[1];
    assert.ok(turn.childNodes.some((n) => n.dataset.id === 'n1'), 'ENTER: the first answer painted');
    m.change('s1');
    await settle();
    assert.deepStrictEqual(seen, [-1, 7]);
    assert.deepStrictEqual(m.pane.childNodes, before);
    assert.ok(turn.childNodes.some((n) => n.dataset.id === 'n1'));
  } finally { m.view.dispose(); m.restore(); }
});

test('the pane is a div, not a pre', () => {
  const m = mountView();
  try {
    assert.strictEqual(m.pane.tag, 'div');
    assert.strictEqual(m.pane.className, 'transcript-pane');
  } finally { m.view.dispose(); m.restore(); }
});

test('setRaw(true) drops a split view to full at once and stops pulling; setRaw(false) lets it re-enter', async () => {
  const m = await mountSplit();
  try {
    assert.strictEqual(m.view.raw(), false);
    const pulls = m.calls.pull;
    m.view.setRaw(true);
    assert.strictEqual(m.view.raw(), true);
    assert.strictEqual(m.view.state().mode, 'full');
    assert.deepStrictEqual(m.changes.map((c) => c.mode), ['full']);
    m.change('s1');
    m.tick(2000);
    m.write();
    await settle();
    assert.strictEqual(m.view.state().mode, 'full');
    assert.strictEqual(m.calls.pull, pulls);
    m.view.setRaw(false);
    await settle();
    m.tick(300);
    m.write();
    assert.strictEqual(m.view.state().mode, 'split');
    assert.ok(m.calls.pull > pulls);
  } finally { m.view.dispose(); m.restore(); }
});

const COMPOSER_PX = 60;

function fakeComposer() {
  const c = { hidden: true, offsetHeight: COMPOSER_PX, focused: 0 };
  c.focus = () => { c.focused += 1; global.document.activeElement = c; };
  return c;
}

test('a composer in split hides the whole terminal, shows the composer and sizes the pane above it', async () => {
  const composerEl = fakeComposer();
  const m = await mountSplit({ geometry: true }, { composerEl });
  try {
    const el = m.terminal.element;
    assert.strictEqual(el.style.visibility, 'hidden');
    assert.strictEqual(composerEl.hidden, false);
    assert.strictEqual(m.view.composerVisible(), true);
    assert.strictEqual(m.pane.hidden, false);
    assert.strictEqual(m.pane.clientHeight, WRAPPER_PX - COMPOSER_PX);
    assert.deepStrictEqual([el.style.transform, el.style.clipPath], ['', '']);
  } finally { m.view.dispose(); m.restore(); }
});

test('a composer in raw stays hidden, the terminal visible and the pane down to its bar', async () => {
  const composerEl = fakeComposer();
  const m = await mountSplit({ geometry: true }, { composerEl });
  try {
    m.view.setRaw(true);
    assert.strictEqual(m.view.state().mode, 'full');
    assert.strictEqual(composerEl.hidden, true);
    assert.strictEqual(m.terminal.element.style.visibility, '');
    assert.strictEqual(m.view.composerVisible(), false);
    assert.deepStrictEqual([m.pane.hidden, m.pane.dataset.raw], [false, '1']);
  } finally { m.view.dispose(); m.restore(); }
});

test('a transcript render while the composer is shown still sticks the pane to the bottom', async () => {
  const composerEl = fakeComposer();
  const m = await mountSplit({ geometry: true }, { composerEl });
  try {
    m.pane.scrollHeight = 1200;
    m.change('s1');
    await settle();
    assert.strictEqual(m.view.composerVisible(), true);
    assert.strictEqual(m.pane.scrollTop, bottomOf(m.pane));
  } finally { m.view.dispose(); m.restore(); }
});

test('entering split moves terminal focus to the composer; collapsing to full hands it back', async () => {
  let t = 5000;
  const composerEl = fakeComposer();
  const m = mountView({ now: () => t, composerEl }, { geometry: true });
  try {
    let termFocus = 0;
    m.terminal.textarea = { tag: 'xterm-helper' };
    m.terminal.focus = () => { termFocus += 1; global.document.activeElement = m.terminal.textarea; };
    global.document.activeElement = m.terminal.textarea;
    m.show(ANCHORED);
    m.write();
    await settle();
    t += 250;
    m.write();
    assert.strictEqual(m.view.state().mode, 'split');
    assert.strictEqual(composerEl.focused, 1);
    m.view.setRaw(true);
    assert.strictEqual(termFocus, 1);
    assert.strictEqual(global.document.activeElement, m.terminal.textarea);
  } finally { m.view.dispose(); m.restore(); }
});

test('a click in the pane focuses the composer while it is shown', async () => {
  const composerEl = fakeComposer();
  const m = await mountSplit({ geometry: true }, { composerEl });
  const prevWindow = global.window;
  global.window = { getSelection: () => ({ isCollapsed: true }) };
  try {
    let termFocus = 0;
    m.terminal.focus = () => { termFocus += 1; };
    m.pane.handlers.mouseup();
    assert.deepStrictEqual([composerEl.focused, termFocus], [1, 0]);
    m.view.setRaw(true);
    assert.deepStrictEqual([composerEl.focused, termFocus], [1, 1]);
    m.pane.handlers.mouseup();
    assert.deepStrictEqual([composerEl.focused, termFocus], [1, 2]);
  } finally { global.window = prevWindow; m.view.dispose(); m.restore(); }
});

test('a draft row with a composer given keeps the composer', async () => {
  const composerEl = fakeComposer();
  const m = await mountSplit({ geometry: true }, { composerEl });
  try {
    m.show([RULE_ROW, '❯ dictated words', '', '']);
    m.write();
    assert.strictEqual(m.view.state().mode, 'split');
    assert.strictEqual(m.view.composerVisible(), true);
    assert.strictEqual(m.terminal.element.style.visibility, 'hidden');
  } finally { m.view.dispose(); m.restore(); }
});

const PICKER = ['', '  Select model', '❯ 1. Opus', '  2. Sonnet'];

async function mountSheet(rows, extra = {}) {
  const composerEl = fakeComposer();
  const m = mountView({ composerEl, sheet: true, ...extra }, { geometry: true });
  m.show(rows);
  m.write();
  await settle();
  return { ...m, composerEl };
}

test('a busy full screen with sheet on keeps the pane above the terminal\'s last rows as a bottom sheet', async () => {
  const m = await mountSheet(PICKER);
  try {
    const el = m.terminal.element;
    assert.strictEqual(m.view.state().mode, 'full');
    assert.strictEqual(m.pane.hidden, false);
    assert.strictEqual(m.pane.clientHeight, WRAPPER_PX - 2 * ROW_PX);
    assert.strictEqual(m.composerEl.hidden, true);
    assert.strictEqual(el.style.visibility, '');
    assert.deepStrictEqual([el.style.transform, el.style.clipPath], [`translateY(${WRAPPER_PX - 4 * ROW_PX}px)`, `inset(${2 * ROW_PX}px 0 0px 0)`]);
    assert.strictEqual(m.wrapper.classList.contains('live-sheet'), true);
    assert.strictEqual(m.wrapper.classList.contains('live-split'), false);
  } finally { m.view.dispose(); m.restore(); }
});

test('a picker shorter than half the terminal takes only its own rows', async () => {
  const m = await mountSheet(['', '', '', '  spinner']);
  try {
    assert.strictEqual(m.pane.clientHeight, WRAPPER_PX - ROW_PX);
  } finally { m.view.dispose(); m.restore(); }
});

test('a blank full screen with sheet on keeps the whole-terminal full view', async () => {
  const m = await mountSheet(['', '', '', '']);
  try {
    assert.strictEqual(m.pane.hidden, true);
    assert.strictEqual(m.wrapper.classList.contains('live-sheet'), false);
    assert.ok(!m.terminal.element.style.transform);
  } finally { m.view.dispose(); m.restore(); }
});

test('a busy full screen with sheet off keeps the whole-terminal full view', async () => {
  const m = await mountSheet(PICKER, { sheet: false });
  try {
    assert.strictEqual(m.pane.hidden, true);
    assert.strictEqual(m.wrapper.classList.contains('live-sheet'), false);
    assert.ok(!m.terminal.element.style.transform);
  } finally { m.view.dispose(); m.restore(); }
});

test('entering the sheet from split hands composer focus to the terminal; returning to split hands it back', async () => {
  const composerEl = fakeComposer();
  const m = await mountSplit({ geometry: true }, { composerEl, sheet: true });
  try {
    let termFocus = 0;
    m.terminal.textarea = { tag: 'xterm-helper' };
    m.terminal.focus = () => { termFocus += 1; global.document.activeElement = m.terminal.textarea; };
    global.document.activeElement = composerEl;
    m.show(PICKER);
    m.write();
    m.tick(50);
    m.write();
    assert.strictEqual(m.wrapper.classList.contains('live-sheet'), true);
    assert.strictEqual(termFocus, 1);
    assert.strictEqual(global.document.activeElement, m.terminal.textarea);
    const focused = composerEl.focused;
    m.show(ANCHORED);
    m.write();
    m.tick(250);
    m.write();
    assert.strictEqual(m.view.state().mode, 'split');
    assert.strictEqual(m.wrapper.classList.contains('live-sheet'), false);
    assert.strictEqual(composerEl.focused, focused + 1);
    assert.strictEqual(global.document.activeElement, composerEl);
  } finally { m.view.dispose(); m.restore(); }
});

test('raw wins over the sheet: the whole terminal shows and the pane is down to its bar', async () => {
  const m = await mountSheet(PICKER);
  try {
    assert.strictEqual(m.wrapper.classList.contains('live-sheet'), true);
    m.view.setRaw(true);
    assert.deepStrictEqual([m.pane.hidden, m.pane.dataset.raw], [false, '1']);
    assert.strictEqual(m.wrapper.classList.contains('live-sheet'), false);
    assert.deepStrictEqual([m.terminal.element.style.transform, m.terminal.element.style.clipPath], ['', '']);
  } finally { m.view.dispose(); m.restore(); }
});

test('the boot screen that already measures split pins live-sheet before the settle tick', async () => {
  const m = await mountSheet(ANCHORED);
  try {
    assert.strictEqual(m.view.state().mode, 'full');
    assert.strictEqual(m.wrapper.classList.contains('live-sheet'), true);
  } finally { m.view.dispose(); m.restore(); }
});

test('a Codex upgrade prompt painted at the top shows its own rows in the sheet, from row 0', async () => {
  const rows = fs.readFileSync(path.join(__dirname, 'fixtures', 'split-states', 'codex-upgrade-prompt@100.screen.txt'), 'utf8').split('\n').slice(0, 30);
  const composerEl = fakeComposer();
  const m = mountView({ composerEl, sheet: true, platform: () => 'codex' }, { geometry: true });
  Object.assign(m.terminal, { rows: 30, cols: 100, element: fakeTermElement(30) });
  m.terminal.buffer.active.cursorY = 9;
  m.show(rows);
  m.write();
  await settle();
  try {
    const el = m.terminal.element;
    assert.strictEqual(m.view.state().mode, 'full');
    assert.strictEqual(m.wrapper.classList.contains('live-sheet'), true);
    assert.deepStrictEqual([el.style.transform, el.style.clipPath], [`translateY(${WRAPPER_PX - 14 * ROW_PX}px)`, `inset(0px 0 ${16 * ROW_PX}px 0)`]);
    assert.strictEqual(m.pane.clientHeight, WRAPPER_PX - 14 * ROW_PX);
  } finally { m.view.dispose(); m.restore(); }
});

test('a Codex picker opened with a past prompt in the history shows in the sheet with the composer hidden', async () => {
  const rows = fs.readFileSync(path.join(__dirname, 'fixtures', 'split-states', 'codex-picker-with-history@100.screen.txt'), 'utf8').split('\n').slice(0, 40);
  const composerEl = fakeComposer();
  let t = 5000;
  const m = mountView({ composerEl, sheet: true, now: () => t, platform: () => 'codex' }, { geometry: true });
  Object.assign(m.terminal, { rows: 40, cols: 100, element: fakeTermElement(40) });
  m.terminal.buffer.active.cursorY = 12;
  m.show(rows);
  m.write();
  await settle();
  t += 250;
  m.write();
  await settle();
  try {
    assert.strictEqual(m.view.state().mode, 'full');
    assert.strictEqual(m.wrapper.classList.contains('live-sheet'), true);
    assert.strictEqual(composerEl.hidden, true);
  } finally { m.view.dispose(); m.restore(); }
});

test('a Muse picker drawn below the kept strip shows in the sheet with the composer hidden', async () => {
  const rows = fs.readFileSync(path.join(__dirname, 'fixtures', 'split-states', 'muse-model-picker@100.screen.txt'), 'utf8').split('\n').slice(0, 30);
  const composerEl = fakeComposer();
  let t = 5000;
  const m = mountView({ composerEl, sheet: true, now: () => t, platform: () => 'muse' }, { geometry: true });
  Object.assign(m.terminal, { rows: 30, cols: 100, element: fakeTermElement(30) });
  m.terminal.buffer.active.cursorY = 28;
  m.show(rows);
  m.write();
  await settle();
  t += 250;
  m.write();
  await settle();
  try {
    assert.strictEqual(m.view.state().mode, 'full');
    assert.strictEqual(m.wrapper.classList.contains('live-sheet'), true);
    assert.strictEqual(composerEl.hidden, true);
  } finally { m.view.dispose(); m.restore(); }
});

test('a band that moves from the top rows to the bottom rows at the same length re-lays the sheet out', async () => {
  const m = await mountSheet(['  banner', '', '', '']);
  try {
    const el = m.terminal.element;
    assert.deepStrictEqual([el.style.transform, el.style.clipPath], [`translateY(${WRAPPER_PX - ROW_PX}px)`, `inset(0px 0 ${3 * ROW_PX}px 0)`]);
    m.show(['', '', '', '  spinner']);
    m.write();
    assert.deepStrictEqual([el.style.transform, el.style.clipPath], [`translateY(${WRAPPER_PX - 4 * ROW_PX}px)`, `inset(${3 * ROW_PX}px 0 0px 0)`]);
  } finally { m.view.dispose(); m.restore(); }
});

test('a terminal scrolled up while the sheet shows snaps back to the bottom', async () => {
  const m = await mountSheet(PICKER);
  try {
    let snaps = 0;
    m.terminal.scrollToBottom = () => { snaps += 1; };
    assert.strictEqual(m.wrapper.classList.contains('live-sheet'), true);
    m.terminal.buffer.active.viewportY = -1;
    m.scroll();
    assert.strictEqual(snaps, 1);
  } finally { m.view.dispose(); m.restore(); }
});

const MENU_DIR = path.join(__dirname, 'fixtures', 'menu-states');
function menuFixture(name) {
  const rows = fs.readFileSync(path.join(MENU_DIR, `${name}.screen.txt`), 'utf8').replace(/\n$/, '').split('\n');
  const cells = JSON.parse(fs.readFileSync(path.join(MENU_DIR, `${name}.cells.json`), 'utf8'));
  return { rows, cells };
}

async function mountMenu(name, platform, extra = {}) {
  const menuMirror = createMenuMirror();
  const composerEl = fakeComposer();
  let t = 5000;
  const m = mountView({ platform: () => platform, menuMirror, composerEl, now: () => t, ...extra }, { geometry: true });
  const { rows, cells } = menuFixture(name);
  Object.assign(m.terminal, { rows: rows.length, cols: 100 });
  m.show(rows, cells);
  const menuEl = m.appended.find((el) => el.className === 'seat-slash-menu seat-slash-menu-pty');
  const enter = async () => {
    m.write();
    await settle();
    t += 250;
    m.write();
    assert.deepStrictEqual([m.view.state().mode, m.view.composerVisible()], ['split', true]);
    m.write();
  };
  return { ...m, menuMirror, menuEl, composerEl, enter };
}

const itemsOf = (el) => el.childNodes.map((row) => [row.className, ...row.childNodes.map((span) => [span.className, span.childNodes.map((n) => (n.tag === 'b' ? `<b>${textOf(n)}</b>` : n.data)).join('')])]);

test('while the mirror is ON each evaluate reads the CLI menu into the slash list, selected row active, matches bold', async () => {
  const m = await mountMenu('claude-one-char@100', 'claude');
  try {
    m.menuMirror.draft('/c');
    await m.enter();
    assert.strictEqual(m.menuEl.hidden, false);
    assert.strictEqual(m.menuMirror.hasRows(), true);
    const items = itemsOf(m.menuEl);
    assert.strictEqual(items.length, 14);
    assert.deepStrictEqual(items[0], ['seat-slash-item active', ['seat-slash-name', '/<b>c</b>d'], ['seat-slash-desc', 'Move this session to a new working dire<b>c</b>tory']]);
    assert.strictEqual(items.filter((r) => r[0] === 'seat-slash-item active').length, 1);
    assert.strictEqual(m.menuEl.style.bottom, `${COMPOSER_PX + 8}px`);
  } finally { m.view.dispose(); m.restore(); }
});

test('a claude menu with no selected row renders no active row', async () => {
  const m = await mountMenu('claude-three-chars@100', 'claude');
  try {
    m.menuMirror.draft('/clo');
    await m.enter();
    const items = itemsOf(m.menuEl);
    assert.strictEqual(items.length, 7);
    assert.deepStrictEqual(items.filter((r) => r[0] !== 'seat-slash-item'), []);
  } finally { m.view.dispose(); m.restore(); }
});

test('a codex menu reads with its selected row active and no description spans on it', async () => {
  const m = await mountMenu('codex-arrow-down@100', 'codex');
  try {
    m.menuMirror.draft('/co');
    await m.enter();
    assert.deepStrictEqual(itemsOf(m.menuEl), [
      ['seat-slash-item', ['seat-slash-name', '/<b>co</b>mpact'], ['seat-slash-desc', 'summarize conversation to prevent hitting the context limit']],
      ['seat-slash-item active', ['seat-slash-name', '/copy'], ['seat-slash-desc', 'copy the last response or part of it']],
    ]);
  } finally { m.view.dispose(); m.restore(); }
});

test('a null read hides and empties the list; mode OFF hides and empties it', async () => {
  const m = await mountMenu('claude-one-char@100', 'claude');
  try {
    m.menuMirror.draft('/c');
    await m.enter();
    assert.strictEqual(m.menuEl.hidden, false);
    m.show(menuFixture('claude-escape@100').rows, menuFixture('claude-escape@100').cells);
    m.write();
    assert.deepStrictEqual([m.menuEl.hidden, m.menuEl.childNodes.length, m.menuMirror.read()], [true, 0, null]);
    m.show(menuFixture('claude-one-char@100').rows, menuFixture('claude-one-char@100').cells);
    m.write();
    assert.strictEqual(m.menuEl.hidden, false);
    m.menuMirror.draft('/c ');
    m.view.refresh();
    assert.deepStrictEqual([m.menuEl.hidden, m.menuEl.childNodes.length], [true, 0]);
  } finally { m.view.dispose(); m.restore(); }
});

test('with the mirror OFF the menu on screen is not read', async () => {
  const m = await mountMenu('claude-one-char@100', 'claude');
  try {
    m.write();
    await settle();
    assert.deepStrictEqual([m.menuEl.hidden, m.menuMirror.read()], [true, null]);
  } finally { m.view.dispose(); m.restore(); }
});

test('with the mirror ON a full state does not read the menu: the list stays hidden and the sheet shows', async () => {
  const m = await mountMenu('claude-one-char@100', 'claude', { sheet: true });
  try {
    m.menuMirror.draft('/c');
    m.write();
    await settle();
    assert.strictEqual(m.view.state().mode, 'full');
    assert.deepStrictEqual([m.menuEl.hidden, m.menuEl.childNodes.length, m.menuMirror.read()], [true, 0, null]);
    assert.strictEqual(m.wrapper.classList.contains('live-sheet'), true);
  } finally { m.view.dispose(); m.restore(); }
});

test('raw mode hides and empties the list while the mirror is ON and the menu is on screen', async () => {
  const m = await mountMenu('claude-one-char@100', 'claude');
  try {
    m.menuMirror.draft('/c');
    await m.enter();
    assert.strictEqual(m.menuEl.hidden, false);
    m.view.setRaw(true);
    assert.deepStrictEqual([m.menuEl.hidden, m.menuEl.childNodes.length, m.menuMirror.read()], [true, 0, null]);
    m.write();
    assert.deepStrictEqual([m.menuEl.hidden, m.menuEl.childNodes.length, m.menuMirror.read()], [true, 0, null]);
  } finally { m.view.dispose(); m.restore(); }
});

test('the pty slash rows carry the default cursor, not the pointer the composer list uses', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /\.seat-slash-menu-pty \.seat-slash-item \{\s*cursor: default;\s*\}/u);
});

test('the same menu screen with the mirror OFF shows the sheet before the settle tick', async () => {
  const m = await mountMenu('claude-one-char@100', 'claude', { sheet: true });
  try {
    m.write();
    await settle();
    assert.strictEqual(m.wrapper.classList.contains('live-sheet'), true);
  } finally { m.view.dispose(); m.restore(); }
});

test('dispose removes the slash list', async () => {
  const m = await mountMenu('claude-one-char@100', 'claude');
  let removed = 0;
  m.menuEl.remove = () => { removed += 1; };
  m.view.dispose();
  m.restore();
  assert.strictEqual(removed, 1);
});

test('ENTER: the web UI differs from the desktop only where the browser cannot, so the pane gate names peer and not __CLODEX_WEB__', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const gate = src.match(/const splitOn = ([^;]*);/u);
  assert.ok(gate, 'renderer.js declares the splitOn gate');
  assert.match(gate[1], /\bpeer\b/u);
  assert.doesNotMatch(gate[1], /__CLODEX_WEB__/u);
});

const { PAINT_BLOCK_CAP, createPaintDelta, mergeByTs, blockText } = require('../renderer/lib/paint-delta');

test('paint delta: the first feed is a baseline and a scrolled screen returns only the rows after the overlap', () => {
  const d = createPaintDelta();
  assert.deepStrictEqual(d.feed(['a', 'b', 'c']), []);
  assert.deepStrictEqual(d.feed(['b', 'c', 'd', 'e']), ['d', 'e']);
  assert.deepStrictEqual(d.feed(['b', 'c', 'd', 'e', '', 'f']), ['', 'f']);
});

test('paint delta: a redraw of the same screen, or a shrink of the region, returns nothing', () => {
  const d = createPaintDelta();
  d.feed(['a', 'b', 'c', '']);
  assert.deepStrictEqual(d.feed(['a', 'b', 'c   ', '', '']), []);
  assert.deepStrictEqual(d.feed(['a', 'b']), []);
});

test('paint delta: a cleared screen returns nothing, then its new rows are all new; reset makes the next feed a baseline', () => {
  const d = createPaintDelta();
  d.feed(['a', 'b']);
  assert.deepStrictEqual(d.feed(['', '', '']), []);
  assert.deepStrictEqual(d.feed(['x', '', 'y']), ['x', 'y']);
  d.reset();
  assert.deepStrictEqual(d.feed(['p', 'q']), []);
});

test('paint merge orders by ts, keeps file order on ties and keeps untimed file records in place', () => {
  const f = [{ id: 'a', ts: null }, { id: 'b', ts: 10 }, { id: 'c', ts: 30 }];
  const x = [{ id: 'x', ts: 10 }, { id: 'y', ts: 20 }, { id: 'z', ts: 40 }];
  assert.deepStrictEqual(mergeByTs(f, x).map((r) => r.id), ['a', 'b', 'x', 'y', 'c', 'z']);
});

test(`a paint block over ${PAINT_BLOCK_CAP} rows keeps the last ${PAINT_BLOCK_CAP} behind an ellipsis`, () => {
  const rows = Array.from({ length: PAINT_BLOCK_CAP + 5 }, (_, i) => `r${i}`);
  const lines = blockText(rows, []).split('\n');
  assert.deepStrictEqual([lines.length, lines[0], lines[1], lines[PAINT_BLOCK_CAP]], [PAINT_BLOCK_CAP + 1, '…', 'r5', `r${PAINT_BLOCK_CAP + 4}`]);
});

const CARD = ['╭ status', '│ model  gpt', '│ dir    /x', '│ perms  ro', '│ limit  82%', '╰────────'];
const PAINT_ROWS = 14;
const codexScreen = (history) => {
  const strip = ['› Ask Codex to do anything', '', '  Context 0% used · gpt'];
  const top = [...history, ''];
  return [...Array(Math.max(0, PAINT_ROWS - strip.length - top.length)).fill(''), ...top, ...strip].slice(-PAINT_ROWS);
};
const LRULE = `── Voice input ${'─'.repeat(25)}`;
const museScreen = (history) => [...history, ...Array(PAINT_ROWS - 4 - history.length).fill(''), LRULE, '❯ ', '─'.repeat(40), '  muse-spark · max'];

async function mountPaint(platform, before, rows = PAINT_ROWS, cols = 40, extra = {}) {
  mock.timers.enable({ apis: ['setTimeout'] });
  let t = 5000;
  const composerEl = fakeComposer();
  const m = mountView({ composerEl, now: () => t, platform: () => platform, ...extra }, { geometry: true });
  Object.assign(m.terminal, { rows, cols, element: fakeTermElement(rows) });
  m.terminal.buffer.active.cursorY = before.findIndex((r) => /^[›❯]/u.test(r));
  m.show(before);
  m.write();
  await settle();
  t += 250;
  m.write();
  m.write();
  const outputs = () => m.pane.childNodes.flatMap((turn) => turn.childNodes).filter((n) => /tr-output|tr-command/u.test(n.className)).map((n) => (/tr-command/u.test(n.className) ? n.childNodes[0].textContent : n.textContent));
  const paintNext = (rows) => {
    m.terminal.buffer.active.cursorY = rows.findIndex((r) => /^[›❯] /u.test(r) && !r.includes('/status'));
    m.show(rows);
    m.write();
    mock.timers.tick(250);
  };
  return { ...m, composerEl, outputs, paintNext, tick: (ms) => { t += ms; }, done: () => { m.view.dispose(); m.restore(); mock.timers.reset(); } };
}

test('a codex /status card painted above the composer becomes one command-output row tagged /status, the echo dropped', async () => {
  const m = await mountPaint('codex', codexScreen(['  banner 1', '  banner 2']));
  try {
    assert.deepStrictEqual([m.view.state().mode, m.view.composerVisible()], ['split', true]);
    m.view.composerSent('/status');
    m.paintNext(codexScreen(['  banner 2', '', '/status', '', ...CARD]));
    assert.deepStrictEqual(m.outputs(), ['❯ /status', CARD.join('\n')]);
  } finally { m.done(); }
});

test('a codex echo row with the › mark is dropped from the block too', async () => {
  const m = await mountPaint('codex', codexScreen(['  banner 1']));
  try {
    m.view.composerSent('/status');
    m.paintNext(codexScreen(['  banner 1', '› /status', ...CARD]));
    assert.deepStrictEqual(m.outputs(), ['❯ /status', CARD.join('\n')]);
  } finally { m.done(); }
});

test('a muse /status card painted above the labeled rule becomes one command-output row tagged /status', async () => {
  const m = await mountPaint('muse', museScreen(['  Muse Code 1.4.0']));
  try {
    assert.deepStrictEqual([m.view.state().mode, m.view.composerVisible()], ['split', true]);
    m.view.composerSent('/status');
    m.paintNext(museScreen(['  Muse Code 1.4.0', '', ...CARD]));
    assert.deepStrictEqual(m.outputs(), ['❯ /status', CARD.join('\n')]);
  } finally { m.done(); }
});

test('rows painted while the view was raw are a new baseline, not command output', async () => {
  const m = await mountPaint('codex', codexScreen(['  banner 1']));
  try {
    m.view.setRaw(true);
    m.show(codexScreen(['  banner 1', '› hello', ...CARD]));
    m.write();
    m.view.setRaw(false);
    await settle();
    m.tick(250);
    m.write();
    m.write();
    m.paintNext(codexScreen(['  banner 1', '› hello', ...CARD]));
    assert.deepStrictEqual([m.view.state().mode, m.view.composerVisible()], ['split', true]);
    assert.deepStrictEqual(m.outputs(), []);
  } finally { m.done(); }
});

test('a paint header whose command the file records after the settle is dropped on the next pull', async () => {
  let recorded = false;
  let rev = 0;
  const pullTranscript = () => ({ ok: true, rev: (rev += 1), records: recorded ? [{ ...HEAD, ts: 1000 }, { id: 'c1', kind: 'command', ts: 5240, turn: 2, name: '/usage', args: '' }] : [{ ...HEAD, ts: 1000 }] });
  const m = await mountPaint('muse', museScreen(['  Muse Code 1.4.0']), PAINT_ROWS, 40, { pullTranscript });
  try {
    m.view.composerSent('/usage');
    m.paintNext(museScreen(['  Muse Code 1.4.0', '', ...CARD]));
    assert.deepStrictEqual(m.outputs(), ['❯ /usage', CARD.join('\n')]);
    recorded = true;
    m.change('s1');
    await settle();
    assert.deepStrictEqual(m.outputs(), ['❯ /usage', CARD.join('\n')]);
  } finally { m.done(); }
});

test('ENTER: an Enter the menu mirror handles forwards the command it submits to the split view', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const at = src.indexOf('const onMenuKey = ');
  const body = src.slice(at, src.indexOf('const composerKit = ', at));
  assert.match(body, /if \(hit\.command && liveSplit\) liveSplit\.composerSent\(hit\.command\);/u);
});

test('a paint block with no slash command sent in the last 10s is emitted untagged', async () => {
  const m = await mountPaint('codex', codexScreen(['  banner 1']));
  try {
    m.view.composerSent('/status');
    m.tick(10001);
    m.paintNext(codexScreen(['  banner 1', ...CARD]));
    assert.deepStrictEqual(m.outputs(), [CARD.join('\n')]);
  } finally { m.done(); }
});

test('rows painted while the codex turn is running are never collected', async () => {
  const m = await mountPaint('codex', codexScreen(['  banner 1', '• Working (1s • esc to interrupt)']));
  try {
    m.paintNext(codexScreen(['  banner 1', ...CARD, '• Working (2s • esc to interrupt)']));
    m.paintNext(codexScreen(['  banner 1', ...CARD, 'done']));
    assert.deepStrictEqual(m.outputs(), []);
  } finally { m.done(); }
});

test('a claude seat never feeds the paint delta: new rows above its anchor add no row', async () => {
  const m = await mountPaint('claude', ['  banner', ...Array(8).fill(''), RULE_ROW + '─'.repeat(20), '❯ ', '']);
  try {
    assert.deepStrictEqual([m.view.state().mode, m.view.composerVisible()], ['split', true]);
    m.view.composerSent('/status');
    m.paintNext(['  banner', '', ...CARD, '', RULE_ROW + '─'.repeat(20), '❯ ', '']);
    assert.deepStrictEqual(m.outputs(), []);
  } finally { m.done(); }
});

for (const cli of ['codex', 'muse']) {
  test(`the captured ${cli} /status screens yield the card as one tagged command-output row`, async () => {
    const screen = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'split-states', `${cli}-${name}@100.screen.txt`), 'utf8').split('\n').slice(0, 30);
    const before = screen('typed-status');
    const after = screen('after-status');
    const m = await mountPaint(cli, before, 30, 100);
    try {
      assert.deepStrictEqual([m.view.state().mode, m.view.composerVisible()], ['split', true]);
      m.view.composerSent('/status');
      m.paintNext(after);
      const [head, body] = m.outputs();
      assert.strictEqual(head, '❯ /status');
      const lines = body.split('\n');
      assert.match(lines[0], /^[╭┌]─+[╮┐]$/u);
      assert.ok(!lines.some((l) => l.trim() === '/status' || /Model set to|directory:/u.test(l)));
      assert.match(lines.join('\n'), cli === 'codex' ? /Weekly limit/u : /BILLING/u);
    } finally { m.done(); }
  });
}

test('the echo drop only strips the block\'s leading rows, so a later output line equal to the command stays', () => {
  assert.strictEqual(blockText(['', '› /status', '/status', 'a', '/status'], ['/status']), 'a\n/status');
});

test('output painted before the file has a timed record survives the first prompt; a later file start prunes it', async () => {
  let records = [];
  let rev = 0;
  const pullTranscript = () => ({ ok: true, rev: (rev += 1), records });
  const m = await mountPaint('muse', museScreen(['  Muse Code 1.4.0']), PAINT_ROWS, 40, { pullTranscript });
  try {
    m.view.composerSent('/status');
    m.paintNext(museScreen(['  Muse Code 1.4.0', '', ...CARD]));
    assert.deepStrictEqual(m.outputs(), ['❯ /status', CARD.join('\n')]);
    records = [{ ...HEAD, ts: 9000 }];
    m.change('s1');
    await settle();
    assert.deepStrictEqual(m.outputs(), ['❯ /status', CARD.join('\n')]);
    records = [{ ...HEAD, id: 'p2', ts: 9500 }];
    m.change('s1');
    await settle();
    assert.deepStrictEqual(m.outputs(), []);
  } finally { m.done(); }
});

test('a codex turn with a follow-up queued under its status row is still busy', async () => {
  const m = await mountPaint('codex', codexScreen(['  banner 1', '• Working (1s • esc to interrupt)', '', '  ↳ queued: and then run the tests', '    ⌥ + ↑ edit']));
  try {
    m.paintNext(codexScreen(['  banner 1', ...CARD, '• Working (2s • esc to interrupt)', '', '  ↳ queued: and then run the tests', '    ⌥ + ↑ edit']));
    assert.deepStrictEqual(m.outputs(), []);
  } finally { m.done(); }
});

test('a picker that hides the composer clears the pending tag, so a later block is untagged', async () => {
  const m = await mountPaint('codex', codexScreen(['  banner 1']));
  try {
    m.view.composerSent('/model');
    m.view.setRaw(true);
    m.view.setRaw(false);
    await settle();
    m.tick(250);
    m.write();
    m.write();
    m.paintNext(codexScreen(['  banner 1', ...CARD]));
    assert.deepStrictEqual(m.outputs(), [CARD.join('\n')]);
  } finally { m.done(); }
});

test('the transcript bar renders the chips slot, then Conversation, Internals, ? and Screen; Conversation reports through onMode and hides the tool block; refresh follows the mode getter', async () => {
  let current = 'internals';
  const reported = [];
  const m = await mountSplit(undefined, { mode: () => current, onMode: (next) => reported.push(next), onHelp: () => {} });
  try {
    const bar = m.pane.childNodes.find((n) => n.className === 'transcript-bar');
    assert.deepStrictEqual(bar.childNodes.map((n) => n.className), ['transcript-bar-chips', 'transcript-bar-views']);
    const views = bar.childNodes[1];
    assert.deepStrictEqual(views.childNodes.map((n) => [n.className, textOf(n), n.title]), [
      ['transcript-mode', 'ConversationInternals', ''],
      ['transcript-help-btn', '?', 'Clodex at a glance'],
      ['transcript-mode-btn transcript-terminal-btn', 'Screen', 'Show the CLI\'s own screen (⌘⇧T)'],
    ]);
    const [conv, internals] = views.childNodes[0].childNodes;
    const block = () => m.pane.childNodes.find((n) => /\btr-turn\b/.test(n.className)).childNodes.find((n) => /\btr-tool-block\b/.test(n.className));
    assert.ok(!/\btr-hidden\b/.test(block().className));
    conv.listeners.click();
    assert.deepStrictEqual(reported, ['conversation']);
    assert.ok(/\btr-hidden\b/.test(block().className));
    internals.listeners.click();
    current = 'conversation';
    m.view.refresh();
    assert.strictEqual(conv.getAttribute('aria-pressed'), 'true');
    assert.ok(/\btr-hidden\b/.test(block().className));
    current = 'internals';
    m.view.refresh();
    assert.strictEqual(internals.getAttribute('aria-pressed'), 'true');
    assert.ok(!/\btr-hidden\b/.test(block().className));
  } finally { m.view.dispose(); m.restore(); }
});

const STATUS_DIR = path.join(__dirname, 'fixtures', 'status-states');
const STATUS_CURSOR = { 'claude-bypass@100': 6, 'claude-shell@100': 16, 'codex-plan@100': 13, 'codex-default@100': 13, 'muse-auto-review@100': 7 };
const statusRowsOf = (name) => fs.readFileSync(path.join(STATUS_DIR, `${name}.screen.txt`), 'utf8').replace(/\n$/, '').split('\n');
const barOf = (m) => m.pane.childNodes.find((n) => n.className === 'transcript-bar');
const stripOf = (m) => barOf(m).childNodes.find((n) => n.className === 'transcript-bar-chips');
const chips = (m) => stripOf(m).childNodes.map((c) => [c.tagName || c.tag, c.dataset.chip, textOf(c)]);
const chipOf = (m, kind) => stripOf(m).childNodes.find((c) => c.dataset.chip === kind);
const fakeEvent = () => { const e = { prevented: 0 }; e.preventDefault = () => { e.prevented += 1; }; return e; };

function mountStatus(name, platform, { effort = null, posture = null, ...extra } = {}) {
  const writes = [];
  const box = { level: effort, posture };
  const composerEl = fakeComposer();
  let t = 5000;
  const m = mountView({ platform: () => platform, composerEl, now: () => t, statusChips: { write: (d) => writes.push(d), effort: () => box.level, posture: () => box.posture }, ...extra }, { geometry: true });
  const rows = statusRowsOf(name);
  Object.assign(m.terminal, { rows: rows.length, cols: 100 });
  m.terminal.buffer.active.cursorY = STATUS_CURSOR[name];
  m.show(rows);
  const strip = stripOf(m);
  strip.contains = (el) => strip.childNodes.includes(el);
  const enter = async () => {
    m.write();
    await settle();
    t += 250;
    m.write();
    assert.deepStrictEqual([m.view.state().mode, m.view.composerVisible()], ['split', true]);
  };
  return { ...m, rows, writes, box, composerEl, strip, enter, advance: (ms) => { t += ms; } };
}

test('the chips slot sits first in the transcript bar, hidden at construction, and no status strip row exists under the composer', () => {
  const m = mountStatus('claude-bypass@100', 'claude');
  try {
    assert.strictEqual(stripOf(m).hidden, true);
    assert.strictEqual(barOf(m).childNodes[0], stripOf(m));
    assert.strictEqual(m.wrapperEl.querySelector('.seat-status-strip'), null);
    assert.strictEqual(m.wrapperEl.querySelector('.transcript-bar-chips'), stripOf(m));
  } finally { m.view.dispose(); m.restore(); }
});

test('the chips render inside .transcript-bar-chips in split and the pane sizes above the composer alone', async () => {
  const m = mountStatus('claude-bypass@100', 'claude');
  try {
    await m.enter();
    assert.strictEqual(stripOf(m).hidden, false);
    assert.deepStrictEqual(stripOf(m).childNodes.map((c) => c.dataset.chip), ['mode']);
    assert.strictEqual(m.wrapperEl.querySelector('.seat-status-strip'), null);
    assert.strictEqual(m.pane.clientHeight, WRAPPER_PX - COMPOSER_PX);
  } finally { m.view.dispose(); m.restore(); }
});

test('raw hides the chips with the composer', async () => {
  const m = mountStatus('claude-bypass@100', 'claude');
  try {
    await m.enter();
    assert.strictEqual(stripOf(m).hidden, false);
    m.view.setRaw(true);
    assert.strictEqual(stripOf(m).hidden, true);
    assert.strictEqual(m.composerEl.hidden, true);
  } finally { m.view.dispose(); m.restore(); }
});

const CHIP_SCREENS = [
  { name: 'claude-bypass@100', platform: 'claude', effort: null, enter: (rows) => assert.strictEqual(rows[9], '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'),
    expected: [['button', 'mode', 'Bypass']], modeTone: 'danger' },
  { name: 'claude-shell@100', platform: 'claude', effort: 'xhigh', enter: (rows) => assert.strictEqual(rows[19].trimEnd(), '  ⏵⏵ bypass permissions on · 1 shell · ← for agents'),
    expected: [['button', 'mode', 'Bypass'], ['span', 'tasks', '1 shell'], ['span', 'effort', 'xhigh']], modeTone: 'danger' },
  { name: 'codex-plan@100', platform: 'codex', effort: 'high', enter: (rows) => assert.ok(rows[15].includes('Plan mode    ⚠ 3 warnings'), rows[15]),
    expected: [['button', 'mode', 'Plan'], ['button', 'warnings', '⚠ 3'], ['span', 'effort', 'high']], modeTone: 'info' },
  { name: 'muse-auto-review@100', platform: 'muse', effort: null, enter: (rows) => assert.ok(rows[9].trimEnd().endsWith('· Auto-review'), rows[9]),
    expected: [['span', 'mode', 'Auto-review']], modeTone: 'muted' },
];

for (const c of CHIP_SCREENS) {
  test(`${c.name} renders the chips ${JSON.stringify(c.expected)} with effort ${c.effort}`, async () => {
    const m = mountStatus(c.name, c.platform, { effort: c.effort });
    try {
      assert.strictEqual(m.rows.length, 40);
      c.enter(m.rows);
      await m.enter();
      assert.deepStrictEqual(chips(m), c.expected);
      assert.strictEqual(chipOf(m, 'mode').dataset.tone, c.modeTone);
    } finally { m.view.dispose(); m.restore(); }
  });
}

test('an effort level of null or default renders no effort chip', async () => {
  const m = mountStatus('claude-bypass@100', 'claude');
  try {
    await m.enter();
    assert.ok(chipOf(m, 'mode'));
    const noEffort = () => {
      assert.strictEqual(chipOf(m, 'effort'), undefined);
      assert.strictEqual(stripOf(m).childNodes.some((n) => textOf(n) === 'default'), false);
    };
    noEffort();
    m.box.level = 'default';
    m.view.refreshStatus();
    noEffort();
  } finally { m.view.dispose(); m.restore(); }
});

const CODEX_APPROVALS = (posture) => `Approvals: ${posture}, set at launch. Collaboration mode — click to toggle Plan (shift+tab in the terminal)`;
const FOLDED = [
  { platform: 'codex', posture: 'bypass', screen: 'codex-plan@100', chips: [['mode', 'Bypass · Plan'], ['warnings', '⚠ 3']], tone: 'danger', title: CODEX_APPROVALS('Bypass') },
  { platform: 'codex', posture: 'bypass', screen: 'codex-default@100', chips: [['mode', 'Bypass'], ['warnings', '⚠ 3']], tone: 'danger', title: CODEX_APPROVALS('Bypass') },
  { platform: 'codex', posture: 'read-only', screen: 'codex-plan@100', chips: [['mode', 'Read-only · Plan'], ['warnings', '⚠ 3']], tone: 'info', title: CODEX_APPROVALS('Read-only') },
  { platform: 'codex', posture: null, screen: 'codex-default@100', chips: [['mode', 'Default'], ['warnings', '⚠ 3']], tone: 'muted', title: 'Collaboration mode — click to toggle Plan (shift+tab in the terminal)' },
  { platform: 'claude', posture: 'bypass', screen: 'claude-bypass@100', chips: [['mode', 'Bypass']], tone: 'danger', title: 'Permission mode — click to cycle (shift+tab in the terminal)' },
  { platform: 'muse', posture: 'bypass', screen: 'muse-auto-review@100', chips: [['mode', 'Auto-review']], tone: 'muted', title: 'Approval posture (set at launch)' },
];
const kindText = (m) => stripOf(m).childNodes.map((c) => [c.dataset.chip, textOf(c)]);

for (const c of FOLDED) {
  test(`(${c.platform}, posture ${c.posture}, ${c.screen}) renders exactly ${JSON.stringify(c.chips)}`, async () => {
    const m = mountStatus(c.screen, c.platform, { posture: c.posture });
    try {
      await m.enter();
      assert.deepStrictEqual(kindText(m), c.chips);
      assert.deepStrictEqual([chipOf(m, 'mode').dataset.tone, chipOf(m, 'mode').title], [c.tone, c.title]);
    } finally { m.view.dispose(); m.restore(); }
  });
}

test('refreshStatus folds the posture into the mode chip once it arrives, without a pty write', async () => {
  const m = mountStatus('codex-plan@100', 'codex');
  try {
    await m.enter();
    assert.deepStrictEqual(kindText(m), [['mode', 'Plan'], ['warnings', '⚠ 3']]);
    m.box.posture = 'bypass';
    m.view.refreshStatus();
    assert.deepStrictEqual(kindText(m), [['mode', 'Bypass · Plan'], ['warnings', '⚠ 3']]);
    assert.deepStrictEqual(m.writes, []);
  } finally { m.view.dispose(); m.restore(); }
});

test('refreshStatus re-renders a changed effort level without a pty write or a screen evaluate', async () => {
  const m = mountStatus('claude-bypass@100', 'claude', { effort: 'high' });
  try {
    await m.enter();
    assert.deepStrictEqual(chips(m), [['button', 'mode', 'Bypass'], ['span', 'effort', 'high']]);
    const pulls = m.calls.pull;
    const buf = m.terminal.buffer.active;
    const getLine = buf.getLine;
    let lineReads = 0;
    buf.getLine = (i) => { lineReads += 1; return getLine(i); };
    m.box.level = 'xhigh';
    m.view.refreshStatus();
    assert.deepStrictEqual(chips(m), [['button', 'mode', 'Bypass'], ['span', 'effort', 'xhigh']]);
    assert.deepStrictEqual(m.writes, []);
    assert.strictEqual(m.calls.pull, pulls);
    assert.strictEqual(lineReads, 0);
    m.box.level = null;
    m.view.refreshStatus();
    assert.deepStrictEqual(chips(m), [['button', 'mode', 'Bypass']]);
  } finally { m.view.dispose(); m.restore(); }
});

test('the mode chip title follows the platform, not the label casing', () => {
  const read = { mode: { key: 'plan', label: 'Plan', cycles: true } };
  const titleFor = (platform) => {
    const el = fakeDoc().createElement('div');
    renderStatusChips(fakeDoc(), el, read, null, () => {}, platform);
    return el.childNodes[0].title;
  };
  assert.strictEqual(titleFor('codex'), 'Collaboration mode — click to toggle Plan (shift+tab in the terminal)');
  assert.strictEqual(titleFor('claude'), 'Permission mode — click to cycle (shift+tab in the terminal)');
});

test('a slash menu frame holds the screen chips but still refreshes the effort chip', async () => {
  const menuMirror = createMenuMirror();
  const m = mountStatus('claude-bypass@100', 'claude', { effort: 'high', menuMirror });
  try {
    await m.enter();
    assert.deepStrictEqual(chips(m), [['button', 'mode', 'Bypass'], ['span', 'effort', 'high']]);
    menuMirror.draft('/c');
    const f = menuFixture('claude-one-char@100');
    m.show(f.rows, f.cells);
    assert.strictEqual(menuMirror.on(), true);
    m.box.level = 'xhigh';
    m.write();
    assert.deepStrictEqual(chips(m), [['button', 'mode', 'Bypass'], ['span', 'effort', 'xhigh']]);
  } finally { m.view.dispose(); m.restore(); }
});

test('a split frame whose status rows read nothing holds the last chips', async () => {
  const { readStatusRows } = require('../renderer/lib/status-rows');
  const m = mountStatus('claude-bypass@100', 'claude');
  try {
    await m.enter();
    assert.deepStrictEqual(chips(m), [['button', 'mode', 'Bypass']]);
    const blank = m.rows.map((r, i) => (i === 8 || i === 9 ? '' : r));
    assert.strictEqual(readStatusRows(blank, 5, 'claude'), null);
    m.show(blank);
    m.write();
    assert.strictEqual(m.view.state().mode, 'split');
    assert.deepStrictEqual(chips(m), [['button', 'mode', 'Bypass']]);
  } finally { m.view.dispose(); m.restore(); }
});

test('the same screen written again keeps the chip nodes', async () => {
  const m = mountStatus('claude-bypass@100', 'claude');
  try {
    await m.enter();
    const node = chipOf(m, 'mode');
    assert.ok(node);
    m.write();
    assert.strictEqual(stripOf(m).childNodes[0], node);
  } finally { m.view.dispose(); m.restore(); }
});

const enterChip = (m, kind) => {
  assert.strictEqual(m.view.state().mode, 'split');
  assert.strictEqual(stripOf(m).hidden, false);
  const chip = chipOf(m, kind);
  assert.ok(chip, kind);
  return chip;
};

test('a claude mode chip click writes shift+tab and its mousedown keeps focus where it was', async () => {
  const m = mountStatus('claude-bypass@100', 'claude');
  try {
    await m.enter();
    const chip = enterChip(m, 'mode');
    const e = fakeEvent();
    chip.listeners.mousedown(e);
    assert.strictEqual(e.prevented, 1);
    chip.listeners.click();
    assert.deepStrictEqual(m.writes, ['\x1b[Z']);
  } finally { m.view.dispose(); m.restore(); }
});

test('a codex warnings chip click writes F2', async () => {
  const m = mountStatus('codex-plan@100', 'codex');
  try {
    await m.enter();
    const chip = enterChip(m, 'warnings');
    const e = fakeEvent();
    chip.listeners.mousedown(e);
    assert.strictEqual(e.prevented, 1);
    chip.listeners.click();
    assert.deepStrictEqual(m.writes, ['\x1bOQ']);
  } finally { m.view.dispose(); m.restore(); }
});

test('a mode chip click with the slash mirror on writes nothing', async () => {
  const menuMirror = createMenuMirror();
  const m = mountStatus('claude-bypass@100', 'claude', { menuMirror });
  try {
    await m.enter();
    const chip = enterChip(m, 'mode');
    menuMirror.draft('/c');
    assert.strictEqual(menuMirror.on(), true);
    chip.listeners.click();
    assert.deepStrictEqual(m.writes, []);
  } finally { m.view.dispose(); m.restore(); }
});

test('a muse mode chip is a span with no click listener', async () => {
  const m = mountStatus('muse-auto-review@100', 'muse');
  try {
    await m.enter();
    const chip = enterChip(m, 'mode');
    assert.strictEqual(chip.tag, 'span');
    assert.strictEqual(chip.listeners.click, undefined);
    assert.deepStrictEqual(m.writes, []);
  } finally { m.view.dispose(); m.restore(); }
});

async function mountFocus() {
  const m = mountStatus('codex-plan@100', 'codex');
  const focus = { term: 0 };
  m.terminal.textarea = { tag: 'xterm-helper' };
  m.terminal.focus = () => { focus.term += 1; global.document.activeElement = m.terminal.textarea; };
  await m.enter();
  return { ...m, focus };
}

test('a keyboard F2 from the warnings chip hands focus to the terminal and the return hands it to the composer', async () => {
  const m = await mountFocus();
  try {
    const chip = enterChip(m, 'warnings');
    assert.strictEqual(chip.tag, 'button');
    global.document.activeElement = chip;
    chip.listeners.click();
    assert.deepStrictEqual(m.writes, ['\x1bOQ']);
    const overlayRows = statusRowsOf('codex-warnings-overlay@100');
    assert.strictEqual(overlayRows.length, 40);
    assert.strictEqual(overlayRows[12].trimEnd(), '  Warnings · 1 of 3 · Startup');
    m.show(overlayRows);
    m.terminal.buffer.active.cursorY = 23;
    m.write();
    m.advance(50);
    m.write();
    assert.strictEqual(m.view.state().mode, 'full');
    assert.strictEqual(stripOf(m).hidden, true);
    assert.strictEqual(m.focus.term, 1);
    assert.strictEqual(global.document.activeElement, m.terminal.textarea);
    m.show(m.rows);
    m.terminal.buffer.active.cursorY = 13;
    m.write();
    await settle();
    m.advance(250);
    m.write();
    assert.strictEqual(m.view.state().mode, 'split');
    assert.strictEqual(stripOf(m).hidden, false);
    assert.strictEqual(m.composerEl.focused, 1);
    assert.strictEqual(global.document.activeElement, m.composerEl);
  } finally { m.view.dispose(); m.restore(); }
});

test('hiding the strip leaves focus outside the composer and the strip where it was', async () => {
  const m = await mountFocus();
  try {
    assert.strictEqual(stripOf(m).hidden, false);
    const sidebar = { tag: 'sidebar-input' };
    global.document.activeElement = sidebar;
    m.view.setRaw(true);
    assert.strictEqual(m.focus.term, 0);
    assert.strictEqual(global.document.activeElement, sidebar);
  } finally { m.view.dispose(); m.restore(); }
});

test('the slash list sits above the composer', async () => {
  const m = await mountMenu('claude-one-char@100', 'claude', { statusChips: { write: () => {}, effort: () => null } });
  try {
    m.menuMirror.draft('/c');
    await m.enter();
    assert.strictEqual(m.menuMirror.on(), true);
    assert.strictEqual(m.menuEl.hidden, false);
    assert.strictEqual(itemsOf(m.menuEl).length, 14);
    assert.strictEqual(m.menuEl.style.bottom, `${COMPOSER_PX + 8}px`);
  } finally { m.view.dispose(); m.restore(); }
});

test('dispose removes the pane that holds the chips, and a later refreshStatus renders nothing', async () => {
  const m = mountStatus('claude-bypass@100', 'claude', { effort: 'high' });
  try {
    await m.enter();
    assert.ok(stripOf(m));
    let removed = 0;
    m.pane.remove = () => { removed += 1; };
    const before = chips(m);
    m.view.dispose();
    assert.strictEqual(removed, 1);
    m.box.level = 'xhigh';
    m.view.refreshStatus();
    assert.deepStrictEqual(chips(m), before);
  } finally { m.restore(); }
});

for (const [label, title] of [
  ['Conversation', 'Your messages and the agent\'s replies. Machine traffic folds to one line.'],
  ['Internals', 'Everything the seat did: tool calls, deliveries from Clodex and other seats, runtime notices.'],
]) {
  test(`the ${label} view button carries its tooltip`, () => {
    const doc = fakeDocument();
    const pane = doc.createElement('div');
    const btn = modeBar(doc, pane, 'conversation').buttons.find((b) => b.textContent === label);
    assert.ok(btn, label);
    assert.strictEqual(btn.title, title);
  });
}

const viewsOf = (m) => barOf(m).childNodes[1];
const modeButtons = (m) => viewsOf(m).childNodes[0].childNodes;
const terminalButton = (m) => viewsOf(m).childNodes.find((n) => /\btranscript-terminal-btn\b/.test(n.className));
const pressed = (m) => [...modeButtons(m), terminalButton(m)].map((b) => b.getAttribute('aria-pressed'));

test('the bar Screen toggle turns raw on, keeps the bar showing over an inset terminal, stops the pull, and turns it off again', async () => {
  const m = await mountSplit({ geometry: true });
  try {
    m.pane.offsetTop = 4;
    m.pane.offsetHeight = 24;
    const pulls = m.calls.pull;
    terminalButton(m).listeners.click();
    assert.strictEqual(m.view.raw(), true);
    assert.deepStrictEqual(pressed(m), ['false', 'false', 'true']);
    assert.deepStrictEqual([m.pane.hidden, m.pane.dataset.raw, m.wrapper.classList.contains('live-raw'), m.wrapper.style.paddingTop], [false, '1', true, '28px']);
    m.write();
    m.change('s1');
    await settle();
    assert.strictEqual(m.calls.pull, pulls);
    terminalButton(m).listeners.click();
    assert.strictEqual(m.view.raw(), false);
    assert.deepStrictEqual([m.pane.dataset.raw, m.wrapper.classList.contains('live-raw'), m.wrapper.style.paddingTop], [undefined, false, '']);
  } finally { m.view.dispose(); m.restore(); }
});

test('a seat put in Screen before its first write never pulls the transcript', async () => {
  const m = mountView({}, { geometry: true });
  try {
    m.view.setRaw(true);
    m.show(ANCHORED);
    m.write();
    m.change('s1');
    await settle();
    assert.strictEqual(m.calls.pull, 0);
  } finally { m.view.dispose(); m.restore(); }
});

async function mountSeat(view) {
  const entry = createSeatView(view);
  const m = await mountSplit(undefined, seatViewDeps(entry));
  entry.liveSplit = m.view;
  return { entry, m };
}

test('two seats: Internals clicked on B changes only B, and nothing is written to settings', async () => {
  const prevWindow = global.window;
  const setSettings = [];
  global.window = { api: { setSettings: (patch) => { setSettings.push(patch); } } };
  const a = await mountSeat('conversation');
  const b = await mountSeat('conversation');
  try {
    assert.deepStrictEqual([a.m.view.state().mode, b.m.view.state().mode], ['split', 'split']);
    modeButtons(b.m)[1].listeners.click();
    assert.deepStrictEqual([a.entry.view, b.entry.view], ['conversation', 'internals']);
    assert.deepStrictEqual([pressed(a.m), pressed(b.m)], [['true', 'false', 'false'], ['false', 'true', 'false']]);
    assert.deepStrictEqual(setSettings, []);
  } finally {
    b.m.view.dispose(); b.m.restore();
    a.m.view.dispose(); a.m.restore();
    global.window = prevWindow;
  }
});

test('the toggle ⌘⇧T calls takes Internals to Screen and back to Internals, the same as the bar button', async () => {
  const { entry, m } = await mountSeat('internals');
  try {
    toggleSeatTerminal(entry);
    assert.deepStrictEqual([entry.view, m.view.raw(), pressed(m)], ['terminal', true, ['false', 'false', 'true']]);
    toggleSeatTerminal(entry);
    assert.deepStrictEqual([entry.view, m.view.raw(), pressed(m)], ['internals', false, ['false', 'true', 'false']]);
    terminalButton(m).listeners.click();
    assert.deepStrictEqual([entry.view, m.view.raw()], ['terminal', true]);
    modeButtons(m)[0].listeners.click();
    assert.deepStrictEqual([entry.view, entry.lastView, m.view.raw(), pressed(m)], ['conversation', 'conversation', false, ['true', 'false', 'false']]);
  } finally { m.view.dispose(); m.restore(); }
});

test('the live view hands its peekFile to the rows, so unfolding a filed body reads the spill through it', async () => {
  const spill = '/Users/x/.clodex/spill/clodex/b000000000000001.md';
  const text = `[agent:task done t1] Report — 2.7 KB filed at ${spill}\n[agent:end]`;
  const recs = [HEAD, { id: 'a1', kind: 'assistant', ts: null, turn: 1, text, segments: segmentsOf(text) }];
  const peeked = [];
  const m = mountView({ peekFile: (p) => { peeked.push(p); return Promise.resolve({ ok: true, size: 4, content: 'body' }); }, pullTranscript: () => ({ ok: true, rev: 1, records: recs }) });
  try {
    m.write();
    await settle();
    const fold = findByClass([m.pane], 'intent-card-filed-link');
    fold.listeners.click();
    await settle();
    assert.deepStrictEqual(peeked, [spill]);
    assert.strictEqual(findByClass([m.pane], 'tr-spill-body').textContent, 'body');
  } finally { m.view.dispose(); m.restore(); }
});
