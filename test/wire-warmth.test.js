'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  WarmthStore, stripCacheControl, canonJson, prefixHash, segmentHashes,
  markerTtl, isWarmPing,
} = require('../wire/warmth');

// A minimal realistic request body. TTL comes from the tail marker.
function makeBody({ nMessages = 2, ttl = '5m', sentinelTail = null } = {}) {
  const messages = [];
  for (let i = 0; i < nMessages; i++) {
    messages.push(i % 2 === 0
      ? { role: 'user', content: [{ type: 'text', text: `turn ${i}` }] }
      : { role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] });
  }
  if (sentinelTail) {
    messages.push({ role: 'user', content: [{ type: 'text', text: sentinelTail }] });
  }
  // rolling marker on the last message, like the CLI
  const last = messages[messages.length - 1];
  last.content[0].cache_control = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  return {
    model: 'claude-haiku-4-5',
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: v=1;cch=abc123' },
      { type: 'text', text: 'You are Claude Code', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Full system prompt here', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
    tools: [{ name: 'Bash', input_schema: {} }, { name: 'Read', input_schema: {} }],
    messages,
  };
}

const CACHED = { cache_creation_input_tokens: 500, cache_read_input_tokens: 0 };
const READ = { cache_creation_input_tokens: 0, cache_read_input_tokens: 9000 };
const UNCACHED = { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

test('canonicalization: cache_control never affects the hash (rolling marker)', () => {
  const a = makeBody({ nMessages: 3 });
  const b = JSON.parse(JSON.stringify(a));
  // hop the marker to a different message — history is "the same"
  delete b.messages[2].content[0].cache_control;
  b.messages[0].content[0].cache_control = { type: 'ephemeral' };
  assert.equal(prefixHash(a, 3), prefixHash(b, 3));
  // but actual content change → different hash
  const c = JSON.parse(JSON.stringify(a));
  c.messages[0].content[0].text = 'different';
  assert.notEqual(prefixHash(a, 3), prefixHash(c, 3));
});

test('canonicalization: key order irrelevant, billing header excluded from fingerprint', () => {
  assert.equal(canonJson({ b: 1, a: [{ z: 1, y: 2 }] }), '{"a":[{"y":2,"z":1}],"b":1}');
  const a = makeBody();
  const b = JSON.parse(JSON.stringify(a));
  b.system[0].text = 'x-anthropic-billing-header: v=1;cch=DIFFERENT'; // volatile per-turn
  assert.equal(prefixHash(a, 2), prefixHash(b, 2));
  // model change invalidates (reads cold, never collides)
  const c = JSON.parse(JSON.stringify(a));
  c.model = 'claude-fable-5';
  assert.notEqual(prefixHash(a, 2), prefixHash(c, 2));
});

test('stripCacheControl deep-removes at any level', () => {
  const node = { a: [{ cache_control: { x: 1 }, keep: 1 }], cache_control: 2 };
  assert.deepEqual(stripCacheControl(node), { a: [{ keep: 1 }] });
});

test('segmentHashes: marker 1 = tools, last marker = system; ttl per marker', () => {
  const obj = makeBody();
  const segs = segmentHashes(obj);
  assert.ok(segs.tools && segs.system);
  assert.equal(segs.tools.ttl, 300);
  assert.equal(segs.system.ttl, 3600);
  assert.notEqual(segs.tools.hash, segs.system.hash);
  // identical tools+system in a DIFFERENT session → same hashes (sharing)
  const other = makeBody({ nMessages: 6 });
  const segs2 = segmentHashes(other);
  assert.equal(segs.tools.hash, segs2.tools.hash);
  assert.equal(segs.system.hash, segs2.system.hash);
  // single marker → only "system"
  const single = makeBody();
  single.system = [single.system[2]];
  const segs3 = segmentHashes(single);
  assert.equal(segs3.tools, undefined);
  assert.ok(segs3.system);
});

test('markerTtl: message tail wins, system fallback, default 300', () => {
  assert.equal(markerTtl(makeBody({ ttl: '1h' })), 3600);
  assert.equal(markerTtl(makeBody({ ttl: '5m' })), 300);
  const noTail = makeBody();
  delete noTail.messages[1].content[0].cache_control;
  assert.equal(markerTtl(noTail), 300); // system marker fallback (first is 5m)
  assert.equal(markerTtl({ messages: [] }), 300);
});

test('two-state: stamp → warm; clock past expiry → cold; unknown → absent', () => {
  let now = 1000000;
  const w = new WarmthStore({ now: () => now });
  const obj = makeBody();
  const rec = w.record(obj, CACHED, 'sess-1');
  assert.ok(rec);
  assert.equal(rec.ttl, 300);
  assert.equal(rec.warm_on_arrival, false); // created, not read
  assert.equal(w.state(rec.hash), 'warm');
  now += 299;
  assert.equal(w.state(rec.hash), 'warm');
  now += 2;
  assert.equal(w.state(rec.hash), 'cold'); // lapsed, row still on disk
  assert.equal(w.state('feedfeed'), 'absent');
  assert.equal(w.warm(rec.hash), false);
  w.close();
});

test('stamps are response-confirmed: no cache event → no row', () => {
  const w = new WarmthStore({});
  const rec = w.record(makeBody(), UNCACHED, 'sess-1');
  assert.equal(rec, null);
  assert.equal(w.query({ session: 'sess-1' }).found, false);
  w.close();
});

test('a cache read re-stamps (TTL slides) and reports warm_on_arrival', () => {
  let now = 1000000;
  const w = new WarmthStore({ now: () => now });
  const obj = makeBody();
  w.record(obj, CACHED, 'sess-1');
  now += 250;
  const rec2 = w.record(obj, READ, 'sess-1');
  assert.equal(rec2.warm_on_arrival, true);
  now += 250; // 500 past first stamp — would have lapsed without the slide
  assert.equal(w.state(rec2.hash), 'warm');
  const q = w.query({ session: 'sess-1' });
  assert.equal(q.found && q.warm, true);
  assert.equal(q.ttl_s, 300);
  w.close();
});

test('cold-resume counter: lapsed head + real turn increments; first turn never counts', () => {
  let now = 1000000;
  const w = new WarmthStore({ now: () => now });
  const t1 = makeBody({ nMessages: 2 });
  const rec1 = w.record(t1, CACHED, 'sess-1');
  assert.equal(rec1.cold_resume, false); // initial cold start, not a resume
  assert.equal(rec1.cold_resumes, 0);
  now += 400; // 5m ttl lapsed
  const t2 = makeBody({ nMessages: 4 });
  const rec2 = w.record(t2, CACHED, 'sess-1');
  assert.equal(rec2.cold_resume, true);
  assert.equal(rec2.cold_resumes, 1);
  assert.equal(w.coldResumes('sess-1'), 1);
  now += 100; // still warm
  const t3 = makeBody({ nMessages: 6 });
  const rec3 = w.record(t3, READ, 'sess-1');
  assert.equal(rec3.cold_resume, false);
  assert.equal(w.coldResumes('sess-1'), 1);
  w.close();
});

test('ping: hashes up to (not incl.) the sentinel tail; refreshes shared prefix, never the head', () => {
  let now = 1000000;
  const w = new WarmthStore({ now: () => now, sentinel: '[keep-warm]' });
  const real = makeBody({ nMessages: 4 });
  const rec = w.record(real, CACHED, 'sess-1');
  // fork's ping: same 4-message history + throwaway sentinel tail
  const ping = makeBody({ nMessages: 4, sentinelTail: '[keep-warm] ping' });
  assert.equal(isWarmPing(ping, '[keep-warm]'), true);
  now += 250;
  const pingRec = w.record(ping, READ, 'fork-sess-9');
  assert.equal(pingRec.ping, true);
  assert.equal(pingRec.hash, rec.hash); // same prefix, tail excluded
  now += 250;
  assert.equal(w.state(rec.hash), 'warm'); // ping slid the TTL
  // the fork's own session id never grew a head row
  assert.equal(w.query({ session: 'fork-sess-9' }).found, false);
  assert.equal(w.query({ session: 'sess-1' }).hash, rec.hash);
  w.close();
});

test('coldPingDecision: declines on cold/absent, passes on warm, ignores non-pings', () => {
  let now = 1000000;
  const w = new WarmthStore({ now: () => now, sentinel: '[keep-warm]' });
  const ping = makeBody({ nMessages: 4, sentinelTail: '[keep-warm] ping' });
  // never stamped → absent → decline
  const d1 = w.coldPingDecision(ping);
  assert.equal(d1.blocked, true);
  assert.equal(d1.warmth_state, 'absent');
  // stamp the real prefix → warm → forward
  w.record(makeBody({ nMessages: 4 }), CACHED, 'sess-1');
  assert.equal(w.coldPingDecision(ping), null);
  // lapse → cold → decline
  now += 400;
  assert.equal(w.coldPingDecision(ping).warmth_state, 'cold');
  // a real turn is never a ping decision
  assert.equal(w.coldPingDecision(makeBody({ nMessages: 4 })), null);
  w.close();
});

test('segments readout: sibling session shares rows; lapse reads cold', () => {
  let now = 1000000;
  const w = new WarmthStore({ now: () => now });
  w.record(makeBody({ nMessages: 2 }), CACHED, 'sess-a');
  w.record(makeBody({ nMessages: 8 }), CACHED, 'sess-b'); // same tools+system
  const segA = w.segments('sess-a');
  const segB = w.segments('sess-b');
  assert.equal(segA.tools.hash, segB.tools.hash);
  assert.equal(segA.system.state, 'warm');
  assert.equal(segA.system.ttl_s, 3600);
  now += 400; // tools (5m) lapses, system (1h) stays
  const seg2 = w.segments('sess-a');
  assert.equal(seg2.tools.state, 'cold');
  assert.equal(seg2.system.state, 'warm');
  assert.equal(w.segments('nobody'), null);
  w.close();
});

test('persistence: reopening the same file keeps rows and heads (schema re-run safe)', async () => {
  const path = require('path');
  const os = require('os');
  const fs = require('fs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'warmth-')), 'w.sqlite');
  let now = 1000000;
  const w1 = new WarmthStore({ now: () => now, path: file });
  const rec = w1.record(makeBody(), CACHED, 'sess-1');
  w1.close();
  const w2 = new WarmthStore({ now: () => now, path: file }); // ALTERs re-run, swallowed
  assert.equal(w2.state(rec.hash), 'warm');
  assert.equal(w2.query({ session: 'sess-1' }).hash, rec.hash);
  w2.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('sweep is hygiene-only: reclaims long-lapsed rows, never changes verdicts', () => {
  let now = 1000000;
  const w = new WarmthStore({ now: () => now });
  const rec = w.record(makeBody(), CACHED, 'sess-1');
  now += 400;
  assert.equal(w.state(rec.hash), 'cold');
  w.sweep(); // default slack 7d — row stays
  assert.equal(w.state(rec.hash), 'cold');
  now += 8 * 24 * 3600;
  w.sweep();
  assert.equal(w.state(rec.hash), 'absent'); // reclaimed; verdict still not-warm
  w.close();
});
