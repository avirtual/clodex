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
  assert.ok(src.includes('worldId == null ? wc.executeJavaScript(code) : wc.executeJavaScriptInIsolatedWorld(worldId, [{ code }])'));
  assert.ok(!src.includes('worldId = 0'));
  assert.ok(!src.includes('wc.executeJavaScript(`new Promise'));
});

test('driver armIdle: without a worldId the probe runs through wc.executeJavaScript (no isolated world is assumed)', async () => {
  let t = 1000;
  const { wc } = fakeWc();
  const real = wc.executeJavaScript;
  let direct = 0;
  wc.executeJavaScript = async (code) => { direct++; return real(code); };
  const w = await driver.armIdle(wc, { now: () => t, sleepFn: async () => { t += 100; } });
  t += 1000;
  const r = await w.wait({ quietMs: 500, timeoutMs: 100 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(wc.worlds, []);
  assert.strictEqual(direct, 1);
});

test('driver act: the world id in its options reaches the idle probe', async () => {
  let t = 1000;
  const { wc } = fakeWc();
  const { idle } = await driver.act(wc, async () => {}, { worldId: 4242, timeoutMs: 5000, now: () => (t += 600), sleepFn: async () => {} });
  assert.strictEqual(idle.ok, true);
  assert.deepStrictEqual(wc.worlds, [4242]);
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
  assert.deepStrictEqual(pair.polls.paths, ['https://x/p0.txt', 'https://x/p1.txt']);
  const reversed = await pollRun(Array.from({ length: 8 }, (_, i) => `https://x/p${1 - (i % 2)}.txt?${i}`));
  assert.strictEqual(reversed.ok, true);
  assert.deepStrictEqual(reversed.polls.paths, ['https://x/p0.txt', 'https://x/p1.txt']);
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
  assert.ok(src.includes('.filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 3);'));
  assert.ok(src.includes('const POLL_MIN_MS = 100;'));
});

test('driver armIdle: a timed-out wait names the top three requests completed in the last 2 s; with none it carries no held', async () => {
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
  assert.ok(!('more' in r.held));
  const tie = fakeWc();
  const w4 = await driver.armIdle(tie.wc, { now: () => t, sleepFn: async () => { t += 100; } });
  [['POST', 'https://x/a'], ['GET', 'https://x/b'], ['GET', 'https://x/a'], ['POST', 'https://x/a'], ['GET', 'https://x/b'], ['GET', 'https://x/a']].forEach(([method, url], i) => { tie.sent(`q${i}`, url, 'XHR', method); t += 50; tie.finished(`q${i}`); t += 50; });
  tie.sent('open', 'https://x/api/slow');
  const r4 = await w4.wait({ quietMs: 500, timeoutMs: 100 });
  assert.deepStrictEqual(r4.held, { n: 6, top: [{ method: 'GET', path: 'https://x/a', n: 2 }, { method: 'GET', path: 'https://x/b', n: 2 }, { method: 'POST', path: 'https://x/a', n: 2 }] });
  const four = fakeWc();
  const w5 = await driver.armIdle(four.wc, { now: () => t, sleepFn: async () => { t += 100; } });
  [['POST', 'https://x/a'], ['GET', 'https://x/b'], ['GET', 'https://x/a'], ['PUT', 'https://x/c'], ['GET', 'https://x/b'], ['GET', 'https://x/a']].forEach(([method, url], i) => { four.sent(`f${i}`, url, 'XHR', method); t += 50; four.finished(`f${i}`); t += 50; });
  four.sent('open', 'https://x/api/slow');
  const r5 = await w5.wait({ quietMs: 500, timeoutMs: 100 });
  assert.strictEqual(r5.held.more, 1);
  assert.strictEqual(r5.held.top.length, 3);
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

function timeline(start = 1000) {
  const clk = { t: start, ev: [] };
  clk.now = () => clk.t;
  clk.at = (at, fn) => clk.ev.push({ at, fn });
  clk.advance = (ms) => {
    const end = clk.t + ms;
    for (;;) {
      clk.ev.sort((a, b) => a.at - b.at);
      if (!clk.ev.length || clk.ev[0].at > end) break;
      const e = clk.ev.shift();
      clk.t = e.at;
      e.fn();
    }
    clk.t = end;
  };
  clk.sleepFn = async (ms) => clk.advance(ms);
  return clk;
}

function channels(clk, { sent, finished }, { url, n, holdMs, gapMs, staggerMs }) {
  let id = 0;
  const open = (at) => clk.at(at, () => {
    const rid = `c${id++}`;
    sent(rid, `${url}&AID=${id}`);
    clk.at(at + holdMs, () => { finished(rid); open(at + holdMs + gapMs); });
  });
  for (let i = 0; i < n; i++) open(clk.t + i * staggerMs);
}

const SIGNALER = 'https://signaler-pa.example.com/punctual/multi-watch/channel?VER=8';

test('driver armIdle: five long-poll channels held 4000 ms and reopened 20 ms later are learned as background, the act goes idle naming the host, and the next act starts knowing them', async () => {
  const clk = timeline();
  const f = fakeWc();
  const watch = await driver.armIdle(f.wc, { now: clk.now });
  channels(clk, f, { url: SIGNALER, n: 5, holdMs: 4000, gapMs: 20, staggerMs: 800 });
  const { idle } = await driver.act(f.wc, async () => {}, { now: clk.now, sleepFn: clk.sleepFn, timeoutMs: 15000 });
  assert.strictEqual(idle.ok, true);
  assert.ok(idle.ms >= 4820 && idle.ms < 15000, String(idle.ms));
  assert.deepStrictEqual(idle.ignored, { requests: 5, hosts: ['signaler-pa.example.com'], ticking: 0 });
  assert.strictEqual(watch.size(), 0);
  assert.strictEqual(watch.background(), 5);
  const next = await driver.act(f.wc, async () => {}, { now: clk.now, sleepFn: clk.sleepFn, timeoutMs: 15000 });
  assert.strictEqual(next.idle.ok, true);
  assert.ok(next.idle.ms <= 600, String(next.idle.ms));
  watch.detach();
});

test('driver armIdle: a chain reopened 400 ms after each end is not learned and stays busy', async () => {
  const clk = timeline();
  const f = fakeWc();
  const watch = await driver.armIdle(f.wc, { now: clk.now });
  channels(clk, f, { url: SIGNALER, n: 5, holdMs: 4000, gapMs: 400, staggerMs: 800 });
  const { idle } = await driver.act(f.wc, async () => {}, { now: clk.now, sleepFn: clk.sleepFn, timeoutMs: 15000 });
  assert.strictEqual(idle.ok, false);
  assert.strictEqual(idle.reason, 'timeout');
  assert.ok(!('ignored' in idle));
  assert.strictEqual(watch.background(), 0);
  watch.detach();
});

test('driver armIdle: a single 60000 ms stream still ages out at STREAM_MS and is not reported as repeating', async () => {
  const clk = timeline();
  const f = fakeWc();
  f.sent('stream', 'https://x.example/stream', 'Fetch', 'POST');
  clk.at(clk.t + 60000, () => f.finished('stream'));
  const { idle } = await driver.act(f.wc, async () => f.sent('s2', 'https://x.example/stream2', 'Fetch', 'POST'), { now: clk.now, sleepFn: clk.sleepFn, timeoutMs: 15000 });
  assert.strictEqual(idle.ok, true);
  assert.ok(idle.ms >= 8000 && idle.ms < 9000, String(idle.ms));
  assert.ok(!('ignored' in idle));
});

test('driver armIdle: learned background keys reset on a new document', async () => {
  const clk = timeline();
  const f = fakeWc();
  const watch = await driver.armIdle(f.wc, { now: clk.now });
  channels(clk, f, { url: SIGNALER, n: 5, holdMs: 4000, gapMs: 20, staggerMs: 800 });
  clk.advance(9000);
  assert.strictEqual(watch.size(), 0);
  assert.strictEqual(watch.background(), 5);
  f.wc.emit('did-navigate');
  watch.reset();
  clk.advance(1000);
  assert.strictEqual(watch.background(), 0);
  assert.strictEqual(watch.size(), 1);
  watch.detach();
});

test('driver waitIdle: a request opened before the wait starts is waited for (3000 ms), as a read would count it', async () => {
  const clk = timeline();
  const f = fakeWc();
  const watch = await driver.armIdle(f.wc, { now: clk.now });
  f.sent('early', 'https://x.example/api/report');
  clk.advance(300);
  clk.at(clk.t + 3000, () => f.finished('early'));
  assert.strictEqual(watch.size(200), 1);
  const r = await driver.waitIdle(f.wc, { now: clk.now, sleepFn: clk.sleepFn, timeoutMs: 15000 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.ms >= 3000, String(r.ms));
  watch.detach();
});

function fakePage(clk, mutate) {
  const g = {};
  const el = (tag, parent, cls) => ({ nodeType: 1, tagName: tag.toUpperCase(), id: '', classList: cls ? [cls] : [], parentElement: parent });
  const page = { el, body: el('body', null), probes: 0 };
  page.run = (code) => {
    page.probes++;
    let ms = 0;
    let obs = null;
    const timers = [];
    class MO { constructor(cb) { obs = cb; } observe() {} disconnect() { obs = null; } }
    const p = new Function('globalThis', 'document', 'MutationObserver', 'performance', 'setTimeout', `return ${code}`)(g, { readyState: 'complete' }, MO, { now: () => ms }, (fn, d) => timers.push({ at: ms + d, fn }));
    while (timers.length && ms < 20000) {
      ms += 50;
      if (obs) { const recs = mutate(ms, page); if (recs.length) obs(recs); }
      const due = timers.filter((x) => x.at <= ms);
      for (const x of due) timers.splice(timers.indexOf(x), 1);
      for (const x of due) x.fn();
    }
    clk.advance(ms);
    return p;
  };
  return page;
}

test('driver armIdle: twelve ticking elements churn the first probe and are quiet on the second; a node added elsewhere during the probe is still busy', async () => {
  const clk = timeline();
  const f = fakeWc();
  let foreign = false;
  const tickers = [];
  const page = fakePage(clk, (ms, pg) => [
    ...(ms % 100 === 50 ? tickers.map((e) => ({ type: 'characterData', target: { nodeType: 3, parentElement: e } })) : []),
    ...(foreign && ms === 250 ? [{ type: 'childList', target: pg.body }] : []),
  ]);
  for (let i = 0; i < 12; i++) tickers.push(page.el('div', page.body, 'g-Td-Jb'));
  f.wc.executeJavaScript = async (code) => page.run(code);
  const w = await driver.armIdle(f.wc, { now: clk.now, sleepFn: clk.sleepFn });
  const r = await w.wait({ quietMs: 500, timeoutMs: 15000 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(page.probes, 2);
  assert.deepStrictEqual(r.ignored, { requests: 0, hosts: [], ticking: 12 });
  foreign = true;
  const w2 = await driver.armIdle(f.wc, { now: clk.now, sleepFn: clk.sleepFn });
  const r2 = await w2.wait({ quietMs: 500, timeoutMs: 5000 });
  assert.strictEqual(r2.ok, false);
  assert.deepStrictEqual(r2.churn, ['div.g-Td-Jb', 'div.g-Td-Jb', 'div.g-Td-Jb']);
});
