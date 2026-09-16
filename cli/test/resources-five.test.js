'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/main');

const TOKEN = 'sekret';

const FULL_RESOURCES = [
  { name: 'sessions', singular: 'session', scope: 'workspace', verbs: ['list', 'get'], subresources: {} },
  { name: 'workspaces', singular: 'workspace', scope: 'node', verbs: ['list'] },
  { name: 'peers', singular: 'peer', scope: 'node', verbs: ['list', 'get'] },
  { name: 'teams', singular: 'team', scope: 'node', verbs: ['list', 'get'] },
  { name: 'tickets', singular: 'ticket', scope: 'team', verbs: ['list', 'get'] },
  { name: 'sandboxes', singular: 'sandbox', scope: 'node', verbs: ['list', 'get'] },
  { name: 'agents', singular: 'agent', scope: 'node', verbs: ['list', 'get'] },
  { name: 'catalogs', singular: 'catalogs', scope: 'node', verbs: ['get'] },
];

const HELLO_NEW = { ok: true, app: 'clodex', host: 'newbox', version: '5.80.0', caps: ['resources'] };
const HELLO_OLD = { ok: true, app: 'clodex', host: 'oldbox', version: '5.69.0', caps: [] };

const PEER_ROW = {
  id: 'boxy', label: 'Boxy', url: 'http://127.0.0.1:7070', direct: true, online: true,
  host: 'boxy-host', version: '9.9.9', caps: ['send'], platform: 'linux', srcDir: null,
  webHost: null, wirescope: null, tunnel: null, webTunnel: null,
};
const PEER_OFF = { ...PEER_ROW, id: 'ghost', label: 'Ghost', online: false, host: 'ghost-host', version: '1.0.0', url: 'http://127.0.0.1:7071', platform: 'darwin' };
const PEER_SESSIONS = [{ name: 'remote-seat', type: 'claude' }, { name: 'second', type: 'codex' }];

const TEAMS = [{ name: 'alpha' }, { name: 'beta' }];
const TEAM_ALPHA = {
  name: 'alpha', root: '/proj/alpha', sandboxed: false, lead: 'alpha-lead',
  roles: { lead: { dispatch: 'session' }, hand: { dispatch: 'worktree' } },
  kit: null, file: 'alpha.json', dir: '/teams/alpha', watchdogMs: 900000, version: 2,
  droppedFields: [], activity: { roles: { lead: { dispatch: 'session', live: ['alpha-lead'], open: [], last: null } } },
};

const TICKETS = [
  { id: 't1', team: 'alpha', state: 'open', assignee: 'hand', title: 'alpha open', branch: 't1-work' },
  { id: 't2', team: 'alpha', state: 'done', assignee: 'hand', title: 'alpha done', branch: 't2-work' },
  { id: 't1', team: 'beta', state: 'done', assignee: 'other', title: 'beta done', branch: null },
  { id: 't7', team: 'beta', state: 'open', assignee: 'other', title: 'beta only', branch: 't7-work' },
];

const SANDBOXES = [{ id: 'boxy', label: 'Boxy' }, { id: 'tiny', label: 'Tiny' }];
const SANDBOX_ONE = { id: 'boxy', label: 'Boxy', state: 'running', ref: 'master', sha: 'deadbeef', ports: { web: 7080, wire: 7900 } };

const AGENTS = [
  { name: 'scout', description: 'a library agent', model: 'opus', tools: 'Read', disallowedTools: '' },
  { name: 'tester', description: 'runs the suite', model: 'haiku', tools: 'Bash,Read', disallowedTools: 'Write' },
];
const AGENT_MD = '---\ndescription: a library agent\nmodel: opus\n---\nbody text\n';

function node({ old = false, omit = null } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
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
      const u = new URL(req.url, 'http://x');
      const p = u.pathname;
      if (p === '/api/peer/hello') return send(200, old ? HELLO_OLD : HELLO_NEW);
      if (old) return send(404, { ok: false, error: 'not found' });
      if (p === '/api/resources') {
        return send(200, { ok: true, version: 1, resources: FULL_RESOURCES.filter((r) => r.name !== omit) });
      }
      const gone = (plural) => omit === plural;

      if (p === '/api/peers') {
        if (gone('peers')) return send(501, { ok: false, error: 'peers not available' });
        return send(200, { ok: true, peers: [PEER_ROW, PEER_OFF] });
      }
      if (p === '/api/peers/boxy') return send(200, { ok: true, peer: { ...PEER_ROW, sessions: PEER_SESSIONS } });

      if (p === '/api/teams') {
        if (gone('teams')) return send(501, { ok: false, error: 'teams not available' });
        return send(200, { ok: true, teams: TEAMS });
      }
      if (p === '/api/teams/alpha') return send(200, { ok: true, team: TEAM_ALPHA });

      if (p === '/api/tickets') {
        if (gone('tickets')) return send(501, { ok: false, error: 'tickets not available' });
        const team = u.searchParams.get('team');
        const state = u.searchParams.get('state') || 'all';
        let rows = TICKETS;
        if (team != null) rows = rows.filter((t) => t.team === team);
        if (state !== 'all') rows = rows.filter((t) => t.state === state);
        return send(200, { ok: true, tickets: rows });
      }
      if (p.startsWith('/api/tickets/')) {
        const id = decodeURIComponent(p.slice('/api/tickets/'.length));
        const team = u.searchParams.get('team');
        let hits = TICKETS.filter((t) => t.id === id);
        if (team != null) hits = hits.filter((t) => t.team === team);
        if (hits.length > 1) return send(400, { ok: false, error: 'ambiguous ticket id', candidates: hits.map((t) => t.team) });
        if (!hits.length) return send(404, { ok: false, error: 'Ticket not found' });
        return send(200, { ok: true, ticket: hits[0] });
      }

      if (p === '/api/sandboxes') {
        if (gone('sandboxes')) return send(501, { ok: false, error: 'sandboxes not available' });
        return send(200, { ok: true, sandboxes: SANDBOXES });
      }
      if (p === '/api/sandboxes/boxy') return send(200, { ok: true, sandbox: SANDBOX_ONE });

      if (p === '/api/agents') {
        if (gone('agents')) return send(501, { ok: false, error: 'agents not available' });
        return send(200, { ok: true, agents: AGENTS });
      }
      if (p === '/api/agents/scout') return send(200, { ok: true, agent: { name: 'scout', content: AGENT_MD } });

      return send(404, { ok: false, error: 'not found' });
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
    contextsFile: path.join(os.tmpdir(), 'nonexistent-clodexctl-t933', 'contexts.json'),
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

const lines = (s) => s.replace(/\n$/, '').split('\n');

test('get peers renders ID LABEL ONLINE HOST VERSION', async () => {
  await withNode({}, async (port) => {
    const { code, stdout } = await cli(['get', 'peers'], port);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(lines(stdout), [
      'ID     LABEL  ONLINE  HOST        VERSION',
      'boxy   Boxy   true    boxy-host   9.9.9',
      'ghost  Ghost  false   ghost-host  1.0.0',
    ]);
  });
});

test('get peers -o wide adds URL and PLATFORM; -o name is peer/<id>', async () => {
  await withNode({}, async (port) => {
    const wide = await cli(['get', 'peers', '-o', 'wide'], port);
    assert.deepStrictEqual(lines(wide.stdout), [
      'ID     LABEL  ONLINE  HOST        VERSION  URL                    PLATFORM',
      'boxy   Boxy   true    boxy-host   9.9.9    http://127.0.0.1:7070  linux',
      'ghost  Ghost  false   ghost-host  1.0.0    http://127.0.0.1:7071  darwin',
    ]);
    const name = await cli(['get', 'peers', '-o', 'name'], port);
    assert.deepStrictEqual(lines(name.stdout), ['peer/boxy', 'peer/ghost']);
  });
});

test('get peers -o json passes the raw payload through', async () => {
  await withNode({}, async (port) => {
    const { stdout } = await cli(['get', 'peers', '-o', 'json'], port);
    assert.deepStrictEqual(JSON.parse(stdout), { ok: true, peers: [PEER_ROW, PEER_OFF] });
  });
});

test('get teams renders NAME rows only — no fan-out of N single gets', async () => {
  await withNode({}, async (port, seen) => {
    const { code, stdout } = await cli(['get', 'teams'], port);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(lines(stdout), ['NAME', 'alpha', 'beta']);
    assert.deepStrictEqual(seen, ['/api/resources', '/api/teams'],
      'one list call — a per-team describe fan-out would be N+1 requests');
  });
});

test('get teams -o wide is the same NAME table; -o name is team/<name>', async () => {
  await withNode({}, async (port) => {
    const wide = await cli(['get', 'teams', '-o', 'wide'], port);
    assert.deepStrictEqual(lines(wide.stdout), ['NAME', 'alpha', 'beta']);
    const name = await cli(['get', 'teams', '-o', 'name'], port);
    assert.deepStrictEqual(lines(name.stdout), ['team/alpha', 'team/beta']);
  });
});

test('get tickets renders ID TEAM STATE TITLE, and -o wide adds ASSIGNEE BRANCH', async () => {
  await withNode({}, async (port) => {
    const { code, stdout } = await cli(['get', 'tickets'], port);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(lines(stdout), [
      'ID  TEAM   STATE  TITLE',
      't1  alpha  open   alpha open',
      't7  beta   open   beta only',
    ]);
    const wide = await cli(['get', 'tickets', '-o', 'wide'], port);
    assert.deepStrictEqual(lines(wide.stdout), [
      'ID  TEAM   STATE  TITLE       ASSIGNEE  BRANCH',
      't1  alpha  open   alpha open  hand      t1-work',
      't7  beta   open   beta only   other     t7-work',
    ]);
    const name = await cli(['get', 'tickets', '-o', 'name'], port);
    assert.deepStrictEqual(lines(name.stdout), ['ticket/t1', 'ticket/t7']);
  });
});

test('get sandboxes renders ID LABEL; -o name is sandbox/<id>', async () => {
  await withNode({}, async (port) => {
    const { code, stdout } = await cli(['get', 'sandboxes'], port);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(lines(stdout), ['ID    LABEL', 'boxy  Boxy', 'tiny  Tiny']);
    const wide = await cli(['get', 'sandboxes', '-o', 'wide'], port);
    assert.deepStrictEqual(lines(wide.stdout), ['ID    LABEL', 'boxy  Boxy', 'tiny  Tiny']);
    const name = await cli(['get', 'sandboxes', '-o', 'name'], port);
    assert.deepStrictEqual(lines(name.stdout), ['sandbox/boxy', 'sandbox/tiny']);
  });
});

test('get agents renders NAME MODEL DESCRIPTION; -o wide adds TOOLS', async () => {
  await withNode({}, async (port) => {
    const { code, stdout } = await cli(['get', 'agents'], port);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(lines(stdout), [
      'NAME    MODEL  DESCRIPTION',
      'scout   opus   a library agent',
      'tester  haiku  runs the suite',
    ]);
    const wide = await cli(['get', 'agents', '-o', 'wide'], port);
    assert.deepStrictEqual(lines(wide.stdout), [
      'NAME    MODEL  DESCRIPTION      TOOLS',
      'scout   opus   a library agent  Read',
      'tester  haiku  runs the suite   Bash,Read',
    ]);
    const name = await cli(['get', 'agents', '-o', 'name'], port);
    assert.deepStrictEqual(lines(name.stdout), ['agent/scout', 'agent/tester']);
  });
});

test('get tickets human default sends ?state=open; -o json sends no state at all', async () => {
  await withNode({}, async (port, seen) => {
    await cli(['get', 'tickets'], port);
    assert.deepStrictEqual(seen, ['/api/resources', '/api/tickets?state=open'],
      'the human table is the OPEN board');
    seen.length = 0;
    const json = await cli(['get', 'tickets', '-o', 'json'], port);
    assert.deepStrictEqual(seen, ['/api/resources', '/api/tickets'],
      '-o json is the raw payload and takes the server default of every state');
    assert.deepStrictEqual(JSON.parse(json.stdout).tickets.map((t) => `${t.team}/${t.id}`),
      ['alpha/t1', 'alpha/t2', 'beta/t1', 'beta/t7']);
  });
});

test('get tickets --team and --state reach the query verbatim', async () => {
  await withNode({}, async (port, seen) => {
    const { stdout } = await cli(['get', 'tickets', '--team', 'alpha', '--state', 'done'], port);
    assert.deepStrictEqual(seen, ['/api/resources', '/api/tickets?team=alpha&state=done']);
    assert.deepStrictEqual(lines(stdout), [
      'ID  TEAM   STATE  TITLE',
      't2  alpha  done   alpha done',
    ]);
  });
});

test('get tickets --state all is honoured, not swallowed by the human default', async () => {
  await withNode({}, async (port, seen) => {
    await cli(['get', 'tickets', '--state', 'all'], port);
    assert.deepStrictEqual(seen, ['/api/resources', '/api/tickets?state=all']);
  });
});

test('a bad --state fails client-side with ZERO requests', async () => {
  await withNode({}, async (port, seen) => {
    const { code, stderr } = await cli(['get', 'tickets', '--state', 'review'], port);
    assert.strictEqual(code, 2);
    assert.match(stderr, /unknown ticket state: review \(open\|done\|cancelled\|all\)/);
    assert.deepStrictEqual(seen, [], 'the enum is checked here, so the node is never asked');
  });
});

test('a bad ticket id fails client-side with ZERO requests', async () => {
  await withNode({}, async (port, seen) => {
    for (const bad of ['nope', 't', '42', 'tt1']) {
      const { code, stderr } = await cli(['describe', 'ticket', bad], port);
      assert.strictEqual(code, 2, `${bad} must be a usage error`);
      assert.match(stderr, new RegExp(`not a ticket id: ${bad}`));
    }
    assert.deepStrictEqual(seen, [], 'the id shape is checked here, so the node is never asked');
  });
});

test('describe peer is a key block with sessions as a nested name list', async () => {
  await withNode({}, async (port) => {
    const { code, stdout } = await cli(['describe', 'peer', 'boxy'], port);
    assert.strictEqual(code, 0);
    const l = lines(stdout);
    assert.ok(l.includes('id:        boxy'), `id line missing: ${stdout}`);
    assert.ok(l.includes('online:    true'), `online line missing: ${stdout}`);
    assert.deepStrictEqual(l.slice(l.indexOf('sessions:')), ['sessions:', '  remote-seat', '  second']);
    assert.ok(!stdout.includes('"name":"remote-seat"'), 'the sessions array is a list, not raw JSON');
  });
});

test('describe team renders roles one per line and activity as its own block', async () => {
  await withNode({}, async (port) => {
    const { code, stdout } = await cli(['describe', 'team', 'alpha'], port);
    assert.strictEqual(code, 0);
    const l = lines(stdout);
    assert.ok(l.includes('name:          alpha'), `name line missing: ${stdout}`);
    assert.ok(l.includes('lead:          alpha-lead'), `lead line missing: ${stdout}`);
    assert.deepStrictEqual(l.slice(l.indexOf('roles:'), l.indexOf('roles:') + 3), [
      'roles:',
      '  lead  {"dispatch":"session"}',
      '  hand  {"dispatch":"worktree"}',
    ]);
    assert.deepStrictEqual(l.slice(l.indexOf('activity:')), [
      'activity:',
      '  lead  {"dispatch":"session","live":["alpha-lead"],"open":[],"last":null}',
    ]);
  });
});

test('describe sandbox renders ports one per line', async () => {
  await withNode({}, async (port) => {
    const { code, stdout } = await cli(['describe', 'sandbox', 'boxy'], port);
    assert.strictEqual(code, 0);
    const l = lines(stdout);
    assert.ok(l.includes('state: running'), `state line missing: ${stdout}`);
    assert.deepStrictEqual(l.slice(l.indexOf('ports:')), ['ports:', '  web  7080', '  wire  7900']);
  });
});

test('describe agent prints the key block, a blank line, then the content verbatim', async () => {
  await withNode({}, async (port) => {
    const { code, stdout } = await cli(['describe', 'agent', 'scout'], port);
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout, `name: scout\n\n${AGENT_MD}\n`);
  });
});

test('describe ticket renders the full record as a key block', async () => {
  await withNode({}, async (port) => {
    const { code, stdout } = await cli(['describe', 'ticket', 't7'], port);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(lines(stdout), [
      'id:       t7',
      'team:     beta',
      'state:    open',
      'assignee: other',
      'title:    beta only',
      'branch:   t7-work',
    ]);
  });
});

test('an ambiguous ticket id names the teams and exits 2, with no stack', async () => {
  await withNode({}, async (port) => {
    const { code, stdout, stderr } = await cli(['describe', 'ticket', 't1'], port);
    assert.strictEqual(code, 2, 'the 400 is a usage problem the caller can fix');
    assert.strictEqual(stderr, 'clodexctl: ticket t1 exists in teams: alpha, beta — add --team\n');
    assert.strictEqual(stdout, '');
    const scoped = await cli(['describe', 'ticket', 't1', '--team', 'beta'], port);
    assert.strictEqual(scoped.code, 0);
    assert.ok(lines(scoped.stdout).includes('title:    beta done'), scoped.stdout);
  });
});

test('describe <singular> with no name is a usage error naming the noun', async () => {
  await withNode({}, async (port, seen) => {
    for (const [word, noun] of [['peer', 'peer'], ['team', 'team'], ['ticket', 'ticket'], ['sandbox', 'sandbox'], ['agent', 'agent']]) {
      const { code, stderr } = await cli(['describe', word], port);
      assert.strictEqual(code, 2);
      assert.match(stderr, new RegExp(`describe ${noun} needs a name`));
    }
    assert.deepStrictEqual(seen, []);
  });
});

test('get <plural> <name> points at describe rather than guessing', async () => {
  await withNode({}, async (port) => {
    const { code, stderr } = await cli(['get', 'peers', 'boxy'], port);
    assert.strictEqual(code, 2);
    assert.match(stderr, /get peers takes no name \(try: describe peer boxy\)/);
  });
});

test('an OLD node (no /api/resources) answers every one of the five with the D.5 line', async () => {
  await withNode({ old: true }, async (port) => {
    for (const plural of ['peers', 'teams', 'tickets', 'sandboxes', 'agents']) {
      const { code, stderr } = await cli(['get', plural], port);
      assert.strictEqual(code, 1, `${plural}: D.5 says exit 1`);
      assert.strictEqual(stderr,
        `clodexctl: node oldbox (5.69.0) does not serve ${plural} list; run: clodexctl upgrade node http://127.0.0.1:${port}\n`);
    }
  });
});

test('a node that OMITS sandboxes refuses get sandboxes while get peers still works', async () => {
  await withNode({ omit: 'sandboxes' }, async (port) => {
    const box = await cli(['get', 'sandboxes'], port);
    assert.strictEqual(box.code, 1);
    assert.match(box.stderr, /node newbox \(5\.80\.0\) does not serve sandboxes list/);
    const peers = await cli(['get', 'peers'], port);
    assert.strictEqual(peers.code, 0, 'the other resources are untouched by one absence');
    assert.deepStrictEqual(lines(peers.stdout)[0], 'ID     LABEL  ONLINE  HOST        VERSION');
  });
});

test('describe on the five checks the GET verb, not the list verb', async () => {
  await withNode({ old: true }, async (port) => {
    for (const [word, plural] of [['peer', 'peers'], ['team', 'teams'], ['sandbox', 'sandboxes'], ['agent', 'agents']]) {
      const { code, stderr } = await cli(['describe', word, 'boxy'], port);
      assert.strictEqual(code, 1);
      assert.match(stderr, new RegExp(`does not serve ${plural} get`));
    }
    const t = await cli(['describe', 'ticket', 't7'], port);
    assert.strictEqual(t.code, 1);
    assert.match(t.stderr, /does not serve tickets get/);
  });
});

test('-n is ignored on the node-scoped resources rather than erroring', async () => {
  await withNode({}, async (port, seen) => {
    const { code, stdout } = await cli(['get', 'peers', '-n', 'main'], port);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(lines(stdout).length, 3, 'every row survives — the flag filters nothing here');
    assert.deepStrictEqual(seen, ['/api/resources', '/api/peers'], 'and it reaches no query string');
  });
});
