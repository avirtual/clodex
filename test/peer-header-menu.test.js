// Run: node --test test/peer-header-menu.test.js
// The peer header's right-click menu (`peer:header-menu`). What this file
// exists for is the Pause item (t276): before it, the ONLY way to pause a peer
// was the ⓘ popover's button, and that button renders solely when
// `online && st.version` — so an offline or version-less peer could not be
// paused at all. An `enabled: !!online` copied from the neighbouring items
// would rebuild exactly that hole while looking correct, and only an assertion
// on the OFFLINE menu catches it.
//
// popupMenu is an injected seam (ipc-handlers takes it in deps), so the
// template is readable without Electron. Rig shape follows
// test/wire-hold-ipc.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { registerIpcHandlers } = require('../ipc-handlers');
// The REAL severity gate, not a stub: it decides whether the Update item joins
// the template, and a stub would pin my idea of when that happens rather than
// the shape the menu is actually assembled against.
const { updateApplies } = require('../proxy-util');

function rig() {
  const listeners = new Map();
  const menus = [];
  const sent = [];
  registerIpcHandlers({
    handle: () => {},
    on: (channel, fn) => listeners.set(channel, fn),
    popupMenu: (template) => menus.push(template),
    uiSettings: { get: () => ({ peers: [] }) },
    getPeerManager: () => null,
    updateApplies,
    log: { info: () => {}, warn: () => {} },
  });
  const fn = listeners.get('peer:header-menu');
  assert.ok(fn, 'ENTER: peer:header-menu registered — every assertion below is vacuous otherwise');
  return {
    sent,
    open(st) {
      menus.length = 0;
      fn({ sender: { send: (channel, payload) => sent.push([channel, payload]) } }, st);
      assert.strictEqual(menus.length, 1, 'ENTER: the handler popped exactly one menu');
      return menus[0];
    },
  };
}

const items = (t) => t.filter((i) => i.type !== 'separator');
const find = (t, prefix) => items(t).find((i) => i.label.startsWith(prefix));

test('Pause is present and ENABLED for an OFFLINE peer', () => {
  const { open } = rig();
  const template = open({ id: 'p1', label: 'thinkpad', online: false, canCreate: false });

  const pause = find(template, 'Pause');
  assert.ok(pause, 'the offline menu must still offer Pause — it is the only entry point offline');
  assert.strictEqual(pause.label, 'Pause thinkpad');
  // Absent `enabled` means enabled in Electron's menu template; what must never
  // appear is an explicit false, or the `!!online` its neighbours carry.
  assert.notStrictEqual(pause.enabled, false);

  // ENTER: the sibling items really are gated on online here, so the assertion
  // above is about Pause specifically and not about a menu where nothing is
  // disabled.
  assert.strictEqual(find(template, 'Restart').enabled, false);
});

test('Pause is present for an ONLINE peer and labelled with the peer', () => {
  const { open } = rig();
  const template = open({ id: 'p1', label: 'thinkpad', online: true, canCreate: true, sev: 'current' });

  const pause = find(template, 'Pause');
  assert.ok(pause);
  assert.strictEqual(pause.label, 'Pause thinkpad');
  // ENTER: the online menu really is the richer one, so this is not the
  // offline template under a different name.
  assert.ok(find(template, 'New Session'), 'online + canCreate offers New Session');
  assert.strictEqual(find(template, 'Restart').enabled, true);
});

test('clicking Pause dispatches the pause action with the peer id and label', () => {
  const { open, sent } = rig();
  const template = open({ id: 'p1', label: 'thinkpad', online: false, canCreate: false });

  find(template, 'Pause').click();
  assert.deepStrictEqual(sent, [['peer:context-action', { action: 'pause', id: 'p1', name: 'thinkpad' }]]);
});

test('a label-less peer degrades to "peer" rather than "Pause undefined"', () => {
  const { open } = rig();
  const template = open({ id: 'p1', online: false, canCreate: false });
  assert.strictEqual(find(template, 'Pause').label, 'Pause peer');
});

test('the paused header owns resume: the menu adds no second resume path', () => {
  const { open } = rig();
  for (const online of [true, false]) {
    const template = open({ id: 'p1', label: 'thinkpad', online, canCreate: true, sev: 'current' });
    const labels = items(template).map((i) => i.label);
    assert.ok(labels.length > 1, `ENTER: the ${online ? 'online' : 'offline'} menu has items to search`);
    assert.ok(!labels.some((l) => /resume|enable|unpause/i.test(l)),
      `resume must stay the paused header's ▶ only, got: ${labels.join(' | ')}`);
  }
});
