// selection-hint.js — the operator's drawer selection as a tail hint.
//
// What is worth pinning here is NOT that a string was built. It is the three
// properties that make the channel safe to point at a model: the two tiers
// cannot collide, the cap holds, and a token cannot survive the cap/scrub
// interaction. The framing prose is pinned only where a missing clause has a
// named failure (an unhedged peek reads as an instruction).

const test = require('node:test');
const assert = require('node:assert');

const {
  buildSelectionHint, clampAndScrub,
  PEEK_ID, ATTACH_ID, PEEK_TTL_S, ATTACH_TTL_S,
  PEEK_MAX_CHARS, ATTACH_MAX_CHARS, TRUNCATION_NOTE,
} = require('../selection-hint');

// The real scrub's shape: REPLACES a token with a shorter marker. The shrink is
// the whole reason the cap needs two cuts, so a fake that pads would test the
// opposite mechanism.
const scrub = (s, t) => (t ? s.split(t).join('***') : s);

test('peek and attach differ in every field that governs delivery', () => {
  const peek = buildSelectionHint({ text: 'hello', tab: 'term' });
  const attach = buildSelectionHint({ text: 'hello', tab: 'term', attach: true });
  // ENTER: both tiers built something, or the assertions below compare nulls.
  assert.ok(peek && attach, 'ENTER: both tiers produced a hint');
  assert.notStrictEqual(peek.id, attach.id);
  assert.strictEqual(peek.id, PEEK_ID);
  assert.strictEqual(attach.id, ATTACH_ID);
  // A peek must pop; an attach must persist. Swapping these is the failure that
  // would make a deliberate attachment vanish after one request.
  assert.strictEqual(peek.once, true);
  assert.strictEqual(attach.once, false);
  assert.strictEqual(peek.ttl_s, PEEK_TTL_S);
  assert.strictEqual(attach.ttl_s, ATTACH_TTL_S);
  // Both land at turn start: a hint arriving mid-turn is read after the
  // question it was meant to inform.
  assert.strictEqual(peek.turn_start_only, true);
  assert.strictEqual(attach.turn_start_only, true);
});

test('distinct ids, so a peek cannot overwrite an attachment', () => {
  // Same fixed id per tier is what makes a re-arm overwrite rather than
  // accrete; different ids across tiers is what keeps them independent.
  const a = buildSelectionHint({ text: 'one', tab: 'ctl' });
  const b = buildSelectionHint({ text: 'two', tab: 'ctl' });
  assert.strictEqual(a.id, b.id, 'a later peek overwrites the earlier one');
  assert.notStrictEqual(a.id, ATTACH_ID);
  // And neither may collide with hint-arm's memory channel.
  assert.notStrictEqual(a.id, 'memory-context');
  assert.notStrictEqual(ATTACH_ID, 'memory-context');
});

test('whitespace-only selections produce nothing', () => {
  assert.strictEqual(buildSelectionHint({ text: '   \n\t ', tab: 'term' }), null);
  assert.strictEqual(buildSelectionHint({ text: '', tab: 'term' }), null);
  assert.strictEqual(buildSelectionHint({ text: null, tab: 'term' }), null);
});

test('indentation survives — it is content, not decoration', () => {
  const indented = '    def f():\n        return 1';
  const h = buildSelectionHint({ text: indented, tab: 'term' });
  assert.ok(h, 'ENTER: the hint was built');
  // The BODY keeps its leading spaces even though the emptiness test trimmed.
  assert.ok(h.text.includes('    def f():'), 'leading indent survived');
  assert.ok(h.text.includes('        return 1'), 'nested indent survived');
});

test('the peek framing carries its hedge and its silence clause', () => {
  const h = buildSelectionHint({ text: 'x', tab: 'log' });
  assert.ok(h, 'ENTER: the hint was built');
  // Without the hedge every incidental highlight becomes a question the agent
  // answers unprompted; without "do not mention it" a model narrates that it is
  // ignoring the thing, which is worse than silence.
  assert.match(h.text, /may have nothing to do with it/);
  assert.match(h.text, /do not mention it/);
  // The SURFACE is named — that is what lets a model tell an error the operator
  // hit from a line they were merely reading.
  assert.match(h.text, /IPC log tab/);
});

test('the attach framing says it persists, so it is not re-acknowledged', () => {
  const h = buildSelectionHint({ text: 'x', tab: 'term', attach: true });
  assert.ok(h, 'ENTER: the hint was built');
  assert.match(h.text, /deliberate/);
  // Without this the model treats a second turn's carriage as a fresh
  // attachment and re-acknowledges text handed over several turns ago.
  assert.match(h.text, /not a new attachment each turn/);
});

test('an unknown tab id never reaches the model as a raw id', () => {
  const h = buildSelectionHint({ text: 'x', tab: 'nonesuch' });
  assert.ok(h, 'ENTER: the hint was built');
  assert.ok(!h.text.includes('nonesuch'), 'raw id did not leak into model-visible text');
  assert.match(h.text, /bottom panel/);
});

test('each tier caps at its own limit and says it truncated', () => {
  const huge = 'y'.repeat(ATTACH_MAX_CHARS * 2);
  const peek = buildSelectionHint({ text: huge, tab: 'term' });
  const attach = buildSelectionHint({ text: huge, tab: 'term', attach: true });
  assert.ok(peek && attach, 'ENTER: both tiers built against oversized input');
  // The framing adds a fixed preamble, so assert on the BODY's growth, not the
  // whole string: the cap governs the selection, not the prose around it.
  const bodyOf = (s, tag) => s.split(`<${tag}>\n`)[1].split(`\n</${tag}>`)[0];
  const peekBody = bodyOf(peek.text, 'selection');
  const attachBody = bodyOf(attach.text, 'attachment');
  assert.ok(peekBody.length <= PEEK_MAX_CHARS + TRUNCATION_NOTE.length,
    `peek body ${peekBody.length} within cap`);
  assert.ok(attachBody.length <= ATTACH_MAX_CHARS + TRUNCATION_NOTE.length,
    `attach body ${attachBody.length} within cap`);
  // ENTER: the caps genuinely differ, or one of the two assertions above is
  // vacuous against the other tier's limit.
  assert.ok(attachBody.length > peekBody.length, 'ENTER: attach carries more than peek');
  assert.match(peek.text, /truncated/);
});

test('under the cap, nothing is truncated and no note appears', () => {
  const h = buildSelectionHint({ text: 'short', tab: 'term' });
  assert.ok(h, 'ENTER: the hint was built');
  assert.ok(!h.text.includes('truncated'), 'no truncation note on a small selection');
});

// The cap/scrub interaction, swept rather than probed at one offset. A token
// straddling the cap is a window ONE TOKEN WIDE, and the framing prose shifts
// every position by an amount the test cannot control — so a single guessed
// offset passes against a naive implementation that leaks at a neighbouring
// one. (Measured on ctl-service's identical cap: the first single-offset
// version of that test passed against code with no post-scrub cut at all.)
test('no token prefix survives the cap at ANY offset near the boundary', () => {
  const TOKEN = 'sk-ant-SECRETTOKENVALUE-0123456789';
  for (let off = -60; off <= 20; off++) {
    const pad = 'z'.repeat(PEEK_MAX_CHARS + off);
    const h = buildSelectionHint({
      text: pad + TOKEN + 'tail', tab: 'term', scrub, tokens: [TOKEN],
    });
    assert.ok(h, `ENTER: built at offset ${off}`);
    // Any prefix of the token longer than a few chars is a leak — the scrub
    // could not match it because the cut split it.
    for (let n = 8; n <= TOKEN.length; n++) {
      assert.ok(!h.text.includes(TOKEN.slice(0, n)),
        `LEAK at offset ${off}: ${n}-char token prefix survived`);
    }
  }
});

test('clampAndScrub replaces a token that sits well inside the cap', () => {
  const TOKEN = 'sk-ant-INSIDE-9876';
  const out = clampAndScrub(`before ${TOKEN} after`, 1000, scrub, [TOKEN]);
  // ENTER: the fixture is under the cap, so this exercises the scrub and not
  // the truncation path.
  assert.ok(!out.includes('truncated'), 'ENTER: fixture was under the cap');
  assert.ok(!out.includes(TOKEN), 'token was scrubbed');
  assert.match(out, /before \*\*\* after/);
});
