'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const { readCache, writeCache } = require('../ipc-prompt-cache');
const { enqueueNotice, parseNotices } = require('../notice-queue');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { mkManager, spawn, bakedBytes, settle, moveTruth } = require('./lib/prompt-regen-fixture');

function landSummary(h, name) {
  const w = h.watchers.filter((x) => x.name === name).pop();
  w.onCompact();
}

test('compact lands with a pending delta on a claude seat: kill+create with --resume <same sid>, fresh bake, notices kept, continuation is turn one', async () => {
  const root = mkTmpRoot('clodex-regen-'), name = 'rx';
  const h = mkManager(root);
  try {
    const s = await spawn(h, name);
    const born = bakedBytes(root, name);
    const sid = s.sessionId;
    assert.ok(sid, 'ENTER: the watcher stub reported an id');
    assert.strictEqual(h.persisted.get(name).sessionId, sid);
    h.persisted.get(name).ephemeral = true;
    h.persisted.get(name).reviewFor = 't9';
    s._scratchVoid = { tomb: 1 };
    enqueueNotice(root, name, 'queued before the compact');
    moveTruth(h);
    assert.strictEqual(h.m._promptDeltaPending(name), true, 'ENTER: the moved team block is a pending delta');

    h.m._handleContextIntent(s, 'compact', 'carry on from step 3');
    assert.deepStrictEqual(h.typed, ['/compact']);
    assert.strictEqual(s._compactContinuation, 'carry on from step 3');
    landSummary(h, name);
    await settle(h, 2);

    assert.strictEqual(h.spawns.length, 2, 'the compact respawned the CLI');
    const args = h.spawns[1].args;
    assert.strictEqual(args[args.indexOf('--resume') + 1], sid, `--resume carries the compact's own id: ${args.join(' ')}`);
    assert.ok(!args.includes('--fork-session'));
    assert.deepStrictEqual(h.typed, ['/compact'], 'nothing else typed into the old process');
    assert.deepStrictEqual(h.handoffs, ['carry on from step 3'], 'the continuation is the fresh process turn one');
    assert.strictEqual(h.refreshes.length, 0, 'neither refreshPrompt(compact) nor the clear edge fired');
    const fresh = bakedBytes(root, name);
    assert.notStrictEqual(fresh, born);
    assert.ok(fresh.includes('NEW TEAM BLOCK'));
    assert.strictEqual(readCache(root, name, 'session'), fresh, 'bakePrompt ran fresh under the resume');
    assert.strictEqual(readCache(root, name, 'notified'), fresh);
    assert.strictEqual(readCache(root, name, 'delta'), null);
    assert.strictEqual(readCache(root, name, 'next'), null);
    assert.strictEqual(h.m._promptDeltaPending(name), false, 'the seat now runs the current prompt');
    assert.deepStrictEqual(parseNotices(root, name).map((n) => n.text), ['queued before the compact'], 'a resume keeps the queue');
    const fresh2 = h.m.sessions.get(name);
    assert.notStrictEqual(fresh2, s);
    assert.deepStrictEqual(fresh2._scratchVoid, { tomb: 1 });
    assert.strictEqual(h.persisted.get(name).ephemeral, true);
    assert.strictEqual(h.persisted.get(name).reviewFor, 't9');
    assert.ok(h.shadow.some((r) => r.type === 'prompt-regen-at-compact' && r.agent === name && r.bytes > 0),
      `shadow row present: ${JSON.stringify(h.shadow)}`);
    assert.ok(h.msgs.includes('context compact → resumed with a regenerated prompt'));
  } finally { h.stop(name); }
});

test('compact lands with nothing pending: refreshPrompt(compact) once, no kill, no create, continuation typed as today', async () => {
  const root = mkTmpRoot('clodex-regen-'), name = 'rx';
  const h = mkManager(root);
  try {
    const s = await spawn(h, name);
    assert.strictEqual(h.m._promptDeltaPending(name), false, 'ENTER: nothing moved');
    h.m._handleContextIntent(s, 'compact', 'carry on from step 3');
    landSummary(h, name);
    await settle(h, 1);

    assert.strictEqual(h.spawns.length, 1, 'no respawn');
    assert.strictEqual(h.m.sessions.get(name), s);
    assert.deepStrictEqual(h.refreshes, [[name, 'compact']]);
    assert.deepStrictEqual(h.typed, ['/compact', 'carry on from step 3']);
    assert.deepStrictEqual(h.handoffs, []);
    assert.ok(!h.shadow.some((r) => r.type === 'prompt-regen-at-compact'));
    assert.strictEqual(s._compactGuard, false, 'the guard released on the old path');
  } finally { h.stop(name); }
});

test('compact on a codex seat or a claude seat without a recipe: untouched', async () => {
  const root = mkTmpRoot('clodex-regen-');
  const h = mkManager(root);
  const cx = { name: 'cx', type: 'codex', agentType: 'codex', promptRecipe: { intents: null, extraArgs: [] }, _dead: false, _compactContinuation: 'go on' };
  h.m.sessions.set('cx', cx);
  h.persisted.set('cx', { name: 'cx', type: 'codex', cwd: os.tmpdir(), sessionId: 'sid-codex' });
  writeCache(root, 'cx', 'session', 'old');
  h.m._fireCompactContinuation(cx);
  await settle(h, 0);
  assert.strictEqual(h.spawns.length, 0);
  assert.deepStrictEqual(h.refreshes, [['cx', 'compact']]);
  assert.deepStrictEqual(h.typed, ['go on']);
  try {
    const s = await spawn(h, 'rx');
    moveTruth(h);
    s.promptRecipe = null;
    h.m._handleContextIntent(s, 'compact', 'go on');
    landSummary(h, 'rx');
    await settle(h, 1);
    assert.strictEqual(h.spawns.length, 1);
    assert.deepStrictEqual(h.refreshes, [['cx', 'compact'], ['rx', 'compact']]);
    assert.ok(!h.shadow.some((r) => r.type === 'prompt-regen-at-compact'));
  } finally { h.stop('rx'); }
});

test('a second compact, clear or reload while the compact respawn is in flight is dropped', async () => {
  const root = mkTmpRoot('clodex-regen-'), name = 'rx';
  const h = mkManager(root);
  try {
    const s = await spawn(h, name);
    moveTruth(h);
    h.m._handleContextIntent(s, 'compact', 'first');
    landSummary(h, name);
    assert.strictEqual(s._reloadInFlight, true, 'ENTER: the respawn is armed synchronously');
    h.m._handleContextIntent(s, 'compact', 'second');
    h.m._handleContextIntent(s, 'clear', 'third');
    h.m._handleContextIntent(s, 'reload', 'fourth');
    await settle(h, 2);
    assert.strictEqual(h.spawns.length, 2, 'exactly one respawn');
    assert.deepStrictEqual(h.handoffs, ['first']);
    assert.deepStrictEqual(h.typed, ['/compact']);
    for (const sub of ['compact', 'clear', 'reload']) {
      assert.ok(h.msgs.includes(`context ${sub} → dropped (already in flight)`), `${sub} dropped: ${JSON.stringify(h.msgs)}`);
    }
  } finally { h.stop(name); }
});

test('pending means exactly what the staging path would stage: a difference ipcDelta swallows is not pending', async () => {
  const root = mkTmpRoot('clodex-regen-'), name = 'rx';
  const seen = [];
  const h = mkManager(root, { ipcDelta: (a, b) => { seen.push([a, b]); return null; } });
  try {
    await spawn(h, name);
    moveTruth(h);
    assert.strictEqual(h.m._promptDeltaPending(name), false);
    assert.strictEqual(seen.length, 1, 'the predicate asked ipcDelta once');
    assert.notStrictEqual(seen[0][0], seen[0][1], 'ENTER: the two texts differ byte-wise, so a byte compare would have said pending');
    assert.ok(seen[0][1].includes('NEW TEAM BLOCK'));
  } finally { h.stop(name); }
});

after(() => { setImmediate(() => process.exit(0)); });
