// Run: node --test
// W2 step-4 dark bridge: turn.completed receipts shaped into poll-payload
// parity + the diff stream the cutover validation reads. Covers the field
// rules from docs/w2-telemetry-flow.md: totals off any line, identity off
// the main line only, error receipts keeping the last real token count,
// warmth two-state verdict, diff dedupe, and the never-throws contract.
const { test } = require('node:test');
const assert = require('node:assert');
const { WireTelemetry } = require('../wire-telemetry');

const warmthStub = (rows) => ({
  query: ({ session }) => rows[session] || { found: false, warm: false },
});

function mainTurn(over = {}) {
  return {
    agent: 'alice', sessionId: 'sid-1', role: 'parent', sideCall: false,
    model: 'claude-sonnet-5', status: 200,
    billing: { tokens: { input_tokens: 100, cache_read_input_tokens: 40000, cache_write_5m_tokens: 500, cache_write_1h_tokens: null, cache_write_flat_tokens: null } },
    sessionTotals: { requests: 8, est_usd: 0.1234, turns: 2, refusals: 0 },
    ...over,
  };
}

test('payload: main-line receipt shapes to poll parity', () => {
  const wt = new WireTelemetry({ warmth: warmthStub({ 'sid-1': { found: true, warm: true, remaining_s: 240.5, ttl_s: 300 } }) });
  wt.noteTurn(mainTurn());
  const p = wt.payload('alice');
  assert.strictEqual(p.sessionId, 'sid-1');
  assert.strictEqual(p.cost.usd, 0.1234);
  assert.strictEqual(p.cost.requests, 8);
  assert.strictEqual(p.turns, 2);
  // inputTokens = uncached + cache read + cache write (TTL-split branch)
  assert.strictEqual(p.context.inputTokens, 40600);
  assert.deepStrictEqual(p.warmth, { state: 'warm', remaining_s: 240.5, ttl_s: 300 });
});

test('subagent/side-call turns update totals but never identity or tokens', () => {
  const wt = new WireTelemetry({});
  wt.noteTurn(mainTurn());
  wt.noteTurn(mainTurn({
    role: 'general-purpose', sessionId: 'sid-other', model: 'claude-haiku-4-5',
    billing: { tokens: { input_tokens: 999999 } },
    sessionTotals: { requests: 9, est_usd: 0.13, turns: 2, refusals: 0 },
  }));
  wt.noteTurn(mainTurn({
    sideCall: true, sessionId: 'sid-title', model: 'title-model',
    sessionTotals: { requests: 10, est_usd: 0.14, turns: 2, refusals: 0 },
  }));
  const p = wt.payload('alice');
  assert.strictEqual(p.cost.requests, 10);      // totals: latest wins, any line
  assert.strictEqual(p.sessionId, 'sid-1');     // identity: main line only
  assert.strictEqual(p.model, 'claude-sonnet-5');
  assert.strictEqual(p.context.inputTokens, 40600);
});

test('error receipt (all-null usage) keeps the last real inputTokens', () => {
  const wt = new WireTelemetry({});
  wt.noteTurn(mainTurn());
  wt.noteTurn(mainTurn({
    status: 529,
    billing: { tokens: { input_tokens: null, cache_read_input_tokens: null, cache_write_flat_tokens: null } },
  }));
  assert.strictEqual(wt.payload('alice').context.inputTokens, 40600);
});

test('flat cache_creation total is used when the TTL split is absent', () => {
  const wt = new WireTelemetry({});
  wt.noteTurn(mainTurn({
    billing: { tokens: { input_tokens: 10, cache_read_input_tokens: 20, cache_write_5m_tokens: null, cache_write_1h_tokens: null, cache_write_flat_tokens: 30 } },
  }));
  assert.strictEqual(wt.payload('alice').context.inputTokens, 60);
});

test('diffPoll: epoch baseline — persisted poll totals vs zero-start wire ledger compare as increments', () => {
  const logs = [];
  const wt = new WireTelemetry({
    warmth: warmthStub({ 'sid-1': { found: true, warm: true, remaining_s: 200, ttl_s: 300 } }),
    log: (r) => logs.push(r),
  });
  // Wire came up mid-session: wire ledger at 1 request / $0.02; poll carries
  // the persisted lifetime totals ($113.98 / 392 — the live 14:38 shape).
  wt.noteTurn(mainTurn({ sessionTotals: { requests: 1, est_usd: 0.02, turns: 1, refusals: 0 } }));
  const poll = (usd, req, turns) => ({
    linked: true, sessionId: 'sid-1', cost: { usd, requests: req }, turns,
    refusals: 0, context: { inputTokens: 40600 }, warmth: { state: 'warm' },
  });
  wt.diffPoll('alice', poll(113.98, 392, 50));
  const first = logs[0];
  assert.ok(first.baselined);                         // epoch anchor tick
  assert.strictEqual(first.cost.poll_inc, 0);         // increments start at 0…
  assert.strictEqual(first.cost.wire_inc, 0);
  assert.strictEqual(first.cost.delta_pct, undefined); // …so no bogus 100%
  // Both sides advance by the same turn: increments agree.
  wt.noteTurn(mainTurn({ sessionTotals: { requests: 2, est_usd: 0.05, turns: 2, refusals: 0 } }));
  wt.diffPoll('alice', poll(114.01, 393, 51));
  const d = logs[1];
  assert.strictEqual(d.baselined, undefined);
  assert.strictEqual(d.cost.poll_inc, 0.03);
  assert.strictEqual(d.cost.wire_inc, 0.03);
  assert.strictEqual(d.cost.delta_pct, 0);
  assert.deepStrictEqual(d.requests, { poll_inc: 1, wire_inc: 1 });
  assert.deepStrictEqual(d.turns, { poll_inc: 1, wire_inc: 1 });
  assert.ok(d.session_match);
  assert.ok(d.warmth.match);
  // dedupe still holds on an unchanged tick
  wt.diffPoll('alice', poll(114.01, 393, 51));
  assert.strictEqual(logs.length, 2);
});

test('diffPoll: session rotation on either side re-baselines', () => {
  const logs = [];
  const wt = new WireTelemetry({ log: (r) => logs.push(r) });
  wt.noteTurn(mainTurn({ sessionTotals: { requests: 1, est_usd: 0.02, turns: 1, refusals: 0 } }));
  const poll = { linked: true, sessionId: 'sid-1', cost: { usd: 10, requests: 100 }, turns: 9, refusals: 0, context: {}, warmth: null };
  wt.diffPoll('alice', poll);
  assert.ok(logs[0].baselined);
  // /clear rotates the wire-side session → fresh epoch, not a giant negative increment
  wt.noteTurn(mainTurn({ sessionId: 'sid-2', sessionTotals: { requests: 1, est_usd: 0.01, turns: 1, refusals: 0 } }));
  wt.diffPoll('alice', { ...poll, sessionId: 'sid-2', cost: { usd: 10.01, requests: 101 } });
  const d = logs[1];
  assert.ok(d.baselined);
  assert.strictEqual(d.cost.poll_inc, 0);
  assert.strictEqual(d.cost.wire_inc, 0);
});

test('diffPoll: warmth pending (no wire stamp yet) is not a mismatch', () => {
  const logs = [];
  const wt = new WireTelemetry({ warmth: warmthStub({}), log: (r) => logs.push(r) });
  wt.noteTurn(mainTurn());
  wt.diffPoll('alice', { linked: true, sessionId: 'sid-1', cost: { usd: 1, requests: 1 }, turns: 1, refusals: 0, context: {}, warmth: { state: 'warm' } });
  assert.deepStrictEqual(logs[0].warmth, { poll: 'warm', wire: null, pending: true });
});

test('diffPoll: pre-main-line wire (no sessionId) logs wire_seen only — no false mismatches', () => {
  const logs = [];
  const wt = new WireTelemetry({ log: (r) => logs.push(r) });
  // Only a side-call seen so far: totals exist but no main-line identity.
  wt.noteTurn(mainTurn({ sideCall: true, sessionTotals: { requests: 1, est_usd: 0.001, turns: 0, refusals: 0 } }));
  wt.diffPoll('alice', { linked: true, sessionId: 'sid-1', cost: { usd: 5, requests: 50 }, turns: 5, refusals: 0, context: {}, warmth: { state: 'warm' } });
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].wire_seen, true);
  assert.strictEqual(logs[0].session_match, undefined); // gated, not false
  assert.strictEqual(logs[0].cost, undefined);
});

test('diffPoll: unlinked/null poll is silent; unseen agent logs wire_seen:false', () => {
  const logs = [];
  const wt = new WireTelemetry({ log: (r) => logs.push(r) });
  wt.diffPoll('alice', null);
  wt.diffPoll('alice', { linked: false });
  assert.strictEqual(logs.length, 0);
  wt.diffPoll('bob', { linked: true, sessionId: 'x', cost: {}, context: {}, warmth: null });
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].wire_seen, false);
});

test('never-throws contract: garbage inputs and a broken warmth store degrade silently', () => {
  const wt = new WireTelemetry({
    warmth: { query: () => { throw new Error('store dead'); } },
    log: () => { throw new Error('log dead'); },
  });
  wt.noteTurn(null);
  wt.noteTurn({ agent: 42 });
  wt.noteTurn(mainTurn());
  const p = wt.payload('alice');
  assert.ok(p, 'payload survives a broken warmth store');
  assert.strictEqual(p.warmth, null);           // warmth degrades alone
  assert.strictEqual(p.cost.usd, 0.1234);       // cost samples keep flowing
  wt.diffPoll('alice', { linked: true, cost: {}, context: {} });
  wt.prune(new Set());
  assert.strictEqual(wt.payload('alice'), null); // pruned
});

// Minimal HoldKeeper stand-in: one armed hold + one replayable entry.
const holdStub = (sid, hold) => ({
  entry: (s) => (s === sid ? { obj: {} } : null),
  holds: () => (hold ? { [sid]: hold } : {}),
});

test('payload: hold/pingable are shaped off the HoldKeeper, poll-parity field names', () => {
  const armed = { until: 1000, armedAt: 900, hours: 4, pings: 2, failures: 0, lastPingTs: 990, lastResult: 'warmed' };
  const wt = new WireTelemetry({ hold: holdStub('sid-1', armed) });
  wt.noteTurn(mainTurn());
  const p = wt.payload('alice');
  assert.strictEqual(p.pingable, true);
  assert.deepStrictEqual(p.hold, { until: 1000, hours: 4, pings: 2, last_result: 'warmed' });
  // Broken keeper degrades hold alone — cost keeps flowing.
  const broken = new WireTelemetry({ hold: { entry: () => { throw new Error('dead'); }, holds: () => { throw new Error('dead'); } } });
  broken.noteTurn(mainTurn());
  const q = broken.payload('alice');
  assert.strictEqual(q.hold, null);
  assert.strictEqual(q.pingable, false);
  assert.strictEqual(q.cost.usd, 0.1234);
});

test('overlay: wire-carried fields overwrite the poll payload, poll-only fields survive', () => {
  const wt = new WireTelemetry({
    warmth: warmthStub({ 'sid-1': { found: true, warm: true, remaining_s: 100, ttl_s: 300 } }),
    hold: holdStub('sid-1', null),
  });
  wt.noteTurn(mainTurn());
  const poll = {
    linked: true, sessionId: 'sid-1', model: 'claude-sonnet-5', base: 'http://x',
    cost: { usd: 113.98, requests: 392 }, turns: 50, refusals: 3,
    context: { turns: 12, messages: 80, inputTokens: 999 },
    warmth: { state: 'cold', remaining_s: null, ttl_s: 300 },
    strip: { configuredLevel: 2 }, capabilities: { stats: true, hold: false },
    subagents: [{ key: 'k' }], stripLevel: 2,
  };
  const out = wt.overlay('alice', poll);
  assert.strictEqual(out.telemetrySource, 'wire');
  assert.deepStrictEqual(out.cost, { usd: 0.1234, requests: 8 });   // wire ledger wins
  assert.strictEqual(out.turns, 2);
  assert.strictEqual(out.refusals, 0);
  assert.strictEqual(out.context.inputTokens, 40600);
  assert.strictEqual(out.context.messages, 80);                     // poll-only: kept
  assert.strictEqual(out.warmth.state, 'warm');
  assert.strictEqual(out.holdSource, 'wire');
  assert.strictEqual(out.capabilities.hold, true);                  // wire hold unlocks the button
  assert.strictEqual(out.capabilities.stats, true);
  assert.deepStrictEqual(out.subagents, [{ key: 'k' }]);            // poll-only: kept
  assert.strictEqual(out.strip.configuredLevel, 2);                 // poll-only: kept
  assert.strictEqual(out.sessionId, 'sid-1');                       // poll ids stay (poll-backed IPC)
  assert.strictEqual(poll.cost.usd, 113.98);                        // input not mutated
});

test('overlay: no wire identity / unlinked poll → poll returned untouched; never throws', () => {
  const wt = new WireTelemetry({});
  const poll = { linked: true, sessionId: 's', cost: { usd: 1 } };
  assert.strictEqual(wt.overlay('unseen', poll), poll);              // wire never saw the agent
  wt.noteTurn(mainTurn({ sideCall: true }));                         // totals but no main-line id
  assert.strictEqual(wt.overlay('alice', poll), poll);
  const unlinked = { linked: false };
  assert.strictEqual(wt.overlay('alice', unlinked), unlinked);
  assert.strictEqual(wt.overlay('alice', null), null);
  // A payload() blow-up degrades to the raw poll, not an exception.
  const broken = new WireTelemetry({});
  broken.payload = () => { throw new Error('dead'); };
  assert.strictEqual(broken.overlay('alice', poll), poll);
});

test('prune drops agents not in the live set', () => {
  const wt = new WireTelemetry({});
  wt.noteTurn(mainTurn());
  wt.noteTurn(mainTurn({ agent: 'bob' }));
  wt.prune(new Set(['bob']));
  assert.strictEqual(wt.payload('alice'), null);
  assert.ok(wt.payload('bob'));
});
