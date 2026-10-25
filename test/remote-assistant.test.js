'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { createRemoteWiring } = require('../remote-wiring');
const { RemoteServer } = require('../remote');

const HOME = '/h';
const SID = '11111111-1111-4111-8111-111111111111';
const STATS = { model: null, cost: null, requests: null, ctxTok: null, ctxSize: null, ctxPct: null };
const ASLEEP = { name: 'avh-7', class: 'assistant', archivedAt: 1, asleepAt: 2, type: 'claude', cwd: '/w' };

function makeDeps(overrides = {}) {
  let srv = null;
  const records = new Map(Object.entries(overrides.records || {}).map(([k, v]) => [k, { name: k, ...v }]));
  const createCalls = [];
  const spawnCalls = [];
  const wakeCalls = [];
  const sleepCalls = [];
  const destroyCalls = [];
  const killCalls = [];
  const deliverCalls = [];
  const awaitCalls = [];
  const unlinkCalls = [];
  const rmCalls = [];
  const order = [];
  const files = new Map(Object.entries(overrides.files || {}));
  const manager = {
    sessions: new Map(Object.entries(overrides.sessions || {})),
    create: async (...args) => { createCalls.push(args); return { name: args[0], type: args[1], pid: 4242 }; },
    _handleSpawnIntent: (spawner, intent, opts = {}) => {
      spawnCalls.push({ spawner, intent });
      setImmediate(() => opts.onReply(overrides.spawnReply || `ok: spawned "${intent.name}" (claude) @ ${intent.cwd} via template "${intent.template}"`));
    },
    wake: async (name, opts) => {
      wakeCalls.push([name, opts]);
      order.push('wake');
      const out = overrides.wakeOut || { ok: true, state: 'awake' };
      if (out.ok) manager.sessions.set(name, { name, agentType: 'claude', type: 'claude', io: 'stream' });
      return out;
    },
    sleep: async (name, opts) => { sleepCalls.push([name, opts]); return overrides.sleepOut || { ok: true, state: 'asleep' }; },
    destroy: async (name) => { destroyCalls.push(name); records.delete(name); manager.sessions.delete(name); return { ok: true }; },
    kill: async (name) => { killCalls.push(name); },
    awaitTurn: (name, opts) => { awaitCalls.push([name, opts]); return Promise.resolve(overrides.turn === undefined ? null : overrides.turn); },
    _deliverMessage: (...args) => {
      deliverCalls.push({ args, awaitsBefore: awaitCalls.length });
      order.push('deliver');
      if (typeof args[5] === 'function') setImmediate(args[5]);
    },
  };
  const persistence = {
    get: (n) => records.get(n),
    list: () => [...records.values()],
    setStripLevel: () => {},
  };
  const realFs = require('fs');
  const fs = {
    ...realFs,
    readFileSync: (p, enc) => {
      if (files.has(p)) return files.get(p);
      const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
    },
    unlinkSync: (p) => { unlinkCalls.push(p); },
    rmSync: (p, o) => { rmCalls.push([p, o]); },
  };
  const memoryUnits = overrides.units || [];
  const deps = {
    path, fs, os: { ...os, homedir: () => HOME },
    log: { info() {}, error() {}, warn() {} },
    DEFAULT_WORKSPACE_ID: 'default',
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    REGISTRY_DIR: '/tmp/reg', OUTBOX_DIR: '/tmp/outbox', SELF_LABEL: 'testbox',
    parseCtxFile: () => null, jsonlToMessages: () => [], ensureDir: () => {}, homeRelativize: (x) => x,
    claimOutbox: () => [], listOutboxOrigins: () => [],
    manager, proxyPoller: { snapshot: () => null },
    loadManifest: (n) => { throw new Error(`no such team "${n}"`); },
    restartClodex: () => {}, restartSession: () => {}, peerProxyView: () => null,
    readSessionArgs: () => ({ ok: false }), applySessionArgs: () => ({ ok: true }),
    readSkillCatalog: () => ({ ok: false }), applySessionSkills: () => ({ ok: false }),
    fetchProxyContext: () => {}, fetchProxyReport: () => {}, fetchProxyBust: () => {},
    fetchSessionFiles: () => {}, fetchFilePeek: () => {}, fetchFileDiff: () => {},
    CLAUDE_TOOLS: ['Bash'],
    getPromptLibrary: () => ({ list: () => [] }),
    getAgentLibrary: () => ({ list: () => [] }),
    getSkillLibrary: () => ({ list: () => [] }),
    getPersistence: () => persistence,
    getMemoryStore: () => ({ list: (n) => (n === 'avh-7' ? memoryUnits : []) }),
    getUiSettings: () => ({ get: () => ({ remoteEnabled: true, remotePort: 0 }) }),
    getWorkspaces: () => ({ get: () => ({}) }),
    getRemoteServer: () => srv, setRemoteServer: (v) => { srv = v; }, setRemoteError: () => {},
    readRemoteEnvToken: () => null, resolveRemoteToken: (a, b) => a || b || null,
    appVersion: '9.9.9', isPackaged: () => false,
  };
  return {
    deps, manager, records, createCalls, spawnCalls, wakeCalls, sleepCalls, destroyCalls, killCalls,
    deliverCalls, awaitCalls, unlinkCalls, rmCalls, order,
  };
}

function captureOptions(deps) {
  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  let opts = null;
  const notifyCalls = [];
  remoteMod.RemoteServer = function (o) {
    opts = o;
    return { start: () => Promise.resolve(), stop() {}, port: 0, notifySessions() { notifyCalls.push(1); }, setWtermCallbacks() {} };
  };
  try {
    createRemoteWiring(deps).syncRemoteServer();
  } finally {
    remoteMod.RemoteServer = orig;
  }
  opts.notifyCalls = notifyCalls;
  return opts;
}

test('send: a dm to an asleep assistant wakes it, then delivers as the operator tagged with the client', async () => {
  const h = makeDeps({ records: { 'avh-7': ASLEEP } });
  const opts = captureOptions(h.deps);
  assert.ok(!h.manager.sessions.has('avh-7'), 'ENTER: asleep');
  assert.deepStrictEqual(await opts.send('avh-7', 'hi', [], 'avh'), { ok: true });
  assert.deepStrictEqual(h.wakeCalls, [['avh-7', { reason: 'message' }]]);
  assert.deepStrictEqual(h.order, ['wake', 'deliver']);
  assert.deepStrictEqual(h.deliverCalls.map((c) => c.args), [['avh-7', 'user', 'hi', 'dm', '(via avh)']]);
  assert.strictEqual(opts.notifyCalls.length, 1);
});

test('send: a refused wake forwards its code and delivers nothing', async () => {
  const h = makeDeps({ records: { 'avh-7': ASLEEP }, wakeOut: { ok: false, code: 503, error: 'at capacity' } });
  const opts = captureOptions(h.deps);
  assert.deepStrictEqual(await opts.send('avh-7', 'hi', [], 'avh'), { ok: false, code: 503, error: 'at capacity' });
  assert.deepStrictEqual(h.deliverCalls, []);
});

test('send: a seat still closing after archive wakes too; an asleep plain record is not found', async () => {
  const closing = makeDeps({ records: { 'avh-7': { ...ASLEEP } }, sessions: { 'avh-7': { name: 'avh-7', agentType: 'claude', io: 'stream', _archived: true } } });
  const o1 = captureOptions(closing.deps);
  assert.deepStrictEqual(await o1.send('avh-7', 'hi', [], 'avh'), { ok: true });
  assert.deepStrictEqual(closing.wakeCalls, [['avh-7', { reason: 'message' }]]);
  const plain = makeDeps({ records: { p1: { archivedAt: 1, type: 'claude', cwd: '/w' } } });
  const o2 = captureOptions(plain.deps);
  assert.deepStrictEqual(await o2.send('p1', 'hi', [], 'avh'), { ok: false, error: 'Session not found' });
  assert.deepStrictEqual(plain.wakeCalls, []);
  assert.deepStrictEqual(plain.deliverCalls, []);
});

test('send with await: arms at the write and answers the turn, or queued on null; no await passes no onWrite', async () => {
  const live = { 'avh-7': { name: 'avh-7', agentType: 'claude', io: 'stream' } };
  const turn = { text: 'hi', intents: [], costUsd: 0.001 };
  const h = makeDeps({ sessions: live, turn });
  const opts = captureOptions(h.deps);
  assert.deepStrictEqual(await opts.send('avh-7', 'yo', [], 'avh', 5000), { ok: true, turn });
  assert.strictEqual(typeof h.deliverCalls[0].args[5], 'function');
  assert.strictEqual(h.deliverCalls[0].awaitsBefore, 0, 'awaitTurn is armed by the write, never at enqueue');
  assert.deepStrictEqual(h.awaitCalls, [['avh-7', { timeoutMs: 5000 }]]);
  const q = makeDeps({ sessions: live, turn: null });
  assert.deepStrictEqual(await captureOptions(q.deps).send('avh-7', 'yo', [], 'avh', 5000), { ok: true, queued: true });
  const z = makeDeps({ sessions: live, turn });
  assert.deepStrictEqual(await captureOptions(z.deps).send('avh-7', 'yo', [], 'avh', 0), { ok: true });
  assert.strictEqual(z.deliverCalls[0].args[5], undefined);
  assert.deepStrictEqual(z.awaitCalls, []);
});

test('createSession: a template body spawns through the handler; a path-shaped template or a taken name never spawns', async () => {
  const h = makeDeps();
  const opts = captureOptions(h.deps);
  assert.deepStrictEqual(await opts.createSession({ name: 'avh-7', template: 'avh-assistant', cwd: '/w' }),
    { ok: true, name: 'avh-7', type: 'claude', template: 'avh-assistant' });
  assert.deepStrictEqual(h.spawnCalls, [{ spawner: { name: 'wire', type: 'claude', cwd: '/w', proxy: null }, intent: { name: 'avh-7', cwd: '/w', template: 'avh-assistant' } }]);
  assert.deepStrictEqual(h.createCalls, []);
  for (const template of ['../x.json', '~/t.json', './t', 'a/b']) {
    const b = makeDeps();
    assert.deepStrictEqual(await captureOptions(b.deps).createSession({ name: 'avh-8', template, cwd: '/w' }),
      { ok: false, error: 'template must be a library template name' }, template);
    assert.deepStrictEqual(b.spawnCalls, [], template);
  }
  const taken = makeDeps({ records: { 'avh-7': ASLEEP } });
  assert.deepStrictEqual(await captureOptions(taken.deps).createSession({ name: 'avh-7', template: 'avh-assistant', cwd: '/w' }),
    { ok: false, error: 'name taken "avh-7"' });
  assert.deepStrictEqual(taken.spawnCalls, []);
});

test('killSession: an assistant record is destroyed with its vetted transcripts and pending dir; a plain seat is killed', async () => {
  const h = makeDeps({ records: { 'avh-7': { ...ASLEEP, sessionIds: [SID, 'bad/../id'] } } });
  const opts = captureOptions(h.deps);
  assert.deepStrictEqual(await opts.killSession('avh-7'), { ok: true, name: 'avh-7', destroyed: true, transcripts: 1 });
  assert.deepStrictEqual(h.destroyCalls, ['avh-7']);
  assert.deepStrictEqual(h.unlinkCalls, [path.join(HOME, '.claude', 'projects', '-w', `${SID}.jsonl`)]);
  assert.deepStrictEqual(h.rmCalls, [[path.join('/tmp/reg', 'pending', 'avh-7'), { recursive: true, force: true }]]);
  assert.deepStrictEqual(h.killCalls, []);
  const p = makeDeps({ records: { w1: { type: 'claude', cwd: '/w' } }, sessions: { w1: { name: 'w1', agentType: 'claude' } } });
  assert.deepStrictEqual(await captureOptions(p.deps).killSession('w1'), { ok: true, name: 'w1' });
  assert.deepStrictEqual(p.killCalls, ['w1']);
  assert.deepStrictEqual(p.destroyCalls, []);
  const u = makeDeps();
  assert.deepStrictEqual(await captureOptions(u.deps).killSession('nobody'), { ok: false, error: 'no such session "nobody"' });
});

test('listSleepers / getSessions: only an archived, unmapped assistant is a sleeper; an awake assistant row says so; a plain row is unchanged', () => {
  const h = makeDeps({
    records: { a1: { class: 'assistant', type: 'claude', cwd: '/a', wakes: 2 }, 'avh-7': ASLEEP, p1: { archivedAt: 1, type: 'claude', cwd: '/p' }, w1: { type: 'codex', cwd: '/q' } },
    sessions: { a1: { name: 'a1', type: 'claude', io: 'stream', cwd: '/a', agentType: 'claude' }, w1: { name: 'w1', type: 'codex', cwd: '/q', agentType: 'codex' } },
  });
  const opts = captureOptions(h.deps);
  const sleeper = {
    name: 'avh-7', type: 'claude', io: 'stream', cwd: '/w', workspace: '', workspaceId: null, activityTs: null,
    class: 'assistant', state: 'asleep', asleepAt: 2, sleepReason: null, template: null, sleep: null, cost: null, wakes: 0, stats: STATS,
  };
  assert.deepStrictEqual(opts.listSleepers(), [sleeper]);
  assert.deepStrictEqual(opts.getSleeper('avh-7'), sleeper);
  assert.strictEqual(opts.getSleeper('a1'), null);
  assert.strictEqual(opts.getSleeper('p1'), null);
  assert.deepStrictEqual(opts.getSessions(), [
    { name: 'a1', type: 'claude', io: 'stream', cwd: '/a', workspace: '', workspaceId: null, activityTs: null, class: 'assistant', state: 'awake', template: null, sleep: null, cost: null, wakes: 2, stats: STATS },
    { name: 'w1', type: 'codex', io: 'pty', cwd: '/q', workspace: '', workspaceId: null, activityTs: null, stats: STATS },
  ]);
});

test('exportMemory: units and brief for an assistant; brief null when absent; refusals for plain and unknown', () => {
  const units = [{ id: 'u1', scope: 'seat', body: 'likes chess' }];
  const brief = path.join('/tmp/reg', 'sessions', 'avh-7', 'brief.md');
  const h = makeDeps({ records: { 'avh-7': ASLEEP, p1: { type: 'claude' } }, units, files: { [brief]: '## Before you slept\n\nhi' } });
  const opts = captureOptions(h.deps);
  assert.deepStrictEqual(opts.exportMemory('avh-7'), { ok: true, name: 'avh-7', units, brief: '## Before you slept\n\nhi' });
  const nb = makeDeps({ records: { 'avh-7': ASLEEP }, units });
  assert.deepStrictEqual(captureOptions(nb.deps).exportMemory('avh-7'), { ok: true, name: 'avh-7', units, brief: null });
  assert.deepStrictEqual(opts.exportMemory('p1'), { ok: false, error: 'not an assistant seat' });
  assert.deepStrictEqual(opts.exportMemory('nobody'), { ok: false, code: 404, error: 'Session not found' });
});

function req(port, pathname, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

const LIVE_ROW = { name: 'w1', type: 'claude', io: 'pty', cwd: '/q', workspace: '', workspaceId: null, activityTs: null, stats: STATS };
const SLEEPER_ROW = { name: 'avh-7', type: 'claude', io: 'stream', cwd: '/w', workspace: '', workspaceId: null, activityTs: null, class: 'assistant', state: 'asleep', stats: STATS };
const BY_NAME = {
  sleep: { 'avh-7': { ok: true, state: 'asleep' }, busy: { ok: true, state: 'sleeping' }, w1: { ok: false, error: 'not an assistant seat' } },
  wake: { 'avh-7': { ok: true, state: 'awake' }, w1: { ok: false, error: 'not an assistant seat' }, full: { ok: false, code: 503, error: 'at capacity', retryAfterMs: 1000 } },
  memory: { 'avh-7': { ok: true, name: 'avh-7', units: [], brief: null }, nobody: { ok: false, code: 404, error: 'Session not found' } },
};

async function withServer(extra, fn) {
  const sent = [];
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1',
    getSessions: () => [LIVE_ROW],
    getTranscript: () => ({ ok: true, messages: [] }),
    send: (name, text, images, client, awaitMs) => { sent.push({ name, client, awaitMs }); return text === 'q' ? { ok: true, queued: true } : { ok: true }; },
    listSleepers: () => [SLEEPER_ROW],
    getSleeper: (n) => (n === 'avh-7' ? SLEEPER_ROW : null),
    sleepSession: (n) => BY_NAME.sleep[n],
    wakeSession: (n) => BY_NAME.wake[n],
    exportMemory: (n) => BY_NAME.memory[n],
    ...extra,
  });
  await server.start();
  try { return await fn(server.port, sent, server); } finally { server.stop(); }
}

test('GET /api/sessions?state=: asleep lists only sleepers as activity asleep, all lists both, anything else is 400', async () => {
  await withServer({}, async (port) => {
    const asleep = await req(port, '/api/sessions?state=asleep');
    assert.deepStrictEqual(asleep.json.sessions, [{ ...SLEEPER_ROW, activity: 'asleep' }]);
    const all = await req(port, '/api/sessions?state=all');
    assert.deepStrictEqual(all.json.sessions.map((s) => [s.name, s.activity]), [['w1', 'idle'], ['avh-7', 'asleep']]);
    const plain = await req(port, '/api/sessions');
    assert.deepStrictEqual(plain.json.sessions.map((s) => s.name), ['w1']);
    const bad = await req(port, '/api/sessions?state=nope');
    assert.strictEqual(bad.status, 400);
    assert.deepStrictEqual(bad.json, { ok: false, error: 'bad state (expected asleep or all)' });
    const one = await req(port, '/api/sessions/avh-7');
    assert.strictEqual(one.status, 200);
    assert.deepStrictEqual(one.json, { ok: true, session: { ...SLEEPER_ROW, activity: 'asleep' } });
    assert.strictEqual((await req(port, '/api/sessions/nobody')).status, 404);
  });
});

test('POST /api/sessions/:name/dm: await is capped at 60 s, omitted is 0, a queued answer is 202', async () => {
  await withServer({}, async (port, sent) => {
    assert.strictEqual((await req(port, '/api/sessions/avh-7/dm', { method: 'POST', body: { text: 'hi', client: 'avh', await: 99999 } })).status, 200);
    assert.strictEqual((await req(port, '/api/sessions/avh-7/dm', { method: 'POST', body: { text: 'hi', client: 'avh' } })).status, 200);
    const q = await req(port, '/api/sessions/avh-7/dm', { method: 'POST', body: { text: 'q', client: 'avh', await: 10 } });
    assert.strictEqual(q.status, 202);
    assert.deepStrictEqual(q.json, { ok: true, queued: true });
    assert.deepStrictEqual(sent, [{ name: 'avh-7', client: 'avh', awaitMs: 60000 }, { name: 'avh-7', client: 'avh', awaitMs: 0 }, { name: 'avh-7', client: 'avh', awaitMs: 10 }]);
  });
});

test('POST sleep / wake and GET memory: status per answer, code forwarded, 501 without the callback', async () => {
  await withServer({}, async (port) => {
    const st = async (p, method = 'POST') => { const r = await req(port, p, { method }); return [r.status, r.json]; };
    assert.deepStrictEqual(await st('/api/sessions/avh-7/sleep'), [200, { ok: true, state: 'asleep' }]);
    assert.deepStrictEqual(await st('/api/sessions/busy/sleep'), [202, { ok: true, state: 'sleeping' }]);
    assert.deepStrictEqual(await st('/api/sessions/w1/sleep'), [409, { ok: false, error: 'not an assistant seat' }]);
    assert.deepStrictEqual(await st('/api/sessions/avh-7/wake'), [200, { ok: true, state: 'awake' }]);
    assert.deepStrictEqual(await st('/api/sessions/w1/wake'), [409, { ok: false, error: 'not an assistant seat' }]);
    assert.deepStrictEqual(await st('/api/sessions/full/wake'), [503, { ok: false, code: 503, error: 'at capacity', retryAfterMs: 1000 }]);
    assert.deepStrictEqual(await st('/api/sessions/avh-7/memory', 'GET'), [200, { ok: true, name: 'avh-7', units: [], brief: null }]);
    assert.deepStrictEqual(await st('/api/sessions/nobody/memory', 'GET'), [404, { ok: false, code: 404, error: 'Session not found' }]);
  });
  await withServer({ sleepSession: null, wakeSession: null, exportMemory: null }, async (port) => {
    for (const [p, method, verb] of [['sleep', 'POST', 'sleep'], ['wake', 'POST', 'wake'], ['memory', 'GET', 'memory']]) {
      const r = await req(port, `/api/sessions/avh-7/${p}`, { method });
      assert.deepStrictEqual([r.status, r.json], [501, { ok: false, error: `${verb} not available` }]);
    }
  });
});

test('hello: the assistant cap is present only when sleep and wake are both wired', async () => {
  const caps = async (extra) => withServer(extra, async (port) => (await req(port, '/api/peer/hello')).json.caps);
  assert.ok((await caps({})).includes('assistant'));
  assert.ok(!(await caps({ wakeSession: null })).includes('assistant'));
  assert.ok(!(await caps({ sleepSession: null })).includes('assistant'));
});

test('notifyTurn: an /api/events subscriber gets an event: turn frame carrying the name and the turn', async () => {
  await withServer({}, async (port, sent, server) => {
    const frames = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
        let buf = '';
        res.on('data', (d) => {
          buf += d;
          if (!buf.includes('\n\n')) return;
          if (!r._emitted) { r._emitted = true; server.notifyTurn('avh-7', { text: 'hi', intents: [], costUsd: 0.001, durationMs: 5, isError: false, ts: 9 }); return; }
          r.destroy();
          resolve(buf);
        });
      });
      r.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
      r.end();
    });
    assert.match(frames, /event: turn\ndata: \{"name":"avh-7","text":"hi","intents":\[\],"costUsd":0\.001,"durationMs":5,"isError":false,"ts":9\}\n\n/);
  });
});
