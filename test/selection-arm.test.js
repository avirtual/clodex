// selection-arm.js — WHEN the operator's drawer selection is on the wire.
//
// The composer's own tests (selection-hint.test.js) pin what the text says.
// What is worth pinning here is traffic and tier interaction: the same bytes
// must not be POSTed twice, must not ride under two framings at once, and a
// refused POST must not leave a memo claiming the proxy holds something.

const { test } = require('node:test');
const assert = require('node:assert');

const { createSelectionArm } = require('../selection-arm');
const { PEEK_ID, ATTACH_ID } = require('../selection-hint');

const CTX = { agent: 'seat', base: 'http://127.0.0.1:7800', route: 'clodex-seat-ab12' };

// Records every call so the assertions can be about TRAFFIC, which is the whole
// subject — a test that only checked the return value would pass against an
// implementation that POSTs on every mouse move.
function mk(overrides = {}) {
  const armed = [];
  const cleared = [];
  const arm = createSelectionArm({
    enabled: () => true,
    armHints: ({ route, hint }) => { armed.push({ route, ...hint }); return Promise.resolve({ status: 200 }); },
    clearHints: ({ route, id }) => { cleared.push({ route, id }); return Promise.resolve({ status: 200 }); },
    ...overrides,
  });
  return { arm, armed, cleared };
}

// A proxy whose round trips can be resolved BY THE TEST, in any order. The
// interleavings below are the whole subject of this half of the file: every
// defect the cold review found lived in a second call arriving before the
// first had resolved, and a mock that resolves synchronously cannot reach any
// of them.
function slowMk(overrides = {}) {
  const ops = [];        // { kind: 'arm'|'clear', id, release }
  const landed = [];     // ops in the order they reached the "proxy"
  function op(kind, id) {
    let release;
    const p = new Promise((res) => { release = res; });
    const rec = {
      kind,
      id,
      // Landing is what the ORDER assertions are about: an op that was issued
      // early but resolves late reaches the proxy late, which is precisely how
      // a DELETE overtook the POST it was meant to undo.
      release: (v = { status: 200 }) => { landed.push(`${kind}:${id}`); release(v); },
    };
    ops.push(rec);
    return p;
  }
  const arm = createSelectionArm({
    enabled: () => true,
    armHints: ({ hint }) => op('arm', hint.id),
    clearHints: ({ id }) => op('clear', id),
    ...overrides,
  });
  const pending = (kind) => ops.filter((o) => o.kind === kind && !landed.includes(`${o.kind}:${o.id}`));
  // Lets the chain advance as far as it can without resolving anything new.
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { arm, ops, landed, pending, settle };
}

test('a peek arms once and re-arming the same text does not POST again', async () => {
  const { arm, armed } = mk();
  const a = await arm.arm('seat', { text: 'hello', tab: 'term' }, CTX);
  assert.strictEqual(a.armed, true, 'ENTER: the first arm went through');
  assert.strictEqual(armed.length, 1, 'exactly one POST for the first selection');
  assert.strictEqual(armed[0].id, PEEK_ID);

  // A drag that ends where it started, or a feed re-render reporting an
  // unchanged selection. Both are common; each one would otherwise be a request.
  const b = await arm.arm('seat', { text: 'hello', tab: 'term' }, CTX);
  assert.strictEqual(b.armed, true, 'still armed');
  assert.strictEqual(b.unchanged, true);
  assert.strictEqual(armed.length, 1, 'no second POST for identical text');
});

test('a changed selection overwrites on the same id rather than accreting', async () => {
  const { arm, armed } = mk();
  await arm.arm('seat', { text: 'one', tab: 'ctl' }, CTX);
  await arm.arm('seat', { text: 'two', tab: 'ctl' }, CTX);
  assert.strictEqual(armed.length, 2, 'ENTER: both arms POSTed');
  assert.strictEqual(armed[0].id, armed[1].id, 'the fixed id is what makes this an overwrite');
  assert.ok(armed[1].text.includes('two'));
});

test('an emptied selection CLEARS rather than leaving the last one riding', async () => {
  const { arm, armed, cleared } = mk();
  await arm.arm('seat', { text: 'something', tab: 'log' }, CTX);
  assert.strictEqual(armed.length, 1, 'ENTER: something was armed to clear');
  const r = await arm.arm('seat', { text: '   ', tab: 'log' }, CTX);
  assert.strictEqual(r.armed, false);
  assert.deepStrictEqual(cleared, [{ route: CTX.route, id: PEEK_ID }]);
});

test('clearing what was never armed costs no request', async () => {
  const { arm, cleared } = mk();
  await arm.arm('seat', { text: '', tab: 'log' }, CTX);
  await arm.release('seat', CTX);
  assert.deepStrictEqual(cleared, [], 'the memo, not the proxy, is what says there is nothing to clear');
});

test('attaching suppresses the peek carrying the same bytes', async () => {
  const { arm, armed, cleared } = mk();
  // The realistic order: the drag arms a peek, then the operator clicks Copy.
  await arm.arm('seat', { text: 'the line', tab: 'term' }, CTX);
  const at = await arm.arm('seat', { text: 'the line', tab: 'term', attach: true }, CTX);
  assert.strictEqual(at.armed, true, 'ENTER: the attach went through');
  assert.strictEqual(at.attached, true);
  assert.deepStrictEqual(armed.map((h) => h.id), [PEEK_ID, ATTACH_ID]);
  // Without this the model gets the same text twice under two framings, one
  // calling it deliberate and one calling it possibly irrelevant.
  assert.deepStrictEqual(cleared, [{ route: CTX.route, id: PEEK_ID }],
    'the superseded peek came off the wire');
});

test('a peek is refused while the identical text is attached', async () => {
  const { arm, armed } = mk();
  await arm.arm('seat', { text: 'x marks', tab: 'term', attach: true }, CTX);
  assert.strictEqual(armed.length, 1, 'ENTER: the attachment is live');
  // Re-selecting the text you just attached (very easy: the selection is still
  // there after the click) must not re-add it as a peek.
  const p = await arm.arm('seat', { text: 'x marks', tab: 'term' }, CTX);
  assert.strictEqual(p.armed, false);
  assert.strictEqual(p.reason, 'already attached');
  assert.strictEqual(armed.length, 1, 'no duplicate on the wire');
});

test('clicking Copy again on attached text DETACHES it', async () => {
  const { arm, armed, cleared } = mk();
  await arm.arm('seat', { text: 'keep me', tab: 'ctl', attach: true }, CTX);
  assert.strictEqual(armed.length, 1, 'ENTER: attached');
  // An attachment is not `once`, so without this gesture the operator's text
  // rides every request until the TTL runs out with no way to stop it.
  const off = await arm.arm('seat', { text: 'keep me', tab: 'ctl', attach: true }, CTX);
  assert.strictEqual(off.armed, false);
  assert.strictEqual(off.detached, true);
  assert.deepStrictEqual(cleared, [{ route: CTX.route, id: ATTACH_ID }]);
  assert.strictEqual(armed.length, 1, 'the toggle-off is a clear, not another arm');

  // And it is genuinely gone: the next click re-attaches rather than being
  // dropped as unchanged.
  const on = await arm.arm('seat', { text: 'keep me', tab: 'ctl', attach: true }, CTX);
  assert.strictEqual(on.armed, true, 'the register was released, not merely reported');
  assert.strictEqual(armed.length, 2);
});

test('release takes back the peek and leaves the attachment alone', async () => {
  const { arm, cleared } = mk();
  await arm.arm('seat', { text: 'attached text', tab: 'term', attach: true }, CTX);
  await arm.arm('seat', { text: 'peeked text', tab: 'term' }, CTX);
  await arm.release('seat', CTX);
  // The operator asked for the attachment; a tab switch or a collapse is not a
  // retraction of that.
  assert.deepStrictEqual(cleared, [{ route: CTX.route, id: PEEK_ID }]);
  assert.strictEqual(arm._registers('seat').attach, 'attached text', 'the attachment survived');
});

test('the pref is read per call, not captured at construction', async () => {
  let on = false;
  const { arm, armed } = mk({ enabled: () => on });
  const off = await arm.arm('seat', { text: 'hi', tab: 'term' }, CTX);
  assert.strictEqual(off.armed, false);
  assert.deepStrictEqual(armed, [], 'nothing on the wire while the pref is off');
  on = true;
  const now = await arm.arm('seat', { text: 'hi', tab: 'term' }, CTX);
  assert.strictEqual(now.armed, true, 'ticking the box takes effect on the next selection');
  assert.strictEqual(armed.length, 1);
});

test('no route means nothing is sent and nothing is claimed', async () => {
  const { arm, armed, cleared } = mk();
  // A session spawned while the proxy was off does not route through wirescope
  // at all — _armCtx resolves a null base for it.
  const r = await arm.arm('seat', { text: 'hi', tab: 'term' }, { agent: 'seat', base: null, route: null });
  assert.strictEqual(r.armed, false);
  assert.match(r.reason, /wirescope/i);
  assert.deepStrictEqual(armed, []);
  assert.deepStrictEqual(cleared, []);
});

// The memo is written BEFORE the await so two arms cannot both POST. That makes
// the rollback load-bearing: without it a refused POST leaves the register
// claiming the proxy holds text it rejected, and the retry is dropped as
// unchanged — a silent permanent failure for that string.
test('a refused POST is retried, not memoised as armed', async () => {
  let status = 500;
  const armed = [];
  const arm = createSelectionArm({
    enabled: () => true,
    armHints: ({ hint }) => { armed.push(hint); return Promise.resolve({ status }); },
    clearHints: () => Promise.resolve({ status: 200 }),
  });
  const bad = await arm.arm('seat', { text: 'retry me', tab: 'term' }, CTX);
  assert.strictEqual(bad.armed, false, 'ENTER: the proxy refused');
  assert.strictEqual(arm._registers('seat').peek, null, 'the memo was rolled back');
  status = 200;
  const good = await arm.arm('seat', { text: 'retry me', tab: 'term' }, CTX);
  assert.strictEqual(good.armed, true, 'the same text is retried rather than dropped as unchanged');
  assert.strictEqual(armed.length, 2);
});

test('a throwing proxy is reported, never raised at the caller', async () => {
  const arm = createSelectionArm({
    enabled: () => true,
    armHints: () => Promise.reject(new Error('ECONNREFUSED')),
    clearHints: () => Promise.reject(new Error('ECONNREFUSED')),
  });
  const r = await arm.arm('seat', { text: 'hi', tab: 'term' }, CTX);
  assert.strictEqual(r.armed, false);
  assert.match(r.reason, /ECONNREFUSED/);
  assert.strictEqual(arm._registers('seat').peek, null);
  // And the clear path swallows too: a release during an outage must not reject
  // into a UI handler that has nothing to do with it.
  await arm.arm('seat', { text: 'hi', tab: 'term' }, CTX).catch(() => {});
  await arm.release('seat', CTX);
});

// Registers are keyed by session name, and a retired seat's name is reused by
// its replacement — the same hazard hint-arm's `forget` exists for, with a
// sharper failure: the replacement's first arm is dropped as "unchanged"
// against text the proxy never held for it.
test('forget drops the registers so a name reused by a new seat starts clean', async () => {
  const { arm, armed } = mk();
  await arm.arm('seat', { text: 'old', tab: 'term' }, CTX);
  assert.strictEqual(armed.length, 1, 'ENTER: the dead seat had armed something');
  arm.forget('seat');
  assert.deepStrictEqual(arm._registers('seat'), { peek: null, attach: null });
  const again = await arm.arm('seat', { text: 'old', tab: 'term' }, CTX);
  assert.strictEqual(again.armed, true, 'the replacement can arm the same text');
  assert.strictEqual(again.unchanged, undefined);
  assert.strictEqual(armed.length, 2);
});

test('the scrubber is read per call and reaches the composed text', async () => {
  const TOKEN = 'sk-live-TOKENVALUE-42';
  let tokens = [];
  const armed = [];
  const arm = createSelectionArm({
    enabled: () => true,
    // Per call, not captured: a `ctx add` between two selections must not leave
    // the newly stored token unredacted.
    scrubber: () => ({ scrub: (s, t) => (t ? s.split(t).join('***') : s), tokens }),
    armHints: ({ hint }) => { armed.push(hint); return Promise.resolve({ status: 200 }); },
    clearHints: () => Promise.resolve({ status: 200 }),
  });
  await arm.arm('seat', { text: `token is ${TOKEN} ok`, tab: 'ctl' }, CTX);
  assert.strictEqual(armed.length, 1, 'ENTER: armed with an empty token set');
  assert.ok(armed[0].text.includes(TOKEN), 'ENTER: nothing scrubbed it yet, so the next assertion is real');

  tokens = [TOKEN];
  await arm.arm('seat', { text: `token is ${TOKEN} again`, tab: 'ctl' }, CTX);
  assert.strictEqual(armed.length, 2);
  assert.ok(!armed[1].text.includes(TOKEN), 'the newly stored token was redacted');
  assert.ok(armed[1].text.includes('***'));
});

// A scrubber that returns null for either field must not DEFEAT the composer's
// identity defaults — a JS parameter default fires on undefined and not on null,
// so passing the value straight through would reach `scrub(...)` as null.
// ── Interleavings ──────────────────────────────────────────────────────────
//
// Everything above resolves each round trip before the next call starts, which
// is the one situation the operator's hands do NOT produce: the debounce is
// 300ms and a proxy round trip is not guaranteed to be shorter. A cold review
// found three defects in this gap; these pin the fixes.

test('an attach behind an in-flight peek reaches the proxy AFTER it', async () => {
  const { arm, ops, landed, settle } = slowMk();
  // The drag arms a peek; the operator clicks Copy before it comes back.
  const peek = arm.arm('seat', { text: 'the line', tab: 'term' }, CTX);
  await settle();
  assert.strictEqual(ops.length, 1, 'ENTER: the peek POST is in flight, not yet resolved');

  const attach = arm.arm('seat', { text: 'the line', tab: 'term', attach: true }, CTX);
  await settle();
  // The chain is the point: the attach must not have issued anything yet.
  assert.strictEqual(ops.length, 1, 'the attach waits for the peek rather than racing it');

  ops[0].release();
  await peek;
  await settle();
  ops[1].release();          // the attach POST
  await settle();
  ops[2].release();          // the DELETE for the superseded peek
  const res = await attach;

  assert.strictEqual(res.armed, true, 'the attach went through');
  // Without the chain the DELETE is issued while the peek POST is still in
  // flight, so the proxy ends up holding BOTH framings of the same bytes with
  // nothing left in the memo that could ever take the peek back.
  assert.deepStrictEqual(landed, [
    `arm:${PEEK_ID}`, `arm:${ATTACH_ID}`, `clear:${PEEK_ID}`,
  ], 'the peek is deleted only after the POST that registered it landed');
  assert.strictEqual(arm._registers('seat').peek, null, 'and the memo agrees it is gone');
});

test('a peek is superseded by an attach carrying DIFFERENT bytes', async () => {
  const { arm, cleared, armed } = mk();
  // Reachable whenever the operator selects new text and hits Copy inside the
  // debounce window: the older selection's peek is still registered.
  await arm.arm('seat', { text: 'older selection', tab: 'term' }, CTX);
  assert.strictEqual(armed.length, 1, 'ENTER: the older peek is live');
  const res = await arm.arm('seat', { text: 'brand new text', tab: 'term', attach: true }, CTX);
  assert.strictEqual(res.armed, true);
  // The renderer drops its handle on the peek at this moment, so a peek left
  // registered here is one nothing will ever release.
  assert.deepStrictEqual(cleared, [{ route: CTX.route, id: PEEK_ID }],
    'the stale peek came off the wire even though the bytes differ');
  assert.strictEqual(arm._registers('seat').peek, null);
});

test('two arms with different text land in issue order, so the memo matches the proxy', async () => {
  const { arm, ops, landed, settle } = slowMk();
  const first = arm.arm('seat', { text: 'AAA', tab: 'term' }, CTX);
  await settle();
  const second = arm.arm('seat', { text: 'BBB', tab: 'term' }, CTX);
  await settle();
  assert.strictEqual(ops.length, 1, 'ENTER: the second arm is queued behind the first');

  ops[0].release();
  await first;
  await settle();
  assert.strictEqual(ops.length, 2, 'the second POST issued once the first cleared the chain');
  ops[1].release();
  await second;

  assert.deepStrictEqual(landed, [`arm:${PEEK_ID}`, `arm:${PEEK_ID}`]);
  // Unserialized, B's memo is written first but A's POST can land last: the
  // proxy holds A, the memo says B, and every later re-arm of B is dropped as
  // `unchanged` while the operator's status line claims it is riding.
  assert.strictEqual(arm._registers('seat').peek, 'BBB', 'the memo names what landed last');
});

test('a release issued during an in-flight arm still takes the peek back', async () => {
  const { arm, ops, landed, settle } = slowMk();
  const armed = arm.arm('seat', { text: 'walking away', tab: 'term' }, CTX);
  await settle();
  // The operator switches sessions while the POST is in flight. The renderer
  // claims peekOn before its await for exactly this reason.
  const rel = arm.release('seat', CTX);
  await settle();
  assert.strictEqual(ops.length, 1, 'ENTER: the release is queued, not racing');

  ops[0].release();
  await armed;
  await settle();
  assert.strictEqual(ops.length, 2, 'the DELETE issued after the arm resolved');
  ops[1].release();
  await rel;

  assert.deepStrictEqual(landed, [`arm:${PEEK_ID}`, `clear:${PEEK_ID}`]);
  assert.strictEqual(arm._registers('seat').peek, null, 'nothing is left riding the abandoned session');
});

test('a memo does not outlive the registration it describes', async () => {
  let clock = 1_000_000;
  const { arm, armed } = mk({ now: () => clock });
  await arm.arm('seat', { text: 'transient', tab: 'term' }, CTX);
  assert.strictEqual(armed.length, 1, 'ENTER: armed once');
  // A peek is once:true / 120s. Past that the proxy holds nothing, but a memo
  // with no expiry still reports `armed: true, unchanged` — a status line
  // claiming text is riding a request that will never carry it.
  clock += 121 * 1000;
  const again = await arm.arm('seat', { text: 'transient', tab: 'term' }, CTX);
  assert.strictEqual(again.unchanged, undefined, 'the expired memo did not suppress the re-arm');
  assert.strictEqual(armed.length, 2, 're-armed on the wire');
});

test('an expired memo costs no DELETE', async () => {
  let clock = 1_000_000;
  const { arm, cleared } = mk({ now: () => clock });
  await arm.arm('seat', { text: 'gone by now', tab: 'term' }, CTX);
  clock += 121 * 1000;
  await arm.release('seat', CTX);
  assert.deepStrictEqual(cleared, [], 'the proxy already dropped it at its ttl');
});

test('forget clears a live attachment off the proxy, not just the memo', async () => {
  const { arm, cleared } = mk();
  await arm.arm('seat', { text: 'left behind', tab: 'term', attach: true }, CTX);
  // _armCtx falls back to a NAME GLOB, so a dead seat's 1800s attachment
  // matches its same-named replacement until the TTL runs out.
  await arm.forget('seat', CTX);
  assert.deepStrictEqual(cleared, [{ route: CTX.route, id: ATTACH_ID }],
    'the registration was taken back, not merely forgotten here');
  assert.deepStrictEqual(arm._registers('seat'), { peek: null, attach: null });
});

test('forget without a ctx is still synchronous and silent', async () => {
  const { arm, cleared } = mk();
  await arm.arm('seat', { text: 'no route to clear on', tab: 'term', attach: true }, CTX);
  await arm.forget('seat');
  assert.deepStrictEqual(cleared, [], 'no ctx means no route to send a DELETE to');
  assert.deepStrictEqual(arm._registers('seat'), { peek: null, attach: null },
    'the memo is dropped regardless, so a replacement seat starts clean');
});

test('the reported byte count is what WENT, not what was selected', async () => {
  const { arm, armed } = mk();
  const huge = 'x'.repeat(50 * 1024);
  const res = await arm.arm('seat', { text: huge, tab: 'term' }, CTX);
  assert.strictEqual(res.armed, true, 'ENTER: the oversized selection armed');
  assert.strictEqual(res.truncated, true);
  // Reporting 51200 for a selection the 2000-char peek cap cut tells the
  // operator the agent has context it does not have.
  assert.ok(res.bytes < 2200 && res.bytes > 0, `bytes should be the clamped body, got ${res.bytes}`);
  // And the measurements are for the status line only — they must not reach
  // the proxy as unknown hint fields.
  assert.deepStrictEqual(Object.keys(armed[0]).filter((k) => k === 'bytes' || k === 'truncated'), [],
    'bytes/truncated are stripped before the POST');
});

test('a half-built scrubber falls back to the composer defaults instead of throwing', async () => {
  const armed = [];
  const arm = createSelectionArm({
    enabled: () => true,
    scrubber: () => ({ scrub: null, tokens: null }),
    armHints: ({ hint }) => { armed.push(hint); return Promise.resolve({ status: 200 }); },
    clearHints: () => Promise.resolve({ status: 200 }),
  });
  const r = await arm.arm('seat', { text: 'plain text', tab: 'term' }, CTX);
  assert.strictEqual(r.armed, true);
  assert.ok(armed[0].text.includes('plain text'));
});
