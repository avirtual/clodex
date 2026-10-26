'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { createRemoteWiring } = require('../remote-wiring');
const { RemoteServer } = require('../remote');
const { sliceSince } = require('../transcript');

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
  const roomCalls = [];
  const spawnOpts = [];
  const order = [];
  const files = new Map(Object.entries(overrides.files || {}));
  const manager = {
    sessions: new Map(Object.entries(overrides.sessions || {})),
    create: async (...args) => { createCalls.push(args); return { name: args[0], type: args[1], pid: 4242 }; },
    _handleSpawnIntent: (spawner, intent, opts = {}) => {
      spawnCalls.push({ spawner, intent });
      spawnOpts.push(Object.keys(opts).filter((k) => k !== 'onReply').reduce((o, k) => ({ ...o, [k]: opts[k] }), {}));
      setImmediate(() => opts.onReply(overrides.spawnReply || `ok: spawned "${intent.name}" (claude) @ ${intent.cwd} via template "${intent.template}"`));
    },
    wake: async (name, opts) => {
      wakeCalls.push([name, opts]);
      order.push('wake');
      const out = overrides.wakeOut || { ok: true, state: 'awake' };
      if (out.ok) manager.sessions.set(name, { name, agentType: 'claude', type: 'claude', io: 'stream' });
      return out;
    },
    _resolveSpawnTemplate: (spawner, v) => {
      const tpl = (overrides.templates || {})[v];
      return tpl ? { ok: true, tpl } : { ok: false, error: `no template named "${v}"` };
    },
    makeAwakeRoom: async (template, cap, holder) => { roomCalls.push(['room', template, cap, holder]); return overrides.roomOut || null; },
    releaseAwakeRoom: (template, holder) => { roomCalls.push(['release', template, holder, spawnCalls.length]); },
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
    upsert: (e) => records.set(e.name, { ...(records.get(e.name) || {}), ...e }),
  };
  const realFs = require('fs');
  const fs = {
    ...realFs,
    readFileSync: (p, enc) => {
      if (files.has(p)) return files.get(p);
      const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
    },
    realpathSync: (p) => (overrides.realpath ? overrides.realpath(p) : realFs.realpathSync(p)),
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
    parseCtxFile: () => null, ensureDir: () => {}, homeRelativize: (x) => x,
    jsonlToMessages: overrides.jsonlToMessages || (() => []),
    cachedMessages: overrides.cachedMessages || (() => []), sliceSince,
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
    deliverCalls, awaitCalls, unlinkCalls, rmCalls, roomCalls, spawnOpts, order,
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

test('send: a refused wake forwards its code and retryAfterMs and delivers nothing', async () => {
  const h = makeDeps({ records: { 'avh-7': ASLEEP }, wakeOut: { ok: false, code: 503, error: 'at capacity', retryAfterMs: 30000 } });
  const opts = captureOptions(h.deps);
  assert.deepStrictEqual(await opts.send('avh-7', 'hi', [], 'avh'), { ok: false, code: 503, error: 'at capacity', retryAfterMs: 30000 });
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
  assert.deepStrictEqual(h.awaitCalls.map(([n]) => n), ['avh-7']);
  const left = h.awaitCalls[0][1].timeoutMs;
  assert.ok(left > 0 && left <= 5000, `the turn wait is what is left of the 5000 ms budget, got ${left}`);
  const q = makeDeps({ sessions: live, turn: null });
  assert.deepStrictEqual(await captureOptions(q.deps).send('avh-7', 'yo', [], 'avh', 5000), { ok: true, queued: true });
  const z = makeDeps({ sessions: live, turn });
  assert.deepStrictEqual(await captureOptions(z.deps).send('avh-7', 'yo', [], 'avh', 0), { ok: true });
  assert.strictEqual(z.deliverCalls[0].args[5], undefined);
  assert.deepStrictEqual(z.awaitCalls, []);
});

test('send with await: a dm never written answers queued at the deadline instead of hanging', async (t) => {
  const { mock } = require('node:test');
  const h = makeDeps({ sessions: { 'avh-7': { name: 'avh-7', agentType: 'claude', io: 'stream' } }, turn: { text: 'x', intents: [] } });
  h.manager._deliverMessage = (...args) => { h.deliverCalls.push({ args }); };
  const opts = captureOptions(h.deps);
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
  const p = opts.send('avh-7', 'yo', [], 'avh', 10);
  assert.strictEqual(h.deliverCalls.length, 1, 'ENTER: delivered without a write');
  mock.timers.tick(10);
  const out = await Promise.race([p, new Promise((r) => setImmediate(() => r('hung')))]);
  assert.deepStrictEqual(out, { ok: true, queued: true });
  assert.deepStrictEqual(h.awaitCalls, []);
});

test('send: two dms racing to a sleeper share one wake', async () => {
  const h = makeDeps({ records: { 'avh-7': ASLEEP } });
  const opts = captureOptions(h.deps);
  const outs = await Promise.all([opts.send('avh-7', 'a', [], 'avh'), opts.send('avh-7', 'b', [], 'avh'), opts.wakeSession('avh-7')]);
  assert.deepStrictEqual(outs, [{ ok: true }, { ok: true }, { ok: true, state: 'awake' }]);
  assert.deepStrictEqual(h.wakeCalls, [['avh-7', { reason: 'message' }]]);
  assert.strictEqual(h.deliverCalls.length, 2);
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
    records: { a1: { class: 'assistant', type: 'claude', cwd: '/a', wakes: 2, cost: { usd: 0.5, turns: 3, at: 9, awakeMs: 7000 } }, 'avh-7': ASLEEP, p1: { archivedAt: 1, type: 'claude', cwd: '/p' }, w1: { type: 'codex', cwd: '/q' } },
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
  const closing = makeDeps({ records: { 'avh-7': ASLEEP }, sessions: { 'avh-7': { name: 'avh-7', type: 'claude', io: 'stream', _archived: true } } });
  const co = captureOptions(closing.deps);
  assert.deepStrictEqual(co.listSleepers(), [], 'an archived assistant still in the map is closing, not asleep');
  assert.strictEqual(co.getSleeper('avh-7'), null);
  assert.strictEqual(co.getSessions()[0].state, 'sleeping', 'a closing assistant is not reported awake');
  assert.deepStrictEqual(opts.getSessions(), [
    { name: 'a1', type: 'claude', io: 'stream', cwd: '/a', workspace: '', workspaceId: null, activityTs: null, class: 'assistant', state: 'awake', template: null, sleep: null, cost: { usd: 0.5, turns: 3, at: 9, awakeMs: 7000 }, wakes: 2, stats: STATS },
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
  const bare = makeDeps({ records: { 'avh-7': ASLEEP } });
  delete bare.deps.getMemoryStore;
  assert.ok(!('exportMemory' in captureOptions(bare.deps)), 'a host without a memory store wires no memory route');
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
  wake: { 'avh-7': { ok: true, state: 'awake' }, w1: { ok: false, error: 'not an assistant seat' }, full: { ok: false, code: 503, error: 'at capacity', retryAfterMs: 30000 } },
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
    assert.deepStrictEqual(await st('/api/sessions/full/wake'), [503, { ok: false, code: 503, error: 'at capacity', retryAfterMs: 30000 }]);
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

test('send with ref: the full-arity delivery carries the ref as the 10th positional', async () => {
  const h = makeDeps({ sessions: { 'avh-7': { name: 'avh-7', agentType: 'claude', io: 'stream' } } });
  const opts = captureOptions(h.deps);
  assert.deepStrictEqual(await opts.send('avh-7', 'hi', [], 'avh', 0, 'm-1'), { ok: true });
  assert.deepStrictEqual(h.deliverCalls.map((c) => c.args), [['avh-7', 'user', 'hi', 'dm', '(via avh)', null, null, null, null, 'm-1']]);
});

test('POST /api/sessions/:name/dm: ref is validated, passed as the 6th positional and echoed top-level on every answer', async () => {
  const seen = [];
  let answer = { ok: true };
  const send = (name, text, images, client, awaitMs, ref) => { seen.push(ref); return answer; };
  await withServer({ send }, async (port) => {
    const post = (body) => req(port, '/api/sessions/avh-7/dm', { method: 'POST', body });
    const plain = await post({ text: 'hi', client: 'avh', ref: 'm-1' });
    assert.deepStrictEqual([plain.status, plain.json, seen], [200, { ok: true, ref: 'm-1' }, ['m-1']]);
    const turn = { text: 'x', intents: [], refs: ['m-1'] };
    answer = { ok: true, turn };
    const t = await post({ text: 'hi', client: 'avh', ref: 'm-1', await: 10 });
    assert.deepStrictEqual([t.status, t.json], [200, { ok: true, turn, ref: 'm-1' }]);
    answer = { ok: true, queued: true };
    const q = await post({ text: 'hi', client: 'avh', ref: 'm-1', await: 10 });
    assert.deepStrictEqual([q.status, q.json], [202, { ok: true, queued: true, ref: 'm-1' }]);
    answer = { ok: false, code: 409, error: 'nope' };
    const refused = await post({ text: 'hi', ref: 'm-1' });
    assert.deepStrictEqual([refused.status, refused.json], [409, { ok: false, code: 409, error: 'nope', ref: 'm-1' }]);
    answer = { ok: false, code: 503, error: 'at capacity', retryAfterMs: 30000 };
    const full = await post({ text: 'hi', ref: 'm-2' });
    assert.deepStrictEqual([full.status, full.json], [503, { ok: false, code: 503, error: 'at capacity', retryAfterMs: 30000, ref: 'm-2' }]);
    answer = { ok: true };
    seen.length = 0;
    for (const ref of ['a'.repeat(129), 42]) {
      const bad = await post({ text: 'hi', ref });
      assert.deepStrictEqual([bad.status, bad.json], [400, { ok: false, error: 'bad ref' }]);
    }
    assert.deepStrictEqual(seen, [], 'a bad ref never sends');
    const none = await post({ text: 'hi', client: 'avh' });
    assert.deepStrictEqual([none.json, seen], [{ ok: true }, [null]]);
    const wide = await post({ text: 'hi', ref: 'id:7.x-y_z' });
    assert.deepStrictEqual([wide.status, wide.json], [200, { ok: true, ref: 'id:7.x-y_z' }]);
    const max = await post({ text: 'hi', ref: 'b'.repeat(128) });
    assert.strictEqual(max.status, 200);
  });
});

const SID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SLEEPER_REC = { class: 'assistant', archivedAt: 1, type: 'claude', cwd: '/w', sessionId: null, sessionIds: [SID_A, SID_B, 'bad/../id'] };

function stubJsonl(rowsByFile, asked) {
  return (file, limit) => {
    asked.push([file, limit]);
    const rows = rowsByFile[path.basename(file)];
    if (!rows) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return rows.map((r) => ({ ...r }));
  };
}

test('getTranscript: a sleeping assistant reads every recorded awake period, oldest first, seq renumbered', async () => {
  const rows = {
    [`${SID_A}.jsonl`]: [{ role: 'user', text: 'q1', ts: '2026-10-25T10:00:00.000Z', seq: 0 }, { role: 'assistant', text: 'a1', ts: '2026-10-25T10:00:05.000Z', seq: 1 }],
    [`${SID_B}.jsonl`]: [{ role: 'assistant', text: 'b1', ts: '2026-10-25T12:00:00.000Z', seq: 0 }],
  };
  const asked = [];
  const h = makeDeps({ records: { 'avh-7': SLEEPER_REC }, jsonlToMessages: stubJsonl(rows, asked) });
  const opts = captureOptions(h.deps);
  const all = await opts.getTranscript('avh-7', 100, null, null);
  assert.deepStrictEqual(all, {
    ok: true,
    messages: [
      { role: 'user', text: 'q1', ts: '2026-10-25T10:00:00.000Z', seq: 0 },
      { role: 'assistant', text: 'a1', ts: '2026-10-25T10:00:05.000Z', seq: 1 },
      { role: 'assistant', text: 'b1', ts: '2026-10-25T12:00:00.000Z', seq: 2 },
    ],
    cursor: 0, complete: true,
  });
  assert.deepStrictEqual(asked, [
    [path.join(HOME, '.claude', 'projects', '-w', `${SID_A}.jsonl`), Infinity],
    [path.join(HOME, '.claude', 'projects', '-w', `${SID_B}.jsonl`), Infinity],
  ]);
  const since = await opts.getTranscript('avh-7', 100, 2, null);
  assert.deepStrictEqual(since.messages.map((m) => [m.text, m.seq]), [['b1', 2]]);
  const after = await opts.getTranscript('avh-7', 100, null, '2026-10-25T11:00:00.000Z');
  assert.deepStrictEqual(after.messages.map((m) => m.ts), ['2026-10-25T12:00:00.000Z']);
  const last = await opts.getTranscript('avh-7', 1, null, null);
  assert.deepStrictEqual(last.messages.map((m) => m.text), ['b1']);

  const acctAsked = [];
  const acct = makeDeps({ records: { 'avh-7': { ...SLEEPER_REC, env: { CLAUDE_CONFIG_DIR: '/acct' } } }, jsonlToMessages: stubJsonl(rows, acctAsked) });
  await captureOptions(acct.deps).getTranscript('avh-7', 100, null, null);
  assert.deepStrictEqual(acctAsked.map(([f]) => f), [
    path.join('/acct', 'projects', '-w', `${SID_A}.jsonl`),
    path.join('/acct', 'projects', '-w', `${SID_B}.jsonl`),
  ]);
});

test('getTranscript: a sleeper skips an unreadable period, answers an empty page with no files, and a plain or live seat keeps its old path', async () => {
  const onlyB = makeDeps({ records: { 'avh-7': SLEEPER_REC }, jsonlToMessages: stubJsonl({ [`${SID_B}.jsonl`]: [{ role: 'assistant', text: 'b1', seq: 4 }] }, []) });
  assert.deepStrictEqual(await captureOptions(onlyB.deps).getTranscript('avh-7', 100, null, null),
    { ok: true, messages: [{ role: 'assistant', text: 'b1', seq: 0 }], cursor: 0, complete: true });
  const none = makeDeps({ records: { 'avh-7': SLEEPER_REC }, jsonlToMessages: stubJsonl({}, []) });
  assert.deepStrictEqual(await captureOptions(none.deps).getTranscript('avh-7', 100, null, null),
    { ok: true, messages: [], cursor: 0, complete: true });

  const plainAsked = [];
  const plain = makeDeps({ records: { p1: { archivedAt: 1, type: 'claude', cwd: '/w', sessionIds: [SID_A] } }, jsonlToMessages: stubJsonl({}, plainAsked) });
  assert.deepStrictEqual(await captureOptions(plain.deps).getTranscript('p1', 100, null, null), { ok: false, error: 'Session not found' });
  assert.deepStrictEqual(plainAsked, []);

  const liveAsked = [];
  const cached = [];
  const live = makeDeps({
    records: { 'avh-7': SLEEPER_REC },
    sessions: { 'avh-7': { name: 'avh-7', agentType: 'claude', io: 'stream' } },
    jsonlToMessages: stubJsonl({}, liveAsked),
    realpath: (p) => (p === path.join('/tmp/reg', 'run', 'avh-7', 'transcript.jsonl') ? '/live.jsonl' : p),
    cachedMessages: (p) => { cached.push(p); return [{ role: 'user', text: 'now', seq: 0 }]; },
  });
  assert.deepStrictEqual(await captureOptions(live.deps).getTranscript('avh-7', 100, null, null),
    { ok: true, messages: [{ role: 'user', text: 'now', seq: 0 }], cursor: 0, complete: true });
  assert.deepStrictEqual([cached, liveAsked], [['/live.jsonl'], []]);
});

test('killSession: an account assistant unlinks its transcripts under its CLAUDE_CONFIG_DIR', async () => {
  const h = makeDeps({ records: { 'avh-7': { ...SLEEPER_REC, env: { CLAUDE_CONFIG_DIR: '/acct' } } } });
  const opts = captureOptions(h.deps);
  assert.deepStrictEqual(await opts.killSession('avh-7'), { ok: true, name: 'avh-7', destroyed: true, transcripts: 2 });
  assert.deepStrictEqual(h.unlinkCalls, [
    path.join('/acct', 'projects', '-w', `${SID_A}.jsonl`),
    path.join('/acct', 'projects', '-w', `${SID_B}.jsonl`),
  ]);
});

const ASSISTANT_TPL = { name: 'clodex-assistant', type: 'claude', class: 'assistant', sleep: { idleMs: 600000, maxAwake: 20, wakeOn: ['message', 'reminder'], briefTail: 10 } };

test('createSession: an assistant template makes room under its maxAwake first; at capacity it answers 503 and never spawns', async () => {
  const h = makeDeps({ templates: { 'clodex-assistant': ASSISTANT_TPL } });
  const opts = captureOptions(h.deps);
  assert.strictEqual((await opts.createSession({ name: 'avh-1', template: 'clodex-assistant' })).ok, true);
  assert.deepStrictEqual(h.roomCalls, [['room', 'clodex-assistant', 20, 'avh-1'], ['release', 'clodex-assistant', 'avh-1', 1]]);
  assert.strictEqual(h.spawnCalls.length, 1);
  const full = makeDeps({ templates: { 'clodex-assistant': ASSISTANT_TPL }, roomOut: { ok: false, code: 503, error: 'at capacity', retryAfterMs: 30000 } });
  assert.deepStrictEqual(await captureOptions(full.deps).createSession({ name: 'avh-2', template: 'clodex-assistant' }),
    { ok: false, code: 503, error: 'at capacity', retryAfterMs: 30000 });
  assert.deepStrictEqual(full.spawnCalls, []);
  const bad = makeDeps({ templates: { 'clodex-assistant': ASSISTANT_TPL } });
  assert.strictEqual((await captureOptions(bad.deps).createSession({ name: 'bad name', template: 'clodex-assistant' })).ok, false);
  assert.deepStrictEqual([bad.roomCalls, bad.spawnCalls], [[], []], 'an invalid name evicts nobody');
  const plain = makeDeps({ templates: { worker: { name: 'worker', type: 'claude' } } });
  assert.strictEqual((await captureOptions(plain.deps).createSession({ name: 'w2', template: 'worker' })).ok, true);
  assert.deepStrictEqual(plain.roomCalls, [], 'a template without the class has no cap');
});

test('createSession: CLODEX_REMOTE_CREATE=template refuses a bare create with 403 and still spawns a template; unset keeps bare creates', async () => {
  const prev = process.env.CLODEX_REMOTE_CREATE;
  try {
    process.env.CLODEX_REMOTE_CREATE = 'template';
    const h = makeDeps();
    const opts = captureOptions(h.deps);
    assert.deepStrictEqual(await opts.createSession({ name: 'w1', type: 'claude', cwd: '/w' }),
      { ok: false, code: 403, error: 'create: this host accepts template creates only' });
    assert.deepStrictEqual(h.createCalls, []);
    h.deps.manager._resolveSpawnTemplate = () => ({ ok: true, tpl: { name: 'avh-assistant', type: 'claude', class: 'assistant' } });
    assert.strictEqual((await opts.createSession({ name: 'avh-7', template: 'avh-assistant' })).ok, true);
    assert.strictEqual(h.spawnCalls.length, 1);
    delete process.env.CLODEX_REMOTE_CREATE;
    const u = makeDeps();
    assert.strictEqual((await captureOptions(u.deps).createSession({ name: 'w1', type: 'claude', cwd: '/w' })).ok, true);
    assert.strictEqual(u.createCalls.length, 1);
  } finally {
    if (prev === undefined) delete process.env.CLODEX_REMOTE_CREATE;
    else process.env.CLODEX_REMOTE_CREATE = prev;
  }
});

test('POST /api/sessions: a create answer\'s code is the status, else 400', async () => {
  let answer = { ok: false, code: 403, error: 'create: this host accepts template creates only' };
  await withServer({ createSession: () => answer }, async (port) => {
    const r = await req(port, '/api/sessions', { method: 'POST', body: { name: 'w1', type: 'claude', cwd: '/w' } });
    assert.deepStrictEqual([r.status, r.json], [403, answer]);
    answer = { ok: false, error: 'cwd required' };
    assert.strictEqual((await req(port, '/api/sessions', { method: 'POST', body: { name: 'w1' } })).status, 400);
  });
});

test('remote.js builds the dm ref pattern from DM_REF_MAX', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'remote.js'), 'utf8');
  assert.match(src, /const DM_REF_MAX = 128;\nconst DM_CLIENT_REF_RE = new RegExp\(`\^\[A-Za-z0-9\._:-\]\{1,\$\{DM_REF_MAX\}\}\$`\);/);
  assert.ok(!src.includes('{1,128}'));
});

const realFs = require('fs');
const { mkTmpRoot } = require('./lib/tmp-roots');
const TOKEN = 't'.repeat(16);

function withTokenRoot(h) {
  const root = mkTmpRoot('clx-client-token-');
  h.deps.REGISTRY_DIR = root;
  h.deps.ensureDir = (d) => realFs.mkdirSync(d, { recursive: true });
  h.deps.fs.unlinkSync = realFs.unlinkSync;
  return { root, tokenPath: (n) => path.join(root, 'sessions', n, 'client-token') };
}

async function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env[key]; else process.env[key] = prev;
  }
}

test('createSession: client.token is written 0600 to the seat dir after create, and reaches neither create() nor the answer', async () => {
  const h = makeDeps();
  const t = withTokenRoot(h);
  const opts = captureOptions(h.deps);
  const out = await opts.createSession({ name: 'w1', type: 'claude', cwd: path.join(t.root, 'cwd'), client: { token: TOKEN } });
  assert.strictEqual(out.ok, true, 'ENTER: the create succeeded');
  assert.strictEqual(realFs.readFileSync(t.tokenPath('w1'), 'utf8'), TOKEN);
  assert.strictEqual(realFs.statSync(t.tokenPath('w1')).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(out).includes(TOKEN), 'the answer never echoes the token');
  assert.strictEqual(h.createCalls.length, 1);
  assert.ok(!JSON.stringify(h.createCalls[0]).includes(TOKEN), 'create() and so the persisted record never see it');
  const tpl = makeDeps({ templates: { 'avh-assistant': { name: 'avh-assistant', type: 'claude' } } });
  const tt = withTokenRoot(tpl);
  const tout = await captureOptions(tpl.deps).createSession({ name: 'avh-1', template: 'avh-assistant', client: { token: TOKEN } });
  assert.strictEqual(tout.ok, true);
  assert.strictEqual(realFs.readFileSync(tt.tokenPath('avh-1'), 'utf8'), TOKEN);
  assert.ok(!JSON.stringify([tout, tpl.spawnCalls]).includes(TOKEN));
});

test('createSession: a malformed client token is 400 and nothing spawns or is written', async () => {
  for (const body of [{ name: 'w1', type: 'claude', cwd: '/w' }, { name: 'avh-1', template: 'avh-assistant' }]) {
    const h = makeDeps({ templates: { 'avh-assistant': { name: 'avh-assistant', type: 'claude' } } });
    const t = withTokenRoot(h);
    assert.deepStrictEqual(await captureOptions(h.deps).createSession({ ...body, client: { token: 'short' } }),
      { ok: false, code: 400, error: 'bad client token' });
    assert.deepStrictEqual([h.createCalls, h.spawnCalls], [[], []]);
    assert.strictEqual(realFs.existsSync(t.tokenPath(body.name)), false);
  }
});

test('PUT /api/sessions/:name/client-token: set, rotate over a loose file, clear, unknown name, bad token', async () => {
  const h = makeDeps({ records: { 'avh-7': ASLEEP } });
  const t = withTokenRoot(h);
  const opts = captureOptions(h.deps);
  realFs.mkdirSync(path.dirname(t.tokenPath('avh-7')), { recursive: true });
  realFs.writeFileSync(t.tokenPath('avh-7'), 'old', { mode: 0o644 });
  await withServer({ setClientToken: opts.setClientToken }, async (port) => {
    const put = (name, token) => req(port, `/api/sessions/${name}/client-token`, { method: 'PUT', body: { token } });
    assert.deepStrictEqual(await put('avh-7', TOKEN), { status: 200, json: { ok: true, set: true } });
    assert.strictEqual(realFs.readFileSync(t.tokenPath('avh-7'), 'utf8'), TOKEN);
    assert.strictEqual(realFs.statSync(t.tokenPath('avh-7')).mode & 0o777, 0o600, 'a rotation tightens a pre-existing file');
    assert.deepStrictEqual(await put('avh-7', null), { status: 200, json: { ok: true, set: false } });
    assert.strictEqual(realFs.existsSync(t.tokenPath('avh-7')), false);
    assert.deepStrictEqual(await put('avh-7', null), { status: 200, json: { ok: true, set: false } }, 'clearing twice is idempotent');
    assert.deepStrictEqual(await put('nobody', TOKEN), { status: 404, json: { ok: false, code: 404, error: 'Session not found' } });
    assert.deepStrictEqual(await put('avh-7', 'x y'), { status: 400, json: { ok: false, code: 400, error: 'bad client token' } });
  });
});

test('CLODEX_REMOTE_CREATE=template: import begin and commit are 403', async () => {
  await withEnv('CLODEX_REMOTE_CREATE', 'template', async () => {
    const h = makeDeps();
    const opts = captureOptions(h.deps);
    const refusal = { ok: false, code: 403, error: 'import: this host accepts template creates only' };
    assert.deepStrictEqual(await opts.importCreate({ name: 'x1', record: { type: 'claude', cwd: '/w' } }), refusal);
    assert.deepStrictEqual(h.createCalls, []);
    const begins = [];
    const seatImport = {
      begin: (a) => { begins.push(a); return { ok: true, id: 'a'.repeat(16) }; },
      commit: () => ({ ok: true, name: 'x1', record: { type: 'claude', cwd: '/w' }, installed: [], dropped: [] }),
    };
    await withServer({ seatImport, importCreate: opts.importCreate }, async (port) => {
      const b = await req(port, '/api/import/begin', { method: 'POST', body: { name: 'x1', record: {} } });
      assert.deepStrictEqual([b.status, b.json], [403, refusal]);
      assert.deepStrictEqual(begins, []);
      const c = await req(port, `/api/import/${'a'.repeat(16)}/commit`, { method: 'POST' });
      assert.deepStrictEqual([c.status, c.json], [403, { ok: false, error: refusal.error, installed: [] }]);
    });
    assert.deepStrictEqual(h.createCalls, []);
  });
});

test('CLODEX_REMOTE_CREATE=template: a non-assistant or unknown template is 403; an assistant template ignores the caller cwd', async () => {
  await withEnv('CLODEX_REMOTE_CREATE', 'template', async () => {
    const refusal = { ok: false, code: 403, error: 'create: this host accepts assistant templates only' };
    for (const template of ['worker', 'missing']) {
      const h = makeDeps({ templates: { worker: { name: 'worker', type: 'claude' } } });
      assert.deepStrictEqual(await captureOptions(h.deps).createSession({ name: 'w2', template, cwd: '/w' }), refusal, template);
      assert.deepStrictEqual(h.spawnCalls, [], template);
    }
    const h = makeDeps({ templates: { 'clodex-assistant': ASSISTANT_TPL } });
    const resolvedWith = [];
    const orig = h.manager._resolveSpawnTemplate;
    h.manager._resolveSpawnTemplate = (spawner, v) => { resolvedWith.push(spawner.cwd); return orig(spawner, v); };
    assert.strictEqual((await captureOptions(h.deps).createSession({ name: 'avh-1', template: 'clodex-assistant', cwd: '/evil' })).ok, true);
    assert.deepStrictEqual(resolvedWith, [HOME]);
    assert.deepStrictEqual(h.spawnCalls, [{ spawner: { name: 'wire', type: 'claude', cwd: HOME, proxy: null }, intent: { name: 'avh-1', template: 'clodex-assistant' } }]);
  });
});

test('createSession: a capped template reserves once on the wire and tells the handler it holds the room', async () => {
  const h = makeDeps({ templates: { 'clodex-assistant': ASSISTANT_TPL, worker: { name: 'worker', type: 'claude' } } });
  const opts = captureOptions(h.deps);
  assert.strictEqual((await opts.createSession({ name: 'avh-1', template: 'clodex-assistant' })).ok, true);
  assert.deepStrictEqual(h.spawnOpts, [{ awakeHeld: true }]);
  assert.strictEqual(h.roomCalls.filter((c) => c[0] === 'room').length, 1);
  assert.strictEqual((await opts.createSession({ name: 'w1', template: 'worker' })).ok, true);
  assert.deepStrictEqual(h.spawnOpts, [{ awakeHeld: true }, {}]);
});

test('send: a sleeper whose wakeOn omits message refuses the dm with 409 and never wakes; absent or listing message wakes', async () => {
  const no = makeDeps({ records: { 'avh-7': { ...ASLEEP, sleep: { wakeOn: ['reminder'] } } } });
  assert.deepStrictEqual(await captureOptions(no.deps).send('avh-7', 'hi', [], 'avh'),
    { ok: false, code: 409, error: 'avh-7 is asleep and does not wake on messages' });
  assert.deepStrictEqual([no.wakeCalls, no.deliverCalls], [[], []]);
  for (const sleep of [{ idleMs: 1 }, { wakeOn: ['message'] }]) {
    const yes = makeDeps({ records: { 'avh-7': { ...ASLEEP, sleep } } });
    assert.deepStrictEqual(await captureOptions(yes.deps).send('avh-7', 'hi', [], 'avh'), { ok: true }, JSON.stringify(sleep));
    assert.deepStrictEqual(yes.wakeCalls, [['avh-7', { reason: 'message' }]]);
  }
});

test('createSession: two concurrent template creates for one name — exactly one spawns, the other is name taken', async () => {
  const h = makeDeps();
  const opts = captureOptions(h.deps);
  const outs = await Promise.all([
    opts.createSession({ name: 'avh-9', template: 'avh-assistant', cwd: '/w' }),
    opts.createSession({ name: 'avh-9', template: 'avh-assistant', cwd: '/w' }),
  ]);
  assert.deepStrictEqual(outs, [
    { ok: true, name: 'avh-9', type: 'claude', template: 'avh-assistant' },
    { ok: false, error: 'name taken "avh-9"' },
  ]);
  assert.strictEqual(h.spawnCalls.length, 1);
  assert.strictEqual((await opts.createSession({ name: 'avh-9', template: 'avh-assistant', cwd: '/w' })).ok, true, 'a settled create frees the claim');
});

test('createSession: a token write that throws after a good create answers ok with a warning and never the token', async () => {
  const bodies = (root) => [{ name: 'w1', type: 'claude', cwd: path.join(root, 'cwd') }, { name: 'avh-1', template: 'avh-assistant' }];
  for (const i of [0, 1]) {
    const h = makeDeps({ templates: { 'avh-assistant': { name: 'avh-assistant', type: 'claude' } } });
    const t = withTokenRoot(h);
    h.deps.fs.writeFileSync = (p, ...rest) => {
      if (String(p).endsWith('client-token')) { realFs.writeFileSync(p, 'par'); throw new Error('ENOSPC'); }
      return realFs.writeFileSync(p, ...rest);
    };
    const out = await captureOptions(h.deps).createSession({ ...bodies(t.root)[i], client: { token: TOKEN } });
    assert.strictEqual(out.ok, true, 'ENTER: the create succeeded');
    assert.deepStrictEqual(out.warnings, ['client token not stored']);
    assert.ok(!JSON.stringify(out).includes(TOKEN));
    assert.strictEqual(realFs.existsSync(t.tokenPath(bodies(t.root)[i].name)), false);
  }
});

test('createSession: a team-lead create carrying a valid client token is 400 and nothing spawns', async () => {
  const h = makeDeps();
  let loaded = 0;
  h.deps.loadManifest = () => { loaded++; return { lead: 'lead-1', root: '/r' }; };
  const t = withTokenRoot(h);
  assert.deepStrictEqual(await captureOptions(h.deps).createSession({ name: 'lead-1', team: 'crew', client: { token: TOKEN } }),
    { ok: false, code: 400, error: 'client token: not accepted for a team-lead create' });
  assert.deepStrictEqual([h.spawnCalls, h.createCalls, loaded], [[], [], 0]);
  assert.strictEqual(realFs.existsSync(t.tokenPath('lead-1')), false);
  assert.strictEqual((await captureOptions(h.deps).createSession({ name: 'lead-1', team: 'crew' })).ok, true, 'without a token the lead still spawns');
});

test('createSession: a create with no client.token onto a name holding a stale client-token leaves no token file', async () => {
  const bodies = (root) => [{ name: 'w1', type: 'claude', cwd: path.join(root, 'cwd') }, { name: 'avh-1', template: 'avh-assistant' }];
  for (const i of [0, 1]) {
    const h = makeDeps({ templates: { 'avh-assistant': { name: 'avh-assistant', type: 'claude' } } });
    const t = withTokenRoot(h);
    const body = bodies(t.root)[i];
    realFs.mkdirSync(path.dirname(t.tokenPath(body.name)), { recursive: true });
    realFs.writeFileSync(t.tokenPath(body.name), 'stale-token-of-game-a');
    const out = await captureOptions(h.deps).createSession(body);
    assert.strictEqual(out.ok, true, 'ENTER: the create succeeded');
    assert.strictEqual(realFs.existsSync(t.tokenPath(body.name)), false, body.name);
  }
});

test('setClientToken: a write that throws after writing partial content leaves no file', () => {
  const h = makeDeps({ records: { 'avh-7': ASLEEP } });
  const t = withTokenRoot(h);
  h.deps.fs.writeFileSync = (p, ...rest) => {
    if (String(p).endsWith('client-token')) { realFs.writeFileSync(p, 'par'); throw new Error('ENOSPC'); }
    return realFs.writeFileSync(p, ...rest);
  };
  const out = captureOptions(h.deps).setClientToken('avh-7', TOKEN);
  assert.deepStrictEqual(out, { ok: false, code: 500, error: 'cannot write client token: ENOSPC' });
  assert.strictEqual(realFs.existsSync(t.tokenPath('avh-7')), false);
});

test('restartSession (wire): an asleep assistant goes through wake, never engine restartSession', async () => {
  const h = makeDeps({ records: { 'avh-7': ASLEEP } });
  const restarts = [];
  h.deps.restartSession = async (...a) => { restarts.push(a); return { ok: true }; };
  const out = await captureOptions(h.deps).restartSession('avh-7', { fresh: false });
  assert.deepStrictEqual(out, { ok: true, state: 'awake', io: 'stream' });
  assert.deepStrictEqual([h.wakeCalls, restarts], [[['avh-7', { reason: 'operator' }]], []]);
  const refused = makeDeps({ records: { 'avh-7': ASLEEP }, wakeOut: { ok: false, code: 503, error: 'at capacity', retryAfterMs: 30000 } });
  assert.deepStrictEqual(await captureOptions(refused.deps).restartSession('avh-7'),
    { ok: false, code: 503, error: 'at capacity', retryAfterMs: 30000 });
});

test('restartSession (wire): an awake assistant reserves under its maxAwake; at capacity it is refused and never restarts', async () => {
  const AWAKE = { class: 'assistant', template: 'avh-tpl', sleep: { maxAwake: 1 }, type: 'claude', cwd: '/w', exitedAt: 5 };
  const full = { ok: false, code: 503, error: 'at capacity', retryAfterMs: 30000 };
  const LIVE = { 'avh-7': { name: 'avh-7', type: 'claude', _dead: false } };
  const h = makeDeps({ records: { 'avh-7': AWAKE }, sessions: LIVE, roomOut: full });
  const restarts = [];
  h.deps.restartSession = async (...a) => { restarts.push(a); return { ok: true }; };
  assert.ok(h.manager.sessions.get('avh-7') && !h.manager.sessions.get('avh-7')._dead, 'ENTER: the name has a live holder');
  assert.deepStrictEqual(await captureOptions(h.deps).restartSession('avh-7'), full);
  assert.deepStrictEqual([h.roomCalls, restarts, h.wakeCalls], [[['room', 'avh-tpl', 1, 'avh-7']], [], []]);
  const ok = makeDeps({ records: { 'avh-7': { ...AWAKE, awokeAt: 1 } }, sessions: LIVE });
  ok.deps.restartSession = async (...a) => { restarts.push(a); return { ok: true }; };
  const before = Date.now();
  assert.strictEqual((await captureOptions(ok.deps).restartSession('avh-7')).ok, true);
  assert.ok(ok.records.get('avh-7').awokeAt >= before, 'a restarted assistant restarts its awake clock');
  assert.deepStrictEqual(ok.roomCalls, [['room', 'avh-tpl', 1, 'avh-7'], ['release', 'avh-tpl', 'avh-7', 0]]);
  assert.deepStrictEqual(restarts, [['avh-7', { fresh: false }, 'default']]);
});

test('POST /api/sessions/:name/restart: a refusal carrying a code is sent with that status, else 404', async () => {
  const full = { ok: false, code: 503, error: 'at capacity', retryAfterMs: 30000 };
  await withServer({ restartSession: (n) => (n === 'avh-7' ? full : { ok: false, error: 'Session not found in persistence' }) }, async (port) => {
    const r = await req(port, '/api/sessions/avh-7/restart', { method: 'POST', body: {} });
    assert.deepStrictEqual([r.status, r.json], [503, full]);
    const gone = await req(port, '/api/sessions/nobody/restart', { method: 'POST', body: {} });
    assert.deepStrictEqual([gone.status, gone.json], [404, { ok: false, error: 'Session not found in persistence' }]);
  });
});
