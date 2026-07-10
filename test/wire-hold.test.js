'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { HoldKeeper, holdDecision, rearmPlan } = require('../wire/hold');
const { WarmthStore, prefixHash } = require('../wire/warmth');
const { WireProxy } = require('../wire/proxy');

const SID = '4a59af49-cc52-44b7-8b02-7f4196a4b486';

function makeObj(overrides = {}) {
  return {
    model: 'claude-opus-4-8',
    stream: true,
    max_tokens: 32000,
    thinking: { type: 'enabled', budget_tokens: 4096 },
    context_management: { edits: [{ type: 'clear_thinking_20250919' }] },
    system: [{ type: 'text', text: 'You are a test.' }],
    tools: [{ name: 'Bash' }],
    metadata: { user_id: JSON.stringify({ session_id: SID }) },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ],
    ...overrides,
  };
}

// Shared fake clock: keeper and store must judge warmth off the same now.
function rig(opts = {}) {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const store = new WarmthStore({ now });
  const sent = [];
  const responder = { status: 200, usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } };
  const request = async (url, headers, body) => {
    sent.push({ url, headers, body: JSON.parse(body.toString('utf8')) });
    if (responder.reject) throw new Error('connect refused');
    return {
      status: responder.status,
      headers: { 'request-id': 'req_fake1' },
      body: Buffer.from(JSON.stringify(responder.status === 200
        ? { usage: responder.usage }
        : { error: { type: 'overloaded_error' } })),
    };
  };
  const keeper = new HoldKeeper({ warmth: store, now, request, ...opts });
  return { clock, store, keeper, sent, responder };
}

function stampWarm(store, obj) {
  // response-confirmed stamp: what a real forwarded turn would have written
  return store.record(obj, { cache_creation_input_tokens: 100, cache_read_input_tokens: 0 }, SID);
}

test('holdDecision: full verdict matrix', () => {
  const hold = { until: 2000, pings: 0, failures: 0 };
  const warm = { found: true, warm: true, remaining_s: 100 };
  assert.deepEqual(holdDecision(hold, true, warm, 2001), ['disarm', 'hold period over', 'expired']);
  assert.deepEqual(holdDecision({ ...hold, pings: 24 }, true, warm, 1000), ['disarm', 'max pings (24) reached', 'max-pings']);
  assert.equal(holdDecision({ ...hold, failures: 2 }, true, warm, 1000)[0], 'disarm');
  // machine-readable cause on the disarm branches (persistence-clearing keys on it)
  assert.equal(holdDecision(hold, true, warm, 2001)[2], 'expired');
  assert.equal(holdDecision({ ...hold, failures: 2 }, true, warm, 1000)[2], 'failures');
  assert.deepEqual(holdDecision(hold, false, warm, 1000), ['skip', 'no replayable request cached']);
  assert.deepEqual(holdDecision(hold, true, { found: false }, 1000), ['skip', 'prefix not in ledger']);
  assert.deepEqual(holdDecision(hold, true, null, 1000), ['skip', 'prefix not in ledger']);
  assert.deepEqual(holdDecision(hold, true, { found: true, remaining_s: 0 }, 1000), ['skip', 'prefix already cold']);
  assert.deepEqual(holdDecision(hold, true, { found: true, remaining_s: 300 }, 1000), ['skip', 'not yet due']);
  assert.deepEqual(holdDecision(hold, true, { found: true, remaining_s: 299 }, 1000), ['ping', 'due']);
  // caps overridable
  assert.equal(holdDecision({ ...hold, pings: 3 }, true, warm, 1000, { maxPings: 3 })[0], 'disarm');
  assert.equal(holdDecision(hold, true, { found: true, remaining_s: 500 }, 1000, { marginSeconds: 600 })[0], 'ping');
});

test('rearmPlan: restore, lapse, and no-op verdicts off a fixed now', () => {
  const now = 1_000_000_000_000; // fixed epoch ms
  // Future deadline -> re-arm for the REMAINING window (hours, unclamped here)
  assert.deepEqual(rearmPlan(now + 2 * 3600e3, now), { arm: true, hours: 2 });
  assert.deepEqual(rearmPlan(now + 30 * 60e3, now), { arm: true, hours: 0.5 });
  // Already lapsed (or exactly at deadline) -> clear the stale field, never arm
  assert.deepEqual(rearmPlan(now - 1, now), { clear: true });
  assert.deepEqual(rearmPlan(now, now), { clear: true });
  // Nothing persisted -> no-op (guard flips without touching the keeper)
  assert.equal(rearmPlan(undefined, now), null);
  assert.equal(rearmPlan(null, now), null);
  assert.equal(rearmPlan(0, now), null);
});

test('noteRequest caches the entry and evicts oldest past the cap', () => {
  const { clock, keeper } = rig({ maxEntries: 2 });
  keeper.noteRequest('s1', makeObj(), { a: '1' }, 'http://u/1');
  clock.t += 1;
  keeper.noteRequest('s2', makeObj(), { a: '2' }, 'http://u/2');
  clock.t += 1;
  keeper.noteRequest('s3', makeObj(), { a: '3' }, 'http://u/3');
  assert.equal(keeper.entry('s1'), null); // oldest evicted
  assert.ok(keeper.entry('s2'));
  assert.ok(keeper.entry('s3'));
  // re-noting the same session replaces, never grows
  keeper.noteRequest('s3', makeObj(), { a: '4' }, 'http://u/4');
  assert.equal(keeper.entry('s3').headers.a, '4');
});

test('ping: warm-only gate — cold declines, absent declines, warm replays', async () => {
  const { store, keeper, sent, clock } = rig();
  const obj = makeObj();

  let res = await keeper.ping(SID);
  assert.equal(res.ok, false); // nothing cached yet
  assert.match(res.reason, /no cached request/);

  keeper.noteRequest(SID, obj, { authorization: 'Bearer x', 'content-length': '999' }, 'http://up/v1/messages?beta=true');
  res = await keeper.ping(SID);
  assert.equal(res.ok, true);
  assert.equal(res.warmed, false);
  assert.equal(res.skipped, 'absent'); // never stamped
  assert.equal(sent.length, 0); // declined without spending

  stampWarm(store, obj);
  res = await keeper.ping(SID);
  assert.equal(res.warmed, true);
  assert.equal(res.prior_warmth, 'warm');
  assert.equal(res.cache_hit, true);
  assert.equal(res.ttl_s, 300);
  assert.equal(res.request_id, 'req_fake1');
  // the replay body: same prefix, minimal spend
  assert.equal(sent.length, 1);
  const w = sent[0].body;
  assert.equal(w.max_tokens, 1);
  assert.equal(w.stream, false);
  assert.equal(w.thinking, undefined);
  assert.equal(w.context_management, undefined);
  assert.deepEqual(w.messages, obj.messages); // prefix untouched
  assert.deepEqual(w.tools, obj.tools); // tools are IN the prefix — must stay
  assert.equal(sent[0].headers.authorization, 'Bearer x');
  assert.equal(sent[0].headers['content-length'], undefined);
  assert.equal(sent[0].headers['accept-encoding'], 'identity');

  // the replay restamped the ledger: TTL slid to a fresh window
  clock.t += 200;
  const q = store.query({ hash: prefixHash(obj, obj.messages.length) });
  assert.equal(q.warm, true);
  assert.equal(q.remaining_s, 100); // 300 - 200 since the PING, not the stamp
});

test('ping: force overrides the cold gate; upstream failure reported', async () => {
  const { keeper, sent, responder } = rig();
  const obj = makeObj();
  keeper.noteRequest(SID, obj, {}, 'http://up/v1/messages');

  let res = await keeper.ping(SID, { force: true }); // absent, forced through
  assert.equal(res.warmed, true);
  assert.equal(res.prior_warmth, 'absent');
  assert.equal(sent.length, 1);

  responder.status = 529;
  res = await keeper.ping(SID, { force: true });
  assert.equal(res.ok, false);
  assert.equal(res.status_code, 529);
  assert.deepEqual(res.error, { error: { type: 'overloaded_error' } });

  responder.reject = true;
  res = await keeper.ping(SID, { force: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /upstream error/);
});

test('arm: cold-gated like a ping; clamps hours; hours<=0 disarms', () => {
  const { store, keeper, clock } = rig();
  const obj = makeObj();
  keeper.noteRequest(SID, obj, {}, 'http://up/v1/messages');

  let r = keeper.arm(SID, 2);
  assert.equal(r.armed, false);
  assert.equal(r.skipped, 'absent'); // nothing warm to hold

  r = keeper.arm(SID, 2, { force: true });
  assert.equal(r.armed, true); // force is the only override

  stampWarm(store, obj);
  r = keeper.arm(SID, 100); // clamp to maxHours
  assert.equal(r.armed, true);
  assert.equal(r.hours, 12);
  assert.equal(r.until, clock.t + 12 * 3600);
  assert.equal(r.pingable, true);

  r = keeper.arm(SID, 0);
  assert.equal(r.armed, false);
  assert.equal(r.disarmed, true);
  assert.deepEqual(keeper.holds(), {});

  assert.equal(keeper.arm(null, 2).reason, 'no_session');
});

test('organic turn re-anchors the window and resets the ping budget', async () => {
  const { store, keeper, clock } = rig();
  const obj = makeObj();
  keeper.noteRequest(SID, obj, {}, 'http://up/v1/messages');
  stampWarm(store, obj);
  keeper.arm(SID, 1);

  clock.t += 250; // due (300 ttl, 300 margin)
  await keeper.tick();
  let h = keeper.holds()[SID];
  assert.equal(h.pings, 1);

  clock.t += 100;
  keeper.noteRequest(SID, makeObj(), {}, 'http://up/v1/messages'); // organic turn
  h = keeper.holds()[SID];
  assert.equal(h.pings, 0); // budget restarts: pings since the LAST real turn
  assert.equal(h.failures, 0);
  assert.equal(h.until, clock.t + 3600); // window re-anchored to now + hours
});

test('tick: pings when due, disarms on expiry / max pings / 2 failures', async () => {
  const { store, keeper, clock, sent, responder } = rig({ maxPings: 2 });
  const obj = makeObj();
  const disarms = [];
  keeper.on('hold', (e) => { if (e.event === 'disarmed') disarms.push(e.reason); });
  keeper.noteRequest(SID, obj, {}, 'http://up/v1/messages');
  stampWarm(store, obj);
  keeper.arm(SID, 1);

  await keeper.tick(); // remaining 300 >= margin: not yet due
  assert.equal(sent.length, 0);

  clock.t += 250;
  await keeper.tick(); // due → ping → restamp
  assert.equal(sent.length, 1);
  assert.equal(keeper.holds()[SID].lastResult, 'warmed');

  clock.t += 250;
  await keeper.tick(); // due again → second ping hits the budget
  assert.equal(sent.length, 2);
  clock.t += 250;
  await keeper.tick(); // pings=2 = maxPings → disarm before spending
  assert.equal(sent.length, 2);
  assert.deepEqual(disarms, ['max pings (2) reached']);
  assert.deepEqual(keeper.holds(), {});

  // hold period over
  keeper.arm(SID, 1, { force: true });
  clock.t += 3601;
  await keeper.tick();
  assert.deepEqual(disarms.slice(1), ['hold period over']);
});

test('tick: 2 consecutive ping FAILURES disarm; ping attempts spend budget', async () => {
  const { store, keeper, clock, responder } = rig();
  const obj = makeObj();
  const disarms = [];
  keeper.on('hold', (e) => { if (e.event === 'disarmed') disarms.push(e.reason); });
  keeper.noteRequest(SID, obj, {}, 'http://up/v1/messages');
  stampWarm(store, obj);
  keeper.arm(SID, 1);
  responder.reject = true;

  clock.t += 250; // due
  await keeper.tick();
  assert.equal(keeper.holds()[SID].failures, 1);
  assert.equal(keeper.holds()[SID].pings, 1); // a failed attempt still spends
  assert.match(keeper.holds()[SID].lastResult, /^fail:/);
  await keeper.tick(); // no restamp happened, still due → strike two
  assert.equal(keeper.holds()[SID].failures, 2);
  await keeper.tick(); // 2 failures → disarm before spending again
  assert.deepEqual(keeper.holds(), {});
  assert.match(disarms[0], /consecutive ping failures/);
});

test('endSession disarms the hold but keeps the cached entry', () => {
  const { store, keeper } = rig();
  const obj = makeObj();
  keeper.noteRequest(SID, obj, {}, 'http://up/v1/messages');
  stampWarm(store, obj);
  keeper.arm(SID, 1);
  const r = keeper.endSession(SID);
  assert.equal(r.holdDisarmed, true);
  assert.deepEqual(keeper.holds(), {});
  assert.ok(keeper.entry(SID)); // post-mortem/resume keeps the body
});

// --- proxy integration: the wire feeds the keeper ---------------------------

const SSE_OK = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":10,"cache_creation_input_tokens":50}}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
  '',
].join('\n');

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('proxy caches the main line for replay; count_tokens path does not', async () => {
  const server = http.createServer((req, res) => {
    if (req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"input_tokens":34}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(SSE_OK);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const clock = { t: 1_000_000 };
  const store = new WarmthStore({ now: () => clock.t });
  const keeper = new HoldKeeper({ warmth: store, now: () => clock.t });
  const proxy = new WireProxy({
    upstreams: { anthropic: `http://127.0.0.1:${server.address().port}` },
    warmth: store, hold: keeper,
  });
  await proxy.listen();

  const turns = [];
  proxy.on('turn.completed', (t) => turns.push(t));
  const body = JSON.stringify(makeObj());
  await post(proxy.port, '/agent/t/v1/messages', body);
  await new Promise((r) => setTimeout(r, 30));
  const entry = keeper.entry(SID);
  assert.ok(entry, 'main-line messages call cached');
  assert.match(entry.url, /\/v1\/messages$/);
  assert.equal(entry.obj.metadata.user_id, JSON.parse(body).metadata.user_id);
  // the response stamped warmth (cache_creation 50) → the entry is pingable
  assert.equal(store.query({ session: SID }).warm, true);

  // count_tokens on the same session must NOT replace the replayable body;
  // it IS billed (0-token request-rate-limit spend) but emits no turn.
  await post(proxy.port, '/agent/t/v1/messages/count_tokens', body);
  await new Promise((r) => setTimeout(r, 30));
  assert.match(keeper.entry(SID).url, /\/v1\/messages$/);
  assert.equal(turns.length, 1); // the messages turn only
  assert.equal(proxy.billing.totals.count_tokens_requests, 1);
  assert.equal(proxy.billing.totals.requests, 2);
  assert.equal(proxy.billing.session(SID).count_tokens_requests, 1);

  await proxy.close();
  server.close();
});
