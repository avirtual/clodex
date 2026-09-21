'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promptCacheDir, readCache, writeCache } = require('../ipc-prompt-cache');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { mkManager, spawn, bakedBytes, settle, moveTruth } = require('./lib/prompt-regen-fixture');

test('clear with a pending delta on a claude seat: kill+create with no --resume, the body rides the reload handoff, refreshPrompt never fires', async () => {
  const root = mkTmpRoot('clodex-regen-'), name = 'rx';
  const h = mkManager(root);
  try {
    const s = await spawn(h, name);
    const born = bakedBytes(root, name);
    moveTruth(h);
    assert.strictEqual(h.m._promptDeltaPending(name), true, 'ENTER: the moved team block is a pending delta');

    h.m._handleContextIntent(s, 'clear', 'pick up at step 3');
    await settle(h, 2);

    assert.strictEqual(h.spawns.length, 2, 'the clear respawned the CLI');
    assert.ok(!h.spawns[1].args.includes('--resume'), `a fresh bake, not a resume: ${h.spawns[1].args.join(' ')}`);
    assert.ok(!h.typed.includes('/clear'), 'no /clear typed on this path');
    assert.deepStrictEqual(h.handoffs, ['pick up at step 3']);
    assert.strictEqual(h.refreshes.length, 0, 'refreshPrompt(clear) belongs to the typed /clear edge, which this path never produces');
    assert.ok(h.shadow.some((r) => r.type === 'prompt-regen-at-clear' && r.agent === name && r.bytes > 0),
      `shadow row present: ${JSON.stringify(h.shadow)}`);
    assert.ok(h.msgs.includes('context clear → cold respawn (prompt regenerated)'));
    const fresh = bakedBytes(root, name);
    assert.notStrictEqual(fresh, born);
    assert.ok(fresh.includes('NEW TEAM BLOCK'), 'the fresh process boots on the regenerated prompt');
    assert.strictEqual(readCache(root, name, 'session'), fresh, 'bakePrompt(reuse=false) re-baselined session.md');
    assert.strictEqual(readCache(root, name, 'notified'), fresh);
    assert.strictEqual(readCache(root, name, 'delta'), null, 'and nothing is left staged');
    assert.strictEqual(readCache(root, name, 'next'), null);
    assert.strictEqual(h.m._promptDeltaPending(name), false, 'the seat now runs the current prompt');
  } finally { h.stop(name); }
});

test('clear without a pending delta: /clear typed, no kill, no create', async () => {
  const root = mkTmpRoot('clodex-regen-'), name = 'rx';
  const h = mkManager(root);
  try {
    const s = await spawn(h, name);
    assert.strictEqual(h.m._promptDeltaPending(name), false, 'ENTER: nothing moved');

    h.m._handleContextIntent(s, 'clear', 'pick up at step 3');
    await settle(h, 1);

    assert.strictEqual(h.spawns.length, 1, 'no respawn');
    assert.strictEqual(h.m.sessions.get(name), s, 'the live session is untouched');
    assert.deepStrictEqual(h.typed, ['/clear']);
    assert.strictEqual(s._postClearContinuation, 'pick up at step 3', 'the body waits on the sessionId edge as before');
    assert.deepStrictEqual(h.handoffs, []);
    assert.ok(!h.shadow.some((r) => r.type === 'prompt-regen-at-clear'));
  } finally { h.stop(name); }
});

test('body-less clear with a pending delta: respawn, no handoff injected, no /clear typed', async () => {
  const root = mkTmpRoot('clodex-regen-'), name = 'rx';
  const h = mkManager(root);
  try {
    const s = await spawn(h, name);
    moveTruth(h);

    h.m._handleContextIntent(s, 'clear', '');
    await settle(h, 2);

    assert.strictEqual(h.spawns.length, 2, 'the clear respawned the CLI');
    assert.ok(!h.spawns[1].args.includes('--resume'));
    assert.deepStrictEqual(h.handoffs, [], 'no body, no first turn: the seat boots idle');
    assert.deepStrictEqual(h.typed, []);
    assert.strictEqual(h.refreshes.length, 0);
  } finally { h.stop(name); }
});

test('codex seat with anything pending: /clear typed, never a respawn', async () => {
  const root = mkTmpRoot('clodex-regen-'), name = 'cx';
  const h = mkManager(root);
  const s = { name, type: 'codex', agentType: 'codex', promptRecipe: { intents: null, extraArgs: [] }, _dead: false };
  h.m.sessions.set(name, s);
  h.persisted.set(name, { name, type: 'codex', cwd: os.tmpdir() });
  writeCache(root, name, 'delta', 'staged');
  writeCache(root, name, 'session', 'old');
  assert.strictEqual(h.m._promptDeltaPending(name), false, 'ENTER: the predicate is claude-only');

  h.m._handleContextIntent(s, 'clear', 'carry on');
  await settle(h, 0);

  assert.strictEqual(h.spawns.length, 0);
  assert.deepStrictEqual(h.typed, ['/clear']);
  assert.strictEqual(s._postClearContinuation, 'carry on');
  clearTimeout(s._postClearValveTimer);
});

test('a claude seat with no captured recipe or no cache is never pending', async () => {
  const root = mkTmpRoot('clodex-regen-'), name = 'rx';
  const h = mkManager(root);
  try {
    const s = await spawn(h, name);
    moveTruth(h);
    assert.strictEqual(h.m._promptDeltaPending(name), true, 'ENTER');
    const recipe = s.promptRecipe;
    s.promptRecipe = null;
    assert.strictEqual(h.m._promptDeltaPending(name), false, 'no recipe: the second recipe is exactly what refreshPrompt refuses to build');
    s.promptRecipe = recipe;
    fs.unlinkSync(path.join(promptCacheDir(root, name), 'session.md'));
    assert.strictEqual(h.m._promptDeltaPending(name), false, 'no session.md: nothing recorded to compare against');
  } finally { h.stop(name); }
});

test('reload still goes through the same respawn and injects its handoff', async () => {
  const root = mkTmpRoot('clodex-regen-'), name = 'rx';
  const h = mkManager(root);
  try {
    const s = await spawn(h, name);
    h.m._handleContextIntent(s, 'reload', 'briefing');
    await settle(h, 2);
    assert.strictEqual(h.spawns.length, 2);
    assert.ok(!h.spawns[1].args.includes('--resume'));
    assert.deepStrictEqual(h.handoffs, ['briefing']);
    assert.ok(h.msgs.includes('context reload → fresh restart'));
  } finally { h.stop(name); }
});

after(() => { setImmediate(() => process.exit(0)); });
