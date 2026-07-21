'use strict';
// verbs-ctx.test.js — the local ctx file verbs through main.run (add/use/list/
// show/rm), token redaction in show, and `ctx test` opening a fake transport +
// hitting hello. No wire for add/use/list/rm; a stub http for `ctx test`.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { run } = require('../src/main');

function tmpCtx() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxv-'));
  return path.join(d, 'contexts.json');
}

async function cli(argv, file, extra = {}) {
  let stdout = '', stderr = '';
  const code = await run(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), env: {}, contextsFile: file, ...extra });
  return { code, stdout, stderr };
}

test('ctx add/use/list/show/rm round-trip through the file', async () => {
  const f = tmpCtx();
  let r = await cli(['ctx', 'add', 'home', '--url', 'http://127.0.0.1:7900', '--token', 'sek'], f);
  assert.strictEqual(r.code, 0);
  assert.strictEqual((fs.statSync(f).mode & 0o777), 0o600);

  r = await cli(['ctx', 'add', 'work', '--ssh', 'user@box'], f);
  assert.strictEqual(r.code, 0);

  r = await cli(['ctx', 'list'], f);
  assert.match(r.stdout, /\*\s+home/); // home is current (first added)
  assert.match(r.stdout, /work\s+ssh\s+user@box/);

  r = await cli(['ctx', 'use', 'work'], f);
  assert.strictEqual(r.code, 0);
  r = await cli(['ctx', 'list', '--json'], f);
  assert.strictEqual(JSON.parse(r.stdout).current, 'work');

  // show redacts the token
  r = await cli(['ctx', 'show', 'home'], f);
  assert.match(r.stdout, /token\s+\(set\)/);
  assert.doesNotMatch(r.stdout, /sek/);
  r = await cli(['ctx', 'show', 'home', '--json'], f);
  assert.strictEqual(JSON.parse(r.stdout).token, '***');

  r = await cli(['ctx', 'rm', 'home'], f);
  assert.strictEqual(r.code, 0);
  r = await cli(['ctx', 'list', '--json'], f);
  assert.strictEqual(JSON.parse(r.stdout).contexts.home, undefined);
});

test('ctx add tunnel: greedy argv, {port} required', async () => {
  const f = tmpCtx();
  let r = await cli(['ctx', 'add', 'k8s', '--token', 't', '--tunnel', 'kubectl', 'port-forward', 'pod/x', '{port}:7900'], f);
  assert.strictEqual(r.code, 0);
  r = await cli(['ctx', 'show', 'k8s', '--json'], f);
  assert.deepStrictEqual(JSON.parse(r.stdout).tunnel, ['kubectl', 'port-forward', 'pod/x', '{port}:7900']);

  // missing {port} → usage error
  r = await cli(['ctx', 'add', 'bad', '--token', 't', '--tunnel', 'kubectl', 'port-forward'], f);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /\{port\} placeholder/);
});

test('ctx add: conflicting transports rejected', async () => {
  const f = tmpCtx();
  const r = await cli(['ctx', 'add', 'x', '--url', 'http://h', '--ssh', 'u@h'], f);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /conflicting transports/);
});

// fake spawn that opens a listener on the substituted {port}, like the
// transport test, so `ctx test` can open a tunnel and speak to a stub server
// bound on that same port... but the stub must own the port. Simpler: use a
// DIRECT ctx for the happy path and a fake tunnel for the stderr-relay path.
test('ctx test (direct): reports identity', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200); res.end(JSON.stringify({ ok: true, app: 'clodex', host: 'box', version: '3.4.0', caps: ['send'] }));
  });
  const port = await new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
  const r = await cli(['ctx', 'test', '--url', `http://127.0.0.1:${port}`], tmpCtx());
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /OK — clodex host=box/);
  server.close();
});

test('ctx test (tunnel): relays child stderr verbatim on failure', async () => {
  // fake spawn: a child that immediately "exits" without listening, carrying a
  // stderr line — openTransport must fail and surface it.
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
  await cli(['ctx', 'add', 'k8s', '--token', 't', '--tunnel', 'kubectl', 'port-forward', 'x', '{port}:7900'], f);
  const r = await cli(['ctx', 'test', '--ctx', 'k8s'], f, { spawnFn });
  assert.strictEqual(r.code, 3); // EXIT.CONNECT
  assert.match(r.stderr, /pods "x" not found/);
});
