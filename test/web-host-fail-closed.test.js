'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const http = require('node:http');
const WebSocket = require('ws');

const { createWebHost } = require('../web-host');

const silentLog = { info() {}, warn() {}, error() {} };

async function withHost(opts, fn) {
  const engine = { manager: { registerWindow() {}, unregisterWindow() {}, listForWorkspace: () => [] }, stores: {} };
  const host = createWebHost({
    engine, log: silentLog, port: 0, token: null, userDataPath: os.tmpdir(), registerHandlers: () => {}, ...opts,
  });
  if (!host._server.listening) await new Promise((res) => host._server.once('listening', res));
  try { await fn(host._server.address().port); } finally { host.close(); }
}

function req(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function upgrade(port, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${token ? `?token=${token}` : ''}`);
    ws.once('open', () => { ws.close(); resolve('open'); });
    ws.once('error', () => resolve('refused'));
  });
}

test('non-loopback bind with no token → 503 naming CLODEX_WEB_TOKEN, WS upgrade refused', async () => {
  await withHost({ host: '0.0.0.0' }, async (port) => {
    const page = await req(port, '/');
    assert.equal(page.status, 503);
    assert.match(page.body, /CLODEX_WEB_TOKEN/);
    assert.equal(page.headers['cache-control'], 'no-store');
    const api = await req(port, '/api/anything');
    assert.equal(api.status, 503);
    assert.match(api.body, /CLODEX_WEB_TOKEN/);
    assert.equal(await upgrade(port), 'refused');
  });
});

test('non-loopback bind with no token: /healthz still answers 200', async () => {
  await withHost({ host: '0.0.0.0' }, async (port) => {
    const r = await req(port, '/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.body, 'ok');
  });
});

test('insecure override: non-loopback bind with no token serves', async () => {
  await withHost({ host: '0.0.0.0', insecure: true }, async (port) => {
    assert.equal((await req(port, '/')).status, 200);
    assert.equal(await upgrade(port), 'open');
  });
});

test('loopback bind with no token serves (localhost-trust preserved)', async () => {
  await withHost({ host: '127.0.0.1' }, async (port) => {
    assert.equal((await req(port, '/')).status, 200);
    assert.equal(await upgrade(port), 'open');
  });
});

test('non-loopback bind with a token: 401 without it, 200 with it', async () => {
  await withHost({ host: '0.0.0.0', token: 'sekret' }, async (port) => {
    assert.equal((await req(port, '/')).status, 401);
    assert.equal((await req(port, '/?token=sekret')).status, 200);
    assert.equal((await req(port, '/', { authorization: 'Bearer sekret' })).status, 200);
    assert.equal(await upgrade(port), 'refused');
    assert.equal(await upgrade(port, 'sekret'), 'open');
  });
});

test('insecure override on a non-loopback bind logs INSECURE, not localhost-trust', async () => {
  const lines = [];
  const log = { info: (_c, m) => lines.push(m), warn() {}, error() {} };
  await withHost({ host: '0.0.0.0', insecure: true, log }, async () => {});
  const listen = lines.find((l) => /web host listening/.test(l));
  assert.match(listen, /INSECURE/);
  assert.doesNotMatch(listen, /localhost-trust/);
});
