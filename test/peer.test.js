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
const restarts = [];
const created = [];
const killed = [];
const restartedSessions = [];
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
    restartApp: () => { restarts.push(Date.now()); },
    // Fake owner-side create/kill, mirroring main.js's distinguishable-error
    // contract: bad name/type, name taken, spawn ack {ok,name,type,pid}.
    createSession: ({ name, type, cwd }) => {
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(String(name || ''))) return { ok: false, error: `invalid name "${name}"` };
      if (type !== 'claude' && type !== 'codex' && type !== 'bash') return { ok: false, error: `invalid type "${type}"` };
      if (created.some((c) => c.name === name) || name === 'alpha') return { ok: false, error: `name taken "${name}"` };
      created.push({ name, type, cwd });
      return { ok: true, name, type, pid: 4242 };
    },
    killSession: (name) => {
      if (name !== 'alpha' && !created.some((c) => c.name === name)) return { ok: false, error: `no such session "${name}"` };
      killed.push(name);
      return { ok: true, name };
    },
    // Fake owner-side restart, mirroring main.js's restartSession(): not-found
    // in persistence is a distinguishable error; the {fresh} flag reaches here.
    restartSession: (name, opts) => {
      if (name !== 'alpha' && !created.some((c) => c.name === name)) {
        return { ok: false, error: 'Session not found in persistence' };
      }
      restartedSessions.push({ name, fresh: !!(opts && opts.fresh) });
      return { ok: true, restarted: true };
    },
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
  assert.ok(st.caps.includes('create'));
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

test('owner resize propagates to attached viewers (debounced + deduped)', async () => {
  // Regression: owner geometry shipped only in the attach replay, so an owner
  // refit (its own fit() -> pty resize) left read-only viewers in a stale
  // letterbox and new output rendered staircase-garbled. notifyResize now
  // mirrors the live geometry down the attach stream. alpha is still attached
  // from the attach test above.
  const notResize = (dims) => events.some(
    (x) => x.channel === 'peer-resize' && x.args[1] === 'alpha'
      && x.args[2].cols === dims[0] && x.args[2].rows === dims[1]);

  server.notifyResize('alpha', 132, 43);
  const ev = await waitFor(
    () => events.find((x) => x.channel === 'peer-resize' && x.args[1] === 'alpha'
      && x.args[2].cols === 132 && x.args[2].rows === 43),
    'peer-resize 132x43');
  assert.equal(ev.args[0], 'p1');

  // A drag-burst coalesces to the final geometry (trailing debounce): fire
  // several synchronously, only the last should surface.
  server.notifyResize('alpha', 100, 30);
  server.notifyResize('alpha', 110, 33);
  server.notifyResize('alpha', 120, 36);
  await waitFor(() => notResize([120, 36]), 'coalesced to final 120x36');
  assert.ok(!notResize([100, 30]) && !notResize([110, 33]),
    'intermediate drag frames were coalesced away, never emitted');

  // Dedup: repeating the current dims emits nothing new.
  const settled = events.filter((x) => x.channel === 'peer-resize').length;
  server.notifyResize('alpha', 120, 36);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(events.filter((x) => x.channel === 'peer-resize').length, settled,
    'identical resize was deduped');
});

test('owner UI event mirrors to attached viewers (generic {kind, args})', async () => {
  // Owner surfaced a session-scoped component (a remote agent's [agent:file
  // view]) — attached viewers get a small {kind, args} trigger on the attach
  // stream and render their own copy (content pulled via the query RPC, not
  // shipped here). alpha is still attached from the attach test above.
  server.pushUiEvent('alpha', 'fileView', { path: '/tmp/x/a.js' });
  const ev = await waitFor(
    () => events.find((x) => x.channel === 'peer-ui' && x.args[1] === 'alpha'),
    'peer-ui fileView');
  assert.equal(ev.args[0], 'p1');
  assert.equal(ev.args[2].kind, 'fileView');
  assert.equal(ev.args[2].args.path, '/tmp/x/a.js');

  // Forward-compat: an unknown kind from a newer owner still reaches the client
  // verbatim (the renderer's dispatch is what ignores kinds it doesn't know).
  server.pushUiEvent('alpha', 'futureThing', { x: 1 });
  const future = await waitFor(
    () => events.find((x) => x.channel === 'peer-ui' && x.args[2].kind === 'futureThing'),
    'peer-ui unknown kind forwarded');
  assert.equal(future.args[2].args.x, 1);

  // Malformed: an empty/non-string kind is dropped owner-side and never emits.
  const before = events.filter((x) => x.channel === 'peer-ui').length;
  server.pushUiEvent('alpha', '', { path: 'nope' });
  server.pushUiEvent('alpha', null, { path: 'nope' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(events.filter((x) => x.channel === 'peer-ui').length, before,
    'empty/non-string kinds emitted nothing');
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

test('restart: peer restart acks and triggers the owner relaunch', async () => {
  const before = restarts.length;
  const res = await new Promise((r) => conn.restart(r));
  assert.ok(res.ok, 'restart acked ok');
  // Owner acks BEFORE quitting, so the relaunch callback fires; wait for it.
  await waitFor(() => restarts.length > before, 'owner restart callback fired');
});

test('restart: 501 when the owner exposes no restart callback', async () => {
  // A RemoteServer built without restartApp must refuse cleanly (not 500/hang):
  // the endpoint is capability-gated on the callback's presence, same as the
  // other optional endpoints.
  const bare = new RemoteServer({
    port: 0, pagePath: '/nonexistent',
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }),
    send: () => ({ ok: true }), hostLabel: 'bare', version: '0.0.0-test',
  });
  await bare.start();
  try {
    const out = await new Promise((resolve, reject) => {
      const body = '{}';
      const req = http.request({
        hostname: '127.0.0.1', port: bare.port, path: '/api/restart', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
      });
      req.on('error', reject);
      req.write(body); req.end();
    });
    assert.equal(out.status, 501);
    assert.equal(out.body.ok, false);
  } finally {
    bare.stop();
  }
});

test('create: valid spec spawns and the ack carries name/type/pid', async () => {
  const res = await new Promise((r) => conn.createSession({ name: 'worker', type: 'claude', cwd: '/tmp/w' }, r));
  assert.ok(res.ok, 'create acked ok');
  assert.equal(res.name, 'worker');
  assert.equal(res.type, 'claude');
  assert.equal(res.pid, 4242);
  assert.ok(created.some((c) => c.name === 'worker' && c.cwd === '/tmp/w'), 'owner create() called');
});

test('create: distinguishable errors (collision, bad name, bad type)', async () => {
  const taken = await new Promise((r) => conn.createSession({ name: 'alpha', type: 'claude', cwd: '/tmp/x' }, r));
  assert.equal(taken.ok, false);
  assert.match(taken.error, /name taken/);

  const badName = await new Promise((r) => conn.createSession({ name: 'bad name!', type: 'claude', cwd: '/tmp/x' }, r));
  assert.equal(badName.ok, false);
  assert.match(badName.error, /invalid name/);

  const badType = await new Promise((r) => conn.createSession({ name: 'ok2', type: 'python', cwd: '/tmp/x' }, r));
  assert.equal(badType.ok, false);
  assert.match(badType.error, /invalid type/);
});

test('kill: existing session acks ok; missing session is a distinguishable error', async () => {
  const ok = await new Promise((r) => conn.killSession('alpha', r));
  assert.ok(ok.ok, 'kill acked ok');
  assert.equal(ok.name, 'alpha');
  assert.ok(killed.includes('alpha'), 'owner kill() called');

  const gone = await new Promise((r) => conn.killSession('nope', r));
  assert.equal(gone.ok, false);
  assert.match(gone.error, /no such session/);
});

test('restart-session: plain and fresh flags reach the owner callback', async () => {
  const plain = await new Promise((r) => conn.restartSession('alpha', { fresh: false }, r));
  assert.ok(plain.ok, 'plain restart acked ok');
  assert.ok(plain.restarted, 'restarted flag echoed');
  assert.deepStrictEqual(restartedSessions.at(-1), { name: 'alpha', fresh: false });

  const fresh = await new Promise((r) => conn.restartSession('alpha', { fresh: true }, r));
  assert.ok(fresh.ok, 'fresh reload acked ok');
  assert.deepStrictEqual(restartedSessions.at(-1), { name: 'alpha', fresh: true });
});

test('restart-session: missing session is a distinguishable error', async () => {
  const gone = await new Promise((r) => conn.restartSession('nope', { fresh: false }, r));
  assert.equal(gone.ok, false);
  assert.match(gone.error, /not found in persistence/i);
});

// ---- bash-type remote sessions (peer-visible, IPC-private on the owner) ----

test('create: bash type is accepted and the ack carries type:bash', async () => {
  const res = await new Promise((r) => conn.createSession({ name: 'shell', type: 'bash', cwd: '/tmp/s' }, r));
  assert.ok(res.ok, 'bash create acked ok');
  assert.equal(res.type, 'bash');
  assert.ok(created.some((c) => c.name === 'shell' && c.cwd === '/tmp/s'), 'owner create() called for bash');
});

test('kill: a bash session kills like any other (no agentType gate)', async () => {
  const res = await new Promise((r) => conn.killSession('shell', r));
  assert.ok(res.ok, 'bash kill acked ok');
  assert.ok(killed.includes('shell'), 'owner kill() called for bash');
});

test('sessions: a bash (non-agent) session is exposed over the wire with its type', async () => {
  // The owner's getSessions filter is lifted to include bash; the wire carries
  // sess.type so the viewer buckets it like a local bash row. remote.js passes
  // the type through unchanged — assert that here (the filter itself lives in
  // main.js, not requireable under plain node).
  const bashy = new RemoteServer({
    port: 0, pagePath: '/nonexistent',
    getSessions: () => [{ name: 'sh1', type: 'bash', cwd: '/tmp', workspace: 'w', stats: {} }],
    getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    hostLabel: 'bh', version: '0.0.0-test',
  });
  await bashy.start();
  try {
    const out = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: bashy.port, path: '/api/sessions' }, (res) => {
        let buf = ''; res.on('data', (c) => (buf += c));
        res.on('end', () => resolve(JSON.parse(buf)));
      }).on('error', reject);
    });
    assert.ok(out.ok);
    const s = out.sessions.find((x) => x.name === 'sh1');
    assert.ok(s, 'bash session listed over the wire');
    assert.equal(s.type, 'bash', 'type carried on the wire');
  } finally {
    bashy.stop();
  }
});

test('create/kill/restart: 501 when the owner exposes no lifecycle callbacks', async () => {
  const bare = new RemoteServer({
    port: 0, pagePath: '/nonexistent',
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }),
    send: () => ({ ok: true }), hostLabel: 'bare', version: '0.0.0-test',
  });
  await bare.start();
  const hit = (path, body) => new Promise((resolve, reject) => {
    const b = JSON.stringify(body || {});
    const req = http.request({
      hostname: '127.0.0.1', port: bare.port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
    });
    req.on('error', reject);
    req.write(b); req.end();
  });
  try {
    const c = await hit('/api/sessions', { name: 'x', type: 'claude', cwd: '/tmp/x' });
    assert.equal(c.status, 501);
    assert.equal(c.body.ok, false);
    const k = await hit('/api/kill/x', {});
    assert.equal(k.status, 501);
    assert.equal(k.body.ok, false);
    const rs = await hit('/api/restart-session/x', {});
    assert.equal(rs.status, 501);
    assert.equal(rs.body.ok, false);
    // And the bare server must not advertise the capability.
    const hello = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: bare.port, path: '/api/peer/hello' }, (res) => {
        let buf = ''; res.on('data', (c) => (buf += c));
        res.on('end', () => resolve(JSON.parse(buf)));
      }).on('error', reject);
    });
    assert.ok(!hello.caps.includes('create'), 'no create cap without the callback');
  } finally {
    bare.stop();
  }
});

test('attach fan-out does not starve control/input (separate socket pools)', async () => {
  // Regression: peer-client once shared ONE http.Agent (maxSockets:4) between
  // the never-ending attach SSE streams and the short request traffic. Attach
  // more sessions than the pool and every socket is pinned by a stream, so a
  // control acquire + each keystroke's input POST queue INSIDE the agent —
  // exactly the live two-laptop failure (control looked stuck, a stale acquire
  // landed minutes late when a reconnect briefly freed a socket). With streams
  // moved to their own uncapped, un-pooled agent this round-trips promptly; on
  // the pre-fix code the replays/acquire never get a socket and this times out.
  const N = 6; // > the old maxSockets of 4
  const names = Array.from({ length: N }, (_, i) => `sess${i}`);
  const localInputs = [];
  const srv = new RemoteServer({
    port: 0,
    pagePath: '/nonexistent',
    getSessions: () => names.map((name) => ({ name, type: 'claude', cwd: '/tmp', workspace: 'w', stats: {} })),
    getTranscript: () => ({ ok: true, messages: [] }),
    send: () => ({ ok: true }),
    hostLabel: 'starve', version: '0.0.0-test',
    getAttachInfo: (name) => (names.includes(name)
      ? { ok: true, scrollback: Buffer.from(name), cols: 80, rows: 24, telemetry: {} }
      : { ok: false }),
    sendInput: (name, data) => { localInputs.push([name, data]); return { ok: true }; },
    resizePty: () => ({ ok: true }),
    onControlChange: () => {},
  });
  await srv.start();
  const evs = [];
  const c = new PeerConnection({
    id: 'starve', label: 'lab', url: `http://127.0.0.1:${srv.port}`,
    emit: (channel, ...args) => evs.push({ channel, args }),
  });
  c.start();
  try {
    await waitFor(() => evs.some((x) => x.channel === 'peer-state' && x.args[1] && x.args[1].online), 'online');
    // Attach every session; waiting for all N replays proves N concurrent SSE
    // streams are established (each holding a live socket).
    for (const name of names) c.attach(name);
    await waitFor(
      () => names.every((name) => evs.some((x) => x.channel === 'peer-replay' && x.args[1] === name)),
      'all attach replays', 4000);
    // Streams now hold sockets; control + input must still get through fast.
    await new Promise((resolve, reject) =>
      c.control(names[0], true, (r) => (r && r.ok ? resolve() : reject(new Error((r && r.error) || 'acquire failed')))));
    await new Promise((resolve) => c.input(names[0], 'ping\r', resolve));
    assert.deepEqual(localInputs[localInputs.length - 1], [names[0], 'ping\r']);
  } finally {
    c.stop();
    srv.stop();
  }
});

test('exit: attachers hear it and the stream tears down', async () => {
  server.notifyExit('alpha', 0);
  const ev = await waitFor(() => events.find((x) => x.channel === 'peer-exit'), 'peer-exit');
  assert.equal(ev.args[1], 'alpha');
  assert.equal(ev.args[2], 0);
  // exit auto-released control on the owner side
  assert.deepEqual(controlChanges[controlChanges.length - 1], ['alpha', null]);
});
