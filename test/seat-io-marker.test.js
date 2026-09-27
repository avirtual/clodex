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

function mkRenderer(extra = {}) {
  const rows = [];
  const created = [];
  const mkNode = () => {
    const stub = () => ({ dataset: {}, addEventListener() {} });
    const node = {
      className: '', dataset: {}, innerHTML: '', on: {},
      chip: { dataset: {} },
      addEventListener(ev, fn) { node.on[ev] = fn; },
      focus() {}, select() {}, replaceWith() {},
      querySelector(sel) { return sel === '.session-chip' ? node.chip : stub(); },
      remove() { const i = rows.indexOf(node); if (i >= 0) rows.splice(i, 1); },
    };
    created.push(node);
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
    sessions: new Map(),
    accountOfRow: () => null,
    movingFailed: new Map(),
    movingToPeer: new Map(),
    pendingPeerMove: new Map(),
    createTerminal() {},
    switchSession() {},
    showToast: () => () => {},
    removeSession: (name) => { const i = rows.findIndex((r) => r.dataset.name === name); if (i >= 0) rows.splice(i, 1); },
    refreshSidebarView() {},
    peerStatuses: new Map(),
    openPeerSessionDialog() {},
    ...extra,
  };
  const names = Object.keys(env);
  const body = [
    slice('const seatIoKind', '\n}\n'),
    fnSrc('markSeatEffort'), fnSrc('markSeatPosture'),
    fnSrc('exitedRowSnapshot'), fnSrc('archivedRowEntry'),
    fnSrc('addSessionToSidebar'), fnSrc('addArchivedSessionToSidebar'),
    fnSrc('addFailedSessionToSidebar'), fnSrc('addExitedSessionToSidebar'),
    fnSrc('moveSessionWithPicker'), fnSrc('moveSessionToPeerWithDialog'), fnSrc('startRename'),
    'return { markSeatIo, markSeatEffort, markSeatPosture, exitedRowSnapshot, archivedRowEntry, addSessionToSidebar, addArchivedSessionToSidebar, addFailedSessionToSidebar, addExitedSessionToSidebar, moveSessionWithPicker, moveSessionToPeerWithDialog, startRename };',
  ].join('\n');
  const fns = new Function(...names, body)(...names.map((n) => env[n]));
  return { rows, env, created, mkNode, ...fns };
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
  assert.ok(whereLine(html).includes(' · stream'), whereLine(html));
  assert.strictEqual(whereLine(html), 'claude · stream');
});

test('a pty row renders a hovercard whose head carries data-io="pty" and names it terminal', () => {
  const html = hoverCard({ io: 'pty' });
  assert.strictEqual(headIo(html), 'pty');
  assert.ok(whereLine(html).includes(' · terminal'), whereLine(html));
});

test('the kind follows the backend segment on the hovercard where-line', () => {
  const html = hoverCard({ io: 'stream', backend: 'bedrock' });
  assert.strictEqual(whereLine(html), 'claude · bedrock · stream');
});

test('markSeatEffort stamps the level on an existing row and removes it on null', () => {
  const h = mkRenderer();
  h.addSessionToSidebar('s', 'claude', '/w');
  h.markSeatEffort('s', 'high');
  assert.strictEqual(h.rows[0].dataset.effort, 'high');
  h.markSeatEffort('s', null);
  assert.strictEqual('effort' in h.rows[0].dataset, false);
});

for (const kind of ['Archived', 'Failed', 'Exited']) {
  test(`${kind.toLowerCase()} rows carry the entry's effort, none when absent`, () => {
    const h = mkRenderer();
    h[`add${kind}SessionToSidebar`]({ name: 'a', type: 'codex', cwd: '/w', effort: 'max', posture: 'bypass' });
    h[`add${kind}SessionToSidebar`]({ name: 'b', type: 'claude', cwd: '/w', posture: 'default' });
    assert.deepStrictEqual(h.rows.map((r) => [r.dataset.name, r.dataset.effort, r.dataset.posture]), [['a', 'max', 'bypass'], ['b', undefined, undefined]]);
  });
}

test('the hovercard of an agent row shows the effort level it was spawned with', () => {
  const html = hoverCard({ type: 'claude', effort: 'xhigh' });
  assert.ok(html.includes('<div class="hc-row"><span class="hc-k">effort</span><span class="hc-v">xhigh</span></div>'), html);
});

test('the hovercard of an agent row with no recorded level shows effort default', () => {
  const html = hoverCard({ type: 'claude' });
  assert.ok(html.includes('<div class="hc-row"><span class="hc-k">effort</span><span class="hc-v">default</span></div>'), html);
});

test('the hovercard of a bash row has no effort row', () => {
  const html = hoverCard({ type: 'bash' });
  assert.doesNotMatch(html, /<span class="hc-k">effort<\/span>/);
});

test('the hovercard of an agent row shows its approval posture, default when none, and a bash row shows none', () => {
  const bypass = hoverCard({ type: 'codex', posture: 'bypass' });
  assert.ok(bypass.includes('<div class="hc-row"><span class="hc-k">posture</span><span class="hc-v">bypass</span></div>'), bypass);
  const plain = hoverCard({ type: 'claude' });
  assert.ok(plain.includes('<div class="hc-row"><span class="hc-k">posture</span><span class="hc-v">default</span></div>'), plain);
  assert.doesNotMatch(hoverCard({ type: 'bash' }), /<span class="hc-k">posture<\/span>/);
});

test('a seat that exits or is archived mid-session keeps its effort level on the rebuilt entry', () => {
  const h = mkRenderer();
  h.addSessionToSidebar('s', 'claude', '/w');
  h.markSeatEffort('s', 'xhigh');
  h.markSeatPosture('s', 'bypass');
  assert.strictEqual(h.exitedRowSnapshot('s', 1, {}).effort, 'xhigh');
  assert.strictEqual(h.archivedRowEntry('s', h.rows[0]).effort, 'xhigh');
  assert.strictEqual(h.exitedRowSnapshot('s', 1, {}).posture, 'bypass');
  assert.strictEqual(h.archivedRowEntry('s', h.rows[0]).posture, 'bypass');
  h.markSeatEffort('s', null);
  h.markSeatPosture('s', 'default');
  assert.strictEqual(h.exitedRowSnapshot('s', 1, {}).effort, null);
  assert.strictEqual(h.archivedRowEntry('s', h.rows[0]).effort, null);
  assert.strictEqual(h.exitedRowSnapshot('s', 1, {}).posture, null);
  assert.strictEqual(h.archivedRowEntry('s', h.rows[0]).posture, null);
});

test('markSeatEffort refreshes the seat\'s live split chips when it stamps a level and again when it clears one', () => {
  const h = mkRenderer();
  let refreshed = 0;
  h.env.sessions.set('s', { liveSplit: { refreshStatus: () => { refreshed += 1; } } });
  h.addSessionToSidebar('s', 'claude', '/w');
  const before = refreshed;
  h.markSeatEffort('s', 'high');
  assert.strictEqual(refreshed, before + 1);
  h.markSeatEffort('s', null);
  assert.strictEqual('effort' in h.rows[0].dataset, false);
  assert.strictEqual(refreshed, before + 2);
  h.markSeatPosture('s', 'bypass');
  assert.strictEqual(h.rows[0].dataset.posture, 'bypass');
  assert.strictEqual(refreshed, before + 3);
  h.markSeatPosture('s', 'default');
  assert.strictEqual('posture' in h.rows[0].dataset, false);
  assert.strictEqual(refreshed, before + 4);
});

test('a seat moved to another directory keeps its effort level on the rebuilt row', async () => {
  const api = { selectDirectory: async () => '/new' };
  const h = mkRenderer({ window: { api } });
  api.moveSession = async () => { h.rows.length = 0; return { ok: true, type: 'claude', cwd: '/new' }; };
  h.addSessionToSidebar('s', 'claude', '/w');
  h.markSeatEffort('s', 'xhigh');
  h.markSeatPosture('s', 'bypass');
  await h.moveSessionWithPicker('s');
  assert.deepStrictEqual(h.rows.map((r) => [r.dataset.name, r.dataset.cwd, r.dataset.effort, r.dataset.posture]), [['s', '/new', 'xhigh', 'bypass']]);
});

test('a seat moved to a peer leaves an archived row whose entry carries its effort level', async () => {
  const api = { moveSessionToPeer: async () => ({ ok: true, peer: 'far', farCwd: '/far' }) };
  const h = mkRenderer({ window: { api } });
  h.addSessionToSidebar('s', 'claude', '/w');
  h.markSeatEffort('s', 'xhigh');
  h.markSeatPosture('s', 'bypass');
  h.moveSessionToPeerWithDialog('s', 'p1', 'far', '/w');
  const res = await h.env.pendingPeerMove.get('s')('/far');
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(h.rows.map((r) => [r.dataset.name, r.dataset.effort, r.dataset.posture]), [['s', 'xhigh', 'bypass']]);
  assert.match(h.rows[0].className, /archived/);
});

test('a peer move that fails but respawns the seat here keeps its effort level on the rebuilt row', async () => {
  const api = {};
  const h = mkRenderer({ window: { api } });
  api.moveSessionToPeer = async () => { h.rows.length = 0; return { ok: false, kept: true, respawned: true, type: 'claude', cwd: '/w', error: 'far refused' }; };
  h.addSessionToSidebar('s', 'claude', '/w');
  h.markSeatEffort('s', 'xhigh');
  h.markSeatPosture('s', 'bypass');
  h.moveSessionToPeerWithDialog('s', 'p1', 'far', '/w');
  await h.env.pendingPeerMove.get('s')('/far');
  assert.deepStrictEqual(h.rows.map((r) => [r.dataset.name, r.dataset.effort, r.dataset.posture]), [['s', 'xhigh', 'bypass']]);
  assert.doesNotMatch(h.rows[0].className, /failed|archived/);
});

test('a failed move that keeps the seat without respawning carries its effort level on the failed row, on either path', async () => {
  const failed = { ok: false, kept: true, type: 'claude', cwd: '/w', error: 'boom' };
  const api = { selectDirectory: async () => '/new', moveSession: async () => failed, moveSessionToPeer: async () => failed };
  const dir = mkRenderer({ window: { api } });
  dir.addSessionToSidebar('s', 'claude', '/w');
  dir.markSeatEffort('s', 'xhigh');
  dir.markSeatPosture('s', 'bypass');
  await dir.moveSessionWithPicker('s');
  const peer = mkRenderer({ window: { api } });
  peer.addSessionToSidebar('s', 'claude', '/w');
  peer.markSeatEffort('s', 'high');
  peer.markSeatPosture('s', 'read-only');
  peer.moveSessionToPeerWithDialog('s', 'p1', 'far', '/w');
  await peer.env.pendingPeerMove.get('s')('/far');
  assert.deepStrictEqual([dir, peer].map((h) => h.rows.map((r) => [r.dataset.name, r.dataset.effort, r.dataset.posture, /failed/.test(r.className)])),
    [[['s', 'xhigh', 'bypass', true]], [['s', 'high', 'read-only', true]]]);
});

test('a rename that fails but keeps the seat carries its effort level on the failed row', async () => {
  let renamed;
  const api = { renameSession: async () => { const res = { ok: false, kept: true, name: 's', type: 'claude', cwd: '/w', error: 'boom' }; renamed = Promise.resolve(); return res; } };
  const h = mkRenderer({ window: { api } });
  h.addSessionToSidebar('s', 'claude', '/w');
  h.markSeatEffort('s', 'xhigh');
  h.markSeatPosture('s', 'bypass');
  const nameEl = h.mkNode();
  nameEl.textContent = 's';
  h.startRename(h.rows[0], nameEl, 's');
  const input = h.created[h.created.length - 1];
  input.value = 't';
  input.on.blur();
  await renamed;
  await new Promise((r) => setImmediate(r));
  assert.ok(renamed, 'ENTER: the rename reached renameSession');
  assert.deepStrictEqual(h.rows.map((r) => [r.dataset.name, r.dataset.effort, r.dataset.posture, /failed/.test(r.className)]), [['s', 'xhigh', 'bypass', true]]);
});
