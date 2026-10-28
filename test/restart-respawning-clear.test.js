'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createEngine } = require('./lib/engine-isolation');
const { mkTmpRoot } = require('./lib/tmp-roots');

function mkEngine() {
  const tmp = mkTmpRoot('clx-respawning-');
  return createEngine({
    userDataPath: tmp,
    seams: { noSeed: true, registryDir: path.join(tmp, 'clodex-home') },
    log: { info() {}, warn() {}, error() {} },
  });
}

function stuckSession(eng, name) {
  const s = {
    name, type: 'bash', cwd: '/tmp', workspaceId: 'default', agentType: null,
    pty: { pid: -1, kill() { s._dead = true; } },
  };
  eng.manager.sessions.set(name, s);
  return s;
}

async function drive(t, run) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let done = false;
  const p = run().finally(() => { done = true; });
  for (let i = 0; i < 200 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(100);
  }
  return p;
}

for (const [label, run] of [
  ['restartSession', (eng) => eng.restartSession('a', {}, 'default')],
  ['applySessionArgs', (eng) => eng.applySessionArgs('a', { restart: true, extraArgs: [] }, 'default')],
]) {
  test(`${label}: a timed-out exit wait clears _respawning on the live seat`, async (t) => {
    const eng = mkEngine();
    eng.stores.persistence.upsert({ name: 'a', type: 'bash', cwd: '/tmp', workspaceId: 'default', sessionId: 's-1' });
    const s = stuckSession(eng, 'a');
    let respawningAtKill = null;
    const kill = eng.manager.kill.bind(eng.manager);
    eng.manager.kill = async (...args) => { await kill(...args); respawningAtKill = s._respawning; };
    const res = await drive(t, () => run(eng));
    assert.strictEqual(respawningAtKill, true, 'ENTER: kill({ respawn: true }) marked the seat');
    assert.match(res.error, /old process did not exit in time/);
    assert.strictEqual(eng.manager.sessions.get('a'), s, 'ENTER: the old seat is still live');
    assert.strictEqual(s._respawning, false);
  });
}
