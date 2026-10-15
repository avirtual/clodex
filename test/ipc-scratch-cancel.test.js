const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { registerIpcHandlers } = require('../ipc-handlers');

function mkHandlers({ entry = { name: 'a', type: 'claude', cwd: '/x', workspaceId: 'ws1' }, manager = {}, here = 'ws1', sent = [], popupMenu = () => {} } = {}) {
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
    popupMenu,
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
test('t1839 the claude row menu no longer carries Scratch mark…, and session:scratch-mark is not registered', () => {
  const { labels } = menuLabels('claude');
  assert.ok(!labels.includes('Scratch mark…'), `claude row still got the item: ${labels.join(' | ')}`);
  assert.ok(labels.includes('Move Session…'), 'the menu was built for this agent row');
  const { handlers } = mkHandlers();
  assert.strictEqual(handlers.has('session:scratch-mark'), false);
  assert.strictEqual(handlers.has('session:scratch-cancel'), true);
});

test('t1547 a scratch clone\'s row menu is the single item Cancel clone, which names the parent', () => {
  let template = null;
  const { handlers, e, sent } = mkHandlers({
    popupMenu: (tpl) => { template = tpl; },
    manager: { sessions: new Map([['a-scratch-1234', { name: 'a-scratch-1234', clone: 'a' }]]) },
  });
  handlers.get('session:context-menu')(e, { name: 'a-scratch-1234', cwd: '/x' });
  assert.deepStrictEqual(template.map((i) => i.label), ['Cancel clone']);
  template[0].click();
  assert.deepStrictEqual(sent, [{ channel: 'session:context-action', payload: { action: 'cancelClone', name: 'a-scratch-1234', clone: 'a' } }]);
});

test('t1547 session:scratch-cancel cancels the parent\'s clone and replies into the parent', async () => {
  const parent = { name: 'a', _scratchClone: 'a-scratch-1234' };
  const calls = [];
  const injected = [];
  const { handlers, e } = mkHandlers({
    manager: {
      sessions: new Map([['a', parent]]),
      _scratchCloneCancel: (s, reply) => { calls.push(s.name); reply('[scratch] clone cancelled, no summary'); },
      _injectText: (s, text) => injected.push([s.name, text]),
    },
  });
  assert.deepStrictEqual(await handlers.get('session:scratch-cancel')(e, { parent: 'a', clone: 'a-scratch-1234' }), { ok: true });
  assert.deepStrictEqual(calls, ['a']);
  assert.deepStrictEqual(injected, [['a', '[scratch] clone cancelled, no summary']]);
  parent._scratchClone = null;
  assert.deepStrictEqual(await handlers.get('session:scratch-cancel')(e, { parent: 'a', clone: 'a-scratch-1234' }), { ok: false, error: 'a has no scratch clone' });
});

test('t1549 session:scratch-cancel refuses when the named clone is no longer the parent\'s, without cancelling', async () => {
  const calls = [];
  const { handlers, e } = mkHandlers({
    manager: {
      sessions: new Map([['a', { name: 'a', _scratchClone: 'a-scratch-ffff' }]]),
      _scratchCloneCancel: (s) => calls.push(s.name),
      _injectText: () => {},
    },
  });
  const res = await handlers.get('session:scratch-cancel')(e, { parent: 'a', clone: 'a-scratch-0000' });
  assert.deepStrictEqual(res, { ok: false, error: "a-scratch-0000 is no longer a's scratch clone" });
  assert.deepStrictEqual(calls, [], '_scratchCloneCancel was not reached');
});

test('t1549 session:scratch-cancel refuses a parent outside the sender window\'s workspace', async () => {
  const calls = [];
  const { handlers, e } = mkHandlers({
    here: 'ws2',
    manager: {
      sessions: new Map([['a', { name: 'a', _scratchClone: 'a-scratch-1234' }]]),
      _scratchCloneCancel: (s) => calls.push(s.name),
    },
  });
  const res = await handlers.get('session:scratch-cancel')(e, { parent: 'a', clone: 'a-scratch-1234' });
  assert.deepStrictEqual(res, { ok: false, error: 'session a is not in this workspace' });
  assert.deepStrictEqual(calls, []);
});
