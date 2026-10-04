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
  const sent = (id, url, type = 'XHR') => dbg.emit('message', {}, 'Network.requestWillBeSent', { requestId: id, type, request: { url } });
  return { wc, sent };
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
