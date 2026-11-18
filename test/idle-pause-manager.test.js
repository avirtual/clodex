'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { mkPark } = require('./lib/session-fixtures');

const H = 3600000;

function mkManager() {
  const records = new Map();
  const persistence = {
    list: () => [...records.values()],
    get: (n) => records.get(n) || null,
    setArchived: (n, on, cause = null) => {
      const r = records.get(n);
      if (!r) return;
      if (on) r.archivedAt = Date.now(); else delete r.archivedAt;
      if (on && cause) r.archiveCause = cause; else delete r.archiveCause;
    },
  };
  const { m } = mkPark({ getPersistence: () => persistence });
  const sent = [];
  m._sendToSession = (name, ch, payload) => sent.push([name, ch, payload]);
  const old = Date.now() - 60 * H;
  for (const name of ['a', 'b', 'c']) {
    records.set(name, { name, type: 'claude' });
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd: '/nowhere', io: 'stream', activityTs: old, stream: { kill() {} } });
  }
  return { m, records, sent };
}

test('pauseIdle re-checks each session and skips one that became busy', async () => {
  const { m, records, sent } = mkManager();
  const survey = m.idlePauseSurvey(Date.now(), 48 * H);
  assert.deepStrictEqual(survey.map((r) => [r.name, r.reason]), [['a', null], ['b', null], ['c', null]],
    'ENTER: all three were pausable when the dialog opened');
  m.sessions.get('b').streamBusy = true;
  const res = await m.pauseIdle(['a', 'b', 'c'], { thresholdMs: 48 * H });
  assert.deepStrictEqual(res, { paused: 2, skipped: 1 });
  assert.deepStrictEqual(['a', 'b', 'c'].map((n) => !!m.sessions.get(n)._archived), [true, false, true]);
  for (const n of ['a', 'c']) {
    assert.ok(Number.isFinite(records.get(n).archivedAt), `${n} has archivedAt`);
    assert.strictEqual(records.get(n).archiveCause, 'idle');
  }
  assert.deepStrictEqual(records.get('b'), { name: 'b', type: 'claude' });
  assert.deepStrictEqual(sent, [
    ['a', 'session:context-action', { action: 'retired', name: 'a', disposition: 'archive' }],
    ['c', 'session:context-action', { action: 'retired', name: 'c', disposition: 'archive' }],
  ]);
});

test('pauseIdle skips a session that turned active since the dialog opened', async () => {
  const { m, records } = mkManager();
  m.sessions.get('a').activityTs = Date.now();
  const res = await m.pauseIdle(['a', 'gone'], { thresholdMs: 48 * H });
  assert.deepStrictEqual(res, { paused: 0, skipped: 2 });
  assert.strictEqual('archivedAt' in records.get('a'), false);
});

test('the survey reads each exempt signal off the live session', () => {
  const { m } = mkManager();
  m.sessions.get('a').streamPermissions = new Map([['x', {}]]);
  m.sessions.get('b')._compactPending = true;
  m.sessions.set('sh', { name: 'sh', type: 'bash', cwd: '/nowhere', activityTs: Date.now() - 60 * H });
  m.sessions.set('pty', { name: 'pty', type: 'claude', agentType: 'claude', cwd: '/nowhere', io: 'pty', needsAttention: { kind: 'permission', ts: 0 }, activityTs: Date.now() - 60 * H });
  const out = m.idlePauseSurvey(Date.now(), 48 * H);
  assert.deepStrictEqual(out.map((r) => [r.name, r.reason]), [
    ['a', 'a dialog is open'], ['b', 'a reload or compact is in flight'], ['c', null], ['sh', 'a shell session cannot be resumed'],
    ['pty', 'a dialog is open'],
  ]);
});
