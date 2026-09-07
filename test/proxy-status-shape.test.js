'use strict';

// ProxyClient.status returns the whole /_status envelope, not just the session
// array. The widening is the one change here that a unit test on the shaping
// cannot cover: a caller still treating the return as an array would type-check
// nowhere, go green everywhere, and die at runtime on the first poll. So this
// drives the REAL client against a real HTTP server rather than a stub.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { ProxyClient } = require('../wirescope-proxy');

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` });
    });
  });
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

test('status(): sessions AND the top-level quota block come back', async () => {
  const sessions = [{ agent: 'clodex-a-1', session_id: 's1' }];
  const quota = { status: 'allowed_warning', primary: { window: '7d', used_pct: 95 } };
  const { srv, base } = await serve((req, res) => {
    assert.strictEqual(req.url, '/_status', 'ENTER: the client must actually hit /_status');
    json(res, 200, { proxy: { version: 'v0.6.53' }, quota, sessions });
  });
  try {
    const out = await ProxyClient.status(base);
    assert.deepStrictEqual(out, { sessions, quota, authRefresh: null });
  } finally { srv.close(); }
});

test('status(): a proxy with no quota block yields sessions plus a null quota', async () => {
  // The pre-quota proxy. The sessions half must be byte-identical to before —
  // that is the contract the poller has always depended on.
  const sessions = [{ agent: 'clodex-a-1' }];
  const { srv, base } = await serve((_req, res) => json(res, 200, { sessions }));
  try {
    assert.deepStrictEqual(await ProxyClient.status(base), { sessions, quota: null, authRefresh: null });
  } finally { srv.close(); }
});

test('status(): a non-200, or a body with no sessions array, degrades to empty', async () => {
  const { srv, base } = await serve((req, res) => {
    if (req.url === '/_status') return json(res, 500, { error: 'boom' });
    json(res, 200, {});
  });
  try {
    assert.deepStrictEqual(await ProxyClient.status(base), { sessions: [], quota: null, authRefresh: null });
  } finally { srv.close(); }

  const { srv: s2, base: b2 } = await serve((_req, res) => json(res, 200, { proxy: {} }));
  try {
    assert.deepStrictEqual(await ProxyClient.status(b2), { sessions: [], quota: null, authRefresh: null });
  } finally { s2.close(); }
});

// proxy.auth_refresh: the readout that says a human owes `claude login`. When
// the refresh token is dead the proxy cannot renew and every keep-warm hold
// dies at the next lapse — so the flag has to survive the reduce, not be
// summarised away into the boolean the banner happens to need today.
test('status(): a stalled auth_refresh block comes back beside the sessions', async () => {
  const sessions = [{ agent: 'clodex-a-1' }];
  const authRefresh = {
    enabled: true, lead_s: 300, token_expires_at: 1786791110, token_expires_in_s: -20,
    token_lapsed: true, checked_ts: 1786791130, read_error: null,
    last_trigger_ts: 1786791120, last_outcome: 'refresh_failed', refreshed: false, stalled: true,
  };
  const { srv, base } = await serve((_req, res) => json(res, 200, { proxy: { version: 'v0.6.59', auth_refresh: authRefresh }, sessions }));
  try {
    assert.deepStrictEqual(await ProxyClient.status(base), {
      sessions,
      quota: null,
      authRefresh: { stalled: true, lapsed: true, lastOutcome: 'refresh_failed', readError: null },
    });
  } finally { srv.close(); }
});

test('status(): a healthy auth_refresh block reads as not stalled', async () => {
  const sessions = [];
  const authRefresh = {
    enabled: true, token_lapsed: false, read_error: null,
    last_outcome: 'refreshed', refreshed: true, stalled: false,
  };
  const { srv, base } = await serve((_req, res) => json(res, 200, { proxy: { auth_refresh: authRefresh }, sessions }));
  try {
    assert.deepStrictEqual(await ProxyClient.status(base), {
      sessions,
      quota: null,
      authRefresh: { stalled: false, lapsed: false, lastOutcome: 'refreshed', readError: null },
    });
  } finally { srv.close(); }
});

// The older proxy. `null` and "present but not stalled" must stay distinct on
// the wire: the banner reads stalled off an object, and a reduce that folded
// absence into `{stalled:false}` would be indistinguishable here yet claim a
// healthy reading the proxy never sent.
test('status(): a proxy with no auth_refresh block yields a null readout', async () => {
  const sessions = [{ agent: 'clodex-a-1' }];
  const { srv, base } = await serve((_req, res) => json(res, 200, { proxy: { version: 'v0.6.53' }, sessions }));
  try {
    assert.deepStrictEqual(await ProxyClient.status(base), { sessions, quota: null, authRefresh: null });
  } finally { srv.close(); }
});

test('status(): every caller in the tree destructures rather than treating it as an array', () => {
  // The widening's only real hazard. A surviving `for (const r of await
  // ProxyClient.status(...))` iterates an object and throws on the first poll,
  // which no shaping test would catch.
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const files = fs.readdirSync(root).filter((f) => f.endsWith('.js'));
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const line of src.split('\n')) {
      if (line.includes('ProxyClient.status(')) hits.push({ f, line: line.trim() });
    }
  }
  assert.ok(hits.length > 0, 'ENTER: no ProxyClient.status call site found — the scan matched nothing and every assertion below is vacuous');
  for (const h of hits) {
    assert.ok(
      /\{[^}]*sessions[^}]*\}\s*=/.test(h.line),
      `${h.f} calls ProxyClient.status without destructuring sessions: ${h.line}`,
    );
  }
});
