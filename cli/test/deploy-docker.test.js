'use strict';
// deploy-docker.test.js — the `deploy docker <name>` flavor: pure argv/host
// helpers, and the full flow through main.run against a FAKE docker child (the
// spawnFn seam) that records argv + env, prints a container id, and exits 0/1.
// Verify (hello poll) is injected via io.pollHello so no real wire is touched.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const D = require('../src/deploy');
const { run } = require('../src/main');

// ── pure helpers ─────────────────────────────────────────────────────────────

test('normalizeDockerHost: bare user@box → ssh://; scheme passed through', () => {
  assert.strictEqual(D.normalizeDockerHost('user@box'), 'ssh://user@box');
  assert.strictEqual(D.normalizeDockerHost('box'), 'ssh://box');
  assert.strictEqual(D.normalizeDockerHost('ssh://user@box'), 'ssh://user@box');
  assert.strictEqual(D.normalizeDockerHost('tcp://1.2.3.4:2375'), 'tcp://1.2.3.4:2375');
  assert.strictEqual(D.normalizeDockerHost(''), '');
});

test('dockerHostToSshDest: only ssh:// hosts, :port stripped, non-ssh → empty', () => {
  assert.strictEqual(D.dockerHostToSshDest('ssh://user@box'), 'user@box');
  assert.strictEqual(D.dockerHostToSshDest('ssh://user@box:2222'), 'user@box');
  assert.strictEqual(D.dockerHostToSshDest('ssh://box/path'), 'box');
  assert.strictEqual(D.dockerHostToSshDest('tcp://1.2.3.4:2375'), '');
  assert.strictEqual(D.dockerHostToSshDest(''), '');
});

test('dockerRunArgs: exact argv — name/hostname/loopback publish/data volume', () => {
  const a = D.dockerRunArgs({ name: 'mybox', port: 7900, image: 'ghcr.io/avirtual/clodex:latest' });
  assert.deepStrictEqual(a, [
    'run', '-d',
    '--name', 'clodexctl-mybox',
    '--hostname', 'mybox',
    '--restart', 'unless-stopped',
    '-p', '127.0.0.1:7900:7900',
    '-v', 'clodexctl-mybox-data:/data',
    'ghcr.io/avirtual/clodex:latest',
  ]);
});

test('dockerRunArgs: env-file + repeated volumes ride in order, image last', () => {
  const a = D.dockerRunArgs({ name: 'n', port: 8100, image: 'img:1', envFile: '/secrets/x.env', volumes: ['/host:/c:ro', 'vol:/d'] });
  assert.strictEqual(a[a.length - 1], 'img:1');
  assert.ok(a.includes('--env-file') && a.includes('/secrets/x.env'));
  assert.match(a.join(' '), /-p 127\.0\.0\.1:8100:7900/);
  // both -v passthroughs present after the data volume
  assert.match(a.join(' '), /-v clodexctl-n-data:\/data .*-v \/host:\/c:ro -v vol:\/d img:1/);
});

// ── flow: fake docker ────────────────────────────────────────────────────────

// A fake docker child (spawnFn shape): records cmd/argv/env, streams optional
// stderr, prints a container id on stdout, exits with `exitCode`.
function fakeDocker(rec, { id = 'deadbeefcafe0000', exitCode = 0, stderr = '' } = {}) {
  return (cmd, args, opts) => {
    rec.cmd = cmd; rec.args = args; rec.env = (opts && opts.env) || null;
    const child = new EventEmitter();
    child.pid = 4321;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      if (exitCode === 0 && id) child.stdout.emit('data', Buffer.from(id + '\n'));
      child.emit('exit', exitCode, null);
    });
    child.kill = () => { rec.killed = true; };
    return child;
  };
}

async function cli(argv, io = {}) {
  let stdout = '', stderr = '';
  const code = await run(argv, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: {},
    contextsFile: io.contextsFile || path.join(os.tmpdir(), 'nonexistent-clodexctl', 'contexts.json'),
    ...io,
  });
  return { code, stdout, stderr };
}

function tmpCtxFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-docker-'));
  return path.join(dir, 'contexts.json');
}

test('deploy docker happy path: argv composed, verified, local url ctx saved', async () => {
  const rec = {};
  const pollCalls = [];
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'docker', 'mybox'], {
    spawnFn: fakeDocker(rec),
    pollHello: async (ctx) => { pollCalls.push(ctx); return { ok: true, hello: { app: 'clodex', host: 'mybox', version: '9.9.9', caps: [] } }; },
    contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(rec.cmd, 'docker');
  assert.strictEqual(rec.args[0], 'run');
  assert.ok(rec.args.includes('clodexctl-mybox'));
  assert.strictEqual(rec.args[rec.args.length - 1], 'ghcr.io/avirtual/clodex:latest');
  assert.strictEqual(rec.env, null);   // local → no DOCKER_HOST override
  assert.match(stdout, /started container clodexctl-mybox \(deadbeefcafe\)/);
  assert.match(stdout, /verified — clodex host=mybox version=9\.9\.9/);
  assert.match(stdout, /context "mybox" saved/);
  assert.deepStrictEqual(pollCalls, [{ url: 'http://127.0.0.1:7900' }]);
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.deepStrictEqual(saved.contexts.mybox, { url: 'http://127.0.0.1:7900' });
  assert.strictEqual(saved.current, 'mybox');
});

test('deploy docker --tag/--image/--port/--volume: argv + non-default url', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  const { code } = await cli(['deploy', 'docker', 'n', '--port', '8100', '--tag', 'v1.2.3', '--volume', '/h:/c:ro'], {
    spawnFn: fakeDocker(rec),
    pollHello: async () => ({ ok: true, hello: { app: 'clodex' } }),
    contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(rec.args[rec.args.length - 1], 'ghcr.io/avirtual/clodex:v1.2.3');
  assert.match(rec.args.join(' '), /-p 127\.0\.0\.1:8100:7900/);
  assert.match(rec.args.join(' '), /-v \/h:\/c:ro/);
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.deepStrictEqual(saved.contexts.n, { url: 'http://127.0.0.1:8100' });
});

test('deploy docker --image overrides repo+tag entirely', async () => {
  const rec = {};
  const { code } = await cli(['deploy', 'docker', 'n', '--image', 'my.reg/clodex:pinned', '--tag', 'ignored'], {
    spawnFn: fakeDocker(rec),
    pollHello: async () => ({ ok: true, hello: {} }),
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(rec.args[rec.args.length - 1], 'my.reg/clodex:pinned');
});

test('deploy docker --host: DOCKER_HOST in child env, remote ssh ctx saved', async () => {
  const rec = {};
  const pollCalls = [];
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'docker', 'edge', '--host', 'user@box', '--port', '8100'], {
    spawnFn: fakeDocker(rec),
    pollHello: async (ctx) => { pollCalls.push(ctx); return { ok: true, hello: { app: 'clodex', host: 'edge' } }; },
    contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(rec.env.DOCKER_HOST, 'ssh://user@box');
  assert.deepStrictEqual(pollCalls, [{ ssh: 'user@box', remotePort: 8100 }]);
  assert.match(stdout, /context "edge" saved/);
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.deepStrictEqual(saved.contexts.edge, { ssh: 'user@box', remotePort: 8100 });
});

test('deploy docker --env-file: passed to docker argv, never read (no fs access)', async () => {
  const rec = {};
  const { code } = await cli(['deploy', 'docker', 'n', '--env-file', '/nope/does/not/exist.env'], {
    spawnFn: fakeDocker(rec),
    pollHello: async () => ({ ok: true, hello: {} }),
  });
  assert.strictEqual(code, 0);   // we never stat/read it — docker would
  assert.ok(rec.args.includes('--env-file') && rec.args.includes('/nope/does/not/exist.env'));
});

test('deploy docker: 401 during verify → success-with-note, ctx still saved', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'docker', 'gated'], {
    spawnFn: fakeDocker(rec),
    pollHello: async () => ({ ok: true, tokenGated: true }),
    contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.match(stdout, /token-gated \(401\)/);
  assert.match(stdout, /context "gated" saved.*token-gated/);
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.deepStrictEqual(saved.contexts.gated, { url: 'http://127.0.0.1:7900' });
  assert.strictEqual(saved.contexts.gated.token, undefined);
});

test('deploy docker --dry-run: composes but spawns nothing, saves nothing', async () => {
  let spawned = false;
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'docker', 'n', '--host', 'user@box', '--dry-run'], {
    spawnFn: () => { spawned = true; throw new Error('should not spawn'); },
    pollHello: async () => { throw new Error('should not poll'); },
    contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(spawned, false);
  assert.match(stdout, /dry-run — would run docker to birth "n"/);
  assert.match(stdout, /DOCKER_HOST=ssh:\/\/user@box/);
  assert.match(stdout, /docker run -d --name clodexctl-n/);
  assert.strictEqual(fs.existsSync(contextsFile), false);
});

test('deploy docker --no-ctx: verifies but saves nothing', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'docker', 'n', '--no-ctx'], {
    spawnFn: fakeDocker(rec),
    pollHello: async () => ({ ok: true, hello: { app: 'clodex' } }),
    contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.match(stdout, /verified/);
  assert.doesNotMatch(stdout, /context .* saved/);
  assert.strictEqual(fs.existsSync(contextsFile), false);
});

test('deploy docker: ctx collision kept unless --force', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  fs.mkdirSync(path.dirname(contextsFile), { recursive: true });
  fs.writeFileSync(contextsFile, JSON.stringify({ current: null, contexts: { n: { url: 'http://old' } } }));
  const skip = await cli(['deploy', 'docker', 'n'], { spawnFn: fakeDocker(rec), pollHello: async () => ({ ok: true, hello: {} }), contextsFile });
  assert.strictEqual(skip.code, 0);
  assert.match(skip.stdout, /already exists — kept it/);
  assert.strictEqual(JSON.parse(fs.readFileSync(contextsFile, 'utf8')).contexts.n.url, 'http://old');
  const force = await cli(['deploy', 'docker', 'n', '--force'], { spawnFn: fakeDocker({}), pollHello: async () => ({ ok: true, hello: {} }), contextsFile });
  assert.strictEqual(force.code, 0);
  assert.match(force.stdout, /context "n" updated/);
  assert.strictEqual(JSON.parse(fs.readFileSync(contextsFile, 'utf8')).contexts.n.url, 'http://127.0.0.1:7900');
});

test('deploy docker: nonzero docker exit relays stderr → EXIT.SERVER, no verify/ctx', async () => {
  const rec = {};
  let polled = false;
  const contextsFile = tmpCtxFile();
  const { code, stderr } = await cli(['deploy', 'docker', 'n'], {
    spawnFn: fakeDocker(rec, { exitCode: 1, stderr: 'docker: Error response from daemon: conflict.\n' }),
    pollHello: async () => { polled = true; return { ok: true }; },
    contextsFile,
  });
  assert.strictEqual(code, 1);
  assert.match(stderr, /Error response from daemon/);   // docker's own stderr streamed through
  assert.strictEqual(polled, false);
  assert.strictEqual(fs.existsSync(contextsFile), false);
});

test('deploy docker: missing docker binary (ENOENT) → EXIT.SERVER + install hint', async () => {
  const { code, stderr } = await cli(['deploy', 'docker', 'n'], {
    spawnFn: () => { const e = new Error('spawn docker ENOENT'); e.code = 'ENOENT'; throw e; },
    pollHello: async () => ({ ok: true }),
  });
  assert.strictEqual(code, 1);
  assert.match(stderr, /is docker installed and on PATH\?/);
});

test('deploy docker: bad node name is a usage error, no spawn', async () => {
  let spawned = false;
  const { code, stderr } = await cli(['deploy', 'docker', 'bad name!'], {
    spawnFn: () => { spawned = true; throw new Error('x'); },
    pollHello: async () => ({ ok: true }),
  });
  assert.strictEqual(code, 2);
  assert.match(stderr, /bad node name/);
  assert.strictEqual(spawned, false);
});

test('deploy docker: no name → usage error', async () => {
  const { code, stderr } = await cli(['deploy', 'docker'], { spawnFn: () => { throw new Error('x'); }, pollHello: async () => ({ ok: true }) });
  assert.strictEqual(code, 2);
  assert.match(stderr, /deploy docker needs a node name/);
});

test('deploy docker --json: run + verify + context objects, no secrets', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'docker', 'n', '--json'], {
    spawnFn: fakeDocker(rec),
    pollHello: async () => ({ ok: true, hello: { app: 'clodex', host: 'n', version: '1.0', caps: [] } }),
    contextsFile,
  });
  assert.strictEqual(code, 0);
  const objs = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(objs[0], { type: 'verify', ok: true, host: 'n', version: '1.0', caps: [] });
  assert.deepStrictEqual(objs[1], { type: 'context', action: 'added', name: 'n', tokenGated: false });
});

test('deploy docker --json 401: verify tokenGated + context tokenGated', async () => {
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'docker', 'n', '--json'], {
    spawnFn: fakeDocker({}),
    pollHello: async () => ({ ok: true, tokenGated: true }),
    contextsFile,
  });
  assert.strictEqual(code, 0);
  const objs = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(objs[0], { type: 'verify', ok: true, tokenGated: true });
  assert.deepStrictEqual(objs[1], { type: 'context', action: 'added', name: 'n', tokenGated: true });
});

test('deploy docker: verify timeout throws EXIT.SERVER, no ctx', async () => {
  const contextsFile = tmpCtxFile();
  const { code, stdout, stderr } = await cli(['deploy', 'docker', 'n'], {
    spawnFn: fakeDocker({}),
    pollHello: async () => { throw new (require('../src/errors').CliError)(1, 'container is up but its wire did not answer within 60s'); },
    contextsFile,
  });
  assert.strictEqual(code, 1);
  assert.match(stdout + stderr, /did not answer/);
  assert.strictEqual(fs.existsSync(contextsFile), false);
});

// ── dispatch sniff: ssh flavor unchanged, `ssh` alias works ──────────────────

test('deploy <user@host> still routes to the ssh flavor (byte-unchanged dispatch)', async () => {
  // A bad ssh dest reaches the ssh verb's validator (proves routing), not docker.
  const { code, stderr } = await cli(['deploy', 'host:7900'], { spawnFn: () => { throw new Error('x'); } });
  assert.strictEqual(code, 2);
  assert.match(stderr, /bad ssh destination/);
});

test('deploy ssh <dest> alias routes to the ssh flavor', async () => {
  const { code, stderr } = await cli(['deploy', 'ssh', 'host:7900'], { spawnFn: () => { throw new Error('x'); } });
  assert.strictEqual(code, 2);
  assert.match(stderr, /bad ssh destination/);   // 'host:7900' is the dest, validated by ssh verb
});

// ── unit: pollHello against a real local wire (url transport, no spawn) ───────

const http = require('node:http');

function tinyWire(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, close: () => new Promise((r) => srv.close(r)) }));
  });
}

test('pollHello: 200 hello resolves { ok, hello } (real url transport)', async () => {
  const wire = await tinyWire((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app: 'clodex', host: 'n', version: '1.0' }));
  });
  try {
    const r = await D.pollHello({ url: `http://127.0.0.1:${wire.port}` }, { timeoutMs: 3000, pollMs: 50 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.hello.host, 'n');
  } finally { await wire.close(); }
});

test('pollHello: 401 short-circuits to tokenGated (no retry)', async () => {
  let hits = 0;
  const wire = await tinyWire((req, res) => { hits++; res.writeHead(401); res.end(JSON.stringify({ error: 'token required' })); });
  try {
    const r = await D.pollHello({ url: `http://127.0.0.1:${wire.port}` }, { timeoutMs: 3000, pollMs: 50 });
    assert.deepStrictEqual(r, { ok: true, tokenGated: true });
    assert.strictEqual(hits, 1);   // stopped on the first auth response
  } finally { await wire.close(); }
});

test('pollHello: unreachable url retries then times out → EXIT.SERVER', async () => {
  const { EXIT } = require('../src/errors');
  // A port nobody listens on: every attempt is a connect failure until deadline.
  await assert.rejects(
    () => D.pollHello({ url: 'http://127.0.0.1:1' }, { timeoutMs: 300, pollMs: 50 }),
    (e) => e.exitCode === EXIT.SERVER && /did not answer within/.test(e.message),
  );
});
