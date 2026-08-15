'use strict';

// The carry-through: a quota block on /_status must reach the payload the
// renderer receives, on the SAME path the rest of the telemetry travels. Driven
// through the real poller against a real HTTP server, because the two things
// that can go wrong here are both wiring — a widened return the poller ignores,
// and a capability gate read off the wrong object.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createProxyPoller } = require('../wirescope-proxy.js');

const silentLog = { info() {}, warn() {}, error() {} };

const QUOTA = {
  age_s: 3.4,
  status: 'allowed_warning',
  representative_window: '7d',
  primary: { window: '7d', used_pct: 95.0, remaining_pct: 5.0, status: 'allowed_warning', resets_in_s: 252486 },
  last_429_age_s: null,
};

const SHAPED = {
  status: 'allowed_warning',
  window: '7d',
  usedPct: 95.0,
  remainingPct: 5.0,
  resetsInS: 252486,
  ageS: 3.4,
  last429AgeS: null,
};

function serveProxy({ quota, capabilities, sessions }) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      res.writeHead(200, { 'content-type': 'application/json' });
      if (url === '/_identity') {
        return res.end(JSON.stringify({ product: 'wirescope', version: 'v0.6.53', capabilities }));
      }
      if (url === '/_status') {
        const body = { proxy: { version: 'v0.6.53' }, sessions };
        if (quota) body.quota = quota;
        return res.end(JSON.stringify(body));
      }
      res.end('{}');
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

// Runs one real tick and returns the payloads the poller sent to the renderer.
async function tickOnce({ quota, capabilities = { stats: true, quota: true }, linked = true }) {
  const sessions = linked
    ? [{ agent: 'clodex-seat-1-abcd', session_id: 's1', model: 'sonnet', last_seen: 1 }]
    : [];
  const { srv, base } = await serveProxy({ quota, capabilities, sessions });
  const emitted = [];
  const manager = {
    sessions: new Map([['seat-1', {
      name: 'seat-1', type: 'claude', agentType: 'claude',
      proxyBase: base, proxyAgent: 'clodex-seat-1-abcd', sessionId: 's1',
    }]]),
    _sendToSession: (name, ch, n2, payload) => emitted.push({ name, ch, payload }),
    _injectText: () => {}, _broadcast: () => {}, _shadowLog: () => {},
  };
  const ProxyPoller = createProxyPoller({
    log: silentLog,
    stripLevelOf: () => null,
    WIRE_TELEMETRY_LIVE: false,
    autoCompactOf: () => false,
    peerProxyView: () => null,
    getPersistence: () => ({ get: () => null }),
    getRemoteServer: () => null,
    getContextCommands: () => ({}),
  });
  const poller = new ProxyPoller(manager);
  try {
    await poller._tick();
  } finally { srv.close(); }
  return emitted;
}

test('poller: the quota block reaches the emitted payload, shaped', async () => {
  const emitted = await tickOnce({ quota: QUOTA });
  assert.strictEqual(emitted.length, 1, 'ENTER: the poller must emit for the seat — zero payloads makes every assertion below vacuous');
  assert.strictEqual(emitted[0].ch, 'session-proxy');
  assert.deepStrictEqual(emitted[0].payload.quota, SHAPED);
});

test('poller: the existing session fields still arrive alongside it', async () => {
  // The widened status() return is the risk: a poller that read the new shape
  // wrong would still deliver quota while quietly losing the record it wraps.
  const emitted = await tickOnce({ quota: QUOTA });
  const p = emitted[0].payload;
  assert.strictEqual(p.linked, true);
  assert.strictEqual(p.sessionId, 's1');
  assert.strictEqual(p.model, 'sonnet');
});

test('poller: no capabilities.quota (older proxy) → no quota on the payload', async () => {
  const emitted = await tickOnce({ quota: QUOTA, capabilities: { stats: true } });
  assert.strictEqual(emitted.length, 1, 'ENTER: the seat must still be polled — the gate is on quota, not on the whole poll');
  assert.strictEqual(emitted[0].payload.quota, null);
  assert.strictEqual(emitted[0].payload.linked, true, 'and the rest of the telemetry is unaffected');
});

test('poller: capability on but the proxy sent no quota block → null', async () => {
  const emitted = await tickOnce({ quota: null });
  assert.strictEqual(emitted[0].payload.quota, null);
});

test('poller: quota rides an UNLINKED payload too — it is the account, not the session', async () => {
  // A seat the proxy has no record for still shows the account's quota; gating
  // it on `linked` would blank the readout for exactly the idle seats an
  // operator is most likely to be looking at when they check.
  const emitted = await tickOnce({ quota: QUOTA, linked: false });
  assert.strictEqual(emitted.length, 1, 'ENTER: an unlinked seat must still emit');
  assert.strictEqual(emitted[0].payload.linked, false);
  assert.deepStrictEqual(emitted[0].payload.quota, SHAPED);
});
