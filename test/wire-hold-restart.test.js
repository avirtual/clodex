'use strict';

// Run: node --test
// Restart survival for PERPETUAL keep-warm holds (t411).
//
// The bug this pins: a `keepWarmAlways` hold does not survive an app restart.
// The keeper is in-memory, so the last-request bytes a ping replays are gone,
// and the intent was only restored on the seat's next MAIN-LINE TURN — which on
// an idle seat never arrives. Measured live: 5.5 hours, no pings, cache cold,
// `keepWarmAlways: true` on the record the whole time.
//
// So every test here restarts with NO INTERVENING TURN. A test that lets the
// restarted keeper see a turn first proves nothing at all — noteRequest would
// have refilled the entry map and the old code would pass it too. `restart()`
// below is deliberately the only way these tests build a second keeper, and it
// takes no traffic.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { HoldKeeper } = require('../wire/hold');
const { HoldEntryStore } = require('../wire/hold-store');
const { WarmthStore, prefixHash } = require('../wire/warmth');

const SID = '4a59af49-cc52-44b7-8b02-7f4196a4b486';

function makeObj(overrides = {}) {
  return {
    model: 'claude-opus-4-8',
    stream: true,
    max_tokens: 32000,
    system: [{ type: 'text', text: 'You are a test.' }],
    tools: [{ name: 'Bash' }],
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
    ...overrides,
  };
}

// One "machine": a durable entry-store path plus a warmth ledger that OUTLIVES
// the keeper, which is what the real one does (sqlite under userData). Sharing
// the ledger across the restart is not a shortcut — it is the only way the
// warm/cold distinction after a restart means anything.
function machine(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hold-restart-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const file = path.join(dir, 'wire-hold-entries.json');
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const warmth = new WarmthStore({ now });
  const errors = [];
  const sent = [];
  const responder = { status: 200 };
  const request = async (url, headers, body) => {
    sent.push({ url, headers, body: JSON.parse(body.toString('utf8')) });
    return {
      status: responder.status,
      headers: { 'request-id': 'req_fake1' },
      body: Buffer.from(JSON.stringify({ usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } })),
    };
  };
  const boot = () => new HoldKeeper({
    warmth, now, request,
    entryStore: new HoldEntryStore({ path: file, onError: (m) => errors.push(m) }),
  });
  return { dir, file, clock, warmth, sent, errors, responder, boot,
    stampWarm: (obj) => warmth.record(obj, { cache_creation_input_tokens: 100, cache_read_input_tokens: 0 }, SID),
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('THE BUG: a perpetual hold pings after a restart with no intervening turn', async (t) => {
  const m = machine(t);
  const obj = makeObj();

  // --- launch 1: an operator arms `always` on a warm seat, then the app dies.
  const before = m.boot();
  before.noteRequest(SID, obj, { authorization: 'Bearer tok', 'anthropic-beta': 'x' }, 'http://up/v1/messages');
  m.stampWarm(obj);
  assert.strictEqual(before.arm(SID, 0, { always: true }).armed, true,
    'ENTER: the hold armed in launch 1 — everything below is about surviving it');
  before.stop();

  // --- launch 2. A NEW keeper: nothing in memory, and no turn will ever come.
  const after = m.boot();
  assert.strictEqual(after.entry(SID), null, 'ENTER: the restarted keeper starts amnesiac');
  assert.deepStrictEqual(after.holds(), {}, 'ENTER: and with no armed hold — this IS the bug');

  const r = after.restorePerpetual({ accept: () => true });
  assert.deepStrictEqual(r, { restored: 1, declined: 0, dropped: 0 });

  // Armed again, perpetually, with the replayable bytes back.
  assert.strictEqual(after.holds()[SID].always, true);
  assert.strictEqual(after.holds()[SID].until, null);
  assert.ok(after.entry(SID), 'the replay entry came back off disk');

  // And the thing the operator actually paid for: it PINGS. Drive the clock to
  // inside the margin so the tick is due, exactly as it would be on an idle seat.
  m.clock.t += 300 - 60; // ttl 300, margin 300 → due once remaining < 300 and > 0
  await after.tick();
  assert.strictEqual(m.sent.length, 1, 'the restored hold pinged with no turn taken');
  assert.strictEqual(m.sent[0].body.max_tokens, 1, 'and it is the minimal warming replay');
  assert.deepStrictEqual(m.sent[0].body.messages, obj.messages, 'same prefix — a cache READ');
  assert.strictEqual(m.sent[0].headers.authorization, 'Bearer tok',
    'replayed with the session own headers; without them it is not a replay');
  after.stop();
});

test('the warm-only gate survives the restore: a prefix that went cold DECLINES', async (t) => {
  const m = machine(t);
  const obj = makeObj();

  const before = m.boot();
  before.noteRequest(SID, obj, { authorization: 'Bearer tok' }, 'http://up/v1/messages');
  m.stampWarm(obj);
  assert.strictEqual(before.arm(SID, 0, { always: true }).armed, true,
    'ENTER: armed while warm, so the decline below is about the DOWNTIME going cold');
  before.stop();

  // A long downtime: the ledger row lapses. A restart is not a reason to pay
  // for a cache write, so the restore must decline exactly as arm() always does.
  m.clock.t += 10_000;
  assert.strictEqual(m.warmth.state(prefixHash(obj, obj.messages.length)), 'cold',
    'ENTER: the prefix really is cold now — a still-warm one would prove nothing');

  const after = m.boot();
  const r = after.restorePerpetual({ accept: () => true });
  assert.deepStrictEqual(r, { restored: 0, declined: 1, dropped: 0 });
  assert.deepStrictEqual(after.holds(), {}, 'nothing armed against a cold prefix');

  await after.tick();
  assert.strictEqual(m.sent.length, 0, 'and not one forced cache write');
  // The declined record is dropped rather than left holding a token on disk.
  assert.strictEqual(fs.existsSync(m.file), false);
  after.stop();
});

test('a TIMED hold gains nothing: it is not persisted and does not restore', async (t) => {
  const m = machine(t);
  const obj = makeObj();

  const before = m.boot();
  before.noteRequest(SID, obj, { authorization: 'Bearer tok' }, 'http://up/v1/messages');
  m.stampWarm(obj);
  assert.strictEqual(before.arm(SID, 4).armed, true,
    'ENTER: a 4h TIMED hold is armed — the negative below is about this hold');
  assert.strictEqual(before.holds()[SID].always, false);
  before.stop();

  // Nothing written at all. A timed hold keeps its on-first-turn behaviour, and
  // the conversation bytes of an attended seat stay off the disk entirely.
  assert.strictEqual(fs.existsSync(m.file), false,
    'a timed hold writes no file — scoping is the whole reason this is safe');

  const after = m.boot();
  assert.deepStrictEqual(after.restorePerpetual({ accept: () => true }),
    { restored: 0, declined: 0, dropped: 0 });
  assert.deepStrictEqual(after.holds(), {});
  await after.tick();
  assert.strictEqual(m.sent.length, 0);
  after.stop();
});

test('accept() is the authority on whether a persisted conversation may still be pinged', async (t) => {
  const m = machine(t);
  const obj = makeObj();

  const before = m.boot();
  before.noteRequest(SID, obj, { authorization: 'Bearer tok' }, 'http://up/v1/messages');
  m.stampWarm(obj);
  before.arm(SID, 0, { always: true });
  before.stop();
  assert.strictEqual(m.read().records.length, 1, 'ENTER: there IS a record to reject');

  // The operator turned keep-warm off, or archived the seat, while the app was
  // down — the record on disk is stale and must not spend anything.
  const after = m.boot();
  assert.deepStrictEqual(after.restorePerpetual({ accept: () => false }),
    { restored: 0, declined: 0, dropped: 1 });
  assert.deepStrictEqual(after.holds(), {});
  await after.tick();
  assert.strictEqual(m.sent.length, 0);
  // Rejected means the token comes off the disk now, not at some later write.
  assert.strictEqual(fs.existsSync(m.file), false);
  after.stop();
});

test('the persisted set tracks the live one: never the entry map, gone on disarm', (t) => {
  const m = machine(t);
  const obj = makeObj();
  const k = m.boot();

  // Three sessions cross the wire; only one is armed perpetually. maxEntries is
  // 2000 in production — spilling the map to fix a bug about a handful of armed
  // seats is the thing this scoping exists to prevent.
  k.noteRequest('other-1', makeObj({ messages: [{ role: 'user', content: 'a' }] }), { authorization: 'Bearer o1' }, 'http://up/v1/messages');
  k.noteRequest(SID, obj, { authorization: 'Bearer tok' }, 'http://up/v1/messages');
  k.noteRequest('other-2', makeObj({ messages: [{ role: 'user', content: 'b' }] }), { authorization: 'Bearer o2' }, 'http://up/v1/messages');
  m.stampWarm(obj);
  k.arm(SID, 0, { always: true });

  const recs = m.read().records;
  assert.deepStrictEqual(recs.map((r) => r.sessionId), [SID],
    'only the armed-perpetual seat is on disk');
  assert.strictEqual(recs[0].headers.authorization, 'Bearer tok');

  // A later organic turn refreshes the persisted bytes — replaying a stale
  // prefix after a restart would be the cold write the warm gate forbids.
  const obj2 = makeObj({ messages: [...obj.messages, { role: 'user', content: 'more' }] });
  k.noteRequest(SID, obj2, { authorization: 'Bearer tok2' }, 'http://up/v1/messages');
  const rec2 = m.read().records[0];
  assert.deepStrictEqual(rec2.obj.messages, obj2.messages, 'the persisted replay follows the live one');
  assert.strictEqual(rec2.headers.authorization, 'Bearer tok2');

  // Disarming takes the credential off the disk immediately.
  k.disarm(SID);
  assert.strictEqual(fs.existsSync(m.file), false);
  k.stop();
});

test('mode 0600, and a broken store degrades the hold instead of breaking the keeper', (t) => {
  const m = machine(t);
  const obj = makeObj();
  const k = m.boot();
  k.noteRequest(SID, obj, { authorization: 'Bearer tok' }, 'http://up/v1/messages');
  m.stampWarm(obj);
  k.arm(SID, 0, { always: true });

  // The file holds conversation bytes and a bearer token.
  assert.strictEqual(fs.statSync(m.file).mode & 0o777, 0o600);
  k.stop();

  // Unreadable/corrupt on the next launch: load() yields nothing, the keeper
  // still constructs and still ticks. Losing restart survival is a degradation;
  // a keeper that throws on boot is an outage.
  fs.writeFileSync(m.file, 'not json at all{{', { mode: 0o600 });
  const after = m.boot();
  assert.deepStrictEqual(after.restorePerpetual({ accept: () => true }),
    { restored: 0, declined: 0, dropped: 0 });
  assert.deepStrictEqual(after.holds(), {});
  after.stop();
});

test('a keeper with no entryStore is exactly as in-memory as before', (t) => {
  const m = machine(t);
  const obj = makeObj();
  const k = new HoldKeeper({ warmth: m.warmth, now: () => m.clock.t, request: async () => { throw new Error('no pings here'); } });
  k.noteRequest(SID, obj, { authorization: 'Bearer tok' }, 'http://up/v1/messages');
  m.stampWarm(obj);
  assert.strictEqual(k.arm(SID, 0, { always: true }).armed, true,
    'ENTER: armed perpetually WITHOUT a store — the absence below is the point');
  assert.strictEqual(fs.existsSync(m.file), false, 'no store, no file, no token on disk');
  assert.deepStrictEqual(k.restorePerpetual({ accept: () => true }), { restored: 0, declined: 0, dropped: 0 });
  k.stop();
});
