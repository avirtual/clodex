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
    assert.deepStrictEqual(out, { sessions, quota });
  } finally { srv.close(); }
});

test('status(): a proxy with no quota block yields sessions plus a null quota', async () => {
  // The pre-quota proxy. The sessions half must be byte-identical to before —
  // that is the contract the poller has always depended on.
  const sessions = [{ agent: 'clodex-a-1' }];
  const { srv, base } = await serve((_req, res) => json(res, 200, { sessions }));
  try {
    assert.deepStrictEqual(await ProxyClient.status(base), { sessions, quota: null });
  } finally { srv.close(); }
});

test('status(): a non-200, or a body with no sessions array, degrades to empty', async () => {
  const { srv, base } = await serve((req, res) => {
    if (req.url === '/_status') return json(res, 500, { error: 'boom' });
    json(res, 200, {});
  });
  try {
    assert.deepStrictEqual(await ProxyClient.status(base), { sessions: [], quota: null });
  } finally { srv.close(); }

  const { srv: s2, base: b2 } = await serve((_req, res) => json(res, 200, { proxy: {} }));
  try {
    assert.deepStrictEqual(await ProxyClient.status(b2), { sessions: [], quota: null });
  } finally { s2.close(); }
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
