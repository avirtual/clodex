'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { proseVerdictNeedsNudge, PROSE_VERDICT_NUDGE } = require('../verdict-nudge');
const { mk } = require('./lib/session-fixtures');

const BOLD_VERDICT = 'I read the whole diff.\n\n- **VERDICT**: ACCEPT — the pins hold and the red-proof is real.\n';
const PLAIN_VERDICT = 'Walked the branch.\nVERDICT: REWORK — the latch is never set.\n';

test('the predicate fires on a verdict-shaped turn from a reviewer seat with no review-done intent', () => {
  const rows = [
    {
      what: 'reviewer, bold verdict, no intents',
      args: { text: BOLD_VERDICT, intents: [], session: { name: 'rev', reviewFor: 'clodex' } },
      want: true,
    },
    {
      what: 'same text, but the review-done intent did fire',
      args: { text: BOLD_VERDICT, intents: [{ type: 'review-done' }], session: { name: 'rev', reviewFor: 'clodex' } },
      want: false,
    },
    {
      what: 'not a reviewer seat (no reviewFor)',
      args: { text: BOLD_VERDICT, intents: [], session: { name: 'hand' } },
      want: false,
    },
    {
      what: 'reviewer prose that merely says ACCEPT, with no VERDICT line',
      args: { text: 'I have read the diff and will ACCEPT soon', intents: [], session: { name: 'rev', reviewFor: 'clodex' } },
      want: false,
    },
    {
      what: 'reviewer, plain VERDICT: REWORK at line start',
      args: { text: PLAIN_VERDICT, intents: [], session: { name: 'rev', reviewFor: 'clodex' } },
      want: true,
    },
    {
      what: 'reviewer already nudged once',
      args: { text: BOLD_VERDICT, intents: [], session: { name: 'rev', reviewFor: 'clodex', _verdictNudged: true } },
      want: false,
    },
  ];
  for (const row of rows) {
    assert.strictEqual(proseVerdictNeedsNudge(row.args), row.want, row.what);
  }
});

test('the predicate reads an intent list shaped {name} too, and survives a junk call', () => {
  const session = { name: 'rev', reviewFor: 'clodex' };
  assert.strictEqual(proseVerdictNeedsNudge({ text: BOLD_VERDICT, intents: [{ name: 'review-done' }], session }), false);
  assert.strictEqual(proseVerdictNeedsNudge({ text: BOLD_VERDICT, intents: undefined, session }), true);
  assert.strictEqual(proseVerdictNeedsNudge({}), false);
  assert.strictEqual(proseVerdictNeedsNudge(), false);
});

const MGR_DEPS = {
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  parseIntent: require('../intent-scanner').parseIntent,
  looksLikeIntent: require('../intent-scanner').looksLikeIntent,
  execBodyCap: 64 * 1024,
};

function mkSeat(extra = {}) {
  const m = mk(MGR_DEPS);
  const calls = [];
  m._deliverParkedActive = (...args) => calls.push(args);
  m._handleIntent = () => {};
  m._maybeSpeak = () => {};
  m._publishAgentText = () => {};
  m.sessions.set('rev', { name: 'rev', reviewFor: 'clodex', ...extra });
  return { m, calls };
}

test('the manager nudges ONCE and through the parked-active route', () => {
  const { m, calls } = mkSeat();
  m._extractIntents = () => [];
  m._scanJsonlText(BOLD_VERDICT, 'rev', []);
  m._scanJsonlText(BOLD_VERDICT, 'rev', []);
  assert.strictEqual(calls.length, 1, 'the latch makes the second verdict-shaped turn silent');
  assert.deepStrictEqual(calls[0], ['rev', 'clodex', PROSE_VERDICT_NUDGE, 'dm']);
  assert.strictEqual(m.sessions.get('rev')._verdictNudged, true);
});

test('a reviewer turn that DID carry review-done is never nudged', () => {
  const { m, calls } = mkSeat();
  m._scanJsonlText(`${BOLD_VERDICT}\n[agent:review-done] ACCEPT — the pins hold.\n[agent:end]`, 'rev', []);
  assert.deepStrictEqual(calls, []);
  assert.ok(!m.sessions.get('rev')._verdictNudged);
});

test('a non-reviewer seat writing the same text is never nudged', () => {
  const { m, calls } = mkSeat();
  m.sessions.set('hand', { name: 'hand' });
  m._extractIntents = () => [];
  m._scanJsonlText(BOLD_VERDICT, 'hand', []);
  assert.deepStrictEqual(calls, []);
});

test('the nudge body names the intent and the re-emit shape', () => {
  assert.match(PROSE_VERDICT_NUDGE, /\[agent:review-done\] <your full verdict>/);
  assert.match(PROSE_VERDICT_NUDGE, /\[agent:end\]/);
  assert.match(PROSE_VERDICT_NUDGE, /reached no one/);
});
