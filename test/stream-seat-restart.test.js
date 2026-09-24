'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createEngine } = require('../engine');
const { mkTmpRoot } = require('./lib/tmp-roots');

function mkEngine() {
  const tmp = mkTmpRoot('clx-stream-restart-');
  return createEngine({
    userDataPath: tmp,
    seams: { registryDir: path.join(tmp, 'clodex-home') },
    log: { info() {}, warn() {}, error() {} },
  });
}

function liveSession(eng, name, entry) {
  const s = {
    name,
    type: entry.type,
    cwd: entry.cwd,
    workspaceId: 'default',
    agentType: null,
    pty: { pid: -1, kill() { eng.manager.sessions.delete(name); } },
  };
  eng.manager.sessions.set(name, s);
  return s;
}

function probe(eng) {
  const seen = [];
  const removals = [];
  const persistence = eng.stores.persistence;
  const origRemove = persistence.remove.bind(persistence);
  persistence.remove = (n) => { origRemove(n); removals.push({ name: n, recordAfter: persistence.get(n) }); };
  eng.manager.create = async (...args) => {
    seen.push(args);
    return { name: args[0], backend: null, ...(args[24] === 'stream' ? { io: 'stream' } : {}) };
  };
  return { seen, removals };
}

function entryOf(name) {
  return { name, type: 'claude', cwd: '/tmp', workspaceId: 'default', sessionId: 's-1', io: 'stream', fixFor: 'peer-a' };
}

for (const [label, run] of [
  ['restartSession', (eng, n) => eng.restartSession(n, {}, 'default')],
  ['applySessionArgs restart', (eng, n) => eng.applySessionArgs(n, { extraArgs: ['--x'], restart: true }, 'default')],
]) {
  test(`${label} carries io:'stream' and fixFor through to create()`, async () => {
    const eng = mkEngine();
    const name = `st-${label.length}`;
    eng.stores.persistence.upsert(entryOf(name));
    liveSession(eng, name, entryOf(name));
    const { seen, removals } = probe(eng);

    const res = await run(eng, name);
    assert.strictEqual(res.ok, true, `${label} succeeded`);
    assert.deepStrictEqual(removals.map((r) => [r.name, r.recordAfter]), [[name, null]],
      'ENTER: kill() removed the record, so create() cannot read io from persistence');
    assert.strictEqual(seen.length, 1, 'ENTER: create() was reached');
    assert.deepStrictEqual([seen[0][23], seen[0][24]], ['peer-a', 'stream'],
      `${label} must pass fixFor and io as create()'s 24th and 25th positionals, or a stream seat restarts as a pty seat`);
    assert.strictEqual(res.io, 'stream',
      `${label} must return io so the renderer rebuilds a stream pane, not an xterm, over the restarted seat`);
  });
}

after(() => { setImmediate(() => process.exit(0)); });
