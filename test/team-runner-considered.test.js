'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { pickRunner, pickRecord, consideredOf, waitNote, ledgerPicks, CONSIDERED_MAX } = require('../suite-client');
const { TEST_RUNNER_POOL_MAX } = require('../team-manifest');
const { pickRunner5211 } = require('./lib/pick-5211');

const DEF = { definitionHash: 'h1', rev: 1 };
const READY = { box: { state: 'ready', definitionHash: 'h1', env: { box: { definitionHash: 'h1' } } } };
const INFO = (total, inUse, queued = 0, extra = {}) => ({
  ok: true, slots: { total, inUse }, queue: { running: inUse ? 'r' : null, queued: Array.from({ length: queued }, (_, i) => `q${i}`) }, ...extra,
});
const M = (peer, info, extra = {}) => ({ peer, wire: 'push', live: true, info, ...extra });
const IDLE = { total: 1, inUse: 0, free: 1, queue: 0, pending: 0 };

const STATE_ROWS = [
  ['chosen', 'a', 'chosen', undefined, [M('a', INFO(1, 0)), M('b', INFO(1, 1))], {}, []],
  ['ranked lower', 'b', 'ranked-lower', undefined, [M('a', INFO(1, 0)), M('b', INFO(1, 1))], {}, []],
  ['no answer, timed out', 'b', 'no-answer', 'timeout', [M('a', INFO(1, 0)), M('b', null, { why: 'timeout' })], {}, []],
  ['no answer, refused', 'b', 'no-answer', 'refused', [M('a', INFO(1, 0)), M('b', null, { why: 'refused' })], {}, []],
  ['no answer, other error', 'b', 'no-answer', 'error', [M('a', INFO(1, 0)), M('b', null)], {}, []],
  ['box probing', 'b', 'probing', undefined, [M('a', INFO(1, 0, 0, READY)), M('b', INFO(1, 0, 0, { box: { state: 'probing', definitionHash: 'h1' } }))], { box: DEF }, []],
  ['not live', 'b', 'not-live', undefined, [M('a', INFO(1, 0)), { peer: 'b', wire: 'push', live: false, info: null }], {}, []],
  ['excluded, no box and cannot build', 'b', 'excluded', 'no-box', [M('a', INFO(1, 0, 0, READY)), M('b', INFO(1, 0))], { box: DEF }, []],
  ['excluded, share missing', 'b', 'excluded', 'share-missing',
    [M('a', INFO(1, 0, 0, { ...READY, shares: [{ name: 's', version: '1' }] })), M('b', INFO(1, 0, 0, READY))], { box: DEF, shares: [{ share: 's', version: '1' }] }, []],
  ['excluded, the job just failed there', 'c', 'excluded', 'failed', [M('a', INFO(1, 0)), M('b', INFO(1, 1))], {}, ['c']],
];

for (const [name, member, state, why, members, opts, excluded] of STATE_ROWS) {
  test(`t2455: a considered entry for a member ${name} reads state ${state}${why ? ` (${why})` : ''}`, () => {
    const list = consideredOf(pickRunner(members, opts), excluded);
    const got = list.find((c) => c.member === member);
    assert.ok(got, `ENTER: ${member} is in the list`);
    assert.deepStrictEqual([got.state, got.why], [state, why]);
  });
}

test('t2455: an answered member carries the ranking inputs the pick used — an honouring busy member outranks an idle ignorer, taken from the same load object', () => {
  const pick = pickRunner([M('a', INFO(2, 1, 0, { pending: 1, exclusive: 'honour' }), { sent: 1 }), M('b', INFO(1, 0, 0, { exclusive: 'ignore' }))], { exclusive: true });
  const list = consideredOf(pick);
  assert.deepStrictEqual(list, [
    { member: 'a', state: 'chosen', load: { total: 2, inUse: 2, free: 0, queue: 1, pending: 2 }, tier: 0, rank: 1, exclusive: 'honour' },
    { member: 'b', state: 'ranked-lower', load: IDLE, tier: 0, rank: 2, exclusive: 'ignore' },
  ]);
  assert.strictEqual(list[0].load, pick.ranks[0].load);
});

test('t2455: the list is in rank order — chosen, the answered by rank, then the unanswered in pool order', () => {
  const members = [M('a', INFO(1, 1, 2)), M('x', null, { why: 'timeout' }), M('b', INFO(1, 0)), { peer: 'y', live: false, info: null }, M('c', INFO(1, 1, 1)), M('d', INFO(1, 0))];
  assert.deepStrictEqual(consideredOf(pickRunner(members)).map((c) => [c.member, c.state]),
    [['b', 'chosen'], ['d', 'ranked-lower'], ['c', 'ranked-lower'], ['a', 'ranked-lower'], ['x', 'no-answer'], ['y', 'not-live']]);
});

test('t2455: at most eight entries, the pool cap, and the worst-case list stays under 1700 bytes', () => {
  assert.strictEqual(CONSIDERED_MAX, TEST_RUNNER_POOL_MAX);
  const long = (i) => `${String(i)}${'n'.repeat(63)}`;
  const nine = Array.from({ length: 9 }, (_, i) => M(long(i), INFO(4, 4, 999, { pending: 999, exclusive: 'honour', ...READY })));
  const list = consideredOf(pickRunner(nine, { box: DEF, exclusive: true }));
  assert.strictEqual(list.length, 8);
  const bytes = Buffer.byteLength(`,"considered":${JSON.stringify(list)}`);
  assert.ok(bytes <= 1700, `worst case ${bytes} bytes`);
});

const FIELD_PICK = { chosen: 'portable-debian', skipped: [{ member: 'avh', reason: 'no answer' }] };

test('t2455: the old chosen and skipped keys keep the shape the field ledger carries', () => {
  const pick = pickRunner([M('avh', null), M('portable-debian', INFO(1, 0)), M('MacBook-Pro-3', INFO(1, 1))]);
  const { considered, ...old } = { ...pickRecord(pick), considered: consideredOf(pick) };
  assert.deepStrictEqual(old, FIELD_PICK);
  assert.deepStrictEqual(considered.map((c) => c.state), ['chosen', 'ranked-lower', 'no-answer']);
});

const CHOICE_ROWS = [
  ['two idle, a tie', [M('a', INFO(1, 0)), M('b', INFO(1, 0))], {}, 0],
  ['the second idle', [M('a', INFO(1, 1)), M('b', INFO(1, 0))], {}, 1],
  ['both busy, shorter queue', [M('a', INFO(1, 1, 2)), M('b', INFO(1, 1, 1))], {}, 1],
  ['both busy, equal queue, a tie', [M('a', INFO(1, 1, 1)), M('b', INFO(1, 1, 1))], {}, 0],
  ['two slots beat one in use', [M('a', INFO(2, 1)), M('b', INFO(3, 1))], {}, 1],
  ['fewer in use beats more free', [M('a', INFO(4, 2)), M('b', INFO(2, 1))], {}, 1],
  ['pending folds into the slots', [M('a', INFO(1, 0, 0, { pending: 1 })), M('b', INFO(1, 0))], {}, 1],
  ['sent folds into the slots', [M('a', INFO(1, 0), { sent: 1 }), M('b', INFO(1, 1))], {}, 0],
  ['first not live, second busy', [{ peer: 'a', live: false, info: null }, M('b', INFO(1, 1))], {}, 1],
  ['none answered', [M('a', null), M('b', null, { why: 'timeout' })], {}, 0],
  ['box ready beats can-build idle', [M('a', INFO(1, 0, 0, { box: { state: 'can-build', definitionHash: 'h1' } })), M('b', INFO(1, 1, 0, READY))], { box: DEF }, 1],
  ['building beats probing', [M('a', INFO(1, 0, 0, { box: { state: 'probing', definitionHash: 'h1' } })), M('b', INFO(1, 0, 0, { box: { state: 'building', definitionHash: 'h1' } }))], { box: DEF }, 1],
  ['exclusive, honour beats an idle ignorer', [M('a', INFO(1, 0, 0, { exclusive: 'ignore' })), M('b', INFO(1, 1, 0, { exclusive: 'honour' }))], { exclusive: true }, 1],
  ['exclusive, two honouring, the idle one', [M('a', INFO(1, 1, 0, { exclusive: 'honour' })), M('b', INFO(1, 0, 0, { exclusive: 'honour' }))], { exclusive: true }, 1],
  ['three-way tie among idle', [M('a', INFO(1, 0)), M('b', INFO(1, 0)), M('c', INFO(1, 0))], {}, 0],
];

for (const [name, members, opts, index] of CHOICE_ROWS) {
  test(`t2455: the pick chooses as 5.211 did — ${name}`, () => {
    const now = pickRunner(members, opts);
    const ref = pickRunner5211(members, opts);
    assert.deepStrictEqual([now.index, now.chosen, now.member && now.member.peer], [index, ref.chosen, ref.member && ref.member.peer]);
    assert.strictEqual(ref.index, index);
    if (now.chosen) assert.deepStrictEqual([consideredOf(now)[0].member, consideredOf(now)[0].state], [members[index].peer, 'chosen']);
  });
}

const WAIT_ROWS = [
  ['three minutes, a member with no answer', { where: 'avh', queueMs: 180000, pick: { chosen: 'avh', considered: [{ member: 'avh', state: 'chosen' }, { member: 'MacBook-Pro-3', state: 'no-answer', why: 'timeout' }] } },
    '(waited 3m on avh; MacBook-Pro-3 no answer (timeout))'],
  ['71 s, a busy member ranked lower', { where: 'avh', queueMs: 71423, pick: { chosen: 'avh', considered: [{ member: 'avh', state: 'chosen' }, { member: 'pd', state: 'ranked-lower' }] } },
    '(waited 71s on avh; pd ranked lower)'],
  ['moved, the move list names the other member', { where: 'pd', queueMs: 90000, pick: { chosen: 'avh', considered: [{ member: 'avh', state: 'chosen' }] },
    moved: [{ from: 'avh', to: 'pd', considered: [{ member: 'pd', state: 'chosen' }, { member: 'avh', state: 'ranked-lower' }] }] }, '(waited 90s on pd; avh ranked lower)'],
  ['a lone member', { where: 'avh', queueMs: 61000, pick: { chosen: 'avh', considered: [{ member: 'avh', state: 'chosen' }] } }, '(waited 61s on avh)'],
  ['exactly 60 s', { where: 'avh', queueMs: 60000, pick: { chosen: 'avh', considered: [{ member: 'b', state: 'ranked-lower' }] } }, null],
  ['under 60 s', { where: 'avh', queueMs: 59999, pick: { chosen: 'avh', considered: [{ member: 'b', state: 'ranked-lower' }] } }, null],
  ['no queue figure', { where: 'avh', queueMs: null, pick: null }, null],
];

for (const [name, record, want] of WAIT_ROWS) {
  test(`t2455: the waited clause — ${name}`, () => {
    assert.strictEqual(waitNote(record), want);
  });
}

test('t2455: ledgerPicks reads the latest row per job that carries a pick, start rows included', () => {
  const file = path.join(mkTmpRoot('clodex-considered-'), 'suite-runs.jsonl');
  const P = { chosen: 'a', considered: [{ member: 'a', state: 'chosen' }] };
  fs.writeFileSync(file, [
    { id: 'j1', phase: 'start', where: 'a', team: 't', kind: 'hand', queuedAt: 'q', startedAt: 's', pick: P },
    { id: 'j0', phase: 'end', where: 'a', team: 't', kind: 'verify', queuedAt: 'q' },
    { id: 'j2', phase: 'start', where: 'b', team: 't', kind: 'hand', queuedAt: 'q2', startedAt: 's2', pick: P, moved: [{ from: 'a', to: 'b' }] },
    { id: 'j1', phase: 'end', where: 'a', team: 't', kind: 'hand', queuedAt: 'q', endedAt: 'e', outcome: 'pass', queueMs: 5, pick: P },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n{bad');
  assert.deepStrictEqual(ledgerPicks(file), [
    { id: 'j2', phase: 'start', team: 't', ticket: undefined, seat: undefined, kind: 'hand', where: 'b', queuedAt: 'q2', startedAt: 's2', pick: P, moved: [{ from: 'a', to: 'b' }] },
    { id: 'j1', phase: 'end', team: 't', ticket: undefined, seat: undefined, kind: 'hand', where: 'a', queuedAt: 'q', endedAt: 'e', outcome: 'pass', queueMs: 5, pick: P },
  ]);
  assert.deepStrictEqual(ledgerPicks(path.join(path.dirname(file), 'absent.jsonl')), []);
});
