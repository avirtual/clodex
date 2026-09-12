'use strict';
// peer-inbox-claim.test.js — a note raised by a seat INSIDE a sandbox box has to
// reach the desktop operator, and the box is the wrong place for it to sit.
//
// THE DEFECT THIS CLOSES. A box seat runs the same session-manager as the
// desktop, so its `[agent:notify-user]` stores the note in the BOX's own
// notifications.json and the box broadcasts an `inbox` SSE event. Nobody reads a
// box inbox — it is headless, and the desktop's PeerConnection handled only
// `sessions`, `activity` and `dm-mail` on that feed. The note was dropped on the
// floor. A dm from the box already crosses the same wire by CLAIM; notes now get
// that shape.
//
// WHAT IS PINNED, over a real socket:
//   1. an `inbox` doorbell on a CLAIM-MARKED connection emits `peer-inbox` once
//      and then removes each note from the box, EMIT FIRST — the desktop store
//      write happens inside the emit, so a crash between the two duplicates a
//      note rather than losing one,
//   2. the same doorbell on an UNMARKED connection claims nothing and does not
//      even ask — the anti-degenerate half, without which "always claim" passes
//      1 and quietly drains a laptop peer's inbox into its neighbour's,
//   3. the mark survives reconciliation: a `inbox: 'claim'` row builds a marked
//      connection, and un-marking that row re-creates it (the flag is fixed at
//      construction, so an in-place edit would leave a stale connection),
//   4. peer-wiring routes `peer-inbox` to the session manager and NOT to the
//      renderer fan-out — note bodies are operator mail, not an ipc event,
//   5. sandbox's own peer row carries the mark, on a fresh row AND backfilled
//      onto a row written before this existed (without the backfill every
//      already-registered box stays silent until someone deletes its row),
//   6. OVERLAPPING triggers deliver each note exactly once. The box has no
//      atomic claim — the dm path gets one from the outbox's whole-dir rename,
//      this path has nothing — so two GETs issued before the first claim's
//      removes land both return the same notes, and the operator is told twice.
//      A seat raising two notes in one turn is enough: the box emits one
//      `added` frame per store write.
//
// Hello ALSO claims, so notes raised while the SSE feed was down are drained on
// the next tick. That second trigger is why subject 6 exists: two triggers over
// one un-atomic inbox is a duplicate delivery unless the connection serializes
// them itself.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PeerConnection, PeerManager } = require('../peer-client');
const { createSandbox, SANDBOX_PEER_ID } = require('../sandbox');

const SELF = 'us';

// A box that answers hello, holds /api/events open for the test to write frames
// into, serves its inbox from `state.notes`, and records every remove. The
// removes really splice, so a second claim of an already-drained inbox is empty
// — which is what makes the emit count in subject 1 an assertion and not a race.
function inboxServer() {
  const state = { notes: [], removes: [], inboxGets: 0, sessionGets: 0, streams: [], order: [] };
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/api/peer/hello') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'clodex', host: 'h', caps: [], version: '1' }));
    } else if (p === '/api/sessions') {
      state.sessionGets++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: [] }));
    } else if (p === '/api/inbox') {
      state.inboxGets++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, notes: state.notes.slice(), unread: state.notes.length }));
    } else if (p.startsWith('/api/inbox/remove/')) {
      const id = decodeURIComponent(p.slice('/api/inbox/remove/'.length));
      state.removes.push(id);
      state.order.push(`remove:${id}`);
      state.notes = state.notes.filter((n) => n.id !== id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id }));
    } else if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      state.streams.push(res);
    } else {
      res.writeHead(404).end();
    }
  });
  return { server, state };
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

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

async function withPeer(fn, connOpts = {}, seed = null) {
  const { server, state } = inboxServer();
  const port = await listen(server);
  if (seed) state.notes = seed.map((n) => ({ ...n }));
  const emits = [];
  const conn = new PeerConnection({
    id: 'box', label: 'box', url: `http://127.0.0.1:${port}`, selfLabel: SELF,
    emit: (channel, ...args) => {
      emits.push([channel, ...args]);
      if (channel === 'peer-inbox') state.order.push('emit');
    },
    helloIntervalMs: 60000,
    ...connOpts,
  });
  conn.start();
  try {
    await waitFor('the events stream to open', () => state.streams.length > 0);
    await fn(emits, state, conn);
  } finally {
    conn.stop();
    server.close();
  }
}

const doorbell = (state) =>
  state.streams[0].write('event: inbox\ndata: {"kind":"added","unread":1}\n\n');

const inboxEmits = (emits) => emits.filter((e) => e[0] === 'peer-inbox');

const NOTES = [
  { id: 'n1', from: 'lead', body: 'need a ruling on the merge' },
  { id: 'n2', from: 'hand-9', body: 'blocked on a permission dialog' },
];

// WINDOW: the whole forward path. Against pre-fix code the waitFor times out —
// the `inbox` frame reached an SSE handler that had no arm for it.
test('an inbox doorbell on a claim-marked peer emits the notes ONCE, then removes them — emit first', async () => {
  await withPeer(async (emits, state) => {
    state.notes = NOTES.map((n) => ({ ...n }));
    doorbell(state);
    await waitFor('both notes removed from the box', () => state.removes.length === 2);

    // ENTER: the emit count is read BEFORE the payload. A path that claimed
    // twice for one doorbell would deliver the same note to the operator twice,
    // and an assertion that only looked at emits[0] would call that a pass.
    assert.strictEqual(inboxEmits(emits).length, 1, 'exactly one peer-inbox emit for one doorbell');
    const [, id, notes] = inboxEmits(emits)[0];
    assert.strictEqual(id, 'box');
    assert.deepStrictEqual(notes.map((n) => n.id), ['n1', 'n2']);
    assert.strictEqual(notes[0].body, 'need a ruling on the merge');

    // The emit is what writes the note into the desktop store; the removes are
    // what make it unrecoverable from the box. What this discriminates is an
    // implementation that emits from the removes' CALLBACKS — there the box has
    // already dropped the note when the claim dies mid-flight, and it exists
    // nowhere. (A bare statement swap that still emits in the same synchronous
    // step is NOT distinguishable here, and loses nothing: no socket has been
    // written when the emit runs either way.)
    assert.deepStrictEqual(state.order, ['emit', 'remove:n1', 'remove:n2']);

    assert.deepStrictEqual(state.notes, [], 'the box is drained, so a later claim is a no-op and not a redelivery');
  }, { claimInbox: true });
});

test('the same doorbell on an UNMARKED peer claims nothing — the inbox is never even fetched', async () => {
  await withPeer(async (emits, state) => {
    state.notes = NOTES.map((n) => ({ ...n }));
    doorbell(state);
    // A negative has nothing to wait FOR, so wait on a FOLLOWING frame instead:
    // SSE is ordered on one stream, so a `sessions` frame written after the
    // doorbell cannot be consumed before it. Its refetch is the proof the
    // doorbell was already handled — without this the assertions below would
    // pass on a claim merely still in flight.
    const sessionsBefore = state.sessionGets;
    state.streams[0].write('event: sessions\ndata: {}\n\n');
    await waitFor('the trailing sessions frame to be consumed', () => state.sessionGets > sessionsBefore);

    assert.strictEqual(inboxEmits(emits).length, 0);
    assert.strictEqual(state.inboxGets, 0, 'an unmarked peer never GETs /api/inbox');
    assert.deepStrictEqual(state.removes, []);
    assert.strictEqual(state.notes.length, 2, "the peer's own notes stay its own operator's");
  });
});

test('PeerManager.sync: the claim mark builds a marked connection, and un-marking re-creates it', async () => {
  const emits = [];
  const mgr = new PeerManager({ emit: (...a) => emits.push(a), selfLabel: SELF });
  // A dead port: every hello fails fast on ECONNREFUSED, so no server is needed
  // to pin what reconciliation BUILDS.
  const url = 'http://127.0.0.1:1';
  try {
    mgr.sync([{ id: 'sandbox', label: 'sandbox', url, inbox: 'claim' }]);
    assert.strictEqual(mgr.get('sandbox')._claimInbox, true);

    const first = mgr.get('sandbox');
    mgr.sync([{ id: 'sandbox', label: 'sandbox', url }]);
    // The flag is fixed at construction, so the ONLY honest way to drop it is a
    // fresh connection — and the UI must shed that peer's tabs when it happens.
    assert.ok(emits.some((e) => e[0] === 'peer-removed' && e[1] === 'sandbox'));
    assert.notStrictEqual(mgr.get('sandbox'), first);
    assert.strictEqual(mgr.get('sandbox')._claimInbox, false);
  } finally {
    mgr.stopAll();
  }
});

test('peer-wiring routes a peer-inbox emit to the session manager and never to the renderer', () => {
  const { createPeerWiring } = require('../peer-wiring');
  const peerMod = require('../peer-client');
  const origCtor = peerMod.PeerManager;
  const broadcasts = [];
  const delivered = [];
  let capturedEmit = null;
  peerMod.PeerManager = function (opts) {
    capturedEmit = opts.emit;
    return { sync() {}, statuses: () => [], get: () => null, stopAll() {} };
  };
  let peerManager = null;
  try {
    const store = { peers: [], peerAttached: {}, peerControlled: {}, peerVisible: {} };
    const wiring = createPeerWiring({
      manager: {
        _broadcast: (...a) => broadcasts.push(a),
        _deliverClaimedDms() {},
        _deliverClaimedInbox: (...a) => delivered.push(a),
      },
      log: { info() {}, error() {} },
      SELF_LABEL: SELF,
      scheduleAppMenuRefresh: () => {},
      getUiSettings: () => ({ get: () => store, set: (p) => Object.assign(store, p) }),
      getPeerManager: () => peerManager,
      setPeerManager: (v) => { peerManager = v; },
      getTunnelManager: () => ({ sync() {}, urlFor: () => null, statuses: () => [] }),
      setTunnelManager: () => {},
      getWebTunnelManager: () => null,
      setWebTunnelManager: () => {},
      openExternal: () => {},
    });
    wiring.syncPeerManager();
    assert.strictEqual(typeof capturedEmit, 'function');

    capturedEmit('peer-inbox', 'box', NOTES);
    assert.deepStrictEqual(delivered, [['box', NOTES]]);
    assert.ok(
      !broadcasts.some((b) => b[0] === 'peer-inbox'),
      'note bodies are operator mail — on the generic ipc fan-out they print into every renderer log line',
    );
  } finally {
    peerMod.PeerManager = origCtor;
  }
});

const TMP_REGISTRY = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t840-registry-'));
process.on('exit', () => { try { fs.rmSync(TMP_REGISTRY, { recursive: true, force: true }); } catch {} });

function fakeSettings(initial = {}) {
  let state = { peers: [], ...initial };
  return {
    _state: () => state,
    get() { return { ...state }; },
    set(partial) { state = { ...state, ...partial }; return state; },
  };
}

test("sandbox registerPeer marks its own box inbox: 'claim', on a fresh row and on an older one", () => {
  const fresh = fakeSettings();
  createSandbox({ registryDir: TMP_REGISTRY, getUiSettings: () => fresh, syncPeerManager: () => {} }).registerPeer(7820);
  assert.strictEqual(fresh._state().peers[0].inbox, 'claim');

  // Url and token already match on this row, so the idempotence early-return
  // used to fire before the mark was ever written — every box registered before
  // this feature existed stayed silent forever.
  const old = fakeSettings({ peers: [{ id: SANDBOX_PEER_ID, label: 'sandbox', url: 'http://127.0.0.1:7820' }] });
  let synced = 0;
  createSandbox({ registryDir: TMP_REGISTRY, getUiSettings: () => old, syncPeerManager: () => { synced++; } }).registerPeer(7820);
  assert.strictEqual(old._state().peers[0].inbox, 'claim');
  assert.strictEqual(old._state().peers.length, 1, 'backfilled in place, never duplicated');
  assert.strictEqual(synced, 1, 'the peer manager is told, or the mark takes effect only after a restart');
});

test('two overlapping triggers deliver each note exactly ONCE — no duplicate toast, no double remove', async () => {
  await withPeer(async (emits, state) => {
    // The notes appear only AFTER the startup hello has claimed an empty box.
    // Seeding them before `start()` would let that hello drain them before the
    // frames below ever arrive — no overlap would form and this subject would
    // pass against the unserialized code it exists to red.
    state.notes = NOTES.map((n) => ({ ...n }));
    // Two `added` frames in ONE write: both reach the SSE handler in the same
    // tick, so an unserialized path issues both GETs before either claim's
    // removes have been sent, and both read the same undrained inbox.
    state.streams[0].write(
      'event: inbox\ndata: {"kind":"added","unread":1}\n\n'
      + 'event: inbox\ndata: {"kind":"added","unread":2}\n\n',
    );
    await waitFor('the box to be drained', () => state.notes.length === 0);

    // ENTER: there must be at least one emit — an implementation that claimed
    // NOTHING would satisfy every "exactly once" assertion below vacuously.
    assert.ok(inboxEmits(emits).length >= 1, 'the notes were claimed at all');

    // The operator-facing invariant: flattened across ALL emits, each note
    // appears once. _deliverClaimedInbox stores and toasts per note per emit,
    // so a repeat here is a duplicate row and a duplicate toast in the inbox.
    const seen = inboxEmits(emits).flatMap((e) => e[2].map((n) => n.id));
    assert.deepStrictEqual(seen, ['n1', 'n2'], 'each note delivered exactly once across every claim');
    assert.strictEqual(state.removes.length, 2, 'one remove per note — a repeat claim would 404 a second set');
  }, { claimInbox: true });
});

test('the hello tick claims on its own — a note raised while the SSE feed was down still arrives', async () => {
  await withPeer(async (emits, state) => {
    // No doorbell is ever written here. The ONLY trigger is the hello path, so
    // deleting that call site reds this and nothing else — without it the
    // "drained on the next hello" promise in docs/peering.md is unpinned.
    await waitFor('the seeded note to be claimed', () => inboxEmits(emits).length === 1);
    await waitFor('it to be removed from the box', () => state.removes.length === 1);
    assert.deepStrictEqual(inboxEmits(emits)[0][2].map((n) => n.id), ['n1']);
  }, { claimInbox: true }, [NOTES[0]]);
});
