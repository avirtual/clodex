'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { WireProxy } = require('../wire/proxy');
const { createSessionManager } = require('../session-manager');
const { registerIpcHandlers } = require('../ipc-handlers');
const { VOICE_ENGINE_NAME, planRecord, engineArgs } = require('../voice-engine');
const { mkTmpRoot } = require('./lib/tmp-roots');

function post(base, pathname, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + pathname);
    const req = http.request(u, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: data }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function wireFixture() {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(500);
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const w = new WireProxy({ upstreams: { anthropic: `http://127.0.0.1:${upstream.address().port}` } });
  await w.listen();
  const close = async () => {
    await w.close();
    await new Promise((r) => upstream.close(r));
  };
  return { w, hits, close };
}

test('a voiceSink seat is answered by the wire and nothing is forwarded upstream', async () => {
  const f = await wireFixture();
  try {
    const base = f.w.registerAgent('eng', { voiceSink: true });
    const streamed = await post(base, '/anthropic/v1/messages', { model: 'm1', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(streamed.status, 200);
    assert.match(streamed.type, /text\/event-stream/);
    assert.match(streamed.body, /event: message_start/);
    assert.match(streamed.body, /"stop_reason":"end_turn"/);
    assert.match(streamed.body, /event: message_stop/);
    const plain = await post(base, '/anthropic/v1/messages', { model: 'm1', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(plain.status, 200);
    const msg = JSON.parse(plain.body);
    assert.equal(msg.role, 'assistant');
    assert.deepEqual(msg.content, [{ type: 'text', text: '' }]);
    const counted = await post(base, '/anthropic/v1/messages/count_tokens', { model: 'm1', messages: [] });
    assert.deepEqual(JSON.parse(counted.body), { input_tokens: 0 });
    assert.deepEqual(f.hits, [], 'no request reached the upstream');
    const other = f.w.registerAgent('seat', {});
    await post(other, '/anthropic/v1/messages', { model: 'm1', messages: [] });
    assert.equal(f.hits.length, 1, 'a seat without the flag still forwards');
    f.w.unregisterAgent('eng');
    const again = f.w.registerAgent('eng', {});
    await post(again, '/anthropic/v1/messages', { model: 'm1', messages: [] });
    assert.equal(f.hits.length, 2, 'unregister drops the sink flag');
  } finally {
    await f.close();
  }
});

function managerFixture() {
  const root = mkTmpRoot('voice-engine-');
  const home = path.join(root, 'home');
  const userData = path.join(root, 'userData');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  const spawns = [];
  const writes = [];
  const registered = [];
  const fakePty = {
    spawn: (cmd, args, opts) => {
      const rec = { cmd, args, opts, killed: false, data: null, exit: null };
      spawns.push(rec);
      return {
        pid: 4242,
        onData(cb) { rec.data = cb; cb('❯ '); },
        onExit(cb) { rec.exit = cb; },
        write(d) { writes.push(d); },
        kill() { rec.killed = true; },
      };
    },
  };
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    WIRE_SHADOW: true,
    fs, path,
    os: { ...os, homedir: () => home },
    pty: fakePty,
    getUserDataPath: () => userData,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    registry: { register: (n) => registered.push(n), unregister: () => {}, listPeers: () => [] },
    notifyOS: () => {},
    setAppQuitting: () => {},
    log: { info() {}, warn() {}, error() {}, debug() {} },
    countPending: () => 0,
    resolveTeam: () => null,
    findProjectRoot: () => null,
  });
  const m = new SessionManager();
  const wireCalls = [];
  m._wire = {
    registerAgent: (name, opts) => { wireCalls.push(['register', name, opts]); return `http://127.0.0.1:1/agent/${name}/tok`; },
    unregisterAgent: (name) => wireCalls.push(['unregister', name]),
  };
  m._broadcast = () => {};
  m.voiceEngineTimings = () => ({ holdRepeatMs: 1, holdMaxMs: 1000, bootSettleMs: 0, bootMaxMs: 50 });
  m.sessions.set('st', { name: 'st', type: 'claude', agentType: 'claude', io: 'stream', cwd: '/proj', workspaceId: 'ws-1', pty: { pid: 1 }, activityState: 'idle' });
  m.sessions.set('tt', { name: 'tt', type: 'claude', agentType: 'claude', io: 'pty', cwd: '/proj', workspaceId: 'ws-1', pty: { pid: 2 }, activityState: 'idle' });
  return { m, spawns, writes, registered, wireCalls, home, userData };
}

test('the voice engine is a private claude pty: wire-sunk, never listed, never registered', async () => {
  const h = managerFixture();
  const engine = await h.m.ensureVoiceEngine();
  assert.equal(engine.name, VOICE_ENGINE_NAME);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].cmd, 'claude');
  assert.equal(h.spawns[0].opts.cwd, h.userData);
  assert.deepEqual(h.spawns[0].args, engineArgs(`http://127.0.0.1:1/agent/${VOICE_ENGINE_NAME}/tok`));
  assert.deepEqual(h.wireCalls[0], ['register', VOICE_ENGINE_NAME, { voiceSink: true }]);
  assert.equal(h.m.sessions.has(VOICE_ENGINE_NAME), false);
  assert.ok(!h.m.list().some((r) => r.name === VOICE_ENGINE_NAME), 'absent from list()');
  assert.ok(!h.m._teamLiveSeatNames('/proj').includes(VOICE_ENGINE_NAME), 'absent from the roster');
  assert.deepEqual(h.registered, [], 'no registry record, so no socket and no [agent:who] row');
  const trusted = JSON.parse(fs.readFileSync(path.join(h.home, '.claude.json'), 'utf8'));
  assert.equal(trusted.projects[h.userData].hasTrustDialogAccepted, true);
  assert.equal(await h.m.ensureVoiceEngine(), engine, 'one engine per box');
  assert.equal(h.spawns.length, 1);
  await h.m.killAll();
  assert.equal(h.spawns[0].killed, true, 'killed on quit');
  assert.deepEqual(h.wireCalls.at(-1), ['unregister', VOICE_ENGINE_NAME]);
});

test('voiceRecord writes the recorder key for a stream seat and refuses a terminal seat', async () => {
  const h = managerFixture();
  const refused = await h.m.voiceRecord('tt', 'toggle', { mode: 'tap' });
  assert.equal(refused.ok, false);
  assert.equal(h.spawns.length, 0, 'a refusal spawns nothing');
  const off = await h.m.voiceRecord('st', 'toggle', { mode: 'off' });
  assert.equal(off.ok, false);
  assert.equal(h.spawns.length, 0);
  const on = await h.m.voiceRecord('st', 'toggle', { mode: 'tap', workspaceId: 'ws-1' });
  assert.deepEqual(on, { ok: true, recording: true, engine: VOICE_ENGINE_NAME });
  assert.deepEqual(h.writes, [' ']);
  assert.deepEqual(h.m._voiceEngine.armedBy, { name: 'st', workspaceId: 'ws-1' });
  const stop = await h.m.voiceRecord('st', 'stop', { mode: 'tap' });
  assert.equal(stop.recording, false);
  assert.deepEqual(h.writes, [' ', ' ']);
  const idle = await h.m.voiceRecord('st', 'stop', { mode: 'tap' });
  assert.equal(idle.recording, false);
  assert.deepEqual(h.writes, [' ', ' '], 'stopping a stopped recorder writes nothing');
  h.m.killVoiceEngine();
});

test('a hold released while the engine boots ends stopped: voiceRecord runs in order', async () => {
  const h = managerFixture();
  const start = h.m.voiceRecord('st', 'start', { mode: 'hold' });
  for (let i = 0; i < 50 && !h.m._voiceEngine; i++) await Promise.resolve();
  assert.ok(h.m._voiceEngine, 'the engine is assigned before it is ready');
  const stop = h.m.voiceRecord('st', 'stop', { mode: 'hold' });
  const [a, b] = await Promise.all([start, stop]);
  assert.equal(a.recording, true);
  assert.equal(b.recording, false);
  assert.equal(h.m._voiceEngine.holdTimer, null);
  assert.equal(h.m._voiceEngine.recording, false);
  h.m.killVoiceEngine();
});

test('engine output reaches only the window of the workspace that armed it', async () => {
  const h = managerFixture();
  const got = { 'ws-1': [], 'ws-2': [] };
  const win = (ws) => ({ isDestroyed: () => false, webContents: { send: (...a) => got[ws].push(a) } });
  h.m.windows.set('ws-1', win('ws-1'));
  h.m.windows.set('ws-2', win('ws-2'));
  h.m.sessions.set('st2', { name: 'st2', type: 'claude', agentType: 'claude', io: 'stream', cwd: '/proj', workspaceId: 'ws-2', pty: { pid: 3 }, activityState: 'idle' });
  await h.m.voiceRecord('st', 'toggle', { mode: 'tap' });
  h.spawns[0].data('one');
  await h.m.voiceRecord('st', 'toggle', { mode: 'tap' });
  got['ws-1'].length = 0;
  await h.m.voiceRecord('st2', 'toggle', { mode: 'tap' });
  h.spawns[0].data('two');
  assert.deepEqual(got['ws-1'], []);
  assert.deepEqual(got['ws-2'], [['pty-data', VOICE_ENGINE_NAME, 'two']]);
  h.m.killVoiceEngine();
});

test('planRecord: tap toggles with one key, hold starts and stops a repeat', () => {
  assert.deepEqual(planRecord({ mode: 'tap', action: 'toggle', recording: false }), { write: true, hold: null, recording: true });
  assert.deepEqual(planRecord({ mode: 'tap', action: 'start', recording: true }), { write: false, hold: null, recording: true });
  assert.deepEqual(planRecord({ mode: 'hold', action: 'start', recording: false }), { write: false, hold: 'start', recording: true });
  assert.deepEqual(planRecord({ mode: 'hold', action: 'stop', recording: true }), { write: false, hold: 'stop', recording: false });
  assert.equal(planRecord({ mode: 'off', action: 'toggle' }), null);
  assert.equal(planRecord({ mode: 'tap', action: 'send' }), null);
});

function ipcFixture() {
  const handlers = new Map();
  const calls = [];
  const manager = {
    sessions: new Map([
      ['st', { name: 'st', workspaceId: 'ws-1', io: 'stream' }],
      ['tt', { name: 'tt', workspaceId: 'ws-1', io: 'pty' }],
    ]),
    voiceRecord: (...a) => { calls.push(a); return { ok: true, recording: true }; },
  };
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    manager,
    readVoiceMode: () => ({ effective: 'tap' }),
    surfaceOfSender: () => 'desktop',
    workspaceOfSender: () => 'ws-1',
    log: { info() {}, error() {}, warn() {} },
  });
  return { calls, record: (...a) => handlers.get('voice:record')({}, ...a) };
}

test('voice:record refuses a pty seat and passes a stream seat with the box-wide mode', async () => {
  const f = ipcFixture();
  const refused = await f.record('tt', 'toggle');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /stream seat/);
  assert.deepEqual(f.calls, []);
  const bad = await f.record('st', 'send');
  assert.equal(bad.ok, false);
  assert.deepEqual(f.calls, []);
  await f.record('st', 'toggle');
  assert.deepEqual(f.calls, [['st', 'toggle', { mode: 'tap', workspaceId: 'ws-1' }]]);
});
