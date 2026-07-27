'use strict';
// engine-context-timeout.test.js — t62: the timeout budget /_context asks for.
//
// One endpoint, two very different weights. Plain /_context is a memory read
// (2.5ms measured); with utilization=1 the proxy disk-scans every retained
// capture for the session (10.5s measured at 18k captures / 1.5GB, for a 7.9KB
// response). The scan was left on PROXY_HTTP_TIMEOUT (4000, "keeps polling/
// handshake snappy"), so a healthy proxy doing exactly what it was asked came
// back to the operator as the bare word "timeout".
//
// These pin the budget at the seam that actually carries it — the third
// argument to ProxyClient._getJson — by driving the REAL fetchProxyContext and
// capturing the call. The distinction is deliberately conditional (see the
// comment at the call site), so the plain path is pinned too: an unconditional
// raise is a passing implementation for the utilization test alone.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEngine } = require('../engine');
const { ProxyClient, PROXY_REPORT_TIMEOUT } = require('../wirescope-proxy');

function mkEngine() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-ctx-timeout-'));
  return createEngine({ userDataPath: tmp, log: { info() {}, warn() {}, error() {} } });
}

// Drive the real fetchProxyContext end to end: plant a routed session, make the
// poller report it linked, and swap ProxyClient._getJson for a capture. No
// socket is ever opened. `linked:false` is how the ENTER guard is stubbed —
// fetchProxyContext returns early on an unlinked snapshot without ever reaching
// the call, which is exactly the vacuous state the calls-length asserts catch.
async function callContext(opts, { linked = true, getJson } = {}) {
  const engine = mkEngine();
  const name = 'ctx-timeout-probe';
  engine.manager.sessions.set(name, { name, proxyBase: 'http://127.0.0.1:7999' });
  engine.proxyPoller.snapshot = () => (linked ? { linked: true, sessionId: 'sid-1' } : null);
  const calls = [];
  const orig = ProxyClient._getJson;
  ProxyClient._getJson = async (base, pathname, timeout) => {
    calls.push({ base, pathname, timeout });
    if (getJson) return getJson();
    return { status: 200, json: { ok: 1 } };
  };
  try {
    const res = await engine.fetchProxyContext(name, opts);
    return { calls, res };
  } finally {
    ProxyClient._getJson = orig;
    engine.manager.sessions.delete(name);
  }
}

test('utilization=1 asks for the report budget, not the snappy default', async () => {
  const { calls } = await callContext({ utilization: true });
  // ENTER, part 1: the call has to have happened at all. fetchProxyContext bails
  // before _getJson on an unrouted or unlinked session, and a test that never
  // reaches the call would satisfy every timeout assertion below by vacuum.
  assert.strictEqual(calls.length, 1,
    'ENTER: fetchProxyContext must actually reach ProxyClient._getJson — zero calls means the test asserted a budget on a request that was never made');
  // ENTER, part 2: and it has to be the HEAVY query. Asserting a raised timeout
  // on the plain path would pass against an unconditional raise and prove
  // nothing about the branch this ticket exists for.
  assert.match(calls[0].pathname, /[?&]utilization=1(&|$)/,
    'ENTER: the captured request must carry utilization=1 — otherwise this pins the plain path and the utilization branch is untested');
  assert.strictEqual(calls[0].timeout, PROXY_REPORT_TIMEOUT,
    'the utilization capture-scan must be given PROXY_REPORT_TIMEOUT (20000): its wall time tracks retained captures, measured at 10.5s, so the 4000ms default reports "timeout" on a healthy proxy');
});

test('the plain read keeps the snappy default budget', async () => {
  const { calls } = await callContext({ utilization: false });
  assert.strictEqual(calls.length, 1,
    'ENTER: fetchProxyContext must actually reach ProxyClient._getJson');
  assert.doesNotMatch(calls[0].pathname, /utilization=1/,
    'ENTER: this test must exercise the PLAIN query — a utilization=1 here would pin the wrong branch');
  assert.strictEqual(calls[0].timeout, undefined,
    'the plain read must NOT be given the report budget: it is a 2.5ms memory read that never approaches either limit, so raising it only makes a genuinely hung proxy hold the popover 20s instead of 4s. Passing undefined (not the constant) keeps _req the single owner of the default');
});

test('no opts at all is the plain path, not the heavy one', async () => {
  const { calls } = await callContext(undefined);
  assert.strictEqual(calls.length, 1,
    'ENTER: fetchProxyContext must actually reach ProxyClient._getJson');
  assert.doesNotMatch(calls[0].pathname, /utilization=1/,
    'a caller passing no opts must not trigger the capture-scan');
  assert.strictEqual(calls[0].timeout, undefined,
    'a caller passing no opts must get the snappy default budget');
});

test('a utilization timeout names the scan and the budget it blew', async () => {
  const { calls, res } = await callContext({ utilization: true }, {
    getJson: () => { throw new Error('timeout'); },
  });
  assert.strictEqual(calls.length, 1,
    'ENTER: the throwing stub must have been reached, or the error text below is whatever the earlier guard clause returned');
  assert.match(calls[0].pathname, /[?&]utilization=1(&|$)/,
    'ENTER: this must be the utilization request for the message to be the utilization message');
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /utilization scan/,
    'the popover renders this string raw, so a bare "timeout" cannot be told from a dead proxy — the error must name WHICH request timed out');
  assert.match(res.error, new RegExp(String(PROXY_REPORT_TIMEOUT)),
    'the error must name the budget that was actually blown, so the operator can tell a 20s scan overrun from a 4s snappy-default one');
});

test('a plain timeout names the endpoint without claiming a scan', async () => {
  const { calls, res } = await callContext({ utilization: false }, {
    getJson: () => { throw new Error('timeout'); },
  });
  assert.strictEqual(calls.length, 1,
    'ENTER: the throwing stub must have been reached');
  assert.doesNotMatch(calls[0].pathname, /utilization=1/,
    'ENTER: this must be the plain request');
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /\/_context/,
    'the plain timeout must still name the endpoint — "timeout" alone is the string this ticket exists to remove');
  assert.doesNotMatch(res.error, /utilization/,
    'the plain path must not claim a capture-scan it never asked for');
});

test('errors that are not timeouts pass through unchanged', async () => {
  const { res } = await callContext({ utilization: true }, {
    getJson: () => { throw new Error('connect ECONNREFUSED 127.0.0.1:7999'); },
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'connect ECONNREFUSED 127.0.0.1:7999',
    'only the bare "timeout" string is rewritten — a dead proxy must keep reporting as a dead proxy, since that is the case the operator currently cannot distinguish');
});

// createEngine stands up real pollers/timers; nothing here stops them, so the
// process would hang after the last assertion. Same teardown as
// engine-web-info-seam.test.js, which builds engines the same way.
after(() => { setImmediate(() => process.exit(0)); });
