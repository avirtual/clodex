'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { PeerConnection } = require('../peer-client');

test('query: a 2 MiB reply is accepted for filePeek and refused as too large for any other kind', async () => {
  const payload = JSON.stringify({ ok: true, content: 'A'.repeat(2 * 1024 * 1024) });
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const conn = new PeerConnection({ id: 'p', label: 'p', url: `http://127.0.0.1:${port}`, emit: () => {} });
  const ask = (kind) => new Promise((resolve) => conn.query('seat', kind, {}, resolve));
  try {
    const peek = await ask('filePeek');
    assert.deepStrictEqual([peek.ok, peek.content.length], [true, 2 * 1024 * 1024]);
    assert.deepStrictEqual(await ask('fileDiff'), { ok: false, error: 'response too large' });
  } finally {
    conn.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
