// Run: node --test
// W3 intent cutover pieces (wire-intents.js): the claim-once deduper that
// makes wire-dispatch and transcript-recovery overlap safe, the wire-event
// activity state machine, and the transcript sentinel (symlink identity +
// compact rendezvous + recovery arming).
const { test } = require('node:test');
const assert = require('node:assert');
const { IntentDeduper, ActivityTracker, TranscriptSentinel } = require('../wire-intents');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('IntentDeduper: source-aware claim matrix ({ok, reason})', () => {
  let now = 1000;
  const mk = () => new IntentDeduper({ ttl: 100, now: () => now });

  // wire-after-wire: ALLOWED (distinct turns are distinct emissions — collapsing
  // them would eat a deliberate retry, the exact bug this fix closes).
  {
    const d = mk();
    assert.deepStrictEqual(d.claim('alice', 'k1', 'wire'), { ok: true, reason: null });
    assert.deepStrictEqual(d.claim('alice', 'k1', 'wire'), { ok: true, reason: null });
  }
  // cross-path overlap: REJECT both directions (the real dedupe case).
  {
    const d = mk();
    assert.strictEqual(d.claim('alice', 'k1', 'wire').ok, true);
    const r = d.claim('alice', 'k1', 'recovery');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /cross-path overlap \(wire→recovery\)/);
  }
  {
    const d = mk();
    assert.strictEqual(d.claim('alice', 'k1', 'recovery').ok, true);
    const r = d.claim('alice', 'k1', 'wire');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /cross-path overlap \(recovery→wire\)/);
  }
  // recovery-after-recovery: REJECT (the replay tail repeats each poll).
  {
    const d = mk();
    assert.strictEqual(d.claim('alice', 'k1', 'recovery').ok, true);
    const r = d.claim('alice', 'k1', 'recovery');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /recovery replay repeat/);
  }
  // per-agent namespaces + TTL expiry + prune all re-open a fresh claim.
  {
    const d = mk();
    assert.strictEqual(d.claim('alice', 'k1', 'wire').ok, true);
    assert.strictEqual(d.claim('bob', 'k1', 'recovery').ok, true); // other agent unaffected
    // A cross-path prior blocks until TTL expiry, then re-opens.
    assert.strictEqual(d.claim('alice', 'k1', 'recovery').ok, false);
    now += 101;
    assert.strictEqual(d.claim('alice', 'k1', 'recovery').ok, true); // TTL expired
    d.prune(new Set(['alice']));
    assert.strictEqual(d.claim('bob', 'k1', 'wire').ok, true);       // pruned -> fresh
  }
  // default source is 'wire' (call-site omission stays back-compatible).
  {
    const d = mk();
    assert.strictEqual(d.claim('alice', 'k1').ok, true);
    assert.strictEqual(d.claim('alice', 'k1').ok, true); // wire-after-wire default
  }
});

test('ActivityTracker: thinking on request, idle+turnEnd on terminal stop, side-calls invisible', () => {
  const events = [];
  const a = new ActivityTracker((agent, state, meta) => events.push([agent, state, meta.turnEnd]));
  a.turnStarted('alice', { reqId: 'r1', sideCall: true });      // title call: nothing
  assert.deepStrictEqual(events, []);
  a.turnStarted('alice', { reqId: 'r2', sideCall: false });
  a.turnStarted('alice', { reqId: 'r3', sideCall: false });     // already thinking: deduped
  assert.deepStrictEqual(events, [['alice', 'thinking', false]]);
  // tool_use hop completes -> still thinking (r3 in flight)
  a.turnCompleted('alice', { reqId: 'r2', sideCall: false, stop: { is_turn: false } });
  assert.strictEqual(events.length, 1);
  // terminal stop -> idle with turnEnd (the notification-worthy one)
  a.turnCompleted('alice', { reqId: 'r3', sideCall: false, stop: { is_turn: true } });
  assert.deepStrictEqual(events.at(-1), ['alice', 'idle', true]);
});

test('ActivityTracker: quiet-gap idle (mid-turn silence) is turnEnd:false; new request cancels it', async () => {
  const events = [];
  const a = new ActivityTracker((agent, state, meta) => events.push([state, meta.turnEnd]), { idleGapMs: 20 });
  a.turnStarted('alice', { reqId: 'r1' });
  a.turnCompleted('alice', { reqId: 'r1', stop: { is_turn: false } }); // tool hop, nothing in flight
  a.turnStarted('alice', { reqId: 'r2' });                            // next request beats the timer
  await sleep(35);
  assert.deepStrictEqual(events, [['thinking', false]]);              // no idle flap between hops
  a.turnCompleted('alice', { reqId: 'r2', stop: { is_turn: false } });
  await sleep(35);                                                    // now the gap elapses
  assert.deepStrictEqual(events.at(-1), ['idle', false]);             // quiet-gap idle: no notification
});

test('ActivityTracker: failed request (tee-failure) cannot wedge thinking', async () => {
  const events = [];
  const a = new ActivityTracker((_n, state) => events.push(state), { idleGapMs: 10 });
  a.turnStarted('alice', { reqId: 'r1' });
  a.requestFailed('alice', 'r1');
  await sleep(25);
  assert.deepStrictEqual(events, ['thinking', 'idle']);
});

test('ActivityTracker: receipt lost entirely (no completed, no failed) expires instead of pinning thinking', async () => {
  const events = [];
  const a = new ActivityTracker((_n, state, meta) => events.push([state, meta.turnEnd]),
    { idleGapMs: 10, inflightMaxAgeMs: 30 });
  a.turnStarted('alice', { reqId: 'r1' });
  // r1's turn.completed never arrives — pre-fix this stayed 'thinking' forever.
  await sleep(80); // max-age sweep drops r1, quiet-gap timer follows
  assert.deepStrictEqual(events, [['thinking', false], ['idle', false]]); // gap idle: no notification
  // The receipt arriving AFTER expiry is harmless: already idle, deduped,
  // and its turnEnd notification is forfeit (the request was silent >maxAge).
  a.turnCompleted('alice', { reqId: 'r1', stop: { is_turn: true } });
  assert.strictEqual(events.length, 2);
});

test('ActivityTracker: max-age sweep drops only stale entries — a fresh request keeps thinking', async () => {
  const events = [];
  const a = new ActivityTracker((_n, state, meta) => events.push([state, meta.turnEnd]),
    { idleGapMs: 10, inflightMaxAgeMs: 70 });
  a.turnStarted('alice', { reqId: 'r1' });   // receipt will be lost
  await sleep(35);
  a.turnStarted('alice', { reqId: 'r2' });   // live work, well inside max-age
  await sleep(55); // sweep at ~70ms expires r1 only; r2 holds thinking, no idle flap
  assert.deepStrictEqual(events, [['thinking', false]]);
  a.turnCompleted('alice', { reqId: 'r2', stop: { is_turn: true } });
  assert.deepStrictEqual(events.at(-1), ['idle', true]); // real turn end still notifies
});

const fakeWatcherFactory = (made) => (cbs) => {
  const w = { started: false, stopped: false, cbs,
    start() { this.started = true; }, stop() { this.stopped = true; } };
  made.push(w);
  return w;
};

test('TranscriptSentinel: symlink repoint fires onSessionId; dangling link is silent', async () => {
  const ids = [];
  let target = null;
  const fakeFs = { realpathSync: () => { if (!target) throw new Error('dangling'); return target; } };
  const s = new TranscriptSentinel({
    linkPath: '/reg/alice.jsonl', onSessionId: (id) => ids.push(id),
    makeWatcher: fakeWatcherFactory([]), fs: fakeFs, pollMs: 5,
  });
  s.start();
  await sleep(15);
  assert.deepStrictEqual(ids, []);              // CLI not booted yet
  target = '/proj/sid-AAA.jsonl';
  await sleep(15);
  target = '/proj/sid-BBB.jsonl';               // /clear repoints
  await sleep(15);
  s.stop();
  assert.deepStrictEqual(ids, ['sid-AAA', 'sid-BBB']);
});

test('TranscriptSentinel: compact rendezvous arms a watcher, summary disarms + fires once', () => {
  const made = [];
  const s = new TranscriptSentinel({
    linkPath: '/reg/a.jsonl', makeWatcher: fakeWatcherFactory(made),
    fs: { realpathSync: () => '/t/sid.jsonl' }, pollMs: 5,
  });
  let fired = 0;
  s.armCompact(() => fired++);
  assert.strictEqual(made.length, 1);
  assert.ok(made[0].started);
  made[0].cbs.onCompactSummary();
  assert.strictEqual(fired, 1);
  assert.ok(made[0].stopped);
  // Re-arm replaces (an abandoned earlier window can't leak a watcher).
  s.armCompact(() => {});
  s.armCompact(() => {});
  assert.ok(made[1].stopped);
  s.stop();
  assert.ok(made[2].stopped);
});

test('TranscriptSentinel: abandoned compact window times out and stops parsing', async () => {
  const made = [];
  let now = 0;
  const s = new TranscriptSentinel({
    linkPath: '/reg/a.jsonl', makeWatcher: fakeWatcherFactory(made),
    fs: { realpathSync: () => '/t/sid.jsonl' }, pollMs: 5, now: () => now,
  });
  s.start();
  s.armCompact(() => { throw new Error('must not fire'); });
  now = 11 * 60_000; // past COMPACT_ARM_TIMEOUT
  await sleep(15);   // next poll notices
  assert.ok(made[0].stopped);
  s.stop();
});

test('TranscriptSentinel: recovery is idempotent, healthy wire turn ends it', () => {
  const made = [];
  const s = new TranscriptSentinel({
    linkPath: '/reg/a.jsonl', makeWatcher: fakeWatcherFactory(made),
    fs: { realpathSync: () => '/t/sid.jsonl' },
  });
  const texts = [];
  s.armRecovery((t) => texts.push(t));
  s.armRecovery(() => { throw new Error('second arm must be a no-op'); });
  assert.strictEqual(made.length, 1);
  assert.ok(s.recovering);
  made[0].cbs.onText('turn text');            // replayed tail flows through
  assert.deepStrictEqual(texts, ['turn text']);
  s.noteWireHealthy();
  assert.ok(made[0].stopped);
  assert.ok(!s.recovering);
  s.noteWireHealthy();                        // idempotent
});
