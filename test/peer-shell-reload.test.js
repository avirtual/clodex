'use strict';

// t224 REPRODUCTION HARNESS — does a renderer reload leak a peer-terminal
// stream and its spawned shell?
//
// The claim under test was that the main-side `PeerConnection` outlives a
// renderer reload, so the fresh renderer's `onShow` opens a SECOND stream for
// the same seat and the serving box ends up with two streams and two shells.
//
// A renderer reload is invisible to the main process by construction, which is
// what makes it testable without Electron: main-side state simply does not
// change. So "reload" here is the ABSENCE of any call — the renderer that
// opened the stream stops existing, its `held` bookkeeping dies with it, and a
// fresh renderer starts with `held = null`. Everything below drives the real
// chain around that gap: a real RemoteServer holding the real `_wterm` Map, and
// a real PeerConnection holding the real `_wterms` Map, over real HTTP.
//
// Both boxes are in-process, which is the point: the defect is a disagreement
// BETWEEN the two maps, and a fake on either side would be the map agreeing
// with itself.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { RemoteServer } = require('../remote');
const { PeerConnection } = require('../peer-client');

const PAGE = path.join(__dirname, '..', 'renderer', 'remote.html');

// The SERVING box. `spawns` counts what the drawer-PTY layer would have been
// asked to create, and `fresh` mimics drawer-pty's real laziness: the first
// spawn for a seat is fresh, every later one attaches to the shell already
// running. Counting spawns rather than trusting `fresh` is deliberate — the
// leak the ticket describes is about a SECOND shell, and a fixture whose spawn
// is idempotent by fiat could not show one either way.
function servingBox() {
  const shells = new Set();
  const spawns = [];
  const reports = [];
  const closes = [];
  const server = new RemoteServer({
    port: 0,
    pagePath: PAGE,
    getSessions: () => [{ name: 'alice' }, { name: 'bob' }],
    getTranscript: () => ({ ok: true, messages: [] }),
    send: () => ({ ok: true }),
    wtermOpen: (seat) => {
      const had = shells.has(seat);
      shells.add(seat);
      spawns.push(seat);
      return { ok: true, fresh: !had, scrollback: Buffer.alloc(0), cols: 80, rows: 24 };
    },
    wtermInput: () => ({ ok: true }),
    wtermResize: () => ({ ok: true }),
    wtermClose: (seat) => { closes.push(seat); return { ok: true }; },
    onWtermStreams: (seats) => { reports.push(seats.slice().sort()); },
  });
  return { server, spawns, reports, closes, shells };
}

// The CONSUMER's main process. A long hello interval so nothing in these
// windows is re-opened by a background tick — every open below is one the test
// asked for, which is what lets a count mean anything.
function consumer(port) {
  return new PeerConnection({
    id: 'p1',
    label: 'box',
    url: `http://127.0.0.1:${port}`,
    emit: () => {},
    helloIntervalMs: 60000,
  });
}

async function waitFor(what, pred, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

// The seats the serving side currently has a live stream for. Read from the
// server's own Map rather than from the report log: a report is a notification
// and the absence of one is ambiguous, while the Map is the state every serving
// surface (the mark, the input gate) is derived from.
const watched = (server) => [...server._wterm.entries()]
  .filter(([, set]) => set.size > 0).map(([seat]) => seat).sort();

// A renderer reload, from the main process's point of view: nothing. Stated as
// a function so the tests below read as the sequence an operator performs, and
// so that a future reload-handling fix has one obvious place to be called from.
function reloadRenderer() { /* the renderer dies and is rebuilt; main is untouched */ }

// --- 1. the claim as filed --------------------------------------------------

test('a reload does NOT open a second stream or a second shell for the same seat', async () => {
  const { server, spawns, reports } = servingBox();
  await server.start();
  const conn = consumer(server.port);
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);

    // Pre-reload: the renderer showed the term tab on seat `alice`.
    await new Promise((r) => conn.wtermOpen('alice', r));
    await waitFor('the stream to reach the serving box', () => watched(server).length === 1);
    assert.deepStrictEqual(watched(server), ['alice'],
      'ENTER: a stream really was open before the reload, so the counts below are about the reload');
    assert.deepStrictEqual(spawns, ['alice'], 'ENTER: and exactly one shell had been asked for');

    reloadRenderer();

    // The fresh renderer shows the same seat and calls the same door. This is
    // the exact call the ticket says opens a second stream.
    await new Promise((r) => conn.wtermOpen('alice', r));
    // A second SSE request would have to travel, so give it a window in which
    // it could have arrived. Asserting immediately would pass against a leak
    // that is merely slower than the assertion.
    await new Promise((r) => setTimeout(r, 250));

    assert.deepStrictEqual(watched(server), ['alice'],
      'still exactly one seat watched — the reload did not open a second stream');
    assert.strictEqual(server._wterm.get('alice').size, 1,
      'and exactly one SSE response is held for it, not two');
    assert.deepStrictEqual(spawns, ['alice'],
      'and the serving side was never asked for a second shell');
    assert.ok(reports.length >= 1, 'ENTER: the stream report fired, so an added stream would have been reported');
  } finally {
    conn.stop();
    server.stop();
  }
});

// WHY it does not, and the answer is TWO independent guards, both main-side, so
// the renderer dying cannot clear either: `wtermOpen`'s `w && w.wanted` early
// return, and `_openWterm`'s `w.req` guard. Verified by mutation, not by
// reading — removing EITHER one alone leaves the test above green, and only
// removing both makes a reload open a second stream. That redundancy is the
// finding worth pinning: a future reader who deletes one as dead code will find
// the suite still green, so this test measures the property at the WIRE instead
// of at whichever guard happens to be doing the work.
//
// The instrument is the serving side's request count rather than the consumer's
// map, which is what makes it a second measurement and not a restatement of the
// first: the map could agree with itself while the wire carried a duplicate.
test('a reload puts no second request on the wire for a seat already streaming', async () => {
  const { server } = servingBox();
  const gets = [];
  const origRoute = server._route.bind(server);
  server._route = (req, res) => {
    if (req.method === 'GET' && String(req.url).startsWith('/api/wterm/')) gets.push(req.url);
    return origRoute(req, res);
  };
  await server.start();
  const conn = consumer(server.port);
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);
    await new Promise((r) => conn.wtermOpen('alice', r));
    await waitFor('the stream to reach the serving box', () => watched(server).length === 1);
    assert.deepStrictEqual(gets, ['/api/wterm/alice'],
      'ENTER: the first open really did reach the wire, so a silent second one would show here');

    reloadRenderer();
    await new Promise((r) => conn.wtermOpen('alice', r));
    await new Promise((r) => setTimeout(r, 250));

    assert.deepStrictEqual(gets, ['/api/wterm/alice'],
      'the fresh renderer asked, and nothing left this box — the want is main-side and survived the reload');
  } finally {
    conn.stop();
    server.stop();
  }
});

// --- 2. what a reload DOES leave behind -------------------------------------
// The renderer's release edge (`releasePeer`) is the only thing that ever tells
// the serving box we stopped watching, and it is driven off `held`, which is
// renderer state. A reload destroys `held` while the main-side want survives —
// so a stream the fresh renderer never re-shows has lost its only closer.
//
// This is NOT the leak as filed: it does not grow per reload, and it is one
// stream for a seat that was genuinely opened, not a duplicate. It is the
// orphaning of that one stream.

test('a seat the fresh renderer does not re-show keeps its stream, with nothing left to close it', async () => {
  const { server, spawns } = servingBox();
  await server.start();
  const conn = consumer(server.port);
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);

    await new Promise((r) => conn.wtermOpen('alice', r));
    await waitFor('alice to be watched', () => watched(server).includes('alice'));

    reloadRenderer();

    // The fresh renderer comes up with the drawer COLLAPSED (drawer-host boots
    // collapsed and only `selectFirst` runs) and the operator opens the term
    // tab on a different seat. Nothing anywhere re-shows `alice`, and the fresh
    // renderer's `held` is null, so its `releasePeer` has nothing to release.
    await new Promise((r) => conn.wtermOpen('bob', r));
    await waitFor('bob to be watched', () => watched(server).includes('bob'));

    assert.deepStrictEqual(watched(server), ['alice', 'bob'],
      'alice is still watched by a renderer that no longer exists');
    assert.deepStrictEqual(spawns, ['alice', 'bob'],
      'ENTER: and both shells are real — the second seat genuinely spawned, so this is two live shells');
  } finally {
    conn.stop();
    server.stop();
  }
});

// The bound on that leak, and the reason it is a stranded stream rather than a
// growing one: the orphan is per SEAT, not per reload. Ten reloads with the
// same seat showing leave exactly one.
test('the orphan does not accumulate across repeated reloads of the same seat', async () => {
  const { server, spawns } = servingBox();
  await server.start();
  const conn = consumer(server.port);
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);
    for (let i = 0; i < 5; i++) {
      reloadRenderer();
      await new Promise((r) => conn.wtermOpen('alice', r));
      // `wtermOpen`'s callback fires SYNCHRONOUSLY, before the SSE request has
      // been answered — so a loop that only awaits the callback leaves
      // `opening` true and every later iteration returns at a guard that is not
      // the one under test. The loop would then pass against a box that leaks a
      // stream per reload, purely by outrunning it. Settling to a live `req`
      // between iterations is what makes each pass a real reload.
      await waitFor(`the stream from reload ${i} to be live`,
        () => { const w = conn._wterms.get('alice'); return !!(w && w.req && !w.opening); });
    }
    await new Promise((r) => setTimeout(r, 250));
    assert.deepStrictEqual(watched(server), ['alice'], 'five reloads, one stream');
    assert.strictEqual(server._wterm.get('alice').size, 1, 'held by exactly one response');
    assert.deepStrictEqual(spawns, ['alice'], 'and one shell');
  } finally {
    conn.stop();
    server.stop();
  }
});
