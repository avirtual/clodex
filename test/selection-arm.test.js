// selection-arm.js — WHICH CHANNEL carries the operator's drawer selection.
//
// The composer's own tests (selection-hint.test.js) pin what the text says.
// What is worth pinning here is the routing and the traffic: selecting goes on
// the wirescope tail and copying goes into the seat's hook queue, the same
// bytes must not be POSTed twice, the two channels must not put the same text
// in one request under two framings, and a refused POST must not leave a memo
// claiming the proxy holds something.

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
  const queued = [];
  const arm = createSelectionArm({
    enabled: () => true,
    armHints: ({ route, hint }) => { armed.push({ route, ...hint }); return Promise.resolve({ status: 200 }); },
    clearHints: ({ route, id }) => { cleared.push({ route, id }); return Promise.resolve({ status: 200 }); },
    queue: ({ name, text }) => { queued.push({ name, text }); },
    ...overrides,
  });
  return { arm, armed, cleared, queued };
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
  const queued = [];
  const arm = createSelectionArm({
    enabled: () => true,
    armHints: ({ hint }) => op('arm', hint.id),
    clearHints: ({ id }) => op('clear', id),
    queue: ({ name, text }) => { queued.push({ name, text }); },
    ...overrides,
  });
  const pending = (kind) => ops.filter((o) => o.kind === kind && !landed.includes(`${o.kind}:${o.id}`));
  // Lets the chain advance as far as it can without resolving anything new.
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { arm, ops, landed, pending, settle, queued };
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
  assert.deepStrictEqual(arm._registers('seat'), { peek: null, pending: [] });
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

// ── The two channels ───────────────────────────────────────────────────────
//
// Selecting is ephemeral and rides the wire; copying is a hard copy that goes
// into the transcript through the seat's own UserPromptSubmit hook. The split
// is the design, so these pin that each gesture uses ITS channel and not the
// other — a Copy that quietly POSTed would put permanent text on an uncached
// tail, and a selection that quietly queued would make an idle highlight
// permanent.

test('Copy queues for the transcript and never touches the proxy', async () => {
  const { arm, armed, cleared, queued } = mk();
  const res = await arm.arm('seat', { text: 'the failing line', tab: 'ctl', attach: true }, CTX);
  assert.strictEqual(res.handed, true, 'ENTER: the hand-off went through');
  assert.strictEqual(queued.length, 1, 'exactly one queue entry');
  assert.strictEqual(queued[0].name, 'seat', 'queued against the seat, whose hook will read it');
  assert.ok(queued[0].text.includes('the failing line'));
  assert.deepStrictEqual(armed, [], 'a hard copy is not tail traffic');
  assert.deepStrictEqual(cleared, []);
});

test('Copy works with wirescope off entirely', async () => {
  const { arm, queued } = mk();
  // The hook reads a file the app wrote; no proxy is involved on this path, so
  // the tier that survives a stopped wirescope must be the deliberate one.
  const res = await arm.arm('seat', { text: 'still works', tab: 'term', attach: true },
    { agent: 'seat', base: null, route: null });
  assert.strictEqual(res.handed, true);
  assert.strictEqual(queued.length, 1, 'the queue is the whole mechanism here');
});

test('a peek is suppressed while the same bytes are queued for the transcript', async () => {
  const { arm, armed, queued } = mk();
  await arm.arm('seat', { text: 'one line', tab: 'term', attach: true }, CTX);
  assert.strictEqual(queued.length, 1, 'ENTER: it is waiting for the next submit');
  // The selection is still on screen after the click, so the drag's debounce
  // fires against text the transcript is about to carry. Both in one request
  // is the same text under two contradictory framings.
  const p = await arm.arm('seat', { text: 'one line', tab: 'term' }, CTX);
  assert.strictEqual(p.armed, false);
  assert.strictEqual(p.reason, 'already handed over');
  assert.deepStrictEqual(armed, [], 'nothing on the tail beside it');
});

test('the suppression lifts once the queue has gone out', async () => {
  const { arm, armed } = mk();
  await arm.arm('seat', { text: 'shipped', tab: 'term', attach: true }, CTX);
  assert.strictEqual(arm.onSubmit('seat'), true, 'ENTER: something was waiting and went');
  // It is in the transcript now, so re-selecting it is an ordinary selection
  // about an ordinary part of the context — suppressing forever would be the
  // wrong way round.
  const p = await arm.arm('seat', { text: 'shipped', tab: 'term' }, CTX);
  assert.strictEqual(p.armed, true, 'the peek is no longer suppressed');
  assert.strictEqual(armed.length, 1);
});

test('onSubmit reports whether anything was actually waiting', async () => {
  const { arm } = mk();
  // The renderer retires its "sending" claim on this, so a submit with an
  // empty queue must not be reported as a delivery.
  assert.strictEqual(arm.onSubmit('seat'), false, 'nothing queued, nothing sent');
  await arm.arm('seat', { text: 'queued', tab: 'term', attach: true }, CTX);
  assert.strictEqual(arm.onSubmit('seat'), true);
  assert.strictEqual(arm.onSubmit('seat'), false, 'and the queue is empty again');
});

test('two Copy clicks between submits are two attachments', async () => {
  const { arm, queued } = mk();
  await arm.arm('seat', { text: 'first', tab: 'term', attach: true }, CTX);
  await arm.arm('seat', { text: 'second', tab: 'log', attach: true }, CTX);
  // The queue file is line-delimited for exactly this: a slot would silently
  // drop the first of two things the operator deliberately handed over.
  assert.strictEqual(queued.length, 2);
  assert.ok(queued[0].text.includes('first'));
  assert.ok(queued[1].text.includes('second'));
});

test('clicking Copy twice on the same text queues it once', async () => {
  const { arm, queued } = mk();
  await arm.arm('seat', { text: 'same text', tab: 'term', attach: true }, CTX);
  const again = await arm.arm('seat', { text: 'same text', tab: 'term', attach: true }, CTX);
  assert.strictEqual(again.handed, true, 'reported as handed over, because it is');
  assert.strictEqual(again.unchanged, true);
  // There is no un-queue gesture, so a second click is the same hand-off — not
  // a second copy of the same block in the transcript.
  assert.strictEqual(queued.length, 1, 'the transcript gets it once');
});

test('a queue write that fails is reported, never raised at the caller', async () => {
  const { arm } = mk({ queue: () => { throw new Error('ENOENT'); } });
  const res = await arm.arm('seat', { text: 'nowhere to put it', tab: 'term', attach: true }, CTX);
  assert.strictEqual(res.handed, false);
  assert.match(res.reason, /ENOENT/);
  // And it did not memoise: the retry must be able to queue it.
  assert.deepStrictEqual(arm._registers('seat').pending, []);
});

test('the pref gates the Copy channel too', async () => {
  let on = false;
  const { arm, queued } = mk({ enabled: () => on });
  const off = await arm.arm('seat', { text: 'hi', tab: 'term', attach: true }, CTX);
  assert.strictEqual(off.handed, false);
  assert.deepStrictEqual(queued, [], 'an unticked box means nothing leaves, on either channel');
  on = true;
  const now = await arm.arm('seat', { text: 'hi', tab: 'term', attach: true }, CTX);
  assert.strictEqual(now.handed, true);
  assert.strictEqual(queued.length, 1);
});

test('the queued text is the COMPOSED hint, not the raw selection', async () => {
  const TOKEN = 'sk-live-TOKENVALUE-42';
  const { arm, queued } = mk({
    scrubber: () => ({ scrub: (s, t) => (t ? s.split(t).join('***') : s), tokens: [TOKEN] }),
  });
  await arm.arm('seat', { text: `key ${TOKEN} here`, tab: 'ctl', attach: true }, CTX);
  assert.strictEqual(queued.length, 1, 'ENTER: something was queued to inspect');
  // This lands in the transcript PERMANENTLY, so an unredacted token here is
  // worse than one on a 120s tail hint.
  assert.ok(!queued[0].text.includes(TOKEN), 'the token was redacted before it could persist');
  assert.ok(queued[0].text.includes('***'));
  // And it carries its framing, or it arrives as a bare wall of text with no
  // account of where it came from.
  assert.match(queued[0].text, /clodexctl tab/);
  assert.match(queued[0].text, /<attachment>/);
});

test('the attach framing does not claim to persist, because the transcript does', async () => {
  const { arm, queued } = mk();
  await arm.arm('seat', { text: 'body', tab: 'term', attach: true }, CTX);
  // The wire version had to say "it stays attached" because it rode every
  // request. This one is delivered once into the conversation, so the same
  // sentence would invite the model to re-acknowledge it every turn.
  assert.ok(!/stays attached/.test(queued[0].text));
  assert.match(queued[0].text, /deliberate gesture/);
});
