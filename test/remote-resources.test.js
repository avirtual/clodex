'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRemoteWiring } = require('../remote-wiring');
const { RemoteServer, RESOURCES } = require('../remote');
const { createTicketsStore } = require('../tickets-store');
const { mkTmpRoot } = require('./lib/tmp-roots');

const REMOTE_SRC = fs.readFileSync(path.join(__dirname, '..', 'remote.js'), 'utf-8');

const WORKSPACES = [
  { id: 'ws-alpha', name: 'Alpha', open: true, lastFocusedAt: 1700000000000, bounds: { x: 1, y: 2, width: 3, height: 4 } },
  { id: 'ws-beta', name: 'Beta', bounds: null },
];

const PEER_STATUS = {
  id: 'boxy', label: 'Boxy', url: 'http://127.0.0.1:7070', direct: true, online: true,
  host: 'boxy-host', version: '9.9.9', caps: ['send'], platform: 'linux', srcDir: null,
  webHost: null, wirescope: null, sessions: [{ name: 'remote-seat', type: 'claude' }],
};

const TEAM_ALPHA = { root: null, lead: 'alpha-lead', roles: { lead: { dispatch: 'session' } } };
const TEAM_BETA = { root: null, lead: 'beta-lead', roles: { lead: { dispatch: 'session' } } };

const TICKETS_ALPHA = [
  { id: 't1', state: 'open', assignee: 'hand', title: 'alpha open' },
  { id: 't2', state: 'done', assignee: 'hand', title: 'alpha done' },
  { id: 't9', state: 'cancelled', assignee: null, title: 'alpha cancelled' },
];
const TICKETS_BETA = [
  { id: 't1', state: 'done', assignee: 'other', title: 'beta done' },
  { id: 't7', state: 'open', assignee: 'other', title: 'beta only' },
];

const AGENT_MD = '---\ndescription: a library agent\nmodel: opus\n---\nbody text\n';

function makeDeps() {
  const root = mkTmpRoot('remote-resources-');
  const registry = path.join(root, 'registry');
  const alphaRoot = path.join(root, 'proj-alpha');
  const betaRoot = path.join(root, 'proj-beta');
  const teams = {
    alpha: { ...TEAM_ALPHA, name: 'alpha', root: alphaRoot },
    beta: { ...TEAM_BETA, name: 'beta', root: betaRoot },
  };
  const seedStore = createTicketsStore({ fs, path, clodexHome: registry });
  seedStore.save(alphaRoot, TICKETS_ALPHA);
  seedStore.save(betaRoot, TICKETS_BETA);

  const sandboxInstances = {
    boxy: { status: async () => ({ state: 'running', ref: 'master', sha: 'deadbeef', ports: { web: 7080 } }) },
  };
  const sandboxManager = {
    list: () => [{ id: 'boxy', label: 'Boxy' }],
    get: (id) => sandboxInstances[id] || null,
  };

  let srv = null;
  const createCalls = [];
  const manager = {
    sessions: new Map([
      ['alice', { name: 'alice', type: 'claude', cwd: path.join(root, 'a'), workspaceId: 'ws-alpha' }],
      ['bob', { name: 'bob', type: 'codex', cwd: path.join(root, 'b'), workspaceId: 'ws-beta' }],
      ['ghost', { name: 'ghost', type: 'claude', cwd: path.join(root, 'g'), workspaceId: 'ws-alpha', _dead: true }],
    ]),
    create: async (...args) => { createCalls.push(args); return { name: args[0], type: args[1], pid: 7 }; },
    teamActivity: (name) => ({ roles: { lead: { dispatch: 'session', live: [`${name}-lead`], open: [], last: null } } }),
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
    REGISTRY_DIR: registry, OUTBOX_DIR: path.join(root, 'outbox'), SELF_LABEL: 'testnode',
    parseCtxFile: () => null, ensureDir: () => {}, homeRelativize: (x) => x,
    claimOutbox: () => [], listOutboxOrigins: () => [],
    manager, proxyPoller: { snapshot: () => null },
    loadManifest: (n) => {
      if (!teams[n]) throw new Error(`no such team "${n}"`);
      return teams[n];
    },
    listTeams: () => Object.keys(teams).sort(),
    getPeerManager: () => ({ statuses: () => [{ ...PEER_STATUS, sessions: [...PEER_STATUS.sessions] }] }),
    getTunnelManager: () => ({ statuses: () => [{ id: 'boxy', kind: 'ssh', state: 'up' }] }),
    getWebTunnelManager: () => ({ statuses: () => [{ id: 'boxy', kind: 'ssh', state: 'down' }] }),
    getSandboxManager: () => sandboxManager,
    restartClodex: () => {}, restartSession: () => {}, peerProxyView: () => null,
    readSessionArgs: () => ({ ok: false }), applySessionArgs: () => ({ ok: true }),
    readSkillCatalog: () => ({ ok: false }), applySessionSkills: () => ({ ok: false }),
    fetchProxyContext: () => {}, fetchProxyReport: () => {}, fetchProxyBust: () => {},
    fetchSessionFiles: () => {}, fetchFilePeek: () => {}, fetchFileDiff: () => {},
    CLAUDE_TOOLS: ['Bash', 'Read'],
    getPromptLibrary: () => ({ list: () => [] }),
    getAgentLibrary: () => ({
      list: () => [{
        name: 'scout', description: 'a library agent', model: 'opus', tools: 'Read',
        disallowedTools: '', file: 'scout.md', meta: { description: 'a library agent' }, body: 'body text',
      }],
      raw: (n) => (n === 'scout' ? AGENT_MD : null),
    }),
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
      if (opts.stream) {
        let body = '';
        res.on('data', (d) => {
          body += d;
          if (opts.until && !body.includes(opts.until)) return;
          r.destroy();
          resolve({ status: res.statusCode, body });
        });
        return;
      }
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', (e) => { if (!opts.stream) reject(e); });
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

const WALK_ID = {
  sessions: 'alice', peers: 'boxy', teams: 'alpha', tickets: 't7', sandboxes: 'boxy', agents: 'scout',
};

const TRANSCRIPT_OUT = { ok: true, messages: [{ seq: 1, role: 'user', text: 'hi' }, { seq: 2, role: 'assistant', text: 'yo' }], cursor: 1, complete: true };
const QUERY_OUT = { ok: true, report: { usd: 1.5 } };

function subresourceFixture() {
  const calls = [];
  return {
    calls,
    opts: {
      getTranscript: (name, limit, since) => {
        calls.push({ route: 'transcript', name, limit, since });
        return name === 'ghost' ? { ok: false, error: 'Session not found' } : TRANSCRIPT_OUT;
      },
      getAttachInfo: (name) => {
        calls.push({ route: 'attach', name });
        return name === 'ghost' ? { ok: false } : { ok: true, scrollback: Buffer.from('hi'), cols: 100, rows: 30 };
      },
      sendInput: (name, data) => {
        calls.push({ route: 'input', name, data });
        return name === 'ghost' ? { ok: false } : { ok: true };
      },
      resizePty: (name, cols, rows) => {
        calls.push({ route: 'resize', name, cols, rows });
        return name === 'ghost' ? { ok: false } : { ok: true };
      },
      query: (name, kind, args) => {
        calls.push({ route: 'query', name, kind, args });
        return name === 'ghost' ? { ok: false, error: 'no such session' } : QUERY_OUT;
      },
    },
  };
}

const SUB_WALK = {
  transcript: { method: 'GET' },
  query: { method: 'POST', body: () => JSON.stringify({ kind: 'report', args: {} }) },
  attach: { method: 'GET', stream: true },
  control: { method: 'POST', body: () => JSON.stringify({ action: 'acquire', client: 'walk' }), capture: (st, res) => { st.token = JSON.parse(res.body).token; } },
  input: { method: 'POST', body: (st) => JSON.stringify({ token: st.token, data: 'x' }) },
  resize: { method: 'POST', body: (st) => JSON.stringify({ token: st.token, cols: 90, rows: 25 }) },
};

test('RESOURCES: every (resource, verb) answers on a fully-injected node, and every name is a literal path in remote.js', async () => {
  const seen = [];
  const walkState = { token: null };
  const fixture = subresourceFixture();
  await withNode(fixture.opts, async (port) => {
    for (const r of RESOURCES) {
      assert.ok(
        REMOTE_SRC.includes(`'/api/${r.name}'`),
        `remote.js spells no literal '/api/${r.name}' — the constant advertises a path the router does not name`,
      );
      for (const verb of r.verbs) {
        const single = !(verb === 'list' || r.singular === r.name);
        if (single) {
          assert.ok(WALK_ID[r.name], `no walk id seeded for ${r.name}.get — the walk cannot exercise it`);
        }
        const p = single ? `/api/${r.name}/${WALK_ID[r.name]}` : `/api/${r.name}`;
        const res = await req(port, p);
        assert.strictEqual(res.status, 200, `${r.name}.${verb} → GET ${p} answered ${res.status}: ${res.body}`);
        seen.push(`${r.name}.${verb}`);
      }
      for (const [sub, verbs] of Object.entries(r.subresources || {})) {
        assert.ok(
          REMOTE_SRC.includes(`sub === '${sub}'`),
          `remote.js dispatches on no literal sub === '${sub}' — the constant advertises a subresource the router does not name`,
        );
        const walk = SUB_WALK[sub];
        assert.ok(walk, `no walk shape seeded for ${r.name}/${sub} — the walk cannot exercise it`);
        for (const verb of verbs) {
          assert.strictEqual(walk.method.toLowerCase(), verb, `${r.name}/${sub} advertises ${verb}, the walk sends ${walk.method}`);
          const p = `/api/${r.name}/${WALK_ID[r.name]}/${sub}`;
          const body = walk.body ? walk.body(walkState) : undefined;
          const res = await req(port, p, { method: walk.method, body, stream: walk.stream, headers: body ? { 'content-type': 'application/json' } : {} });
          assert.strictEqual(res.status, 200, `${r.name}/${sub}.${verb} → ${walk.method} ${p} answered ${res.status}: ${res.body}`);
          if (walk.capture) walk.capture(walkState, res);
          seen.push(`${r.name}/${sub}.${verb}`);
        }
      }
    }
  });
  assert.deepStrictEqual(seen, [
    'sessions.list', 'sessions.get', 'sessions/transcript.get', 'sessions/query.post',
    'sessions/attach.get', 'sessions/control.post', 'sessions/input.post', 'sessions/resize.post', 'workspaces.list',
    'peers.list', 'peers.get', 'teams.list', 'teams.get', 'tickets.list', 'tickets.get',
    'sandboxes.list', 'sandboxes.get', 'agents.list', 'agents.get', 'catalogs.get',
  ], 'the walk must visit every shipped row — an empty or shortened walk passes vacuously');
  assert.strictEqual(seen.length, 20, 'the walk entered 14 resource verbs plus the 6 session subresources');
  assert.strictEqual(RESOURCES.length, 8, 'the walk covered fewer than the 8 shipped resources');
});

test('GET /api/sessions/:name/transcript: the status and body the deleted /api/transcript/ served, limit and since threaded', async () => {
  const fixture = subresourceFixture();
  await withNode(fixture.opts, async (port) => {
    const r = await req(port, '/api/sessions/alice/transcript');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), TRANSCRIPT_OUT);
    assert.deepStrictEqual(fixture.calls[0], { route: 'transcript', name: 'alice', limit: 100, since: null }, 'the no-query defaults');
    await req(port, '/api/sessions/alice/transcript?limit=9999&since=4');
    assert.deepStrictEqual(fixture.calls[1], { route: 'transcript', name: 'alice', limit: 500, since: 4 }, 'limit clamped at 500, since parsed');
    const miss = await req(port, '/api/sessions/ghost/transcript');
    assert.strictEqual(miss.status, 404, 'a not-ok callback result is still a 404, as the deleted route answered');
    assert.deepStrictEqual(JSON.parse(miss.body), { ok: false, error: 'Session not found' });
  });
});

test('POST /api/sessions/:name/query: the status and body the deleted /api/query/ served, 501 without the callback', async () => {
  const fixture = subresourceFixture();
  const post = (port, p, body) => req(port, p, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  await withNode(fixture.opts, async (port) => {
    const r = await post(port, '/api/sessions/alice/query', JSON.stringify({ kind: 'report', args: { detail: true } }));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), QUERY_OUT);
    assert.deepStrictEqual(fixture.calls[0], { route: 'query', name: 'alice', kind: 'report', args: { detail: true } });
    assert.strictEqual((await post(port, '/api/sessions/alice/query', 'not json')).status, 400, 'bad JSON is a 400');
    const miss = await post(port, '/api/sessions/ghost/query', JSON.stringify({ kind: 'report' }));
    assert.strictEqual(miss.status, 404);
    assert.deepStrictEqual(JSON.parse(miss.body), { ok: false, error: 'no such session' });
  });
  await withNode({ ...fixture.opts, query: null }, async (port) => {
    const r = await post(port, '/api/sessions/alice/query', JSON.stringify({ kind: 'report' }));
    assert.strictEqual(r.status, 501);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: false, error: 'query not available' });
  });
});

test('the OLD transcript and query paths are gone — 404, no alias, no legacy shim', async () => {
  const fixture = subresourceFixture();
  await withNode(fixture.opts, async (port) => {
    assert.strictEqual((await req(port, '/api/transcript/alice')).status, 404, 'GET /api/transcript/:name still answers');
    assert.strictEqual((await req(port, '/api/transcript/alice?limit=5')).status, 404);
    const q = await req(port, '/api/query/alice', { method: 'POST', body: JSON.stringify({ kind: 'report' }), headers: { 'content-type': 'application/json' } });
    assert.strictEqual(q.status, 404, 'POST /api/query/:name still answers');
    assert.strictEqual(fixture.calls.length, 0, 'no old-path request reached a callback');
  });
  assert.ok(!REMOTE_SRC.includes("'/api/transcript/'"), "remote.js still spells the old '/api/transcript/' prefix");
  assert.ok(!REMOTE_SRC.includes("'/api/query/'"), "remote.js still spells the old '/api/query/' prefix");
});

test('the OLD attach/control/input/resize paths are gone — 404, no alias, no legacy shim', async () => {
  const fixture = subresourceFixture();
  const post = (port, p, body) => req(port, p, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  await withNode(fixture.opts, async (port) => {
    assert.strictEqual((await req(port, '/api/attach/alice')).status, 404, 'GET /api/attach/:name still answers');
    assert.strictEqual((await post(port, '/api/control/alice', JSON.stringify({ action: 'acquire' }))).status, 404, 'POST /api/control/:name still answers');
    assert.strictEqual((await post(port, '/api/input/alice', JSON.stringify({ data: 'x' }))).status, 404, 'POST /api/input/:name still answers');
    assert.strictEqual((await post(port, '/api/resize/alice', JSON.stringify({ cols: 90, rows: 25 }))).status, 404, 'POST /api/resize/:name still answers');
    assert.strictEqual(fixture.calls.length, 0, 'no old-path request reached a callback');
  });
  for (const old of ["'/api/attach/'", "'/api/control/'", "'/api/input/'", "'/api/resize/'"]) {
    assert.ok(!REMOTE_SRC.includes(old), `remote.js still spells the old ${old} prefix`);
  }
});

test('GET /api/sessions/:name/attach: the SSE the deleted /api/attach/ served, 501 without the callback', async () => {
  const fixture = subresourceFixture();
  await withNode(fixture.opts, async (port) => {
    const r = await req(port, '/api/sessions/alice/attach', { stream: true, until: 'event: replay' });
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /event: replay\ndata: /, 'the stream carries the replay frame the old route sent');
    const replay = JSON.parse(r.body.split('event: replay\ndata: ')[1].split('\n')[0]);
    assert.deepStrictEqual(
      { b64: replay.b64, cols: replay.cols, rows: replay.rows, holder: replay.holder },
      { b64: Buffer.from('hi').toString('base64'), cols: 100, rows: 30, holder: null },
    );
    const miss = await req(port, '/api/sessions/ghost/attach');
    assert.strictEqual(miss.status, 404, 'a not-ok callback result is still a 404');
    assert.deepStrictEqual(JSON.parse(miss.body), { ok: false, error: 'no such session' });
  });
  await withNode({ ...fixture.opts, getAttachInfo: null }, async (port) => {
    const r = await req(port, '/api/sessions/alice/attach');
    assert.strictEqual(r.status, 501);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: false, error: 'attach not available' });
  });
});

test('sessions/control|input|resize: control-token semantics and resize bounds, byte for byte as the deleted routes served', async () => {
  const fixture = subresourceFixture();
  const post = (port, p, body) => req(port, p, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  await withNode(fixture.opts, async (port) => {
    const acq = await post(port, '/api/sessions/alice/control', JSON.stringify({ action: 'acquire', client: 'walker' }));
    assert.strictEqual(acq.status, 200);
    const token = JSON.parse(acq.body).token;
    assert.match(token, /^[0-9a-f]{32}$/, 'acquire mints a 16-byte hex token');

    const wrong = await post(port, '/api/sessions/alice/input', JSON.stringify({ token: 'bogus', data: 'evil' }));
    assert.strictEqual(wrong.status, 403);
    assert.deepStrictEqual(JSON.parse(wrong.body), { ok: false, error: 'not the control holder' });

    assert.strictEqual((await post(port, '/api/sessions/alice/input', JSON.stringify({ token, data: 'ls\r' }))).status, 200);
    assert.deepStrictEqual(fixture.calls.at(-1), { route: 'input', name: 'alice', data: 'ls\r' });

    for (const dims of [{ cols: 19, rows: 25 }, { cols: 501, rows: 25 }, { cols: 90, rows: 4 }, { cols: 90, rows: 301 }]) {
      const bad = await post(port, '/api/sessions/alice/resize', JSON.stringify({ token, ...dims }));
      assert.strictEqual(bad.status, 400, `resize ${JSON.stringify(dims)} was accepted`);
      assert.deepStrictEqual(JSON.parse(bad.body), { ok: false, error: 'bad dimensions' });
    }
    assert.strictEqual((await post(port, '/api/sessions/alice/resize', JSON.stringify({ token, cols: 20, rows: 300 }))).status, 200, 'the bounds are inclusive');

    assert.strictEqual((await post(port, '/api/sessions/alice/control', 'not json')).status, 400, 'bad JSON is a 400');
    assert.deepStrictEqual(
      JSON.parse((await post(port, '/api/sessions/alice/control', JSON.stringify({ action: 'nope' }))).body),
      { ok: false, error: 'bad action' },
    );
    assert.strictEqual((await post(port, '/api/sessions/ghost/control', JSON.stringify({ action: 'acquire' }))).status, 404);
    assert.strictEqual((await post(port, '/api/sessions/alice/control', JSON.stringify({ action: 'release', token }))).status, 200);
    assert.strictEqual(
      (await post(port, '/api/sessions/alice/control', JSON.stringify({ action: 'release', token }))).status, 403,
      'the token died with the release',
    );
  });
  await withNode({ ...fixture.opts, sendInput: null }, async (port) => {
    assert.deepStrictEqual(JSON.parse((await post(port, '/api/sessions/alice/control', '{}')).body), { ok: false, error: 'control not available' });
    assert.deepStrictEqual(JSON.parse((await post(port, '/api/sessions/alice/input', '{}')).body), { ok: false, error: 'input not available' });
  });
  await withNode({ ...fixture.opts, resizePty: null }, async (port) => {
    const r = await post(port, '/api/sessions/alice/resize', '{}');
    assert.strictEqual(r.status, 501);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: false, error: 'resize not available' });
  });
});

test('subresource gating: a node with the attach/control callbacks nulled omits them from the document AND 501s the routes', async () => {
  const fixture = subresourceFixture();
  const nulled = { ...fixture.opts, getAttachInfo: null, sendInput: null, resizePty: null };
  await withNode(nulled, async (port) => {
    const doc = JSON.parse((await req(port, '/api/resources')).body);
    const sessions = doc.resources.find((r) => r.name === 'sessions');
    assert.deepStrictEqual(
      Object.keys(sessions.subresources), ['transcript', 'query'],
      'the document advertises a subresource this node cannot serve',
    );
    assert.strictEqual((await req(port, '/api/sessions/alice/attach')).status, 501);

    for (const [sub] of Object.entries(sessions.subresources)) {
      const walk = SUB_WALK[sub];
      const body = walk.body ? walk.body({ token: null }) : undefined;
      const res = await req(port, `/api/sessions/alice/${sub}`, {
        method: walk.method, body, stream: walk.stream,
        headers: body ? { 'content-type': 'application/json' } : {},
      });
      assert.strictEqual(res.status, 200, `served ${sub} answered ${res.status}: ${res.body}`);
    }
  });
});

test('/api/sessions/:name/<anything else>: 404, and a deeper path is not read as a subresource', async () => {
  const fixture = subresourceFixture();
  await withNode(fixture.opts, async (port) => {
    for (const p of ['/api/sessions/alice/nope', '/api/sessions/alice/transcript/extra', '/api/sessions/alice/query']) {
      const r = await req(port, p);
      assert.strictEqual(r.status, 404, `GET ${p} answered ${r.status}`);
      assert.deepStrictEqual(JSON.parse(r.body), { ok: false, error: 'not found' });
    }
    const wrongMethod = await req(port, '/api/sessions/alice/transcript', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.strictEqual(wrongMethod.status, 404, 'the subresource is dispatched on (method, sub), not on sub alone');
    assert.strictEqual(fixture.calls.length, 0, 'no bad-subresource request reached a callback');
  });
});

test('GET /api/sessions/%ZZ: a malformed escape is a 400 bad session name, not a 500', async () => {
  await withNode({}, async (port) => {
    for (const p of ['/api/sessions/%ZZ', '/api/sessions/%E0%A4%A/transcript']) {
      const r = await req(port, p);
      assert.strictEqual(r.status, 400, `${p} answered ${r.status}: ${r.body}`);
      assert.deepStrictEqual(JSON.parse(r.body), { ok: false, error: 'bad session name' });
    }
  });
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
    assert.deepStrictEqual(names, ['sessions', 'peers', 'teams', 'tickets', 'sandboxes', 'agents', 'catalogs']);
  });
});

test('catalogs: absent from /api/resources when getCatalogs is not injected', async () => {
  await withNode({ getCatalogs: null }, async (port) => {
    const names = JSON.parse((await req(port, '/api/resources')).body).resources.map(r => r.name);
    assert.deepStrictEqual(names, ['sessions', 'workspaces', 'peers', 'teams', 'tickets', 'sandboxes', 'agents']);
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

const PEER_ROW = {
  id: 'boxy', label: 'Boxy', url: 'http://127.0.0.1:7070', direct: true, online: true,
  host: 'boxy-host', version: '9.9.9', caps: ['send'], platform: 'linux', srcDir: null,
  webHost: null, wirescope: null,
  tunnel: { id: 'boxy', kind: 'ssh', state: 'up' },
  webTunnel: { id: 'boxy', kind: 'ssh', state: 'down' },
};

test('GET /api/peers: the composed row, with the per-peer sessions array dropped', async () => {
  await withNode({}, async (port) => {
    const r = await req(port, '/api/peers');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true, peers: [PEER_ROW] });
    assert.ok(!('sessions' in JSON.parse(r.body).peers[0]), 'a list row carries no sessions array');
  });
});

test('GET /api/peers/:id: 200 keeps sessions, 404 unknown, 400 bad id', async () => {
  await withNode({}, async (port) => {
    const r = await req(port, '/api/peers/boxy');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), {
      ok: true, peer: { ...PEER_ROW, sessions: [{ name: 'remote-seat', type: 'claude' }] },
    });
    const miss = await req(port, '/api/peers/nobody');
    assert.strictEqual(miss.status, 404);
    assert.deepStrictEqual(JSON.parse(miss.body), { ok: false, error: 'Peer not found' });
    const bad = await req(port, '/api/peers/bad%20id');
    assert.strictEqual(bad.status, 400);
    assert.deepStrictEqual(JSON.parse(bad.body), { ok: false, error: 'bad peer id' });
  });
});

test('peers: 501 and absent from /api/resources when listPeers is not injected', async () => {
  await withNode({ listPeers: null }, async (port) => {
    assert.strictEqual((await req(port, '/api/peers')).status, 501);
    assert.strictEqual((await req(port, '/api/peers/boxy')).status, 501);
    const names = JSON.parse((await req(port, '/api/resources')).body).resources.map(r => r.name);
    assert.ok(!names.includes('peers'), `peers is still advertised: ${names.join(',')}`);
  });
});

test('GET /api/teams: the name rows, and the single get folds in activity', async () => {
  await withNode({}, async (port) => {
    const list = await req(port, '/api/teams');
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(JSON.parse(list.body), { ok: true, teams: [{ name: 'alpha' }, { name: 'beta' }] });
    const one = await req(port, '/api/teams/alpha');
    assert.strictEqual(one.status, 200);
    const { team } = JSON.parse(one.body);
    assert.strictEqual(team.name, 'alpha');
    assert.strictEqual(team.lead, 'alpha-lead');
    assert.deepStrictEqual(team.activity, {
      roles: { lead: { dispatch: 'session', live: ['alpha-lead'], open: [], last: null } },
    }, 'the single get folds in teamActivity');
  });
});

test('GET /api/teams/:name: 404 unknown, 400 bad name', async () => {
  await withNode({}, async (port) => {
    const miss = await req(port, '/api/teams/nosuch');
    assert.strictEqual(miss.status, 404);
    assert.deepStrictEqual(JSON.parse(miss.body), { ok: false, error: 'Team not found' });
    const bad = await req(port, '/api/teams/bad%20name');
    assert.strictEqual(bad.status, 400);
    assert.deepStrictEqual(JSON.parse(bad.body), { ok: false, error: 'bad team name' });
  });
});

test('teams: 501 and absent from /api/resources when listTeams is not injected', async () => {
  await withNode({ listTeams: null }, async (port) => {
    assert.strictEqual((await req(port, '/api/teams')).status, 501);
    assert.strictEqual((await req(port, '/api/teams/alpha')).status, 501);
    const names = JSON.parse((await req(port, '/api/resources')).body).resources.map(r => r.name);
    assert.ok(!names.includes('teams'), `teams is still advertised: ${names.join(',')}`);
  });
});

test('GET /api/tickets: every board, each row tagged with its team', async () => {
  await withNode({}, async (port) => {
    const r = await req(port, '/api/tickets');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), {
      ok: true,
      tickets: [
        { id: 't1', state: 'open', assignee: 'hand', title: 'alpha open', team: 'alpha' },
        { id: 't2', state: 'done', assignee: 'hand', title: 'alpha done', team: 'alpha' },
        { id: 't9', state: 'cancelled', assignee: null, title: 'alpha cancelled', team: 'alpha' },
        { id: 't1', state: 'done', assignee: 'other', title: 'beta done', team: 'beta' },
        { id: 't7', state: 'open', assignee: 'other', title: 'beta only', team: 'beta' },
      ],
    }, 'both seeded boards are walked — a one-team walk cannot see the ambiguity rule at all');
  });
});

test('GET /api/tickets?team=&state=: the two filters, and the four-value state enum', async () => {
  await withNode({}, async (port) => {
    const ids = async (q) => JSON.parse((await req(port, `/api/tickets${q}`)).body)
      .tickets.map(t => `${t.team}/${t.id}`);
    assert.deepStrictEqual(await ids('?team=alpha'), ['alpha/t1', 'alpha/t2', 'alpha/t9']);
    assert.deepStrictEqual(await ids('?state=open'), ['alpha/t1', 'beta/t7']);
    assert.deepStrictEqual(await ids('?state=done'), ['alpha/t2', 'beta/t1']);
    assert.deepStrictEqual(await ids('?state=cancelled'), ['alpha/t9']);
    assert.deepStrictEqual(await ids('?state=all'), await ids(''), 'all is the default');
    assert.deepStrictEqual(await ids('?team=beta&state=open'), ['beta/t7'], 'the filters compose');
  });
});

test('GET /api/tickets?state=: a value outside the enum is a 400, not an empty list', async () => {
  await withNode({}, async (port) => {
    const r = await req(port, '/api/tickets?state=review');
    assert.strictEqual(r.status, 400, 'review is a loop step, not one of the four stored states');
    assert.deepStrictEqual(JSON.parse(r.body), {
      ok: false, error: 'bad state "review" — one of open, done, cancelled, all',
    });
    assert.strictEqual((await req(port, '/api/tickets?state=')).status, 200, 'an empty state reads as the default');
  });
});

test('GET /api/tickets/:id: an id on two boards is ambiguous, and names both candidates', async () => {
  await withNode({}, async (port) => {
    const r = await req(port, '/api/tickets/t1');
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(JSON.parse(r.body), {
      ok: false, error: 'ambiguous ticket id', candidates: ['alpha', 'beta'],
    });
    const scoped = await req(port, '/api/tickets/t1?team=beta');
    assert.strictEqual(scoped.status, 200, '?team= disambiguates');
    assert.deepStrictEqual(JSON.parse(scoped.body).ticket, {
      id: 't1', state: 'done', assignee: 'other', title: 'beta done', team: 'beta',
    });
  });
});

test('GET /api/tickets/:id: a unique id resolves with no ?team=, 404 unknown, 400 bad id', async () => {
  await withNode({}, async (port) => {
    const uniq = await req(port, '/api/tickets/t7');
    assert.strictEqual(uniq.status, 200);
    assert.deepStrictEqual(JSON.parse(uniq.body).ticket, {
      id: 't7', state: 'open', assignee: 'other', title: 'beta only', team: 'beta',
    });
    const miss = await req(port, '/api/tickets/t404');
    assert.strictEqual(miss.status, 404);
    assert.deepStrictEqual(JSON.parse(miss.body), { ok: false, error: 'Ticket not found' });
    assert.strictEqual((await req(port, '/api/tickets/t7?team=alpha')).status, 404,
      'a real id on the wrong board is a miss, not a hit');
    const bad = await req(port, '/api/tickets/nope');
    assert.strictEqual(bad.status, 400);
    assert.deepStrictEqual(JSON.parse(bad.body), { ok: false, error: 'bad ticket id' });
  });
});

test('tickets: 501 and absent from /api/resources when listTickets is not injected', async () => {
  await withNode({ listTickets: null }, async (port) => {
    assert.strictEqual((await req(port, '/api/tickets')).status, 501);
    assert.strictEqual((await req(port, '/api/tickets/t1')).status, 501);
    const names = JSON.parse((await req(port, '/api/resources')).body).resources.map(r => r.name);
    assert.ok(!names.includes('tickets'), `tickets is still advertised: ${names.join(',')}`);
  });
});

test('GET /api/sandboxes: the id/label list, and the single get adds the async status', async () => {
  await withNode({}, async (port) => {
    const list = await req(port, '/api/sandboxes');
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(JSON.parse(list.body), { ok: true, sandboxes: [{ id: 'boxy', label: 'Boxy' }] });
    const one = await req(port, '/api/sandboxes/boxy');
    assert.strictEqual(one.status, 200);
    assert.deepStrictEqual(JSON.parse(one.body), {
      ok: true,
      sandbox: { id: 'boxy', label: 'Boxy', state: 'running', ref: 'master', sha: 'deadbeef', ports: { web: 7080 } },
    });
  });
});

test('GET /api/sandboxes/:id: 404 unknown, 400 on an id BOX_ID_RE refuses', async () => {
  await withNode({}, async (port) => {
    const miss = await req(port, '/api/sandboxes/nosuch');
    assert.strictEqual(miss.status, 404);
    assert.deepStrictEqual(JSON.parse(miss.body), { ok: false, error: 'Sandbox not found' });
    const bad = await req(port, '/api/sandboxes/Bad.Id');
    assert.strictEqual(bad.status, 400, 'BOX_ID_RE admits no dots and no capitals');
    assert.deepStrictEqual(JSON.parse(bad.body), { ok: false, error: 'bad sandbox id' });
  });
});

test('sandboxes: 501 and absent from /api/resources on a node with no sandbox manager', async () => {
  await withNode({ listSandboxes: null }, async (port) => {
    assert.strictEqual((await req(port, '/api/sandboxes')).status, 501);
    assert.strictEqual((await req(port, '/api/sandboxes/boxy')).status, 501);
    const names = JSON.parse((await req(port, '/api/resources')).body).resources.map(r => r.name);
    assert.ok(!names.includes('sandboxes'), `sandboxes is still advertised: ${names.join(',')}`);
  });
});

test('headless: no sandbox manager means no sandbox callbacks are wired at all', async () => {
  const { deps } = makeDeps();
  const opts = captureOptions({ ...deps, getSandboxManager: () => null });
  assert.strictEqual(opts.listSandboxes, undefined, 'a headless node wires no sandbox list');
  assert.strictEqual(opts.getSandbox, undefined, 'a headless node wires no sandbox get');
  assert.strictEqual(typeof opts.listPeers, 'function', 'the other four are unaffected');
});

test('GET /api/agents: the library rows, and the single get returns name + content', async () => {
  await withNode({}, async (port) => {
    const list = await req(port, '/api/agents');
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(JSON.parse(list.body), {
      ok: true,
      agents: [{ name: 'scout', description: 'a library agent', model: 'opus', tools: 'Read', disallowedTools: '' }],
    });
    const one = await req(port, '/api/agents/scout');
    assert.strictEqual(one.status, 200);
    assert.deepStrictEqual(JSON.parse(one.body), { ok: true, agent: { name: 'scout', content: AGENT_MD } });
  });
});

test('GET /api/agents/:name: 404 unknown, 400 bad name', async () => {
  await withNode({}, async (port) => {
    const miss = await req(port, '/api/agents/nosuch');
    assert.strictEqual(miss.status, 404);
    assert.deepStrictEqual(JSON.parse(miss.body), { ok: false, error: 'Agent not found' });
    const bad = await req(port, '/api/agents/bad%20name');
    assert.strictEqual(bad.status, 400);
    assert.deepStrictEqual(JSON.parse(bad.body), { ok: false, error: 'bad agent name' });
  });
});

test('agents: 501 and absent from /api/resources when listAgents is not injected', async () => {
  await withNode({ listAgents: null }, async (port) => {
    assert.strictEqual((await req(port, '/api/agents')).status, 501);
    assert.strictEqual((await req(port, '/api/agents/scout')).status, 501);
    const names = JSON.parse((await req(port, '/api/resources')).body).resources.map(r => r.name);
    assert.ok(!names.includes('agents'), `agents is still advertised: ${names.join(',')}`);
  });
});

const SECRET_KEYS = ['token', 'auth', 'secret', 'password'];

function findSecretKey(value, trail = '$') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findSecretKey(value[i], `${trail}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.includes(k.toLowerCase())) return `${trail}.${k}`;
    const hit = findSecretKey(v, `${trail}.${k}`);
    if (hit) return hit;
  }
  return null;
}

test('no read-only resource response carries a token/auth/secret/password key at any depth', async () => {
  const paths = [
    '/api/resources',
    '/api/peers', '/api/peers/boxy',
    '/api/teams', '/api/teams/alpha',
    '/api/tickets', '/api/tickets?team=alpha', '/api/tickets/t7',
    '/api/sandboxes', '/api/sandboxes/boxy',
    '/api/agents', '/api/agents/scout',
    '/api/sessions', '/api/sessions/alice', '/api/workspaces',
  ];
  await withNode({}, async (port) => {
    for (const p of paths) {
      const r = await req(port, p);
      assert.strictEqual(r.status, 200, `${p} answered ${r.status}, so the walk read no body`);
      const hit = findSecretKey(JSON.parse(r.body));
      assert.strictEqual(hit, null, `GET ${p} leaks a secret-shaped key at ${hit}`);
    }
  });
  assert.strictEqual(findSecretKey({ a: [{ b: { token: 'x' } }] }), '$.a[0].b.token',
    'the walker finds a key nested under an array — otherwise every assertion above passes vacuously');
});

test('route order: /api/peer/hello and /api/peer/roster still match ahead of the /api/peers branches', async () => {
  await withNode({}, async (port) => {
    const hello = await req(port, '/api/peer/hello');
    assert.strictEqual(hello.status, 200);
    assert.strictEqual(JSON.parse(hello.body).app, 'clodex', '/api/peer/hello is the hello, not a peer row');
    const roster = await req(port, '/api/peer/roster', {
      method: 'POST', body: JSON.stringify({ rv: 1, via: 'hub', roster: [] }),
      headers: { 'content-type': 'application/json' },
    });
    assert.notStrictEqual(roster.status, 404, '/api/peer/roster still reaches the relay handler');
  });
  assert.ok(
    REMOTE_SRC.indexOf("p === '/api/peer/hello'") < REMOTE_SRC.indexOf("p === '/api/peers'"),
    'the hello branch must be spelled before the peers branch',
  );
  assert.ok(
    REMOTE_SRC.indexOf("p === '/api/peer/roster'") < REMOTE_SRC.indexOf("p === '/api/peers'"),
    'the roster branch must be spelled before the peers branch',
  );
});
