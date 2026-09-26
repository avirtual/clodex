'use strict';

const test = require('node:test');
const { mock } = test;
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseTranscript } = require('../transcript-spike');
const { renderTranscript, createLiveSplitView } = require('../renderer/live-split-view');
const { OUTPUT_LINE_CAP } = require('../renderer/transcript-rows');
const { fakeDocument, textOf } = require('./lib/fake-dom');
const { fakeLine } = require('./lib/fake-cells');
const { createMenuMirror } = require('../renderer/lib/menu-mirror');

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
  const wrapper = { appendChild: (c) => appended.push(c), clientHeight: WRAPPER_PX, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } };
  const view = createLiveSplitView(terminal, wrapper, {
    isEligible: () => true,
    pullTranscript: () => { calls.pull += 1; rev += 1; return { ok: true, rev, records: recordsAt(rev) }; },
    now: () => 5000,
    seatName: 's1',
    onTranscriptChanged: (cb) => { listener = cb; return () => { calls.unsubscribed += 1; listener = null; }; },
    ...extra,
  });
  return {
    view, calls, csi, pane, terminal, wrapper, appended,
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
    const turn = m.pane.childNodes[0];
    const [head, block] = turn.childNodes;
    const tool = block.childNodes[0];
    assert.strictEqual(tool.className, 'tr-row tr-tool tr-state-pending');
    m.pane.userScroll(100);
    m.pane.scrollHeight = 1400;
    m.change('s1');
    await settle();
    assert.strictEqual(m.pane.childNodes[0], turn);
    assert.strictEqual(turn.childNodes[0], head);
    assert.strictEqual(turn.childNodes[1], block);
    assert.notStrictEqual(block.childNodes[0], tool);
    assert.strictEqual(block.childNodes[0].className, 'tr-row tr-tool tr-state-ok');
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

test('a composer in full stays hidden and the terminal visible', async () => {
  const composerEl = fakeComposer();
  const m = await mountSplit({ geometry: true }, { composerEl });
  try {
    m.view.setRaw(true);
    assert.strictEqual(m.view.state().mode, 'full');
    assert.strictEqual(composerEl.hidden, true);
    assert.strictEqual(m.terminal.element.style.visibility, '');
    assert.strictEqual(m.view.composerVisible(), false);
    assert.strictEqual(m.pane.hidden, true);
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

test('raw wins over the sheet: the whole terminal shows and the pane hides', async () => {
  const m = await mountSheet(PICKER);
  try {
    assert.strictEqual(m.wrapper.classList.contains('live-sheet'), true);
    m.view.setRaw(true);
    assert.strictEqual(m.pane.hidden, true);
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
