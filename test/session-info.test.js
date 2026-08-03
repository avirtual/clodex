'use strict';
// The ⓘ panel: the ledger arithmetic and the transcript scan.
//
// What these guard is the ONE property Bogdan asked for by name — the agent
// lifetime total goes up and never resets. Three separate mechanisms can break
// it (a /clear mints a new session_id; the ledger file trails the live payload
// by a debounce; the ledger prunes past 500 sessions), so each has a test.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { createSessionInfo, trackedSessionIds, sumAgentCost, compactSummary } = require('../session-info');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-sinfo-'));
}

test('trackedSessionIds unions history with the live id', () => {
  // A seat that never cleared has a live id and NO history — the union is what
  // keeps its cost visible at all.
  assert.deepStrictEqual(trackedSessionIds({ sessionId: 'a' }), ['a']);
  assert.deepStrictEqual(trackedSessionIds({ sessionIds: ['a', 'b'], sessionId: 'c' }), ['a', 'b', 'c']);
  // setSessionId appends the OLD id then sets the new one, so the current id is
  // already in the history after a roll — it must not be counted twice.
  assert.deepStrictEqual(trackedSessionIds({ sessionIds: ['a', 'b'], sessionId: 'b' }), ['a', 'b']);
  assert.deepStrictEqual(trackedSessionIds({}), []);
  assert.deepStrictEqual(trackedSessionIds(null), []);
});

test('agent total sums every conversation the seat has held', () => {
  const totals = { sessions: {
    a: { cost: 1.5, requests: 10, turns: 3, refusals: 1 },
    b: { cost: 2.25, requests: 5, turns: 2, refusals: 0 },
    other: { cost: 99, requests: 1, turns: 1, refusals: 0 },
  } };
  const r = sumAgentCost(totals, ['a', 'b']);
  assert.strictEqual(r.usd, 3.75);
  assert.strictEqual(r.requests, 15);
  assert.strictEqual(r.turns, 5);
  assert.strictEqual(r.refusals, 1);
  assert.strictEqual(r.known, 2);
  assert.strictEqual(r.total, 2);
  // A seat's total must not absorb a conversation belonging to another seat.
  assert.ok(r.usd < 99);
});

test('the live ledger overrides the file for the current conversation', () => {
  // wire-totals.json is written on a 1s debounce. Without this override the
  // panel would show a SMALLER agent total right after a turn lands than it
  // showed before — the one thing this number must never do.
  const totals = { sessions: { a: { cost: 1, requests: 1, turns: 1, refusals: 0 }, b: { cost: 2, requests: 2, turns: 2, refusals: 0 } } };
  const stale = sumAgentCost(totals, ['a', 'b']);
  const fresh = sumAgentCost(totals, ['a', 'b'], { currentId: 'b', live: { cost: 5, requests: 9, turns: 4, refusals: 0 } });
  assert.strictEqual(stale.usd, 3);
  assert.strictEqual(fresh.usd, 6);        // a's 1 from the file + b's live 5
  assert.strictEqual(fresh.requests, 10);
  assert.ok(fresh.usd > stale.usd);
});

test('a pruned ledger reports partial coverage instead of a confident total', () => {
  // The ledger keeps only the newest 500 conversations, so an old seat's
  // earliest spend is GONE. Reporting known/total is what stops the panel
  // presenting an understated figure as complete.
  const r = sumAgentCost({ sessions: { b: { cost: 2 } } }, ['a', 'b', 'c']);
  assert.strictEqual(r.usd, 2);
  assert.strictEqual(r.known, 1);
  assert.strictEqual(r.total, 3);
});

test('sumAgentCost tolerates a missing or malformed ledger', () => {
  assert.strictEqual(sumAgentCost(null, ['a']).usd, 0);
  assert.strictEqual(sumAgentCost({}, ['a']).known, 0);
  assert.strictEqual(sumAgentCost({ sessions: { a: {} } }, ['a']).usd, 0);
  assert.strictEqual(sumAgentCost({ sessions: { a: { cost: 'x' } } }, ['a']).usd, 0);
});

test('dropped tokens come from the last boundary, never a sum', () => {
  // cumulativeDroppedTokens is a RUNNING total in the CLI's own metadata.
  // Summing it across boundaries triple-counts; summing pre−post instead
  // undercounts (post is the summary, not what survived).
  const b = [
    { trigger: 'manual', preTokens: 100, postTokens: 10, cumulativeDroppedTokens: 90 },
    { trigger: 'manual', preTokens: 200, postTokens: 20, cumulativeDroppedTokens: 270 },
  ];
  const s = compactSummary(b);
  assert.strictEqual(s.count, 2);
  assert.strictEqual(s.dropped, 270);
  assert.strictEqual(s.last.pre, 200);
  assert.strictEqual(s.last.post, 20);
});

test('compactSummary separates auto from manual, and handles never-compacted', () => {
  assert.deepStrictEqual(compactSummary([]), { count: 0, dropped: null, last: null, autoCount: 0 });
  const s = compactSummary([{ trigger: 'auto' }, { trigger: 'manual' }, { trigger: 'auto' }]);
  assert.strictEqual(s.count, 3);
  assert.strictEqual(s.autoCount, 2);
  assert.strictEqual(s.dropped, null); // no metadata → not invented
});

test('the transcript scan counts real boundaries, not quoted ones', async () => {
  const root = tmpRoot();
  const f = path.join(root, 't.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user', timestamp: '2026-08-01T10:00:00Z' }),
    // Assistant PROSE containing the marker string. A substring test alone
    // would count this; the type/subtype check after the parse is what rejects it.
    JSON.stringify({ type: 'assistant', text: 'the compact_boundary record is written by the CLI' }),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-08-01T11:00:00Z', compactMetadata: { trigger: 'manual', preTokens: 100, postTokens: 9, cumulativeDroppedTokens: 91 } }),
    'not json at all',
    JSON.stringify({ type: 'user', timestamp: '2026-08-01T12:00:00Z' }),
  ].join('\n') + '\n');

  const si = createSessionInfo({ fs, readline, homedir: () => root, pathFor: () => path.join(root, 'nope'), registryDir: root, userDataPath: root });
  const scan = await si.scanTranscript(f);
  assert.strictEqual(scan.ok, true);
  assert.strictEqual(scan.boundaries.length, 1);
  assert.strictEqual(scan.boundaries[0].preTokens, 100);
  assert.strictEqual(scan.lines, 5);
  assert.strictEqual(scan.firstTs, '2026-08-01T10:00:00Z');
  // The LAST timestamp, not the last one that happened to sit on a parsed line
  // — the scan only parses boundary lines, so the tail is read at close.
  assert.strictEqual(scan.lastTs, '2026-08-01T12:00:00Z');

  fs.rmSync(root, { recursive: true, force: true });
});

test('a missing transcript degrades to an empty scan, never a throw', async () => {
  const root = tmpRoot();
  const si = createSessionInfo({ fs, readline, homedir: () => root, pathFor: () => path.join(root, 'nope'), registryDir: root, userDataPath: root });
  const scan = await si.scanTranscript(path.join(root, 'gone.jsonl'));
  assert.strictEqual(scan.ok, false);
  assert.deepStrictEqual(scan.boundaries, []);
  assert.strictEqual(await si.scanTranscript(null).then((s) => s.ok), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('collect assembles the panel record and keeps the three cost scopes apart', async () => {
  const root = tmpRoot();
  const proj = path.join(root, '.claude', 'projects', '-tmp-work');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'sid2.jsonl'),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-08-01T11:00:00Z', compactMetadata: { trigger: 'manual', preTokens: 150, postTokens: 12, cumulativeDroppedTokens: 138 } }) + '\n');
  fs.writeFileSync(path.join(root, 'wire-totals.json'), JSON.stringify({ version: 1, sessions: {
    sid1: { cost: 4, requests: 20, turns: 8, refusals: 0 },
    sid2: { cost: 6, requests: 30, turns: 9, refusals: 1 },
  } }));

  const si = createSessionInfo({
    fs, readline, homedir: () => root,
    pathFor: () => path.join(root, 'no-symlink'), // forces the composed-path fallback
    registryDir: root, userDataPath: root,
  });
  const info = await si.collect({
    name: 'seat',
    entry: { type: 'claude', cwd: '/tmp/work', sessionIds: ['sid1'], sessionId: 'sid2', createdAt: 1000, stripLevel: 2 },
    payload: { linked: true, model: 'claude-opus-5', costRun: { usd: 0.5, requests: 3 }, sinceCompact: { estUsd: 0.25, compacted: true }, subagents: [{}, {}] },
  });

  assert.strictEqual(info.sessionCount, 2);
  assert.strictEqual(info.compact.count, 1);
  assert.strictEqual(info.compact.dropped, 138);
  // The three scopes stay distinct — this is the 07-15 ruling in test form.
  assert.strictEqual(info.run.usd, 0.5);          // this process
  assert.strictEqual(info.session.usd, 6);        // this conversation
  assert.strictEqual(info.agent.usd, 10);         // every conversation, monotonic
  assert.strictEqual(info.sinceCompact.estUsd, 0.25);
  assert.strictEqual(info.agent.known, 2);
  assert.strictEqual(info.subagents, 2);
  assert.strictEqual(info.stripLevel, 2);

  fs.rmSync(root, { recursive: true, force: true });
});

test('collect survives a session with no telemetry at all', async () => {
  const root = tmpRoot();
  const si = createSessionInfo({ fs, readline, homedir: () => root, pathFor: () => path.join(root, 'x'), registryDir: root, userDataPath: root });
  const info = await si.collect({ name: 'bash1', entry: { type: 'bash', cwd: '/tmp/work' } });
  assert.strictEqual(info.linked, false);
  assert.strictEqual(info.session, null);
  assert.strictEqual(info.run, null);
  assert.strictEqual(info.compact.count, 0);
  assert.strictEqual(info.agent.total, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
