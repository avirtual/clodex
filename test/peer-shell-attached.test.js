'use strict';

// What the SERVING operator can see while a peer is in one of their shells
// (t219 rework: the attachment indicator + the reconnect-quiet ops row).
//
// The grant chip in the peer header answers "could a peer open a shell here" —
// a setting, true whether or not anyone is looking. This file is about the
// other question, the one that actually matters: is a peer in a shell on this
// box RIGHT NOW. Opening the stream SPAWNS the PTY, so the answer can be yes
// with no tab open here at all, and an operator must never be in that state
// unannounced.
//
// Two halves, both driven through real code rather than a stand-in:
//   A. remote.js reports the WATCHED SEATS out of its own `_wterm` Map, over
//      real HTTP, including on the paths that are not explicit closes.
//   B. remote-wiring's real `wtermOpen` closure decides whether an open is a
//      new exposure (announce) or a reconnect of one already announced (stay
//      quiet) — and the two facts that decision needs come from two different
//      layers, which is why it is tested here and not in either alone.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { RemoteServer } = require('../remote');
const { createRemoteWiring } = require('../remote-wiring');

const PAGE = path.join(__dirname, '..', 'renderer', 'remote.html');

// --- A. the server's report ------------------------------------------------

function serve(extra = {}) {
  const reports = [];
  const server = new RemoteServer({
    port: 0, pagePath: PAGE,
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    wtermOpen: () => ({ ok: true, scrollback: Buffer.alloc(0), cols: 80, rows: 24 }),
    wtermInput: () => ({ ok: true }),
    wtermResize: () => ({ ok: true }),
    wtermClose: () => ({ ok: true }),
    onWtermStreams: (seats) => reports.push(seats),
    ...extra,
  });
  return { server, reports };
}

// An SSE GET held open, resolving once the stream is live on both ends. The
// server-side membership is what the reports describe, so the resolve waits for
// the replay frame rather than for the request object: a request that has not
// been answered yet is not in the Map.
// `frames` accumulates everything after the replay, which is how a test sees
// what the server said on the way OUT. A stream that ends is otherwise
// indistinguishable from a tunnel that dropped — the distinction is the whole
// reason `dropWterm` carries a reason.
function openStream(port, seat) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/api/wterm/${seat}`, method: 'GET',
      headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
      res.setEncoding('utf8');
      const frames = [];
      res.on('data', (c) => { frames.push(c); });
      res.once('data', () => resolve({ req, res, frames }));
    });
    req.on('error', reject);
    req.end();
  });
}

function post(port, pathname, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', reject);
    r.end(payload);
  });
}

function waitFor(label, pred, ms = 5000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v; try { v = pred(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error(`timed out waiting for: ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

// WINDOW: a stream arriving, a second seat joining, and one of them going away
// by having its SOCKET DROPPED — no wterm-close, no exit frame, nothing the
// server chose. That is the path the indicator has to survive, because it is
// the one the operator's tunnel produces.
test('the watched-seat report follows the Map, including on a dropped socket', async () => {
  const { server, reports } = serve();
  await server.start();
  const open = [];
  try {
    open.push(await openStream(server.port, 'alice'));
    await waitFor('the first report', () => reports.length >= 1);
    assert.deepStrictEqual(reports[0], ['alice'], 'the seat is reported as watched');

    open.push(await openStream(server.port, 'bob'));
    await waitFor('the second report', () => reports.length >= 2);
    assert.deepStrictEqual(reports[1].slice().sort(), ['alice', 'bob'],
      'EVERY watched seat, not the one that changed — a consumer applying a delta drifts the first time one is missed');

    // Kill the socket from the client end. Nothing on the server called close;
    // the only notice it gets is `req.on('close')`, and a report built by
    // counting opens and explicit closes would leak this seat forever.
    open[0].req.destroy();
    await waitFor('the drop to be reported', () => reports.length >= 3);
    assert.deepStrictEqual(reports[reports.length - 1], ['bob'],
      'the dropped stream left the set — a mark that outlives its stream is worse than no mark');
  } finally {
    for (const o of open) { try { o.req.destroy(); } catch {} }
    server.stop();
  }
});

// WINDOW: the DETACH, which is the half of the feature that had no caller at
// all until this rework — the chain existed and nothing reached it, so deleting
// every line of it failed nothing. Two seats watched, one closed on purpose:
// the closed one leaves the report and the other stays, because a close is
// per-seat and a `dropAllWterm` in its place would clear both.
test('an explicit close drops that seat from the report and leaves the other', async () => {
  const closed = [];
  const { server, reports } = serve({ wtermClose: (seat) => { closed.push(seat); return { ok: true }; } });
  await server.start();
  const open = [];
  try {
    open.push(await openStream(server.port, 'alice'));
    open.push(await openStream(server.port, 'bob'));
    await waitFor('both seats watched', () => reports.length >= 2);
    assert.deepStrictEqual(reports[reports.length - 1].slice().sort(), ['alice', 'bob'],
      'ENTER: both seats were being watched before the close');

    const res = await post(server.port, '/api/wterm-close/alice', {});
    assert.strictEqual(res.status, 200, 'the close was accepted');

    await waitFor('the close to be reported', () => reports.length >= 3);
    assert.deepStrictEqual(reports[reports.length - 1], ['bob'],
      'the closed seat left the report and the other one did not');
    assert.deepStrictEqual(closed, ['alice'], 'the serving side was told which seat, once');
  } finally {
    for (const o of open) { try { o.req.destroy(); } catch {} }
    server.stop();
  }
});

// WINDOW: the `attached` fact crossing from the server to the handler, over real
// HTTP. Part B below tests what the handler DOES with it, but only the server
// knows it: remote-wiring can see that the shell was already running and cannot
// see whether anyone was still watching. Read BEFORE this stream joins the set,
// or the first open would report itself as already attached and every announce
// would be suppressed — the failure mode is silence, which is exactly what an
// unannounced remote shell looks like.
test('the server tells the handler whether the seat was already being watched', async () => {
  const ctxs = [];
  const { server } = serve({
    wtermOpen: (seat, ctx) => {
      ctxs.push(ctx);
      return { ok: true, scrollback: Buffer.alloc(0), cols: 80, rows: 24 };
    },
  });
  await server.start();
  const open = [];
  try {
    open.push(await openStream(server.port, 'alice'));
    assert.deepStrictEqual(ctxs, [{ attached: false }],
      'the first viewer of a seat is told nobody was there — read before it joined the set');

    open.push(await openStream(server.port, 'alice'));
    assert.deepStrictEqual(ctxs[1], { attached: true }, 'the second is told someone was');

    // A different seat is a different question, and the answer must not carry
    // over: a per-server flag rather than a per-seat lookup would report this
    // one as attached because `alice` is.
    open.push(await openStream(server.port, 'bob'));
    assert.deepStrictEqual(ctxs[2], { attached: false }, 'answered per seat, not per box');
  } finally {
    for (const o of open) { try { o.req.destroy(); } catch {} }
    server.stop();
  }
});

// WINDOW: input with nothing open. The mark and the input routes have to be
// answers to the SAME question, or the mark is decoration: a caller that never
// opens `/api/wterm/:seat` leaves the Map untouched, so no report fires, the
// announce (which lives only in the open path) never runs, and the seat carries
// no mark — while the keystrokes land in a shell the local operator opened in
// their own tab.
test('input and resize are refused for a seat nobody is streaming', async () => {
  const seen = [];
  const { server, reports } = serve({
    wtermInput: (seat, d) => { seen.push(['input', seat, d]); return { ok: true }; },
    wtermResize: (seat, c, r) => { seen.push(['resize', seat, c, r]); return { ok: true }; },
  });
  await server.start();
  let s = null;
  try {
    const inp = await post(server.port, '/api/wterm-input/alice', { data: 'rm -rf .\n' });
    assert.strictEqual(inp.status, 409, 'input into an unwatched seat is refused');
    assert.match(inp.body, /no open terminal stream/, 'and says why');
    const rsz = await post(server.port, '/api/wterm-resize/alice', { cols: 100, rows: 40 });
    assert.strictEqual(rsz.status, 409, 'so is a resize — it moves what is on the operator\'s screen');
    assert.deepStrictEqual(seen, [],
      'neither reached the shell: refused BEFORE the callback, not reported after it');
    assert.deepStrictEqual(reports, [], 'ENTER: nothing was ever streaming, so nothing was ever marked');

    // The positive control. Without it this test passes just as well against a
    // route that refuses everything, which would be a broken feature rather
    // than a closed hole.
    s = await openStream(server.port, 'alice');
    await waitFor('the seat to be marked', () => reports.length >= 1);
    assert.deepStrictEqual(reports[0], ['alice'], 'ENTER: now it is being watched');
    const ok = await post(server.port, '/api/wterm-input/alice', { data: 'echo hi\n' });
    assert.strictEqual(ok.status, 200, 'a watched seat still takes input');
    assert.deepStrictEqual(seen, [['input', 'alice', 'echo hi\n']], 'and it reached the shell');
  } finally {
    if (s) { try { s.req.destroy(); } catch {} }
    server.stop();
  }
});

// The refusal has to survive the same window MF2-round-one closed for the
// callback: `_readBody` calls back from `req.on('end')`, so a caller who
// dribbles the body chooses how long it sits between the check and the write.
// Checked at the moment of use, the last watcher leaving mid-body refuses; a
// check hoisted above `_readBody` would let the keystroke through.
test('a stream that ends while the body is in flight refuses the input', async () => {
  const seen = [];
  const { server } = serve({ wtermInput: (seat, d) => { seen.push([seat, d]); return { ok: true }; } });
  await server.start();
  let s = null;
  try {
    s = await openStream(server.port, 'alice');
    const payload = JSON.stringify({ data: 'x' });
    const res = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: server.port, path: '/api/wterm-input/alice',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (rs) => {
        let out = ''; rs.setEncoding('utf8');
        rs.on('data', (c) => { out += c; });
        rs.on('end', () => resolve({ status: rs.statusCode, body: out }));
      });
      r.on('error', reject);
      r.write(payload.slice(0, 4));
      // A macrotask after the first chunk: the server has taken it and is
      // waiting on 'end'.
      setTimeout(() => { s.req.destroy(); setTimeout(() => r.end(payload.slice(4)), 30); }, 30);
    });
    assert.strictEqual(res.status, 409, 'the watcher left before the body finished arriving');
    assert.deepStrictEqual(seen, [], 'ENTER: nothing reached the shell');
  } finally {
    if (s) { try { s.req.destroy(); } catch {} }
    server.stop();
  }
});

// WINDOW: revocation. The last report has to be the EMPTY one, and this is the
// moment the seam is most easily broken: `onWtermStreams` looks like part of the
// peer-terminal grant, and anyone who folds it into the bundle that
// setWtermCallbacks nulls would leave every seat marked forever at exactly the
// moment the operator is watching for the marks to go out.
test('revoking the grant reports the seats as no longer watched', async () => {
  const { server, reports } = serve();
  await server.start();
  let s = null;
  try {
    s = await openStream(server.port, 'alice');
    await waitFor('the open report', () => reports.length >= 1);
    assert.deepStrictEqual(reports[0], ['alice'], 'ENTER: the seat was marked before the revoke');

    server.setWtermCallbacks(null);
    await waitFor('the revocation report', () => reports.length >= 2);
    assert.deepStrictEqual(reports[reports.length - 1], [],
      'the revocation cleared the marks; a seam nulled with the grant would report nothing here');
  } finally {
    if (s) { try { s.req.destroy(); } catch {} }
    server.stop();
  }
});

// The report is a UI signal on a request path. A renderer fault must not take
// the wire down with it — least of all on the revocation path, where the throw
// would land inside dropAllWterm and could strand the remaining streams.
test('a throwing consumer cannot break the wire', async () => {
  let called = 0;
  const { server } = serve({ onWtermStreams: () => { called += 1; throw new Error('renderer gone'); } });
  await server.start();
  let s = null;
  try {
    s = await openStream(server.port, 'alice');
    await waitFor('the throwing consumer to be called', () => called >= 1);
    assert.doesNotThrow(() => server.setWtermCallbacks(null), 'the revoke completed');
    assert.ok(called >= 2, 'ENTER: it threw on the revocation path too, not only the open');
  } finally {
    if (s) { try { s.req.destroy(); } catch {} }
    server.stop();
  }
});

// --- A2. the seat going away underneath the stream --------------------------
// The mark is a sidebar row attribute and a killed or archived session has no
// row, so a stream that outlives its seat is unmarkable by construction — the
// heartbeat re-asserts it into a list that no longer contains it. notifySessions
// is where the server learns the seat is gone; it pruned `_activity` and
// `_attach` and left `_wterm` alone.

test('a seat that leaves the session list has its terminal stream closed, with a reason', async () => {
  let live = ['alice', 'bob'];
  const closed = [];
  const { server, reports } = serve({
    getSessions: () => live.map((name) => ({ name })),
    wtermClose: (seat) => { closed.push(seat); return { ok: true }; },
  });
  await server.start();
  const open = [];
  try {
    open.push(await openStream(server.port, 'alice'));
    open.push(await openStream(server.port, 'bob'));
    await waitFor('both seats watched', () => reports.length >= 2);
    assert.deepStrictEqual(reports[reports.length - 1].slice().sort(), ['alice', 'bob'],
      'ENTER: both streams were open before the session went away');

    live = ['bob'];
    server.notifySessions();

    await waitFor('the report to drop alice', () => reports.length >= 3);
    assert.deepStrictEqual(reports[reports.length - 1], ['bob'],
      'the mark clears for a seat that no longer exists, and stays for the one that does');
    // The positive control is bob, in the same run: a `dropAllWterm` here would
    // pass every assertion above except this one.
    assert.strictEqual(open[1].res.destroyed, false, 'the surviving seat was not swept up with it');

    await waitFor('alice\'s stream to end', () => open[0].frames.join('').includes('event: closed'));
    assert.match(open[0].frames.join(''), /"reason":"closed"/,
      'the consumer is told it was closed, not left retrying against a dropped tunnel');

    // The SHELL is the operator's own and a restart-through-kill has to keep
    // whatever is running in it. remote.js holds no drawer-PTY handle, so it
    // cannot reap one directly; `wtermClose` is the callback that reaches that
    // side, and the prune must not take it. Only the peer's VIEW ends here.
    assert.deepStrictEqual(closed, [], 'the serving side was not asked to tear anything down');
  } finally {
    for (const o of open) { try { o.req.destroy(); } catch {} }
    server.stop();
  }
});

// Recovery is the sharper half. The drawer shell is NOT reaped by a kill — only
// by a window close and by session:forget — so recreating the same name in the
// same workspace reconnects a surviving stream to the same running shell. With
// no fresh open there is no `wtermOpen` call, so the announce never fires and a
// remote party is back inside a shell silently. Pruning is what forces them to
// re-open.
test('a recreated seat cannot be resumed by the old stream', async () => {
  let live = ['alice'];
  const seen = [];
  const { server } = serve({
    getSessions: () => live.map((name) => ({ name })),
    wtermInput: (seat, d) => { seen.push([seat, d]); return { ok: true }; },
  });
  await server.start();
  let s = null;
  try {
    s = await openStream(server.port, 'alice');
    const ok = await post(server.port, '/api/wterm-input/alice', { data: 'echo hi\n' });
    assert.strictEqual(ok.status, 200, 'ENTER: the stream carried input while the seat existed');

    live = [];
    server.notifySessions();                 // the kill
    live = ['alice'];
    server.notifySessions();                 // recreated under the same name

    const after = await post(server.port, '/api/wterm-input/alice', { data: 'rm -rf .\n' });
    assert.strictEqual(after.status, 409, 'the old stream has no input rights over the new seat');
    assert.deepStrictEqual(seen, [['alice', 'echo hi\n']], 'and nothing more reached the shell');
  } finally {
    if (s) { try { s.req.destroy(); } catch {} }
    server.stop();
  }
});

// --- B. announce vs stay quiet ---------------------------------------------
// remote-wiring's real wtermOpen closure. The decision needs two facts from two
// layers — whether the SHELL was already running (drawer-pty's `fresh`) and
// whether anyone was still WATCHING it (the server's Map) — and neither layer
// can answer for the other, which is the reason this is a seam and not a flag.

// `windowOpen` defaults TRUE so every pre-existing case here keeps testing what
// it says it tests. It is a real map rather than a `() => true`, because a
// stand-in that cannot answer "no" tests the check the same way an absent
// method does: `manager.windowForWorkspace` missing entirely would throw here,
// but a version that always says yes passes whether the check exists or not.
function wiringFixture({ spawnFresh, granted = true, windowOpen = true } = {}) {
  const rows = [];
  const windows = new Map(windowOpen ? [['ws1', { id: 'win1' }]] : []);
  const manager = {
    sessions: new Map([['alice', { workspaceId: 'ws1' }]]),
    windowForWorkspace: (ws) => windows.get(ws) || null,
    _broadcast: (ch, msg) => { if (ch === 'ipc-message') rows.push(msg); },
  };
  const spawns = [];
  const drawerPtys = {
    spawn: (ws, seat) => {
      spawns.push({ ws, seat });
      return { ok: true, fresh: spawnFresh, scrollback: '', cols: 80, rows: 24 };
    },
  };
  let srv = null;
  const deps = {
    path, fs: require('fs'), os,
    log: { info() {}, error() {} },
    DEFAULT_WORKSPACE_ID: 'default',
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    REGISTRY_DIR: '/tmp/reg', OUTBOX_DIR: '/tmp/outbox', SELF_LABEL: 'testbox',
    parseCtxFile: () => null, jsonlToMessages: () => [], ensureDir: () => {}, homeRelativize: (x) => x,
    claimOutbox: () => [], listOutboxOrigins: () => [],
    manager, proxyPoller: { snapshot: () => null },
    restartClodex: () => {}, restartSession: () => {}, peerProxyView: () => null,
    readSessionArgs: () => ({ ok: false }), applySessionArgs: () => ({ ok: true }),
    readSkillCatalog: () => ({ ok: false }), applySessionSkills: () => ({ ok: false }),
    fetchProxyContext: () => {}, fetchProxyReport: () => {}, fetchProxyBust: () => {},
    fetchSessionFiles: () => {}, fetchFilePeek: () => {}, fetchFileDiff: () => {},
    CLAUDE_TOOLS: ['Bash'],
    getPromptLibrary: () => ({ list: () => [] }),
    getAgentLibrary: () => ({ list: () => [] }),
    getSkillLibrary: () => ({ list: () => [] }),
    getPersistence: () => ({ get: () => undefined }),
    getUiSettings: () => ({ get: () => ({
      remoteEnabled: true, remotePort: 0,
      // The grant is a top-level serving setting, and deliberately NOT derived
      // from the peers list: this fixture has no peer records at all, which is
      // the serving-only shape that could not grant it before t239.
      peerShellEnabled: granted, peers: [],
    }) }),
    getWorkspaces: () => ({ get: () => ({}) }),
    getDrawerPtys: () => drawerPtys,
    getRemoteServer: () => srv, setRemoteServer: (v) => { srv = v; }, setRemoteError: () => {},
    readRemoteEnvToken: () => null, resolveRemoteToken: (a, b) => a || b || null,
    appVersion: '9.9.9', isPackaged: () => false,
  };

  // Capture the options the wiring hands the server, which is where the real
  // wtermOpen closure lives. The fake must answer setWtermCallbacks — the sync
  // reconciles it every time — and deliberately is not guarded for in
  // production: a real server without the method is a wiring break.
  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  let opts = null;
  remoteMod.RemoteServer = function (o) {
    opts = o;
    return { start: () => Promise.resolve(), stop() {}, port: 0, notifySessions() {}, setWtermCallbacks() {} };
  };
  try { createRemoteWiring(deps).syncRemoteServer(); } finally { remoteMod.RemoteServer = orig; }
  assert.ok(opts && typeof opts.wtermOpen === 'function', 'ENTER: the granted wiring supplied a wtermOpen');
  return { open: opts.wtermOpen, rows, spawns };
}

const openRows = (rows) => rows.filter((r) => r.kind === 'peer-terminal-open');

test('a first open announces — the shell is new and nobody was watching', () => {
  const { open, rows } = wiringFixture({ spawnFresh: true });
  assert.strictEqual(open('alice', { attached: false }).ok, true);
  assert.strictEqual(openRows(rows).length, 1, 'the operator was told');
  assert.match(openRows(rows)[0].body, /alice/, 'and told which seat');
});

// The half-open tunnel: the consumer's watchdog gives up and redials while the
// server still holds the dead stream, so the same viewer arrives again against
// a shell that is already running and already marked. An ops log that says "a
// peer opened your terminal" every twenty-five seconds is one the operator
// stops reading, which costs exactly the property the row exists for.
test('a reconnect of an already-watched shell stays quiet', () => {
  const { open, rows } = wiringFixture({ spawnFresh: false });
  assert.strictEqual(open('alice', { attached: true }).ok, true);
  assert.deepStrictEqual(openRows(rows), [], 'no row for a viewer that was already there');
});

// The half that a "simplify to ctx.attached" refactor would drop. Nobody was
// watching when this arrived, so whoever this is, they are a remote party
// entering a shell on the operator's box — a new exposure, announced, even
// though the shell itself is old.
test('an open after a genuine detach announces, even though the shell is not fresh', () => {
  const { open, rows } = wiringFixture({ spawnFresh: false });
  assert.strictEqual(open('alice', { attached: false }).ok, true);
  assert.strictEqual(openRows(rows).length, 1,
    'a new viewer of an old shell is still a new viewer');
});

// The other half, and it is reachable: the server can hold a stale stream for a
// seat whose drawer shell has gone away, so the next open spawns a BRAND NEW
// shell while `attached` still reads true. A fresh shell is always a new
// exposure — there is nothing for the previous mark to have been about.
test('a fresh shell announces even if the server still shows a stream attached', () => {
  const { open, rows } = wiringFixture({ spawnFresh: true });
  assert.strictEqual(open('alice', { attached: true }).ok, true);
  assert.strictEqual(openRows(rows).length, 1, 'a new shell is never a reconnect');
});

// A missing ctx must not read as "already attached". The argument comes over a
// callback boundary that an older or a test caller can omit, and the safe
// reading of "I do not know" is to announce.
test('an open with no context announces', () => {
  const { open, rows } = wiringFixture({ spawnFresh: false });
  assert.strictEqual(open('alice').ok, true);
  assert.strictEqual(openRows(rows).length, 1, 'unknown is not quiet');
});

// --- C. the window, not just the session -----------------------------------
// A session OUTLIVES its window: main.js's `closed` handler kills the
// workspace's drawer PTYs and deliberately keeps the session record. So the
// session lookup above answers yes for a workspace with nothing on screen, and
// every way this box has of showing a served terminal — the sidebar mark, the
// ipc-message chip, the tab itself — lives in that window. Serving here spawns
// a login shell no local surface can report.

test('an open for a workspace WITH a window spawns and announces', () => {
  const { open, rows, spawns } = wiringFixture({ spawnFresh: true });
  const res = open('alice', { attached: false });
  assert.strictEqual(res.ok, true, 'ENTER: the open succeeded, so the refusal below is about the window');
  assert.deepStrictEqual(spawns, [{ ws: 'ws1', seat: 'alice' }], 'the shell was spawned for that seat');
  assert.strictEqual(openRows(rows).length, 1, 'and the operator was told');
});

test('an open for a workspace whose window is CLOSED is refused before the spawn', () => {
  const { open, rows, spawns } = wiringFixture({ spawnFresh: true, windowOpen: false });
  const res = open('alice', { attached: false });
  assert.strictEqual(res.ok, false, 'refused');
  // Not a code of its own: a seat whose window is closed is unreachable to the
  // consumer in the same way a missing one is. 501 would say "this box does not
  // do terminals", which is false and sends the remote operator to the wrong
  // setting.
  assert.strictEqual(res.code, 'no-seat', 'and refused as a missing seat, not a config bit');
  // The load-bearing assertion. A refusal that spawns first has already created
  // the unwatchable shell — the peer is merely not given the bytes, and the
  // process lives on the operator's box until the workspace is reopened.
  assert.deepStrictEqual(spawns, [], 'no shell was created');
  assert.deepStrictEqual(openRows(rows), [], 'and nothing was announced, since there is nowhere to announce it');
});
