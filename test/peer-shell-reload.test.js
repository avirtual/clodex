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
//
// The emitted events are RECORDED, not dropped. They are the only thing the
// renderer ever sees of this wire, so a harness that swallows them can measure
// the serving box perfectly and still miss what the operator gets — which is
// exactly what the first pass of this file did.
function consumer(port) {
  const events = [];
  const conn = new PeerConnection({
    id: 'p1',
    label: 'box',
    url: `http://127.0.0.1:${port}`,
    emit: (channel, id, seat, payload) => { events.push({ channel, seat, payload }); },
    helloIntervalMs: 60000,
  });
  conn.events = events;
  return conn;
}

const chan = (conn, channel) => conn.events.filter((e) => e.channel === channel);

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

// Two windows on one box. A workspace id IS the window (1:1 with a
// BrowserWindow), and it is what ipc-handlers puts in `owners`.
const W1 = 'workspace-1';
const W2 = 'workspace-2';

// A renderer reload as main sees it, and t379 made this a real seam. It used to
// be a no-op, because a per-window drop was not implementable: `_wterms` had no
// window attribution and the `peer:wterm*` handlers discarded the sender. Both
// were fixed — a wterm entry now carries an `owners` Set of workspace ids, and
// ipc-handlers records the sender's workspace on open and close.
//
// So the drop below is what main.js's `did-start-navigation` listener does with
// the navigating window's id. It stands in for that listener, which is
// Electron-bound and cannot run here; what it calls is the real production
// method, and the wire underneath it is real.
//
// Everything a window did NOT own is untouched, which is the whole point of
// keying by window rather than shedding the connection's streams.
function reloadRenderer(conn, windowId = W1) { conn.dropWtermsForWindow(windowId); }

// A window CLOSE. Identical here by construction — main calls the same drop
// with the same id — and that identity is the point rather than a shortcut:
// the two edges must shed the same way, so the behaviour below is asserted
// once and the WIRING of each edge is pinned separately against main.js source
// (a closed window cannot be driven from this process). The close edge matters
// more than the reload one: after `unregisterWindow` no navigation for that
// workspace can ever fire, so a want left here is permanent.
function closeWindow(conn, windowId = W1) { conn.dropWtermsForWindow(windowId); }

// --- 1. the claim as filed --------------------------------------------------

test('a reload re-opens the seat: one stream, one shell, and a snapshot for the fresh renderer', async () => {
  const { server, spawns, reports, shells } = servingBox();
  await server.start();
  const conn = consumer(server.port);
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);

    // Pre-reload: the renderer showed the term tab on seat `alice`.
    await new Promise((r) => conn.wtermOpen('alice', W1, r));
    await waitFor('the stream to reach the serving box', () => watched(server).length === 1);
    assert.deepStrictEqual(watched(server), ['alice'],
      'ENTER: a stream really was open before the reload, so the counts below are about the reload');
    assert.deepStrictEqual(spawns, ['alice'], 'ENTER: and exactly one shell had been asked for');

    reloadRenderer(conn);

    // The fresh renderer shows the same seat and calls the same door. This is
    // the exact call the ticket said opens a second stream.
    await new Promise((r) => conn.wtermOpen('alice', W1, r));
    // A second SSE request would have to travel, so give it a window in which
    // it could have arrived. Asserting immediately would pass against a leak
    // that is merely slower than the assertion.
    await waitFor('the re-opened stream to reach the serving box', () => watched(server).length === 1);
    await new Promise((r) => setTimeout(r, 250));

    assert.deepStrictEqual(watched(server), ['alice'],
      'still exactly one seat watched — the reload did not leave a second stream behind');
    assert.strictEqual(server._wterm.get('alice').size, 1,
      'and exactly one SSE response is held for it, not two');
    assert.deepStrictEqual(spawns, ['alice', 'alice'],
      'the seat was re-opened, and the SECOND spawn attached to the shell already running — drawer-pty is idempotent per seat, so this is one shell asked for twice, not two shells');
    assert.strictEqual(shells.size, 1,
      'ENTER: and the serving box really is holding ONE shell, which is what makes the line above a re-attach rather than a leak');
    assert.ok(reports.length >= 1, 'ENTER: the stream report fired, so an added stream would have been reported');

    // THE FRESH RENDERER IS FED, and this is the half t224 could only report.
    // Before t379 the reload hit `wtermOpen`'s `w && w.wanted` early return,
    // which answers ok WITHOUT opening an SSE — and the serving box writes
    // `replay` only at stream-open, so the fresh renderer got no snapshot.
    //
    // What that cost the operator is in term-tab.js, which this test cannot
    // execute (DOM-bound) but whose input it fully determines: `onShow` sets
    // `pending = []` on every show, and on the PEER path `flushPending` is
    // reachable from exactly one place — the replay listener. No replay meant
    // `pending` was never nulled, so every live byte was buffered instead of
    // painted: a blank pane and a buffer growing for as long as the remote
    // shell printed.
    //
    // Dropping the window's want at navigation start is what makes the re-show
    // a REAL open, so a second replay is sent and the pane paints.
    assert.strictEqual(chan(conn, 'peer-wterm-replay').length, 2,
      'the fresh renderer was handed its own snapshot — without one its pending buffer never flushes and the pane stays blank');

    server.pushWtermOutput('alice', Buffer.from('post-reload output\n'));
    await waitFor('the live byte to reach the consumer', () => chan(conn, 'peer-wterm-data').length >= 1);
    assert.strictEqual(chan(conn, 'peer-wterm-replay').length, 2,
      'and live output rides the same stream the replay opened, so those bytes are painted rather than piling up');
  } finally {
    conn.stop();
    server.stop();
  }
});

// The same property measured at the WIRE rather than at either side's map, and
// that is what makes it a second measurement instead of a restatement: the two
// maps could agree with each other while the wire carried something else.
//
// A reload now costs exactly one extra request — the old stream is dropped and
// the seat re-opened. The number that matters is not "one more" but "one more
// AT A TIME": what must never appear is a second GET while the first stream is
// still live, which is the duplicate t224 disproved and the shape a fix that
// dropped the want WITHOUT closing the stream would produce.
test('a reload costs exactly one re-open on the wire, never a second concurrent stream', async () => {
  const { server } = servingBox();
  const gets = [];
  const concurrent = [];
  const origRoute = server._route.bind(server);
  server._route = (req, res) => {
    if (req.method === 'GET' && String(req.url).startsWith('/api/wterm/')) {
      gets.push(req.url);
      // Sampled BEFORE the route runs, so it counts the streams already held
      // when this request arrives. A duplicate open is exactly the case where
      // that count is not zero.
      const set = server._wterm.get('alice');
      concurrent.push(set ? set.size : 0);
    }
    return origRoute(req, res);
  };
  await server.start();
  const conn = consumer(server.port);
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);
    await new Promise((r) => conn.wtermOpen('alice', W1, r));
    await waitFor('the stream to reach the serving box', () => watched(server).length === 1);
    assert.deepStrictEqual(gets, ['/api/wterm/alice'],
      'ENTER: the first open really did reach the wire, so every later one shows here too');

    reloadRenderer(conn);
    // WAIT for the shed before re-opening, rather than sampling and hoping.
    // The drop destroys the socket synchronously, but the server learns of it
    // on its own `close` event, which is async — so firing the re-open
    // immediately makes the sample below a race with the serving box's event
    // loop. A flake there reads as a duplicate-stream regression, the most
    // expensive misdiagnosis available on this file, since a second concurrent
    // stream is the very thing t224 disproved. Waiting makes the sample
    // deterministic and still measures the real property: what must never
    // happen is a GET arriving on top of a stream that is still live.
    await waitFor('the old stream to be shed', () => watched(server).length === 0);
    await new Promise((r) => conn.wtermOpen('alice', W1, r));
    await waitFor('the re-open to reach the wire', () => gets.length >= 2);
    await new Promise((r) => setTimeout(r, 250));

    assert.deepStrictEqual(gets, ['/api/wterm/alice', '/api/wterm/alice'],
      'one re-open, and only one — the fresh renderer opened for real and nothing opened a third time');
    assert.deepStrictEqual(concurrent, [0, 0],
      'every open arrived with NO stream already held for the seat, so the reload closed before it re-opened and the two never overlap');
  } finally {
    conn.stop();
    server.stop();
  }
});

// --- 2. the orphan, which is what t379 fixed --------------------------------
// The renderer's release edge (`releasePeer`) used to be the only thing that
// ever told the serving box we stopped watching, and it is driven off `held`,
// which is renderer state. A reload destroys `held` while the main-side want
// survives — so a stream the fresh renderer never re-shows had lost its only
// closer, and on the SERVING side that is a real shell on someone else's
// machine kept alive by a viewer that no longer exists.
//
// The fix gives the want an OWNER (the window), so main can drop it without the
// renderer's help. The two tests below were t224's characterization of the
// orphan; they now state its absence.

test('a seat the fresh renderer does not re-show is dropped, not orphaned', async () => {
  const { server, spawns, closes } = servingBox();
  await server.start();
  const conn = consumer(server.port);
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);

    await new Promise((r) => conn.wtermOpen('alice', W1, r));
    await waitFor('alice to be watched', () => watched(server).includes('alice'));
    assert.deepStrictEqual(watched(server), ['alice'],
      'ENTER: alice really was streaming before the reload, so its absence below is the drop and not a stream that never opened');

    reloadRenderer(conn);

    // The fresh renderer comes up with the drawer COLLAPSED (drawer-host boots
    // collapsed and only `selectFirst` runs) and the operator opens the term
    // tab on a different seat. Nothing anywhere re-shows `alice`.
    await new Promise((r) => conn.wtermOpen('bob', W1, r));
    await waitFor('bob to be watched', () => watched(server).includes('bob'));
    await new Promise((r) => setTimeout(r, 250));

    assert.deepStrictEqual(watched(server), ['bob'],
      'alice went with the renderer that wanted it; only the seat the fresh renderer actually showed is still watched');
    assert.deepStrictEqual(spawns, ['alice', 'bob'],
      'ENTER: both seats genuinely spawned, so the assertion above is about a shell that really existed');
    assert.deepStrictEqual(closes, [],
      'and the far box was never sent a close POST — the stream is shed by dropping the socket, so a close still in flight cannot land on a re-opened stream');
  } finally {
    conn.stop();
    server.stop();
  }
});

// The seat that IS re-shown must survive, and this is the fenced hazard stated
// as a test: a fix that sheds on reload without ownership races the re-show and
// kills a terminal the operator is actively watching. It cannot happen here
// because the drop is ordered BEFORE the fresh renderer's first call, never
// concurrently with it — so a re-show is always a fresh open, never a survivor
// of a shootdown.
test('the seat the fresh renderer DOES re-show ends up live, not shot down by the drop', async () => {
  const { server } = servingBox();
  await server.start();
  const conn = consumer(server.port);
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);
    await new Promise((r) => conn.wtermOpen('alice', W1, r));
    await waitFor('alice to be watched', () => watched(server).includes('alice'));

    reloadRenderer(conn);
    await new Promise((r) => conn.wtermOpen('alice', W1, r));
    await waitFor('the re-show to reach the serving box', () => watched(server).includes('alice'));
    // Long enough for a late close to land, if the mechanism could produce one.
    await new Promise((r) => setTimeout(r, 300));

    assert.deepStrictEqual(watched(server), ['alice'],
      'the re-shown seat is streaming — nothing arrived after the re-open to tear it down');
    const w = conn._wterms.get('alice');
    assert.ok(w && w.wanted && w.req, 'and the consumer side holds a live request for it, so the pane has a feed');
    server.pushWtermOutput('alice', Buffer.from('still alive\n'));
    await waitFor('output to reach the re-shown pane', () => chan(conn, 'peer-wterm-data').length >= 1);
  } finally {
    conn.stop();
    server.stop();
  }
});

// Repeated reloads: still one stream and one shell, which was already true and
// must stay true. What changed is that the one stream now belongs to the window
// that is actually looking at it.
test('repeated reloads of the same seat leave exactly one stream and one shell', async () => {
  const { server, spawns, shells } = servingBox();
  await server.start();
  const conn = consumer(server.port);
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);
    for (let i = 0; i < 5; i++) {
      reloadRenderer(conn);
      await new Promise((r) => conn.wtermOpen('alice', W1, r));
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
    assert.strictEqual(shells.size, 1, 'and one shell — every re-open attached to the shell already running');
    assert.strictEqual(spawns.length, 5,
      'ENTER: all five reload-and-re-show passes really did ask the far side to open the seat, so "one shell" above is idempotent re-attachment and not a loop that stopped early');
  } finally {
    conn.stop();
    server.stop();
  }
});

// A drop landing while the SSE is MID-OPEN — the GET has gone out, the 200 has
// not come back. Every other test in this file awaits `watched(server).length
// === 1` before dropping, so all of them measure a stream that is fully open
// and the entire opening interval is unmeasured by construction. That is where
// the r2 defect lived: teardown can only destroy `w.req`, `onOpen` had not
// assigned it yet, so the drop deleted the map entry and destroyed nothing
// while the far side had already spawned the shell, added its response and
// written `replay`. A stream nothing local can ever close — this ticket's own
// orphan, one interval over — and it is permanent at the window-close edge,
// where no later navigation can fire a second drop.
//
// So: open and drop back-to-back, without awaiting the stream. What must be
// true afterwards is that the far side ends up watching NOTHING.
test('a drop that lands while the stream is still opening reaps it anyway', async () => {
  const { server, spawns } = servingBox();
  await server.start();
  const conn = consumer(server.port);
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);

    // Back-to-back and deliberately un-awaited: `wtermOpen`'s callback fires
    // synchronously (the request is only dispatched), so the drop runs with the
    // entry in `opening: true, req: null` — the state no teardown could reap.
    conn.wtermOpen('alice', W1, () => {});
    closeWindow(conn, W1);

    // The far box must have SEEN the open, or this test would pass against a
    // request that never left and prove nothing about reaping.
    await waitFor('the mid-open GET to reach the far box', () => spawns.length >= 1);
    assert.deepStrictEqual(spawns, ['alice'],
      'ENTER: the far side really did spawn and attach for this seat, so there was a live stream to orphan');

    await waitFor('the mid-open stream to be reaped', () => watched(server).length === 0);
    assert.deepStrictEqual(watched(server), [],
      'the socket was destroyed when it first existed, so nothing is left watching — an unreaped mid-open stream has no local closer at all');
    assert.ok(!conn._wterms.has('alice'), 'and no want survives on this side either');

    // The second harm, which is worse than the leak: a re-show against a stale
    // entry opens a SECOND concurrent stream and every byte prints twice.
    await new Promise((r) => conn.wtermOpen('alice', W1, r));
    await waitFor('the re-open to reach the far box', () => watched(server).length === 1);
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(server._wterm.get('alice').size, 1,
      'exactly ONE response is held for the seat — a surviving mid-open stream would make the re-show a duplicate and double-print every byte');
  } finally {
    conn.stop();
    server.stop();
  }
});

// --- 3. window attribution, which is what makes the drop safe ---------------
// The reviewer's objection to the original spec: `_wterms` is keyed by seat per
// connection, so a per-window drop would tear down a stream ANOTHER window is
// legitimately watching. Ownership is the answer, and these two pin both
// directions of it — a drop must not over-reach, and a close must not either.

test('a reload in one window leaves a seat the OTHER window is watching alone', async () => {
  const { server } = servingBox();
  await server.start();
  const conn = consumer(server.port);
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);
    // Both windows show the same seat. The second open takes the dedupe path,
    // which is exactly where an unrecorded owner would be lost.
    await new Promise((r) => conn.wtermOpen('alice', W1, r));
    await new Promise((r) => conn.wtermOpen('alice', W2, r));
    await waitFor('alice to be watched', () => watched(server).includes('alice'));
    assert.deepStrictEqual([...conn._wterms.get('alice').owners].sort(), [W1, W2],
      'ENTER: both windows are recorded as wanting the seat — if the dedupe path dropped the second owner, the assertion below would pass for the wrong reason');

    reloadRenderer(conn, W1);
    await new Promise((r) => setTimeout(r, 250));

    assert.deepStrictEqual(watched(server), ['alice'],
      'the other window is still watching, so the stream stays up');
    assert.deepStrictEqual([...conn._wterms.get('alice').owners], [W2],
      'and only the reloaded window lost its want');
  } finally {
    conn.stop();
    server.stop();
  }
});

// The same property on the ordinary close edge. A window hiding the tab must
// not detach a window that still has it open — the serving side's close route
// drops EVERY watcher of the seat, so an unrefcounted close kills the other
// window's pane.
test('one window closing a shared seat does not detach the other window', async () => {
  const { server, closes } = servingBox();
  await server.start();
  const conn = consumer(server.port);
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);
    await new Promise((r) => conn.wtermOpen('alice', W1, r));
    await new Promise((r) => conn.wtermOpen('alice', W2, r));
    await waitFor('alice to be watched', () => watched(server).includes('alice'));

    await new Promise((r) => conn.wtermClose('alice', W1, r));
    await new Promise((r) => setTimeout(r, 250));

    assert.deepStrictEqual(watched(server), ['alice'],
      'W2 is still watching, so its stream survived W1 hiding the tab');
    assert.deepStrictEqual(closes, [],
      'ENTER: and no close reached the far box at all — its close route drops every watcher of the seat, so one sent here would have taken W2 down with it');

    await new Promise((r) => conn.wtermClose('alice', W2, r));
    await waitFor('the last close to reach the far box', () => closes.length >= 1);
    assert.deepStrictEqual(closes, ['alice'],
      'the LAST window out closes it for real — refcounting defers the close, it does not lose it');
    assert.deepStrictEqual(watched(server), [], 'and the stream is gone');
  } finally {
    conn.stop();
    server.stop();
  }
});

// --- 4. the window-close edge -----------------------------------------------
// A close is not a navigation, so it needs its own hook, and it is the WORSE of
// the two edges: a reload's orphan is self-healing (a later navigation for that
// workspace would shed it), while after `unregisterWindow` no navigation for it
// can ever fire again. The stream, the far box's watcher mark and the spawned
// shell are then held forever by a window that does not exist.

test('closing a window sheds its seats and leaves the surviving window alone', async () => {
  const { server, spawns } = servingBox();
  await server.start();
  const conn = consumer(server.port);
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);

    // Two windows, DIFFERENT seats — the case where a connection-wide shed
    // would look correct for the closing window and destroy the other one.
    await new Promise((r) => conn.wtermOpen('alice', W1, r));
    await new Promise((r) => conn.wtermOpen('bob', W2, r));
    await waitFor('both seats to be watched', () => watched(server).length === 2);
    assert.deepStrictEqual(watched(server), ['alice', 'bob'],
      'ENTER: both windows really are watching a seat, so the shed below is measured against two live streams');

    closeWindow(conn, W1);
    await new Promise((r) => setTimeout(r, 250));

    assert.deepStrictEqual(watched(server), ['bob'],
      'the closed window took its seat with it and left the other window streaming');
    assert.ok(!conn._wterms.has('alice'), 'and the want is gone on this side too, not merely the stream');
    assert.deepStrictEqual(spawns, ['alice', 'bob'],
      'ENTER: both shells were genuinely asked for, so this is a shed of a real stream');
  } finally {
    conn.stop();
    server.stop();
  }
});

// --- 5. the ordinary release edge -------------------------------------------
// term-tab's own close, with its window named. The drop tests above all shed
// through `dropWtermsForWindow`, which tears down LOCALLY and sends no POST;
// this is the other closer, and the POST is the half only it exercises.
//
// A close whose sender resolves to no workspace never reaches here at all: the
// seam refuses it, symmetrically with the open (pinned in
// test/drawer-services-seam.test.js). Both of the alternatives are wrong below
// this line — swallowing makes the sole closing path a no-op, shedding takes
// down a pane another window still holds — which is why the rule sits at the
// one door that has the sender rather than here, where it does not.

test('the last window closing a seat sheds the stream and tells the far box', async () => {
  const { server, closes } = servingBox();
  await server.start();
  const conn = consumer(server.port);
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);
    await new Promise((r) => conn.wtermOpen('alice', W1, r));
    await waitFor('alice to be watched', () => watched(server).includes('alice'));
    assert.deepStrictEqual(watched(server), ['alice'],
      'ENTER: a stream really was open, so the shed below is measured against a live one');

    await new Promise((r) => conn.wtermClose('alice', W1, r));
    await waitFor('the close to reach the far box', () => closes.length >= 1);

    assert.deepStrictEqual(watched(server), [],
      'the stream is gone — the owners set emptied, so the seat is genuinely unwatched');
    assert.deepStrictEqual(closes, ['alice'],
      'and the far box was TOLD, which is what clears its watcher mark; this closer POSTs where the window drops deliberately do not');
    assert.ok(!conn._wterms.has('alice'), 'and no want is left behind on this side');
  } finally {
    conn.stop();
    server.stop();
  }
});
