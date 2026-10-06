'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const driver = require('../plugins/browser-pane/driver');

function fakeWc() {
  const dbg = new EventEmitter();
  dbg.isAttached = () => true;
  dbg.attach = () => {};
  dbg.sendCommand = async () => ({});
  const wc = new EventEmitter();
  Object.assign(wc, { debugger: dbg, isDestroyed: () => false, isLoading: () => false, executeJavaScript: async () => 'complete' });
  const sent = (id, url, type = 'XHR', method = 'GET') => dbg.emit('message', {}, 'Network.requestWillBeSent', { requestId: id, type, request: { url, method } });
  const finished = (id) => dbg.emit('message', {}, 'Network.loadingFinished', { requestId: id });
  return { wc, sent, finished };
}

test('driver armIdle: blob: and data: requests never count as in flight', async () => {
  let t = 1000;
  const { wc, sent } = fakeWc();
  const w = await driver.armIdle(wc, { now: () => t });
  sent('1', 'blob:https://x.com/7f1e-4c2a');
  sent('2', 'data:image/png;base64,AAAA');
  t += 1000;
  assert.strictEqual(w.size(), 0);
  assert.strictEqual(w.background(), 0);
  assert.strictEqual(w.fired.requests, 0);
  w.detach();
});

test('driver armIdle: a request open past STREAM_MS is background, out of size() and out of the idle wait', async () => {
  let t = 1000;
  const { wc, sent } = fakeWc();
  const w = await driver.armIdle(wc, { now: () => t });
  sent('poll', 'https://x.com/i/api/live_pipeline', 'XHR');
  t += 300;
  assert.strictEqual(w.size(200), 1);
  t += 9000;
  sent('fresh', 'https://x.com/i/api/graphql', 'Fetch');
  assert.strictEqual(w.size(), 1, 'only the fresh request counts');
  assert.strictEqual(w.background(), 1);
  wc.debugger.emit('message', {}, 'Network.loadingFinished', { requestId: 'fresh' });
  t += 1000;
  assert.strictEqual(w.size(), 0);
  const r = await w.wait({ quietMs: 500, timeoutMs: 100 });
  assert.strictEqual(r.ok, true);
});

test('driver armIdle: a page whose only mutations are a repainting ticker goes idle and names it; a plain readyState keeps the old shape', async () => {
  let t = 1000;
  const { wc } = fakeWc();
  wc.executeJavaScript = async () => ({ state: 'complete', ticker: 'span#clock' });
  const w = await driver.armIdle(wc, { now: () => t });
  t += 1000;
  const r = await w.wait({ quietMs: 500, timeoutMs: 100 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ticker, 'span#clock');
  const plain = fakeWc();
  const w2 = await driver.armIdle(plain.wc, { now: () => t });
  t += 1000;
  const r2 = await w2.wait({ quietMs: 500, timeoutMs: 100 });
  assert.strictEqual(r2.ok, true);
  assert.ok(!('ticker' in r2));
  const src = require('node:fs').readFileSync(require.resolve('../plugins/browser-pane/driver'), 'utf8');
  assert.ok(src.includes('hits.size <= 8 && [...hits.values()].every(n => n >= 3)'));
  assert.ok(src.includes('${quietMs} * 4'));
  assert.ok(src.includes("const k = [...hits.entries()].sort((a, b) => b[1] - a[1])[0][0];"));
});

test('driver armIdle: a page that never stops churning times out naming its top churn nodes, sanitized', async () => {
  let t = 1000;
  const { wc } = fakeWc();
  wc.executeJavaScript = async () => { t += 1000; return { state: 'interactive', churn: ['div#app', 'span.price', 'x y z!'] }; };
  const w = await driver.armIdle(wc, { now: () => t, sleepFn: async () => {} });
  const r = await w.wait({ quietMs: 500, timeoutMs: 100 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'timeout');
  assert.deepStrictEqual(r.churn, ['div#app', 'span.price', 'xyz']);
  const src = require('node:fs').readFileSync(require.resolve('../plugins/browser-pane/driver'), 'utf8');
  assert.ok(src.includes('quietMs * 4 + 3000'));
  assert.ok(src.includes('if (performance.now() - t0 >= ${quietMs} * 4 + 2000) { mo.disconnect(); res({ state: document.readyState, churn: [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => label(k)) }); return; }'));
});

test('driver armIdle: a complete page reporting churn is not idle', async () => {
  let t = 1000;
  const { wc } = fakeWc();
  wc.executeJavaScript = async () => { t += 1000; return { state: 'complete', churn: ['div#app'] }; };
  const w = await driver.armIdle(wc, { now: () => t, sleepFn: async () => {} });
  const r = await w.wait({ quietMs: 500, timeoutMs: 100 });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.churn, ['div#app']);
});

function pollRun(urls, gapMs = 200, { method = 'GET', other = false } = {}) {
  let t = 1000;
  const { wc, sent, finished } = fakeWc();
  return driver.armIdle(wc, { now: () => t, sleepFn: async () => { t += 100; } }).then((w) => {
    urls.forEach((url, i) => { sent(`p${i}`, url, 'XHR', method); t += 100; finished(`p${i}`); t += gapMs; });
    if (other) { sent('o', 'https://x/api/data'); finished('o'); }
    sent('open', urls[0].replace(/\?.*$/, '?open'), 'XHR', method);
    return w.wait({ quietMs: 500, timeoutMs: 1000 });
  });
}

test('driver armIdle: a page GET-polling one path goes idle with the poll named; under three completions, a burst or POSTs it does not; another completion holds the quiet window', async () => {
  const r = await pollRun(['https://x/api/poll?1', 'https://x/api/poll?2', 'https://x/api/poll?3', 'https://x/api/poll?4']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.polls.path, 'https://x/api/poll');
  assert.ok(Math.abs(r.polls.everyMs - 300) <= 50, String(r.polls.everyMs));
  const two = await pollRun(['https://x/api/poll?1', 'https://x/api/poll?2']);
  assert.strictEqual(two.ok, false);
  assert.strictEqual(two.reason, 'timeout');
  assert.ok(!('polls' in two));
  const posts = await pollRun(['https://x/graphql', 'https://x/graphql', 'https://x/graphql', 'https://x/graphql'], 200, { method: 'POST' });
  assert.strictEqual(posts.ok, false);
  assert.ok(!('polls' in posts));
  const held = await pollRun(['https://x/api/poll?1', 'https://x/api/poll?2', 'https://x/api/poll?3', 'https://x/api/poll?4'], 200, { other: true });
  assert.strictEqual(held.ok, true);
  assert.ok(held.ms >= 500, String(held.ms));
  const burst = await pollRun(['https://x/w/load.php?a', 'https://x/w/load.php?b', 'https://x/w/load.php?c', 'https://x/w/load.php?d'], -95);
  assert.strictEqual(burst.ok, false);
  assert.ok(!('polls' in burst));
  const src = require('node:fs').readFileSync(require.resolve('../plugins/browser-pane/driver'), 'utf8');
  assert.ok(src.includes('const DONE_MAX = 64;'));
  assert.ok(src.includes('if (!top || top[1] < 3) return null;'));
  assert.ok(src.includes('const POLL_MIN_MS = 100;'));
});

test('driver armIdle: reset() forgets the finished requests a poll was detected from', async () => {
  let t = 1000;
  const { wc, sent, finished } = fakeWc();
  const w = await driver.armIdle(wc, { now: () => t, sleepFn: async () => { t += 100; } });
  for (let i = 0; i < 4; i++) { sent(`p${i}`, `https://x/api/poll?${i}`); t += 100; finished(`p${i}`); t += 200; }
  w.reset();
  sent('open', 'https://x/api/poll?open');
  const r = await w.wait({ quietMs: 500, timeoutMs: 1000 });
  assert.strictEqual(r.ok, false);
  assert.ok(!('polls' in r));
});
