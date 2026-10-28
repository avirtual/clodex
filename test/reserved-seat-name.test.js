'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { RemoteServer } = require('../remote');
const { RESERVED_SEAT_NAMES } = require('../pending-store');
const nameValidity = require('../renderer/lib/name-validity');
const { mk } = require('./lib/session-fixtures');

test('the renderer copy of the reserved seat names agrees with pending-store', () => {
  assert.deepStrictEqual([...RESERVED_SEAT_NAMES], ['.claims']);
  assert.deepStrictEqual([...nameValidity.RESERVED_SEAT_NAMES], [...RESERVED_SEAT_NAMES]);
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'lib', 'name-validity.js'), 'utf8');
  assert.ok(!/require\(/.test(src), 'the renderer lib stays dependency-free');
});

test('create refuses the reserved name before anything else runs', async () => {
  const m = mk({});
  await assert.rejects(() => m.create('.claims', 'claude', null), /"\.claims" is a reserved name/);
  assert.strictEqual(m.sessions.has('.claims'), false);
});

function req(port, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

test('the peer API refuses the reserved name at create and on the per-session routes, and still serves .hidden', async () => {
  const created = [];
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: path.join(__dirname, '..', 'renderer', 'remote.html'),
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    createSession: async (msg) => { created.push(msg.name); return { ok: true }; },
  });
  await server.start();
  try {
    const post = (name) => req(server.port, '/api/sessions', {
      method: 'POST', body: JSON.stringify({ name }), headers: { 'content-type': 'application/json' },
    });
    const bad = await post('.claims');
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body, /reserved name/);
    assert.strictEqual((await post('.hidden')).status, 200);
    assert.deepStrictEqual(created, ['.hidden']);
    const get = await req(server.port, '/api/sessions/.claims');
    assert.strictEqual(get.status, 400);
    assert.match(get.body, /bad session name/);
  } finally { server.stop(); }
});
