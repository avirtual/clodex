'use strict';
// PeerManager.sync's newborn announcement. _setOnline emits peer-state on
// TRANSITIONS only, so a peer whose hello never succeeds (wrong port, box
// down) would never emit at all — saved in settings yet invisible in the
// sidebar, whose peerStatuses map is fed exclusively by peer-state events.
// Bogdan hit this live: a peer added with the web port instead of the wire
// port "saved" and then never appeared. sync() now emits the newborn's
// (offline) status once at creation; a later successful hello follows with
// the online transition.

const { test } = require('node:test');
const assert = require('node:assert');

const { PeerManager } = require('../peer-client');

test('sync announces a newly-added peer immediately, offline, exactly once', () => {
  const emits = [];
  const mgr = new PeerManager({ emit: (ch, ...a) => emits.push([ch, ...a]) });
  try {
    // Port 1 — hello can never succeed, so only the newborn emit can fire.
    mgr.sync([{ id: 'sandbox', label: 'Sandbox', url: 'http://127.0.0.1:1' }]);

    const states = emits.filter(([ch]) => ch === 'peer-state');
    assert.equal(states.length, 1, 'the newborn announces itself synchronously');
    const [, id, status] = states[0];
    assert.equal(id, 'sandbox');
    assert.equal(status.online, false, 'announced offline — hello has not run');
    assert.equal(status.label, 'Sandbox');

    // Re-syncing the same config is a no-op: existing connections re-announce
    // via their own transitions, not via sync.
    mgr.sync([{ id: 'sandbox', label: 'Sandbox', url: 'http://127.0.0.1:1' }]);
    assert.equal(emits.filter(([ch]) => ch === 'peer-state').length, 1, 'no re-emit for a kept peer');
  } finally {
    mgr.stopAll();
  }
});

test('a url edit restarts the connection: peer-removed then a fresh offline announcement', () => {
  const emits = [];
  const mgr = new PeerManager({ emit: (ch, ...a) => emits.push([ch, ...a]) });
  try {
    mgr.sync([{ id: 'p', label: 'P', url: 'http://127.0.0.1:1' }]);
    emits.length = 0;
    mgr.sync([{ id: 'p', label: 'P', url: 'http://127.0.0.1:2' }]);

    assert.deepEqual(emits.map(([ch]) => ch), ['peer-removed', 'peer-state'],
      'drop announced, then the replacement announces itself');
    assert.equal(emits[1][2].url, 'http://127.0.0.1:2', 'the announcement carries the new url');
    assert.equal(emits[1][2].online, false);
  } finally {
    mgr.stopAll();
  }
});

test('a token edit restarts the connection like a url/label edit (Bearer is fixed per connection)', () => {
  const emits = [];
  const mgr = new PeerManager({ emit: (ch, ...a) => emits.push([ch, ...a]) });
  try {
    mgr.sync([{ id: 'p', label: 'P', url: 'http://127.0.0.1:1', token: 't1' }]);
    emits.length = 0;
    // Same url+label, new token → must drop and re-create so the new Bearer applies.
    mgr.sync([{ id: 'p', label: 'P', url: 'http://127.0.0.1:1', token: 't2' }]);
    assert.deepEqual(emits.map(([ch]) => ch), ['peer-removed', 'peer-state'],
      'a token change restarts the peer');
    emits.length = 0;
    // Re-syncing the identical token is a no-op (no needless restart).
    mgr.sync([{ id: 'p', label: 'P', url: 'http://127.0.0.1:1', token: 't2' }]);
    assert.equal(emits.length, 0, 'an unchanged token does not restart');
  } finally {
    mgr.stopAll();
  }
});

test('a managed tunnel peer whose url moves A -> placeholder -> B is re-pointed, never removed', () => {
  const emits = [];
  const mgr = new PeerManager({ emit: (ch, ...a) => emits.push([ch, ...a]) });
  try {
    mgr.sync([{ id: 'p', label: 'P', url: 'http://127.0.0.1:3', managed: true }]);
    const conn = mgr._peers.get('p');
    emits.length = 0;
    mgr.sync([{ id: 'p', label: 'P', url: 'http://127.0.0.1:1', managed: true }]);
    mgr.sync([{ id: 'p', label: 'P', url: 'http://127.0.0.1:4', managed: true }]);

    assert.ok(emits.some(([ch]) => ch === 'peer-state'), 'ENTER: the re-point announced itself');
    assert.equal(emits.filter(([ch]) => ch === 'peer-removed').length, 0, 'a tunnel blip is not a peer removal');
    assert.strictEqual(mgr._peers.get('p'), conn, 'the same connection survives both moves');
    assert.equal(conn.url, 'http://127.0.0.1:4');
    const last = emits.filter(([ch]) => ch === 'peer-state').pop();
    assert.equal(last[2].url, 'http://127.0.0.1:4');
  } finally {
    mgr.stopAll();
  }
});

test('the same url moves on a non-managed row still restart the connection', () => {
  const emits = [];
  const mgr = new PeerManager({ emit: (ch, ...a) => emits.push([ch, ...a]) });
  try {
    mgr.sync([{ id: 'p', label: 'P', url: 'http://127.0.0.1:3' }]);
    const conn = mgr._peers.get('p');
    emits.length = 0;
    mgr.sync([{ id: 'p', label: 'P', url: 'http://127.0.0.1:1' }]);
    mgr.sync([{ id: 'p', label: 'P', url: 'http://127.0.0.1:4' }]);

    assert.equal(emits.filter(([ch]) => ch === 'peer-removed').length, 2);
    assert.notStrictEqual(mgr._peers.get('p'), conn);
  } finally {
    mgr.stopAll();
  }
});
