'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRemoteWiring } = require('../remote-wiring');
const { RemoteServer, RESOURCES } = require('../remote');
const { mkTmpRoot } = require('./lib/tmp-roots');

const REMOTE_SRC = fs.readFileSync(path.join(__dirname, '..', 'remote.js'), 'utf-8');

const WORKSPACES = [
  { id: 'ws-alpha', name: 'Alpha', open: true, lastFocusedAt: 1700000000000, bounds: { x: 1, y: 2, width: 3, height: 4 } },
  { id: 'ws-beta', name: 'Beta', bounds: null },
];

function makeDeps() {
  const root = mkTmpRoot('remote-resources-');
  let srv = null;
  const createCalls = [];
  const manager = {
    sessions: new Map([
      ['alice', { name: 'alice', type: 'claude', cwd: path.join(root, 'a'), workspaceId: 'ws-alpha' }],
      ['bob', { name: 'bob', type: 'codex', cwd: path.join(root, 'b'), workspaceId: 'ws-beta' }],
      ['ghost', { name: 'ghost', type: 'claude', cwd: path.join(root, 'g'), workspaceId: 'ws-alpha', _dead: true }],
    ]),
    create: async (...args) => { createCalls.push(args); return { name: args[0], type: args[1], pid: 7 }; },
  };
  const workspaces = {
    list: () => WORKSPACES.map(w => ({ ...w })),
    get: (id) => WORKSPACES.find(w => w.id === id) || null,
  };
  const uiSettings = { get: () => ({ remoteEnabled: true, remotePort: 0, proxyUrl: 'http://127.0.0.1:8123', proxyEnabled: true }) };
  const deps = {
    path, fs, os,
    log: { info() {}, error() {} },
    DEFAULT_WORKSPACE_ID: 'ws-alpha',
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    REGISTRY_DIR: path.join(root, 'registry'), OUTBOX_DIR: path.join(root, 'outbox'), SELF_LABEL: 'testnode',
    parseCtxFile: () => null, ensureDir: () => {}, homeRelativize: (x) => x,
    claimOutbox: () => [], listOutboxOrigins: () => [],
    manager, proxyPoller: { snapshot: () => null },
    loadManifest: (n) => { throw new Error(`no such team "${n}"`); },
    restartClodex: () => {}, restartSession: () => {}, peerProxyView: () => null,
    readSessionArgs: () => ({ ok: false }), applySessionArgs: () => ({ ok: true }),
    readSkillCatalog: () => ({ ok: false }), applySessionSkills: () => ({ ok: false }),
    fetchProxyContext: () => {}, fetchProxyReport: () => {}, fetchProxyBust: () => {},
    fetchSessionFiles: () => {}, fetchFilePeek: () => {}, fetchFileDiff: () => {},
    CLAUDE_TOOLS: ['Bash', 'Read'],
    getPromptLibrary: () => ({ list: () => [] }),
    getAgentLibrary: () => ({ list: () => [] }),
    getSkillLibrary: () => ({ list: () => [] }),
    getPersistence: () => ({ get: () => undefined, setStripLevel: () => {} }),
    getUiSettings: () => uiSettings,
    getWorkspaces: () => workspaces,
    getNotifications: () => null,
    getRemoteServer: () => srv, setRemoteServer: (v) => { srv = v; }, setRemoteError: () => {},
    readRemoteEnvToken: () => null, resolveRemoteToken: (a, b) => a || b || null,
    appVersion: '9.9.9', isPackaged: () => false,
  };
  return { deps, createCalls };
}

function captureOptions(deps) {
  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  let opts = null;
  remoteMod.RemoteServer = function (o) {
    opts = o;
    return { start: () => Promise.resolve(), stop() {}, port: 0, notifySessions() {}, setWtermCallbacks() {} };
  };
  try { createRemoteWiring(deps).syncRemoteServer(); }
  finally { remoteMod.RemoteServer = orig; }
  return opts;
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

async function withNode(extra, fn) {
  const { deps, createCalls } = makeDeps();
  const s = new RemoteServer({ ...captureOptions(deps), ...extra });
  await s.start();
  try { return await fn(s.port, { createCalls }); } finally { s.stop(); }
}

test('RESOURCES: every (resource, verb) answers on a fully-injected node, and every name is a literal path in remote.js', async () => {
  const seen = [];
  await withNode({}, async (port) => {
    for (const r of RESOURCES) {
      assert.ok(
        REMOTE_SRC.includes(`'/api/${r.name}'`),
        `remote.js spells no literal '/api/${r.name}' — the constant advertises a path the router does not name`,
      );
      for (const verb of r.verbs) {
        const p = verb === 'list' || r.singular === r.name
          ? `/api/${r.name}`
          : `/api/${r.name}/alice`;
        const res = await req(port, p);
        assert.notStrictEqual(res.status, 404, `${r.name}.${verb} → GET ${p} answered 404`);
        seen.push(`${r.name}.${verb}`);
      }
    }
  });
  assert.deepStrictEqual(seen, ['sessions.list', 'sessions.get', 'workspaces.list', 'catalogs.get'],
    'the walk must visit every shipped row — an empty or shortened walk passes vacuously');
  assert.ok(RESOURCES.length >= 3, 'the walk covered fewer than the 3 shipped resources');
});

test('GET /api/resources: the document a fully-injected node serves', async () => {
  await withNode({}, async (port) => {
    const r = await req(port, '/api/resources');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true, version: 1, resources: RESOURCES });
  });
});

test('hello carries the resources cap', async () => {
  await withNode({}, async (port) => {
    const caps = JSON.parse((await req(port, '/api/peer/hello')).body).caps;
    assert.ok(caps.includes('resources'), `hello caps lack 'resources': ${JSON.stringify(caps)}`);
  });
});

test('GET /api/workspaces: the four-key row, and nothing of the window geometry', async () => {
  await withNode({}, async (port) => {
    const r = await req(port, '/api/workspaces');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), {
      ok: true,
      workspaces: [
        { id: 'ws-alpha', name: 'Alpha', open: true, lastFocusedAt: 1700000000000 },
        { id: 'ws-beta', name: 'Beta', open: false, lastFocusedAt: null },
      ],
    });
  });
});

test('workspaces: 501 and absent from /api/resources when listWorkspaces is not injected', async () => {
  await withNode({ listWorkspaces: null }, async (port) => {
    assert.strictEqual((await req(port, '/api/workspaces')).status, 501);
    const names = JSON.parse((await req(port, '/api/resources')).body).resources.map(r => r.name);
    assert.deepStrictEqual(names, ['sessions', 'catalogs']);
  });
});

test('catalogs: absent from /api/resources when getCatalogs is not injected', async () => {
  await withNode({ getCatalogs: null }, async (port) => {
    const names = JSON.parse((await req(port, '/api/resources')).body).resources.map(r => r.name);
    assert.deepStrictEqual(names, ['sessions', 'workspaces']);
  });
});

const ALICE_ROW = {
  name: 'alice', type: 'claude', workspace: 'Alpha', workspaceId: 'ws-alpha',
  stats: { model: null, cost: null, requests: null, ctxTok: null, ctxSize: null, ctxPct: null },
  activity: 'idle',
};

test('GET /api/sessions/:name: 200 with the whole row the list serves, plus activity', async () => {
  await withNode({}, async (port) => {
    const r = await req(port, '/api/sessions/alice');
    assert.strictEqual(r.status, 200);
    const { session } = JSON.parse(r.body);
    assert.deepStrictEqual({ ...session, cwd: undefined }, { ...ALICE_ROW, cwd: undefined });
    assert.ok(session.cwd, 'the row carries a cwd');
    const list = JSON.parse((await req(port, '/api/sessions')).body).sessions;
    assert.deepStrictEqual(session, list.find(s => s.name === 'alice'));
  });
});

test('GET /api/sessions/:name: 404 for an unknown name and for a dead session', async () => {
  await withNode({}, async (port) => {
    const miss = await req(port, '/api/sessions/nobody');
    assert.strictEqual(miss.status, 404);
    assert.deepStrictEqual(JSON.parse(miss.body), { ok: false, error: 'Session not found' });
    assert.strictEqual((await req(port, '/api/sessions/ghost')).status, 404, 'a _dead session is not a session');
  });
});

test('GET /api/sessions/:name: 400 on a name NAME_RE refuses', async () => {
  await withNode({}, async (port) => {
    const r = await req(port, '/api/sessions/bad%20name');
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: false, error: 'bad session name' });
    assert.strictEqual((await req(port, `/api/sessions/${'x'.repeat(65)}`)).status, 400);
  });
});

test('route order: POST /api/sessions still reaches createSession', async () => {
  await withNode({}, async (port, { createCalls }) => {
    const body = JSON.stringify({ name: 'newbie', type: 'claude', cwd: '/tmp/newbie' });
    const r = await req(port, '/api/sessions', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    assert.strictEqual(r.status, 200, `create answered ${r.status}: ${r.body}`);
    assert.strictEqual(JSON.parse(r.body).name, 'newbie');
    assert.strictEqual(createCalls.length, 1, 'the create closure ran');
    assert.strictEqual(createCalls[0][0], 'newbie');
  });
});

test('GET /api/sessions?workspace=: filters by workspace name and by id', async () => {
  await withNode({}, async (port) => {
    const names = async (q) => JSON.parse((await req(port, `/api/sessions${q}`)).body).sessions.map(s => s.name);
    assert.deepStrictEqual(await names(''), ['alice', 'bob'], 'both live sessions unfiltered');
    assert.deepStrictEqual(await names('?workspace=Alpha'), ['alice'], 'filtered by display name');
    assert.deepStrictEqual(await names('?workspace=ws-alpha'), ['alice'], 'filtered by id');
    assert.deepStrictEqual(await names('?workspace=Beta'), ['bob']);
    assert.deepStrictEqual(await names('?workspace=ws-beta'), ['bob']);
  });
});

test('GET /api/sessions?workspace=: an unknown value is an empty list, not an error', async () => {
  await withNode({}, async (port) => {
    const r = await req(port, '/api/sessions?workspace=ws-nope');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true, sessions: [] });
  });
});
