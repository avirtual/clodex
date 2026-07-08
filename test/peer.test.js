'use strict';

// Peering protocol integration: RemoteServer (owner side, remote.js) driven
// by a real PeerConnection (consumer side, peer-client.js) over loopback.
// Covers: hello/caps, attach replay, live output fan-out, status-bar
// telemetry (seed + live), control tokens (read-only viewers can't type),
// release-on-detach, exit teardown.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { RemoteServer } = require('../remote');
const { PeerConnection } = require('../peer-client');

// ---- owner-side fakes ----
const inputs = [];
const resizes = [];
const controlChanges = [];
const fakeSessions = [{ name: 'alpha', type: 'claude', cwd: '/tmp/x', workspace: 'w', stats: {} }];

let server;
let conn;
const events = [];

function waitFor(pred, what, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = pred();
      if (hit) return resolve(hit);
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function post(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1', port: server.port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

before(async () => {
  server = new RemoteServer({
    port: 0,
    pagePath: '/nonexistent',
    getSessions: () => fakeSessions,
    getTranscript: () => ({ ok: true, messages: [] }),
    send: () => ({ ok: true }),
    hostLabel: 'testhost',
    version: '0.0.0-test',
    getAttachInfo: (name) => (name === 'alpha'
      ? {
          ok: true, scrollback: Buffer.from('hello world'), cols: 100, rows: 30,
          telemetry: {
            proxy: { linked: true, model: 'test-model', warmth: { state: 'warm', remaining_s: 120 } },
            ctx: { pct: 42, tok: 84000, size: 200000 },
          },
        }
      : { ok: false }),
    sendInput: (name, data) => { inputs.push([name, data]); return { ok: true }; },
    resizePty: (name, cols, rows) => { resizes.push([name, cols, rows]); return { ok: true }; },
    onControlChange: (name, holder) => controlChanges.push([name, holder]),
    query: (name, kind, args) => {
      if (name !== 'alpha') return { ok: false, error: 'no such session' };
      if (kind === 'files') return { ok: true, cwd: '/tmp/x', files: [{ path: '/tmp/x/a.js', tool: 'Edit' }] };
      if (kind === 'filePeek') return { ok: true, size: 5, binary: false, truncated: false, content: `peek:${(args && args.path) || ''}` };
      if (kind === 'slow') return new Promise((r) => setTimeout(() => r({ ok: true, data: 'eventually' }), 50));
      if (kind === 'boom') throw new Error('kaput');
      return { ok: false, error: `unknown query kind: ${kind}` };
    },
  });
  await server.start();
  conn = new PeerConnection({
    id: 'p1', label: 'lab', url: `http://127.0.0.1:${server.port}`,
    emit: (channel, ...args) => events.push({ channel, args }),
  });
  conn.start();
});

after(() => {
  if (conn) conn.stop();
  if (server) server.stop();
});

test('hello: identity and caps reach the peer, connection goes online', async () => {
  const st = await waitFor(() => {
    const e = [...events].reverse().find((x) => x.channel === 'peer-state');
    const s = e && e.args[1];
    return s && s.online && s.sessions.length === 1 ? s : null;
  }, 'online peer-state with sessions');
  assert.equal(st.host, 'testhost');
  assert.ok(st.caps.includes('attach'));
  assert.ok(st.caps.includes('control'));
  assert.ok(st.caps.includes('query'));
  assert.equal(st.sessions[0].name, 'alpha');
});

test('attach: replay carries scrollback and owner geometry', async () => {
  conn.attach('alpha');
  const rep = await waitFor(() => events.find((x) => x.channel === 'peer-replay'), 'peer-replay');
  const [, name, info] = rep.args;
  assert.equal(name, 'alpha');
  assert.equal(info.data.toString('utf8'), 'hello world');
  assert.equal(info.cols, 100);
  assert.equal(info.rows, 30);
  assert.equal(info.holder, null);
});

test('live output fans out to the attached peer', async () => {
  server.pushOutput('alpha', 'fresh bytes');
  const ev = await waitFor(() => events.find((x) => x.channel === 'peer-data'), 'peer-data');
  assert.equal(ev.args[2].toString('utf8'), 'fresh bytes');
});

test('telemetry: attach seeds the status bar, live pushes fan out', async () => {
  // The seed frame rides right behind the replay (an empty bar for a full
  // poll tick reads broken).
  const seed = await waitFor(() => events.find((x) => x.channel === 'peer-telemetry'), 'seed telemetry');
  assert.equal(seed.args[1], 'alpha');
  assert.equal(seed.args[2].proxy.model, 'test-model');
  assert.equal(seed.args[2].proxy.warmth.state, 'warm');
  assert.equal(seed.args[2].ctx.pct, 42);

  // Live pushes are partial frames ({proxy} or {ctx}); the client merges.
  server.pushTelemetry('alpha', { proxy: { linked: true, model: 'test-model', turns: 7 } });
  const live = await waitFor(
    () => events.find((x) => x.channel === 'peer-telemetry' && x.args[2].proxy && x.args[2].proxy.turns === 7),
    'live telemetry');
  assert.equal(live.args[1], 'alpha');
  assert.equal(live.args[2].ctx, undefined);
});

test('input without control is refused (read-only by default)', async () => {
  const r = await post('/api/input/alpha', { token: 'bogus', data: 'evil' });
  assert.equal(r.status, 403);
  assert.equal(inputs.length, 0);
});

test('control: acquire grants input+resize, owner is notified', async () => {
  await new Promise((resolve, reject) => conn.control('alpha', true, (r) => (r.ok ? resolve() : reject(new Error(r.error)))));
  await waitFor(() => controlChanges.some(([n, h]) => n === 'alpha' && h === 'peer:lab'), 'owner control notification');
  // control event also reaches the attached viewer
  await waitFor(() => events.some((x) => x.channel === 'peer-control' && x.args[2] === 'peer:lab'), 'peer-control event');

  await new Promise((resolve) => conn.input('alpha', 'ls\r', resolve));
  assert.deepEqual(inputs[inputs.length - 1], ['alpha', 'ls\r']);

  await new Promise((resolve) => conn.resize('alpha', 120, 40, resolve));
  assert.deepEqual(resizes[resizes.length - 1], ['alpha', 120, 40]);
});

test('release: input is refused again', async () => {
  await new Promise((resolve) => conn.control('alpha', false, resolve));
  await waitFor(() => controlChanges.some(([n, h]) => n === 'alpha' && h === null), 'owner release notification');
  const n = inputs.length;
  await new Promise((resolve) => conn.input('alpha', 'nope', resolve));
  assert.equal(inputs.length, n);
});

test('resize dimensions are bounded', async () => {
  await new Promise((resolve, reject) => conn.control('alpha', true, (r) => (r.ok ? resolve() : reject(new Error(r.error)))));
  const n = resizes.length;
  await new Promise((resolve) => conn.resize('alpha', 5000, 2, resolve));
  assert.equal(resizes.length, n);
});

test('query: popover pulls round-trip with kind + args', async () => {
  const files = await new Promise((r) => conn.query('alpha', 'files', null, r));
  assert.ok(files.ok);
  assert.equal(files.cwd, '/tmp/x');
  assert.equal(files.files[0].path, '/tmp/x/a.js');

  const peek = await new Promise((r) => conn.query('alpha', 'filePeek', { path: '/tmp/x/a.js' }, r));
  assert.ok(peek.ok);
  assert.equal(peek.content, 'peek:/tmp/x/a.js');

  // Async owner-side sources (disk scans) are awaited, not dropped.
  const slow = await new Promise((r) => conn.query('alpha', 'slow', null, r));
  assert.ok(slow.ok);
  assert.equal(slow.data, 'eventually');
});

test('query: unknown kinds and throwing sources answer as errors, never hang', async () => {
  const unk = await new Promise((r) => conn.query('alpha', 'nope', null, r));
  assert.equal(unk.ok, false);
  assert.match(unk.error, /unknown query kind/);

  const boom = await new Promise((r) => conn.query('alpha', 'boom', null, r));
  assert.equal(boom.ok, false);
  assert.equal(boom.error, 'kaput');

  const gone = await new Promise((r) => conn.query('beta', 'files', null, r));
  assert.equal(gone.ok, false);
});

test('exit: attachers hear it and the stream tears down', async () => {
  server.notifyExit('alpha', 0);
  const ev = await waitFor(() => events.find((x) => x.channel === 'peer-exit'), 'peer-exit');
  assert.equal(ev.args[1], 'alpha');
  assert.equal(ev.args[2], 0);
  // exit auto-released control on the owner side
  assert.deepEqual(controlChanges[controlChanges.length - 1], ['alpha', null]);
});
