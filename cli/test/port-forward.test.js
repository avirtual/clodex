'use strict';
// port-forward.test.js — the foreground-tunnel verb WITHOUT real ssh/aws. Spec
// parsing, url-kind rejection, the `web` sugar, the signal→exit-0 hold, and the
// tunnel-died→CONNECT path — all driven through injected openTransport/onSignal
// seams so nothing touches the network.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/main');
const { parseForwardSpec } = require('../src/port-forward');

const NOFILE = path.join(os.tmpdir(), 'nonexistent-clodexctl-pf', 'contexts.json');

// A fake transport whose waitExit is controllable — resolve it to simulate the
// tunnel child dying; leave it pending to simulate a healthy hold.
function fakeTransport({ stderr = '' } = {}) {
  let resolveExit;
  const rec = { closed: false, openedWith: null };
  const t = {
    localPort: null, // filled per-open below
    close() { rec.closed = true; },
    stderr: () => stderr,
    waitExit: () => new Promise((r) => { resolveExit = r; }),
  };
  return { t, rec, die: () => resolveExit && resolveExit() };
}

// Drive main.run for `port-forward SPEC` with an ssh ctx from flags + injected
// seams. Returns { code, stdout, stderr, rec, fireSignal }.
async function runPF(spec, { ctxFlags = ['--ssh', 'user@box'], transport, onSignalCapture } = {}) {
  let stdout = '', stderr = '';
  let signalCb = null;
  const { t, rec } = transport || fakeTransport();
  const code = await run(['port-forward', spec, ...ctxFlags], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: {},
    contextsFile: NOFILE,
    openTransport: async (ctx, opts) => {
      rec.openedWith = { ctx, opts };
      t.localPort = opts.localPort;
      return t;
    },
    onSignal: (cb) => { signalCb = cb; if (onSignalCapture) onSignalCapture(() => cb()); return () => {}; },
  });
  return { code, stdout, stderr, rec, fireSignal: () => signalCb && signalCb() };
}

// ── parseForwardSpec (pure) ──────────────────────────────────────────────────

test('parseForwardSpec: LOCAL:REMOTE numeric', () => {
  assert.deepStrictEqual(parseForwardSpec('8080:7900', {}), { local: 8080, remote: 7900, remoteLabel: '7900' });
});

test('parseForwardSpec: web sugar → wire+1 by default', () => {
  const r = parseForwardSpec('8080:web', { remotePort: 7900 });
  assert.strictEqual(r.remote, 7901);
  assert.strictEqual(r.remoteLabel, 'web(7901)');
});

test('parseForwardSpec: web sugar honors an explicit ctx.webPort', () => {
  assert.strictEqual(parseForwardSpec('8080:web', { remotePort: 7900, webPort: 9000 }).remote, 9000);
});

test('parseForwardSpec: web sugar defaults wire to 7900 when ctx has no remotePort', () => {
  assert.strictEqual(parseForwardSpec('8080:web', {}).remote, 7901);
});

test('parseForwardSpec: rejects a missing colon', () => {
  assert.throws(() => parseForwardSpec('8080', {}), (e) => e.exitCode === 2);
});

test('parseForwardSpec: rejects an empty half', () => {
  assert.throws(() => parseForwardSpec('8080:', {}), (e) => e.exitCode === 2);
  assert.throws(() => parseForwardSpec(':7900', {}), (e) => e.exitCode === 2);
});

test('parseForwardSpec: rejects a non-numeric / out-of-range port', () => {
  assert.throws(() => parseForwardSpec('8080:notaport', {}), (e) => e.exitCode === 2);
  assert.throws(() => parseForwardSpec('0:7900', {}), (e) => e.exitCode === 2);
  assert.throws(() => parseForwardSpec('8080:70000', {}), (e) => e.exitCode === 2);
});

// ── the verb end-to-end (seamed) ─────────────────────────────────────────────

test('port-forward: prints the kubectl-style local address banner once up', async () => {
  const transport = fakeTransport();
  const p = runPF('8080:7900', { transport });
  await new Promise((r) => setTimeout(r, 10));
  transport.die();
  const out = await p;
  assert.match(out.stdout, /forwarding 127\.0\.0\.1:8080 -> user@box:7900 — Ctrl-C to stop/);
});

test('port-forward: opens the transport with remotePort=REMOTE and localPort=LOCAL', async () => {
  const transport = fakeTransport();
  const p = runPF('12345:7900', { transport });
  await new Promise((r) => setTimeout(r, 10));
  transport.die();
  await p;
  assert.strictEqual(transport.rec.openedWith.ctx.remotePort, 7900);
  assert.strictEqual(transport.rec.openedWith.ctx.ssh, 'user@box');
  assert.strictEqual(transport.rec.openedWith.opts.localPort, 12345);
  assert.strictEqual(transport.rec.closed, true);
});

test('port-forward: signal releases the hold with exit 0', async () => {
  const transport = fakeTransport();
  const res = await runPF('8080:7900', { transport, onSignalCapture: (fire) => setTimeout(fire, 10) });
  assert.strictEqual(res.code, 0);
  assert.strictEqual(transport.rec.closed, true);
});

test('port-forward: tunnel death exits CONNECT with the child stderr', async () => {
  const transport = fakeTransport({ stderr: 'ssh: connection refused' });
  const p = runPF('8080:7900', { transport });
  await new Promise((r) => setTimeout(r, 10));
  transport.die();
  const res = await p;
  assert.strictEqual(res.code, 3); // EXIT.CONNECT
  assert.match(res.stderr, /tunnel closed/);
  assert.match(res.stderr, /connection refused/);
});

test('port-forward: web sugar forwards wire+1', async () => {
  const transport = fakeTransport();
  const p = runPF('8080:web', { transport, ctxFlags: ['--ssh', 'user@box', '--remote-port', '7900'] });
  await new Promise((r) => setTimeout(r, 10));
  transport.die();
  const res = await p;
  assert.strictEqual(transport.rec.openedWith.ctx.remotePort, 7901);
  assert.match(res.stdout, /-> user@box:web\(7901\)/);
});

test('port-forward: a url (direct) context is rejected — nothing to forward', async () => {
  let stderr = '';
  const code = await run(['port-forward', '8080:7900', '--url', 'http://h:7900'], {
    stdout: () => {}, stderr: (s) => (stderr += s), env: {}, contextsFile: NOFILE,
    openTransport: async () => { throw new Error('should not open a transport for a url ctx'); },
  });
  assert.strictEqual(code, 2); // EXIT.USAGE
  assert.match(stderr, /nothing to forward|url context/);
});
