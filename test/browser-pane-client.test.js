'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createPluginHostEngine } = require('../plugin-host-engine');
const { HOST_API_VERSION } = require('../plugin-api');
const { createClient, CRASHED } = require('../plugins/browser-pane/client');
const { mkTmpRoot } = require('./lib/tmp-roots');

const PLUGIN_DIR = path.join(__dirname, '..', 'plugins', 'browser-pane');
const FAKE = path.join(__dirname, 'fixtures', 'browser-pane', 'fake-child');

function fakeClock() {
  let t = 1000000;
  let seq = 0;
  const timers = [];
  return {
    now: () => t,
    setTimeout(fn, ms) { const h = { at: t + ms, fn, id: seq++ }; timers.push(h); return h; },
    clearTimeout(h) { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => (a.at - b.at) || (a.id - b.id));
        const h = timers[0];
        if (!h || h.at > end) break;
        timers.shift();
        t = h.at;
        h.fn();
      }
      t = end;
    },
  };
}

function boot(t, { mode = 'normal', timeouts = {} } = {}) {
  const dir = mkTmpRoot('clodex-bp-client-');
  const state = { mode };
  const engine = createPluginHostEngine({
    manager: { sessions: new Map(), list: () => [], listForWorkspace: () => [], _broadcast() {}, _sendToSession() {}, windowForWorkspace: () => null },
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    log: { info: () => {}, error: () => {} },
    userDataPath: dir,
    fs, path,
    gitWorktree: {},
    electronChild: (script, extraArgs) => ({ command: process.execPath, args: [FAKE, ...extraArgs, `--mode=${state.mode}`], env: process.env }),
  });
  const host = engine.register('browser-pane', { activate() {} }, { hostApi: HOST_API_VERSION }, { dir: PLUGIN_DIR });
  const clock = fakeClock();
  const logs = [];
  let logWaiter = null;
  const waitLog = (text) => (logs.includes(text) ? Promise.resolve() : new Promise((resolve) => { logWaiter = { text, resolve }; }));
  const exits = [];
  let exitWaiter = null;
  const client = createClient({
    spawnSpec: () => host.runtime.electronChild(path.join(PLUGIN_DIR, 'child.js'), ['--cxb-data=' + path.join(dir, 'chromium'), '--cxb-proto=1']),
    clock,
    timeouts: { heartbeatMs: 1e12, ...timeouts },
    log: { info: (m) => { logs.push(m); if (logWaiter && m === logWaiter.text) logWaiter.resolve(); }, error: (m) => logs.push(m) },
    onExit: (e) => { exits.push(e); if (exitWaiter) { const w = exitWaiter; exitWaiter = null; w(e); } },
  });
  const nextExit = () => new Promise((r) => { exitWaiter = r; });
  t.after(() => {
    client.dispose();
    clock.advance(10000);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { client, clock, logs, exits, nextExit, state, waitLog };
}

test('client: handshake, then a request round-trips', async (t) => {
  const { client } = boot(t);
  const r = await client.request('echo', { v: 'hi' });
  assert.strictEqual(r.echo, 'hi');
  assert.strictEqual(client.state(), 'running');
  assert.strictEqual(r.pid, client.pid());
});

test('client: concurrent first requests share one start', async (t) => {
  const { client } = boot(t);
  const [a, b] = await Promise.all([client.request('echo', { v: 1 }), client.request('echo', { v: 2 })]);
  assert.strictEqual(a.pid, b.pid);
});

test('client: out-of-order replies resolve the right requests', async (t) => {
  const { client } = boot(t, { mode: 'out-of-order' });
  const p1 = client.request('echo', { v: 'first', hold: true });
  const p2 = client.request('echo', { v: 'second' });
  assert.deepStrictEqual([(await p1).echo, (await p2).echo], ['first', 'second']);
});

test('client: stdout lines that are not cxb frames are ignored and logged', async (t) => {
  const { client, logs } = boot(t, { mode: 'noisy' });
  assert.strictEqual((await client.request('echo', { v: 3 })).echo, 3);
  assert.ok(logs.includes('child stdout (ignored): hello from a library'));
  assert.ok(logs.includes('child stdout (ignored): {"not":"a frame"}'));
});

test('client: no ready within 20 s fails the start with the stderr tail', async (t) => {
  const { client, clock, nextExit } = boot(t, { mode: 'no-ready' });
  const p = client.request('echo', { v: 1 });
  const exited = nextExit();
  clock.advance(19999);
  assert.strictEqual(client.state(), 'starting');
  clock.advance(1);
  await assert.rejects(p, { message: /^browser child did not start: / });
  await exited;
});

test('client: a crash mid-op rejects in-flight ops, and the next request restarts the child', async (t) => {
  const { client, state } = boot(t, { mode: 'crash-on-op' });
  await assert.rejects(client.request('read', {}),
    { message: 'browser child exited (code 3) during read; its effect is unknown — read again' });
  state.mode = 'normal';
  const r = await client.request('echo', { v: 'back' });
  assert.strictEqual(r.echo, 'back');
});

test('client: three exits in 5 min refuse for 10 min; exits spread wider do not', async (t) => {
  const { client, clock, state } = boot(t, { mode: 'crash-on-op' });
  for (let i = 0; i < 3; i++) await assert.rejects(client.request('read', {}), { message: /during read/ });
  await assert.rejects(client.request('read', {}), { message: CRASHED });
  assert.strictEqual(client.state(), 'unavailable');
  clock.advance(10 * 60 * 1000 - 1);
  await assert.rejects(client.request('read', {}), { message: CRASHED });
  clock.advance(1);
  state.mode = 'normal';
  assert.strictEqual((await client.request('echo', { v: 'ok' })).echo, 'ok');
});

test('client: crashes more than 5 min apart never trip the guard', async (t) => {
  const { client, clock } = boot(t, { mode: 'crash-on-op' });
  for (let i = 0; i < 4; i++) {
    await assert.rejects(client.request('read', {}), { message: /during read/ });
    clock.advance(5 * 60 * 1000);
  }
  assert.notStrictEqual(client.state(), 'unavailable');
});

test('client: 15 min without commands sends shutdown, and that exit is not a crash', async (t) => {
  const { client, clock, logs, nextExit } = boot(t);
  await client.request('echo', { v: 1 });
  const exited = nextExit();
  clock.advance(15 * 60 * 1000 - 1);
  assert.strictEqual(client.state(), 'running');
  clock.advance(1);
  const e = await exited;
  assert.deepStrictEqual({ code: e.code, expected: e.expected }, { code: 0, expected: true });
  assert.ok(logs.includes('child: got shutdown'));
  assert.strictEqual(client.state(), 'off');
});

test('client: a request during the idle shutdown waits for the exit and respawns', async (t) => {
  const { client, clock } = boot(t);
  const first = (await client.request('echo', { v: 1 })).pid;
  clock.advance(15 * 60 * 1000);
  assert.strictEqual(client.state(), 'stopping');
  const r = await client.request('echo', { v: 2 });
  assert.strictEqual(r.echo, 2);
  assert.notStrictEqual(r.pid, first);
});

test('client: a missed heartbeat kills the child and counts as a crash', async (t) => {
  const { client, clock, exits, nextExit } = boot(t, { mode: 'ignore-ping', timeouts: { heartbeatMs: 30000 } });
  await client.request('echo', { v: 1 });
  const exited = nextExit();
  clock.advance(30000);
  await new Promise((r) => setImmediate(r));
  clock.advance(9999);
  assert.strictEqual(client.state(), 'running');
  clock.advance(1);
  await exited;
  assert.strictEqual(exits[0].signal, 'SIGKILL');
  assert.strictEqual(exits[0].expected, false);
});

test('client: dispose sends shutdown, then SIGTERM after 3 s', { timeout: 5000 }, async (t) => {
  const { client, clock, nextExit, waitLog } = boot(t, { mode: 'ignore-shutdown' });
  await client.request('echo', { v: 1 });
  const exited = nextExit();
  client.dispose();
  await waitLog('child: got shutdown');
  clock.advance(2999);
  assert.strictEqual(client.state(), 'running');
  clock.advance(1);
  const e = await exited;
  assert.strictEqual(e.signal, 'SIGTERM');
  assert.strictEqual(e.expected, true);
  await assert.rejects(client.request('echo', {}), { message: 'browser pane is disabled' });
});

test('fixtures: no .js, .cjs or .mjs file under test/fixtures (node --test would load it as a test)', () => {
  const found = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(c|m)?js$/.test(e.name)) found.push(p); } };
  walk(path.join(__dirname, 'fixtures'));
  assert.deepStrictEqual(found, []);
});
