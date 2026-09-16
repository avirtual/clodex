'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { run, RENAMED_SECOND } = require('../src/main');
const R = require('../src/resources');
const V = require('../src/verbs');
const { mkTmpRoot } = require('../../test/lib/tmp-roots');

function tmpCtx() {
  const d = mkTmpRoot('nodev-');
  return path.join(d, 'contexts.json');
}

async function cli(argv, file, extra = {}) {
  let stdout = '', stderr = '';
  const code = await run(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), env: {}, contextsFile: file, ...extra });
  return { code, stdout, stderr };
}

test('create/use/get/describe/delete node round-trip through the file', async () => {
  const f = tmpCtx();
  let r = await cli(['create', 'node', 'home', '--url', 'http://127.0.0.1:7900', '--token', 'sek'], f);
  assert.strictEqual(r.code, 0);
  assert.strictEqual((fs.statSync(f).mode & 0o777), 0o600);

  r = await cli(['create', 'node', 'work', '--ssh', 'user@box'], f);
  assert.strictEqual(r.code, 0);

  r = await cli(['get', 'nodes'], f);
  assert.match(r.stdout, /\*\s+home/, 'home is current — the first node created');
  assert.match(r.stdout, /work\s+ssh\s+user@box/);

  r = await cli(['use', 'node', 'work'], f);
  assert.strictEqual(r.code, 0);
  r = await cli(['get', 'nodes', '-o', 'json'], f);
  assert.strictEqual(JSON.parse(r.stdout).current, 'work');

  r = await cli(['describe', 'node', 'home'], f);
  assert.match(r.stdout, /token\s+\(set\)/);
  assert.doesNotMatch(r.stdout, /sek/);

  r = await cli(['delete', 'node', 'home', '--force'], f);
  assert.strictEqual(r.code, 0);
  r = await cli(['get', 'nodes', '-o', 'json'], f);
  assert.strictEqual(JSON.parse(r.stdout).nodes.find((n) => n.name === 'home'), undefined);
});

test('the singular/plural spellings behave like every other resource', async () => {
  const f = tmpCtx();
  await cli(['create', 'nodes', 'home', '--url', 'http://127.0.0.1:7900'], f);
  assert.match((await cli(['get', 'node'], f)).stdout, /home/, 'get node is get nodes');
  assert.match((await cli(['describe', 'nodes'], f)).stdout, /name\s+home/, 'describe nodes is describe node');
  assert.strictEqual(R.resolveResource('nodes').singular, 'node');
  assert.strictEqual(R.resolveResource('node').plural, 'nodes');
  const bad = await cli(['get', 'pods'], f);
  assert.match(bad.stderr, /unknown resource: pods .*nodes\|node/);
});

test('get nodes --current prints the name ALONE, and follows use node', async () => {
  const f = tmpCtx();
  await cli(['create', 'node', 'home', '--url', 'http://127.0.0.1:7900'], f);
  await cli(['create', 'node', 'work', '--url', 'http://127.0.0.1:7901'], f);
  let r = await cli(['get', 'nodes', '--current'], f);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, 'home\n', 'the name alone — kubectl config current-context');
  assert.strictEqual(r.stderr, '');
  r = await cli(['use', 'node', 'work'], f);
  assert.strictEqual(r.code, 0);
  r = await cli(['get', 'nodes', '--current'], f);
  assert.strictEqual(r.stdout, 'work\n');
});

test('get nodes --current with no current node exits 5 and names the fix', async () => {
  const f = tmpCtx();
  let r = await cli(['get', 'nodes', '--current'], f);
  assert.strictEqual(r.code, 5, 'EXIT.NOTFOUND — there is no current node to print');
  assert.strictEqual(r.stdout, '', 'nothing on stdout, so `$(clodexctl get nodes --current)` is empty not garbage');
  assert.match(r.stderr, /no current node \(clodexctl use node <name>\)/);

  await cli(['create', 'node', 'home', '--url', 'http://127.0.0.1:7900'], f);
  await cli(['delete', 'node', 'home', '--force'], f);
  r = await cli(['get', 'nodes', '--current'], f);
  assert.strictEqual(r.code, 5, 'deleting the current node clears it');
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

test('no node output carries a token — json, yaml, wide, name, or describe', async () => {
  const f = tmpCtx();
  await cli(['create', 'node', 'home', '--url', 'http://127.0.0.1:7900', '--token', 'SUPERSECRET'], f);
  await cli(['create', 'node', 'k8s', '--kubectl', 'pod/clodex-0', '--token', 'SECOND_TOKEN'], f);

  const json = await cli(['get', 'nodes', '-o', 'json'], f);
  assert.strictEqual(json.code, 0, `ENTER: the listing rendered (${json.stderr})`);
  const parsed = JSON.parse(json.stdout);
  assert.deepStrictEqual(parsed.nodes.map((n) => n.name).sort(), ['home', 'k8s'], 'ENTER: both entries are really in the payload');
  assert.strictEqual(findSecretKey(parsed), null, `-o json leaks a secret-shaped key at ${findSecretKey(parsed)}`);
  assert.strictEqual(parsed.nodes[0].tokenSet, true, 'redacted, not dropped — is a token set is still answerable');

  for (const argv of [
    ['get', 'nodes'],
    ['get', 'nodes', '-o', 'json'],
    ['get', 'nodes', '-o', 'yaml'],
    ['get', 'nodes', '-o', 'wide'],
    ['get', 'nodes', '-o', 'name'],
    ['describe', 'node', 'home'],
    ['describe', 'node', 'k8s'],
  ]) {
    const r = await cli(argv, f);
    assert.strictEqual(r.code, 0, `${argv.join(' ')} -> ${r.code}: ${r.stderr}`);
    assert.ok(r.stdout.length > 0, `ENTER: ${argv.join(' ')} printed nothing, so the absences below are vacuous`);
    assert.doesNotMatch(r.stdout, /SUPERSECRET/, `${argv.join(' ')} printed the current node's token`);
    assert.doesNotMatch(r.stdout, /SECOND_TOKEN/, `${argv.join(' ')} printed another node's token`);
  }

  assert.strictEqual(findSecretKey({ nodes: [{ e: { token: 'x' } }] }), '$.nodes[0].e.token');
});

test('`nodes` never reaches the wire resource gate — a node is a CLIENT record', async () => {
  const f = tmpCtx();
  await cli(['create', 'node', 'home', '--url', 'http://127.0.0.1:1', '--token', 't'], f);
  const asked = [];
  const client = { get: async (p) => { asked.push(p); throw new Error('the wire must not be consulted about nodes'); } };
  await assert.rejects(() => R.requireResource(client, 'nodes', 'list', 'home'),
    /the wire must not be consulted about nodes/,
    'ENTER: requireResource really is the gate, and it really dials');
  assert.deepStrictEqual(asked, ['/api/resources'], 'ENTER: the gate asks /api/resources');

  const spawnFn = () => { throw new Error('spawnFn called — a node verb opened a transport'); };
  for (const argv of [
    ['get', 'nodes'], ['get', 'nodes', '--current'], ['get', 'nodes', '-o', 'json'],
    ['describe', 'node', 'home'],
    ['create', 'node', 'other', '--url', 'http://127.0.0.1:2'],
    ['use', 'node', 'other'],
    ['delete', 'node', 'other', '--force'],
  ]) {
    const r = await cli(argv, f, { spawnFn });
    assert.strictEqual(r.code, 0, `${argv.join(' ')} -> ${r.code}: ${r.stderr}`);
  }
});

test('-o json answers every node write with an object, not a human sentence', async () => {
  const f = tmpCtx();
  let r = await cli(['create', 'node', 'home', '--url', 'http://127.0.0.1:1', '-o', 'json'], f);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), { name: 'home', created: true, current: 'home' });

  await cli(['create', 'node', 'work', '--ssh', 'u@box', '--remote-port', '7911'], f);
  r = await cli(['use', 'node', 'work', '-o', 'json'], f);
  assert.deepStrictEqual(JSON.parse(r.stdout), { current: 'work' });

  r = await cli(['get', 'nodes', '-o', 'json'], f);
  const row = JSON.parse(r.stdout).nodes.find((n) => n.name === 'work');
  assert.deepStrictEqual(row.transport, { ssh: 'u@box', remotePort: 7911 },
    'the structured transport survives -o json — the rendered locator is not the only machine-readable form');
});

test('the WIRE verbs refuse a node word outright — no dial, no silent success', async () => {
  const client = { get: async (p) => { throw new Error(`dialled ${p}`); }, post: async () => { throw new Error('dialled'); }, del: async () => { throw new Error('dialled'); } };
  const printed = [];
  const printer = { line: (s) => printed.push(s), json: (o) => printed.push(JSON.stringify(o)) };
  const bundle = { client, ctx: { name: 'home' }, printer, flags: {}, prompt: async () => 'x' };
  for (const [verb, args] of [
    ['get', ['nodes']],
    ['get', ['node']],
    ['describe', ['node', 'home']],
    ['describe', ['nodes']],
    ['create', ['node', 'x']],
    ['delete', ['node', 'x']],
  ]) {
    const fn = verb === 'delete' ? V.delete : V[verb];
    await assert.rejects(() => fn({ ...bundle, args }),
      (e) => {
        assert.strictEqual(e.exitCode, 2, `${verb} ${args.join(' ')} must be a USAGE error, not a dial or a silent resolve`);
        assert.match(e.message, /LOCAL record/, `${verb} ${args.join(' ')}: ${e.message}`);
        return true;
      },
      `${verb} ${args.join(' ')} resolved instead of throwing — the ctl tab would print nothing and exit 0`);
  }
  assert.deepStrictEqual(printed, [], 'nothing was rendered on the way to the refusal');

  await assert.rejects(() => V.get({ ...bundle, args: ['pods'] }), /unknown resource: pods/,
    'ENTER: an unrelated resource still reaches the normal parse path');
});

test('`use` bare names the resource it needs; `use session` is a USAGE error', async () => {
  const f = tmpCtx();
  let r = await cli(['use'], f);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /use needs a resource \(node\)/);

  r = await cli(['use', 'session', 'bob'], f);
  assert.strictEqual(r.code, 2, 'checkResourceWord refuses a resource use does not serve');
  assert.match(r.stderr, /use session is not supported \(node\)/);

  r = await cli(['use', 'node', 'ghost'], f);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /no such node: ghost/);
});

const POINTERS = [
  [['ctx'], 'get nodes'],
  [['ctx', 'add', 'home'], 'create node <name> --url URL'],
  [['ctx', 'use', 'home'], 'use node <name>'],
  [['ctx', 'current'], 'get nodes --current'],
  [['ctx', 'list'], 'get nodes'],
  [['ctx', 'ls'], 'get nodes'],
  [['ctx', 'show', 'home'], 'describe node [name]'],
  [['ctx', 'rm', 'home'], 'delete node <name>'],
  [['ctx', 'remove', 'home'], 'delete node <name>'],
  [['ctx', 'import'], 'create node --import'],
  [['ctx', 'test'], 'describe node [name] --test'],
];

for (const [argv, expected] of POINTERS) {
  test(`\`${argv.join(' ')}\` points at "${expected}", exit 1, and runs nothing`, async () => {
    let dialled = false;
    const r = await cli(argv, tmpCtx(), {
      spawnFn: () => { dialled = true; throw new Error('spawnFn called'); },
    });
    assert.strictEqual(r.code, 1, `${argv.join(' ')}: ${r.stderr}`);
    assert.ok(r.stderr.includes(`was renamed: use clodexctl ${expected}`), `${argv.join(' ')}: ${r.stderr}`);
    assert.strictEqual(dialled, false, `${argv.join(' ')} must run nothing`);
    assert.strictEqual(r.stdout, '', 'the pointer goes to stderr — stdout stays scriptable');
    const sub = argv[1];
    if (sub) assert.strictEqual(typeof RENAMED_SECOND.ctx[sub], 'function', `ctx.${sub} must have its own row`);
  });
}

test('an UNKNOWN ctx sub still points rather than reporting a subcommand', async () => {
  const r = await cli(['ctx', 'nope'], tmpCtx());
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /clodexctl ctx nope was renamed: use clodexctl get nodes/);
  assert.doesNotMatch(r.stderr, /unknown ctx subcommand/);
});

test('every deleted sub has its own pointer row — not a default that flattens them', async () => {
  const subs = ['add', 'use', 'current', 'list', 'ls', 'show', 'rm', 'remove', 'import', 'test'];
  for (const s of subs) {
    assert.strictEqual(typeof RENAMED_SECOND.ctx[s], 'function', `${s} must be in the table`);
  }
  const destinations = new Set(subs.map((s) => RENAMED_SECOND.ctx[s]()));
  assert.ok(destinations.size >= 6, `the rows must not collapse to one destination (got ${destinations.size})`);
});

test('create node tunnel: greedy argv, {port} required', async () => {
  const f = tmpCtx();
  let r = await cli(['create', 'node', 'k8s', '--token', 't', '--tunnel', 'kubectl', 'port-forward', 'pod/x', '{port}:7900'], f);
  assert.strictEqual(r.code, 0);
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(saved.contexts.k8s.tunnel, ['kubectl', 'port-forward', 'pod/x', '{port}:7900']);

  r = await cli(['create', 'node', 'bad', '--token', 't', '--tunnel', 'kubectl', 'port-forward'], f);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\{port\} placeholder/);
});

test('create node: conflicting transports rejected', async () => {
  const f = tmpCtx();
  const r = await cli(['create', 'node', 'x', '--url', 'http://h', '--ssh', 'u@h'], f);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /conflicting transports/);
});

test('get nodes KIND names the flag that created the record, not the shared family', async () => {
  const f = tmpCtx();
  await cli(['create', 'node', 'ec2', '--ssm', 'i-0abc'], f);
  await cli(['create', 'node', 'far', '--ssm-ecs', 'CLUSTER/clodex'], f);
  await cli(['create', 'node', 'gcp', '--gcloud-iap', 'clodex-node', '--zone', 'z'], f);
  await cli(['create', 'node', 'azv', '--az-bastion', 'b', '--az-resource-group', 'g', '--az-target', '/s/vm1'], f);
  const r = await cli(['get', 'nodes'], f);
  assert.match(r.stdout, /ec2\s+ssm\s+i-0abc/);
  assert.match(r.stdout, /far\s+ssm-ecs\s+ecs CLUSTER\/clodex/);
  assert.match(r.stdout, /gcp\s+gcloud-iap\s+clodex-node/);
  assert.match(r.stdout, /azv\s+az-bastion\s+b → vm1/);
});

test('delete node confirms by name unless --force, and --force is required for -o json', async () => {
  const f = tmpCtx();
  await cli(['create', 'node', 'doomed', '--url', 'http://h'], f);

  let r = await cli(['delete', 'node', 'doomed', '-o', 'json'], f);
  assert.strictEqual(r.code, 2, 'no prompt to answer in machine mode');
  assert.match(r.stderr, /delete node needs --force/);

  r = await cli(['delete', 'node', 'doomed'], f, { prompt: async () => 'wrong' });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /aborted — confirmation did not match/);
  assert.ok(JSON.parse(fs.readFileSync(f, 'utf8')).contexts.doomed, 'an aborted delete keeps the record');

  r = await cli(['delete', 'node', 'doomed'], f, { prompt: async () => 'doomed' });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).contexts.doomed, undefined);
});

test('describe node --test (direct): reports identity', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200); res.end(JSON.stringify({ ok: true, app: 'clodex', host: 'box', version: '3.4.0', caps: ['send'] }));
  });
  const port = await new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
  const r = await cli(['describe', 'node', '--test', '--url', `http://127.0.0.1:${port}`], tmpCtx());
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /OK — clodex host=box/);
  server.close();
});

test('describe node <name> --test selects that node, not the current one', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200); res.end(JSON.stringify({ ok: true, app: 'clodex', host: 'named', version: '3.4.0', caps: [] }));
  });
  const port = await new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
  const f = tmpCtx();
  await cli(['create', 'node', 'current-one', '--url', 'http://127.0.0.1:1'], f);
  await cli(['create', 'node', 'wanted', '--url', `http://127.0.0.1:${port}`], f);
  const r = await cli(['describe', 'node', 'wanted', '--test', '--verbose'], f);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /host=named/, 'the NAME on the argv chose the node');
  assert.match(r.stdout, new RegExp(`base: http://127\\.0\\.0\\.1:${port}`));
  server.close();
});

test('describe node --test (tunnel): relays child stderr verbatim on failure', async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.pid = null;
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('kubectl: pods "x" not found'));
      child.emit('exit', 1);
    });
    return child;
  };
  const f = tmpCtx();
  await cli(['create', 'node', 'k8s', '--token', 't', '--tunnel', 'kubectl', 'port-forward', 'x', '{port}:7900'], f);
  const r = await cli(['describe', 'node', 'k8s', '--test'], f, { spawnFn });
  assert.strictEqual(r.code, 3, 'EXIT.CONNECT');
  assert.match(r.stderr, /pods "x" not found/);
});
