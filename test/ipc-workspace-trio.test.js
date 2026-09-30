'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { registerIpcHandlers } = require('../ipc-handlers');

function mkRetry(entry, senderWs) {
  const calls = [];
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, warn() {}, error() {} },
    persistence: { list: () => [entry] },
    manager: {
      resumeCwdOf: (en) => en.cwd,
      create: async (...args) => { calls.push(args); },
    },
    workspaceOfSender: () => senderWs,
  });
  return { retry: (name) => handlers.get('session:retrySpawn')({}, name), calls };
}

const RETRY_ENTRY = { name: 'seat', type: 'claude', cwd: '/x', sessionId: 'sid' };

function expectedCreateArgs(workspaceId) {
  return [
    'seat', 'claude', '/x', [], 'sid', workspaceId, null, false, null,
    [], [], [], [], [], null, [], [], null, null, false, false, null, null, null, 'pty', null,
  ];
}

test('session:retrySpawn respawns a seat saved in workspace A into A, even from a window in B', async () => {
  const { retry, calls } = mkRetry({ ...RETRY_ENTRY, workspaceId: 'A' }, 'B');
  const res = await retry('seat');
  assert.strictEqual(res.ok, true, res.error);
  assert.deepStrictEqual(calls, [expectedCreateArgs('A')]);
});

test('session:retrySpawn falls back to the sender\'s workspace for a legacy record with no workspaceId', async () => {
  const { retry, calls } = mkRetry({ ...RETRY_ENTRY }, 'B');
  const res = await retry('seat');
  assert.strictEqual(res.ok, true, res.error);
  assert.deepStrictEqual(calls, [expectedCreateArgs('B')]);
});

function mkForget(entries, senderWs) {
  const kills = [];
  const store = [...entries];
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, warn() {}, error() {} },
    persistence: {
      list: () => store,
      get: (n) => store.find((e) => e.name === n) || null,
      remove: (n) => { const i = store.findIndex((e) => e.name === n); if (i >= 0) store.splice(i, 1); },
    },
    manager: { clearHintForRecord() {} },
    getDrawerPtys: () => ({ killSeat: (ws, name) => kills.push([ws, name]) }),
    workspaceOfSender: () => senderWs,
    workspaceOfSenderStrict: () => senderWs,
  });
  return { forget: (name) => handlers.get('session:forget')({}, name), kills, store };
}

test('session:forget of a seat owned by workspace A from a window in B reaps the drawer shell in A', () => {
  const { forget, kills, store } = mkForget([{ name: 'seat', workspaceId: 'A' }], 'B');
  assert.strictEqual(forget('seat'), true);
  assert.deepStrictEqual(store, [], 'ENTER: remove() really dropped the record the handler read');
  assert.deepStrictEqual(kills, [['A', 'seat']]);
});

test('session:forget falls back to the sender\'s workspace for a record with no workspaceId, or none at all', () => {
  for (const entries of [[{ name: 'seat' }], []]) {
    const { forget, kills } = mkForget(entries, 'B');
    assert.strictEqual(forget('seat'), true);
    assert.deepStrictEqual(kills, [['B', 'seat']]);
  }
});

function mkContextMenu(entry, openInTerminal) {
  let template = null;
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, warn() {}, error() {} },
    persistence: { get: () => entry },
    promptLibrary: { list: () => [] },
    popupMenu: (tpl) => { template = tpl; },
    fs: require('fs'),
    openInTerminal,
    workspaces: { list: () => [] },
    workspaceOfSender: () => 'ws1',
  });
  handlers.get('session:context-menu')({ sender: { send() {} } }, { name: entry.name, cwd: entry.cwd });
  return template;
}

function findItem(template, label) {
  let found = null;
  const walk = (items) => { for (const i of items || []) { if (i.label === label) found = i; if (i.submenu) walk(i.submenu); } };
  walk(template);
  return found;
}

test('Open in Terminal hands the cwd to the injected openInTerminal seam', () => {
  const opened = [];
  const item = findItem(mkContextMenu({ name: 'a', type: 'claude', cwd: '/x' }, (cwd) => opened.push(cwd)), 'Open in Terminal');
  assert.ok(item, 'ENTER: the item is in the template');
  item.click();
  assert.deepStrictEqual(opened, ['/x']);
});

test('ipc-handlers.js requires no child_process: every native touch rides a seam', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'ipc-handlers.js'), 'utf8');
  assert.doesNotMatch(src, /require\(\s*['"](?:node:)?child_process['"]\s*\)/);
});
