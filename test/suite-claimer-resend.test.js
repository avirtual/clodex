'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSuiteClaimer } = require('../suite-claimer');

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
const del = (id, ttlMs = 600000) => ({ id, claim: `k-${id}`, ttlMs, method: 'DELETE', path: `/api/suite/jobs/${id}`, headers: {}, body: null });
const poll = (id) => ({ id, claim: `k-${id}`, ttlMs: 35000, method: 'GET', path: `/api/suite/jobs?ids=${id}&wait=5000`, headers: {}, body: null });
const HANG = { status: 0, body: null, error: 'socket hang up' };
const TIMEOUT = { status: 0, body: null, error: 'timeout' };
const OK = { status: 200, body: { ok: true }, error: null };

function setup({ calls, answers = () => TIMEOUT, execute, pollConcurrency } = {}) {
  const ft = fakeTime();
  const logs = [];
  const sends = [];
  const executed = [];
  const batches = [{ status: 200, body: { ok: true, calls } }];
  const claimer = createSuiteClaimer({
    claim: async () => batches.shift() || { status: 200, body: { ok: true, calls: [] } },
    blob: async () => ({ status: 404 }),
    reply: async (id, claim, answer, timeoutMs) => {
      sends.push({ id, answer, timeoutMs });
      return answers(id, sends.filter((s) => s.id === id).length);
    },
    execute: execute || (async (c) => { executed.push(c.id); return { status: 200, body: { ok: true, id: c.id } }; }),
    log: (m) => logs.push(m), clock: ft.clock, timers: ft.timers, random: () => 0.5,
    ...(pollConcurrency ? { pollConcurrency } : {}),
  });
  return { ft, logs, sends, executed, claimer };
}

async function steps(ft, n, ms) {
  for (let i = 0; i < n; i++) { ft.advance(ms); await flush(); }
}

test('two transport failures then 200: the same answer is sent three times, 250 then 500 ms apart, executed once', async () => {
  const s = setup({ calls: [del('d1')], answers: (_id, n) => (n < 3 ? HANG : OK) });
  await s.claimer.ring();
  await flush();
  await steps(s.ft, 1, 250);
  await steps(s.ft, 1, 500);
  const answer = { status: 200, body: { ok: true, id: 'd1' } };
  assert.deepStrictEqual(s.sends.map((x) => x.answer), [answer, answer, answer]);
  assert.deepStrictEqual(s.ft.delays, [250, 500]);
  assert.deepStrictEqual(s.executed, ['d1']);
  assert.deepStrictEqual(s.logs, ['call d1: reply failed (socket hang up), resending', 'call d1: reply delivered on attempt 3']);
  assert.deepStrictEqual([s.claimer.status().resending, s.ft.armed.size], [0, 0]);
  s.claimer.stop();
});

test('a resend answered 410 call already settled is the first send confirmed, not a failure', async () => {
  const settled = { status: 410, body: { ok: false, error: 'call already settled' }, error: null };
  const s = setup({ calls: [del('d1')], answers: (_id, n) => (n === 1 ? HANG : settled) });
  await s.claimer.ring();
  await flush();
  await steps(s.ft, 8, 1000);
  assert.deepStrictEqual([s.sends.length, s.logs], [2, ['call d1: reply failed (socket hang up), resending', 'call d1: reply delivered (confirmed on resend)']]);
});

test('terminal answers on the first send are never resent', async () => {
  const rows = [
    ['expired', { status: 410, body: { ok: false, error: 'call expired' }, error: null }, 'call d1: reply arrived after the call expired (0 ms)'],
    ['conflict', { status: 409, body: { ok: false, error: 'wrong claim token' }, error: null }, 'call d1: reply not accepted (409)'],
    ['bad', { status: 400, body: { ok: false, error: 'bad reply' }, error: null }, 'call d1: reply not accepted (400)'],
  ];
  const seen = [];
  for (const [label, sent] of rows) {
    const s = setup({ calls: [del('d1')], answers: () => sent });
    await s.claimer.ring();
    await flush();
    await steps(s.ft, 8, 1000);
    seen.push([label, s.sends.length, s.logs]);
    s.claimer.stop();
  }
  assert.deepStrictEqual(seen, rows.map(([label, , line]) => [label, 1, [line]]));
});

test('a call with 3000 ms left gives up before its lifetime ends', async () => {
  const s = setup({ calls: [del('d1', 3000)] });
  const at = [];
  await s.claimer.ring();
  await flush();
  for (let i = 0; i < 12; i++) {
    s.ft.advance(250);
    await flush();
    if (s.logs.length === 2 && !at.length) at.push(s.ft.clock());
  }
  assert.deepStrictEqual([s.sends.length, s.logs, at, s.ft.armed.size], [
    4,
    ['call d1: reply failed (timeout), resending', 'call d1: reply not accepted (timeout) after 4 attempts'],
    [1750],
    0,
  ]);
});

test('six failing attempts with a long lifetime: six sends, then the give-up line', async () => {
  const s = setup({ calls: [del('d1')], answers: () => ({ status: 503, body: { ok: false }, error: null }) });
  await s.claimer.ring();
  await flush();
  await steps(s.ft, 40, 250);
  assert.deepStrictEqual([s.sends.length, s.logs, s.ft.delays, s.claimer.status().resending], [
    6,
    ['call d1: reply failed (503), resending', 'call d1: reply not accepted (503) after 6 attempts'],
    [250, 500, 1000, 1000, 1000],
    0,
  ]);
});

test('a reply waiting for resend frees its poll slot for the next poll', async () => {
  const gates = [];
  const started = [];
  const execute = (c) => {
    started.push(c.id);
    return new Promise((resolve) => gates.push(() => resolve({ status: 200, body: { ok: true } })));
  };
  const s = setup({ calls: [poll('p1'), poll('p2'), poll('p3')], execute, pollConcurrency: 2, answers: (id) => (id === 'p1' ? HANG : OK) });
  await s.claimer.ring();
  await flush();
  const full = s.claimer.status();
  assert.deepStrictEqual([started, full.active, full.waiting, full.resending], [['p1', 'p2'], 2, 1, 0]);
  gates[0]();
  await flush();
  const after = s.claimer.status();
  assert.deepStrictEqual([started, after.active, after.waiting, after.resending], [['p1', 'p2', 'p3'], 2, 0, 1]);
  s.claimer.stop();
});

test('past 64 pending resends the oldest is dropped', async () => {
  const s = setup({ calls: Array.from({ length: 65 }, (_, i) => del(`d${i}`)) });
  await s.claimer.ring();
  await flush();
  assert.deepStrictEqual([s.claimer.status().resending, s.ft.armed.size], [64, 64]);
  assert.ok(s.logs.includes('call d0: reply not accepted (timeout) (resend dropped: too many pending)'));
  await steps(s.ft, 1, 250);
  assert.deepStrictEqual([s.sends.filter((x) => x.id === 'd0').length, s.sends.filter((x) => x.id === 'd1').length], [1, 2]);
  s.claimer.stop();
});

test('past 8 MiB of held bodies the oldest pending resend is dropped', async () => {
  const big = 'x'.repeat(3 * 1024 * 1024);
  const execute = async () => ({ status: 200, body: { o: big } });
  const s = setup({ calls: [del('d0'), del('d1'), del('d2')], execute });
  await s.claimer.ring();
  await flush();
  assert.deepStrictEqual([s.claimer.status().resending, s.logs.filter((l) => l.includes('resend dropped'))], [
    2, ['call d0: reply not accepted (timeout) (resend dropped: too many pending)'],
  ]);
  s.claimer.stop();
});

test('stop() with resends pending clears every timer and sends nothing more', async () => {
  const s = setup({ calls: [del('d0'), del('d1'), del('d2')] });
  await s.claimer.ring();
  await flush();
  assert.strictEqual(s.claimer.status().resending, 3, 'ENTER: three resends pending');
  s.claimer.stop();
  assert.deepStrictEqual([s.ft.armed.size, s.claimer.status().resending], [0, 0]);
  await steps(s.ft, 10, 1000);
  assert.strictEqual(s.sends.length, 3);
});

test('each reply request is timed out at the call\'s remaining lifetime', async () => {
  const s = setup({ calls: [del('d1', 4000)], answers: () => OK });
  await s.claimer.ring();
  await flush();
  assert.deepStrictEqual(s.sends.map((x) => x.timeoutMs), [4000]);
});
