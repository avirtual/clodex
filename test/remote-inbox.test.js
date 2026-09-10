'use strict';
// remote-inbox.test.js — the operator Inbox over the phone-access server (t806):
// five /api/inbox routes, the `inbox` cap in hello, and the `inbox` SSE event.
// Real HTTP against a port-0 RemoteServer, the remote-progress.test.js harness.
//
// The store is a HAND-ROLLED fake rather than a real initStores(): these tests
// are about the wire, and the real store's own onChange payloads are pinned in
// test/notification-page.test.js against the real file. The fake mirrors the
// contract remote.js relies on — page/unreadCount/markRead/markAllRead/remove/
// list, and an onChange that fires after each mutation.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { RemoteServer } = require('../remote');

const PAGE = path.join(__dirname, '..', 'renderer', 'remote.html');

const mkNote = (id, createdAt, readAt = null) =>
  ({ id, from: 'agent-a', workspaceId: null, body: `body-${id}`, createdAt, readAt });

function fakeStore(initial = []) {
  const notes = initial.slice();
  const listeners = [];
  const store = {
    _emit(p) { for (const fn of listeners) fn(p); },
    onChange(fn) { listeners.push(fn); },
    list() { return notes.slice(); },
    unreadCount() { return notes.filter((n) => n.readAt == null).length; },
    page({ limit = 30, before = null } = {}) {
      const raw = limit == null ? NaN : Number(limit);
      const n = Number.isFinite(raw) ? Math.max(1, Math.min(200, Math.floor(raw))) : 30;
      const cut = Number.isFinite(before);
      const kept = notes.filter((r) => !cut || r.createdAt < before)
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt);
      return { items: kept.slice(0, n), hasMore: kept.length > n };
    },
    add(rec) {
      notes.push(rec);
      store._emit({ kind: 'added', id: rec.id, unread: store.unreadCount(), note: rec });
      return rec;
    },
    markRead(id) {
      const rec = notes.find((n) => n.id === id);
      if (!rec) return false;
      if (rec.readAt == null) {
        rec.readAt = 5150;
        store._emit({ kind: 'read', id, unread: store.unreadCount() });
      }
      return true;
    },
    markAllRead() {
      let count = 0;
      for (const n of notes) { if (n.readAt == null) { n.readAt = 6000; count++; } }
      if (count) store._emit({ kind: 'read-all', unread: store.unreadCount() });
      return count;
    },
    remove(id) {
      const i = notes.findIndex((n) => n.id === id);
      if (i < 0) return false;
      notes.splice(i, 1);
      store._emit({ kind: 'removed', id, unread: store.unreadCount() });
      return true;
    },
  };
  return store;
}

async function withServer(notifications, fn) {
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: PAGE,
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    notifications,
  });
  await server.start();
  // The wiring remote-wiring.js performs: the STORE drives the SSE frame, so a
  // change made anywhere — including from outside this server — broadcasts.
  if (notifications) notifications.onChange((p) => server.notifyInbox(p));
  try { return await fn(server); } finally { server.stop(); }
}

function req(server, method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: server.port, path: p, method }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* leave null; the test asserts on it */ }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

// Opens the SSE stream, runs `emit` once the connection is live, and resolves
// with everything that arrived after it.
function collect(server, emit) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: server.port, path: '/api/events' }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        if (!buf.includes('\n\n')) return;
        if (!r._emitted) { r._emitted = true; emit(); return; }
        r.destroy();
        resolve(buf);
      });
    });
    r.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    r.end();
  });
}

// ── list ────────────────────────────────────────────────────────────────────

test('GET /api/inbox returns notes newest-first with an unread count of the unread ones only', async () => {
  const store = fakeStore([mkNote('a', 100), mkNote('b', 200, 9), mkNote('c', 300)]);
  await withServer(store, async (server) => {
    const { status, json } = await req(server, 'GET', '/api/inbox');
    assert.strictEqual(status, 200);
    assert.strictEqual(json.ok, true);
    assert.deepStrictEqual(json.notes.map((n) => n.id), ['c', 'b', 'a'], 'newest first');
    // ENTER: 'b' carries a readAt, so a count of 3 would mean the route counted
    // rows rather than unread rows — the badge's whole meaning.
    assert.strictEqual(json.unread, 2);
    assert.deepStrictEqual(json.notes[2], mkNote('a', 100), 'the note shape is the stored one, unchanged');
  });
});

test('GET /api/inbox?before= pages strictly older notes', async () => {
  const store = fakeStore([mkNote('a', 100), mkNote('b', 200), mkNote('c', 300)]);
  await withServer(store, async (server) => {
    const { json } = await req(server, 'GET', '/api/inbox?before=300');
    assert.deepStrictEqual(json.notes.map((n) => n.id), ['b', 'a'], 'before is exclusive');
    const first = await req(server, 'GET', '/api/inbox?limit=1');
    assert.deepStrictEqual(first.json.notes.map((n) => n.id), ['c']);
  });
});

test('GET /api/inbox clamps limit to 200 and floors it at 1; a junk limit falls back to 50', async () => {
  const many = [];
  for (let i = 1; i <= 250; i++) many.push(mkNote(`n${i}`, i));
  await withServer(fakeStore(many), async (server) => {
    const big = await req(server, 'GET', '/api/inbox?limit=9999');
    assert.strictEqual(big.json.notes.length, 200, 'clamped at the 200 ceiling');
    const zero = await req(server, 'GET', '/api/inbox?limit=0');
    assert.strictEqual(zero.json.notes.length, 1, 'floored at 1, never an empty page');
    const junk = await req(server, 'GET', '/api/inbox?limit=banana');
    assert.strictEqual(junk.json.notes.length, 50, 'the default is 50, not the store default 30');
  });
});

test('GET /api/inbox/unread answers the count alone', async () => {
  const store = fakeStore([mkNote('a', 100), mkNote('b', 200, 9)]);
  await withServer(store, async (server) => {
    const { status, json } = await req(server, 'GET', '/api/inbox/unread');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json, { ok: true, unread: 1 });
  });
});

// ── mutations ───────────────────────────────────────────────────────────────

test('POST /api/inbox/read/:id is idempotent and keeps the ORIGINAL readAt; unknown is 404', async () => {
  const store = fakeStore([mkNote('a', 100)]);
  await withServer(store, async (server) => {
    const first = await req(server, 'POST', '/api/inbox/read/a');
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.json.ok, true);
    assert.strictEqual(first.json.id, 'a');
    assert.strictEqual(typeof first.json.readAt, 'number');
    const again = await req(server, 'POST', '/api/inbox/read/a');
    assert.strictEqual(again.status, 200);
    // ENTER: a re-read that reported Date.now() would move a timestamp the phone
    // already rendered, which is exactly what "idempotent" has to exclude here.
    assert.strictEqual(again.json.readAt, first.json.readAt, 'the same readAt, not a fresh stamp');
    const missing = await req(server, 'POST', '/api/inbox/read/nope');
    assert.strictEqual(missing.status, 404);
    assert.deepStrictEqual(missing.json, { ok: false, error: 'unknown note' });
  });
});

test('POST /api/inbox/read-all reports how many it marked', async () => {
  const store = fakeStore([mkNote('a', 100), mkNote('b', 200, 9), mkNote('c', 300)]);
  await withServer(store, async (server) => {
    const { status, json } = await req(server, 'POST', '/api/inbox/read-all');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json, { ok: true, marked: 2 }, 'the already-read one is not counted');
    const again = await req(server, 'POST', '/api/inbox/read-all');
    assert.deepStrictEqual(again.json, { ok: true, marked: 0 });
  });
});

test('POST /api/inbox/remove/:id removes once, then 404s', async () => {
  const store = fakeStore([mkNote('a', 100)]);
  await withServer(store, async (server) => {
    const gone = await req(server, 'POST', '/api/inbox/remove/a');
    assert.strictEqual(gone.status, 200);
    assert.deepStrictEqual(gone.json, { ok: true, id: 'a' });
    assert.deepStrictEqual(store.list(), [], 'it really left the store');
    const again = await req(server, 'POST', '/api/inbox/remove/a');
    assert.strictEqual(again.status, 404);
    assert.deepStrictEqual(again.json, { ok: false, error: 'unknown note' });
  });
});

// ── SSE ─────────────────────────────────────────────────────────────────────

test('a note added from OUTSIDE the server (the desktop path) reaches the phone as inbox/added', async () => {
  const store = fakeStore([]);
  await withServer(store, async (server) => {
    const frames = await collect(server, () => store.add(mkNote('a', 100)));
    // ENTER-anchor the frame before asserting on its contents: without this a
    // regression that stopped broadcasting entirely would fall through to
    // doesNotMatch-style checks that a missing frame satisfies.
    const m = /event: inbox\ndata: (\{.*\})\n\n/.exec(frames);
    assert.ok(m, `an inbox frame arrived: ${JSON.stringify(frames)}`);
    const d = JSON.parse(m[1]);
    assert.strictEqual(d.kind, 'added');
    assert.strictEqual(d.unread, 1);
    assert.deepStrictEqual(d.note, mkNote('a', 100), 'added carries the full note, so no refetch is needed');
  });
});

test('a phone-side POST read yields exactly one inbox/read frame carrying id and unread', async () => {
  const store = fakeStore([mkNote('a', 100), mkNote('b', 200)]);
  await withServer(store, async (server) => {
    const frames = await collect(server, () => { req(server, 'POST', '/api/inbox/read/a'); });
    const all = [...frames.matchAll(/event: inbox\ndata: (\{.*\})\n\n/g)].map((m) => JSON.parse(m[1]));
    assert.strictEqual(all.length, 1, `exactly one frame, not a route+store double: ${JSON.stringify(frames)}`);
    assert.deepStrictEqual(all[0], { kind: 'read', id: 'a', unread: 1 });
  });
});

// ── capability + the no-store box ───────────────────────────────────────────

test("hello advertises 'inbox' with the store injected and omits it without", async () => {
  await withServer(fakeStore([]), async (server) => {
    const { json } = await req(server, 'GET', '/api/peer/hello');
    assert.ok(Array.isArray(json.caps), 'caps is the string array, not a capabilities object');
    assert.ok(json.caps.includes('inbox'), `caps names inbox: ${json.caps}`);
  });
  await withServer(null, async (server) => {
    const { json } = await req(server, 'GET', '/api/peer/hello');
    assert.ok(!json.caps.includes('inbox'), `an inbox-less box does not advertise it: ${json.caps}`);
    assert.ok(json.caps.includes('transcript'), 'and still advertises what it does have');
  });
});

test('with no store injected every /api/inbox route answers 501', async () => {
  await withServer(null, async (server) => {
    for (const [method, p] of [
      ['GET', '/api/inbox'],
      ['GET', '/api/inbox/unread'],
      ['POST', '/api/inbox/read/a'],
      ['POST', '/api/inbox/read-all'],
      ['POST', '/api/inbox/remove/a'],
    ]) {
      const { status, json } = await req(server, method, p);
      assert.strictEqual(status, 501, `${method} ${p} 501s`);
      assert.deepStrictEqual(json, { ok: false, error: 'inbox not available' }, `${method} ${p} body`);
    }
  });
});
