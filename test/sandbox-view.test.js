'use strict';
// Unit tests for renderer/lib/sandbox-view.js — the Sandbox dialog's pure copy
// selection (docs/sandbox-plan.md M2). The install-vs-daemon-down distinction is
// the branch that matters (different remedy), so it's pinned here.

const test = require('node:test');
const assert = require('node:assert');
const { detectNotice, sandboxActionGate, statusNotice, openUrl, portsLineText } = require('../renderer/lib/sandbox-view');

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

// ── sandboxActionGate: the docker action gate (Task 8) ──────────────────────
// Stop must NEVER be gated (cleanup stays reachable), so 'stop' is absent from
// the disabled set in every state; Start/Rebuild/box-row-Start/box-create are
// gated whenever docker is not running.
const GATED = ['start', 'rebuild', 'boxStart', 'boxCreate'];

test('sandboxActionGate: docker not installed → all start/build actions disabled, Stop free', () => {
  const g = sandboxActionGate({ present: false, running: false });
  assert.strictEqual(g.running, false);
  assert.deepStrictEqual(g.disabled, GATED);
  assert.strictEqual(g.disabled.includes('stop'), false, 'Stop is never gated');
  assert.match(g.reason, /installed/i);           // the not-installed remedy
  assert.strictEqual(g.notice.kind, 'error');
});

test('sandboxActionGate: daemon down → same disabled set, daemon-down reason', () => {
  const g = sandboxActionGate({ present: true, running: false });
  assert.strictEqual(g.running, false);
  assert.deepStrictEqual(g.disabled, GATED);
  assert.match(g.reason, /running/i);             // start-the-daemon remedy
  assert.strictEqual(g.notice.kind, 'warn');
});

test('sandboxActionGate: docker running → nothing disabled, no reason', () => {
  const g = sandboxActionGate({ present: true, running: true });
  assert.strictEqual(g.running, true);
  assert.deepStrictEqual(g.disabled, []);
  assert.strictEqual(g.reason, null);
});

test('sandboxActionGate: missing/undefined detect reads as not installed (fully gated)', () => {
  assert.deepStrictEqual(sandboxActionGate(undefined).disabled, GATED);
  assert.deepStrictEqual(sandboxActionGate(null).disabled, GATED);
  assert.strictEqual(sandboxActionGate({}).running, false);
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
