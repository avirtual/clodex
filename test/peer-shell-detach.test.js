'use strict';

// The RELEASE edge: does anything on this box ever tell a peer's box that we
// have stopped watching its shell?
//
// It did not, for the whole first cut of the feature. `peer:wtermClose` was
// registered in the contract, handled in ipc-handlers, implemented in
// peer-client, routed in remote.js and pinned by two tests — and no product
// code called it. Every one of those pins passed, because pinning that a
// channel EXISTS says nothing about whether anything reaches it. What the
// operator got was a mark on their sidebar for a seat nobody was watching,
// re-asserted by the serving box's heartbeat forever, over a shell the open
// had SPAWNED.
//
// So this file tests the caller, not the channel. term-tab.js is DOM-bound and
// carries no unit tests per the R1 rule, but the release logic touches the DOM
// nowhere: it needs an xterm that swallows writes and a `pane` with three
// methods. That is a small enough stand-in to be worth the one thing it buys —
// deleting the detach path fails here and nowhere else.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// xterm is a real dependency of the packaged app and a heavy one to construct
// against no DOM, so the two modules term-tab pulls are pre-seeded into the
// require cache. Resolved from term-tab's own directory: a different resolution
// than the one it performs would seed a cache entry it never reads, and the
// test would silently run against the real xterm.
// A sentinel, not a shape: `{ ok: false }` and `null` are both real replies the
// production code distinguishes, so the "leave it in flight" instruction cannot
// be one of them.
const DEFER = Symbol('defer');

// `onData` KEEPS the callback rather than swallowing it. A stub that drops it
// makes the keystroke path unreachable from any test in the suite, which is how
// term-tab shipped sending a peer seat's keystrokes into the seatless workspace
// shell under a green suite: nothing had ever typed.
function stubXterm(writes, sink) {
  const seed = (id, exports) => {
    const p = require.resolve(id, { paths: [path.join(ROOT, 'renderer')] });
    require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] };
  };
  seed('@xterm/xterm', { Terminal: class {
    open() {} write(d) { writes.push(String(d)); } reset() {} focus() {} clear() {}
    loadAddon() {} onData(fn) { sink.data = fn; } onSelectionChange() {}
    getSelection() { return ''; }
    get cols() { return 80; } get rows() { return 24; }
  } });
  seed('@xterm/addon-fit', { FitAddon: class {
    fit() {}
    proposeDimensions() { return { cols: 80, rows: 24 }; }
  } });
}

// The drawer host's side of the contract, reduced to what this seam uses: it
// takes the tenant definition and hands back a notify. The real host's rule 2
// (onShow/onHide strictly alternate, guarded by `rec.shown`) is NOT modelled —
// these tests drive the edges directly, because the point is what the TENANT
// does when told, and modelling the host here would test the model.
function mountTermTab({ seatType = 'remote', shellCap = true } = {}) {
  const writes = [];
  const sink = {};
  stubXterm(writes, sink);
  delete require.cache[require.resolve(path.join(ROOT, 'renderer', 'term-tab.js'))];
  const { createTermTab } = require(path.join(ROOT, 'renderer', 'term-tab.js'));

  const calls = [];
  let active = null;
  let type = seatType;
  let cap = shellCap;

  // A reply of DEFER leaves the open in flight and parks its resolver in
  // `deferred`, which is the only way to get two opens overlapping for ONE
  // seat — the same-seat race the epoch exists for. Every other test wants the
  // immediate resolve, so this is opt-in per reply rather than a mode.
  const openReplies = [];
  const deferred = [];
  const api = {
    peerWtermOpen: (key) => {
      calls.push(['open', key]);
      const reply = openReplies.length ? openReplies.shift() : { ok: true };
      if (reply === DEFER) return new Promise((resolve, reject) => deferred.push({ resolve, reject }));
      return Promise.resolve(reply);
    },
    peerWtermClose: (key) => { calls.push(['close', key]); return Promise.resolve({ ok: true }); },
    peerWtermInput: (key, d) => { calls.push(['peer-input', key, d]); },
    peerWtermResize: (key) => { calls.push(['peer-resize', key]); },
    wtermSpawn: (o) => { calls.push(['spawn', o.seat]); return Promise.resolve({ ok: true, fresh: true }); },
    wtermWrite: (key, d) => { calls.push(['local-write', key, d]); },
    wtermResize: (key) => { calls.push(['local-resize', key]); },
    onWtermData: () => {}, onPeerWtermReplay: () => {}, onPeerWtermData: () => {},
    onPeerWtermExit: () => {}, onPeerWtermClosed: () => {},
  };
  const prevWindow = global.window;
  const prevDocument = global.document;
  global.window = { api };
  global.document = { createElement: () => ({ addEventListener() {}, style: {} }) };

  let def = null;
  const host = {
    register: (d) => { def = d; return Object.assign(() => {}, { selectionChanged: () => {} }); },
    open() {},
  };
  createTermTab({
    host,
    xtermTheme: () => ({}),
    getActiveSession: () => active,
    getSeatType: () => type,
    getSeatShellCap: () => cap,
  });
  def.mount({ innerHTML: '', querySelector: () => ({}) }, { appendChild() {} });

  return {
    def, calls, openReplies, writes, DEFER,
    // Resolve the oldest still-in-flight open. Oldest first because that is the
    // race: the STALE reply is the one that arrives last.
    resolveOpen: (reply) => { deferred.shift().resolve(reply); },
    // The other way an open ends: `invoke` REJECTS. A different branch in
    // term-tab (`.catch`) with its own copy of the guard, so a test that only
    // ever resolves leaves half the race unmeasured.
    rejectOpen: (err) => { deferred.shift().reject(err || new Error('ipc is down')); },
    // What the operator typing does, and the only way to reach the third
    // sender. Throws rather than no-ops if mount never registered a handler —
    // a silent skip here would restore exactly the blindness this replaced.
    typeInto: (d) => {
      assert.strictEqual(typeof sink.data, 'function', 'ENTER: mount registered an onData handler');
      sink.data(d);
    },
    setSeat: (s) => { active = s; },
    setType: (t) => { type = t; },
    setCap: (c) => { cap = c; },
    restore: () => { global.window = prevWindow; global.document = prevDocument; },
    // The awaits below are for term-tab's own `.then` on peerWtermOpen — the
    // hold is recorded before the request, but the FAILURE branch that clears
    // it runs in the continuation, so a test that asserts about a refused open
    // has to let the microtask queue drain first.
    settle: () => new Promise((r) => setImmediate(r)),
  };
}

test('hiding the drawer releases the peer stream', async () => {
  const t = mountTermTab();
  try {
    t.setSeat('alice@p1');
    t.def.onShow();
    await t.settle();
    assert.deepStrictEqual(t.calls, [['open', 'alice@p1']], 'ENTER: the pane opened a peer stream');

    t.def.onHide();
    assert.deepStrictEqual(t.calls[1], ['close', 'alice@p1'],
      'a collapsed drawer stops holding a stream open on someone else\'s box');
  } finally { t.restore(); }
});

// The edge the host CANNOT tell a tenant about: rule 2 makes onShow/onHide the
// visibility axis, so a seat switch while the tab stays visible fires neither.
// It arrives as onSeatChanged, which term-tab routes into onShow — so the
// release has to happen there, before the re-key, or the old seat is
// unreferenced and unreleasable.
test('switching seats releases the seat being left', async () => {
  const t = mountTermTab();
  try {
    t.setSeat('alice@p1');
    t.def.onShow();
    await t.settle();
    assert.deepStrictEqual(t.calls, [['open', 'alice@p1']], 'ENTER: alice was open');

    t.setSeat('bob@p1');
    t.def.onSeatChanged();
    await t.settle();
    assert.deepStrictEqual(t.calls, [['open', 'alice@p1'], ['close', 'alice@p1'], ['open', 'bob@p1']],
      'the old seat was closed BEFORE the new one opened, and the close named the old seat');
  } finally { t.restore(); }
});

// Re-showing the same seat is the ordinary case (onShow re-opens every time and
// the main side is idempotent about it). It must not read as a switch: a close
// here would drop the stream a moment before re-opening it, and on the serving
// side that is a detach followed by a fresh announce — the operator gets a
// "peer opened your terminal" row every time they collapse and expand a drawer.
test('re-showing the same seat does not release it', async () => {
  const t = mountTermTab();
  try {
    t.setSeat('alice@p1');
    t.def.onShow();
    await t.settle();
    t.def.onShow();
    await t.settle();
    assert.deepStrictEqual(t.calls, [['open', 'alice@p1'], ['open', 'alice@p1']],
      'ENTER: two opens and no close between them');
  } finally { t.restore(); }
});

// A LOCAL shell is the operator's own and is deliberately left running: it
// survives a collapse today, and it has no stream to release in any case. The
// close route on the serving side drops every watcher of a seat, so a close
// fired for a local seat would not be a harmless no-op if the names ever
// collided across the two paths.
test('a local seat is never closed on hide', async () => {
  const t = mountTermTab({ seatType: 'claude' });
  try {
    t.setSeat('alice');
    t.def.onShow();
    await t.settle();
    assert.deepStrictEqual(t.calls, [['spawn', 'alice']], 'ENTER: this took the LOCAL path');

    t.def.onHide();
    assert.deepStrictEqual(t.calls, [['spawn', 'alice']], 'nothing was closed');
  } finally { t.restore(); }
});

// Two hides with one show between them. The host's rule 2 makes that
// impossible, but the tenant does not depend on it here — and a second close
// is not idempotent on the far side: it would drop a stream some LATER show
// had opened, or another consumer's.
test('a second hide sends nothing', async () => {
  const t = mountTermTab();
  try {
    t.setSeat('alice@p1');
    t.def.onShow();
    await t.settle();
    t.def.onHide();
    assert.strictEqual(t.calls.length, 2, 'ENTER: the first hide closed it');
    t.def.onHide();
    assert.strictEqual(t.calls.length, 2, 'the second hide sent nothing');
  } finally { t.restore(); }
});

// A refused open holds nothing. Releasing anyway would reach the serving side's
// close route for a seat we never opened — and that route drops EVERY watcher
// of the seat, so the refusal would detach a different consumer.
test('an open that was refused is not closed on hide', async () => {
  const t = mountTermTab();
  try {
    t.openReplies.push({ ok: false, error: 'terminal sharing is not enabled on this box' });
    t.setSeat('alice@p1');
    t.def.onShow();
    await t.settle();
    assert.deepStrictEqual(t.calls, [['open', 'alice@p1']], 'ENTER: the open was attempted and refused');

    t.def.onHide();
    assert.deepStrictEqual(t.calls, [['open', 'alice@p1']], 'no close for a door that never opened');
  } finally { t.restore(); }
});

// The reply arrives AFTER the operator has moved on, and it is a refusal. The
// hold it would clear is no longer its own — it belongs to the seat switched to
// — so clearing it unguarded leaks that seat's stream on the next hide, which is
// the exact bug this whole file exists for, one race narrower.
test('a refusal that lost a race to a later switch does not clear the new hold', async () => {
  const t = mountTermTab();
  try {
    t.openReplies.push({ ok: false, error: 'no such peer session' });
    t.setSeat('alice@p1');
    t.def.onShow();
    t.setSeat('bob@p1');
    t.def.onSeatChanged();
    await t.settle();
    const opens = t.calls.filter((c) => c[0] === 'open').map((c) => c[1]);
    assert.deepStrictEqual(opens, ['alice@p1', 'bob@p1'], 'ENTER: both opens went out, alice\'s refused');

    t.def.onHide();
    assert.deepStrictEqual(t.calls[t.calls.length - 1], ['close', 'bob@p1'],
      'the surviving hold is bob\'s and the hide released it');
  } finally { t.restore(); }
});

// The same race one seat narrower, and the seat test cannot see it. onShow
// re-opens on every show, so show/hide/show for ONE seat puts two opens in
// flight for it. The second succeeds and is the live stream; the first comes
// back refused, `asked === seat` passes because the seat never changed, and the
// refusal clears the hold the live stream is recorded under. Nothing releases it
// after that — the far box keeps a stream, the shell it spawned, and a mark for
// a pane nobody is watching.
test('a stale same-SEAT refusal does not clear the hold the live open took', async () => {
  const t = mountTermTab();
  try {
    t.openReplies.push(DEFER);          // open #1 — left in flight
    t.setSeat('alice@p1');
    t.def.onShow();
    t.def.onHide();
    t.def.onShow();                     // open #2 — resolves ok
    await t.settle();
    const opens = t.calls.filter((c) => c[0] === 'open');
    assert.strictEqual(opens.length, 2, 'ENTER: two opens for the one seat are in play');

    t.resolveOpen({ ok: false, error: 'no such peer session' });
    await t.settle();

    t.def.onHide();
    assert.deepStrictEqual(t.calls[t.calls.length - 1], ['close', 'alice@p1'],
      'the live stream was still held, so the hide released it');
  } finally { t.restore(); }
});

// The same stale reply arriving as a REJECTION rather than a refusal. It is a
// separate branch with its own copy of the guard — an `invoke` that throws (the
// main process gone, the channel unregistered) lands here, and without the
// epoch it clears the live hold exactly as the refusal above would.
test('a stale same-SEAT rejection does not clear the hold either', async () => {
  const t = mountTermTab();
  try {
    t.openReplies.push(DEFER);
    t.setSeat('alice@p1');
    t.def.onShow();
    t.def.onHide();
    t.def.onShow();
    await t.settle();
    assert.strictEqual(t.calls.filter((c) => c[0] === 'open').length, 2,
      'ENTER: two opens for the one seat are in play');

    t.rejectOpen(new Error('ipc is down'));
    await t.settle();

    t.def.onHide();
    assert.deepStrictEqual(t.calls[t.calls.length - 1], ['close', 'alice@p1'],
      'the live stream was still held');
  } finally { t.restore(); }
});

// A success that a LATER refusal for the same seat tries to undo. peer-client
// refuses on a transient offline/no-cap disagreement before it reaches its
// `wanted` early return, so the refusal is purely local: the main side still
// wants the stream and re-opens it on the next hello. Clearing the hold on that
// refusal strands a stream nothing on this side can ever close.
test('a refusal after a successful open for the same seat does not clear the hold', async () => {
  const t = mountTermTab();
  try {
    t.setSeat('alice@p1');
    t.def.onShow();
    await t.settle();
    assert.deepStrictEqual(t.calls, [['open', 'alice@p1']], 'ENTER: the first open succeeded');

    t.openReplies.push({ ok: false, error: 'that box is offline' });
    t.def.onShow();
    await t.settle();
    assert.strictEqual(t.calls.filter((c) => c[0] === 'open').length, 2,
      'ENTER: a second open for the same seat went out and was refused');

    t.def.onHide();
    assert.deepStrictEqual(t.calls[t.calls.length - 1], ['close', 'alice@p1'],
      'the hold survived the refusal, so the hide could release it');
  } finally { t.restore(); }
});

// The same, arriving as a REJECTION. Separate branch, separate copy of the
// guard — a test that only ever refuses leaves it unmeasured.
test('a rejection after a successful open for the same seat does not clear the hold', async () => {
  const t = mountTermTab();
  try {
    t.setSeat('alice@p1');
    t.def.onShow();
    await t.settle();
    assert.deepStrictEqual(t.calls, [['open', 'alice@p1']], 'ENTER: the first open succeeded');

    t.openReplies.push(DEFER);
    t.def.onShow();
    await t.settle();
    t.rejectOpen(new Error('ipc is down'));
    await t.settle();
    assert.strictEqual(t.calls.filter((c) => c[0] === 'open').length, 2,
      'ENTER: a second open for the same seat went out and threw');

    t.def.onHide();
    assert.deepStrictEqual(t.calls[t.calls.length - 1], ['close', 'alice@p1'],
      'the hold survived it');
  } finally { t.restore(); }
});

// --- keystrokes, the third sender -------------------------------------------
// onShow prints its refusal and RETURNS — it does not unmount, close or blur
// the pane. So a tab whose backend went away is still focused and still
// delivering every keystroke to this callback.

test('a live peer seat types over the wire', async () => {
  const t = mountTermTab();
  try {
    t.setSeat('alice@p1');
    t.def.onShow();
    await t.settle();
    t.typeInto('ls\r');
    assert.deepStrictEqual(t.calls.filter((c) => c[0] === 'peer-input'), [['peer-input', 'alice@p1', 'ls\r']],
      'the keystroke went to the peer, keyed by the composite');
  } finally { t.restore(); }
});

test('a local seat types into the local shell', async () => {
  const t = mountTermTab({ seatType: 'claude' });
  try {
    t.setSeat('alice');
    t.def.onShow();
    await t.settle();
    t.typeInto('ls\r');
    assert.deepStrictEqual(t.calls.filter((c) => c[0] === 'local-write'), [['local-write', 'alice', 'ls\r']],
      'and the local writer is reachable too — both arms of the absence below');
  } finally { t.restore(); }
});

// The defect the two controls above make meaningful. An `else` here means
// "local", so a peer seat with no backend sends its COMPOSITE key to
// wtermWrite; seatOf rejects the `@` and a rejected seat is null, which is the
// seatless workspace shell. The Enter executes there. Nothing shows it: `write`
// never spawns, so it lands only where that shell already exists, and the data
// handler's `from` filter drops the echo.
test('a seat with no backend types nowhere at all', async () => {
  const t = mountTermTab();
  try {
    t.setSeat('alice@p1');
    t.def.onShow();
    await t.settle();
    t.typeInto('before\r');
    assert.strictEqual(t.calls.filter((c) => c[0] === 'peer-input').length, 1,
      'ENTER: this pane could type a moment ago');

    t.setCap(false);
    t.def.onShow();                     // prints the refusal, leaves the pane live
    await t.settle();
    t.typeInto('rm -rf .\r');

    assert.deepStrictEqual(t.calls.filter((c) => c[0] === 'local-write'), [],
      'nothing went to a local shell — that would be the seatless workspace terminal');
    assert.strictEqual(t.calls.filter((c) => c[0] === 'peer-input').length, 1,
      'and nothing more went over the wire either');
  } finally { t.restore(); }
});

// --- a backend that went away under a visible tab ---------------------------
// `availableFor` is only re-run by the host's syncSeatAvailability, so a peer
// going offline or a grant being withdrawn does not take the tab away on its
// own. term-tab therefore meets a THIRD answer from termBackendFor — null — and
// must not read it as local: the local call would carry this seat's composite
// `name@peerId` key, ipc-handlers' seatOf rejects the `@`, and a rejected seat
// is null, which is the key of the seatless workspace shell.

test('a peer seat whose backend went away spawns nothing and says so', async () => {
  const t = mountTermTab();
  try {
    t.setSeat('alice@p1');
    t.def.onShow();
    await t.settle();
    assert.deepStrictEqual(t.calls, [['open', 'alice@p1']], 'ENTER: the peer stream was open and held');

    t.setCap(false);                    // the grant is withdrawn, tab still visible
    t.def.onShow();
    await t.settle();

    assert.deepStrictEqual(t.calls.filter((c) => c[0] === 'spawn'), [],
      'no local shell was asked for — that request would land in the seatless workspace terminal');
    assert.deepStrictEqual(t.calls.filter((c) => c[0] === 'open'), [['open', 'alice@p1']],
      'and no second peer open either');
    assert.deepStrictEqual(t.calls[t.calls.length - 1], ['close', 'alice@p1'],
      'the stream it was holding was released — the backend is gone, nobody is watching');
    assert.match(t.writes.join(''), /peer is offline, or terminal sharing was turned off/,
      'the operator is told why the pane is empty');
  } finally { t.restore(); }
});

// The positive control for the absence above. Without it "spawn was not called"
// is true of a harness that cannot call spawn at all.
test('a local seat still spawns — the absence above is about the null backend', async () => {
  const t = mountTermTab({ seatType: 'claude' });
  try {
    t.setSeat('alice');
    t.def.onShow();
    await t.settle();
    assert.deepStrictEqual(t.calls, [['spawn', 'alice']], 'the local path does reach wtermSpawn');
  } finally { t.restore(); }
});

// onResize is the second sender, and it reads the same field. A resize on a null
// backend would push the composite key down the local path — the same seatless
// shell, reached by a gesture as ordinary as dragging the drawer.
test('a resize with no backend sends nothing either way', async () => {
  const t = mountTermTab();
  try {
    t.setSeat('alice@p1');
    t.def.onShow();
    await t.settle();
    t.def.onResize();
    assert.deepStrictEqual(t.calls.filter((c) => c[0] === 'peer-resize'), [['peer-resize', 'alice@p1']],
      'ENTER: a resize on a live peer backend does reach the wire');

    t.setCap(false);
    t.def.onShow();                     // re-reads the backend as null
    await t.settle();
    const before = t.calls.length;
    t.def.onResize();
    assert.strictEqual(t.calls.length, before, 'neither wtermResize nor peerWtermResize was called');
  } finally { t.restore(); }
});
