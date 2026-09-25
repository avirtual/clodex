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
  const events = [];
  const registered = [];
  const records = new Map();
  const fakePty = {
    spawn: (cmd, args, opts) => {
      const rec = { cmd, args, opts, killed: false, data: null, exit: null };
      spawns.push(rec);
      return {
        pid: 4242,
        onData(cb) { rec.data = cb; cb('❯ '); },
        onExit(cb) { rec.exit = cb; },
        write(d) { writes.push(d); events.push(['write', d]); },
        resize(c, r) { events.push(['resize', c, r]); setImmediate(() => { events.push(['paint']); if (rec.data) rec.data('❯ '); }); },
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
    getPersistence: () => ({
      list: () => [...records.values()],
      get: (n) => records.get(n) || null,
      setVoice: (n, mode) => { records.set(n, { ...(records.get(n) || { name: n }), voice: mode }); return true; },
    }),
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
  m.voiceEngineTimings = () => ({ bootSettleMs: 0, bootMaxMs: 50, repaintMaxMs: 50 });
  m.sessions.set('st', { name: 'st', type: 'claude', agentType: 'claude', io: 'stream', cwd: '/proj', workspaceId: 'ws-1', pty: { pid: 1 }, activityState: 'idle' });
  m.sessions.set('tt', { name: 'tt', type: 'claude', agentType: 'claude', io: 'pty', cwd: '/proj', workspaceId: 'ws-1', pty: { pid: 2 }, activityState: 'idle' });
  const setVoice = (n, mode) => records.set(n, { ...(records.get(n) || { name: n }), voice: mode });
  return { m, spawns, writes, events, registered, wireCalls, home, userData, setVoice };
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

test('voiceRecord writes the recorder key for a tap seat', async () => {
  const h = managerFixture();
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

test('a stop sent while the engine boots ends stopped: voiceRecord runs in order', async () => {
  const h = managerFixture();
  const start = h.m.voiceRecord('st', 'start');
  for (let i = 0; i < 50 && !h.m._voiceEngine; i++) await Promise.resolve();
  assert.ok(h.m._voiceEngine, 'the engine is assigned before it is ready');
  const stop = h.m.voiceRecord('st', 'stop');
  const [a, b] = await Promise.all([start, stop]);
  assert.equal(a.recording, true);
  assert.equal(b.recording, false);
  assert.deepEqual(h.writes, [' ', ' ']);
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
  assert.deepEqual(h.events.filter((e) => e[0] === 'resize'), [], 'the first armer saw the engine from spawn');
  got['ws-1'].length = 0;
  h.events.length = 0;
  await h.m.voiceRecord('st2', 'toggle', { mode: 'tap' });
  assert.deepEqual(h.events, [['resize', 121, 30], ['paint'], ['resize', 120, 30], ['paint'], ['write', ' ']],
    'a new workspace gets a full repaint before the record key');
  h.spawns[0].data('two');
  assert.deepEqual(got['ws-1'], []);
  assert.deepEqual(got['ws-2'], [
    ['pty-data', VOICE_ENGINE_NAME, '❯ '], ['pty-data', VOICE_ENGINE_NAME, '❯ '], ['pty-data', VOICE_ENGINE_NAME, 'two'],
  ]);
  h.events.length = 0;
  await h.m.voiceRecord('st2', 'toggle', { mode: 'tap' });
  assert.deepEqual(h.events, [['write', ' ']], 'a same-workspace re-arm does not repaint');
  h.m.killVoiceEngine();
});

test('planRecord: tap toggles with one key and there is no hold arm', () => {
  assert.deepEqual(planRecord({ mode: 'tap', action: 'toggle', recording: false }), { write: true, recording: true });
  assert.deepEqual(planRecord({ mode: 'tap', action: 'toggle', recording: true }), { write: true, recording: false });
  assert.deepEqual(planRecord({ mode: 'tap', action: 'start', recording: false }), { write: true, recording: true });
  assert.deepEqual(planRecord({ mode: 'tap', action: 'start', recording: true }), { write: false, recording: true });
  assert.deepEqual(planRecord({ mode: 'tap', action: 'stop', recording: true }), { write: true, recording: false });
  assert.deepEqual(planRecord({ mode: 'tap', action: 'stop', recording: false }), { write: false, recording: false });
  assert.equal(planRecord({ mode: 'hold', action: 'start', recording: false }), null);
  assert.equal(planRecord({ mode: 'off', action: 'toggle' }), null);
  assert.equal(planRecord({ mode: 'tap', action: 'send' }), null);
});

test('engineArgs takes no mode and always asks for the tap recorder', () => {
  assert.equal(engineArgs.length, 1);
  const args = engineArgs('http://127.0.0.1:1/agent/x/tok');
  assert.equal(args[0], '--settings');
  assert.match(args[1], /"voice":\{"mode":"tap"\}/);
  assert.deepEqual(engineArgs('http://127.0.0.1:1/agent/x/tok', 'hold'), args);
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
    surfaceOfSender: () => 'desktop',
    workspaceOfSender: () => 'ws-1',
    log: { info() {}, error() {}, warn() {} },
  });
  return { calls, record: (...a) => handlers.get('voice:record')({}, ...a) };
}

test('voice:record passes a pty seat and a stream seat alike, carrying no mode of its own', async () => {
  const f = ipcFixture();
  const bad = await f.record('st', 'send');
  assert.equal(bad.ok, false);
  assert.deepEqual(f.calls, []);
  await f.record('tt', 'toggle');
  await f.record('st', 'toggle');
  assert.deepEqual(f.calls, [
    ['tt', 'toggle', { workspaceId: 'ws-1', observed: null }],
    ['st', 'toggle', { workspaceId: 'ws-1', observed: null }],
  ]);
  await f.record('st', 'start', { recording: 1, processing: true, extra: 'x' });
  assert.deepEqual(f.calls[2], ['st', 'start', { workspaceId: 'ws-1', observed: { recording: false, processing: true, text: false } }]);
  await f.record('st', 'start', { recording: false, processing: false, text: true });
  assert.deepEqual(f.calls[3], ['st', 'start', { workspaceId: 'ws-1', observed: { recording: false, processing: false, text: true } }]);
  await f.record('st', 'start', { text: 'yes' });
  assert.deepEqual(f.calls[4], ['st', 'start', { workspaceId: 'ws-1', observed: { recording: false, processing: false, text: false } }]);
});

test('voiceRecord on an OFF seat writes nothing, spawns nothing and refuses', async () => {
  const h = managerFixture();
  h.setVoice('st', 'off');
  const off = await h.m.voiceRecord('st', 'toggle', { workspaceId: 'ws-1' });
  assert.deepStrictEqual(off, { ok: false, error: 'voice is off for this seat' });
  assert.equal(h.spawns.length, 0);
  assert.deepEqual(h.writes, []);
});

test('a tap on a codex pty seat spawns the engine with the tap mode in its inline settings', async () => {
  const h = managerFixture();
  h.m.sessions.set('cx', { name: 'cx', type: 'codex', agentType: 'codex', io: 'pty', cwd: '/proj', workspaceId: 'ws-1', pty: { pid: 5 }, activityState: 'idle' });
  const on = await h.m.voiceRecord('cx', 'toggle', { workspaceId: 'ws-1' });
  assert.deepStrictEqual(on, { ok: true, recording: true, engine: VOICE_ENGINE_NAME });
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].args[0], '--settings');
  assert.deepStrictEqual(JSON.parse(h.spawns[0].args[1]), {
    env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:1/agent/${VOICE_ENGINE_NAME}/tok/anthropic` },
    voice: { mode: 'tap' },
    voiceEnabled: true,
  });
  assert.deepEqual(h.writes, [' ']);
  h.m.killVoiceEngine();
});

test('a seat persisted as hold arms the one tap engine without a respawn', async () => {
  const h = managerFixture();
  h.m.sessions.set('hd', { name: 'hd', type: 'bash', io: 'pty', cwd: '/proj', workspaceId: 'ws-1', pty: { pid: 6 }, activityState: 'idle' });
  h.setVoice('hd', 'hold');
  await h.m.voiceRecord('st', 'toggle', { workspaceId: 'ws-1' });
  await h.m.voiceRecord('st', 'toggle', { workspaceId: 'ws-1' });
  const start = await h.m.voiceRecord('hd', 'start', { workspaceId: 'ws-1' });
  assert.equal(start.recording, true);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].killed, false);
  assert.deepEqual(h.writes, [' ', ' ', ' ']);
  h.m.killVoiceEngine();
});

function resyncFixture() {
  const h = managerFixture();
  const logs = [];
  h.m._shadowLog = (r) => logs.push(r);
  const got = [];
  h.m.windows.set('ws-1', { isDestroyed: () => false, webContents: { send: (...a) => got.push(a) } });
  const tap = (action, observed) => h.m.voiceRecord('st', action, { mode: 'tap', workspaceId: 'ws-1', observed });
  return { ...h, logs, got, tap };
}

test('a lit recorder the tracked state missed is reconciled: start writes nothing and reports recording', async () => {
  const h = resyncFixture();
  await h.tap('stop', null);
  const res = await h.tap('start', { recording: true, processing: false });
  assert.deepEqual(res, { ok: true, recording: true, engine: VOICE_ENGINE_NAME });
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.logs, [{ type: 'voice-engine-resync', agent: 'st', tracked: false, observed: true }]);
  h.m.killVoiceEngine();
});

test('a recorder the CLI stopped on its own: the next toggle starts it rather than stopping a dark one', async () => {
  const h = resyncFixture();
  await h.tap('start', null);
  assert.deepEqual(h.writes, [' ']);
  assert.equal(h.m._voiceEngine.recording, true);
  const res = await h.tap('toggle', { recording: false, processing: false });
  assert.deepEqual(res, { ok: true, recording: true, engine: VOICE_ENGINE_NAME });
  assert.deepEqual(h.writes, [' ', ' ']);
  assert.deepEqual(h.logs, [{ type: 'voice-engine-resync', agent: 'st', tracked: true, observed: false }]);
  h.m.killVoiceEngine();
});

test('a start over a row still holding text clears it with Ctrl-U before the record key', async () => {
  const h = resyncFixture();
  await h.tap('stop', null);
  const res = await h.tap('start', { recording: false, processing: false, text: true });
  assert.deepEqual(res, { ok: true, recording: true, engine: VOICE_ENGINE_NAME });
  assert.deepEqual(h.writes, ['\x15', ' ']);
  h.m.killVoiceEngine();
});

test('a start over an empty row writes only the record key', async () => {
  const h = resyncFixture();
  await h.tap('stop', null);
  await h.tap('start', { recording: false, processing: false, text: false });
  assert.deepEqual(h.writes, [' ']);
  h.m.killVoiceEngine();
});

test('a stop never clears the row, even when it holds text', async () => {
  const h = resyncFixture();
  await h.tap('stop', null);
  await h.tap('start', { recording: false, processing: false, text: false });
  await h.tap('stop', { recording: true, processing: false, text: true });
  assert.deepEqual(h.writes, [' ', ' ']);
  h.m.killVoiceEngine();
});

test('a tap while the recorder is still transcribing writes nothing and is refused', async () => {
  const h = resyncFixture();
  await h.tap('stop', null);
  const res = await h.tap('start', { recording: false, processing: true });
  assert.deepEqual(res, { ok: false, error: 'the recorder is still transcribing' });
  assert.deepEqual(h.writes, []);
  h.m.killVoiceEngine();
});

test('a tap that spawns the engine ignores the screen the window kept from a dead one', async () => {
  const h = resyncFixture();
  const lit = await h.tap('start', { recording: true, processing: false });
  assert.deepEqual(lit, { ok: true, recording: true, engine: VOICE_ENGINE_NAME });
  assert.deepEqual(h.writes, [' ']);
  h.m.killVoiceEngine();
  h.writes.length = 0;
  const busy = await h.tap('start', { recording: false, processing: true });
  assert.equal(busy.ok, true);
  assert.deepEqual(h.writes, [' ']);
  assert.deepEqual(h.logs, []);
  h.m.killVoiceEngine();
});

test('a spawn clears the arming window copy of the engine screen before the first chunk', async () => {
  const h = resyncFixture();
  await h.tap('stop', null);
  const data = h.got.filter((a) => a[0] === 'pty-data');
  assert.deepEqual(data[0], ['pty-data', VOICE_ENGINE_NAME, '\x1b[H\x1b[2J\x1b[3J']);
  assert.ok(data.length > 1);
  assert.ok(data.slice(1).every((a) => a[2] !== data[0][2]));
  h.m.killVoiceEngine();
});

test('the engine screen saying no speech ends a tracked recording and tells the arming window once', async () => {
  const h = resyncFixture();
  await h.tap('start', null);
  h.got.length = 0;
  h.spawns[0].data('No speech detected');
  assert.equal(h.m._voiceEngine.recording, false);
  assert.deepEqual(h.got.filter((a) => a[0] !== 'pty-data'), [['voice-engine-stopped', 'st']]);
  h.spawns[0].data('No speech detected');
  h.spawns[0].data('Voice: processing');
  assert.deepEqual(h.got.filter((a) => a[0] !== 'pty-data'), [['voice-engine-stopped', 'st']]);
  h.m.killVoiceEngine();
});
