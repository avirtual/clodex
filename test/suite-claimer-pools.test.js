'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSuiteClaimer, CLAIMER_CONCURRENCY, POLL_CONCURRENCY, REPLY_RESERVE_MS } = require('../suite-claimer');
const { PeerConnection } = require('../peer-client');

function fakeTime() {
  let t = 0;
  const armed = new Set();
  const delays = [];
  return {
    clock: () => t,
    timers: {
      setTimeout(fn, ms) { const h = { at: t + ms, fn }; armed.add(h); delays.push(ms); return h; },
      clearTimeout(h) { armed.delete(h); },
    },
    advance(ms) {
      t += ms;
      for (const h of [...armed].sort((a, b) => a.at - b.at)) if (h.at <= t && armed.has(h)) { armed.delete(h); h.fn(); }
    },
    armed,
    delays,
  };
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

function held() {
  const gates = [];
  const started = [];
  const exec = (call) => {
    started.push(`${call.method} ${call.path}`);
    return new Promise((resolve) => gates.push(() => resolve({ status: 200, body: { ok: true } })));
  };
  return { gates, started, exec };
}

const poll = (id, wait = 25000, ttlMs = 35000) => ({ id, claim: `k-${id}`, ttlMs, method: 'GET', path: `/api/suite/jobs?ids=${id}&wait=${wait}`, headers: {}, body: null });
const call = (id, method, path, ttlMs = 600000, body = null) => ({ id, claim: `k-${id}`, ttlMs, method, path, headers: {}, body });

function batches(list) {
  const answers = list.map((calls) => (Array.isArray(calls) ? { status: 200, body: { ok: true, calls } } : calls));
  const claims = [];
  return { claims, claim: async (s) => { claims.push(s); return answers.shift() || { status: 200, body: { ok: true, calls: [] } }; } };
}

test('claim fails three times then succeeds: retries wait 500, 1000, 2000, the fourth claim\'s call runs, and the next failure waits 500 again', async () => {
  const ft = fakeTime();
  const fail = { status: 0, body: null, error: 'timeout' };
  const b = batches([fail, fail, fail, [call('d1', 'DELETE', '/api/suite/jobs/j1')], [], fail]);
  const executed = [];
  const claimer = createSuiteClaimer({
    claim: b.claim, blob: async () => ({ status: 404 }), reply: async () => ({ status: 200 }),
    execute: async (c) => { executed.push(`${c.method} ${c.path}`); return { status: 200, body: { ok: true } }; },
    clock: ft.clock, timers: ft.timers, random: () => 0.5,
  });
  await claimer.ring();
  for (const ms of [500, 1000, 2000]) { ft.advance(ms); await flush(); }
  assert.deepStrictEqual([b.claims.length, executed], [5, ['DELETE /api/suite/jobs/j1']]);
  await claimer.ring();
  assert.deepStrictEqual(ft.delays, [500, 1000, 2000, 500]);
  claimer.stop();
});

test('stop() during a pending retry: no further claim and no timer left', async () => {
  const ft = fakeTime();
  const b = batches([{ status: 0, error: 'socket hang up' }]);
  const claimer = createSuiteClaimer({
    claim: b.claim, blob: async () => ({ status: 404 }), reply: async () => ({ status: 200 }), execute: async () => ({ status: 200, body: {} }),
    clock: ft.clock, timers: ft.timers, random: () => 0.5,
  });
  await claimer.ring();
  assert.strictEqual(ft.armed.size, 1, 'ENTER: a retry is pending');
  claimer.stop();
  ft.advance(60000);
  await flush();
  assert.deepStrictEqual([b.claims.length, ft.armed.size], [1, 0]);
});

test('ready() false: no retry is scheduled and no claim runs; turning ready and ringing claims', async () => {
  const ft = fakeTime();
  let up = true;
  const claims = [];
  const claimer = createSuiteClaimer({
    claim: async () => { claims.push(1); up = false; return { status: 0, error: 'timeout' }; },
    blob: async () => ({ status: 404 }), reply: async () => ({ status: 200 }), execute: async () => ({ status: 200, body: {} }),
    ready: () => up, clock: ft.clock, timers: ft.timers, random: () => 0.5,
  });
  await claimer.ring();
  await claimer.ring();
  assert.deepStrictEqual([claims.length, ft.armed.size], [1, 0]);
  up = true;
  await claimer.ring();
  assert.strictEqual(claims.length, 2);
  claimer.stop();
});

test('nine blocking status polls: eight run, one waits, and a submit and an info call still run and reply', async () => {
  const ft = fakeTime();
  const h = held();
  const replied = [];
  const polls = Array.from({ length: 9 }, (_, i) => poll(`p${i + 1}`));
  const b = batches([polls, [], [call('s1', 'POST', '/api/suite/jobs', 600000, { team: 't' }), call('i1', 'GET', '/api/suite/info')]]);
  const claimer = createSuiteClaimer({
    claim: b.claim, blob: async () => ({ status: 404 }),
    reply: async (id) => { replied.push(id); return { status: 200 }; },
    execute: (c) => (c.path.startsWith('/api/suite/jobs?') ? h.exec(c) : Promise.resolve({ status: 200, body: { ok: true, id: 'job-1' } })),
    clock: ft.clock, timers: ft.timers,
  });
  await claimer.ring();
  await flush();
  assert.deepStrictEqual([POLL_CONCURRENCY, h.started.length, claimer.status().active, claimer.status().waiting], [8, 8, 8, 1]);
  await claimer.ring();
  await flush();
  assert.deepStrictEqual([replied, h.started.length], [['s1', 'i1'], 8]);
  claimer.stop();
});

test('a GET carrying wait that is not a status poll goes to the general pool', async () => {
  const ft = fakeTime();
  const h = held();
  const blockers = Array.from({ length: 4 }, (_, i) => call(`g${i}`, 'GET', `/api/suite/jobs/j${i}/output?stream=stdout`));
  const others = [
    call('w1', 'GET', '/api/suite/info?wait=5000'),
    call('w2', 'GET', '/api/suite/jobs?wait=5000'),
    call('w3', 'GET', '/api/suite/jobs?ids=a&wait=1.5'),
  ];
  const b = batches([[...blockers, ...others]]);
  const claimer = createSuiteClaimer({
    claim: b.claim, blob: async () => ({ status: 404 }), reply: async () => ({ status: 200 }),
    execute: h.exec, clock: ft.clock, timers: ft.timers,
  });
  await claimer.ring();
  await flush();
  assert.deepStrictEqual([CLAIMER_CONCURRENCY, h.started.length, claimer.status().waiting], [4, 4, 3]);
  h.gates[0]();
  await flush();
  assert.strictEqual(h.started[4], 'GET /api/suite/info?wait=5000');
  claimer.stop();
});

test('a status poll\'s wait is clamped to its remaining lifetime less the reply reserve when it starts', async () => {
  const seen = [];
  for (const [label, startAt] of [['starts at 20000', 20000], ['starts at 30000', 30000]]) {
    const ft = fakeTime();
    const h = held();
    const blockers = Array.from({ length: 8 }, (_, i) => poll(`b${i}`, 25000, 600000));
    const b = batches([[...blockers, poll('late', 25000, 35000)]]);
    const claimer = createSuiteClaimer({
      claim: b.claim, blob: async () => ({ status: 404 }), reply: async () => ({ status: 200 }),
      execute: h.exec, clock: ft.clock, timers: ft.timers,
    });
    await claimer.ring();
    await flush();
    ft.advance(startAt);
    h.gates[0]();
    await flush();
    seen.push([label, h.started[8]]);
    claimer.stop();
  }
  assert.strictEqual(REPLY_RESERVE_MS, 10000);
  assert.deepStrictEqual(seen, [
    ['starts at 20000', 'GET /api/suite/jobs?ids=late&wait=5000'],
    ['starts at 30000', 'GET /api/suite/jobs?ids=late&wait=0'],
  ]);
});

test('a queued call whose lifetime ends is dropped then, logged, and never executed when a slot frees', async () => {
  const seen = [];
  const rows = [
    ['poll pool', Array.from({ length: 8 }, (_, i) => poll(`b${i}`, 25000, 600000)), poll('q1', 25000, 30000)],
    ['general pool', Array.from({ length: 4 }, (_, i) => call(`b${i}`, 'GET', '/api/suite/info', 600000)), call('q2', 'GET', '/api/suite/info', 30000)],
  ];
  for (const [label, blockers, queued] of rows) {
    const ft = fakeTime();
    const h = held();
    const logs = [];
    const b = batches([[...blockers, queued]]);
    const claimer = createSuiteClaimer({
      claim: b.claim, blob: async () => ({ status: 404 }), reply: async () => ({ status: 200 }),
      execute: h.exec, log: (m) => logs.push(m), clock: ft.clock, timers: ft.timers,
    });
    await claimer.ring();
    await flush();
    ft.advance(29999);
    const before = [logs.length, claimer.status().waiting];
    ft.advance(1);
    const at = [logs.slice(), claimer.status().waiting];
    h.gates[0]();
    await flush();
    seen.push([label, before, at, h.started.length]);
    claimer.stop();
  }
  assert.deepStrictEqual(seen, [
    ['poll pool', [0, 1], [['call q1 (GET /api/suite/jobs?ids=q1&wait=25000) is past its deadline; not executed'], 0], 8],
    ['general pool', [0, 1], [['call q2 (GET /api/suite/info) is past its deadline; not executed'], 0], 4],
  ]);
});

test('a call with no ttlMs (an absolute deadline only) is skipped as malformed and nothing throws', async () => {
  const ft = fakeTime();
  const logs = [];
  const executed = [];
  const b = batches([[{ id: 'o1', claim: 'k', deadline: 99999, method: 'GET', path: '/api/suite/info', headers: {}, body: null }]]);
  const claimer = createSuiteClaimer({
    claim: b.claim, blob: async () => ({ status: 404 }), reply: async () => ({ status: 200 }),
    execute: async (c) => { executed.push(c.id); return { status: 200, body: {} }; },
    log: (m) => logs.push(m), clock: ft.clock, timers: ft.timers,
  });
  await claimer.ring();
  await flush();
  assert.deepStrictEqual([logs, executed], [['claim returned a malformed call; skipped'], []]);
  claimer.stop();
});

test('reply outcomes: expired, already settled and any other refusal each log their own line', async () => {
  const seen = [];
  const rows = [
    ['expired', { status: 410, body: { ok: false, error: 'call expired' }, error: null }, 'call r1: reply arrived after the call expired (1234 ms)'],
    ['settled', { status: 410, body: { ok: false, error: 'call already settled' }, error: null }, 'call r1: reply not needed, call already settled'],
    ['other', { status: 503, body: { ok: false, error: 'busy' }, error: null }, 'call r1: reply not accepted (503)'],
  ];
  for (const [label, sent] of rows) {
    const ft = fakeTime();
    const logs = [];
    const b = batches([[call('r1', 'GET', '/api/suite/info')]]);
    const claimer = createSuiteClaimer({
      claim: b.claim, blob: async () => ({ status: 404 }), reply: async () => sent,
      execute: async () => { ft.advance(1234); return { status: 200, body: { ok: true } }; },
      log: (m) => logs.push(m), clock: ft.clock, timers: ft.timers,
    });
    await claimer.ring();
    await flush();
    seen.push([label, logs]);
    claimer.stop();
  }
  assert.deepStrictEqual(seen, rows.map(([label, , line]) => [label, [line]]));
});

test('the events stream opening rings the suite claimer', () => {
  let rings = 0;
  const conn = new PeerConnection({
    id: 'p-lead', label: 'lead', url: 'http://127.0.0.1:1', token: 't', emit: () => {}, selfLabel: 'laptop',
    helloIntervalMs: 600000, suiteClaimer: () => ({ ring: () => { rings += 1; }, stop: () => {}, status: () => null }),
  });
  let handlers = null;
  conn._sse = (_path, h) => { handlers = h; };
  conn._refreshSessions = () => {};
  conn._openEvents();
  assert.strictEqual(rings, 0, 'ENTER: opening the request alone does not ring');
  handlers.onOpen({ destroy() {} });
  assert.strictEqual(rings, 1);
  conn.stop();
});
