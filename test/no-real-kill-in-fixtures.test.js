'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mk } = require('./lib/session-fixtures');
const { mkManager, spawn } = require('./lib/prompt-regen-fixture');
const { mkTmpRoot } = require('./lib/tmp-roots');

async function realKillsDuring(fn) {
  const realKill = process.kill;
  const seen = [];
  process.kill = (pid, sig) => { seen.push({ pid, sig }); };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await fn();
    mock.timers.tick(6000);
  } finally {
    mock.timers.reset();
    process.kill = realKill;
  }
  return seen;
}

test('session-fixtures mk(): killing a fake-pid seat never reaches the real process.kill', async () => {
  const store = [];
  const m = mk({
    getPersistence: () => ({ list: () => store, get: () => null, remove: () => {} }),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  m._notifyComposition = () => {};
  m.sessions.set('a', { name: 'a', type: 'claude', cwd: '/proj', workspaceId: 'default', agentType: null, pty: { pid: 999, kill() {} } });
  const seen = await realKillsDuring(() => m.kill('a'));
  assert.deepStrictEqual(m.killedPids, [{ pid: 999, sig: 'SIGKILL' }],
    'ENTER: the 5s backstop must have fired into the fixture killPid');
  assert.deepStrictEqual(m.psCalls, ['ps'], 'ENTER: the descendant reap must have read the fixture ps, not the real one');
  assert.deepStrictEqual(h.psCalls, ['ps'], 'ENTER: the descendant reap must have read the fixture ps, not the real one');
  assert.deepStrictEqual(seen, [], 'the fixture let a kill reach the real process.kill');
});

test('prompt-regen-fixture mkManager(): killing a spawned seat never reaches the real process.kill', async () => {
  const root = mkTmpRoot('clodex-no-real-kill-');
  fs.mkdirSync(path.join(root, 'pending'), { recursive: true });
  const h = mkManager(root);
  await spawn(h, 'b');
  h.stop('b');
  const seen = await realKillsDuring(() => h.m.kill('b'));
  assert.deepStrictEqual(h.killed, [{ pid: 999, sig: 'SIGKILL' }],
    'ENTER: the 5s backstop must have fired into the fixture killPid');
  assert.deepStrictEqual(h.psCalls, ['ps'], 'ENTER: the descendant reap must have read the fixture ps, not the real one');
  assert.deepStrictEqual(seen, [], 'the fixture let a kill reach the real process.kill');
});
