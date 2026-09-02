'use strict';
// peer-client-claim-failure.test.js — a DM claim that fails on the wire must not
// fail silently.
//
// THE DEFECT THIS CLOSES. `claimOutbox` (peer-outbox.js) renames the origin dir,
// reads it, and rm -rf's it BEFORE remote.js serialises the array into the HTTP
// response — so between the removal and the response reaching the wire the batch
// exists only in the server's heap. A crash or a dropped connection there loses
// it outright: gone from disk, never arrived. `claimDms` turns that into
// `{ ok: false, error }`, and its only caller `_claimAndEmit` used to let that
// arm fall off the end — no log, no counter, nothing. Invisible from BOTH ends:
// the sender's /api/dm already returned 200, and the receiver never knew a claim
// was in flight.
//
// This does NOT change the delivery contract (still at-most-once, still no
// retry and no tombstone — duplicate DM delivery would re-run intent bodies).
// It makes the failure observable, which is all the loss arm can honestly offer.
//
// WHAT IS PINNED, over a real socket:
//   1. a failed claim emits an ipc-message system line,
//   2. a SECOND failure inside the rate-limit interval emits nothing more —
//      without this the throttle is unpinned, and `_claimAndEmit` fires on every
//      hello tick AND every SSE doorbell against a condition that recurs on
//      every one of them, so an unthrottled line buries the signal it exists to
//      give,
//   3. a SUCCESSFUL claim still emits `peer-dms` and reports nothing — the
//      anti-degenerate half, without which an unconditional "always report"
//      passes 1 and 2.
//
// The hello tick is the trigger throughout rather than a direct
// `_claimAndEmit()` call: the arm is only reachable in production through
// dmOrigins, and driving the private method would leave that wiring unexercised.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { PeerConnection } = require('../peer-client');

const SELF = 'us';

// `claimReply` returns the raw bytes for /api/dm/claim. Returning something
// unparseable is how a failure is induced: _request's JSON.parse throws and the
// callback gets `bad response`, which is the same { ok: false } shape a dropped
// socket produces — the arm under test cannot tell them apart, and neither can
// the code that lost the batch.
function claimServer(claimReply) {
  const state = { claims: 0 };
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/api/peer/hello') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'clodex', host: 'h', caps: [], version: '1', dmOrigins: [SELF] }));
    } else if (p === '/api/dm/claim') {
      state.claims++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(claimReply(state.claims));
    } else if (p === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: [] }));
    } else if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
    } else {
      res.writeHead(404).end();
    }
  });
  return { server, state };
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

function waitFor(label, pred, ms = 5000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v; try { v = pred(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error(`timed out waiting for: ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const systemLines = (emits) =>
  emits.filter((e) => e[0] === 'ipc-message' && e[1] && e[1].type === 'system').map((e) => e[1]);

async function withPeer(claimReply, fn, connOpts = {}) {
  const { server, state } = claimServer(claimReply);
  const port = await listen(server);
  const emits = [];
  const conn = new PeerConnection({
    id: 'box', label: 'box', url: `http://127.0.0.1:${port}`, selfLabel: SELF,
    emit: (channel, ...args) => { emits.push([channel, ...args]); },
    helloIntervalMs: 25,
    ...connOpts,
  });
  conn.start();
  try {
    await fn(emits, state, conn);
  } finally {
    conn.stop();
    server.close();
  }
}

const FAIL = () => 'not json at all';

// WINDOW: the failure arm itself. Against pre-fix code this times out at the
// waitFor — no line is ever emitted, which is the whole defect.
test('a DM claim that fails on the wire is reported on the IPC log', async () => {
  await withPeer(FAIL, async (emits, state) => {
    await waitFor('a claim to be attempted', () => state.claims >= 1);
    await waitFor('a system line explaining the failed claim', () => systemLines(emits).length >= 1);
    const line = systemLines(emits)[0];
    // Asserted on the emitted object, not on spelling: the routing fields are
    // what makes it show up against the right peer in the IPC log.
    assert.strictEqual(line.type, 'system');
    assert.strictEqual(line.from, 'peer:box');
    assert.strictEqual(line.to, 'peer:box');
    // The two claims the prose MUST make, matched as the narrowest fragments
    // that distinguish them. `unrecoverable` is the honest one: an error can
    // also mean the claim never ran or found nothing, so the line may not say a
    // count was dropped, only that whatever it took cannot be got back.
    assert.match(line.body, /claim failed/i);
    assert.match(line.body, /unrecoverable/i);
  });
});

// WINDOW: the throttle. The hello interval here is 25ms, so a dozen claims land
// well inside the one-minute rate-limit window; every one of them fails. Waiting
// on the SERVER's claim counter (not on a delay) means the assertion below runs
// only after the repeat failures it is about have actually happened —
// ENTER: state.claims >= 3 is asserted before the count, so a version of this
// test where the hello loop stalled would fail by label at the waitFor rather
// than reporting a vacuous "exactly one line" over one single claim.
test('repeat claim failures inside the rate-limit interval report only once', async () => {
  await withPeer(FAIL, async (emits, state) => {
    await waitFor('at least three failed claims', () => state.claims >= 3);
    assert.ok(state.claims >= 3, `ENTER: expected repeat claims, got ${state.claims}`);
    await new Promise((r) => setTimeout(r, 150));   // any extra line would have landed
    assert.strictEqual(systemLines(emits).length, 1,
      `${state.claims} failed claims produced ${systemLines(emits).length} lines; the throttle is gone`);
  });
});

// WINDOW: the anti-degenerate half. Without it, a `_reportClaimFailure` call
// moved above the ok-check — or an arm that reports unconditionally — passes
// both tests above while spamming the log on every healthy claim.
test('a successful claim emits peer-dms and reports nothing', async () => {
  const OK = () => JSON.stringify({ ok: true, messages: [{ from: 'a', to: 'b', body: 'hi', ts: 1 }] });
  await withPeer(OK, async (emits, state) => {
    await waitFor('the delivered mail', () => emits.some((e) => e[0] === 'peer-dms'));
    const dms = emits.find((e) => e[0] === 'peer-dms');
    assert.deepStrictEqual(dms, ['peer-dms', 'box', [{ from: 'a', to: 'b', body: 'hi', ts: 1 }]]);
    await new Promise((r) => setTimeout(r, 150));   // several more successful ticks
    assert.ok(state.claims >= 2, `ENTER: expected repeat successful claims, got ${state.claims}`);
    assert.deepStrictEqual(systemLines(emits), [], 'a healthy claim says nothing');
  });
});

// WINDOW: the record. claimOutbox's header is where the next agent reasoning
// about delivery guarantees will look, and it used to assert single delivery as
// the ONLY outcome. A sentence naming a mechanism's behaviour without naming the
// case it holds in is the defect class this repo has paid for repeatedly, so the
// property asserted is that the case is named — a crash or dropped connection
// before the response is flushed — not the wording that names it.
test('claimOutbox documents the zero-delivery arm and the case it holds in', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'peer-outbox.js'), 'utf8');
  const header = src.slice(0, src.indexOf('function claimOutbox'));
  const tail = header.slice(header.lastIndexOf('// Atomically claim'));
  assert.ok(tail, 'ENTER: claimOutbox still has a header block to assert about');
  assert.doesNotMatch(tail, /single delivery/,
    'the header still calls the outcome single delivery, which is the claim being corrected');
  assert.match(tail, /at most once/i, 'names the guarantee');
  assert.match(tail, /possibly zero|or zero|zero/i, 'names the loss arm');
  assert.match(tail, /crash|dropped connection/i, 'names the case the loss holds in');
  assert.match(tail, /response|flush/i, 'and locates it against the response');
});
