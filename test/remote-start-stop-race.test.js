'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { RemoteServer } = require('../remote');

const PAGE = path.join(__dirname, '..', 'renderer', 'remote.html');

function minimal() {
  return new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: PAGE,
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
  });
}

async function withCreatedServers(fn) {
  const created = [];
  const orig = http.createServer;
  http.createServer = function (...args) {
    const s = orig.apply(this, args);
    created.push(s);
    return s;
  };
  try { return await fn(created); } finally {
    http.createServer = orig;
    for (const s of created) { try { s.close(); } catch {} }
  }
}

test('two start() calls before listen resolves yield one server on one port', async () => {
  await withCreatedServers(async (created) => {
    const rs = minimal();
    const first = rs.start();
    const second = rs.start();
    await Promise.all([first, second]);
    try {
      assert.strictEqual(created.length, 1, `start() built ${created.length} http servers`);
      assert.strictEqual(created.filter((s) => s.listening).length, 1, 'exactly one server is listening');
      assert.strictEqual(rs.running, true);
      assert.strictEqual(rs.port, created[0].address().port, 'the reported port is the one server bound');
    } finally { rs.stop(); }
  });
});

test('stop() during a pending start() leaves no listening server, and a fresh start() binds cleanly', async () => {
  await withCreatedServers(async (created) => {
    const rs = minimal();
    const pending = rs.start();
    rs.stop();
    await pending;
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].listening, false, 'the server opened mid-stop was closed, not installed');
    assert.strictEqual(rs.running, false, 'the stopped server did not come back to life');

    await rs.start();
    try {
      assert.strictEqual(rs.running, true);
      assert.strictEqual(created.length, 2);
      assert.strictEqual(created[1].listening, true, 'the fresh start bound');
      assert.strictEqual(rs.port, created[1].address().port);
    } finally { rs.stop(); }
    assert.strictEqual(created[1].listening, false);
  });
});

test('start() after a stop() issued mid-start cancels the stop and installs the pending server', async () => {
  await withCreatedServers(async (created) => {
    const rs = minimal();
    const pending = rs.start();
    rs.stop();
    const again = rs.start();
    await Promise.all([pending, again]);
    try {
      assert.strictEqual(created.length, 1);
      assert.strictEqual(rs.running, true, 'the latest intent was start');
      assert.strictEqual(created[0].listening, true);
    } finally { rs.stop(); }
  });
});
