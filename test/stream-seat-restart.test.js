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

const MODEL_ENTRY = (name, io = 'stream') => ({ name, type: 'claude', cwd: '/tmp', workspaceId: 'default', sessionId: 's-1', io, extraArgs: ['--model', 'claude-haiku-4-5', '--verbose'] });
const DIALOG_PATCH = (extraArgs, extra = {}) => ({
  extraArgs, restart: true, proxy: null, systemPrompt: undefined, agents: [], denyBuiltins: [], disabledTools: [],
  disabledSkills: [], injectSkills: [], systemPromptFile: null, appendPromptFiles: [], intents: undefined,
  execCommands: [], env: {}, plugins: undefined, io: 'stream', effort: undefined, ...extra,
});

function modelSeat(name, reply, io = 'stream', spawnRecord = true) {
  const eng = mkEngine();
  eng.stores.persistence.upsert(MODEL_ENTRY(name, io));
  Object.assign(liveSession(eng, name, MODEL_ENTRY(name, io)), { io, _spawnRecord: spawnRecord ? eng.stores.persistence.get(name) : undefined });
  const { seen } = probe(eng);
  const calls = { setModel: [], kill: 0 };
  eng.manager.seatSetModel = async (n, model) => { calls.setModel.push([n, model]); return reply; };
  const kill = eng.manager.kill.bind(eng.manager);
  eng.manager.kill = (...a) => { calls.kill += 1; return kill(...a); };
  return { eng, seen, calls };
}

test('t1493: a model-only change on a live claude stream seat switches it with set_model, no respawn, and persists on ok', async () => {
  const { eng, seen, calls } = modelSeat('sm-ok', { ok: true });
  const res = await eng.applySessionArgs('sm-ok', DIALOG_PATCH(['--model', 'claude-sonnet-4-6', '--verbose']), 'default');
  assert.deepStrictEqual(res, { ok: true, restarted: false, modelSwitched: true });
  assert.deepStrictEqual(calls.setModel, [['sm-ok', 'claude-sonnet-4-6']]);
  assert.strictEqual(calls.kill, 0);
  assert.strictEqual(seen.length, 0);
  assert.deepStrictEqual(eng.stores.persistence.get('sm-ok').extraArgs, ['--model', 'claude-sonnet-4-6', '--verbose']);
});

test('t1493: a set_model the CLI rejects persists nothing and returns its error', async () => {
  const { eng, seen, calls } = modelSeat('sm-err', { ok: false, error: "Model 'claude-nope-1' not found", errorCode: 'catalog_unknown' });
  const res = await eng.applySessionArgs('sm-err', DIALOG_PATCH(['--model', 'claude-nope-1', '--verbose']), 'default');
  assert.deepStrictEqual(res, { ok: false, error: "Model 'claude-nope-1' not found" });
  assert.strictEqual(calls.kill + seen.length, 0);
  assert.deepStrictEqual(eng.stores.persistence.get('sm-err').extraArgs, ['--model', 'claude-haiku-4-5', '--verbose']);
});

for (const [label, patch, io] of [
  ['a model plus another arg', DIALOG_PATCH(['--model', 'claude-sonnet-4-6']), 'stream'],
  ['a model plus another field', DIALOG_PATCH(['--model', 'claude-sonnet-4-6', '--verbose'], { disabledTools: ['WebFetch'] }), 'stream'],
  ['a model-only change on a pty seat', DIALOG_PATCH(['--model', 'claude-sonnet-4-6', '--verbose'], { io: 'pty' }), 'pty'],
]) {
  test(`t1493: ${label} still respawns`, async () => {
    const { eng, seen, calls } = modelSeat(`sm-${label.length}`, { ok: true }, io);
    const res = await eng.applySessionArgs(`sm-${label.length}`, patch, 'default');
    assert.strictEqual(res.restarted, true);
    assert.deepStrictEqual(calls.setModel, []);
    assert.strictEqual(seen.length, 1);
  });
}

test('t1493: a model-only restart save over settings saved without a restart still respawns', async () => {
  const { eng, seen, calls } = modelSeat('sm-pend', { ok: true });
  await eng.applySessionArgs('sm-pend', DIALOG_PATCH(['--model', 'claude-haiku-4-5', '--verbose'], { disabledTools: ['Bash'], restart: false }), 'default');
  assert.strictEqual(seen.length, 0, 'ENTER: the first save did not restart');
  const res = await eng.applySessionArgs('sm-pend', DIALOG_PATCH(['--model', 'claude-sonnet-4-6', '--verbose'], { disabledTools: ['Bash'] }), 'default');
  assert.strictEqual(res.restarted, true);
  assert.deepStrictEqual(calls.setModel, []);
  assert.strictEqual(seen.length, 1);
});

test('t1493: a live seat with no spawn record respawns on a model-only change', async () => {
  const { eng, seen, calls } = modelSeat('sm-nosnap', { ok: true }, 'stream', false);
  const res = await eng.applySessionArgs('sm-nosnap', DIALOG_PATCH(['--model', 'claude-sonnet-4-6', '--verbose']), 'default');
  assert.strictEqual(res.restarted, true);
  assert.deepStrictEqual(calls.setModel, []);
  assert.strictEqual(seen.length, 1);
});

test('t1493: switching back to the spawn model after an in-place switch is switched in place too', async () => {
  const { eng, seen, calls } = modelSeat('sm-back', { ok: true });
  await eng.applySessionArgs('sm-back', DIALOG_PATCH(['--model', 'claude-sonnet-4-6', '--verbose']), 'default');
  const res = await eng.applySessionArgs('sm-back', DIALOG_PATCH(['--model', 'claude-haiku-4-5', '--verbose']), 'default');
  assert.deepStrictEqual(res, { ok: true, restarted: false, modelSwitched: true });
  assert.deepStrictEqual(calls.setModel, [['sm-back', 'claude-sonnet-4-6'], ['sm-back', 'claude-haiku-4-5']]);
  assert.strictEqual(seen.length, 0);
});

test('t1493: a peer model-only save that omits env respawns when the saved env differs from the spawned one', async () => {
  const { eng, seen, calls } = modelSeat('sm-peer', { ok: true });
  eng.stores.persistence.setEnv('sm-peer', { FOO: 'bar' });
  const peer = DIALOG_PATCH(['--model', 'claude-sonnet-4-6', '--verbose']);
  delete peer.env; delete peer.execCommands; delete peer.plugins;
  const res = await eng.applySessionArgs('sm-peer', peer, 'default');
  assert.strictEqual(res.restarted, true);
  assert.deepStrictEqual(calls.setModel, []);
  assert.strictEqual(seen.length, 1);
});

test('t1493: a model-only restart save on a stream seat whose saved io went pty without a restart respawns', async () => {
  const { eng, seen, calls } = modelSeat('sm-io', { ok: true });
  await eng.applySessionArgs('sm-io', DIALOG_PATCH(['--model', 'claude-haiku-4-5', '--verbose'], { io: 'pty', restart: false }), 'default');
  assert.strictEqual(eng.stores.persistence.get('sm-io').io, 'pty', 'ENTER: the first save moved the saved io without a restart');
  const res = await eng.applySessionArgs('sm-io', DIALOG_PATCH(['--model', 'claude-sonnet-4-6', '--verbose'], { io: 'pty' }), 'default');
  assert.strictEqual(res.restarted, true);
  assert.deepStrictEqual(calls.setModel, []);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0][24], 'pty');
});
