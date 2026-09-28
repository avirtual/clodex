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
    seams: { noSeed: true, registryDir: path.join(tmp, 'clodex-home') },
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

const PTY_ENTRY = (name) => ({ name, type: 'claude', cwd: '/tmp', workspaceId: 'default', sessionId: 's-1', io: 'pty' });
const RESTART_TUPLE = (name, io) => [
  name, 'claude', '/tmp', [], 's-1', 'default', null, false, null, [], [], [], [], [], null, [], [], null, null,
  false, false, null, null, null, io, null,
];

test('restartSession after setIo(stream) respawns the seat as a stream seat', async () => {
  const eng = mkEngine();
  eng.stores.persistence.upsert(PTY_ENTRY('io-flip'));
  liveSession(eng, 'io-flip', PTY_ENTRY('io-flip'));
  eng.stores.persistence.setIo('io-flip', 'stream');
  const { seen } = probe(eng);
  const res = await eng.restartSession('io-flip', {}, 'default');
  assert.deepStrictEqual(seen, [RESTART_TUPLE('io-flip', 'stream')]);
  assert.strictEqual(res.io, 'stream');
});

test('a plain restartSession of a pty seat keeps pty', async () => {
  const eng = mkEngine();
  eng.stores.persistence.upsert(PTY_ENTRY('io-keep'));
  liveSession(eng, 'io-keep', PTY_ENTRY('io-keep'));
  const { seen } = probe(eng);
  const res = await eng.restartSession('io-keep', {}, 'default');
  assert.deepStrictEqual(seen, [RESTART_TUPLE('io-keep', 'pty')]);
  assert.strictEqual(res.io, 'pty');
});

test('applySessionArgs with io:stream persists it and the restart spawns a stream seat', async () => {
  const eng = mkEngine();
  eng.stores.persistence.upsert(PTY_ENTRY('io-edit'));
  liveSession(eng, 'io-edit', PTY_ENTRY('io-edit'));
  const { seen } = probe(eng);
  const res = await eng.applySessionArgs('io-edit', { extraArgs: [], restart: true, io: 'stream' }, 'default');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(seen.length, 1, 'ENTER: create() was reached');
  assert.strictEqual(seen[0][24], 'stream');
  assert.strictEqual(res.io, 'stream');
});

test('applySessionArgs with io:stream and no restart persists it for the next restart', async () => {
  const eng = mkEngine();
  eng.stores.persistence.upsert(PTY_ENTRY('io-later'));
  const res = await eng.applySessionArgs('io-later', { extraArgs: [], restart: false, io: 'stream' }, 'default');
  assert.deepStrictEqual(res, { ok: true, restarted: false });
  assert.strictEqual(eng.stores.persistence.get('io-later').io, 'stream');
});

test('applySessionArgs refuses io:stream on a seat whose adapter declares no stream transport and keeps its transport', async () => {
  const eng = mkEngine();
  eng.stores.persistence.upsert({ ...PTY_ENTRY('io-bash'), type: 'bash' });
  await eng.applySessionArgs('io-bash', { extraArgs: [], restart: false, io: 'stream' }, 'default');
  assert.strictEqual(eng.stores.persistence.get('io-bash').io, 'pty');
});

test('t1174: applySessionArgs accepts io:stream on a muse seat', async () => {
  const eng = mkEngine();
  eng.stores.persistence.upsert({ ...PTY_ENTRY('io-muse'), type: 'muse' });
  await eng.applySessionArgs('io-muse', { extraArgs: [], restart: false, io: 'stream' }, 'default');
  assert.strictEqual(eng.stores.persistence.get('io-muse').io, 'stream');
});

test('t1172: applySessionArgs accepts io:stream on a codex seat', async () => {
  const eng = mkEngine();
  eng.stores.persistence.upsert({ ...PTY_ENTRY('io-codex'), type: 'codex' });
  await eng.applySessionArgs('io-codex', { extraArgs: [], restart: false, io: 'stream' }, 'default');
  assert.strictEqual(eng.stores.persistence.get('io-codex').io, 'stream');
});

after(() => { setImmediate(() => process.exit(0)); });
