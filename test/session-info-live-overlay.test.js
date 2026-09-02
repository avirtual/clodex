'use strict';
// Run: node --test test/session-info-live-overlay.test.js
//
// The ⓘ panel's agent total, driven through the REAL `session:info` handler.
//
// The subject is a JOIN between two files, so neither half is stubbed: the
// handler decides WHICH payloads become an overlay, and sumAgentCost decides
// what an overlay does to the total — it REPLACES the file's row for the
// current id rather than adding to it. Stubbing sessionInfo would assert the
// handler's gate while the arithmetic it feeds went unexercised, and stubbing
// the handler would test a gate nothing in the app runs.
//
// What it guards is the property session-info.js's header states by name: the
// agent total must never appear to go DOWN between two opens of the panel.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const { registerIpcHandlers } = require('../ipc-handlers');
const { createSessionInfo } = require('../session-info');

const ENTRY = {
  name: 'seat', type: 'claude', cwd: '/tmp/work',
  sessionIds: ['sid-old'], sessionId: 'sid-now', createdAt: 1000,
};

// The handler wired to the real session-info module over a tmp userData, with
// `wire-totals.json` as the fixture writes it. `wire` is what
// `_wireTelemetry.payload(name)` returns — null means no telemetry at all,
// which is the un-overlaid baseline every subject here compares against.
function mkDoor({ sessions, wire }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-sinfo-overlay-'));
  fs.writeFileSync(path.join(root, 'wire-totals.json'), JSON.stringify({ sessions }));
  const sessionInfo = createSessionInfo({
    fs, readline, homedir: () => root,
    pathFor: () => path.join(root, 'no-symlink'),
    registryDir: root, userDataPath: root,
  });
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, warn() {}, error() {}, debug() {} },
    persistence: { get: (n) => (n === ENTRY.name ? ENTRY : null) },
    manager: { _wireTelemetry: wire === null ? null : { payload: () => wire } },
    proxyPoller: null,
    sessionInfo,
  });
  return {
    info: async () => {
      const r = await handlers.get('session:info')(null, ENTRY.name);
      assert.strictEqual(r.ok, true, `session:info failed: ${r.error}`);
      return r.info;
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const FILE_ROW = { 'sid-old': { cost: 1.5, requests: 5, turns: 2, refusals: 0 },
  'sid-now': { cost: 4.2, requests: 9, turns: 3, refusals: 1 } };

// A payload wire-telemetry emits when `_lifetime` had neither a persisted base
// nor a turn snapshot to add: the sessionId matches, every measured field is
// null. Reachable on a seat with a main-line turn and no `sessionTotals`.
const NULLED = { sessionId: 'sid-now', cost: { usd: null, requests: null }, turns: null, refusals: null };

test('a payload whose cost the wire never observed does not OMIT the recorded spend from the agent total', async () => {
  // sumAgentCost's per-field `typeof === 'number'` guard means the null
  // contributes nothing rather than a zero — so applied, this row does not
  // publish a false figure, it makes a real recorded spend disappear. The
  // total between two opens of the panel goes DOWN.
  const baseline = mkDoor({ sessions: FILE_ROW, wire: null });
  const nulled = mkDoor({ sessions: FILE_ROW, wire: NULLED });
  try {
    const b = (await baseline.info()).agent;
    const n = (await nulled.info()).agent;

    assert.strictEqual(b.usd, 5.7, 'the file alone: 1.5 + 4.2');
    assert.deepStrictEqual(n, b, 'the null overlay changed the agent total');
    assert.strictEqual(n.usd, 5.7, 'an applied null overlay reports 1.5 here — the current id vanishes');
    assert.strictEqual(n.requests, 14);
    assert.strictEqual(n.turns, 5);
    assert.strictEqual(n.known, 2, 'both ids still answered — an applied null keeps known at 2 but empties the sum');
  } finally { baseline.cleanup(); nulled.cleanup(); }
});

test('ENTER: the overlay branch is reachable with these ids', async () => {
  // The sibling of the case above, differing only in `cost.usd` being a real
  // number. It proves the fixture clears `w.sessionId === entry.sessionId`, so
  // the surviving 4.2 up there is the cost check doing work rather than a
  // fixture that silently missed the id gate and would assert the same thing
  // with no gate at all. It stays green under the mutation below by design: it
  // pins reachability, not the fix.
  const d = mkDoor({ sessions: FILE_ROW, wire: { ...NULLED, cost: { usd: 9.5, requests: 95 }, turns: 30 } });
  try {
    const a = (await d.info()).agent;
    assert.strictEqual(a.usd, 11, 'the live 9.5 replaced the file\'s 4.2, leaving sid-old\'s 1.5');
    assert.strictEqual(a.requests, 100);
    assert.strictEqual(a.turns, 32);
  } finally { d.cleanup(); }
});

test('a NaN cost is not applied either', async () => {
  // NaN passes `typeof === 'number'`, and every field it reaches sums to NaN —
  // a total the panel renders rather than a shortfall it reports. Number.isFinite
  // is what closes that door; typeof is what leaves it open.
  const baseline = mkDoor({ sessions: FILE_ROW, wire: null });
  const nan = mkDoor({ sessions: FILE_ROW, wire: { ...NULLED, cost: { usd: NaN, requests: NaN } } });
  try {
    const b = (await baseline.info()).agent;
    const n = (await nan.info()).agent;
    assert.deepStrictEqual(n, b, 'the NaN overlay changed the agent total');
    assert.strictEqual(n.usd, 5.7);
    assert.ok(Number.isFinite(n.usd), 'an applied NaN overlay makes the whole total NaN');
  } finally { baseline.cleanup(); nan.cleanup(); }
});

test('a payload for a DIFFERENT session is still not applied', async () => {
  // The id gate the cost check was added alongside — a conjunct added to a
  // guard is a chance to weaken the one already there.
  const d = mkDoor({ sessions: FILE_ROW, wire: { sessionId: 'sid-SOMEONE-ELSE', cost: { usd: 999, requests: 1 }, turns: 1, refusals: 0 } });
  try {
    const a = (await d.info()).agent;
    assert.strictEqual(a.usd, 5.7, 'the mismatched payload was ignored; the file answered');
  } finally { d.cleanup(); }
});
