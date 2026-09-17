'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
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

const NODE_LOG_SEED = [
  '2026-09-17T00:00:00.000Z  INFO  [app] booted',
  '2026-09-17T01:00:00.000Z  INFO  [remote] listening on 127.0.0.1:7777',
  '2026-09-17T02:00:00.000Z  WARN  [peer] handshake retried',
].join('\n') + '\n';

const FAKE_REPO = path.join(os.tmpdir(), 'clodex-walk-repo');
const FAKE_WORKTREES = [
  { path: FAKE_REPO, branch: 'master', head: 'abcdef12', isMain: true, detached: false, locked: false, prunable: false },
];

function makeDeps() {
  const root = mkTmpRoot('remote-resources-');
  const registry = path.join(root, 'registry');
  const alphaRoot = path.join(root, 'proj-alpha');
  const betaRoot = path.join(root, 'proj-beta');
  const teams = {
    alpha: { ...TEAM_ALPHA, name: 'alpha', root: alphaRoot },
    beta: { ...TEAM_BETA, name: 'beta', root: betaRoot },
  };
  const nodeLog = path.join(root, 'clodex.log');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(nodeLog, NODE_LOG_SEED);

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
    gitWorktree: {
      listWorktrees: async (repo) => (repo === FAKE_REPO
        ? { ok: true, repo, worktrees: FAKE_WORKTREES }
        : { ok: false, error: 'Not inside a git repository', repo: null, worktrees: [] }),
    },
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
    getNodeLogFile: () => nodeLog,
  };
  return { deps, createCalls, nodeLog };
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
    let settled = false;
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      if (opts.stream) {
        let body = '';
        res.on('data', (d) => {
          body += d;
          if (opts.until && !body.includes(opts.until)) return;
          settled = true;
          r.destroy();
          resolve({ status: res.statusCode, body });
        });
        return;
      }
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { settled = true; resolve({ status: res.statusCode, body }); });
    });
    r.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

async function withNode(extra, fn) {
  const { deps, createCalls, nodeLog } = makeDeps();
  const s = new RemoteServer({ ...captureOptions(deps), ...extra });
  await s.start();
  try { return await fn(s.port, { createCalls, nodeLog }); } finally { s.stop(); }
}

const WALK_ID = {
  sessions: 'alice', peers: 'boxy', teams: 'alpha', tickets: 't7', sandboxes: 'boxy', agents: 'scout',
};

const WALK_QUERY = { worktrees: `?repo=${encodeURIComponent(FAKE_REPO)}` };

const TRANSCRIPT_OUT = { ok: true, messages: [{ seq: 1, role: 'user', text: 'hi' }, { seq: 2, role: 'assistant', text: 'yo' }], cursor: 1, complete: true };
const QUERY_OUT = { ok: true, report: { usd: 1.5 } };
const ARGS_OUT = { ok: true, type: 'claude', extraArgs: ['--x'], catalogs: { agents: ['a1'] } };
const SKILLS_OUT = { ok: true, names: ['pdf'], disabledSkills: [], injectSkills: [] };

function subresourceFixture() {
  const calls = [];
  return {
    calls,
    opts: {
      getTranscript: (name, limit, since, after = null) => {
        calls.push({ route: 'transcript', name, limit, since, after });
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
      send: (name, text) => {
        calls.push({ route: 'dm', name, text });
        return name === 'ghost' ? { ok: false, error: 'no such session' } : { ok: true };
      },
      killSession: (name) => {
        calls.push({ route: 'kill', name });
        return name === 'ghost' ? { ok: false, error: 'no such session' } : { ok: true, name };
      },
      restartSession: (name, opts) => {
        calls.push({ route: 'restart', name, fresh: !!(opts && opts.fresh) });
        return name === 'ghost' ? { ok: false, error: 'Session not found in persistence' } : { ok: true, restarted: true };
      },
      getSessionArgs: (name) => {
        calls.push({ route: 'argsGet', name });
        return name === 'ghost' ? { ok: false } : ARGS_OUT;
      },
      setSessionArgs: (name, patch) => {
        calls.push({ route: 'argsSet', name, patch });
        return name === 'ghost' ? { ok: false, error: 'Session not found in persistence' } : { ok: true, restarted: !!patch.restart };
      },
      getSkillCatalog: (name) => {
        calls.push({ route: 'skillsGet', name });
        return name === 'ghost' ? { ok: false } : SKILLS_OUT;
      },
      setSessionSkills: (name, disabledSkills, injectSkills) => {
        calls.push({ route: 'skillsSet', name, disabledSkills, injectSkills });
        return name === 'ghost' ? { ok: false, error: 'Session not found in persistence' } : { ok: true };
      },
    },
  };
}

const SUB_WALK = {
  transcript: { get: { method: 'GET' } },
  query: { post: { method: 'POST', body: () => JSON.stringify({ kind: 'report', args: {} }) } },
  attach: { get: { method: 'GET', stream: true } },
  control: { post: { method: 'POST', body: () => JSON.stringify({ action: 'acquire', client: 'walk' }), capture: (st, res) => { st.token = JSON.parse(res.body).token; } } },
  input: { post: { method: 'POST', body: (st) => JSON.stringify({ token: st.token, data: 'x' }) } },
  resize: { post: { method: 'POST', body: (st) => JSON.stringify({ token: st.token, cols: 90, rows: 25 }) } },
  dm: { post: { method: 'POST', body: () => JSON.stringify({ text: 'hi' }) } },
  restart: { post: { method: 'POST', body: () => JSON.stringify({ fresh: false }) } },
  args: { get: { method: 'GET' }, patch: { method: 'PATCH', body: () => JSON.stringify({ extraArgs: ['--y'] }) } },
  skills: { get: { method: 'GET' }, patch: { method: 'PATCH', body: () => JSON.stringify({ disabledSkills: [] }) } },
};

const VERB_WALK = { list: 'GET', get: 'GET', delete: 'DELETE' };

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
        const p = single ? `/api/${r.name}/${WALK_ID[r.name]}` : `/api/${r.name}${WALK_QUERY[r.name] || ''}`;
        const method = VERB_WALK[verb];
        assert.ok(method, `no walk method seeded for the ${verb} verb — the walk cannot exercise it`);
        const res = await req(port, p, { method });
        assert.strictEqual(res.status, 200, `${r.name}.${verb} → ${method} ${p} answered ${res.status}: ${res.body}`);
        seen.push(`${r.name}.${verb}`);
      }
      const subs = Object.entries(r.subresources || {})
        .sort(([a], [b]) => (a === 'attach' ? 1 : 0) - (b === 'attach' ? 1 : 0));
      for (const [sub, verbs] of subs) {
        assert.ok(
          REMOTE_SRC.includes(`sub === '${sub}'`),
          `remote.js dispatches on no literal sub === '${sub}' — the constant advertises a subresource the router does not name`,
        );
        for (const verb of verbs) {
          const walk = SUB_WALK[sub] && SUB_WALK[sub][verb];
          assert.ok(walk, `no walk shape seeded for ${r.name}/${sub}.${verb} — the walk cannot exercise it`);
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
    'sessions.list', 'sessions.get', 'sessions.delete', 'sessions/transcript.get', 'sessions/query.post',
    'sessions/control.post', 'sessions/input.post', 'sessions/resize.post', 'sessions/dm.post',
    'sessions/restart.post', 'sessions/args.get', 'sessions/args.patch', 'sessions/skills.get',
    'sessions/skills.patch', 'sessions/attach.get', 'workspaces.list',
    'peers.list', 'peers.get', 'teams.list', 'teams.get', 'tickets.list', 'tickets.get',
    'sandboxes.list', 'sandboxes.get', 'agents.list', 'agents.get', 'worktrees.list', 'catalogs.get',
    'node/logs.get',
  ], 'the walk must visit every shipped row — an empty or shortened walk passes vacuously');
  assert.strictEqual(seen.length, 29, 'the walk entered 16 resource verbs, the sessions delete, and the 12 session subresource verbs');
  assert.strictEqual(RESOURCES.length, 10, 'the walk covered fewer than the 10 shipped resources');
});

test('GET /api/sessions/:name/transcript: the status and body the deleted /api/transcript/ served, limit and since threaded', async () => {
  const fixture = subresourceFixture();
  await withNode(fixture.opts, async (port) => {
    const r = await req(port, '/api/sessions/alice/transcript');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), TRANSCRIPT_OUT);
    assert.deepStrictEqual(fixture.calls[0], { route: 'transcript', name: 'alice', limit: 100, since: null, after: null }, 'the no-query defaults');
    await req(port, '/api/sessions/alice/transcript?limit=9999&since=4');
    assert.deepStrictEqual(fixture.calls[1], { route: 'transcript', name: 'alice', limit: 500, since: 4, after: null }, 'limit clamped at 500, since parsed');
    const miss = await req(port, '/api/sessions/ghost/transcript');
    assert.strictEqual(miss.status, 404, 'a not-ok callback result is still a 404, as the deleted route answered');
    assert.deepStrictEqual(JSON.parse(miss.body), { ok: false, error: 'Session not found' });
  });
});

test('GET .../transcript?after=: an ISO instant reaches the callback, `since` keeps its seq meaning', async () => {
  const fixture = subresourceFixture();
  await withNode(fixture.opts, async (port) => {
    const r = await req(port, '/api/sessions/alice/transcript?after=2026-09-17T02:00:00.000Z');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(fixture.calls[0],
      { route: 'transcript', name: 'alice', limit: 100, since: null, after: '2026-09-17T02:00:00.000Z' },
      'after arrives VERBATIM — the route does not re-serialize the operator\'s instant');

    await req(port, '/api/sessions/alice/transcript?since=4&after=2026-09-17T02:00:00.000Z');
    assert.deepStrictEqual(fixture.calls[1],
      { route: 'transcript', name: 'alice', limit: 100, since: 4, after: '2026-09-17T02:00:00.000Z' },
      'the two cursors are independent: since stays an integer seq, after an instant');

    await req(port, '/api/sessions/alice/transcript');
    assert.strictEqual(fixture.calls[2].after, null, 'no after query ⇒ null, not the empty string');
  });
});

test('GET .../transcript?after=: an unparseable instant is a 400 and never reaches the callback', async () => {
  const fixture = subresourceFixture();
  await withNode(fixture.opts, async (port) => {
    for (const bad of ['bogus', '', '30m', 'yesterday']) {
      const r = await req(port, `/api/sessions/alice/transcript?after=${encodeURIComponent(bad)}`);
      assert.strictEqual(r.status, 400, `after="${bad}" must be refused, not silently ignored`);
      assert.deepStrictEqual(JSON.parse(r.body), { ok: false, error: 'bad after (expected an ISO-8601 instant)' });
    }
    assert.strictEqual(fixture.calls.length, 0, 'a refused instant reached no transcript read');
  });
});

test('GET /api/node/logs: the current log file tailed, limit honoured and clamped, missing file is empty', async () => {
  await withNode({}, async (port, { nodeLog }) => {
    const all = JSON.parse((await req(port, '/api/node/logs')).body);
    assert.strictEqual(all.ok, true);
    assert.deepStrictEqual(all.lines, NODE_LOG_SEED.split('\n').filter(Boolean),
      'every seeded line, in file order, with no trailing empty');

    const one = JSON.parse((await req(port, '/api/node/logs?limit=1')).body);
    assert.deepStrictEqual(one.lines, ['2026-09-17T02:00:00.000Z  WARN  [peer] handshake retried'],
      'limit takes the NEWEST lines (a tail), not the oldest');

    const clamped = JSON.parse((await req(port, '/api/node/logs?limit=9999')).body);
    assert.strictEqual(clamped.lines.length, 3, 'an oversized limit clamps rather than erroring');

    fs.writeFileSync(nodeLog, `${NODE_LOG_SEED}2026-09-17T04:00:00.000Z  INFO  [app] appended\n`);
    const grown = JSON.parse((await req(port, '/api/node/logs')).body);
    assert.strictEqual(grown.lines.length, 4, 'the route re-reads the file — it holds no snapshot');

    fs.unlinkSync(nodeLog);
    const gone = JSON.parse((await req(port, '/api/node/logs')).body);
    assert.deepStrictEqual(gone, { ok: true, lines: [] }, 'a missing log is an empty page, never a 500');
  });
});

test('GET /api/node/logs: never reads the ROTATED file, and 501s with no host log path', async () => {
  await withNode({}, async (port, { nodeLog }) => {
    fs.writeFileSync(`${nodeLog}.1`, '2026-09-16T00:00:00.000Z  INFO  [app] previous generation\n');
    const body = JSON.parse((await req(port, '/api/node/logs')).body);
    assert.ok(!body.lines.some((l) => l.includes('previous generation')),
      'the rotated .log.1 is a different file and stays off the wire');
  });
  await withNode({ nodeLogFile: null }, async (port) => {
    const r = await req(port, '/api/node/logs');
    assert.strictEqual(r.status, 501, 'a host that supplies no log path refuses rather than guessing ~/.clodex');
    assert.deepStrictEqual(JSON.parse(r.body), { ok: false, error: 'node logs not available' });
    const names = JSON.parse((await req(port, '/api/resources')).body).resources.map(r2 => r2.name);
    assert.ok(!names.includes('node/logs'), 'and it drops out of the catalog, so the CLI says upgrade');
  });
});

test('GET /api/node/logs: a credential-shaped log line is masked before it reaches the wire', async () => {
  const marker = 'Zq7-NOT-A-REAL-VALUE-Zq7';
  await withNode({}, async (port, { nodeLog }) => {
    fs.writeFileSync(nodeLog, [
      `2026-09-17T00:00:00.000Z  INFO  [remote] token=${marker}`,
      `2026-09-17T00:00:01.000Z  INFO  [peer] Authorization: Bearer ${marker}`,
      `2026-09-17T00:00:02.000Z  WARN  [auth] password: ${marker} rejected`,
      `2026-09-17T00:00:03.000Z  INFO  [box] secret=${marker}`,
      '2026-09-17T00:00:04.000Z  INFO  [app] a plain line survives verbatim',
    ].join('\n') + '\n');
    const raw = (await req(port, '/api/node/logs')).body;
    assert.ok(!raw.includes(marker), 'the value appears NOWHERE in the response body, at any depth');
    const { lines } = JSON.parse(raw);
    assert.strictEqual(lines[0], '2026-09-17T00:00:00.000Z  INFO  [remote] token=[redacted]');
    assert.strictEqual(lines[1], '2026-09-17T00:00:01.000Z  INFO  [peer] Authorization=[redacted]',
      'the `Bearer` scheme word is consumed WITH the value — masking only up to it would leave the credential on the wire');
    assert.strictEqual(lines[2], '2026-09-17T00:00:02.000Z  WARN  [auth] password=[redacted] rejected');
    assert.strictEqual(lines[3], '2026-09-17T00:00:03.000Z  INFO  [box] secret=[redacted]');
    assert.strictEqual(lines[4], '2026-09-17T00:00:04.000Z  INFO  [app] a plain line survives verbatim',
      'a line with no credential shape is passed through byte for byte');
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

test('a trailing slash on a session path is a 404, not the resource it looks like', async () => {
  const fixture = subresourceFixture();
  await withNode(fixture.opts, async (port) => {
    const ok = await req(port, '/api/sessions/alice');
    assert.strictEqual(ok.status, 200, 'ENTER: the same request WITHOUT the slash is the shipped resource');

    const slashed = await req(port, '/api/sessions/alice/');
    assert.strictEqual(slashed.status, 404,
      "a trailing slash splits to an empty sub, which matches no route. It answered 400 ('bad session name') "
      + 'before the resource wire and nothing pinned the change, so the status has drifted once already.');
    assert.strictEqual(fixture.calls.length, 0, 'and the slashed spelling reached no callback');
  });
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

test('the OLD session-write paths are gone — 404, no alias, no legacy shim', async () => {
  const fixture = subresourceFixture();
  const post = (port, p, body) => req(port, p, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  await withNode(fixture.opts, async (port) => {
    assert.strictEqual((await post(port, '/api/send', JSON.stringify({ name: 'alice', text: 'hi' }))).status, 404, 'POST /api/send still answers');
    assert.strictEqual((await post(port, '/api/kill/alice', '{}')).status, 404, 'POST /api/kill/:name still answers');
    assert.strictEqual((await post(port, '/api/restart-session/alice', '{}')).status, 404, 'POST /api/restart-session/:name still answers');
    assert.strictEqual((await req(port, '/api/session-args/alice')).status, 404, 'GET /api/session-args/:name still answers');
    assert.strictEqual((await post(port, '/api/session-args/alice', '{}')).status, 404, 'POST /api/session-args/:name still answers');
    assert.strictEqual((await req(port, '/api/skill-catalog/alice')).status, 404, 'GET /api/skill-catalog/:name still answers');
    assert.strictEqual((await post(port, '/api/session-skills/alice', '{}')).status, 404, 'POST /api/session-skills/:name still answers');
    assert.strictEqual(fixture.calls.length, 0, 'no old-path request reached a callback');
  });
  for (const old of ["'/api/send'", "'/api/kill/'", "'/api/restart-session/'", "'/api/session-args/'", "'/api/skill-catalog/'", "'/api/session-skills/'"]) {
    assert.ok(!REMOTE_SRC.includes(old), `remote.js still spells the old ${old} path`);
  }
});

test('POST /api/sessions/:name/dm: the path names the session — a body `name` is ignored, never obeyed', async () => {
  const fixture = subresourceFixture();
  const post = (port, p, body) => req(port, p, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  await withNode(fixture.opts, async (port) => {
    const r = await post(port, '/api/sessions/alice/dm', JSON.stringify({ name: 'bob', text: 'hi' }));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(fixture.calls.at(-1), { route: 'dm', name: 'alice', text: 'hi' }, 'the path name won over the body name');

    assert.strictEqual((await post(port, '/api/sessions/alice/dm', JSON.stringify({ text: '   ' }))).status, 400, 'whitespace-only text is empty');
    assert.deepStrictEqual(
      JSON.parse((await post(port, '/api/sessions/alice/dm', JSON.stringify({ name: 'alice' }))).body),
      { ok: false, error: 'empty message' },
    );
    assert.strictEqual((await post(port, '/api/sessions/alice/dm', 'not json')).status, 400, 'bad JSON is a 400');
    const miss = await post(port, '/api/sessions/ghost/dm', JSON.stringify({ text: 'hi' }));
    assert.strictEqual(miss.status, 404, 'a not-ok callback result is still a 404');
  });
});

test('DELETE /api/sessions/:name and POST .../restart: the statuses the deleted kill/restart-session routes served', async () => {
  const fixture = subresourceFixture();
  const post = (port, p, body) => req(port, p, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  await withNode(fixture.opts, async (port) => {
    const k = await req(port, '/api/sessions/alice', { method: 'DELETE' });
    assert.strictEqual(k.status, 200);
    assert.deepStrictEqual(JSON.parse(k.body), { ok: true, name: 'alice' });
    assert.deepStrictEqual(fixture.calls.at(-1), { route: 'kill', name: 'alice' });
    assert.strictEqual((await req(port, '/api/sessions/ghost', { method: 'DELETE' })).status, 404);

    assert.strictEqual((await post(port, '/api/sessions/alice/restart', JSON.stringify({ fresh: true }))).status, 200);
    assert.deepStrictEqual(fixture.calls.at(-1), { route: 'restart', name: 'alice', fresh: true });
    assert.strictEqual((await post(port, '/api/sessions/alice/restart', '')).status, 200, 'an empty body is a plain restart');
    assert.deepStrictEqual(fixture.calls.at(-1), { route: 'restart', name: 'alice', fresh: false });
    assert.strictEqual((await post(port, '/api/sessions/alice/restart', 'not json')).status, 400, 'bad JSON is a 400');
    assert.strictEqual((await post(port, '/api/sessions/ghost/restart', '{}')).status, 404);
  });
  await withNode({ ...fixture.opts, restartSession: null }, async (port) => {
    const r = await post(port, '/api/sessions/alice/restart', '{}');
    assert.strictEqual(r.status, 501);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: false, error: 'restart not available' });
  });
});

test('sessions/args and sessions/skills: GET reads, PATCH writes, and the merge-patch body reaches the owner', async () => {
  const fixture = subresourceFixture();
  const patch = (port, p, body) => req(port, p, { method: 'PATCH', body, headers: { 'content-type': 'application/json' } });
  await withNode(fixture.opts, async (port) => {
    const a = await req(port, '/api/sessions/alice/args');
    assert.strictEqual(a.status, 200);
    assert.deepStrictEqual(JSON.parse(a.body), ARGS_OUT);
    assert.strictEqual((await req(port, '/api/sessions/ghost/args')).status, 404);

    assert.strictEqual((await patch(port, '/api/sessions/alice/args', JSON.stringify({ extraArgs: ['--y'], restart: true }))).status, 200);
    assert.deepStrictEqual(fixture.calls.at(-1), { route: 'argsSet', name: 'alice', patch: { extraArgs: ['--y'], restart: true } });
    assert.strictEqual((await patch(port, '/api/sessions/alice/args', 'not json')).status, 400);

    const sk = await req(port, '/api/sessions/alice/skills');
    assert.strictEqual(sk.status, 200);
    assert.deepStrictEqual(JSON.parse(sk.body), SKILLS_OUT);
    assert.strictEqual((await req(port, '/api/sessions/ghost/skills')).status, 404);

    assert.strictEqual((await patch(port, '/api/sessions/alice/skills', JSON.stringify({ disabledSkills: ['xlsx'], injectSkills: ['my'] }))).status, 200);
    assert.deepStrictEqual(fixture.calls.at(-1), { route: 'skillsSet', name: 'alice', disabledSkills: ['xlsx'], injectSkills: ['my'] });
    assert.strictEqual((await patch(port, '/api/sessions/alice/skills', 'not json')).status, 400);
  });
  await withNode({ ...fixture.opts, getSessionArgs: null, setSessionSkills: null }, async (port) => {
    assert.deepStrictEqual(JSON.parse((await req(port, '/api/sessions/alice/args')).body), { ok: false, error: 'args not available' });
    assert.deepStrictEqual(JSON.parse((await patch(port, '/api/sessions/alice/skills', '{}')).body), { ok: false, error: 'skills not available' });
  });
});

test('verb gating: a node without killSession drops `delete` from the sessions verbs AND 501s DELETE', async () => {
  const fixture = subresourceFixture();
  await withNode({ ...fixture.opts, killSession: null }, async (port) => {
    const doc = JSON.parse((await req(port, '/api/resources')).body);
    const sessions = doc.resources.find((r) => r.name === 'sessions');
    assert.deepStrictEqual(sessions.verbs, ['list', 'get'], 'the document advertises a delete this node cannot serve');
    const r = await req(port, '/api/sessions/alice', { method: 'DELETE' });
    assert.strictEqual(r.status, 501);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: false, error: 'delete not available' });
    assert.strictEqual(fixture.calls.length, 0, 'the refused DELETE reached no callback');
  });
});

test('per-verb subresource gating: args keeps get and drops patch when only setSessionArgs is absent', async () => {
  const fixture = subresourceFixture();
  await withNode({ ...fixture.opts, setSessionArgs: null }, async (port) => {
    const doc = JSON.parse((await req(port, '/api/resources')).body);
    const sessions = doc.resources.find((r) => r.name === 'sessions');
    assert.deepStrictEqual(sessions.subresources.args, ['get'], 'the read half must survive a missing write callback');
    assert.strictEqual((await req(port, '/api/sessions/alice/args')).status, 200);
    const w = await req(port, '/api/sessions/alice/args', { method: 'PATCH', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.strictEqual(w.status, 501);
  });
  await withNode({ ...fixture.opts, getSessionArgs: null, setSessionArgs: null }, async (port) => {
    const doc = JSON.parse((await req(port, '/api/resources')).body);
    const sessions = doc.resources.find((r) => r.name === 'sessions');
    assert.ok(!('args' in sessions.subresources), 'a subresource with no servable verb is dropped whole');
  });
});

test('subresource gating: a node with the attach/control callbacks nulled omits them from the document AND 501s the routes', async () => {
  const fixture = subresourceFixture();
  const nulled = { ...fixture.opts, getAttachInfo: null, sendInput: null, resizePty: null };
  await withNode(nulled, async (port) => {
    const doc = JSON.parse((await req(port, '/api/resources')).body);
    const sessions = doc.resources.find((r) => r.name === 'sessions');
    assert.deepStrictEqual(
      Object.keys(sessions.subresources), ['transcript', 'query', 'dm', 'restart', 'args', 'skills'],
      'the document advertises a subresource this node cannot serve',
    );
    assert.strictEqual((await req(port, '/api/sessions/alice/attach')).status, 501);

    for (const [sub, verbs] of Object.entries(sessions.subresources)) {
      for (const verb of verbs) {
        const walk = SUB_WALK[sub][verb];
        const body = walk.body ? walk.body({ token: null }) : undefined;
        const res = await req(port, `/api/sessions/alice/${sub}`, {
          method: walk.method, body, stream: walk.stream,
          headers: body ? { 'content-type': 'application/json' } : {},
        });
        assert.strictEqual(res.status, 200, `served ${sub}.${verb} answered ${res.status}: ${res.body}`);
      }
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
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true, version: 2, resources: RESOURCES });
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
    assert.deepStrictEqual(names, ['sessions', 'peers', 'teams', 'tickets', 'sandboxes', 'agents', 'worktrees', 'catalogs', 'node/logs']);
  });
});

test('catalogs: absent from /api/resources when getCatalogs is not injected', async () => {
  await withNode({ getCatalogs: null }, async (port) => {
    const names = JSON.parse((await req(port, '/api/resources')).body).resources.map(r => r.name);
    assert.deepStrictEqual(names, ['sessions', 'workspaces', 'peers', 'teams', 'tickets', 'sandboxes', 'agents', 'worktrees', 'node/logs']);
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

function gitAvailable() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function makeRepoWithWorktree() {
  const dir = mkTmpRoot('remote-wt-');
  const run = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  run('init', '-q', '-b', 'master');
  run('config', 'user.email', 't@example.com');
  run('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi\n');
  run('add', '-A');
  run('commit', '-qm', 'init');
  const linked = `${dir}-linked`;
  run('worktree', 'add', '-q', '-b', 'side', linked);
  return { dir, linked };
}

const realWorktrees = { listWorktrees: (repo) => require('../git-worktree').listWorktrees(repo) };

test('GET /api/worktrees?repo=: 200 with every field listWorktrees builds, for a real repo with a linked tree', { skip: !gitAvailable() }, async () => {
  const { dir, linked } = makeRepoWithWorktree();
  await withNode({ listWorktrees: realWorktrees.listWorktrees }, async (port) => {
    const r = await req(port, `/api/worktrees?repo=${encodeURIComponent(dir)}`);
    assert.strictEqual(r.status, 200, r.body);
    const body = JSON.parse(r.body);
    for (const w of body.worktrees) {
      assert.match(w.head, /^[0-9a-f]{8}$/, `head is not 8 hex chars: ${w.head}`);
      w.head = 'HEAD8CHR';
    }
    assert.deepStrictEqual(body, {
      ok: true,
      repo: fs.realpathSync(dir),
      worktrees: [
        { path: fs.realpathSync(dir), branch: 'master', head: 'HEAD8CHR', isMain: true, detached: false, locked: false, prunable: false },
        { path: fs.realpathSync(linked), branch: 'side', head: 'HEAD8CHR', isMain: false, detached: false, locked: false, prunable: false },
      ],
    });
  });
});

test('GET /api/worktrees: `repo` is git\'s TOPLEVEL, not the path that was asked for', { skip: !gitAvailable() }, async () => {
  const { dir } = makeRepoWithWorktree();
  const sub = path.join(dir, 'deep', 'er');
  fs.mkdirSync(sub, { recursive: true });
  const top = fs.realpathSync(dir);
  await withNode({ listWorktrees: realWorktrees.listWorktrees }, async (port) => {
    const r = await req(port, `/api/worktrees?repo=${encodeURIComponent(sub)}`);
    assert.strictEqual(r.status, 200, r.body);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.repo, top, 'the subdirectory that was requested came back instead of the toplevel');
    assert.ok(body.worktrees.some((w) => w.path === top), 'the toplevel is the anchor every worktree path shares');
  });
});

test('GET /api/worktrees: 400 when repo is missing, empty or relative — the callback is never reached', async () => {
  let calls = 0;
  await withNode({ listWorktrees: (repo) => { calls += 1; return { ok: true, repo, worktrees: [] }; } }, async (port) => {
    for (const q of ['', '?repo=', '?repo=relative%2Fpath', '?repo=.']) {
      const r = await req(port, `/api/worktrees${q}`);
      assert.strictEqual(r.status, 400, `${q} answered ${r.status}: ${r.body}`);
      assert.deepStrictEqual(JSON.parse(r.body), { ok: false, error: 'repo must be an absolute path' });
    }
    const good = await req(port, `/api/worktrees?repo=${encodeURIComponent(path.join(os.tmpdir(), 'x'))}`);
    assert.strictEqual(good.status, 200, 'an absolute repo still reaches the callback');
  });
  assert.strictEqual(calls, 1, 'only the absolute path reached the callback');
});

test('GET /api/worktrees: 404 with the callback error for an absolute dir in no git repo', { skip: !gitAvailable() }, async () => {
  const notRepo = mkTmpRoot('remote-wt-nr-');
  await withNode({ listWorktrees: realWorktrees.listWorktrees }, async (port) => {
    const r = await req(port, `/api/worktrees?repo=${encodeURIComponent(notRepo)}`);
    assert.strictEqual(r.status, 404, r.body);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: false, error: 'Not inside a git repository' });
  });
});

test('worktrees: 501 and absent from /api/resources when listWorktrees is not injected', async () => {
  await withNode({ listWorktrees: null }, async (port) => {
    const r = await req(port, `/api/worktrees?repo=${encodeURIComponent(os.tmpdir())}`);
    assert.strictEqual(r.status, 501);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: false, error: 'worktrees not available' });
    const names = JSON.parse((await req(port, '/api/resources')).body).resources.map(r2 => r2.name);
    assert.ok(!names.includes('worktrees'), `worktrees is still advertised: ${names.join(',')}`);
  });
  await withNode({}, async (port) => {
    const names = JSON.parse((await req(port, '/api/resources')).body).resources.map(r2 => r2.name);
    assert.ok(names.includes('worktrees'), 'a wired node DOES advertise worktrees — the absence above is the injection, not the constant');
  });
});

test('wiring: engine-shaped deps produce a listWorktrees callback — gitWorktree is mandatory, not a capability gate', () => {
  const { deps } = makeDeps();
  const opts = captureOptions(deps);
  assert.strictEqual(typeof opts.listWorktrees, 'function', 'the wiring hands the server a worktree lister');
  assert.strictEqual(typeof opts.listPeers, 'function', 'the other callbacks are unaffected');
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
    `/api/worktrees?repo=${encodeURIComponent(FAKE_REPO)}`,
    '/api/sessions', '/api/sessions/alice', '/api/workspaces',
    '/api/node/logs',
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

test('hello: caps carries voice only when the node was constructed capable', async () => {
  await withNode({ voiceCapable: true }, async (port) => {
    const caps = JSON.parse((await req(port, '/api/peer/hello')).body).caps;
    assert.ok(caps.includes('voice'), 'a capable node offers the voice cap');
  });
  await withNode({ voiceCapable: false }, async (port) => {
    const caps = JSON.parse((await req(port, '/api/peer/hello')).body).caps;
    assert.ok(!caps.includes('voice'), 'a node that cannot record must not offer it');
    assert.ok(caps.includes('resources'), 'and the rest of the caps list is unaffected');
  });
});

test('remote-wiring passes voiceCapable as a boolean read off the machine', () => {
  const { deps } = makeDeps();
  const opts = captureOptions(deps);
  assert.strictEqual(typeof opts.voiceCapable, 'boolean',
    'remote-wiring must pass a boolean, not the capability object, which is truthy whatever it says');
});
