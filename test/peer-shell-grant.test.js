'use strict';

// The peer-terminal GRANT and its ops-log ending — the node-testable pieces of
// the feature's operator-visibility surface. (The chip, the toast and the
// checkbox cannot be CLICKED here; §4 pins that they exist and are wired, which
// is the failure a move actually causes.)
//
//   1. ipc `peer:setShellAllowed`: writes the box-wide serving setting AND
//      calls syncRemoteServer. The sync is not bookkeeping — remote-wiring
//      re-derives the wterm callbacks from it, and dropping them runs
//      dropAllWterm BEFORE the handlers go null. A handler that persisted
//      without syncing would revoke on paper while a live shell kept serving
//      until the next restart.
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
function shellAllowedFixture(initial) {
  const handlers = new Map();
  const store = { peerShellEnabled: false, peers: [{ id: 'a', label: 'Thinkpad', url: 'http://a' }], ...initial };
  const calls = { set: [], sync: 0, log: [], broadcast: [] };
  const { registerIpcHandlers } = require('../ipc-handlers');
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    uiSettings: {
      get: () => store,
      set: (patch) => { calls.set.push(patch); Object.assign(store, patch); return store; },
    },
    // Only `settings:get` needs these, and only to be callable — the values are
    // never asserted here.
    agentDefaults: { getDefaultDeny: () => [] },
    syncRemoteServer: () => { calls.sync += 1; },
    // The grant is box-wide but the toggle lives in one window's popover, so
    // the other windows learn about it here. Recorded with the ORDER against
    // sync, which is why `sync` is a counter and this is a list.
    manager: { _broadcast: (ch, ...args) => calls.broadcast.push([ch, ...args, `sync:${calls.sync}`]) },
    log: { info: (...a) => calls.log.push(a), error() {} },
  });
  return { handler: handlers.get('peer:setShellAllowed'), handlers, store, calls };
}

// THE IPC PROJECTION. `settings:get` builds an explicit whitelist object rather
// than spreading the settings, so a serving-side key the renderer reads has to
// be named there or it arrives `undefined` — and `!!undefined` is a perfectly
// ordinary "off" at every consumer. That shipped once on this very key: the
// store had it, the renderer read it, and nothing in between carried it, so the
// chip stayed hidden on a serving box and Prefs painted the switch unticked.
//
// Driven through the HANDLER, not by grepping the source: the store tests go
// straight to uiSettings and the renderer checks read source text, so this
// crossing is the one place neither of them looks.
test('settings:get carries the peer-shell grant to the renderer', () => {
  const { handlers } = shellAllowedFixture({ peerShellEnabled: true, peers: [] });
  const get = handlers.get('settings:get');
  assert.strictEqual(typeof get, 'function', 'ENTER: settings:get is registered');
  const s = get({});
  assert.strictEqual(s.remoteEnabled, undefined,
    'ENTER: this stub store has no remoteEnabled, so a passing assertion below is not a spread');
  assert.strictEqual(s.peerShellEnabled, true,
    'the renderer can see the grant — omitted, it reads as undefined and every surface says "off"');
});

test('settings:get reports a revoked grant as false, not as absent', () => {
  const { handlers } = shellAllowedFixture({ peerShellEnabled: false });
  const s = handlers.get('settings:get')({});
  assert.strictEqual('peerShellEnabled' in s, true, 'the key is projected in BOTH states');
  assert.strictEqual(s.peerShellEnabled, false);
});

// The write and the read are separate seams, and the failure that shipped was a
// working write with no read. Round-trip them through the two handlers.
test('the grant the setter writes is the grant settings:get hands back', () => {
  const { handler, handlers } = shellAllowedFixture();
  assert.strictEqual(handlers.get('settings:get')({}).peerShellEnabled, false, 'ENTER: off to begin with');
  handler({}, true);
  assert.strictEqual(handlers.get('settings:get')({}).peerShellEnabled, true,
    'the toggle is visible to the window that has to draw the indicator');
  handler({}, false);
  assert.strictEqual(handlers.get('settings:get')({}).peerShellEnabled, false);
});

test('peer:setShellAllowed(on) records the grant and re-syncs the remote server', () => {
  const { handler, store, calls } = shellAllowedFixture();
  assert.strictEqual(typeof handler, 'function', 'ENTER: peer:setShellAllowed handler registered');
  const res = handler({}, true);
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual(store.peerShellEnabled, true, 'the serving setting carries the grant');
  assert.deepStrictEqual(calls.set, [{ peerShellEnabled: true }],
    'persisted once, and as the top-level setting — not onto a peer record');
  assert.strictEqual(calls.sync, 1, 'syncRemoteServer ran — the callbacks are re-derived from settings');
  assert.match(calls.log.at(-1)[1], /terminal sharing ENABLED/, 'the ops log records it');
});

// The setter is UNGATED (it writes a setting on this box) but its effect is a
// capability on the wire, and the only thing joining the two is that
// shellCapGranted reads the field this handler writes. Asserting the boolean
// alone would stay green if the handler wrote `shellEnabled` or `'true'`.
test('the field the handler writes is the field the cap leaf reads', () => {
  const { handler, store } = shellAllowedFixture();
  assert.strictEqual(shellCapGranted(store), false, 'ENTER: no grant before the click');
  handler({}, true);
  assert.strictEqual(shellCapGranted(store), true, 'the grant reaches the cap decision');
  handler({}, false);
  assert.strictEqual(shellCapGranted(store), false, 'and the revocation does too');
});

// The whole reason for the move: the grant has to be reachable on a box with no
// outbound peers at all, which is what a serving-only deployment looks like.
// The old shape computed `.some()` over an empty array and could never be true.
test('a box with NO peer records can still grant — the defect t239 fixed', () => {
  const { handler, store } = shellAllowedFixture({ peers: [] });
  assert.deepStrictEqual(store.peers, [], 'ENTER: nothing to dial out to, the serving-only case');
  assert.deepStrictEqual(handler({}, true), { ok: true }, 'no peer id needed, and no record to reject it');
  assert.strictEqual(shellCapGranted(store), true, 'the box serves — under the old per-record shape it could not');
});

test('peer:setShellAllowed(off) writes false and re-syncs — the sync is what closes open streams', () => {
  const { handler, store, calls } = shellAllowedFixture();
  handler({}, true);
  const res = handler({}, false);
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual(store.peerShellEnabled, false, 'the box stops serving');
  assert.strictEqual(calls.sync, 2, 'revocation syncs too — without it the shells stay served');
  assert.match(calls.log.at(-1)[1], /terminal sharing revoked/, 'the revocation is in the ops log too');
});

// The handler is the ONE writer of this key, so a non-boolean reaching the
// store from a renderer that passed something odd would make the grant depend
// on truthiness at every reader instead of at this one point.
test('the persisted value is a boolean, whatever the caller passed', () => {
  const { handler, store, calls } = shellAllowedFixture();
  handler({}, 'yes');
  assert.strictEqual(store.peerShellEnabled, true, 'coerced, not stored raw');
  assert.deepStrictEqual(calls.set.at(-1), { peerShellEnabled: true });
  handler({}, undefined);
  assert.strictEqual(store.peerShellEnabled, false);
});

// It takes no id, and it must not start taking one back: a stray first argument
// is the grant value under the OLD signature, so a handler that still read
// `(_e, id, on)` would silently treat a peer id as the boolean and turn sharing
// ON for every call.
test('the setter takes no peer id — the box-wide switch is the whole argument list', () => {
  const { handler, store } = shellAllowedFixture();
  handler({}, false, true);
  assert.strictEqual(store.peerShellEnabled, false,
    'the FIRST argument is the switch; a trailing one is ignored, not obeyed');
});

// Every window, not only the one holding the prefs dialog. The header chip is a
// standing statement that the grant is on — a window that missed the change
// goes on saying "off" over a box that serves shells.
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
  handler({}, true);
  assert.deepStrictEqual(calls.broadcast, [['peer-shell-allowed', 'sync:0']],
    'broadcast once, with no payload, and BEFORE syncRemoteServer ran');
  handler({}, false);
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

// --- the operator-visible surface, statically ------------------------------
// None of it can be clicked from node. What CAN be checked is that the four
// properties the ruling names still have somewhere to live — and a move is
// exactly the change that quietly drops one. Each of these went missing at
// least once while t239 was being written.

const RENDERER_DIR = require('node:path').join(__dirname, '..', 'renderer');
const readRenderer = (f) => require('node:fs').readFileSync(require('node:path').join(RENDERER_DIR, f), 'utf8');

test('the ON indicator is visible WITHOUT opening a dialog', () => {
  const html = readRenderer('index.html');
  // Both anchors, checked BEFORE the slice: a missing END gives `slice(N, -1)`
  // — the whole tail of index.html — and the positive match below then finds
  // the chip anywhere in the file, which is the one thing this test claims it
  // does not do.
  assert.ok(html.indexOf('<div id="sidebar-filterbar"') > html.indexOf('<div id="sidebar-header"'),
    'ENTER: both anchors, in order');
  const header = html.slice(html.indexOf('<div id="sidebar-header"'), html.indexOf('<div id="sidebar-filterbar"'));
  assert.ok(header.length > 0, 'ENTER: the sidebar header markup was found');
  assert.match(header, /id="shell-share-chip"/,
    'the chip lives in the always-on-screen sidebar header, not inside a dialog or a popover');
  // Not on the peer rows any more: box-wide, and a serving-only box has none.
  assert.doesNotMatch(readRenderer('peers-ui.js'), /peer-shell-chip"/,
    'the per-row chip is gone — one home for a box-wide flag');
  assert.match(readRenderer('peers-ui.js'), /shell-share-chip/,
    'and peers-ui drives the header one instead');
});

test('the checkbox lives with the other box-wide serving settings', () => {
  const html = readRenderer('index.html');
  // The existing ENTER below does not carry this: `prefs-remote-enabled` lives
  // elsewhere in index.html, so it still passes when a missing END anchor turns
  // the slice into the whole tail and the match finds the control anywhere.
  assert.ok(html.indexOf('data-group="discovery"') > html.indexOf('data-group="phone"'),
    'ENTER: both anchors, in order');
  const phone = html.slice(html.indexOf('data-group="phone"'), html.indexOf('data-group="discovery"'));
  assert.ok(phone.includes('prefs-remote-enabled'), 'ENTER: this really is the serving group');
  assert.match(phone, /id="prefs-peer-shell"/, 'the grant is a prefs control now');
  assert.doesNotMatch(html, /id="peer-info-shell"/, 'and no longer a per-peer popover row');
});

// The toast has to name the exposure in plain words, and the checkbox has to
// apply through the IPC — a version that only rode the prefs Save batch would
// write the setting without the sync that closes live shells.
test('the toggle applies through the IPC and says what it exposes', () => {
  const js = readRenderer('renderer.js');
  assert.match(js, /prefsPeerShell\.addEventListener\('change'/,
    'applied on change, not batched into Save — Save does not run syncRemoteServer');
  assert.match(js, /window\.api\.peerSetShellAllowed\(on\)/, 'through the dedicated handler');
  assert.doesNotMatch(js, /peerShellEnabled:\s*prefsPeerShell/,
    'and NOT also written by the setSettings batch, which would be a second door');
  assert.match(js, /can open a shell here/, 'the warm toast names the exposure in plain words');
  assert.match(js, /open remote shells were closed/, 'and the revocation says what it ended');
  // A swallowed rejection under an unconditional toast tells the operator a
  // revocation happened while the box is still serving — the worst sentence
  // this feature can print.
  assert.match(js, /res\.ok !== true/, 'success is claimed only on ok === true');
  assert.match(js, /STILL serving shells/, 'and a failed revocation says the box is still serving');
});

// The chip is a standing statement, so every window has to re-derive it when
// another window flips the switch.
test('every window re-reads the grant when it changes', () => {
  assert.match(readRenderer('peers-ui.js'), /onPeerShellAllowed\(\(\) => \{ refreshShellAllowed\(\)/,
    'the broadcast the handler sends is what repaints a window that did not toggle it');
  // The chip self-heals on that broadcast; an OPEN Prefs dialog does not, and a
  // stale checkbox is a switch that re-sends the value already set instead of
  // the revocation the operator meant.
  assert.match(readRenderer('renderer.js'), /onPeerShellAllowed\(async \(\) => \{/,
    'the prefs checkbox subscribes too');
});
