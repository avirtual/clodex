'use strict';
// peer-state-text.test.js — t938: the peer header's state word.
//
// A pure function rather than a render test: peers-ui runs under
// contextIsolation:false and there is no jsdom in this repo, so the builder is
// extracted and pinned directly. What matters is the PRECEDENCE — offline and
// tunnel-down outrank the dialect flag, because a peer that cannot be reached
// at all is not a peer that needs updating.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { peerStateText, NEEDS_UPGRADE_TEXT } = require('../renderer/lib/peer-state-text');

const PEERS_UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'peers-ui.js'), 'utf-8');

test('an online peer with needsUpgrade reads "needs upgrade", and carries a tip that says why', () => {
  const s = peerStateText({ status: { online: true, needsUpgrade: true } });
  assert.strictEqual(s.text, NEEDS_UPGRADE_TEXT);
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

// The renderer is contextIsolation:false: a peer-supplied string reaching an
// HTML position is arbitrary code in the main world. The state word goes
// through esc() like every other, and this pin is here because the word is new.
test('peers-ui renders the state word through esc(), never into an attribute', () => {
  assert.ok(
    PEERS_UI_SRC.includes('${esc(stateText)}'),
    'peers-ui no longer escapes the state word — a peer-supplied string would reach the DOM raw',
  );
  assert.ok(
    PEERS_UI_SRC.includes("require('./lib/peer-state-text')"),
    'peers-ui builds its state word somewhere other than the pinned builder',
  );
});
