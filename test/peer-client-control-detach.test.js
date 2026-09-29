'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { PeerConnection } = require('../peer-client');

function fixture() {
  const conn = new PeerConnection({ id: 'box', label: 'box', url: 'http://127.0.0.1:9', emit: () => {} });
  const calls = [];
  conn._request = (method, p, body, cb) => { calls.push({ method, p, body, cb }); };
  const releases = () => calls.filter((c) => c.body && c.body.action === 'release');
  return { conn, calls, releases };
}

test('a control token acquired for an attachment detached mid-request is released, not kept', () => {
  const { conn, calls, releases } = fixture();
  conn.attach('sess');
  const att = conn._attachments.get('sess');
  let result = null;
  conn.control('sess', true, (r) => { result = r; });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].body.action, 'acquire');

  conn.detach('sess');
  assert.strictEqual(releases().length, 0, 'ENTER: detach had no token to release yet');

  calls[0].cb(null, { ok: true, token: 'tok-1' });
  assert.deepStrictEqual(result, { ok: false, error: 'detached' });
  assert.strictEqual(att.token, null, 'the detached attachment never holds the token');
  assert.strictEqual(releases().length, 1, 'the minted token was released on the box');
  assert.strictEqual(releases()[0].body.token, 'tok-1');
  assert.strictEqual(releases()[0].p, '/api/sessions/sess/control');
  conn.stop();
});

test('a re-attach during the acquire does not inherit the old attachment\'s token', () => {
  const { conn, calls, releases } = fixture();
  conn.attach('sess');
  let result = null;
  conn.control('sess', true, (r) => { result = r; });
  conn.detach('sess');
  conn.attach('sess');
  const fresh = conn._attachments.get('sess');

  calls[0].cb(null, { ok: true, token: 'tok-2' });
  assert.deepStrictEqual(result, { ok: false, error: 'detached' });
  assert.strictEqual(fresh.token, null);
  assert.deepStrictEqual(releases().map((c) => c.body.token), ['tok-2']);
  conn.stop();
});

test('an acquire that lands on a live attachment keeps its token and releases nothing', () => {
  const { conn, calls, releases } = fixture();
  conn.attach('sess');
  let result = null;
  conn.control('sess', true, (r) => { result = r; });

  calls[0].cb(null, { ok: true, token: 'tok-3' });
  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(conn._attachments.get('sess').token, 'tok-3');
  assert.strictEqual(releases().length, 0);
  conn.stop();
});

test('control off during an in-flight acquire releases the token it minted and does not store it', () => {
  const { conn, calls, releases } = fixture();
  conn.attach('sess');
  const att = conn._attachments.get('sess');
  let result = null;
  conn.control('sess', true, (r) => { result = r; });
  let offResult = null;
  conn.control('sess', false, (r) => { offResult = r; });
  assert.deepStrictEqual(offResult, { ok: true });
  assert.strictEqual(releases().length, 0, 'ENTER: off had no token to release yet');

  calls[0].cb(null, { ok: true, token: 'tok-4' });
  assert.deepStrictEqual(result, { ok: false, error: 'released' });
  assert.strictEqual(att.token, null, 'the released attachment never holds the token');
  assert.deepStrictEqual(releases().map((c) => c.body.token), ['tok-4']);
  conn.stop();
});

test('a second acquire after an off supersedes the first', () => {
  const { conn, calls, releases } = fixture();
  conn.attach('sess');
  const att = conn._attachments.get('sess');
  let resultA = null;
  let resultB = null;
  conn.control('sess', true, (r) => { resultA = r; });
  const acquireA = calls[calls.length - 1];
  conn.control('sess', false, () => {});
  conn.control('sess', true, (r) => { resultB = r; });
  const acquireB = calls[calls.length - 1];
  assert.notStrictEqual(acquireA, acquireB);

  acquireA.cb(null, { ok: true, token: 'tok-A' });
  assert.deepStrictEqual(resultA, { ok: false, error: 'released' });
  assert.strictEqual(att.token, null);
  assert.deepStrictEqual(releases().map((c) => c.body.token), ['tok-A']);

  acquireB.cb(null, { ok: true, token: 'tok-B' });
  assert.deepStrictEqual(resultB, { ok: true });
  assert.strictEqual(att.token, 'tok-B');
  assert.deepStrictEqual(releases().map((c) => c.body.token), ['tok-A']);
  conn.stop();
});
