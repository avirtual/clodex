'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');

const { localFromHome } = require('../renderer/lib/far-cwd-guess');
const { registerIpcHandlers } = require('../ipc-handlers');
const { updateApplies } = require('../proxy-util');

const LOCAL = localFromHome(os.homedir());

function mkEl(id, { stubQueries = false } = {}) {
  const el = {
    id,
    value: '',
    textContent: '',
    disabled: false,
    style: {},
    dataset: {},
    classList: {
      _set: new Set(),
      add(...c) { for (const x of c) this._set.add(x); },
      remove(...c) { for (const x of c) this._set.delete(x); },
      toggle(c, on) { if (on) this.add(c); else this.remove(c); },
      contains(c) { return this._set.has(c); },
    },
    children: [],
    listeners: {},
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { el.children.push(c); return c; },
    removeChild() {},
    remove() {},
    focus() {},
    querySelector() { return stubQueries ? mkEl('<query>', { stubQueries }) : null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    insertAdjacentHTML() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
    setAttribute() {},
    getAttribute() { return null; },
    contains() { return false; },
  };
  return el;
}

function mkPeersUi({ moveSessionToPeer = async () => ({ ok: true }), api: apiOverrides = {} } = {}) {
  const els = new Map();
  const byId = (id) => {
    if (!els.has(id)) els.set(id, mkEl(id));
    return els.get(id);
  };
  const doc = {
    getElementById: byId,
    createElement: (tag) => {
      const el = mkEl(`<${tag}>`, { stubQueries: true });
      el.innerHTML = '';
      return el;
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    body: mkEl('body'),
  };
  const noop = () => {};
  const calls = [];
  const handlers = {};
  const api = new Proxy({}, {
    get: (_, prop) => (...args) => {
      calls.push({ fn: prop, args });
      if (typeof prop === 'string' && /^on[A-Z]/.test(prop) && typeof args[0] === 'function') {
        handlers[prop] = args[0];
      }
      if (apiOverrides[prop]) return apiOverrides[prop](...args);
      return Promise.resolve(null);
    },
  });

  const win = { api, addEventListener: noop, removeEventListener: noop, setTimeout, clearTimeout };
  const install = () => {
    const prev = [global.document, global.window, global.requestAnimationFrame, global.CSS];
    global.document = doc;
    global.window = win;
    global.requestAnimationFrame = (f) => { f(); return 0; };
    global.CSS = { escape: (s) => String(s) };
    return () => { [global.document, global.window, global.requestAnimationFrame, global.CSS] = prev; };
  };
  const withDom = (fn) => {
    const restore = install();
    try { return fn(); } finally { restore(); }
  };
  const sessions = new Map();
  const peerStatuses = new Map();
  const sessionList = mkEl('session-list');

  const ui = withDom(() => {
    delete require.cache[require.resolve('../renderer/peers-ui')];
    const { initPeersUi } = require('../renderer/peers-ui');
    return initPeersUi({
      sessions, sessionList,
      getActiveSession: () => null,
      createTerminal: noop, switchSession: noop, removeSession: noop,
      updateSidebarActive: noop, showToast: noop, appendIpcEntry: noop,
      remeasureReadonlyPeer: noop,
      peerStatuses, peerTunnels: new Map(), peerWebTunnels: new Map(),
      getOurAppVersion: () => '0.0.0', syncSeatAvailability: noop,
      getDeployLineHandlers: () => [],
      proxyState: new Map(), ctxPct: new Map(), ctxTokens: new Map(),
      peerFilesCount: new Map(), filesUnseen: new Map(),
      applyCtxBadge: noop, applyWarmBadge: noop, renderProxyBar: noop,
      openFilePeek: noop, isFilesPopoverForKey: () => false,
      openArgsDialog: noop, openSkillsPopover: noop,
      moveSessionToPeer,
    });
  });

  const shape = () => ({
    nameDisabled: byId('peer-input-name').disabled,
    typeHidden: byId('peer-input-type-row').style.display === 'none',
    noteHidden: byId('peer-session-note').style.display === 'none',
    title: byId('peer-session-title').textContent,
  });
  return { ui: {
    openPeerSessionDialog: (...a) => withDom(() => ui.openPeerSessionDialog(...a)),
    closePeerSessionDialog: (...a) => withDom(() => ui.closePeerSessionDialog(...a)),
    typeToTakeControl: (...a) => withDom(() => ui.typeToTakeControl(...a)),
  }, byId, shape, doc, withDom, install, calls, handlers, sessions, peerStatuses, sessionList };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

test('a move-mode open locks the name, hides the type row and shows the note', () => {
  const { ui, byId, shape } = mkPeersUi();
  ui.openPeerSessionDialog('p1', 'murmurfi', { move: { name: 'crypto-hand', cwd: '/far/app' } });
  assert.deepStrictEqual(shape(), {
    nameDisabled: true, typeHidden: true, noteHidden: false,
    title: 'Move crypto-hand to murmurfi',
  });
  assert.strictEqual(byId('peer-input-name').value, 'crypto-hand', 'the travelling seat names itself');
  assert.strictEqual(byId('peer-input-cwd').value, '/far/app', 'the far cwd is prefilled, and editable');
  assert.match(byId('peer-session-note').textContent, /Exec grants and privileged intents do not/,
    'the note names what does NOT travel — the dialog is the only place it is said');
});

test('a same-platform peer prefills the cwd verbatim and adds no guess warning', () => {
  const { ui, byId } = mkPeersUi();
  ui.openPeerSessionDialog('p1', 'murmurfi', {
    move: { name: 'crypto-hand', cwd: '/far/app', farPlatform: LOCAL.platform },
  });
  assert.strictEqual(byId('peer-input-cwd').value, '/far/app');
  assert.doesNotMatch(byId('peer-session-note').textContent, /guessed from yours/,
    'no cross-platform guess happened, so nothing warns about one');
});

test('a peer on another OS warns in the note that the folder was guessed', () => {
  const foreign = LOCAL.platform === 'linux' ? 'darwin' : 'linux';
  const { ui, byId } = mkPeersUi();
  ui.openPeerSessionDialog('p1', 'murmurfi', {
    move: { name: 'crypto-hand', cwd: '/far/app', farPlatform: foreign },
  });
  const note = byId('peer-session-note').textContent;
  assert.match(note, new RegExp(`The peer runs ${foreign}; the folder was guessed from yours`),
    'the operator is told the path is a guess — the incident was a default nobody doubted');
  assert.match(note, /Exec grants and privileged intents do not/,
    'and the warning is APPENDED: the move note it sits beside still says what does not travel');
});

test('close itself restores the create shape, without waiting for the next open', () => {
  const { ui, byId } = mkPeersUi();
  ui.openPeerSessionDialog('p1', 'murmurfi', { move: { name: 'crypto-hand', cwd: '/far/app' } });
  ui.closePeerSessionDialog();
  assert.deepStrictEqual({
    nameDisabled: byId('peer-input-name').disabled,
    typeHidden: byId('peer-input-type-row').style.display === 'none',
    noteHidden: byId('peer-session-note').style.display === 'none',
    createLabel: byId('peer-session-create').textContent,
  }, {
    nameDisabled: false, typeHidden: false, noteHidden: true, createLabel: 'Create',
  }, 'asserted BEFORE any reopen: a later open re-asserts the whole shape, so checking after '
    + 'one would pass with no restore in close at all');
});

test('close restores the create shape, so the next create-mode open is unchanged', () => {
  const { ui, shape } = mkPeersUi();
  ui.openPeerSessionDialog('p1', 'murmurfi', { move: { name: 'crypto-hand', cwd: '/far/app' } });
  ui.closePeerSessionDialog();
  ui.openPeerSessionDialog('p1', 'murmurfi');
  assert.deepStrictEqual(shape(), {
    nameDisabled: false, typeHidden: false, noteHidden: true,
    title: 'New Session on murmurfi',
  });
});

test('a create-mode open after a move needs no close to be clean', () => {
  const { ui, shape, byId } = mkPeersUi();
  ui.openPeerSessionDialog('p1', 'murmurfi', { move: { name: 'crypto-hand', cwd: '/far/app' } });
  ui.openPeerSessionDialog('p1', 'murmurfi');
  assert.deepStrictEqual(shape(), {
    nameDisabled: false, typeHidden: false, noteHidden: true,
    title: 'New Session on murmurfi',
  });
  assert.strictEqual(byId('peer-input-name').value, '', 'and the moved seat name is not left behind');
});

function peerRowMenu(payload) {
  const listeners = new Map();
  const menus = [];
  registerIpcHandlers({
    handle: () => {},
    on: (channel, fn) => listeners.set(channel, fn),
    popupMenu: (template) => menus.push(template),
    uiSettings: { get: () => ({ peers: [] }) },
    getPeerManager: () => null,
    updateApplies,
    log: { info: () => {}, warn: () => {} },
  });
  const fn = listeners.get('peer:context-menu');
  assert.ok(fn, 'ENTER: peer:context-menu registered');
  fn({ sender: { send: () => {} } }, payload);
  assert.strictEqual(menus.length, 1, 'ENTER: the handler popped exactly one menu');
  return menus[0];
}

for (const row of [
  { type: 'claude', expectEditSkills: true, expectReloadFresh: true },
  { type: 'codex', expectEditSkills: false, expectReloadFresh: true },
  { type: 'bash', expectEditSkills: false, expectReloadFresh: false },
]) {
  test(`a ${row.type} peer row's context menu carries the far session's type, so main gates Edit Skills and Reload (fresh) as for a local seat`, () => {
    const h = mkPeersUi();
    const status = { online: true, caps: ['args', 'create'], sessions: [{ name: 'a', type: row.type, cwd: '/x' }] };
    h.withDom(() => h.handlers.onPeerState('p1', status));
    const item = h.sessionList.children.find((c) => c.dataset.name === 'a@p1');
    assert.ok(item, 'ENTER: the peer row was rendered');
    h.withDom(() => item.listeners.contextmenu.forEach((fn) => fn({ preventDefault() {} })));
    const sent = h.calls.filter((c) => c.fn === 'showPeerContextMenu');
    assert.strictEqual(sent.length, 1, 'ENTER: the row menu was requested');
    assert.strictEqual(sent[0].args[0].type, row.type);
    const template = peerRowMenu(sent[0].args[0]);
    const find = (prefix) => template.some((i) => typeof i.label === 'string' && i.label.startsWith(prefix));
    assert.ok(find('Edit Session'), 'ENTER: the menu reached the per-seat items');
    assert.strictEqual(find('Edit Skills'), row.expectEditSkills);
    assert.strictEqual(find('Reload'), row.expectReloadFresh);
  });
}

test('a control acquire that resolves after its tab was detached forgets the persisted claim instead of adopting it', async () => {
  const pending = deferred();
  const h = mkPeersUi({ api: { peerControl: (id, name, on) => (on ? pending.promise : Promise.resolve({ ok: true })) } });
  h.peerStatuses.set('p1', { online: true, caps: ['args', 'create'], sessions: [] });
  const entry = {
    peer: { id: 'p1', name: 'a', controlled: false },
    fitAddon: { fit() {} },
    terminal: { cols: 80, rows: 24, focus() {} },
  };
  h.sessions.set('a@p1', entry);
  const restore = h.install();
  try {
    h.ui.typeToTakeControl('a@p1', 'x');
    const acquires = h.calls.filter((c) => c.fn === 'peerControl');
    assert.deepStrictEqual(acquires.map((c) => c.args), [['p1', 'a', true]], 'ENTER: one acquire in flight');
    h.sessions.delete('a@p1');
    pending.resolve({ ok: true });
    await settle();
  } finally { restore(); }
  assert.deepStrictEqual(h.calls.filter((c) => c.fn === 'peerResize' || c.fn === 'peerInput'), [],
    'nothing is resized or typed into a detached tab');
  assert.deepStrictEqual(h.calls.filter((c) => c.fn === 'peerForgetControlled').map((c) => c.args),
    [['p1', 'a']], 'main is told to forget the claim its late remember re-saved');
  assert.deepStrictEqual(h.calls.filter((c) => c.fn === 'peerControl').map((c) => c.args),
    [['p1', 'a', true]], 'no release is sent: it would hit a re-attached tab of the same name');
  assert.strictEqual(entry.peer.controlled, false);
});

for (const row of [
  { res: { ok: false, error: 'name taken' }, outcome: 'fails' },
  { res: { ok: true, name: 'fresh', type: 'claude' }, outcome: 'succeeds' },
]) {
  test(`a create that ${row.outcome} after the dialog was reopened for a move leaves the new dialog untouched`, async () => {
    const pending = deferred();
    const h = mkPeersUi({ api: { peerCreateSession: () => pending.promise } });
    h.ui.openPeerSessionDialog('p1', 'box1');
    h.byId('peer-input-name').value = 'fresh';
    h.byId('peer-input-type').value = 'claude';
    h.byId('peer-input-cwd').value = '/work';
    const restore = h.install();
    try {
      h.byId('peer-session-create').listeners.click.forEach((fn) => fn({}));
      assert.strictEqual(h.calls.filter((c) => c.fn === 'peerCreateSession').length, 1, 'ENTER: the create is in flight');
      h.ui.closePeerSessionDialog();
      h.ui.openPeerSessionDialog('p2', 'box2', { move: { name: 'seat', cwd: '/x' } });
      assert.strictEqual(h.shape().title, 'Move seat to box2', 'ENTER: the move dialog is open');
      assert.strictEqual(h.byId('peer-session-overlay').classList.contains('hidden'), false, 'ENTER: the overlay is shown');
      pending.resolve(row.res);
      await settle();
    } finally { restore(); }
    assert.strictEqual(h.byId('peer-session-error').textContent, '');
    assert.strictEqual(h.byId('peer-session-overlay').classList.contains('hidden'), false);
    assert.strictEqual(h.byId('peer-input-name').disabled, true);
    assert.strictEqual(h.shape().title, 'Move seat to box2');
  });
}
