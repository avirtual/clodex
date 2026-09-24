'use strict';

const test = require('node:test');
const { mock } = test;
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseTranscript } = require('../transcript-spike');
const { renderTranscript, createLiveSplitView } = require('../renderer/live-split-view');
const { OUTPUT_LINE_CAP } = require('../renderer/transcript-rows');
const { fakeDocument } = require('./lib/fake-dom');

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
  return rows.flatMap((row) => body(row).childNodes);
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
    { text: '[agent:end]', style: '', cls: 'intent-mark intent-mark-fire' },
  ]);
  assert.strictEqual(plain(nodes), 'Reply\n[agent:dm bob] hi\n[agent:end]');
  assert.deepStrictEqual(nodes.filter((n) => !n.cls).map((n) => n.text).join('|'), 'Reply|\n| hi|\n');
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
  const terminal = {
    rows: 4, cols: 20, element: geometry ? fakeTermElement(4) : null,
    buffer: { active: { type: 'normal', baseY: 0, cursorY: 1, viewportY: 0, getLine: (i) => (screen[i] == null ? null : { translateToString: () => screen[i] }) } },
    parser: parser ? {
      registerCsiHandler(id, cb) { csi[`${id.prefix}${id.final}`] = cb; return { dispose() {} }; },
    } : undefined,
    onWriteParsed(cb) { writes.push(cb); return { dispose() {} }; },
    onResize() { return { dispose() {} }; },
    onScroll() { return { dispose() {} }; },
  };
  const calls = { pull: 0, unsubscribed: 0 };
  let listener = null;
  let rev = 0;
  const wrapper = { appendChild() {}, clientHeight: WRAPPER_PX, classList: { add() {}, remove() {} } };
  const view = createLiveSplitView(terminal, wrapper, {
    isEligible: () => true,
    pullTranscript: () => { calls.pull += 1; rev += 1; return { ok: true, rev, records: recordsAt(rev) }; },
    now: () => 5000,
    seatName: 's1',
    onTranscriptChanged: (cb) => { listener = cb; return () => { calls.unsubscribed += 1; listener = null; }; },
    ...extra,
  });
  return {
    view, calls, csi, pane,
    show: (rows) => { screen.length = 0; screen.push(...rows); },
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

async function mountSplit(opts) {
  let t = 5000;
  const changes = [];
  const m = mountView({ now: () => t, onChange: (st) => changes.push({ ...st }) }, opts);
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
    const turn = m.pane.childNodes[0];
    const [head, tool] = turn.childNodes;
    assert.strictEqual(tool.className, 'tr-row tr-tool tr-state-pending');
    m.pane.userScroll(100);
    m.pane.scrollHeight = 1400;
    m.change('s1');
    await settle();
    assert.strictEqual(m.pane.childNodes[0], turn);
    assert.strictEqual(turn.childNodes[0], head);
    assert.notStrictEqual(turn.childNodes[1], tool);
    assert.strictEqual(turn.childNodes[1].className, 'tr-row tr-tool tr-state-ok');
    assert.strictEqual(m.pane.scrollTop, 100);
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
