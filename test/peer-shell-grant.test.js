'use strict';

// The peer-terminal GRANT and its ops-log ending — the two node-testable pieces
// of the feature's operator-visibility surface. (The chip, the toast and the
// checkbox are DOM-bound; documented in the design note, not tested here.)
//
//   1. ipc `peer:setShellAllowed`: writes the per-peer record AND calls
//      syncRemoteServer. The sync is not bookkeeping — remote-wiring re-derives
//      the wterm callbacks from it, and dropping them runs dropAllWterm BEFORE
//      the handlers go null. A handler that persisted without syncing would
//      revoke on paper while a live shell kept serving until the next restart.
//   2. RemoteServer.setWtermCallbacks: the serving side of the same off switch,
//      where the ORDER is the property — streams closed before the handlers go
//      null, or the grant is revoked on paper and serving in fact.
//   3. peer-wiring's `peer-wterm-closed` ops row: the consumer end's record that
//      a shell it opened on someone else's box ended, and why.

const { test } = require('node:test');
const assert = require('node:assert');

const { createPeerWiring } = require('../peer-wiring');
const { RemoteServer } = require('../remote');
const { shellCapGranted } = require('../peer-shell');

// --- ipc harness. Same shape as peer-disable.test.js: registration rides the
// injected handle/on seams, and only the deps peer:setShellAllowed touches are
// real — registration never runs the other bodies.
function shellAllowedFixture(peers) {
  const handlers = new Map();
  const store = { peers: peers || [{ id: 'a', label: 'Thinkpad', url: 'http://a' }] };
  const calls = { set: [], sync: 0, log: [], broadcast: [] };
  const { registerIpcHandlers } = require('../ipc-handlers');
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    uiSettings: {
      get: () => store,
      set: (patch) => { calls.set.push(patch); Object.assign(store, patch); return store; },
    },
    syncRemoteServer: () => { calls.sync += 1; },
    // The grant is box-wide but the toggle lives in one window's popover, so
    // the other windows learn about it here. Recorded with the ORDER against
    // sync, which is why `sync` is a counter and this is a list.
    manager: { _broadcast: (ch, ...args) => calls.broadcast.push([ch, ...args, `sync:${calls.sync}`]) },
    log: { info: (...a) => calls.log.push(a), error() {} },
  });
  return { handler: handlers.get('peer:setShellAllowed'), store, calls };
}

test('peer:setShellAllowed(on) records the grant and re-syncs the remote server', () => {
  const { handler, store, calls } = shellAllowedFixture();
  assert.strictEqual(typeof handler, 'function', 'ENTER: peer:setShellAllowed handler registered');
  const res = handler({}, 'a', true);
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual(store.peers[0].shellAllowed, true, 'record carries the grant');
  assert.strictEqual(calls.set.length, 1, 'persisted once');
  assert.strictEqual(calls.sync, 1, 'syncRemoteServer ran — the callbacks are re-derived from settings');
  assert.match(calls.log.at(-1)[1], /Thinkpad terminal sharing ENABLED/, 'ops row names the box');
});

// The setter is UNGATED (it writes a setting on this box) but its effect is a
// capability on the wire, and the only thing joining the two is that
// shellCapGranted reads the field this handler writes. Asserting the boolean
// alone would stay green if the handler wrote `shellEnabled` or `'true'`.
test('the field the handler writes is the field the cap leaf reads', () => {
  const { handler, store } = shellAllowedFixture();
  assert.strictEqual(shellCapGranted(store.peers), false, 'ENTER: no grant before the click');
  handler({}, 'a', true);
  assert.strictEqual(shellCapGranted(store.peers), true, 'the grant reaches the cap decision');
  handler({}, 'a', false);
  assert.strictEqual(shellCapGranted(store.peers), false, 'and the revocation does too');
});

test('peer:setShellAllowed(off) DELETES the flag and re-syncs — the sync is what closes open streams', () => {
  const { handler, store, calls } = shellAllowedFixture();
  handler({}, 'a', true);
  const res = handler({}, 'a', false);
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual('shellAllowed' in store.peers[0], false, 'revoked records carry no leftover flag');
  assert.strictEqual(calls.sync, 2, 'revocation syncs too — without it the shells stay served');
  assert.match(calls.log.at(-1)[1], /terminal sharing revoked/, 'the revocation is in the ops log too');
});

// A grant on one peer is box-wide in effect (the cap is a server capability, not
// a per-caller one) — but the RECORD is still per-peer, and a setter that wrote
// the flag onto the wrong record, or onto all of them, would leave the operator
// unable to revoke the one they meant.
test('the grant lands on the addressed record only', () => {
  const peers = [{ id: 'a', label: 'A', url: 'http://a' }, { id: 'b', label: 'B', url: 'http://b' }];
  const { handler, store } = shellAllowedFixture(peers);
  handler({}, 'b', true);
  assert.deepStrictEqual(
    store.peers.map((p) => [p.id, !!p.shellAllowed]),
    [['a', false], ['b', true]],
    'only b granted',
  );
});

test('peer:setShellAllowed on an unknown id changes nothing and never syncs', () => {
  const { handler, calls } = shellAllowedFixture();
  const res = handler({}, 'nope', true);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(calls.set.length, 0, 'nothing persisted');
  assert.strictEqual(calls.sync, 0, 'no re-derive on a write that did not happen');
  assert.deepStrictEqual(calls.broadcast, [], 'and no window was told about a change that did not happen');
});

// Every window, not only the one holding the popover. The grant is box-wide in
// effect, and the header chip is a standing statement that it is on — a window
// that missed the change goes on saying "off" over a box that serves shells.
// Payload-free by design: the renderer re-reads settings, so the chip has one
// derivation rather than a delta that can drift out of step.
//
// The `sync:0` tag pins that the broadcast precedes syncRemoteServer, matching
// peer:setDisabled, whose comment states the ordering is required there. Here
// it is DEFENSIVE, not measured: the renderer re-reads settings, which are
// already written above, so either order paints the same chip today. Recorded
// as such rather than dressed up — a claim that the order matters would be a
// claim about code that does not depend on it.
test('the grant change is announced to every window, before the re-derive', () => {
  const { handler, calls } = shellAllowedFixture();
  handler({}, 'a', true);
  assert.deepStrictEqual(calls.broadcast, [['peer-shell-allowed', 'sync:0']],
    'broadcast once, with no payload, and BEFORE syncRemoteServer ran');
  handler({}, 'a', false);
  assert.deepStrictEqual(calls.broadcast.map((b) => b[0]), ['peer-shell-allowed', 'peer-shell-allowed'],
    'the revocation is announced too — a chip stuck ON is the dangerous direction');
});

// --- the serving side of the off switch -------------------------------------
// setWtermCallbacks is what syncRemoteServer above reaches. Its comment says the
// ordering is the whole point, and a mutation run proved that claim was pinned
// by nothing: swapping the two lines left every test green. These three pin it.

const WTERM_CBS = {
  wtermOpen: () => ({ ok: true }),
  wtermInput: () => ({ ok: true }),
  wtermResize: () => ({ ok: true }),
  wtermClose: () => ({ ok: true }),
};

// A stream stand-in that records the exact order of writes against the moment
// the handlers were nulled — which is the only way to see the reversed order,
// since both orderings end with the same closed stream and the same null field.
function servingFixture() {
  const server = new RemoteServer({
    port: 0,
    pagePath: '/nonexistent',
    getSessions: () => [],
    getTranscript: () => ({ ok: true, messages: [] }),
    send: () => ({ ok: true }),
    ...WTERM_CBS,
  });
  const events = [];
  const res = {
    write: (frame) => {
      // What the handler state was AT THE MOMENT this stream was written to.
      events.push({ frame, openLive: !!server._wtermOpen });
    },
    end: () => {},
  };
  server._wterm.set('bob', new Set([res]));
  return { server, events };
}

test('revoking the callbacks closes open streams with a REASON', () => {
  const { server, events } = servingFixture();
  assert.strictEqual(server._wtermOpen, WTERM_CBS.wtermOpen, 'ENTER: the grant was live');
  server.setWtermCallbacks(null);
  assert.strictEqual(events.length, 1, 'ENTER: the open stream was written to');
  assert.match(events[0].frame, /^event: closed\n/, 'a close frame, not a silent drop');
  assert.match(events[0].frame, /"reason":"revoked"/, 'and it says why — not a dropped tunnel');
  assert.strictEqual(server._wtermOpen, null, 'the handlers are gone afterwards');
  assert.strictEqual(server._wterm.size, 0, 'and no stream entry is left behind');
});

// remote-wiring's no-grant return is a truthy object of four nulls, and only a
// ternary at the call site converts it to `null`. The setter must not depend on
// that: this passes the all-null bundle DIRECTLY, the way a future caller that
// drops the ternary would.
test('an all-null bundle IS a withdrawal — the setter does not rely on its caller', () => {
  const { server, events } = servingFixture();
  const allNull = { wtermOpen: null, wtermInput: null, wtermResize: null, wtermClose: null };
  assert.ok(allNull, 'ENTER: the bundle is truthy — that is the whole trap');
  server.setWtermCallbacks(allNull);
  assert.strictEqual(events.length, 1, 'the open stream was closed, not silently orphaned');
  assert.match(events[0].frame, /"reason":"revoked"/, 'and told why');
  assert.strictEqual(events[0].openLive, true, 'with the ordering still right');
  assert.strictEqual(server._wtermOpen, null, 'handlers withdrawn');
});

// The mutation that survived: `this._wtermOpen = …` moved above the
// dropAllWterm call. Both orderings end with a closed stream and a null
// handler, so only the state DURING the close tells them apart.
test('the streams close while the handlers are still live, never after', () => {
  const { server, events } = servingFixture();
  server.setWtermCallbacks(null);
  assert.strictEqual(events.length, 1, 'ENTER: the close actually happened');
  assert.strictEqual(events[0].openLive, true,
    'the close ran BEFORE the handlers were nulled — reversed, there is a window in '
    + 'which the capability is gone and a live shell stream is still writing');
});

test('re-applying the callbacks does not close anything — only withdrawal does', () => {
  const { server, events } = servingFixture();
  server.setWtermCallbacks({ ...WTERM_CBS });
  assert.deepStrictEqual(events, [], 'a reconcile that keeps the grant is not a revocation');
  assert.strictEqual(server._wterm.size, 1, 'ENTER: the stream is still open to be closed');
  server.setWtermCallbacks(null);
  assert.strictEqual(events.length, 1, 'and withdrawal still closes it');
});

// --- peer-wiring harness. Unlike peer-disable's, this one lets the REAL
// PeerManager be constructed so we can reach the emit fan-out the connections
// actually call; the tunnel manager stays stubbed (nothing here dials).
function makeEmit({ logThrows = false } = {}) {
  const logged = [];
  const broadcast = [];
  let pm = null;
  const uiSettings = { get: () => ({ peers: [] }), set: () => {} };
  const wiring = createPeerWiring({
    manager: { _broadcast: (...a) => broadcast.push(a), _deliverClaimedDms() {} },
    log: {
      info: (...a) => { logged.push(a); if (logThrows) throw new Error('log sink is down'); },
      error() {},
    },
    SELF_LABEL: 'self',
    scheduleAppMenuRefresh: () => {},
    getUiSettings: () => uiSettings,
    getPeerManager: () => pm, setPeerManager: (v) => { pm = v; },
    getTunnelManager: () => ({ sync() {}, urlFor: () => null, statuses: () => [] }),
    setTunnelManager: () => {},
  });
  wiring.syncPeerManager();
  assert.ok(pm && typeof pm._emit === 'function', 'ENTER: the real PeerManager was constructed');
  return { emit: pm._emit, logged, broadcast };
}

test('peer-wterm-closed reaches the renderer AND leaves an ops row naming the seat and the reason', () => {
  const { emit, logged, broadcast } = makeEmit();
  emit('peer-wterm-closed', 'p1', 'bob', "terminal sharing was turned off on 'thinkpad'.");
  assert.deepStrictEqual(
    broadcast.at(-1),
    ['peer-wterm-closed', 'p1', 'bob', "terminal sharing was turned off on 'thinkpad'."],
    'ENTER: the event still fans out to the windows — the log is in addition, not instead',
  );
  const row = logged.at(-1);
  assert.deepStrictEqual(row[0], 'peer', 'filed under the peer channel');
  assert.match(row[1], /terminal bob@p1 closed/, 'names which shell on which box');
  assert.match(row[1], /turned off on 'thinkpad'/, 'and carries the reason through');
});

// The ops rows are wrapped in a try/catch whose comment says logging never
// breaks the emit fan-out. That is only true if the broadcast happens FIRST —
// pinned by asserting the renderer still got its event from a throwing log.
test('a throwing logger cannot break the emit fan-out', () => {
  const { emit, logged, broadcast } = makeEmit({ logThrows: true });
  assert.doesNotThrow(() => emit('peer-wterm-closed', 'p1', 'bob', 'why'),
    'the emit survives a log sink that is down');
  assert.strictEqual(logged.length, 1, 'ENTER: the throwing log path really ran');
  assert.deepStrictEqual(broadcast.at(-1), ['peer-wterm-closed', 'p1', 'bob', 'why'],
    'the renderer got its event — the broadcast precedes the logging, not the reverse');
});

// Only the ENDING is logged on this end, and only for the terminal. A row per
// output frame would bury the ops log; a row for an open would duplicate what
// the serving box already records at the site that actually spawned the shell.
test('the consumer logs the terminal ENDING only — not its replay, data or exit frames', () => {
  const { emit, logged, broadcast } = makeEmit();
  const before = logged.length;
  emit('peer-wterm-replay', 'p1', 'bob', { data: Buffer.from('x'), cols: 80, rows: 24 });
  emit('peer-wterm-data', 'p1', 'bob', Buffer.from('ls\r'));
  emit('peer-wterm-exit', 'p1', 'bob', 0);
  assert.strictEqual(broadcast.length, 3, 'ENTER: all three frames DID reach the fan-out');
  assert.strictEqual(logged.length, before, 'and none of them wrote an ops row');
  emit('peer-wterm-closed', 'p1', 'bob', 'why');
  assert.strictEqual(logged.length, before + 1, 'only the ending does');
});
