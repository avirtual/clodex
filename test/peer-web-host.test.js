'use strict';
// peer-web-host.test.js — t30a: a peer's browser frontend is DISCOVERABLE over
// the peering hello, so a consumer can tunnel to it instead of reconstructing
// wire-port+1. Producer side (remote.js `webHost` + the `getWebInfo` seam),
// consumer side (peer-client.js normalization, identityChanged, status), and the
// security boundary: the hello advertises that a token is REQUIRED and NEVER
// what it is.
//
// Real HTTP against port-0 servers throughout — the field is a wire contract,
// so it is asserted on the bytes a consumer actually receives.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const { RemoteServer } = require('../remote');
const { PeerConnection } = require('../peer-client');
const { createWebHost } = require('../web-host');

function minimal(extra) {
  return new RemoteServer({
    port: 0, pagePath: '/nonexistent',
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    hostLabel: 'testhost', version: '0.0.0-test',
    ...extra,
  });
}

// One GET → { status, text, json }. `text` is kept RAW: the token-leak assertion
// searches the bytes on the wire, not a re-serialized object.
function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* asserted by the caller */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

async function withServer(extra, fn) {
  const server = minimal(extra);
  await server.start();
  try { return await fn(server.port, server); } finally { server.stop(); }
}

const hello = (port) => get(port, '/api/peer/hello');

function waitFor(pred, what, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let hit;
      try { hit = pred(); } catch (e) { return reject(e); }
      if (hit) return resolve(hit);
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
      setTimeout(tick, 15);
    };
    tick();
  });
}

// ── producer: the hello carries the web host, or an honest null ──────────────

test('hello carries webHost when the host reports one', async () => {
  await withServer({ getWebInfo: () => ({ port: 8080, tokenGated: false }) }, async (port) => {
    const r = await hello(port);
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.json.webHost, { port: 8080, tokenGated: false });
  });
});

test('no seam (the Electron case): webHost is present and null, never a guessed port', async () => {
  await withServer({}, async (port) => {
    const r = await hello(port);
    assert.equal(r.status, 200);
    // Present-and-null, not absent: a consumer distinguishes "this box says it
    // has no web host" from "this box is too old to say" only if we always
    // answer. And null, not wire-port+1 — the guess this ticket exists to kill.
    assert.ok(Object.prototype.hasOwnProperty.call(r.json, 'webHost'), 'the field is always present');
    assert.strictEqual(r.json.webHost, null);
  });
});

test('a seam reporting null (CLODEX_WEB_PORT unset, or the host failed to start) → webHost null', async () => {
  await withServer({ getWebInfo: () => null }, async (port) => {
    assert.strictEqual((await hello(port)).json.webHost, null);
  });
});

// ── producer: a malformed or throwing seam degrades, never breaks hello ──────

test('a malformed or out-of-range port is refused: webHost null rather than an unreachable port', async () => {
  // Each of these would produce a URL that goes nowhere (or, for a string,
  // silently concatenates into one) if it reached a consumer unchecked.
  const bad = [
    { label: 'zero', info: { port: 0 } },
    { label: 'negative', info: { port: -1 } },
    { label: 'above the port range', info: { port: 65536 } },
    { label: 'non-integer', info: { port: 8080.5 } },
    { label: 'numeric string', info: { port: '8080' } },
    { label: 'NaN', info: { port: NaN } },
    { label: 'missing port', info: { tokenGated: true } },
    { label: 'not an object', info: 8080 },
  ];
  for (const { label, info } of bad) {
    await withServer({ getWebInfo: () => info }, async (port) => {
      const r = await hello(port);
      assert.equal(r.status, 200, `${label}: hello still serves`);
      assert.strictEqual(r.json.webHost, null, `${label} → null`);
    });
  }
  // 65535 is the last valid port and must NOT be swept up by the range check.
  await withServer({ getWebInfo: () => ({ port: 65535 }) }, async (port) => {
    assert.deepStrictEqual((await hello(port)).json.webHost, { port: 65535, tokenGated: false });
  });
});

test('a THROWING seam degrades to null with hello still 200 and identity intact', async () => {
  // Identity is load-bearing for every peer feature (online state, caps, update
  // checks). A web view is not worth taking that down for, so the seam's failure
  // must cost exactly the web field and nothing else.
  await withServer({ getWebInfo: () => { throw new Error('web host exploded'); } }, async (port) => {
    const r = await hello(port);
    assert.equal(r.status, 200, 'hello survives a throwing seam');
    assert.strictEqual(r.json.webHost, null);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.host, 'testhost', 'identity still reported');
    assert.equal(r.json.version, '0.0.0-test');
  });
});

test('tokenGated is always a real boolean: only a literal true is believed', async () => {
  // `=== true`, deliberately, on BOTH sides of the wire. A truthy non-boolean
  // means the seam is confused, and the two failure modes are not symmetric in
  // cost: reading it as false makes the UI offer a plain link that 401s — an
  // honest, visible failure — while reading it as true makes the UI claim a
  // token is needed when none is. Neither leaks anything (the token is never
  // advertised either way), so the tie goes to the strict form, which keeps one
  // coercion rule instead of two.
  for (const gated of ['yes', 'false', 1, {}]) {
    await withServer({ getWebInfo: () => ({ port: 8080, tokenGated: gated }) }, async (port) => {
      const wh = (await hello(port)).json.webHost;
      assert.strictEqual(wh.tokenGated, false, `${JSON.stringify(gated)} is not a boolean true`);
      assert.strictEqual(typeof wh.tokenGated, 'boolean', 'never reaches the wire as a non-boolean');
    });
  }
  await withServer({ getWebInfo: () => ({ port: 8080 }) }, async (port) => {
    assert.strictEqual((await hello(port)).json.webHost.tokenGated, false, 'absent → false, not undefined');
  });
});

// ── the security boundary: locked door yes, key never ────────────────────────

test('SECURITY: a token-gated web host advertises tokenGated:true and the token appears NOWHERE in the hello', async () => {
  // A REAL web host, so `tokenGated` is derived from the fact the host knows
  // about itself (gate.configured) rather than a signal the test invents.
  const SECRET = 'sup3r-s3cret-web-token-do-not-advertise';
  const host = createWebHost({
    engine: { manager: { registerWindow() {}, unregisterWindow() {}, listForWorkspace: () => [] }, stores: {} },
    log: { info() {}, warn() {}, error() {} },
    port: 0, token: SECRET, userDataPath: os.tmpdir(), registerHandlers: () => {},
  });
  if (!host._server.listening) await new Promise((res) => host._server.once('listening', res));
  try {
    await withServer({ getWebInfo: () => host.info }, async (port) => {
      const r = await hello(port);
      assert.equal(r.json.webHost.tokenGated, true, 'a configured token IS advertised as required');
      assert.equal(r.json.webHost.port, host._server.address().port, 'the port actually listened on');
      // THE assertion. hello is unauthenticated on the common loopback-no-token
      // deployment, so shipping a second service's secret through it would be
      // indefensible. This fails the moment anyone adds the token to the body,
      // under any key name — it searches the raw response bytes.
      assert.doesNotMatch(r.text, /sup3r-s3cret-web-token/, 'the web token is not on the wire');
      assert.strictEqual(r.text.includes(SECRET), false, 'not anywhere in the hello body');
      // And the webHost object carries exactly two keys — a future field can't
      // smuggle the secret in past the string search by encoding it.
      assert.deepStrictEqual(Object.keys(r.json.webHost).sort(), ['port', 'tokenGated']);
    });
  } finally { host.close(); }
});

test('an ungated web host reports tokenGated:false (a fact about the host, not a UI guess)', async () => {
  const host = createWebHost({
    engine: { manager: { registerWindow() {}, unregisterWindow() {}, listForWorkspace: () => [] }, stores: {} },
    log: { info() {}, warn() {}, error() {} },
    port: 0, token: null, userDataPath: os.tmpdir(), registerHandlers: () => {},
  });
  if (!host._server.listening) await new Promise((res) => host._server.once('listening', res));
  try {
    await withServer({ getWebInfo: () => host.info }, async (port) => {
      const wh = (await hello(port)).json.webHost;
      assert.equal(wh.tokenGated, false);
      assert.ok(wh.port > 0, 'a port-0 host reports the port it was ASSIGNED, not 0');
    });
  } finally { host.close(); }
});

// ── consumer: normalization, identityChanged, status ─────────────────────────

// A consumer against a server whose reported web host the test can move.
async function withPeer(seed, fn) {
  let info = seed;
  const server = minimal({ getWebInfo: () => info });
  await server.start();
  const states = [];
  const conn = new PeerConnection({
    id: 'pw', label: 'webwatch', url: `http://127.0.0.1:${server.port}`, selfLabel: 'consumer',
    helloIntervalMs: 30,
    emit: (channel, ...args) => { if (channel === 'peer-state') states.push(args[1]); },
  });
  conn.start();
  try {
    return await fn({ conn, states, setInfo: (v) => { info = v; } });
  } finally { conn.stop(); server.stop(); }
}

test('status() exposes the peer\'s web host, so a view reads LIVE state', async () => {
  await withPeer({ port: 8080, tokenGated: true }, async ({ conn }) => {
    await waitFor(() => conn.online, 'online');
    assert.deepStrictEqual(conn.status().webHost, { port: 8080, tokenGated: true });
  });
});

test('status().webHost is null while offline and for a box with no web host', async () => {
  await withPeer(null, async ({ conn }) => {
    // Before the first hello lands there is no identity at all — null, not a throw.
    assert.strictEqual(conn.status().webHost, null, 'null before the first hello');
    await waitFor(() => conn.online, 'online');
    assert.strictEqual(conn.status().webHost, null, 'still null: this box has none');
  });
});

test('a malformed webHost from an old or hostile box is normalized to null on the consumer', async () => {
  // The producer normalizes, but a consumer talks to boxes it did not build.
  // One bad field must not reach the renderer.
  for (const bad of [{ port: 'eighty' }, { port: 0 }, { port: 70000 }, 'nope', 42]) {
    await withPeer(bad, async ({ conn }) => {
      await waitFor(() => conn.online, 'online');
      assert.strictEqual(conn.status().webHost, null, `${JSON.stringify(bad)} → null`);
    });
  }
});

test('identityChanged: a web host APPEARING re-emits peer-state without an offline dip', async () => {
  await withPeer(null, async ({ conn, states, setInfo }) => {
    await waitFor(() => states.find((s) => s.online), 'initial online state');
    const before = states.length;
    setInfo({ port: 8080, tokenGated: false });
    const seen = await waitFor(
      () => states.slice(before).find((s) => s.webHost && s.webHost.port === 8080),
      'peer-state carrying the new web host');
    assert.equal(seen.online, true);
    assert.ok(states.every((s) => s.online === true), 'no offline dip — the box never went away');
  });
});

test('identityChanged: a web host MOVING to another port re-emits (the stale-tunnel case)', async () => {
  // This is the one t30b depends on: a consumer forwarding to the old port would
  // tunnel to nothing — or worse, to whatever took the port.
  await withPeer({ port: 8080, tokenGated: false }, async ({ conn, states, setInfo }) => {
    await waitFor(() => states.find((s) => s.webHost && s.webHost.port === 8080), 'initial web host');
    const before = states.length;
    setInfo({ port: 9090, tokenGated: false });
    const moved = await waitFor(
      () => states.slice(before).find((s) => s.webHost && s.webHost.port === 9090),
      'peer-state carrying the moved port');
    assert.equal(moved.online, true);
  });
});

test('identityChanged: a web host VANISHING re-emits, so no view keeps offering a dead link', async () => {
  await withPeer({ port: 8080, tokenGated: false }, async ({ states, setInfo }) => {
    await waitFor(() => states.find((s) => s.webHost), 'initial web host');
    const before = states.length;
    setInfo(null);
    const gone = await waitFor(
      () => states.slice(before).find((s) => s.online && s.webHost === null),
      'peer-state with the web host gone');
    assert.strictEqual(gone.webHost, null);
  });
});

test('identityChanged: tokenGated flipping re-emits (the UI must stop promising a plain link)', async () => {
  await withPeer({ port: 8080, tokenGated: false }, async ({ states, setInfo }) => {
    await waitFor(() => states.find((s) => s.webHost), 'initial web host');
    const before = states.length;
    setInfo({ port: 8080, tokenGated: true });
    await waitFor(
      () => states.slice(before).find((s) => s.webHost && s.webHost.tokenGated === true),
      'peer-state carrying the gate change');
  });
});

test('a steady web host emits no spurious peer-state across ticks', async () => {
  // identityChanged compares a KEY, not object identity — a fresh {port,tokenGated}
  // object every hello must not read as a change and spam the renderer.
  await withPeer({ port: 8080, tokenGated: true }, async ({ conn, states }) => {
    await waitFor(() => conn.online && conn.status().webHost, 'online with a web host');
    await new Promise((r) => setTimeout(r, 60));
    const settled = states.length;
    await new Promise((r) => setTimeout(r, 200)); // ~6 more hello ticks at 30ms
    assert.equal(states.length, settled, 'not one re-emission from an unchanged web host');
  });
});
