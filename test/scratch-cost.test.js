'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tc = require('../team-cost');

const STATS = {
  bytes: { before: 300000, kept: 88000, dropped: 212000 },
  records: {
    dropped: 140,
    byType: { assistant: 40, user: 60, system: 38, sidecar: 2 },
    toolResults: 57,
    toolResultBytes: 190000,
    backgroundTasksDropped: 1,
  },
  turns: { dropped: 14 },
  tokens: { atBegin: 41000, atCut: 102000, dropped: 61000 },
};

function cutRow(over = {}) {
  return tc.scratchCostRecord({
    seat: 'clodex-hand-9', team: 'clodex', sessionId: 'sid-1', nonce: 's7f3a1',
    beganAt: 1000, endedAt: 421000, stats: STATS, summaryBytes: 1843,
    replayed: 2, dispatched: ['t99'], outcome: 'cut', reason: null,
    recycleMs: 5120, ...over,
  });
}

test('scratchCostRecord: a cut row carries the §8 shape', () => {
  const r = cutRow();
  assert.strictEqual(r.version, tc.SCRATCH_COST_VERSION);
  assert.strictEqual(r.seat, 'clodex-hand-9');
  assert.strictEqual(r.team, 'clodex');
  assert.strictEqual(r.sessionId, 'sid-1');
  assert.strictEqual(r.nonce, 's7f3a1',
    'the nonce is what ties this row to a wirescope observation of the post-resume request');
  assert.strictEqual(r.beganAt, 1000);
  assert.strictEqual(r.endedAt, 421000);
  assert.strictEqual(r.wallMs, 420000);
  assert.strictEqual(r.recycleMs, 5120);
  assert.strictEqual(r.outcome, 'cut');
  assert.strictEqual(r.reason, null);
  assert.deepStrictEqual(r.bytes, { before: 300000, kept: 88000, dropped: 212000 });
  assert.strictEqual(r.records.dropped, 140);
  assert.deepStrictEqual(r.records.byType, { assistant: 40, user: 60, system: 38, sidecar: 2 });
  assert.strictEqual(r.records.toolResults, 57);
  assert.strictEqual(r.records.toolResultBytes, 190000);
  assert.strictEqual(r.records.backgroundTasksDropped, 1);
  assert.deepStrictEqual(r.turns, { dropped: 14 });
  assert.deepStrictEqual(r.tokens, { atBegin: 41000, atCut: 102000, dropped: 61000 });
  assert.strictEqual(r.summaryBytes, 1843);
  assert.strictEqual(r.replayed, 2);
  assert.deepStrictEqual(r.dispatched, ['t99']);
});

test('scratchCostRecord: byType is COPIED, so a later mutation of stats cannot rewrite a written row', () => {
  const stats = JSON.parse(JSON.stringify(STATS));
  const r = cutRow({ stats });
  stats.records.byType.assistant = 999;
  assert.strictEqual(r.records.byType.assistant, 40);
});

test('scratchCostRecord: a refused episode reads as UNMEASURED, never as zero', () => {
  const r = tc.scratchCostRecord({
    seat: 'a', nonce: 'n1', beganAt: 10, endedAt: 20,
    outcome: 'refused', reason: 'arrivals', stats: null,
  });
  assert.strictEqual(r.outcome, 'refused');
  assert.strictEqual(r.reason, 'arrivals');
  for (const k of ['before', 'kept', 'dropped']) {
    assert.strictEqual(r.bytes[k], null, `bytes.${k} is null — nothing was cut, so nothing was measured`);
  }
  assert.strictEqual(r.records.dropped, null);
  assert.strictEqual(r.records.byType, null);
  assert.strictEqual(r.records.toolResults, null);
  assert.strictEqual(r.records.toolResultBytes, null);
  assert.strictEqual(r.records.backgroundTasksDropped, null);
  assert.strictEqual(r.turns.dropped, null);
  for (const k of ['atBegin', 'atCut', 'dropped']) {
    assert.strictEqual(r.tokens[k], null, `tokens.${k} is null`);
  }
  assert.strictEqual(r.replayed, null, 'nothing was replayed because nothing was cut');
  assert.notStrictEqual(r.bytes.dropped, 0,
    'the whole point: an episode that could not be measured must never be indistinguishable '
    + 'from one that dropped nothing');
});

test('scratchCostRecord: a refusal CAUGHT BY THE VALIDATOR still carries the stats it computed', () => {
  const r = tc.scratchCostRecord({
    seat: 'a', nonce: 'n1', outcome: 'refused', reason: 'arrivals', stats: STATS,
  });
  assert.strictEqual(r.bytes.dropped, 212000,
    'the validator measured what the cut WOULD have dropped; that is the number that says how '
    + 'much a refused episode is costing the seat');
  assert.strictEqual(r.replayed, null, 'but nothing was actually replayed');
});

test('scratchCostRecord: a token field the transcript never carried stays null inside a real cut', () => {
  const r = cutRow({ stats: { ...STATS, tokens: { atBegin: null, atCut: 102000, dropped: null } } });
  assert.strictEqual(r.tokens.atBegin, null);
  assert.strictEqual(r.tokens.atCut, 102000);
  assert.strictEqual(r.tokens.dropped, null);
  assert.strictEqual(r.bytes.dropped, 212000, 'and the bytes, which WERE measured, are unaffected');
});

test('scratchCostRecord: wallMs is null rather than negative or zero when the clocks do not resolve', () => {
  assert.strictEqual(tc.scratchCostRecord({ seat: 'a', beganAt: null, endedAt: 500 }).wallMs, null);
  assert.strictEqual(tc.scratchCostRecord({ seat: 'a', beganAt: 900, endedAt: 500 }).wallMs, null);
  assert.strictEqual(tc.scratchCostRecord({ seat: 'a', beganAt: 100, endedAt: 100 }).wallMs, 0);
  assert.strictEqual(tc.scratchCostRecord({ seat: 'a', beganAt: 10, now: 30 }).endedAt, 30,
    'endedAt falls back to now, so a row always says when it was written');
});

test('scratchCostRecord: recycleMs is null on every arm that never killed the process', () => {
  assert.strictEqual(tc.scratchCostRecord({ seat: 'a', recycleMs: null }).recycleMs, null);
  assert.strictEqual(tc.scratchCostRecord({ seat: 'a', recycleMs: -1 }).recycleMs, null);
  assert.strictEqual(tc.scratchCostRecord({ seat: 'a', recycleMs: 5120.6 }).recycleMs, 5121);
});

test('scratchCostRecord: a teamless seat gets a row with team null, not a missing row', () => {
  const r = tc.scratchCostRecord({ seat: 'solo', nonce: 'n2', outcome: 'cut', stats: STATS });
  assert.strictEqual(r.team, null);
  assert.strictEqual(r.seat, 'solo');
  assert.strictEqual(r.bytes.dropped, 212000);
});

test('scratchCostRecord: dispatched drops the tokens that could not be resolved', () => {
  const r = cutRow({ dispatched: ['t99', null, 'bob', undefined] });
  assert.deepStrictEqual(r.dispatched, ['t99', 'bob'],
    'a dispatch whose token the recorder could not name is not a searchable identity, and a null '
    + 'in this list would read as one');
  assert.deepStrictEqual(tc.scratchCostRecord({ seat: 'a' }).dispatched, []);
});

test('scratchCostRecord: every field is JSON round-trippable — this row is written as JSONL', () => {
  const r = cutRow();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), r,
    'no undefined, no Date, no Buffer: a field that does not survive JSON.stringify is a field '
    + 'the file silently loses');
});

test('scratch-cost.jsonl is APPENDED — a second episode never rewrites the first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-cost-'));
  const file = path.join(dir, tc.SCRATCH_COST_FILE);
  const first = cutRow({ nonce: 'aaa111', outcome: 'refused', reason: 'arrivals', stats: null });
  const second = cutRow({ nonce: 'bbb222' });
  fs.appendFileSync(file, `${JSON.stringify(first)}\n`);
  fs.appendFileSync(file, `${JSON.stringify(second)}\n`);

  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.strictEqual(rows.length, 2, 'both episodes are on disk');
  assert.deepStrictEqual(rows.map((r) => r.nonce), ['aaa111', 'bbb222'],
    'in the order they happened — the refused one is the discipline signal and would be the row '
    + 'a whole-file rewrite silently lost');
  assert.strictEqual(rows[0].outcome, 'refused');
  assert.strictEqual(rows[1].outcome, 'cut');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SCRATCH_COST_FILE sits beside the team ledger, not inside a per-ticket task dir', () => {
  assert.strictEqual(tc.SCRATCH_COST_FILE, 'scratch-cost.jsonl');
  assert.notStrictEqual(tc.SCRATCH_COST_FILE, tc.TEAM_LEDGER_FILE);
  assert.notStrictEqual(tc.SCRATCH_COST_FILE, tc.REVIEW_COST_FILE);
});
