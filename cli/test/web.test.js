'use strict';
// web.test.js — the `web` headline verb WITHOUT real ssh/aws/browser. Local-port
// pick policy, the URL announcement, the best-effort browser pop and its gates
// (--no-open, non-TTY, platform), and the delegation onto portForward's tunnel
// machinery — all through injected seams so nothing touches the network or spawns
// a real browser.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/main');
const { pickLocalPort, openBrowser } = require('../src/web');

const NOFILE = path.join(os.tmpdir(), 'nonexistent-clodexctl-web', 'contexts.json');

// A fake transport whose waitExit is controllable (mirrors port-forward.test.js).
function fakeTransport() {
  let resolveExit;
  const rec = { closed: false, openedWith: null };
  const t = {
    localPort: null,
    close() { rec.closed = true; },
    stderr: () => '',
    waitExit: () => new Promise((r) => { resolveExit = r; }),
  };
  return { t, rec, die: () => resolveExit && resolveExit() };
}

// Drive main.run for `web ...` with an ssh ctx from flags + injected seams.
async function runWeb(args, { ctxFlags = ['--ssh', 'user@box'], transport, io = {} } = {}) {
  let stdout = '', stderr = '';
  let signalCb = null;
  const { t, rec } = transport || fakeTransport();
  const browserSpawns = [];
  const code = await run(['web', ...args, ...ctxFlags], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: {},
    contextsFile: NOFILE,
    openTransport: async (ctx, opts) => { rec.openedWith = { ctx, opts }; t.localPort = opts.localPort; return t; },
    onSignal: (cb) => { signalCb = cb; return () => {}; },
    // web-verb seams: force TTY on, canned free-port probe, capture browser spawns.
    isTTY: io.isTTY != null ? io.isTTY : true,
    platform: io.platform || 'darwin',
    probeListen: io.probeListen,
    spawnFn: (cmd, a) => { browserSpawns.push({ cmd, args: a }); return { unref() {}, on() {} }; },
    ...io,
  });
  return { code, stdout, stderr, rec, browserSpawns, fireSignal: () => signalCb && signalCb() };
}

// ── pickLocalPort (pure, seamed) ─────────────────────────────────────────────

test('pickLocalPort: returns 8080 when it is free', async () => {
  const p = await pickLocalPort({ probeListen: async (port) => port === 8080 });
  assert.strictEqual(p, 8080);
});

test('pickLocalPort: walks to the first free port in 8080..8090', async () => {
  const p = await pickLocalPort({ probeListen: async (port) => port === 8083 });
  assert.strictEqual(p, 8083);
});

test('pickLocalPort: whole range busy → falls back to 8080 (openTransport surfaces the real conflict)', async () => {
  const p = await pickLocalPort({ probeListen: async () => false });
  assert.strictEqual(p, 8080);
});

// ── openBrowser (pure, seamed) ───────────────────────────────────────────────

test('openBrowser: darwin uses `open`', () => {
  const spawns = [];
  openBrowser('http://127.0.0.1:8080', { platform: 'darwin', spawnFn: (cmd, a) => { spawns.push({ cmd, a }); return { unref() {}, on() {} }; } });
  assert.deepStrictEqual(spawns, [{ cmd: 'open', a: ['http://127.0.0.1:8080'] }]);
});

test('openBrowser: linux uses `xdg-open`', () => {
  const spawns = [];
  openBrowser('http://127.0.0.1:8080', { platform: 'linux', spawnFn: (cmd, a) => { spawns.push({ cmd, a }); return { unref() {}, on() {} }; } });
  assert.deepStrictEqual(spawns, [{ cmd: 'xdg-open', a: ['http://127.0.0.1:8080'] }]);
});

test('openBrowser: unknown platform is a no-op', () => {
  const spawns = [];
  openBrowser('http://127.0.0.1:8080', { platform: 'win32', spawnFn: (cmd, a) => { spawns.push({ cmd, a }); return {}; } });
  assert.strictEqual(spawns.length, 0);
});

test('openBrowser: a throwing spawn is swallowed (best-effort)', () => {
  assert.doesNotThrow(() => openBrowser('http://127.0.0.1:8080', { platform: 'darwin', spawnFn: () => { throw new Error('nope'); } }));
});

// ── the verb end-to-end (seamed) ─────────────────────────────────────────────

test('web: prints the browser URL prominently and holds until signal', async () => {
  const transport = fakeTransport();
  const p = runWeb([], { transport, io: { probeListen: async (port) => port === 8080 } });
  await new Promise((r) => setTimeout(r, 10));
  transport.die();
  const out = await p;
  assert.match(out.stdout, /Clodex web GUI:\s+http:\/\/127\.0\.0\.1:8080/);
});

test('web: opens the tunnel to the wire+1 fallback (ctx without webPort) with the picked LOCAL', async () => {
  const transport = fakeTransport();
  const p = runWeb([], { ctxFlags: ['--ssh', 'user@box', '--remote-port', '7900'], transport, io: { probeListen: async (port) => port === 8080 } });
  await new Promise((r) => setTimeout(r, 10));
  transport.die();
  await p;
  // web sugar → remote = wire+1 = 7901; local = picked 8080
  assert.strictEqual(transport.rec.openedWith.ctx.remotePort, 7901);
  assert.strictEqual(transport.rec.openedWith.opts.localPort, 8080);
});

test('web: --port pins the LOCAL end', async () => {
  const transport = fakeTransport();
  const p = runWeb(['--port', '9090'], { transport });
  await new Promise((r) => setTimeout(r, 10));
  transport.die();
  const out = await p;
  assert.strictEqual(transport.rec.openedWith.opts.localPort, 9090);
  assert.match(out.stdout, /http:\/\/127\.0\.0\.1:9090/);
});

test('web: pops the browser by default on a TTY', async () => {
  const transport = fakeTransport();
  const p = runWeb([], { transport, io: { isTTY: true, platform: 'darwin', probeListen: async (port) => port === 8080 } });
  await new Promise((r) => setTimeout(r, 10));
  transport.die();
  const out = await p;
  assert.deepStrictEqual(out.browserSpawns, [{ cmd: 'open', args: ['http://127.0.0.1:8080'] }]);
});

test('web: --no-open suppresses the browser pop but still prints the URL', async () => {
  const transport = fakeTransport();
  const p = runWeb(['--no-open'], { transport, io: { isTTY: true, probeListen: async (port) => port === 8080 } });
  await new Promise((r) => setTimeout(r, 10));
  transport.die();
  const out = await p;
  assert.strictEqual(out.browserSpawns.length, 0);
  assert.match(out.stdout, /http:\/\/127\.0\.0\.1:8080/);
});

test('web: a non-TTY stdout suppresses the browser pop (scripts) but prints the URL', async () => {
  const transport = fakeTransport();
  const p = runWeb([], { transport, io: { isTTY: false, probeListen: async (port) => port === 8080 } });
  await new Promise((r) => setTimeout(r, 10));
  transport.die();
  const out = await p;
  assert.strictEqual(out.browserSpawns.length, 0);
  assert.match(out.stdout, /http:\/\/127\.0\.0\.1:8080/);
});

test('web: a url (direct) context has no tunnel → usage error', async () => {
  let stderr = '';
  const code = await run(['web', '--url', 'http://x'], {
    stdout: () => {}, stderr: (s) => (stderr += s), env: {}, contextsFile: NOFILE,
  });
  assert.strictEqual(code, 2);
  assert.match(stderr, /needs a tunnel context/);
});

test('web: --port out of range is a usage error', async () => {
  let stderr = '';
  const code = await run(['web', '--port', '70000', '--ssh', 'user@box'], {
    stdout: () => {}, stderr: (s) => (stderr += s), env: {}, contextsFile: NOFILE,
  });
  assert.strictEqual(code, 2);
  assert.match(stderr, /--port must be an integer/);
});
