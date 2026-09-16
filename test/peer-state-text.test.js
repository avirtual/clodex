'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { peerStateText } = require('../renderer/lib/peer-state-text');

const PEERS_UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'peers-ui.js'), 'utf-8');

test('an online peer with needsUpgrade shows NO state word (the cue is the name colour), and carries a tip that says why', () => {
  const s = peerStateText({ status: { online: true, needsUpgrade: true } });
  assert.strictEqual(s.text, '', 'a state word widens the row and breaks the sidebar layout');
  assert.strictEqual(s.needsUpgrade, true);
  assert.match(s.tip, /sessions\/attach/);
});

test('an online peer without the flag reads empty, exactly as before', () => {
  assert.deepStrictEqual(
    peerStateText({ status: { online: true, needsUpgrade: false } }),
    { text: '', tip: null, needsUpgrade: false },
  );
  assert.strictEqual(peerStateText({ status: { online: true } }).text, '', 'an absent flag is not an upgrade prompt');
});

test('offline and tunnel-down outrank the dialect flag — unreachable is not "needs upgrade"', () => {
  assert.strictEqual(peerStateText({ status: { online: false, needsUpgrade: true } }).text, 'offline');
  const down = peerStateText({ status: { online: false, needsUpgrade: true }, tunnel: { state: 'down', error: 'no route' } });
  assert.strictEqual(down.text, 'tunnel down');
  assert.strictEqual(down.tip, 'no route');
  assert.strictEqual(down.needsUpgrade, false, 'an unreachable peer must not light the upgrade cue');
});

test('peers-ui renders the state word through esc(), never into an attribute', () => {
  assert.ok(
    PEERS_UI_SRC.includes('${esc(stateText)}'),
    'peers-ui no longer escapes the state word — a peer-supplied string would reach the DOM raw',
  );
  assert.ok(
    PEERS_UI_SRC.includes("require('./lib/peer-state-text')"),
    'peers-ui builds its state word somewhere other than the pinned builder',
  );
  assert.ok(
    PEERS_UI_SRC.includes("state.needsUpgrade ? ' peer-sev-major'"),
    'the upgrade cue must ride the peer NAME colour, not a text label',
  );
  assert.ok(!PEERS_UI_SRC.includes('peer-state-upgrade'), 'the text-label class was removed with the label');
});
