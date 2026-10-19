'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { RemoteServer } = require('../remote');

const PAGE = path.join(__dirname, '..', 'renderer', 'remote.html');

function post(server, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: server.port, path: '/api/dm', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf) }));
    });
    r.on('error', reject);
    r.end(payload);
  });
}

async function withServer(fn) {
  const got = [];
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: PAGE,
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    deliverDm: (msg) => { got.push(msg); return { ok: true, delivered: true }; },
  });
  await server.start();
  try { await fn(server, got); } finally { server.stop(); }
}

test('/api/dm accepts a sandbox envelope and hands exactly its three fields on', async () => {
  await withServer(async (server, got) => {
    const res = await post(server, { to: 'board', from: 'lead', origin: 'team-x', body: 'sandbox port add 18080',
      task: { kind: 'sandbox', verb: 'port', args: 'add 18080', extra: 'dropped' } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(got.map((g) => g.task), [{ kind: 'sandbox', verb: 'port', args: 'add 18080' }]);
  });
});

test('/api/dm refuses a sandbox envelope whose verb is rebuild', async () => {
  await withServer(async (server, got) => {
    const res = await post(server, { to: 'board', from: 'lead', origin: 'team-x', body: 'sandbox rebuild',
      task: { kind: 'sandbox', verb: 'rebuild', args: '' } });
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.json, { ok: false, error: 'bad task envelope' });
    assert.deepStrictEqual(got, []);
  });
});

test('/api/dm still hands a done envelope on as kind done', async () => {
  await withServer(async (server, got) => {
    const res = await post(server, { to: 'board', from: 'x', origin: 'p', body: 'r', task: { kind: 'done', id: 't7' } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(got.map((g) => g.task), [{ kind: 'done', id: 't7' }]);
  });
});
