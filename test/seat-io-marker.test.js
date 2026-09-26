'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { classifySender } = require('../renderer/lib/sender-class');

const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const stylesSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

function slice(startMarker, endMarker) {
  const start = rendererSrc.indexOf(startMarker);
  assert.ok(start >= 0, `ENTER: ${startMarker} not found in the shipped renderer`);
  const end = rendererSrc.indexOf(endMarker, start);
  assert.ok(end > start, `ENTER: end of ${startMarker} not found`);
  return rendererSrc.slice(start, end + endMarker.length);
}
const fnSrc = (name) => slice(`function ${name}(`, '\n}\n');

function mkRenderer() {
  const rows = [];
  const mkNode = () => {
    const stub = () => ({ dataset: {}, addEventListener() {} });
    const node = {
      className: '', dataset: {}, innerHTML: '',
      chip: { dataset: {} },
      addEventListener() {},
      querySelector(sel) { return sel === '.session-chip' ? node.chip : stub(); },
      remove() { const i = rows.indexOf(node); if (i >= 0) rows.splice(i, 1); },
    };
    return node;
  };
  const env = {
    document: { createElement: () => mkNode() },
    window: { api: {} },
    CSS: { escape: (s) => s },
    sessionList: {
      querySelector(sel) {
        const m = /data-name="([^"]*)"/.exec(sel);
        return (m && rows.find((r) => r.dataset.name === m[1])) || null;
      },
    },
    streamSeatNames: new Set(),
    sidebarMeta: new Map(),
    ACCOUNT_DEFAULT: 'default',
    insertLocalSessionRow: (item) => rows.push(item),
    esc: (s) => String(s),
    typeGlyph: () => 'C',
    baseName: (p) => p,
    classifySender,
    applyFixChip() {},
    scheduleSidebarRelayout() {},
    exitedLabel: () => 'exited',
  };
  const names = Object.keys(env);
  const body = [
    slice('const seatIoKind', '\n}\n'),
    fnSrc('addSessionToSidebar'), fnSrc('addArchivedSessionToSidebar'),
    fnSrc('addFailedSessionToSidebar'), fnSrc('addExitedSessionToSidebar'),
    'return { markSeatIo, addSessionToSidebar, addArchivedSessionToSidebar, addFailedSessionToSidebar, addExitedSessionToSidebar };',
  ].join('\n');
  const fns = new Function(...names, body)(...names.map((n) => env[n]));
  return { rows, env, ...fns };
}

const chipTip = (row) => (/<span class="session-chip"[^>]*>/.exec(row.innerHTML) || [''])[0].includes('data-tip=') ? 'tip' : null;

test('a stream seat marked then added carries data-io="stream" and no chip tip', () => {
  const h = mkRenderer();
  h.markSeatIo('s', 'stream');
  h.addSessionToSidebar('s', 'claude', '/w');
  assert.strictEqual(h.rows[0].dataset.io, 'stream');
  assert.match(h.rows[0].innerHTML, /<span class="session-chip"/);
  assert.strictEqual(chipTip(h.rows[0]), null);
});

test('a pty seat added carries data-io="pty" and no chip tip', () => {
  const h = mkRenderer();
  h.markSeatIo('p', 'pty');
  h.addSessionToSidebar('p', 'codex', '/w');
  assert.strictEqual(h.rows[0].dataset.io, 'pty');
  assert.strictEqual(chipTip(h.rows[0]), null);
});

test('a late markSeatIo flips an existing row and leaves its chip without a tip', () => {
  const h = mkRenderer();
  h.addSessionToSidebar('m', 'claude', '/w');
  assert.strictEqual(h.rows[0].dataset.io, 'pty');
  h.markSeatIo('m', 'stream');
  assert.strictEqual(h.rows[0].dataset.io, 'stream');
  assert.strictEqual(h.rows[0].chip.dataset.tip, undefined);
  h.markSeatIo('m', 'pty');
  assert.strictEqual(h.rows[0].dataset.io, 'pty');
  assert.strictEqual(h.rows[0].chip.dataset.tip, undefined);
});

for (const kind of ['Archived', 'Failed', 'Exited']) {
  test(`${kind.toLowerCase()} rows carry the entry's io, pty when absent, and no chip tip`, () => {
    const h = mkRenderer();
    h[`add${kind}SessionToSidebar`]({ name: 'a', type: 'claude', cwd: '/w', io: 'stream' });
    h[`add${kind}SessionToSidebar`]({ name: 'b', type: 'claude', cwd: '/w' });
    assert.deepStrictEqual(h.rows.map((r) => [r.dataset.name, r.dataset.io, chipTip(r)]),
      [['a', 'stream', null], ['b', 'pty', null]]);
  });
}

test('the stylesheet rounds the chip of a stream row and of a stream hovercard head in one rule', () => {
  const m = /\.session-item\[data-io="stream"\] \.session-chip,\s*\.hovercard-head\[data-io="stream"\] \.session-chip \{([^}]*)\}/.exec(stylesSrc);
  assert.ok(m, 'two-selector stream chip rule present');
  assert.match(m[1], /border-radius: 50%;/);
  assert.match(m[1], /box-shadow: inset 0 0 0 1px/);
});

function withDom(fn) {
  const saved = { document: global.document, window: global.window };
  const card = { style: {}, hidden: true, innerHTML: '', offsetWidth: 0, offsetHeight: 0 };
  global.document = {
    createElement: (tag) => (tag === 'div' && card.id ? {
      set textContent(v) { this.innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
    } : card),
    body: { appendChild() {} },
    addEventListener() {},
  };
  global.window = { innerWidth: 1000, innerHeight: 800 };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try { return fn(card); } finally {
    mock.timers.reset();
    global.document = saved.document;
    global.window = saved.window;
  }
}

function hoverCard(dataset) {
  return withDom((card) => {
    const listeners = {};
    const { initSessionHovercard } = require('../renderer/session-hovercard');
    initSessionHovercard({
      sessionList: { addEventListener: (ev, fn) => { listeners[ev] = fn; } },
      proxyState: new Map(), ctxPct: new Map(), ctxTokens: new Map(),
      proxyPollMs: 1000, typeGlyph: () => 'C',
    });
    const item = {
      dataset: { name: 'seat', type: 'claude', cwd: '/w', ...dataset },
      isConnected: true,
      querySelector: () => null,
      getBoundingClientRect: () => ({ right: 10, top: 10 }),
    };
    listeners.mouseover({ target: { closest: (sel) => (sel === '.session-item' ? item : null) } });
    mock.timers.tick(1000);
    assert.strictEqual(card.hidden, false, 'ENTER: the hovercard was shown');
    const html = card.innerHTML;
    listeners.mouseout({ relatedTarget: null });
    return html;
  });
}

const headIo = (html) => (/<div class="hovercard-head"( data-io="([^"]*)")?>/.exec(html) || [])[2];
const whereLine = (html) => (/<span class="hovercard-type">([^<]*)<\/span>/.exec(html) || [])[1];

test('a stream row renders a hovercard whose head carries data-io="stream" and names the kind', () => {
  const html = hoverCard({ io: 'stream' });
  assert.strictEqual(headIo(html), 'stream');
  assert.ok(whereLine(html).includes(' · streamed'), whereLine(html));
  assert.strictEqual(whereLine(html), 'claude · streamed');
});

test('a pty row renders a hovercard whose head carries data-io="pty" and names it terminal', () => {
  const html = hoverCard({ io: 'pty' });
  assert.strictEqual(headIo(html), 'pty');
  assert.ok(whereLine(html).includes(' · terminal'), whereLine(html));
});

test('the kind follows the backend segment on the hovercard where-line', () => {
  const html = hoverCard({ io: 'stream', backend: 'bedrock' });
  assert.strictEqual(whereLine(html), 'claude · bedrock · streamed');
});
