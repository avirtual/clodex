const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { registerIpcHandlers } = require('../ipc-handlers');

function mkHandlers({ entry = { name: 'a', type: 'claude', cwd: '/x', workspaceId: 'ws1' }, manager = {}, here = 'ws1', sent = [] } = {}) {
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, warn() {}, error() {} },
    persistence: {
      get: () => entry,
      listForWorkspace: (ws) => (ws === entry.workspaceId ? [entry] : []),
    },
    promptLibrary: { list: () => [] },
    popupMenu: () => {},
    REGISTRY_DIR: null,
    fs,
    showItemInFolder: () => {},
    getPeerManager: () => null,
    workspaces: { list: () => [{ id: 'ws1', name: 'Home' }] },
    workspaceOfSender: () => here,
    manager: {
      sessions: new Map(),
      listForWorkspace: () => [],
      ...manager,
    },
  });
  const e = { sender: { send: (channel, payload) => sent.push({ channel, payload }) } };
  return { handlers, e, sent };
}

function menuLabels(type) {
  let template = null;
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, warn() {}, error() {} },
    persistence: { get: () => ({ name: 'a', type, cwd: '/x' }) },
    promptLibrary: { list: () => [] },
    popupMenu: (tpl) => { template = tpl; },
    REGISTRY_DIR: null,
    fs,
    showItemInFolder: () => {},
    getPeerManager: () => null,
    workspaces: { list: () => [{ id: 'ws1', name: 'Home' }] },
    workspaceOfSender: () => 'ws1',
  });
  const sent = [];
  handlers.get('session:context-menu')(
    { sender: { send: (channel, payload) => sent.push({ channel, payload }) } },
    { name: 'a', cwd: '/x' },
  );
  const items = [];
  const walk = (list) => { for (const i of list || []) { items.push(i); if (i.submenu) walk(i.submenu); } };
  walk(template);
  return { labels: items.map((i) => i.label).filter(Boolean), items, sent };
}

test('session:scratch-mark is registered and forwards (name, label) to manager.scratchMark', async () => {
  const calls = [];
  const { handlers, e } = mkHandlers({
    manager: { scratchMark: (name, label) => { calls.push([name, label]); return { ok: true, nonce: 'n1', offset: 10 }; } },
  });
  const fn = handlers.get('session:scratch-mark');
  assert.equal(typeof fn, 'function', 'handler registered');
  const res = await fn(e, { name: 'a', label: 'before-refactor' });
  assert.deepStrictEqual(calls, [['a', 'before-refactor']]);
  assert.deepStrictEqual(res, { ok: true });
});

test('a throw from manager.scratchMark becomes {ok:false, error}', async () => {
  const { handlers, e } = mkHandlers({
    manager: { scratchMark: () => { throw new Error('scratch marks are for Claude seats only'); } },
  });
  const res = await handlers.get('session:scratch-mark')(e, { name: 'a', label: 'x' });
  assert.deepStrictEqual(res, { ok: false, error: 'scratch marks are for Claude seats only' });
});

test('a {ok:false} refusal from manager.scratchMark is passed through as {ok:false, error}', async () => {
  const { handlers, e } = mkHandlers({
    manager: { scratchMark: () => ({ ok: false, error: 'scratch mark x refused: mid-turn — re-try when the seat is idle' }) },
  });
  const res = await handlers.get('session:scratch-mark')(e, { name: 'a', label: 'x' });
  assert.deepStrictEqual(res, { ok: false, error: 'scratch mark x refused: mid-turn — re-try when the seat is idle' });
});

test('a persisted-but-not-live seat in this workspace REACHES manager.scratchMark — the guard scopes by persistence, not liveness', async () => {
  const calls = [];
  const { handlers, e } = mkHandlers({
    manager: { scratchMark: (name, label) => { calls.push([name, label]); throw new Error('session a is not running'); } },
  });
  const res = await handlers.get('session:scratch-mark')(e, { name: 'a', label: 'x' });
  assert.deepStrictEqual(calls, [['a', 'x']], 'the manager, not the guard, answers for an exited seat');
  assert.deepStrictEqual(res, { ok: false, error: 'session a is not running' });
});

test('the workspace guard refuses a name outside the sender window\'s workspace without calling the manager', async () => {
  const calls = [];
  const { handlers, e } = mkHandlers({
    here: 'ws2',
    manager: { scratchMark: (name, label) => { calls.push([name, label]); return { ok: true }; } },
  });
  const res = await handlers.get('session:scratch-mark')(e, { name: 'a', label: 'x' });
  assert.deepStrictEqual(res, { ok: false, error: 'session a is not in this workspace' });
  assert.deepStrictEqual(calls, [], 'manager.scratchMark was not reached');
});

test('the context menu carries Scratch mark… for a claude row, and it emits the scratchMark action', () => {
  const { labels, items, sent } = menuLabels('claude');
  assert.ok(labels.includes('Scratch mark…'), `expected the item, got: ${labels.join(' | ')}`);
  items.find((i) => i.label === 'Scratch mark…').click();
  assert.deepStrictEqual(sent, [{ channel: 'session:context-action', payload: { action: 'scratchMark', name: 'a' } }]);
});

test('the context menu does NOT carry Scratch mark… for a bash row', () => {
  const { labels } = menuLabels('bash');
  assert.ok(!labels.includes('Scratch mark…'), `bash row got the item: ${labels.join(' | ')}`);
  assert.ok(labels.includes('Restart Session'), 'the menu was built for this row');
});

test('the context menu does NOT carry Scratch mark… for a codex row', () => {
  const { labels } = menuLabels('codex');
  assert.ok(!labels.includes('Scratch mark…'), `codex row got the item: ${labels.join(' | ')}`);
  assert.ok(labels.includes('Move Session…'), 'the menu was built for this agent row');
});
