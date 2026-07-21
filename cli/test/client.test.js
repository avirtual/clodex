'use strict';
// client.test.js — the WireClient's header building + token scrub, without a
// real socket where possible (scrub is pure; header shape via a fake fetch).
const { test } = require('node:test');
const assert = require('node:assert');
const { WireClient, scrub, parseSseBlock } = require('../src/client');

test('scrub replaces the token everywhere', () => {
  assert.strictEqual(scrub('a TOK b TOK', 'TOK'), 'a *** b ***');
  assert.strictEqual(scrub('no secret', 'TOK'), 'no secret');
  assert.strictEqual(scrub('x', null), 'x');
});

test('Bearer header set only when a token is present', async () => {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, text: async () => '{"ok":true}' }; };
  try {
    await new WireClient('http://h', 'TOK').get('/api/x', 'x');
    assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer TOK');
    await new WireClient('http://h', null).get('/api/x', 'x');
    assert.strictEqual(calls[1].init.headers.Authorization, undefined);
  } finally { global.fetch = orig; }
});

test('non-2xx maps to a coded CliError with the server error text', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, text: async () => '{"ok":false,"error":"no such session"}' });
  try {
    await assert.rejects(new WireClient('http://h', 't').get('/api/x', 'logs'), (e) => {
      assert.strictEqual(e.exitCode, 5);
      assert.match(e.message, /logs failed: no such session/);
      return true;
    });
  } finally { global.fetch = orig; }
});

test('a network throw becomes EXIT.CONNECT', async () => {
  const orig = global.fetch;
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    await assert.rejects(new WireClient('http://h', 'realistic-32char-tok').get('/api/x', 'info'), (e) => {
      assert.strictEqual(e.exitCode, 3);
      assert.match(e.message, /cannot reach the engine/);
      return true;
    });
  } finally { global.fetch = orig; }
});

test('parseSseBlock: event + data, comments and dataless blocks skipped', () => {
  assert.deepStrictEqual(parseSseBlock('event: output\ndata: {"b64":"aGk="}'), { event: 'output', data: '{"b64":"aGk="}' });
  // leading space after the colon is trimmed (SSE spec), one space only
  assert.deepStrictEqual(parseSseBlock('event:activity\ndata:  x'), { event: 'activity', data: ' x' });
  // multiple data lines join with \n; comment lines ignored
  assert.deepStrictEqual(parseSseBlock(': ping\ndata: a\ndata: b'), { event: null, data: 'a\nb' });
  // comment-only / dataless → null
  assert.strictEqual(parseSseBlock(': connected'), null);
  assert.strictEqual(parseSseBlock('event: x'), null);
});
