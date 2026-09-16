'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { run, RENAMED_VERBS } = require('../src/main');
const { SESSIONS, RENDERED } = require('./fixtures/sessions-render');

const TOKEN = 'sekret';

const RESOURCE_DOC = {
  ok: true,
  version: 1,
  resources: [
    { name: 'sessions', singular: 'session', scope: 'workspace', verbs: ['list', 'get'], subresources: {} },
    { name: 'workspaces', singular: 'workspace', scope: 'node', verbs: ['list'] },
    { name: 'catalogs', singular: 'catalogs', scope: 'node', verbs: ['get'] },
  ],
};
const HELLO_NEW = { ok: true, app: 'clodex', host: 'newbox', version: '5.80.0', caps: ['transcript', 'resources'] };
const HELLO_OLD = { ok: true, app: 'clodex', host: 'oldbox', version: '5.69.0', caps: ['transcript'] };
const WORKSPACES = [
  { id: 'w1', name: 'main', open: true, lastFocusedAt: 1 },
  { id: 'w2', name: 'side', open: false, lastFocusedAt: 2 },
];

function node({ old = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if ((req.headers['authorization'] || '') !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      }
      seen.push(req.url);
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const p = req.url.split('?')[0];
      if (p === '/api/peer/hello') return send(200, old ? HELLO_OLD : HELLO_NEW);
      if (p === '/api/sessions') return send(200, { ok: true, sessions: SESSIONS });
      if (p === '/api/catalogs') return send(200, { ok: true, catalogs: { agents: [{ name: 'a' }], skills: [], proxyEnabled: false } });
      if (!old && p === '/api/resources') return send(200, RESOURCE_DOC);
      if (!old && p === '/api/workspaces') return send(200, { ok: true, workspaces: WORKSPACES });
      if (!old && p.startsWith('/api/sessions/')) {
        const name = decodeURIComponent(p.slice('/api/sessions/'.length));
        const s = SESSIONS.find((x) => x.name === name);
        if (!s) return send(404, { ok: false, error: 'Session not found' });
        return send(200, { ok: true, session: { ...s, workspaceId: 'w1', stats: { turns: 2 }, activity: s.activity } });
      }
      return send(404, { ok: false, error: old ? 'not found' : 'Session not found' });
    });
  });
  return { server, seen };
}

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

async function cli(argv, port, extra = {}) {
  let stdout = '', stderr = '';
  const wire = port == null ? [] : ['--url', `http://127.0.0.1:${port}`, '--token', TOKEN];
  const code = await run([...argv, ...wire], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: {},
    contextsFile: path.join(os.tmpdir(), 'nonexistent-clodexctl-t931', 'contexts.json'),
    spawnFn: () => { throw new Error('spawnFn called — the verb reached a transport'); },
    ...extra,
  });
  return { code, stdout, stderr };
}

async function withNode(opts, fn) {
  const { server, seen } = node(opts);
  const port = await listen(server);
  try { return await fn(port, seen); } finally { server.close(); }
}

test('get sessions renders BYTE-IDENTICALLY to the deleted `sessions` verb', async () => {
  await withNode({}, async (port) => {
    const { code, stdout } = await cli(['get', 'sessions'], port);
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout, RENDERED + '\n',
      'get sessions must reproduce the bytes `sessions` printed at fc8445f3 for this fixture');
  });
});

test('get sessions needs NO capability check — it works against an old node', async () => {
  await withNode({ old: true }, async (port, seen) => {
    const { code, stdout } = await cli(['get', 'sessions'], port);
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout, RENDERED + '\n');
    assert.deepStrictEqual(seen, ['/api/sessions'], 'no /api/resources probe on a path that never moved');
  });
});

test('get catalogs likewise never probes /api/resources', async () => {
  await withNode({ old: true }, async (port, seen) => {
    const { code } = await cli(['get', 'catalogs'], port);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(seen, ['/api/catalogs']);
  });
});

test('get sessions -o json passes the raw payload through', async () => {
  await withNode({}, async (port) => {
    const { code, stdout } = await cli(['get', 'sessions', '-o', 'json'], port);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(stdout), { ok: true, sessions: SESSIONS });
  });
});

test('get sessions -o wide adds WORKSPACE to the default columns', async () => {
  await withNode({}, async (port) => {
    const { stdout } = await cli(['get', 'sessions', '-o', 'wide'], port);
    assert.match(stdout, /^NAME\s+TYPE\s+ACTIVITY\s+CWD\s+WORKSPACE$/m);
    assert.match(stdout, /bob\s+claude\s+idle\s+\/w\/one\s+main/);
  });
});

test('get sessions -o name emits session/<name>, one per line', async () => {
  await withNode({}, async (port) => {
    const { stdout } = await cli(['get', 'sessions', '-o', 'name'], port);
    assert.strictEqual(stdout, 'session/bob\nsession/builder-long\nsession/sh\n');
  });
});

test('-o wide and -o name are valid ONLY on get', async () => {
  for (const fmt of ['wide', 'name']) {
    const { code, stderr } = await cli(['info', '-o', fmt], null);
    assert.strictEqual(code, 2, `info -o ${fmt} must be a usage error`);
    assert.match(stderr, new RegExp(`-o ${fmt} is only valid on get`));
  }
});

test('-o yaml is a usage error naming it as not yet supported', async () => {
  const { code, stderr } = await cli(['get', 'sessions', '-o', 'yaml'], null);
  assert.strictEqual(code, 2);
  assert.match(stderr, /-o yaml is not supported yet/);
});

test('an unknown -o format is a usage error listing the real ones', async () => {
  const { code, stderr } = await cli(['get', 'sessions', '-o', 'toml'], null);
  assert.strictEqual(code, 2);
  assert.match(stderr, /unknown output format: toml \(json\|wide\|name\)/);
});

test('-n filters sessions CLIENT-SIDE, with no extra request and no capability check', async () => {
  await withNode({ old: true }, async (port, seen) => {
    const { code, stdout } = await cli(['get', 'sessions', '-n', 'side'], port);
    assert.strictEqual(code, 0);
    assert.match(stdout, /builder-long/);
    assert.doesNotMatch(stdout, /bob/, 'a row in another workspace must be filtered out');
    assert.deepStrictEqual(seen, ['/api/sessions'], 'the filter costs no round trip');
  });
});

test('-n also filters the -o json payload, not just the table', async () => {
  await withNode({}, async (port) => {
    const { stdout } = await cli(['get', 'sessions', '-n', 'main', '-o', 'json'], port);
    assert.deepStrictEqual(JSON.parse(stdout).sessions.map((s) => s.name), ['bob', 'sh']);
  });
});

test('-A is accepted and is a no-op — every workspace is already the default', async () => {
  await withNode({}, async (port) => {
    const bare = await cli(['get', 'sessions'], port);
    const all = await cli(['get', 'sessions', '-A'], port);
    assert.strictEqual(all.code, 0);
    assert.strictEqual(all.stdout, bare.stdout);
  });
});

test('get session <name> checks resources once, then fetches the object', async () => {
  await withNode({}, async (port, seen) => {
    const { code, stdout } = await cli(['get', 'session', 'bob'], port);
    assert.strictEqual(code, 0);
    assert.match(stdout, /^NAME\s+TYPE\s+ACTIVITY\s+CWD$/m);
    assert.match(stdout, /bob\s+claude\s+idle\s+\/w\/one/);
    assert.deepStrictEqual(seen, ['/api/resources', '/api/sessions/bob']);
  });
});

test('session/<name> is accepted wherever `session <name>` is', async () => {
  await withNode({}, async (port) => {
    const slash = await cli(['get', 'session/bob', '-o', 'json'], port);
    const spaced = await cli(['get', 'session', 'bob', '-o', 'json'], port);
    assert.strictEqual(slash.code, 0);
    assert.strictEqual(slash.stdout, spaced.stdout);
  });
});

test('get session against an OLD node prints the upgrade line and exits 1', async () => {
  await withNode({ old: true }, async (port, seen) => {
    const { code, stdout, stderr } = await cli(['get', 'session', 'bob'], port);
    assert.strictEqual(code, 1);
    assert.strictEqual(stderr,
      'clodexctl: node oldbox (5.69.0) does not serve sessions get; run: clodexctl upgrade node http://127.0.0.1:' + port + '\n');
    assert.strictEqual(stdout, '', 'nothing but the one line');
    assert.deepStrictEqual(seen, ['/api/resources', '/api/peer/hello'],
      'hello is fetched only on the failure path, and the session is never requested');
  });
});

test('get workspaces renders ID NAME; against an old node it is the upgrade line', async () => {
  await withNode({}, async (port) => {
    const { code, stdout } = await cli(['get', 'workspaces'], port);
    assert.strictEqual(code, 0);
    assert.match(stdout, /^ID\s+NAME$/m);
    assert.match(stdout, /w1\s+main/);
  });
  await withNode({ old: true }, async (port) => {
    const { code, stderr } = await cli(['get', 'workspaces'], port);
    assert.strictEqual(code, 1);
    assert.match(stderr, /does not serve workspaces list/);
  });
});

test('get session <unknown> is a 404 → exit 5, not an upgrade line', async () => {
  await withNode({}, async (port) => {
    const { code, stderr } = await cli(['get', 'session', 'ghost'], port);
    assert.strictEqual(code, 5);
    assert.match(stderr, /Session not found/);
    assert.doesNotMatch(stderr, /upgrade node/, 'a missing session is not an out-of-date node');
  });
});

test('describe session renders every field as a key: value block', async () => {
  await withNode({}, async (port) => {
    const { code, stdout } = await cli(['describe', 'session', 'bob'], port);
    assert.strictEqual(code, 0);
    assert.match(stdout, /^name:\s+bob$/m);
    assert.match(stdout, /^workspaceId:\s+w1$/m);
    assert.match(stdout, /^stats:\s+\{"turns":2\}$/m);
  });
});

test('describe workspace reads the list and renders the one row', async () => {
  await withNode({}, async (port) => {
    const { code, stdout } = await cli(['describe', 'workspace', 'side'], port);
    assert.strictEqual(code, 0);
    assert.match(stdout, /^id:\s+w2$/m);
    assert.match(stdout, /^open:\s+false$/m);
  });
});

test('describe checks the resources API too — an old node gets the upgrade line', async () => {
  for (const argv of [['describe', 'session', 'bob'], ['describe', 'workspace', 'main'], ['describe', 'catalogs']]) {
    await withNode({ old: true }, async (port, seen) => {
      const { code, stderr } = await cli(argv, port);
      assert.strictEqual(code, 1, `${argv.join(' ')} must exit 1 against an old node`);
      assert.match(stderr, /does not serve \w+ \w+; run: clodexctl upgrade node /);
      assert.deepStrictEqual(seen, ['/api/resources', '/api/peer/hello'],
        `${argv.join(' ')} must probe resources and stop, never fetch the object`);
    });
  }
});

test('describe workspace <unknown> is a not-found, not an empty block', async () => {
  await withNode({}, async (port) => {
    const { code, stderr } = await cli(['describe', 'workspace', 'nope'], port);
    assert.strictEqual(code, 5);
    assert.match(stderr, /no workspace nope/);
  });
});

test('describe has no -o json, and refuses BEFORE any wire (kubectl has none either)', async () => {
  await withNode({}, async (port, seen) => {
    const { code, stderr } = await cli(['describe', 'session', 'bob', '-o', 'json'], port);
    assert.strictEqual(code, 2);
    assert.match(stderr, /describe has no -o json/);
    assert.deepStrictEqual(seen, [], 'a usage error must not cost a round trip');
  });
});

test('describe needs a name for a named resource', async () => {
  await withNode({}, async (port) => {
    const { code, stderr } = await cli(['describe', 'session'], port);
    assert.strictEqual(code, 2);
    assert.match(stderr, /describe sessions needs a session name/);
  });
});

test('api-resources prints NAME SINGULAR SCOPE VERBS', async () => {
  await withNode({}, async (port) => {
    const { code, stdout } = await cli(['api-resources'], port);
    assert.strictEqual(code, 0);
    assert.match(stdout, /^NAME\s+SINGULAR\s+SCOPE\s+VERBS$/m);
    assert.match(stdout, /^sessions\s+session\s+workspace\s+list,get$/m);
    assert.match(stdout, /^workspaces\s+workspace\s+node\s+list$/m);
  });
});

test('api-resources against an old node is the upgrade line, exit 1', async () => {
  await withNode({ old: true }, async (port) => {
    const { code, stderr } = await cli(['api-resources'], port);
    assert.strictEqual(code, 1);
    assert.match(stderr, /node oldbox \(5\.69\.0\) does not serve resources get/);
  });
});

test('version prints the client line and the node line', async () => {
  await withNode({}, async (port) => {
    const { code, stdout } = await cli(['version'], port);
    assert.strictEqual(code, 0);
    const lines = stdout.trim().split('\n');
    assert.match(lines[0], /^clodexctl \d/);
    assert.strictEqual(lines[1], 'Server: newbox 5.80.0');
  });
});

test('version -o json carries { client, server:{host,version} }', async () => {
  await withNode({}, async (port) => {
    const { stdout } = await cli(['version', '-o', 'json'], port);
    const j = JSON.parse(stdout);
    assert.match(j.client, /^clodexctl \d/);
    assert.deepStrictEqual(j.server, { host: 'newbox', version: '5.80.0' });
  });
});

test('-V still prints the client version alone and opens no wire', async () => {
  const { code, stdout } = await cli(['-V', 'info'], null);
  assert.strictEqual(code, 0);
  assert.match(stdout, /^clodexctl \d[^\n]*\n$/);
});

test('`clodexctl sessions` points at the new spelling, exit 2, and RUNS NOTHING', async () => {
  let dialled = false;
  const { code, stdout, stderr } = await cli(['sessions'], null, {
    spawnFn: () => { dialled = true; throw new Error('spawnFn called'); },
  });
  assert.strictEqual(code, 2);
  assert.strictEqual(stderr, 'clodexctl: clodexctl sessions was renamed: use clodexctl get sessions\n');
  assert.strictEqual(stdout, '');
  assert.strictEqual(dialled, false, 'no transport, no context resolution');
});

test('a renamed verb never reaches the wire even with a live node and flags', async () => {
  await withNode({}, async (port, seen) => {
    const { code, stderr } = await cli(['sessions', '-o', 'json'], port);
    assert.strictEqual(code, 2);
    assert.strictEqual(stderr, 'clodexctl: clodexctl sessions was renamed: use clodexctl get sessions\n');
    assert.deepStrictEqual(seen, [], 'the stub node saw no request at all');
  });
});

test('`clodexctl help sessions` prints the same pointer on stdout, exit 1', async () => {
  const { code, stdout, stderr } = await cli(['help', 'sessions'], null);
  assert.strictEqual(code, 1);
  assert.strictEqual(stdout, 'clodexctl sessions was renamed: use clodexctl get sessions\n');
  assert.strictEqual(stderr, '');
});

test('`clodexctl sessions --help` is the same pointer, exit 1', async () => {
  const { code, stdout } = await cli(['sessions', '--help'], null);
  assert.strictEqual(code, 1);
  assert.strictEqual(stdout, 'clodexctl sessions was renamed: use clodexctl get sessions\n');
});

test('every RENAMED_VERBS key answers, and none of them is a live verb', async () => {
  const { TOP_VERBS } = require('../src/main');
  for (const old of Object.keys(RENAMED_VERBS)) {
    assert.ok(!TOP_VERBS.includes(old), `${old} is renamed but still dispatched`);
    const { code, stderr } = await cli([old], null);
    assert.strictEqual(code, 2, `${old} must exit 2`);
    assert.match(stderr, new RegExp(`clodexctl ${old} was renamed: use clodexctl ${RENAMED_VERBS[old]}`));
  }
});

test('--json prints its replacement, exits 2, and runs nothing', async () => {
  await withNode({}, async (port, seen) => {
    const { code, stdout, stderr } = await cli(['info', '--json'], port);
    assert.strictEqual(code, 2);
    assert.strictEqual(stderr, 'clodexctl: --json was replaced by -o json\n');
    assert.strictEqual(stdout, '');
    assert.deepStrictEqual(seen, []);
  });
});

test('--json is caught in EVERY argv position, including ahead of the verb and as --json=x', async () => {
  for (const argv of [['--json', 'info'], ['info', '--json'], ['info', '--json=true'], ['get', 'sessions', '--json']]) {
    const { code, stderr } = await cli(argv, null);
    assert.strictEqual(code, 2, `${argv.join(' ')} must be the replacement line`);
    assert.match(stderr, /--json was replaced by -o json/);
  }
});

test('a literal --json in a verbatim tail or a tunnel argv is still just text', async () => {
  const passthrough = await cli(['send', 'bob', '--', '--json'], null);
  assert.doesNotMatch(passthrough.stderr, /--json was replaced/, 'a payload after -- is not a flag');
  const tunnel = await cli(['ctx', 'add', 'k', '--url', 'http://h', '--tunnel', 'sh', '-c', '--json'], null);
  assert.doesNotMatch(tunnel.stderr, /--json was replaced/);
});
