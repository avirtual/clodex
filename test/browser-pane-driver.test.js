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
  wc.worlds = [];
  Object.assign(wc, { debugger: dbg, isDestroyed: () => false, isLoading: () => false, executeJavaScript: async () => 'complete', executeJavaScriptInIsolatedWorld: async (w, [{ code }]) => { wc.worlds.push(w); return wc.executeJavaScript(code); } });
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

test('driver armIdle: the idle probe runs in the isolated world so a page that replaces Promise cannot swallow it', async () => {
  let t = 1000;
  const { wc } = fakeWc();
  let direct = 0;
  wc.executeJavaScriptInIsolatedWorld = async (w) => { wc.worlds.push(w); return { state: 'complete' }; };
  wc.executeJavaScript = async () => { direct++; return { __zone_symbol__state: null, __zone_symbol__value: [] }; };
  const w = await driver.armIdle(wc, { now: () => t, sleepFn: async () => { t += 100; }, worldId: 4242 });
  t += 1000;
  const r = await w.wait({ quietMs: 500, timeoutMs: 100 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(wc.worlds, [4242]);
  assert.strictEqual(direct, 0);
  const src = require('node:fs').readFileSync(require.resolve('../plugins/browser-pane/driver'), 'utf8');
  assert.ok(src.includes('wc.executeJavaScriptInIsolatedWorld(worldId, [{ code: `new Promise(res => {'));
  assert.ok(!src.includes('wc.executeJavaScript(`new Promise'));
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

test('driver armIdle: a page polling up to three paths of any method goes idle with the polls named; under three completions, a burst or five rotating paths it does not; another completion holds the quiet window', async () => {
  const r = await pollRun(['https://x/api/poll?1', 'https://x/api/poll?2', 'https://x/api/poll?3', 'https://x/api/poll?4']);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.polls.paths, ['https://x/api/poll']);
  assert.ok(!('keys' in r.polls));
  assert.ok(Math.abs(r.polls.everyMs - 300) <= 50, String(r.polls.everyMs));
  const two = await pollRun(['https://x/api/poll?1', 'https://x/api/poll?2']);
  assert.strictEqual(two.ok, false);
  assert.strictEqual(two.reason, 'timeout');
  assert.ok(!('polls' in two));
  const posts = await pollRun(['https://x/graphql', 'https://x/graphql', 'https://x/graphql', 'https://x/graphql'], 200, { method: 'POST' });
  assert.strictEqual(posts.ok, true);
  assert.deepStrictEqual(posts.polls.paths, ['https://x/graphql']);
  const rotate = await pollRun(Array.from({ length: 15 }, (_, i) => `https://x/p${i % 5}.txt?${i}`));
  assert.strictEqual(rotate.ok, false);
  assert.ok(!('polls' in rotate));
  const pair = await pollRun(Array.from({ length: 8 }, (_, i) => `https://x/p${i % 2}.txt?${i}`));
  assert.strictEqual(pair.ok, true);
  assert.deepStrictEqual([...pair.polls.paths].sort(), ['https://x/p0.txt', 'https://x/p1.txt']);
  assert.ok(Math.abs(pair.polls.everyMs - 600) <= 50, String(pair.polls.everyMs));
  const held = await pollRun(['https://x/api/poll?1', 'https://x/api/poll?2', 'https://x/api/poll?3', 'https://x/api/poll?4'], 200, { other: true });
  assert.strictEqual(held.ok, true);
  assert.ok(held.ms >= 500, String(held.ms));
  const burst = await pollRun(['https://x/w/load.php?a', 'https://x/w/load.php?b', 'https://x/w/load.php?c', 'https://x/w/load.php?d'], -95);
  assert.strictEqual(burst.ok, false);
  assert.ok(!('polls' in burst));
  const src = require('node:fs').readFileSync(require.resolve('../plugins/browser-pane/driver'), 'utf8');
  assert.ok(src.includes('const DONE_MAX = 64;'));
  assert.ok(src.includes('const other = recent.filter((d) => !keys.has(d.method + \' \' + d.path)); if (other.length > tops.length) return null;'));
  assert.ok(src.includes('.filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3);'));
  assert.ok(src.includes('const POLL_MIN_MS = 100;'));
});

test('driver armIdle: a timed-out wait names the top two requests completed in the last 2 s; with none it carries no held', async () => {
  let t = 1000;
  const { wc, sent, finished } = fakeWc();
  const w = await driver.armIdle(wc, { now: () => t, sleepFn: async () => { t += 100; } });
  const rows = [['POST', 'https://x/api/graphql'], ['GET', 'https://x/api/v1/x'], ['POST', 'https://x/api/graphql'], ['POST', 'https://x/api/graphql'], ['GET', 'https://x/api/v1/x?2'], ['POST', 'https://x/api/graphql']];
  rows.forEach(([method, url], i) => { sent(`h${i}`, url, 'XHR', method); t += 50; finished(`h${i}`); t += 50; });
  sent('open', 'https://x/api/slow');
  const r = await w.wait({ quietMs: 500, timeoutMs: 100 });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.held, { n: 6, top: [{ method: 'POST', path: 'https://x/api/graphql', n: 4 }, { method: 'GET', path: 'https://x/api/v1/x', n: 2 }] });
  const bare = fakeWc();
  const w2 = await driver.armIdle(bare.wc, { now: () => t, sleepFn: async () => { t += 100; } });
  bare.sent('open', 'https://x/api/slow');
  const r2 = await w2.wait({ quietMs: 500, timeoutMs: 100 });
  assert.strictEqual(r2.ok, false);
  assert.ok(!('held' in r2));
  const many = fakeWc();
  const w3 = await driver.armIdle(many.wc, { now: () => t, sleepFn: async () => { t += 100; } });
  for (let i = 0; i < 64; i++) { many.sent(`m${i}`, 'https://x/api/graphql', 'XHR', 'POST'); t += 10; many.finished(`m${i}`); t += 10; }
  many.sent('open', 'https://x/api/slow');
  const r3 = await w3.wait({ quietMs: 500, timeoutMs: 100 });
  assert.strictEqual(r3.held.full, true);
  assert.strictEqual(r3.held.n, 64);
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
