'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createEngine } = require('../engine');
const { ProxyClient } = require('../wirescope-proxy');
const { mkTmpRoot } = require('./lib/tmp-roots');

const NAME = 'report-cache-probe';

function mkEngine() {
  const tmp = mkTmpRoot('clx-report-cache-');
  const engine = createEngine({
    userDataPath: tmp,
    seams: { registryDir: path.join(tmp, 'clodex-home') },
    log: { info() {}, warn() {}, error() {} },
  });
  engine.manager.sessions.set(NAME, { name: NAME, proxyBase: 'http://127.0.0.1:7999' });
  engine.proxyPoller.snapshot = () => ({ linked: true, sessionId: 'sid-1' });
  return engine;
}

async function withJson(engine, impl, opts) {
  const calls = [];
  const orig = ProxyClient._getJson;
  ProxyClient._getJson = async (base, pathname, timeout) => {
    calls.push({ base, pathname, timeout });
    return impl();
  };
  try { return { calls, res: await engine.fetchProxyReport(NAME, opts) }; }
  finally { ProxyClient._getJson = orig; }
}

const OK = (usd) => () => ({ status: 200, json: { totals: { est_usd: usd } } });
const BOOM = (msg) => () => { throw new Error(msg); };

test('a timeout after a good report serves the cached one, flagged stale', async () => {
  const engine = mkEngine();
  const warm = await withJson(engine, OK(12.5));
  assert.strictEqual(warm.calls.length, 1,
    'ENTER: the priming fetch must actually reach _getJson — zero calls means nothing was ever cached and the assertions below are vacuous');
  assert.strictEqual(warm.res.ok, true);
  assert.ok(!warm.res.stale, 'a live answer must never be labelled stale');

  const cold = await withJson(engine, BOOM('timeout'));
  assert.strictEqual(cold.calls.length, 1,
    'ENTER: the timing-out fetch must have been attempted — a cached answer returned WITHOUT trying the proxy would never refresh');
  assert.strictEqual(cold.res.ok, true,
    'with a cached report on hand a timeout is not a failure — the popover has something true to show');
  assert.strictEqual(cold.res.stale, true, 'and it must say so, or the operator reads minute-old numbers as live');
  assert.deepStrictEqual(cold.res.data, warm.res.data, 'the served data must BE the cached report');
  assert.strictEqual(cold.res.error, 'timeout', 'the reason the live fetch failed rides along for the popover line');
  assert.strictEqual(typeof cold.res.at, 'number', 'and the age the popover prints needs the stamp it was taken at');
});

test('a timeout with nothing cached is still a plain failure', async () => {
  const engine = mkEngine();
  const { calls, res } = await withJson(engine, BOOM('timeout'));
  assert.strictEqual(calls.length, 1, 'ENTER: the fetch must have been attempted');
  assert.strictEqual(res.ok, false,
    'with no cached report there is nothing to show — inventing ok:true with no data would paint an empty popover as a success');
  assert.strictEqual(res.error, 'timeout');
  assert.ok(!res.data, 'a failure carries no data');
});

test('a non-200 falls back the same way a timeout does', async () => {
  const engine = mkEngine();
  await withJson(engine, OK(3.25));
  const { res } = await withJson(engine, () => ({ status: 503, json: null }));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.stale, true);
  assert.deepStrictEqual(res.data, { totals: { est_usd: 3.25 } });
  assert.match(res.error, /503/, 'the popover line must name what the proxy actually said');
});

test('a fresh success replaces the cache rather than pinning the first answer', async () => {
  const engine = mkEngine();
  await withJson(engine, OK(1));
  await withJson(engine, OK(2));
  const { res } = await withJson(engine, BOOM('timeout'));
  assert.deepStrictEqual(res.data, { totals: { est_usd: 2 } },
    'the cache must hold the LAST good report — a write-once cache would serve an ever-older one forever');
});

test('the detail fetch is neither cached nor served stale', async () => {
  const engine = mkEngine();
  const primed = await withJson(engine, OK(9), { detail: true });
  assert.match(primed.calls[0].pathname, /[?&]detail=1(&|$)/,
    'ENTER: this must be the detail request, or it pins the summary arm twice');
  const { res } = await withJson(engine, BOOM('timeout'));
  assert.strictEqual(res.ok, false, 'a detail success must not have populated the summary cache');

  await withJson(engine, OK(4));
  const d = await withJson(engine, BOOM('timeout'), { detail: true });
  assert.strictEqual(d.res.ok, false,
    'a detail timeout must not be answered with the cached SUMMARY — the caller asked for series it would not get');
});

test('killing the session drops its cached report', async () => {
  const engine = mkEngine();
  await withJson(engine, OK(7));
  assert.ok(engine.manager._reportCache.has(NAME),
    'ENTER: the cache must actually hold this session, or the drop below proves nothing');

  engine.manager._cleanup(NAME);
  assert.ok(!engine.manager._reportCache.has(NAME),
    '_cleanup must drop the report cache entry with the session it belongs to');

  engine.manager.sessions.set(NAME, { name: NAME, proxyBase: 'http://127.0.0.1:7999' });
  const { res } = await withJson(engine, BOOM('timeout'));
  assert.strictEqual(res.ok, false,
    "a same-named replacement must not be served its predecessor's report");
});

after(() => { setImmediate(() => process.exit(0)); });
