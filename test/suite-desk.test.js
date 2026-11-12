'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSuiteDesk, SESSION_RE } = require('../suite-desk');

const SESSION = 'session-aaaa1111';
const OTHER = 'session-bbbb2222';

function fakeClock(start = 1000) {
  let t = start;
  const armed = new Set();
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) { const h = { at: t + ms, fn }; armed.add(h); return h; },
      clearTimeout(h) { armed.delete(h); },
    },
    advance(ms) {
      t += ms;
      for (const h of [...armed]) if (h.at <= t) { armed.delete(h); h.fn(); }
    },
    armed: () => armed.size,
  };
}

function mkDesk(opts = {}) {
  const clock = fakeClock();
  const rung = [];
  const desk = createSuiteDesk({ now: clock.now, timers: clock.timers, notify: (o) => rung.push(o), ...opts });
  return { desk, clock, rung };
}

function settled(p) {
  let out = null;
  p.then((v) => { out = v; });
  return () => out;
}

const tick = () => new Promise((r) => setImmediate(r));

test('an origin that never claimed is not attached: a call answers 503 at once and queues nothing', async () => {
  const { desk, rung } = mkDesk();
  const r = await desk.conn('laptop').suiteAsk('GET', '/api/suite/info', null, 5000);
  assert.deepStrictEqual(r, { status: 503, body: null, error: 'runner laptop is not attached' });
  assert.deepStrictEqual(rung, []);
  assert.deepStrictEqual(desk.retained('laptop'), { unsettled: 0, bytes: 0 });
});

test('attach, call, claim, reply: the caller gets the literal answer', async () => {
  const { desk, rung } = mkDesk();
  assert.deepStrictEqual(desk.claim('laptop', SESSION), { status: 200, calls: [] });
  assert.strictEqual(desk.attached('laptop'), true);
  const p = desk.conn('laptop').suiteAsk('POST', '/api/suite/jobs', { id: 'job1', treeHash: 'abc' }, 30000);
  assert.deepStrictEqual(rung, ['laptop']);
  const got = desk.claim('laptop', SESSION);
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.calls.length, 1);
  const [call] = got.calls;
  assert.match(call.id, /^[0-9a-f]{16}$/);
  assert.match(call.claim, /^[0-9a-f]{32}$/);
  assert.deepStrictEqual({ ...call, id: null, claim: null }, {
    id: null, claim: null, ttlMs: 30000, method: 'POST', path: '/api/suite/jobs',
    headers: {}, body: { id: 'job1', treeHash: 'abc' }, blob: null,
  });
  assert.deepStrictEqual(desk.reply(call.id, call.claim, { status: 200, body: { ok: true, id: 'job1', state: 'awaiting-pack', have: 0 } }), { status: 200 });
  assert.deepStrictEqual(await p, { status: 200, body: { ok: true, id: 'job1', state: 'awaiting-pack', have: 0 }, error: null });
  assert.deepStrictEqual(desk.retained('laptop'), { unsettled: 0, bytes: 0 });
});

test('a timeout is floored at 20 s; expiry resolves status 0 and the late reply is 410', async () => {
  const { desk, clock } = mkDesk();
  desk.claim('laptop', SESSION);
  const p = desk.conn('laptop').suiteAsk('GET', '/api/suite/info', null, 1000);
  const out = settled(p);
  const [call] = desk.claim('laptop', SESSION).calls;
  assert.strictEqual(call.ttlMs, 20000);
  clock.advance(19999);
  await tick();
  assert.strictEqual(out(), null, 'ENTER: still pending one ms before the floor');
  clock.advance(1);
  await tick();
  assert.deepStrictEqual(out(), { status: 0, body: null, error: 'runner did not answer in time' });
  assert.deepStrictEqual(desk.reply(call.id, call.claim, { status: 200, body: { ok: true } }), { status: 410, error: 'call expired' });
  assert.deepStrictEqual(desk.blob(call.id, call.claim), { status: 410, error: 'call expired' });
  assert.deepStrictEqual(desk.reply('0123456789abcdef', call.claim, { status: 200, body: {} }), { status: 404, error: 'unknown call' });
});

test('a second claim returns no calls once the first took them', () => {
  const { desk } = mkDesk();
  desk.claim('laptop', SESSION);
  desk.conn('laptop').suiteAsk('GET', '/api/suite/info', null, 30000);
  const first = desk.claim('laptop', SESSION);
  assert.strictEqual(first.calls.length, 1, 'ENTER: the first claim returned the call');
  assert.strictEqual(first.calls[0].path, '/api/suite/info');
  assert.deepStrictEqual(desk.claim('laptop', SESSION), { status: 200, calls: [] });
});

test('blob and reply with the wrong claim token are 409 and leave the call live', async () => {
  const { desk } = mkDesk();
  desk.claim('laptop', SESSION);
  const buf = Buffer.from('pack-bytes-0123');
  const p = desk.conn('laptop').suitePut('/api/suite/jobs/job1/pack', buf, { 'Content-Range': 'bytes 0-14/*' }, 30000);
  const [call] = desk.claim('laptop', SESSION).calls;
  assert.deepStrictEqual(call.headers, { 'content-range': 'bytes 0-14/*' });
  assert.deepStrictEqual(call.blob, { bytes: 15 });
  const wrong = 'f'.repeat(32);
  assert.deepStrictEqual(desk.blob(call.id, wrong), { status: 409, error: 'wrong claim token' });
  assert.deepStrictEqual(desk.reply(call.id, wrong, { status: 200, body: { ok: true } }), { status: 409, error: 'wrong claim token' });
  const got = desk.blob(call.id, call.claim);
  assert.strictEqual(got.status, 200);
  assert.ok(got.bytes.equals(buf));
  desk.reply(call.id, call.claim, { status: 200, body: { ok: true, size: 15 } });
  assert.deepStrictEqual(await p, { status: 200, body: { ok: true, size: 15 }, error: null });
});

test('the 33rd unsettled call for one origin is 429, claimed calls count, a reply frees a slot', async () => {
  const { desk } = mkDesk();
  desk.claim('laptop', SESSION);
  const c = desk.conn('laptop');
  for (let i = 0; i < 32; i++) c.suiteAsk('GET', `/api/suite/jobs?ids=j${i}`, null, 30000);
  assert.deepStrictEqual(desk.retained('laptop'), { unsettled: 32, bytes: 0 });
  assert.deepStrictEqual(await c.suiteAsk('GET', '/api/suite/info', null, 30000), { status: 429, body: null, error: 'suite desk is full' });
  const { calls } = desk.claim('laptop', SESSION);
  assert.strictEqual(calls.length, 32);
  assert.deepStrictEqual(desk.retained('laptop'), { unsettled: 32, bytes: 0 });
  const afterClaim = settled(c.suiteAsk('GET', '/api/suite/info', null, 30000));
  await tick();
  assert.deepStrictEqual(afterClaim(), { status: 429, body: null, error: 'suite desk is full' });
  desk.reply(calls[0].id, calls[0].claim, { status: 200, body: { ok: true } });
  const more = settled(c.suiteAsk('GET', '/api/suite/info', null, 30000));
  await tick();
  assert.strictEqual(more(), null, 'queued, not refused');
  assert.deepStrictEqual(desk.retained('laptop'), { unsettled: 32, bytes: 0 });
});

test('the total cap spans origins', async () => {
  const { desk } = mkDesk({ limits: { total: 3 } });
  desk.claim('a', SESSION);
  desk.claim('b', OTHER);
  desk.conn('a').suiteAsk('GET', '/api/suite/info', null, 30000);
  desk.conn('a').suiteAsk('GET', '/api/suite/info', null, 30000);
  desk.conn('b').suiteAsk('GET', '/api/suite/info', null, 30000);
  assert.deepStrictEqual(await desk.conn('b').suiteAsk('GET', '/api/suite/info', null, 30000), { status: 429, body: null, error: 'suite desk is full' });
});

test('retained blob bytes are capped per origin and read zero after reply and after expiry', async () => {
  const { desk, clock } = mkDesk({ limits: { blobBytes: 10 } });
  desk.claim('laptop', SESSION);
  const c = desk.conn('laptop');
  const p1 = c.suitePut('/api/suite/jobs/j/pack', Buffer.alloc(6), {}, 30000);
  assert.deepStrictEqual(desk.retained('laptop'), { unsettled: 1, bytes: 6 });
  assert.deepStrictEqual(await c.suitePut('/api/suite/jobs/j/pack', Buffer.alloc(5), {}, 30000),
    { status: 429, body: null, error: 'suite desk holds too many bytes for this runner' });
  const [call] = desk.claim('laptop', SESSION).calls;
  desk.reply(call.id, call.claim, { status: 200, body: { ok: true, size: 6 } });
  await p1;
  assert.deepStrictEqual(desk.retained('laptop'), { unsettled: 0, bytes: 0 });
  const p2 = settled(c.suitePut('/api/suite/jobs/j/pack', Buffer.alloc(10), {}, 30000));
  assert.deepStrictEqual(desk.retained('laptop'), { unsettled: 1, bytes: 10 });
  clock.advance(30000);
  await tick();
  assert.strictEqual(p2().status, 0);
  assert.deepStrictEqual(desk.retained('laptop'), { unsettled: 0, bytes: 0 });
  assert.strictEqual(clock.armed(), 0);
});

test('oversize bodies are refused before queueing', async () => {
  const { desk } = mkDesk();
  desk.claim('laptop', SESSION);
  const c = desk.conn('laptop');
  const big = await c.suiteAsk('POST', '/api/suite/jobs', { pad: 'x'.repeat(256 * 1024) }, 30000);
  assert.strictEqual(big.status, 413);
  const chunk = await c.suitePut('/api/suite/jobs/j/pack', Buffer.alloc(4 * 1024 * 1024 + 1), {}, 30000);
  assert.strictEqual(chunk.status, 413);
  assert.deepStrictEqual(desk.retained('laptop'), { unsettled: 0, bytes: 0 });
});

test('a claim batch stops once bodies pass the batch limit, always holding one call', () => {
  const { desk } = mkDesk({ limits: { batchBytes: 30 } });
  desk.claim('laptop', SESSION);
  const c = desk.conn('laptop');
  for (const n of [1, 2, 3]) c.suiteAsk('POST', '/api/suite/jobs', { id: `job-number-${n}` }, 30000);
  assert.deepStrictEqual(desk.claim('laptop', SESSION).calls.map((x) => x.body.id), ['job-number-1']);
  assert.deepStrictEqual(desk.claim('laptop', SESSION).calls.map((x) => x.body.id), ['job-number-2']);
});

test('a malformed reply settles the call as 502 and is refused', async () => {
  const { desk } = mkDesk();
  desk.claim('laptop', SESSION);
  const c = desk.conn('laptop');
  for (const bad of [{ status: 99, body: {} }, { status: 200.5, body: {} }, { status: 600, body: {} }, { status: 200, body: [] }, { status: 200, body: null }]) {
    const p = c.suiteAsk('GET', '/api/suite/info', null, 30000);
    const [call] = desk.claim('laptop', SESSION).calls;
    assert.deepStrictEqual(desk.reply(call.id, call.claim, bad), { status: 400, error: 'bad reply' });
    assert.deepStrictEqual(await p, { status: 502, body: null, error: 'runner sent a malformed reply' });
  }
});

test('L2: a claim from another session while one is attached is 409', () => {
  const { desk, clock } = mkDesk();
  assert.strictEqual(desk.claim('laptop', SESSION).status, 200);
  clock.advance(44999);
  assert.deepStrictEqual(desk.claim('laptop', OTHER), { status: 409, error: 'another runner session is attached for this origin' });
  assert.strictEqual(desk.claim('laptop', SESSION).status, 200, 'the attached session keeps claiming');
  assert.deepStrictEqual(desk.claim('laptop', 'short'), { status: 400, error: 'bad session' });
  assert.ok(SESSION_RE.test(SESSION) && SESSION_RE.test(OTHER));
});

test('L2: a session replacing a lapsed one fails the old pending and claimed calls as runner-restart', async () => {
  const { desk, clock } = mkDesk({ presenceMs: 10000 });
  desk.claim('laptop', SESSION);
  const c = desk.conn('laptop');
  const claimedP = c.suitePut('/api/suite/jobs/j/pack', Buffer.alloc(8), {}, 60000);
  const [old] = desk.claim('laptop', SESSION).calls;
  const pendingP = c.suiteAsk('GET', '/api/suite/jobs?ids=j&wait=25000', null, 60000);
  assert.deepStrictEqual(desk.retained('laptop'), { unsettled: 2, bytes: 8 });
  clock.advance(10000);
  assert.strictEqual(desk.attached('laptop'), false);
  assert.deepStrictEqual(desk.claim('laptop', OTHER), { status: 200, calls: [] });
  const restart = { status: 404, body: { ok: false, error: 'runner session replaced', reason: 'runner-restart' }, error: null };
  assert.deepStrictEqual(await claimedP, restart);
  assert.deepStrictEqual(await pendingP, restart);
  assert.deepStrictEqual(desk.retained('laptop'), { unsettled: 0, bytes: 0 });
  assert.deepStrictEqual(desk.reply(old.id, old.claim, { status: 200, body: { ok: true } }), { status: 410, error: 'call already settled' });
});

test('origins lists claimers with their attachment; close settles everything', async () => {
  const { desk, clock } = mkDesk();
  desk.claim('laptop', SESSION);
  const p = desk.conn('laptop').suiteAsk('GET', '/api/suite/info', null, 30000);
  assert.deepStrictEqual(desk.origins(), [{ origin: 'laptop', attached: true, lastClaim: 1000 }]);
  desk.close();
  assert.deepStrictEqual(await p, { status: 0, body: null, error: 'suite desk closed' });
  assert.strictEqual(clock.armed(), 0);
  assert.deepStrictEqual(desk.origins(), []);
});
