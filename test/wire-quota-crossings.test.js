'use strict';

process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert');
const { QuotaStore, quotaCrossings } = require('../wire/quota');
const { createSessionManager } = require('../session-manager');

const R1 = 1893524400;
const R2 = 1893542400;

const snap = (util, { status = 'allowed', winStatus = 'allowed', reset = R1 } = {}) => ({
  status,
  representative_window: '5h',
  windows: { '5h': { window: '5h', utilization: util, status: winStatus, reset } },
});

for (const [name, prev, next, want] of [
  ['60 → 85', snap(0.60), snap(0.85), [{ window: '5h', threshold: 80 }]],
  ['85 → 96', snap(0.85), snap(0.96), [{ window: '5h', threshold: 95 }]],
  ['60 → 100', snap(0.60), snap(1.0), [{ window: '5h', threshold: 80 }, { window: '5h', threshold: 95 }, { window: '5h', threshold: 100 }]],
  ['96 → 96', snap(0.96), snap(0.96), []],
  ['top-level rejected at 40%', snap(0.30), snap(0.40, { status: 'rejected' }), [{ window: '5h', threshold: 100 }]],
  ['window rejected at 40%', snap(0.30), snap(0.40, { winStatus: 'rejected' }), [{ window: '5h', threshold: 100 }]],
  ['99 → 20 on a new reset', snap(0.99), snap(0.20, { reset: R2 }), []],
  ['20 → 85 after the reset', snap(0.20, { reset: R2 }), snap(0.85, { reset: R2 }), [{ window: '5h', threshold: 80 }]],
  ['nothing before → 85', null, snap(0.85), [{ window: '5h', threshold: 80 }]],
]) {
  test(`quotaCrossings: ${name}`, () => {
    assert.deepStrictEqual(quotaCrossings(prev, next), want);
  });
}

test('quotaCrossings: a window with no utilization (a disabled overage at rejected) never crosses', () => {
  const next = snap(0.30);
  next.windows.overage = { window: 'overage', utilization: null, status: 'rejected', reset: null };
  assert.deepStrictEqual(quotaCrossings(snap(0.30), next), []);
});

const ACCT = 'opsguru';
const hdrs = (u5, reset = R1) => ({
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-5h-utilization': String(u5),
  'anthropic-ratelimit-unified-5h-reset': String(reset),
  'anthropic-ratelimit-unified-5h-status': 'allowed',
});

test('the store dedupes a crossing per (window, threshold, reset) and re-arms on a new reset', () => {
  const store = new QuotaStore();
  const take = (u, reset, at) => {
    store.note(hdrs(u, reset), { status: 200, now: at, account: ACCT });
    return store.takeCrossings().map((c) => `${c.window}:${c.threshold}`);
  };
  assert.deepStrictEqual(take(0.60, R1, R1 - 9000), []);
  assert.deepStrictEqual(take(0.85, R1, R1 - 8000), ['5h:80']);
  assert.deepStrictEqual(take(0.79, R1, R1 - 7000), []);
  assert.deepStrictEqual(take(0.81, R1, R1 - 6000), [], 'a dip and re-cross in the same window is not news');
  assert.deepStrictEqual(take(0.20, R2, R1 + 10), []);
  assert.deepStrictEqual(take(0.85, R2, R1 + 20), ['5h:80'], 'a new reset notifies again');
});

function mkHost() {
  const notes = [];
  const dms = [];
  const root = '/proj';
  const team = { name: 'team', root, lead: 'lead', roles: {} };
  const SessionManager = createSessionManager({
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    getNotifications: () => ({ add: (n) => { notes.push(n); return n; } }),
    resolveTeam: (cwd) => {
      if (cwd && cwd.startsWith('/codexteam')) return { name: 'codexteam', root: '/codexteam', lead: 'codex-lead', roles: {} };
      return cwd && cwd.startsWith(root) ? team : null;
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  const m = new SessionManager();
  m._broadcast = () => {};
  m._shadowLog = (e) => { throw new Error(`unexpected shadow log: ${JSON.stringify(e)}`); };
  m._deliverMessage = (to, from, body, kind) => { dms.push({ to, from, body, kind }); };
  for (const name of ['lead', 'team-hand-1', 'other']) {
    m.sessions.set(name, { name, agentType: 'claude', cwd: name === 'other' ? '/elsewhere' : `${root}/x` });
  }
  m.sessions.set('team-codex-1', { name: 'team-codex-1', agentType: 'codex', cwd: `${root}/y` });
  m.sessions.set('codex-lead', { name: 'codex-lead', agentType: 'codex', cwd: '/codexteam/z' });
  m.accountFor = (name) => (name === 'other' ? 'personal' : ACCT);
  m._accountForWireAgent = () => ACCT;
  const store = new QuotaStore();
  const respond = (u5, status = 200) => m._noteQuotaResponse(store, {
    agent: 'team-hand-1', status, headers: status === 429 ? {} : hdrs(u5),
  });
  return { m, store, notes, dms, respond };
}

test('host: one inbox note per crossing with the literal body head, none on a 429 or a repeat', () => {
  const h = mkHost();
  h.respond(0.60);
  assert.deepStrictEqual(h.notes, [], 'ENTER: 60% is below every threshold');
  h.respond(0.85);
  assert.strictEqual(h.notes.length, 1);
  assert.strictEqual(h.notes[0].from, 'clodex');
  assert.ok(h.notes[0].body.startsWith('Claude plan (account opsguru): 5-hour window at 85% — resets 19:00 (in '), h.notes[0].body);
  assert.ok(h.notes[0].body.endsWith('Seats on this account: lead, team-hand-1.'), h.notes[0].body);
  h.respond(0.85);
  h.respond(null, 429);
  assert.strictEqual(h.notes.length, 1);
  assert.deepStrictEqual(h.dms, [], 'no lead dm below exhaustion');
});

test('host: exhaustion notes and dms each lead once per (account, reset), naming the seats', () => {
  const h = mkHost();
  h.respond(0.60);
  h.respond(1.0);
  assert.deepStrictEqual(h.notes.map((n) => n.body.slice(0, 60)), [
    'Claude plan (account opsguru): 5-hour window at 100% — reset',
    'Claude plan (account opsguru): 5-hour window at 100% — reset',
    'Claude plan (account opsguru): 5-hour window EXHAUSTED — res',
  ]);
  assert.match(h.notes[2].body, /Seats on this account will fail until then: lead, team-hand-1\.$/);
  assert.ok(h.notes.every((n) => !n.body.includes('codex')), 'a codex seat is not on the Claude plan');
  assert.deepStrictEqual(h.dms, [{
    to: 'lead', from: 'clodex', kind: 'dm',
    body: '[quota] account opsguru: 5-hour window exhausted, resets 19:00 — seats on it (lead, team-hand-1) will fail until then; move the role ([agent:team role-set <role> account:<other>]) or wait.',
  }]);
  h.respond(1.0);
  h.m._dmLeadsQuotaExhausted({ account: ACCT, reset: R1 }, [...h.m.sessions.values()], '5-hour window', '19:00');
  assert.strictEqual(h.dms.length, 1);
});
