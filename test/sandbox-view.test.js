'use strict';
// Unit tests for renderer/lib/sandbox-view.js — the Sandbox dialog's pure copy
// selection (docs/sandbox-plan.md M2). The install-vs-daemon-down distinction is
// the branch that matters (different remedy), so it's pinned here.

const test = require('node:test');
const assert = require('node:assert');
const { detectNotice, statusNotice, openUrl, portsLineText } = require('../renderer/lib/sandbox-view');

test('detectNotice: docker not installed → error + install remedy', () => {
  const n = detectNotice({ present: false, running: false });
  assert.strictEqual(n.kind, 'error');
  assert.match(n.text, /install/i);
});

test('detectNotice: installed but daemon down → warn + start remedy (distinct copy)', () => {
  const n = detectNotice({ present: true, running: false });
  assert.strictEqual(n.kind, 'warn');
  assert.match(n.text, /running/i);
  assert.match(n.text, /start/i);
});

test('detectNotice: running → ok', () => {
  const n = detectNotice({ present: true, running: true });
  assert.strictEqual(n.kind, 'ok');
});

test('detectNotice: missing/undefined input reads as not installed', () => {
  assert.strictEqual(detectNotice(undefined).kind, 'error');
  assert.strictEqual(detectNotice({}).kind, 'error');
});

test('statusNotice: running → ok + running true', () => {
  const n = statusNotice('running');
  assert.strictEqual(n.kind, 'ok');
  assert.strictEqual(n.running, true);
});

test('statusNotice: exited → stopped, running false', () => {
  const n = statusNotice('exited');
  assert.strictEqual(n.running, false);
  assert.match(n.text, /stopped/i);
});

test('statusNotice: absent/unknown → not-created copy, running false', () => {
  const n = statusNotice('absent');
  assert.strictEqual(n.running, false);
  assert.match(n.text, /not been created/i);
  // Any unexpected state falls back to the same safe "not created / stopped".
  assert.strictEqual(statusNotice(undefined).running, false);
});

test('openUrl: localhost + the web port', () => {
  assert.strictEqual(openUrl(7810), 'http://localhost:7810');
});

test('portsLineText: stopped (no effective ports) → empty (caller hides the line)', () => {
  assert.strictEqual(portsLineText(null), '');
  assert.strictEqual(portsLineText(undefined), '');
});

test('portsLineText: running → the effective ports, middot-joined (states what IS)', () => {
  assert.strictEqual(
    portsLineText({ web: 7812, wirescope: 7813, wire: 7821 }),
    'Web 7812 · Wirescope 7813 · Peer wire 7821',
  );
});

test('portsLineText: a role missing from a partial parse is skipped', () => {
  assert.strictEqual(portsLineText({ web: 7812 }), 'Web 7812');
  assert.strictEqual(portsLineText({ web: 7812, wire: 7821 }), 'Web 7812 · Peer wire 7821');
});

test('portsLineText: a non-numeric port value is skipped', () => {
  assert.strictEqual(portsLineText({ web: NaN, wirescope: 7813 }), 'Wirescope 7813');
  assert.strictEqual(portsLineText({}), '');
});
