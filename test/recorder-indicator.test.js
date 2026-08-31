'use strict';

// recorder-indicator.test.js — what Clodex BELIEVES the recorder is doing, and
// the click that stops it.
//
// Two subjects, and they are asserted differently on purpose. The READING is a
// display, so its assertions are on the reported string. The TAP-OFF writes a
// byte, so — like every other decision in this subsystem — its assertions are
// ON THE BYTES THAT REACHED THE PTY, never on a predicate's return: a gate can
// be deleted and leave every function in lib/voice-submit.js still answering
// correctly while the character goes out anyway.
//
// Its own file rather than cases in external-tap-trigger.test.js: that one is
// the ensure-ON tap and its harness is shaped for the routing half. The fixture
// literals are DUPLICATED rather than shared, for the reason that file gives —
// a shared fixture lets one edit move both sides of every assertion at once.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const { createVoiceSubmitWatcher } = require('../renderer/voice-submit-watcher');

// Measured off a live seat 2026-08-31 (CLI 2.1.251). Spelled as escapes so an
// editor cannot silently "fix" the separator: it is a NON-BREAKING space, and
// an ASCII one here makes every empty-composer fixture read as a draft — the
// feature dead and the suite green.
const EMPTY_COMPOSER = '\u276f\u00a0';
const DRAFT_COMPOSER = '\u276f\u00a0stop recording';
const REC_ROW = ' agents \u23faREC \u00b7 tap to send';
const IDLE_ROW = ' agents \u00b7 tap to talk';
const PROCESSING_ROW = ' agents Voice: processing\u2026';

// Cursor on the LAST row unless a row carries `cursor: true` — so a fixture
// that paints the composer with an indicator BELOW it must mark the composer
// row explicitly, or the cursor lands on the indicator and the composer read
// looks at the wrong line entirely.
//
// `indicatorUnreadable` throws from the ROW COUNT, which is the one thing the
// indicator scan reads and the composer read does not — the only way to put the
// watcher in "cannot see the recorder, can see the composer".
function fakeTerminal({ rows = [''], type = 'normal', indicatorUnreadable = false } = {}) {
  const state = { rows: rows.map((r) => (typeof r === 'string' ? { text: r } : r)), type };
  const cursorIndex = () => {
    const marked = state.rows.findIndex((r) => r && r.cursor);
    return marked === -1 ? state.rows.length - 1 : marked;
  };
  return {
    get rows() {
      if (indicatorUnreadable) throw new Error('screen unreadable');
      return state.rows.length;
    },
    buffer: {
      get active() {
        return {
          type: state.type,
          baseY: 0,
          get cursorY() { return cursorIndex(); },
          get cursorX() {
            const r = state.rows[cursorIndex()];
            return typeof r.cursorX === 'number' ? r.cursorX : r.text.length;
          },
          getLine: (y) => {
            const r = state.rows[y];
            if (!r) return null;
            return {
              translateToString: (_trim, start, end) =>
                r.text.slice(start ?? 0, end ?? r.text.length),
            };
          },
        };
      },
    },
    onWriteParsed() { return { dispose() {} }; },
  };
}

// Every watcher holds the composition poll's setInterval, so an assertion that
// throws jumps over its own dispose() and the surviving interval would hang the
// run on a timeout instead of naming the failure.
const live = [];
afterEach(() => { while (live.length) live.pop().dispose(); });

function harness({
  // `cursor: true` is REQUIRED on the composer row of any multi-row paint: the
  // fake puts the cursor on the LAST row, and the real footer paints the
  // indicator BELOW the composer.
  rows = [{ text: EMPTY_COMPOSER, cursor: true }, IDLE_ROW],
  type = 'normal',
  attention = null,
  voiceMode = 'tap',
  trigger = ' ',
  indicatorUnreadable = false,
  // Null config AND no recorder scope is the out-of-scope seat. Both are
  // needed: `inScope` is their OR, so switching off only one still scans.
  config = { enabled: true, rearm: true, phrase: 'over and out' },
  recorderScope = true,
} = {}) {
  const writes = [];
  const env = { attention, voiceMode, trigger };
  const watcher = createVoiceSubmitWatcher(fakeTerminal({ rows, type, indicatorUnreadable }), {
    getConfig: () => config,
    getAttention: () => env.attention,
    getVoiceMode: () => env.voiceMode,
    getTriggerKey: () => env.trigger,
    recorderScope: () => recorderScope,
    // The reading is produced by the composition poll, so the test has to let
    // one run. Short enough that a case costs milliseconds, and the value under
    // test is a classification rather than anything timing-dependent.
    pollMs: 2,
    write: (d) => writes.push(d),
  });
  live.push(watcher);
  return { watcher, writes, env };
}

const tick = () => new Promise((res) => setTimeout(res, 12));

// ------------------------------------------------------------- the reading

// THREE STATES, NOT TWO, and the table is the assertion: each row carries the
// literal it expects rather than re-deriving it from the predicates the code
// under test uses, which would only assert that the code agrees with itself.
//
// `unreadable` and `busy` are the rows that matter. Both are invisible on
// screen today and both change what the gates will do — that is the entire
// reason this display exists, and a two-state version would pass every other
// row here.
for (const [name, fixture, expected] of [
  ['a LIT recorder', { rows: [{ text: EMPTY_COMPOSER, cursor: true }, REC_ROW] }, 'lit'],
  ['the PROCESSING window', { rows: [{ text: EMPTY_COMPOSER, cursor: true }, PROCESSING_ROW] }, 'busy'],
  ['an UNREADABLE screen', { indicatorUnreadable: true }, 'unreadable'],
  ['an IDLE footer', { rows: [{ text: EMPTY_COMPOSER, cursor: true }, IDLE_ROW] }, 'off'],
  ['an ALTERNATE buffer', { type: 'alternate' }, 'unreadable'],
]) {
  test(`the reading reports ${name} as ${expected}`, async () => {
    const h = harness(fixture);
    await tick();
    assert.strictEqual(h.watcher.recorderReading(), expected);
  });
}

// NOT merely 'off'. The scan does not run on a seat nothing is looking at, so
// there is no reading to report — and painting 'off' would be a claim that a
// dark recorder was MEASURED on a seat where nothing measured anything.
test('a seat OUT OF SCOPE reports no reading at all, never "off"', async () => {
  const h = harness({
    config: null,
    recorderScope: false,
    rows: [{ text: EMPTY_COMPOSER, cursor: true }, REC_ROW],
  });
  await tick();
  assert.strictEqual(h.watcher.recorderReading(), 'out',
    'a lit recorder on an unwatched seat is still not a reading this seat took');
});

// The display and the gates must never be able to disagree, which is the whole
// design rule. This is the observable half of it: the reading moves only when
// the screen the gates read moves, on the poll they already run.
test('the reading FOLLOWS the screen across a change', async () => {
  const rows = [{ text: EMPTY_COMPOSER, cursor: true }, { text: IDLE_ROW }];
  const h = harness({ rows });
  await tick();
  assert.strictEqual(h.watcher.recorderReading(), 'off');
  rows[1].text = REC_ROW;
  await tick();
  assert.strictEqual(h.watcher.recorderReading(), 'lit');
  rows[1].text = PROCESSING_ROW;
  await tick();
  assert.strictEqual(h.watcher.recorderReading(), 'busy');
});

// --------------------------------------------------------------- the tap-off

// THE POLARITY, and it is the OPPOSITE of the ensure-on tap's. That one writes
// on a DARK recorder; this one must write on a LIT one and nowhere else, so a
// hand that copied `externalTap`'s gate shape reds exactly here.
//
// NOT VACUOUS: the composer reads clean, no dialog is up, the screen is
// readable and tap mode is on, so every other guard PASSES and the lit read is
// the only thing that can decline. A fixture an earlier guard already rejects
// would pin nothing.
test('THE POLARITY: a DARK recorder is never written to — the byte would ARM a mic he asked to stop', () => {
  const h = harness({ rows: [{ text: EMPTY_COMPOSER, cursor: true }, IDLE_ROW] });
  assert.strictEqual(h.watcher.tapOff(), false);
  assert.deepStrictEqual(h.writes, [],
    'ensure-OFF: writing here starts a recording nobody asked for, the inverted failure');
  assert.strictEqual(h.watcher.offTapCount(), 0);
});

// Distinguishes this gate from `recorderBlocksRearm`, which answers TRUE here —
// an implementation built on that predicate instead would write, so this row is
// what tells the two predicates apart at this call site.
//
// The byte would not even be swallowed: measured in 2.1.251 the processing arm
// returns without consuming a single-character binding, so it lands as a
// LITERAL and the now-non-empty composer blocks every later re-arm and tap. A
// permanently stuck mic, which is the worst outcome available here.
test('THE PROCESSING WINDOW gets no character — the recorder has already stopped', () => {
  for (const row of [
    ' agents Voice: processing\u2026',
    ' agents Voice: processing...',
  ]) {
    const h = harness({ rows: [{ text: EMPTY_COMPOSER, cursor: true }, row] });
    assert.strictEqual(h.watcher.tapOff(), false, JSON.stringify(row));
    assert.deepStrictEqual(h.writes, [], JSON.stringify(row));
    assert.strictEqual(h.watcher.offTapCount(), 0, JSON.stringify(row));
  }
});

// The BEHAVIOUR is what this pins, and it is worth being exact about what it
// does not: with `recordingObserved` in the gate, deleting the explicit
// `!Array.isArray(rows)` line above it leaves this GREEN, because that
// predicate answers false for null too. The line is kept as the stated polarity
// rule and as the defence against a predicate swap, and it is documented as
// unpinned at the line rather than pinned by an invented fixture.
//
// The fixture still has to fail the INDICATOR read ALONE — `indicatorRows`
// walks `terminal.rows` inside its try/catch and `cursorRow` never touches it —
// so the composer reads clean and every earlier guard passes.
test('an UNREADABLE indicator is never written to, even with a clean composer', () => {
  const h = harness({ indicatorUnreadable: true });
  assert.strictEqual(h.watcher.tapOff(), false);
  assert.deepStrictEqual(h.writes, [],
    'two of the three outcomes here are bad and one is a permanently stuck composer');
  assert.strictEqual(h.watcher.offTapCount(), 0);
});

// The gate that is NOT inherited from the ensure-on half's reasoning, and the
// only case that reaches it: the recorder IS lit, so `recordingObserved` passes
// and the composer read is what decides.
//
// The CLI paints `tap to send` beside the lit indicator and that is what the
// key does — stop AND SUBMIT. Writing here would send a draft he never asked to
// send, turning an ensure-off into a submit.
test('a LIT recorder over a NON-EMPTY composer is left alone — the key would SEND the draft', () => {
  const h = harness({ rows: [{ text: DRAFT_COMPOSER, cursor: true }, REC_ROW] });
  assert.strictEqual(h.watcher.tapOff(), false);
  assert.deepStrictEqual(h.writes, []);
  assert.strictEqual(h.watcher.offTapCount(), 0);
});

// A byte written into an open permission dialog ANSWERS it. Lit, so the gate
// below it would otherwise write — which is what makes this reach the interlock
// rather than passing for the reason the dark case passes.
test('a PERMISSION dialog blocks the stop, even with the recorder lit', () => {
  const h = harness({ rows: [{ text: EMPTY_COMPOSER, cursor: true }, REC_ROW], attention: 'permission' });
  assert.strictEqual(h.watcher.tapOff(), false);
  assert.deepStrictEqual(h.writes, []);
});

// Same reason the re-arm and the ensure-on tap are tap-only: in hold mode a
// single written character cannot reach the auto-repeat threshold, so it lands
// in the draft as a literal instead of toggling anything.
test('HOLD mode writes nothing — a single character cannot toggle a hold recorder', () => {
  const h = harness({ rows: [{ text: EMPTY_COMPOSER, cursor: true }, REC_ROW], voiceMode: 'hold' });
  assert.strictEqual(h.watcher.tapOff(), false);
  assert.deepStrictEqual(h.writes, []);
});

test('no single-character binding writes nothing', () => {
  const h = harness({ rows: [{ text: EMPTY_COMPOSER, cursor: true }, REC_ROW], trigger: null });
  assert.strictEqual(h.watcher.tapOff(), false);
  assert.deepStrictEqual(h.writes, []);
});

// Without this row every case above passes for a gate that blocks
// unconditionally: the feature would be dead and the suite green. It is the
// only case here that asserts a byte WAS written.
test('a LIT recorder over an empty composer gets the trigger character', () => {
  const h = harness({ rows: [{ text: EMPTY_COMPOSER, cursor: true }, REC_ROW] });
  assert.strictEqual(h.watcher.tapOff(), true);
  assert.deepStrictEqual(h.writes, [' ']);
  assert.strictEqual(h.watcher.offTapCount(), 1);
});

// The two directions are counted apart because one number could not say which
// way the byte went, and direction is the only thing that differs between them.
test('the off tap is counted apart from the ensure-ON tap', () => {
  const lit = harness({ rows: [{ text: EMPTY_COMPOSER, cursor: true }, REC_ROW] });
  assert.strictEqual(lit.watcher.tapOff(), true);
  assert.strictEqual(lit.watcher.offTapCount(), 1);
  assert.strictEqual(lit.watcher.externalTapCount(), 0, 'a stop is not an arm');

  const dark = harness();
  assert.strictEqual(dark.watcher.externalTap(), true);
  assert.strictEqual(dark.watcher.externalTapCount(), 1);
  assert.strictEqual(dark.watcher.offTapCount(), 0, 'an arm is not a stop');
});

// A disposed watcher's seat is gone. Asserted on the BYTES for the same reason
// as everything else here: a return value can be right while the write happened.
test('a DISPOSED watcher writes nothing', () => {
  const h = harness({ rows: [{ text: EMPTY_COMPOSER, cursor: true }, REC_ROW] });
  h.watcher.dispose();
  assert.strictEqual(h.watcher.tapOff(), false);
  assert.deepStrictEqual(h.writes, []);
});
