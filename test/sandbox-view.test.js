'use strict';
// Unit tests for renderer/lib/sandbox-view.js — the Sandbox dialog's pure copy
// selection (docs/sandbox-plan.md M2). The install-vs-daemon-down distinction is
// the branch that matters (different remedy), so it's pinned here.

const test = require('node:test');
const assert = require('node:assert');
const { detectNotice, sandboxActionGate, sandboxGateTreatment, boxRowStartGated, statusNotice, openUrl, portsLineText } = require('../renderer/lib/sandbox-view');

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

test('detectNotice: {ok:false} detection failure is NOT reported as "not installed"', () => {
  // Regression: deleting the last sandbox routed detect through a box that no
  // longer existed → {ok:false,'no such sandbox'} → the old code lied "Docker
  // isn't installed" and gated create-box. A detection FAILURE must read as a
  // failed check, never as an absence verdict.
  const n = detectNotice({ ok: false, error: 'no such sandbox: ' });
  assert.strictEqual(n.kind, 'error');
  assert.doesNotMatch(n.text, /install/i);
  assert.match(n.text, /check Docker/i);
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

// ── sandboxGateTreatment: element-treatment map (Task 13) ───────────────────
// Docker-down must be OBVIOUS: gated controls disabled AND dimmed, the notice at
// banner weight, Stop always live + undimmed. Start is gated ONLY when the toggle
// would START — a running box's Stop is never gated.

test('sandboxGateTreatment: docker down + box stopped → Start/Rebuild/create all disabled+dimmed, banner up, Stop not live', () => {
  const t = sandboxGateTreatment(sandboxActionGate({ present: true, running: false }), false);
  assert.strictEqual(t.running, false);
  assert.strictEqual(t.gated, true);
  assert.strictEqual(t.startDisabled, true);
  assert.strictEqual(t.dimStart, true);
  assert.strictEqual(t.rebuildDisabled, true);
  assert.strictEqual(t.dimRebuild, true);
  assert.strictEqual(t.boxCreateDisabled, true);
  assert.strictEqual(t.dimBoxCreate, true);
  assert.strictEqual(t.banner, true);
  assert.strictEqual(t.stopLive, false);          // nothing running → no Stop to keep live
  assert.match(t.reason, /running/i);             // daemon-down remedy carried through
});

test('sandboxGateTreatment: docker down + box RUNNING → Stop stays live (not gated/dimmed), Rebuild/create still gated', () => {
  const t = sandboxGateTreatment(sandboxActionGate({ present: false, running: false }), true);
  assert.strictEqual(t.startDisabled, false, 'the toggle is Stop here — never gated');
  assert.strictEqual(t.dimStart, false, 'a live Stop is never dimmed');
  assert.strictEqual(t.stopLive, true);
  assert.strictEqual(t.rebuildDisabled, true, 'Rebuild would recreate — still gated');
  assert.strictEqual(t.dimRebuild, true);
  assert.strictEqual(t.boxCreateDisabled, true);
  assert.strictEqual(t.banner, true);
  assert.match(t.reason, /installed/i);           // not-installed remedy carried through
});

test('sandboxGateTreatment: docker running → nothing gated/dimmed, no banner, reason null', () => {
  for (const running of [false, true]) {
    const t = sandboxGateTreatment(sandboxActionGate({ present: true, running: true }), running);
    assert.strictEqual(t.gated, false);
    assert.strictEqual(t.startDisabled, false);
    assert.strictEqual(t.rebuildDisabled, false);
    assert.strictEqual(t.boxCreateDisabled, false);
    assert.strictEqual(t.dimStart, false);
    assert.strictEqual(t.dimRebuild, false);
    assert.strictEqual(t.dimBoxCreate, false);
    assert.strictEqual(t.banner, false);
    assert.strictEqual(t.reason, null);
  }
});

test('sandboxGateTreatment: missing/undefined gate reads as gated (pessimistic), notice defined', () => {
  const t = sandboxGateTreatment(undefined, false);
  assert.strictEqual(t.gated, true);
  assert.strictEqual(t.boxCreateDisabled, true);
  assert.ok(t.notice && typeof t.notice.text === 'string', 'a notice is always present for the banner');
});

// ── boxRowStartGated: per-row Start gating (each row carries its own running) ──
test('boxRowStartGated: docker down gates a STOPPED row Start, never a running row Stop', () => {
  assert.strictEqual(boxRowStartGated(false, false), true, 'docker down + row stopped → Start gated');
  assert.strictEqual(boxRowStartGated(false, true), false, 'docker down + row running → Stop stays live');
  assert.strictEqual(boxRowStartGated(true, false), false, 'docker up → Start free');
  assert.strictEqual(boxRowStartGated(true, true), false, 'docker up + running → Stop free');
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
