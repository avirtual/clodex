'use strict';
// remote-create.test.js — the M5 full-param wire create (docs/sandbox-plan.md M5).
// Two levels:
//   1. remote-wiring's createSession/getCatalogs mapping — captured by patching
//      RemoteServer so we can call the real owner-side closures with a mock
//      manager, asserting each wire key lands in the right create() position, that
//      exec grants never cross, warnings ride the ack, and stripLevel seeds
//      explicit-only.
//   2. remote.js over real HTTP — the create2 hello cap, the GET /api/catalogs
//      route (200 shape + 501 when unwired), and that POST /api/sessions forwards
//      the WHOLE body (not just name/type/cwd).

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { createRemoteWiring } = require('../remote-wiring');

// create() positional indices (session-manager.js:610) — pinned here so a
// mapping regression names the exact slot that drifted.
const IDX = {
  name: 0, type: 1, cwd: 2, extraArgs: 3, resumeId: 4, workspaceId: 5,
  systemPromptBody: 6, fork: 7, proxy: 8, agents: 9, denyBuiltins: 10,
  disabledTools: 11, disabledSkills: 12, injectSkills: 13, systemPromptFile: 14,
  appendPromptFiles: 15, execCommands: 16, intents: 17,
};

// A createRemoteWiring dep bundle sufficient to reach `new RemoteServer(...)`.
// Only manager/persistence/libraries matter for the create path; the rest are
// inert stubs (their handlers never run in these tests).
function makeDeps(overrides = {}) {
  let srv = null;
  const createCalls = [];
  const stripCalls = [];
  const manager = {
    sessions: new Map(),
    create: async (...args) => {
      createCalls.push(args);
      const out = { name: args[0], type: args[1], pid: 4242 };
      if (overrides.createWarnings) out.warnings = overrides.createWarnings;
      return out;
    },
  };
  const persistence = { get: () => undefined, setStripLevel: (n, l) => stripCalls.push([n, l]) };
  const uiSettings = { get: () => ({ remoteEnabled: true, remotePort: 0, proxyUrl: 'http://127.0.0.1:8123', proxyEnabled: true }) };
  const deps = {
    path, fs: require('fs'), os,
    log: { info() {}, error() {} },
    DEFAULT_WORKSPACE_ID: 'default',
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    REGISTRY_DIR: '/tmp/reg', OUTBOX_DIR: '/tmp/outbox', SELF_LABEL: 'testbox',
    parseCtxFile: () => null, jsonlToMessages: () => [], ensureDir: () => {}, homeRelativize: (x) => x,
    claimOutbox: () => [], listOutboxOrigins: () => [],
    manager, proxyPoller: { snapshot: () => null },
    restartClodex: () => {}, restartSession: () => {}, peerProxyView: () => null,
    readSessionArgs: () => ({ ok: false }), applySessionArgs: () => ({ ok: false }),
    readSkillCatalog: () => ({ ok: false }), applySessionSkills: () => ({ ok: false }),
    fetchProxyContext: () => {}, fetchProxyReport: () => {}, fetchProxyBust: () => {},
    fetchSessionFiles: () => {}, fetchFilePeek: () => {}, fetchFileDiff: () => {},
    CLAUDE_TOOLS: ['Bash', 'Read'],
    getPromptLibrary: () => ({ list: () => [{ name: 'sys1' }] }),
    getAgentLibrary: () => ({ list: () => [{ name: 'agentA' }] }),
    getSkillLibrary: () => ({ list: () => [{ name: 'skillX' }] }),
    getPersistence: () => persistence,
    getUiSettings: () => uiSettings,
    getWorkspaces: () => ({ get: () => ({}) }),
    getRemoteServer: () => srv, setRemoteServer: (v) => { srv = v; }, setRemoteError: () => {},
    readRemoteEnvToken: () => null, resolveRemoteToken: (a, b) => a || b || null,
    appVersion: '9.9.9', isPackaged: () => false,
  };
  return { deps, createCalls, stripCalls };
}

// Patch RemoteServer (require()d lazily inside syncRemoteServer) with a capturing
// fake, run syncRemoteServer, and hand back the owner-side options object so the
// real createSession/getCatalogs closures can be exercised directly.
function captureOptions(deps) {
  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  let opts = null;
  remoteMod.RemoteServer = function (o) {
    opts = o;
    return { start: () => Promise.resolve(), stop() {}, port: 0, notifySessions() {} };
  };
  try {
    createRemoteWiring(deps).syncRemoteServer();
  } finally {
    remoteMod.RemoteServer = orig;
  }
  return opts;
}

// ── createSession: bare-body compat pin ──────────────────────────────────────

test('createSession: bare {name,type,cwd} maps to the exact M3 defaults (compat)', async () => {
  const { deps, createCalls, stripCalls } = makeDeps();
  const opts = captureOptions(deps);
  const ack = await opts.createSession({ name: 'worker', type: 'claude', cwd: '/tmp/w' });
  assert.deepStrictEqual(ack, { ok: true, name: 'worker', type: 'claude', pid: 4242 });
  assert.deepStrictEqual(createCalls[0], [
    'worker', 'claude', path.resolve('/tmp/w'),
    [], null, 'default', null, false, null, [], [], [], [], [], null, [], [], null,
  ]);
  assert.deepStrictEqual(stripCalls, [], 'no stripLevel seed for a bare body');
});

// ── createSession: full-body mapping ─────────────────────────────────────────

test('createSession: every wire key lands in the right create() position', async () => {
  const { deps, createCalls } = makeDeps();
  const opts = captureOptions(deps);
  await opts.createSession({
    name: 'rich', type: 'claude', cwd: '/tmp/r',
    extraArgs: ['--model', 'opus'], resumeId: 'sess-123', fork: true,
    proxy: 'http://p', agents: ['a1'], denyBuiltins: ['Explore'],
    disabledTools: ['Bash'], disabledSkills: ['s1'], injectSkills: ['inj1'],
    systemPromptFile: '/sp.md', appendPromptFiles: ['/ap.md'], intents: ['dm'],
  });
  const c = createCalls[0];
  assert.deepStrictEqual(c[IDX.extraArgs], ['--model', 'opus']);
  assert.strictEqual(c[IDX.resumeId], 'sess-123');
  assert.strictEqual(c[IDX.workspaceId], 'default');
  assert.strictEqual(c[IDX.systemPromptBody], null, 'F2 — systemPromptBody stays null');
  assert.strictEqual(c[IDX.fork], true);
  assert.strictEqual(c[IDX.proxy], 'http://p');
  assert.deepStrictEqual(c[IDX.agents], ['a1']);
  assert.deepStrictEqual(c[IDX.denyBuiltins], ['Explore']);
  assert.deepStrictEqual(c[IDX.disabledTools], ['Bash']);
  assert.deepStrictEqual(c[IDX.disabledSkills], ['s1']);
  assert.deepStrictEqual(c[IDX.injectSkills], ['inj1']);
  assert.strictEqual(c[IDX.systemPromptFile], '/sp.md');
  assert.deepStrictEqual(c[IDX.appendPromptFiles], ['/ap.md']);
  assert.deepStrictEqual(c[IDX.intents], ['dm']);
});

// ── createSession: exec grants never cross ───────────────────────────────────

test('createSession: execCommands are stripped inbound and forced [] into create()', async () => {
  const { deps, createCalls } = makeDeps();
  const opts = captureOptions(deps);
  await opts.createSession({
    name: 'noexec', type: 'claude', cwd: '/tmp/n',
    execCommands: [{ name: 'rm', cmd: 'rm -rf /' }],
  });
  assert.deepStrictEqual(createCalls[0][IDX.execCommands], [], 'exec grants never reach create()');
});

// ── createSession: warnings forwarded on the ack ─────────────────────────────

test('createSession: non-fatal create() warnings ride the ack (slice 4 toast shape)', async () => {
  const warnings = ['Skill "x" calls subagent "y", which isn\'t enabled'];
  const { deps } = makeDeps({ createWarnings: warnings });
  const opts = captureOptions(deps);
  const ack = await opts.createSession({ name: 'warn', type: 'claude', cwd: '/tmp/warn' });
  assert.deepStrictEqual(ack.warnings, warnings);
});

test('createSession: no warnings key when create() returns none', async () => {
  const { deps } = makeDeps();
  const opts = captureOptions(deps);
  const ack = await opts.createSession({ name: 'clean', type: 'claude', cwd: '/tmp/clean' });
  assert.ok(!('warnings' in ack), 'ack stays lean when there is nothing to warn about');
});

// ── createSession: stripLevel explicit-only seed ─────────────────────────────

test('createSession: an explicit stripLevel seeds persistence (no agentDefaults fallback)', async () => {
  const { deps, stripCalls } = makeDeps();
  const opts = captureOptions(deps);
  await opts.createSession({ name: 'strip2', type: 'claude', cwd: '/tmp/s', stripLevel: 2 });
  assert.deepStrictEqual(stripCalls, [['strip2', 2]]);
});

test('createSession: an out-of-range/absent stripLevel seeds nothing', async () => {
  const { deps, stripCalls } = makeDeps();
  const opts = captureOptions(deps);
  await opts.createSession({ name: 'strip0', type: 'claude', cwd: '/tmp/s0', stripLevel: 0 });
  await opts.createSession({ name: 'strip3', type: 'claude', cwd: '/tmp/s3', stripLevel: 3 });
  await opts.createSession({ name: 'stripNone', type: 'claude', cwd: '/tmp/sn' });
  assert.deepStrictEqual(stripCalls, [], 'only an explicit 1|2 seeds');
});

// ── getCatalogs: superset shape ──────────────────────────────────────────────

test('getCatalogs: a SUPERSET of the edit block — adds skills, agents unscoped', () => {
  const { deps } = makeDeps();
  const opts = captureOptions(deps);
  assert.deepStrictEqual(opts.getCatalogs(), {
    agents: [{ name: 'agentA' }],
    prompts: [{ name: 'sys1' }],
    skills: [{ name: 'skillX' }],
    claudeTools: ['Bash', 'Read'],
    proxyUrl: 'http://127.0.0.1:8123',
    proxyEnabled: true,
  });
});

// ── remote.js over HTTP: hello cap + /api/catalogs route + full-body forward ──

const { RemoteServer } = require('../remote');
const PAGE = path.join(__dirname, '..', 'renderer', 'remote.html');

function server(extra) {
  return new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: PAGE,
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    ...extra,
  });
}

function req(port, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

async function withServer(extra, fn) {
  const s = server(extra);
  await s.start();
  try { return await fn(s.port); } finally { s.stop(); }
}

test('hello: create2 rides alongside create when createSession is wired', async () => {
  await withServer({ createSession: () => ({ ok: true }), getCatalogs: () => ({}) }, async (port) => {
    const r = await req(port, '/api/peer/hello');
    const caps = JSON.parse(r.body).caps;
    assert.ok(caps.includes('create'), 'create present');
    assert.ok(caps.includes('create2'), 'create2 present');
  });
});

test('hello: no create2 (nor create) when createSession is absent', async () => {
  await withServer({}, async (port) => {
    const caps = JSON.parse((await req(port, '/api/peer/hello')).body).caps;
    assert.ok(!caps.includes('create2'), 'create2 gated on the create surface');
    assert.ok(!caps.includes('create'));
  });
});

test('GET /api/catalogs: 200 with the box-truth catalogs when wired', async () => {
  const cat = { agents: [{ name: 'a' }], prompts: [], skills: [{ name: 's' }], claudeTools: ['Bash'], proxyUrl: 'u', proxyEnabled: false };
  await withServer({ createSession: () => ({ ok: true }), getCatalogs: () => cat }, async (port) => {
    const r = await req(port, '/api/catalogs');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true, catalogs: cat });
  });
});

test('GET /api/catalogs: 501 when the owner does not serve catalogs', async () => {
  await withServer({}, async (port) => {
    const r = await req(port, '/api/catalogs');
    assert.strictEqual(r.status, 501);
  });
});

test('POST /api/sessions: the WHOLE body reaches the owner, not just name/type/cwd', async () => {
  let received = null;
  await withServer({ createSession: (b) => { received = b; return { ok: true, name: b.name, type: b.type, pid: 1 }; } }, async (port) => {
    const body = JSON.stringify({ name: 'w', type: 'claude', cwd: '/tmp/w', injectSkills: ['inj'], stripLevel: 2, intents: ['dm'] });
    const r = await req(port, '/api/sessions', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    assert.strictEqual(r.status, 200);
  });
  assert.deepStrictEqual(received, { name: 'w', type: 'claude', cwd: '/tmp/w', injectSkills: ['inj'], stripLevel: 2, intents: ['dm'] });
});
