'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

function mkEl(id) {
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
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { el.children.push(c); return c; },
    removeChild() {},
    remove() {},
    focus() {},
    querySelector() { return null; },
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

function mkPeersUi({ moveSessionToPeer = async () => ({ ok: true }) } = {}) {
  const els = new Map();
  const byId = (id) => {
    if (!els.has(id)) els.set(id, mkEl(id));
    return els.get(id);
  };
  const doc = {
    getElementById: byId,
    createElement: (tag) => mkEl(`<${tag}>`),
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    body: mkEl('body'),
  };
  const noop = () => {};
  const api = new Proxy({}, {
    get: () => (() => Promise.resolve(null)),
  });

  const win = { api, addEventListener: noop, removeEventListener: noop, setTimeout, clearTimeout };
  const withDom = (fn) => {
    const prev = [global.document, global.window, global.requestAnimationFrame, global.CSS];
    global.document = doc;
    global.window = win;
    global.requestAnimationFrame = (f) => { f(); return 0; };
    global.CSS = { escape: (s) => String(s) };
    try { return fn(); } finally {
      [global.document, global.window, global.requestAnimationFrame, global.CSS] = prev;
    }
  };

  const ui = withDom(() => {
    delete require.cache[require.resolve('../renderer/peers-ui')];
    const { initPeersUi } = require('../renderer/peers-ui');
    return initPeersUi({
      sessions: new Map(), sessionList: mkEl('session-list'),
      getActiveSession: () => null,
      createTerminal: noop, switchSession: noop, removeSession: noop,
      updateSidebarActive: noop, showToast: noop, appendIpcEntry: noop,
      remeasureReadonlyPeer: noop,
      peerStatuses: new Map(), peerTunnels: new Map(), peerWebTunnels: new Map(),
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
  }, byId, shape, doc, withDom };
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
