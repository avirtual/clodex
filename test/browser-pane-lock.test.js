'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { initial, reduce, barView } = require('../plugins/browser-pane/lock');

const S = (state, more = {}) => ({ state, reason: null, seat: null, what: null, takeover: false, suppress: false, ...more });
const DRIVING = S('driving', { seat: 'clodex-hand', what: 'click [5] "Download PDF"' });

const ROWS = [
  ['closed', S('closed'), { type: 'open' }, S('idle')],
  ['closed ignores gate', S('closed'), { type: 'gate', seat: 'clodex-hand', what: 'click [5]' }, S('closed')],
  ['idle → gating', S('idle'), { type: 'gate', seat: 'clodex-hand', what: 'click [5]' }, S('gating', { seat: 'clodex-hand', what: 'click [5]' })],
  ['gating → driving', S('gating', { seat: 'clodex-hand', what: 'click [5]' }), { type: 'quiet' }, S('driving', { seat: 'clodex-hand', what: 'click [5]' })],
  ['gating busy → idle', S('gating', { seat: 'clodex-hand', what: 'click [5]' }), { type: 'busy' }, S('idle')],
  ['gating takeover → held', S('gating', { seat: 'clodex-hand', what: 'click [5]' }), { type: 'takeover' }, S('held', { reason: 'takeover' })],
  ['driving describe', S('driving', { seat: 'clodex-hand', what: 'click [5]' }), { type: 'describe', what: 'click [5] "Download PDF"' }, DRIVING],
  ['driving done → idle', DRIVING, { type: 'done', signin: null }, S('idle')],
  ['driving done sign-in → held', DRIVING, { type: 'done', signin: 'login' }, S('held', { reason: 'login' })],
  ['driving done google → held idp', DRIVING, { type: 'done', signin: 'idp' }, S('held', { reason: 'idp' })],
  ['takeover during driving is deferred', DRIVING, { type: 'takeover' }, { ...DRIVING, takeover: true }],
  ['deferred takeover lands at done', { ...DRIVING, takeover: true }, { type: 'done', signin: null }, S('held', { reason: 'takeover' })],
  ['deferred takeover beats sign-in', { ...DRIVING, takeover: true }, { type: 'done', signin: 'login' }, S('held', { reason: 'takeover' })],
  ['idle takeover → held', S('idle'), { type: 'takeover' }, S('held', { reason: 'takeover' })],
  ['idle sign-in from a read → held', S('idle'), { type: 'signin', reason: 'otp' }, S('held', { reason: 'otp' })],
  ['held refuses gate', S('held', { reason: 'login' }), { type: 'gate', seat: 'clodex-hand', what: 'click [5]' }, S('held', { reason: 'login' })],
  ['handback sets suppression', S('held', { reason: 'login' }), { type: 'handback' }, S('idle', { suppress: true })],
  ['suppressed read sign-in stays idle', S('idle', { suppress: true }), { type: 'signin', reason: 'login' }, S('idle', { suppress: true })],
  ['suppressed act sign-in stays idle', { ...DRIVING, suppress: true }, { type: 'done', signin: 'login' }, S('idle', { suppress: true })],
  ['password refusal forces the handoff', { ...DRIVING, suppress: true }, { type: 'done', signin: 'login', force: true }, S('held', { reason: 'login', suppress: true })],
  ['navigation clears suppression', S('idle', { suppress: true }), { type: 'navigate' }, S('idle')],
  ['then a sign-in holds again', S('idle'), { type: 'signin', reason: 'login' }, S('held', { reason: 'login' })],
  ['window closed from driving', DRIVING, { type: 'closed' }, S('closed')],
  ['window closed from held', S('held', { reason: 'login' }), { type: 'closed' }, S('closed')],
];

for (const [name, from, ev, to] of ROWS) {
  test(`lock: ${name}`, () => {
    assert.deepStrictEqual(reduce(from, ev), to);
  });
}

test('lock: initial is closed', () => {
  assert.deepStrictEqual(initial(), S('closed'));
});

const VIEWS = [
  [S('closed'), { tone: 'grey', text: 'closed', takeover: false, handback: false }],
  [S('idle'), { tone: 'grey', text: 'Idle — agents act only after you pause for 3s', takeover: true, handback: false }],
  [S('gating', { seat: 'clodex-hand', what: 'click [5]' }),
    { tone: 'wait', text: 'Agent waiting for you to pause — clodex-hand wants to click [5]', takeover: true, handback: false }],
  [DRIVING, { tone: 'amber', takeover: true, handback: false,
    text: '● Agent driving — clodex-hand: click [5] "Download PDF" — your clicks and keys are ignored until it finishes' }],
  [{ ...DRIVING, takeover: true }, { tone: 'amber', takeover: false, handback: false,
    text: 'Take over requested — you get control when clodex-hand: click [5] "Download PDF" finishes' }],
  [S('held', { reason: 'login' }), { tone: 'blue', text: 'You have control (sign-in) — Hand back to agent ▸', takeover: false, handback: true }],
  [S('held', { reason: 'takeover' }), { tone: 'blue', text: 'You have control (takeover) — Hand back to agent ▸', takeover: false, handback: true }],
];

for (const [s, want] of VIEWS) {
  test(`lock bar: ${s.state}${s.takeover ? ' (takeover pending)' : ''}${s.reason ? ` (${s.reason})` : ''}`, () => {
    assert.deepStrictEqual(barView(s, { service: 'utility', url: 'https://portal.example.com/' }),
      { service: 'utility', url: 'https://portal.example.com/', state: s.state, ...want });
  });
}
