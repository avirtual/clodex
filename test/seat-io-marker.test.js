'use strict';

const { test } = require('node:test');
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
    slice('const SEAT_IO_TIPS', '\n}\n'),
    fnSrc('addSessionToSidebar'), fnSrc('addArchivedSessionToSidebar'),
    fnSrc('addFailedSessionToSidebar'), fnSrc('addExitedSessionToSidebar'),
    'return { markSeatIo, addSessionToSidebar, addArchivedSessionToSidebar, addFailedSessionToSidebar, addExitedSessionToSidebar };',
  ].join('\n');
  const fns = new Function(...names, body)(...names.map((n) => env[n]));
  return { rows, env, ...fns };
}

const chipTip = (row) => (/<span class="session-chip"[^>]* data-tip="([^"]*)"/.exec(row.innerHTML) || [])[1];

test('a stream seat marked then added carries data-io="stream" and the streamed tip', () => {
  const h = mkRenderer();
  h.markSeatIo('s', 'stream');
  h.addSessionToSidebar('s', 'claude', '/w');
  assert.strictEqual(h.rows[0].dataset.io, 'stream');
  assert.strictEqual(chipTip(h.rows[0]), 'streamed seat (headless)');
});

test('a pty seat added carries data-io="pty" and the terminal tip', () => {
  const h = mkRenderer();
  h.markSeatIo('p', 'pty');
  h.addSessionToSidebar('p', 'codex', '/w');
  assert.strictEqual(h.rows[0].dataset.io, 'pty');
  assert.strictEqual(chipTip(h.rows[0]), 'terminal seat');
});

test('a late markSeatIo flips an existing row and its chip tip', () => {
  const h = mkRenderer();
  h.addSessionToSidebar('m', 'claude', '/w');
  assert.strictEqual(h.rows[0].dataset.io, 'pty');
  h.markSeatIo('m', 'stream');
  assert.strictEqual(h.rows[0].dataset.io, 'stream');
  assert.strictEqual(h.rows[0].chip.dataset.tip, 'streamed seat (headless)');
  h.markSeatIo('m', 'pty');
  assert.strictEqual(h.rows[0].dataset.io, 'pty');
  assert.strictEqual(h.rows[0].chip.dataset.tip, 'terminal seat');
});

for (const kind of ['Archived', 'Failed', 'Exited']) {
  test(`${kind.toLowerCase()} rows carry the entry's io, pty when absent`, () => {
    const h = mkRenderer();
    h[`add${kind}SessionToSidebar`]({ name: 'a', type: 'claude', cwd: '/w', io: 'stream' });
    h[`add${kind}SessionToSidebar`]({ name: 'b', type: 'claude', cwd: '/w' });
    assert.deepStrictEqual(h.rows.map((r) => [r.dataset.name, r.dataset.io, chipTip(r)]),
      [['a', 'stream', 'streamed seat (headless)'], ['b', 'pty', 'terminal seat']]);
  });
}

test('the stylesheet rounds the chip of a stream row', () => {
  const m = /\.session-item\[data-io="stream"\] \.session-chip \{([^}]*)\}/.exec(stylesSrc);
  assert.ok(m, 'stream chip rule present');
  assert.match(m[1], /border-radius: 50%;/);
  assert.match(m[1], /box-shadow: inset 0 0 0 1px/);
});
