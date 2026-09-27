'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mk } = require('./lib/session-fixtures');
const { COMPACTING_VALVE_MS, mergeCompactNotices } = require('../compact-notices');
const { liveSnapshotFor } = require('../session-restore');

function fakeWin() {
  const win = {
    sent: [],
    webContents: { send: (...a) => win.sent.push(a) },
    isDestroyed: () => false,
    isFocused: () => true,
    show() {}, focus() {},
  };
  return win;
}

function seat() {
  const m = mk({
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    registry: { unregister: () => {} },
    cleanupClaudeHook: () => {}, cleanupSkills: () => {}, cleanupAgentPlugin: () => {},
  });
  const win = fakeWin();
  m.registerWindow('ws1', win);
  const s = { name: 'a', workspaceId: 'ws1', agentType: 'claude' };
  m.sessions.set('a', s);
  const broadcasts = [];
  m._broadcast = (ch, msg) => broadcasts.push([ch, msg]);
  return { m, s, win, broadcasts };
}

const compactingSends = (win) => win.sent.filter((x) => x[0] === 'session-compacting');

test('attention routing: a PreCompact entry reaches _onCompactStart with its trigger and never _onAttention', () => {
  const { m, s } = seat();
  const starts = [];
  const attns = [];
  m._onCompactStart = (sess, trigger) => starts.push([sess.name, trigger]);
  m._onAttention = (sess, entry) => attns.push(entry);
  m._routeAttnEntry(s, { hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'x' });
  assert.deepStrictEqual(starts, [['a', 'auto']], 'ENTER: the PreCompact entry reached _onCompactStart');
  assert.deepStrictEqual(attns, []);
  m._routeAttnEntry(s, { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
  m._routeAttnEntry(s, null);
  assert.strictEqual(attns.length, 2, 'Notification and unparseable lines still reach _onAttention');
  assert.strictEqual(starts.length, 1);
});

test('start → end: sets the display state, sends it, notices the pane, and clears on the compact summary', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { m, s, win, broadcasts } = seat();
  m._onCompactStart(s, 'manual');
  assert.deepStrictEqual(s.compacting, { since: 1_000_000, trigger: 'manual' });
  assert.deepStrictEqual(compactingSends(win), [['session-compacting', 'a', { since: 1_000_000, trigger: 'manual' }]]);
  assert.ok(!win.sent.some((x) => x[0] === 'transcript-changed'), 'nothing new for the pane to pull at start');
  assert.deepStrictEqual(broadcasts.map((b) => b[1].body), ['compact started (manual)']);
  assert.strictEqual(m.compactNoticesFor('a'), null);

  t.mock.timers.tick(100_000);
  m._onCompactEnd(s);
  assert.strictEqual(s.compacting, null);
  assert.strictEqual(s._compactingValveTimer, null);
  assert.deepStrictEqual(compactingSends(win).at(-1), ['session-compacting', 'a', null, { outcome: 'done', ms: 100_000 }]);
  assert.strictEqual(broadcasts.at(-1)[1].body, 'compact finished in 100s');
  const after = m.compactNoticesFor('a');
  assert.deepStrictEqual(after.notices, [{ id: 'compact:1000000', ts: 1000000, ms: 100000, outcome: 'done', text: 'Compacted in 1m 40s' }]);
  assert.ok(win.sent.some((x) => x[0] === 'transcript-changed'), 'the pane is told to re-pull');

  const sends = win.sent.length;
  m._onCompactEnd(s);
  assert.strictEqual(win.sent.length, sends, 'idempotent when nothing is in flight');
});

test('SessionStart compact line alone ends the compact and rewrites the notice, without _onAttention', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { m, s, win } = seat();
  const attns = [];
  m._onAttention = (sess, entry) => attns.push(entry);
  m._routeAttnEntry(s, { hook_event_name: 'PreCompact', trigger: 'auto' });
  assert.ok(s.compacting, 'ENTER: compacting after PreCompact');
  t.mock.timers.tick(42_000);
  m._routeAttnEntry(s, { hook_event_name: 'SessionStart', source: 'compact' });
  assert.strictEqual(s.compacting, null);
  assert.deepStrictEqual(compactingSends(win).at(-1), ['session-compacting', 'a', null, { outcome: 'done', ms: 42_000 }]);
  assert.deepStrictEqual(m.compactNoticesFor('a').notices, [{ id: 'compact:0', ts: 0, ms: 42000, outcome: 'done', text: 'Compacted in 42s' }]);
  m._routeAttnEntry(s, { hook_event_name: 'SessionStart', source: 'startup' });
  assert.deepStrictEqual(attns, [], 'SessionStart lines never reach _onAttention');
});

test('_fireCompactContinuation ends the compacting display first', () => {
  const { m, s } = seat();
  const boom = new Error('stop here');
  let ended = null;
  m._onCompactEnd = (sess) => { ended = sess; throw boom; };
  assert.throws(() => m._fireCompactContinuation(s), (e) => e === boom);
  assert.strictEqual(ended, s);
});

test('valve: no end signal within five minutes clears the state', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { m, s, win } = seat();
  m._onCompactStart(s, 'auto');
  t.mock.timers.tick(COMPACTING_VALVE_MS - 1);
  assert.ok(s.compacting, 'still compacting just under the valve');
  t.mock.timers.tick(1);
  assert.strictEqual(s.compacting, null);
  assert.deepStrictEqual(compactingSends(win).at(-1), ['session-compacting', 'a', null, { outcome: 'valve', ms: COMPACTING_VALVE_MS }]);
  assert.deepStrictEqual(m.compactNoticesFor('a').notices.map((n) => n.text), ['Compact did not report back']);
});

test('valve does not touch the injection hold', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { m, s } = seat();
  s._compactGuard = true;
  s._compactPending = { cmd: '/compact' };
  m._onCompactStart(s, 'manual');
  assert.strictEqual(s._compactValveTimer, undefined);
  t.mock.timers.tick(COMPACTING_VALVE_MS);
  assert.strictEqual(s._compactGuard, true);
  assert.deepStrictEqual(s._compactPending, { cmd: '/compact' });
});

test('kill: _cleanup clears a compacting seat', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { m, s, win } = seat();
  m._onCompactStart(s, 'manual');
  assert.ok(s.compacting, 'ENTER: compacting before cleanup');
  m._cleanup('a');
  assert.strictEqual(s.compacting, null);
  assert.strictEqual(s._compactingValveTimer, null);
  assert.deepStrictEqual(compactingSends(win).at(-1)[3], { outcome: 'exit', ms: 0 });
});

test('snapshot: liveSnapshotFor carries compacting so a reopened window renders it', () => {
  const manager = { teamNameFor: () => null, pendingCountFor: () => 0, sessions: new Map() };
  const row = liveSnapshotFor({
    manager, entry: { name: 'a', type: 'claude', cwd: '/x' },
    session: { name: 'a', compacting: { since: 5, trigger: 'auto' } },
    readCtxFor: () => ({}), proxyPoller: { snapshot: () => null },
  });
  assert.deepStrictEqual(row.compacting, { since: 5, trigger: 'auto' });
});

test('snapshot: liveSnapshotFor carries the approval posture of a codex bypass seat', () => {
  const manager = { teamNameFor: () => null, pendingCountFor: () => 0, sessions: new Map() };
  const row = liveSnapshotFor({
    manager, entry: { name: 'a', type: 'codex', cwd: '/x', extraArgs: ['--dangerously-bypass-approvals-and-sandbox'] },
    session: { name: 'a' },
    readCtxFor: () => ({}), proxyPoller: { snapshot: () => null },
  });
  assert.strictEqual(row.posture, 'bypass');
});

test('mergeCompactNotices: places the notice after the last record at or before its time, in that turn', () => {
  const recs = [
    { id: 'r1', kind: 'prompt', ts: 10, turn: 1 },
    { id: 'r2', kind: 'assistant', ts: null, turn: 1 },
    { id: 'r3', kind: 'assistant', ts: 20, turn: 1 },
    { id: 'r4', kind: 'prompt', ts: 40, turn: 2 },
  ];
  const out = mergeCompactNotices(recs, [{ id: 'compact:30', ts: 30, ms: 10000, outcome: 'done', text: 'Compacted in 10s' }]);
  assert.deepStrictEqual(out.map((r) => r.id), ['r1', 'r2', 'r3', 'compact:30', 'r4']);
  assert.deepStrictEqual(out[3], { id: 'compact:30', kind: 'notice', level: 'info', ts: 30, turn: 1, text: 'Compacted in 10s' });
  assert.strictEqual(recs.length, 4, 'the reader cache is not mutated');
});

test('mergeCompactNotices: a finished notice folds into the compact boundary at or after its time as elapsedMs, with no notice row', () => {
  const recs = [
    { id: 'r1', kind: 'prompt', ts: 10, turn: 1 },
    { id: 'b1', kind: 'boundary', ts: 40, turn: 1, what: 'compact', trigger: 'manual', preTokens: 100, postTokens: 10 },
  ];
  const out = mergeCompactNotices(recs, [{ id: 'compact:30', ts: 30, ms: 10000, outcome: 'done', text: 'Compacted in 10s' }]);
  assert.deepStrictEqual(out, [
    { id: 'r1', kind: 'prompt', ts: 10, turn: 1 },
    { id: 'b1', kind: 'boundary', ts: 40, turn: 1, what: 'compact', trigger: 'manual', preTokens: 100, postTokens: 10, elapsedMs: 10000 },
  ]);
  assert.deepStrictEqual(recs[1], { id: 'b1', kind: 'boundary', ts: 40, turn: 1, what: 'compact', trigger: 'manual', preTokens: 100, postTokens: 10 });
});

test('mergeCompactNotices: a notice spliced in ahead of a folded boundary does not let a later notice fold into that boundary again', () => {
  const recs = [
    { id: 'b1', kind: 'boundary', ts: 10, turn: 1, what: 'compact' },
    { id: 'b2', kind: 'boundary', ts: 20, turn: 1, what: 'compact' },
  ];
  const out = mergeCompactNotices(recs, [
    { id: 'c5', ts: 5, ms: 1000, outcome: 'done', text: 'Compacted in 1s' },
    { id: 'c1', ts: 1, outcome: 'timeout', text: 'Compact did not report back' },
    { id: 'c6', ts: 6, ms: 2000, outcome: 'done', text: 'Compacted in 2s' },
  ]);
  assert.deepStrictEqual(out, [
    { id: 'c1', kind: 'notice', level: 'info', ts: 1, turn: 1, text: 'Compact did not report back' },
    { id: 'b1', kind: 'boundary', ts: 10, turn: 1, what: 'compact', elapsedMs: 1000 },
    { id: 'b2', kind: 'boundary', ts: 20, turn: 1, what: 'compact', elapsedMs: 2000 },
  ]);
});

test('renderer: listens on onSessionCompacting and ticks the compacting rows', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(src, /window\.api\.onSessionCompacting\(\(name, c\) => \{[\s\S]{0,200}applyCompacting\(el, c\)/);
  assert.match(src, /querySelectorAll\('[^']*\.session-item\[data-compacting-since\]'\)\) applyThinkBadge\(el\)/);
  assert.match(src, /if \(entry\.compacting\) applyCompacting\(item, entry\.compacting\)/);
});
