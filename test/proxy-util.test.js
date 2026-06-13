// Run: node --test
// Covers the reviewed risk surface: proxy-agent identity lifecycle (which
// session actions preserve vs reset identity), nonce uniqueness, and the
// /_status record shaping.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  PROXY_AGENT_PREFIX, mintProxyAgent, resolveProxyAgentId, pickProxyRecord, shapeProxyRecord,
} = require('../proxy-util');

test('mintProxyAgent: prefixed, name-embedded, unique against taken set', () => {
  let n = 0;
  const seq = ['aaaa', 'aaaa', 'bbbb']; // first two collide, third is free
  const rand = () => seq[n++];
  const taken = new Set(['clodex-foo-aaaa']);
  const id = mintProxyAgent('foo', taken, rand);
  assert.ok(id.startsWith(PROXY_AGENT_PREFIX));
  assert.strictEqual(id, 'clodex-foo-bbbb'); // skipped the collision
});

test('lifecycle: fresh create mints a new id', () => {
  const id = resolveProxyAgentId({ name: 'a', fork: false, existing: null, taken: new Set(), rand: () => 'dead' });
  assert.strictEqual(id, 'clodex-a-dead');
});

test('lifecycle: resume/restart/restore reuse the persisted id', () => {
  const existing = { proxyAgent: 'clodex-a-keep' };
  const id = resolveProxyAgentId({ name: 'a', fork: false, existing, taken: new Set(), rand: () => 'new' });
  assert.strictEqual(id, 'clodex-a-keep'); // continuity → same ledger
});

test('lifecycle: fork mints a new id even when one is persisted', () => {
  const existing = { proxyAgent: 'clodex-a-old' };
  const id = resolveProxyAgentId({ name: 'a', fork: true, existing, taken: new Set(), rand: () => 'fork' });
  assert.strictEqual(id, 'clodex-a-fork'); // divergent session → fresh ledger
});

test('lifecycle: legacy entry without proxyAgent lazy-mints', () => {
  const existing = { name: 'a' }; // predates the field
  const id = resolveProxyAgentId({ name: 'a', fork: false, existing, taken: new Set(), rand: () => 'mint' });
  assert.strictEqual(id, 'clodex-a-mint');
});

test('lifecycle: recycled name cannot inherit old telemetry', () => {
  // Old session "foo" left a record under clodex-foo-old. A brand-new "foo"
  // (no persisted entry) mints a different id, so an exact-equality match
  // against the stale record is impossible.
  const oldId = 'clodex-foo-old';
  const newId = resolveProxyAgentId({ name: 'foo', fork: false, existing: null, taken: new Set([oldId]), rand: () => 'newx' });
  assert.notStrictEqual(newId, oldId);
});

test('shapeProxyRecord: null record → unlinked, carries probe metadata', () => {
  const probe = { version: 'v1', capabilities: { stats: true } };
  const p = shapeProxyRecord(null, probe, 123);
  assert.deepStrictEqual(p, { ts: 123, version: 'v1', capabilities: { stats: true }, linked: false });
});

test('shapeProxyRecord: maps wire fields to renderer payload', () => {
  const probe = { version: 'v1', capabilities: { stats: true } };
  const r = {
    session_id: 'sid', model: 'claude-opus-4-8',
    cost: { est_usd: 1.25, requests: 7 },
    turns_completed: 4, refusals: 2,
    context: { turns_in_context: 9, n_messages: 30, input_tokens: 185218 },
    warmth: { state: 'warm', remaining_s: 280.4, ttl_s: 300 },
    pingable: true,
    hold: { until: 123, hours: 4 },
  };
  const p = shapeProxyRecord(r, probe, 1);
  assert.strictEqual(p.linked, true);
  assert.deepStrictEqual(p.cost, { usd: 1.25, requests: 7 });
  assert.deepStrictEqual(p.context, { turns: 9, messages: 30, inputTokens: 185218 });
  assert.deepStrictEqual(p.warmth, { state: 'warm', remaining_s: 280.4, ttl_s: 300 });
  assert.strictEqual(p.refusals, 2);
  assert.strictEqual(p.turns, 4);
  assert.strictEqual(p.pingable, true);
  assert.deepStrictEqual(p.hold, { until: 123, hours: 4 });
});

test('shapeProxyRecord: pingable defaults false when absent', () => {
  const probe = { version: 'v1', capabilities: {} };
  const p = shapeProxyRecord({ session_id: 's' }, probe, 1);
  assert.strictEqual(p.pingable, false);
});

test('shapeProxyRecord: codex-style nulls (no warmth/context) degrade cleanly', () => {
  const probe = { version: 'v1', capabilities: { stats: true } };
  const r = { session_id: 's', model: 'gpt-5.1-codex', cost: { est_usd: 0.01, requests: 3 }, warmth: null, context: null };
  const p = shapeProxyRecord(r, probe, 1);
  assert.strictEqual(p.warmth, null);
  assert.strictEqual(p.context, null);
  assert.deepStrictEqual(p.cost, { usd: 0.01, requests: 3 });
});

test('pickProxyRecord: empty / null candidates → null', () => {
  assert.strictEqual(pickProxyRecord(null, 'x'), null);
  assert.strictEqual(pickProxyRecord([], 'x'), null);
});

test('pickProxyRecord: /clear regression — binds the live session, not the clear-ended one', () => {
  // The real /_status order that bit us: live record FIRST, clear-ended SECOND,
  // both under one agent id. Last-writer-wins would pick the dead one.
  const live = { agent: 'clodex-clodex-1bf', session_id: 'new', ended: null, last_seen: 200 };
  const dead = { agent: 'clodex-clodex-1bf', session_id: 'old', ended: { reason: 'clear' }, last_seen: 100 };
  assert.strictEqual(pickProxyRecord([live, dead], 'new'), live);
});

test('pickProxyRecord: exact session id wins even against a newer record', () => {
  const tracked = { session_id: 'mine', ended: null, last_seen: 1 };
  const newer = { session_id: 'other', ended: null, last_seen: 999 };
  assert.strictEqual(pickProxyRecord([newer, tracked], 'mine'), tracked);
});

test('pickProxyRecord: no session id → prefer live, most-recently-seen', () => {
  const dead = { session_id: 'a', ended: { reason: 'clear' }, last_seen: 999 };
  const liveOld = { session_id: 'b', ended: null, last_seen: 10 };
  const liveNew = { session_id: 'c', ended: null, last_seen: 50 };
  assert.strictEqual(pickProxyRecord([dead, liveOld, liveNew], null), liveNew);
});

test('pickProxyRecord: all ended → fall back to most-recently-seen', () => {
  const older = { session_id: 'a', ended: { reason: 'clear' }, last_seen: 10 };
  const newer = { session_id: 'b', ended: { reason: 'clear' }, last_seen: 20 };
  assert.strictEqual(pickProxyRecord([older, newer], 'missing'), newer);
});
