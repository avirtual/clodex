const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createConsoleTab } = require('../renderer/console-tab');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `ENTER: ${startMarker} not found in the shipped renderer`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, `ENTER: end of ${startMarker} not found`);
  return src.slice(start, end + endMarker.length);
}

function mk({ active = null, armed = null, recording = null, seats = [] } = {}) {
  const calls = [];
  const rec = (what) => (...a) => { calls.push([what, ...a]); };
  let stoppedHandler = null;
  const env = {
    sessions: new Map(seats.map((n) => [n, { wrapperEl: { remove() {} } }])),
    window: { api: { onVoiceEngineStopped: (cb) => { stoppedHandler = cb; }, peerDetach() {} } },
    streamSeatNames: new Set(),
    drawerHost: { forgetSession: rec('drawer.forgetSession'), onSessionChanged: rec('drawer.onSessionChanged') },
    sidePane: { forgetSeat: rec('sidePane.forgetSeat') },
    consoleTab: { forgetSeat: rec('consoleTab.forgetSeat') },
    voiceEngineView: { mirror: { disarm: rec('mirror.disarm') } },
    seatVoices: new Map(),
    removeSessionFromSidebar: rec('removeSessionFromSidebar'),
    updateWindowTitle() {},
    proxyState: new Map(),
    refreshQuotaChip() {},
    ctxPct: new Map(), ctxTokens: new Map(), filesState: new Map(), filesUnseen: new Map(), peerFilesCount: new Map(),
    forgetFilesCwd() {},
    forgetControlMirror() {},
    switchSession: rec('switchSession'),
    reportFocusedSession() {},
    emptyState: { style: {} },
    pluginBar: { renderFooterButtons() {} },
    renderProxyBar() {},
    filesToggle: { refresh() {} },
    voiceTrace() {},
    voiceSinkFor: () => null,
    setSeatRecording: rec('setSeatRecording'),
  };
  const names = Object.keys(env);
  const body = [
    `let activeSession = ${JSON.stringify(active)};`,
    `let voiceArmedSeat = ${JSON.stringify(armed)};`,
    `let voiceRecordingSeat = ${JSON.stringify(recording)};`,
    slice('function removeSession(', '\n}\n'),
    slice('window.api.onVoiceEngineStopped((name) => {', '\n});\n'),
    'return { removeSession, voice: () => ({ voiceArmedSeat, voiceRecordingSeat }) };',
  ].join('\n');
  const out = new Function(...names, body)(...names.map((n) => env[n]));
  return { ...out, env, calls, stopped: (n) => stoppedHandler(n) };
}

test('removing the recording seat disarms the mirror and clears both voice seats', () => {
  const h = mk({ active: 'alice', armed: 'alice', recording: 'alice', seats: ['alice', 'bob'] });
  h.removeSession('alice');
  assert.deepStrictEqual(h.voice(), { voiceArmedSeat: null, voiceRecordingSeat: null });
  assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'mirror.disarm'), [['mirror.disarm']]);
});

test('removing another seat leaves the armed recording seat alone', () => {
  const h = mk({ active: 'alice', armed: 'alice', recording: 'alice', seats: ['alice', 'bob'] });
  h.removeSession('bob');
  assert.deepStrictEqual(h.voice(), { voiceArmedSeat: 'alice', voiceRecordingSeat: 'alice' });
  assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'mirror.disarm'), []);
});

test('an engine stop for a seat that is gone still clears the recording seat', () => {
  const h = mk({ recording: 'ghost' });
  h.stopped('ghost');
  assert.strictEqual(h.voice().voiceRecordingSeat, null);
});

test('a removal that does not keep the record drops the console blocks and the voice mode', () => {
  const h = mk({ seats: ['alice'] });
  h.env.seatVoices.set('alice', 'tap');
  h.env.seatVoices.set('bob', 'hold');
  h.removeSession('alice');
  assert.deepStrictEqual([...h.env.seatVoices], [['bob', 'hold']]);
  assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'consoleTab.forgetSeat'), [['consoleTab.forgetSeat', 'alice']]);
});

test('a kept removal (rename, move) leaves the console blocks and voice mode', () => {
  const h = mk({ seats: ['alice'] });
  h.env.seatVoices.set('alice', 'tap');
  h.removeSession('alice', { keepPersisted: true });
  assert.deepStrictEqual([...h.env.seatVoices], [['alice', 'tap']]);
  assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'consoleTab.forgetSeat'), []);
});

test('the empty-state branch tells the drawer the seat it served is gone', () => {
  const h = mk({ active: 'alice', seats: ['alice'] });
  h.removeSession('alice');
  assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'drawer.onSessionChanged'), [['drawer.onSessionChanged']]);
});

function el() {
  const e = {
    children: [], parentNode: null, id: '', className: '', dataset: {}, style: {},
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, innerHTML: '', textContent: '',
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, removeAttribute() {},
    appendChild(c) { e.children.push(c); c.parentNode = e; return c; },
    insertBefore(c) { e.children.push(c); c.parentNode = e; return c; },
    replaceChild(n) { return n; },
    remove() {},
    querySelector(sel) { const made = el(); made.id = sel.slice(1); return made; },
    querySelectorAll: () => [],
  };
  return e;
}

test('console-tab forgetSeat drops the seat\'s blocks and cursor, and only that seat\'s', async (t) => {
  const had = { d: global.document, w: global.window, si: global.setInterval, ci: global.clearInterval };
  t.after(() => {
    global.document = had.d; global.window = had.w;
    global.setInterval = had.si; global.clearInterval = had.ci;
  });
  const reads = [];
  global.document = { createElement: el, addEventListener() {} };
  global.window = {
    __CLODEX_WEB__: false,
    api: {
      consoleRead: async (name, cursor) => { reads.push([name, cursor]); return { cursor: `${name}-c${reads.length}`, records: [] }; },
      consoleLive: async () => [],
    },
  };
  let poll = null;
  global.setInterval = (fn) => { poll = fn; return 1; };
  global.clearInterval = () => {};
  let tenant = null;
  const host = {
    register: (spec) => { tenant = spec; return Object.assign(() => {}, { selectionChanged() {} }); },
    domSelection: () => '', open() {},
  };
  let seat = 'alice';
  const tab = createConsoleTab({ host, getActiveSession: () => seat, getSeatType: () => 'claude' });
  tenant.mount(el(), el());
  tenant.onShow();
  const settle = () => new Promise((r) => setImmediate(r));
  await settle(); await settle();
  assert.deepStrictEqual(reads, [['alice', '']], 'ENTER: the first pull starts from an empty cursor');
  tab.forgetSeat('bob');
  await poll(); await settle();
  assert.deepStrictEqual(reads[1], ['alice', 'alice-c1'], 'forgetting another seat leaves this one\'s cursor');
  tab.forgetSeat('alice');
  await poll(); await settle();
  assert.deepStrictEqual(reads[2], ['alice', ''], 'a forgotten seat starts over from an empty cursor');
});
