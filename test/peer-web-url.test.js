'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { directWebUrl } = require('../peer-web-url');

test('t923: the HOST comes from the record, never from a loopback literal — url-kind does not mean local', () => {
  assert.equal(directWebUrl('http://localhost:7900', 7902), 'http://localhost:7902');
  assert.equal(directWebUrl('http://127.0.0.1:7900', 7902), 'http://127.0.0.1:7902');
  assert.equal(directWebUrl('http://box.example:7900', 7902), 'http://box.example:7902',
    'a hardcoded 127.0.0.1 passes on a box whose peers are local and lies on every other box');
  assert.equal(directWebUrl('http://10.1.2.3:7900', 8080), 'http://10.1.2.3:8080');
});

test('t923: the SCHEME is kept — an https peer must not be downgraded to http', () => {
  assert.equal(directWebUrl('https://box.example:7900', 7902), 'https://box.example:7902');
  assert.equal(directWebUrl('https://box.example', 443), 'https://box.example:443');
});

test('t923: the PORT is the ADVERTISED one, replacing the record`s own wire port', () => {
  assert.equal(directWebUrl('http://box.example:7900', 7902), 'http://box.example:7902',
    'keeping the record`s port would open the peer API, which is a different listener');
  assert.equal(directWebUrl('http://box.example', 7902), 'http://box.example:7902',
    'an implicit :80 is replaced too');
});

test('t923: path, query and fragment on the record are DROPPED, not carried into the web address', () => {
  assert.equal(directWebUrl('http://box.example:7900/api/peer', 7902), 'http://box.example:7902',
    'a record`s path is the peer API`s prefix, not a location in the web UI served on another port');
  assert.equal(directWebUrl('http://box.example:7900/?workspace=w1', 7902), 'http://box.example:7902');
  assert.equal(directWebUrl('http://box.example:7900#frag', 7902), 'http://box.example:7902');
});

test('t923: an IPv6 host recomposes in the bracketed form a URL needs', () => {
  assert.equal(directWebUrl('http://[::1]:7900', 7902), 'http://[::1]:7902');
});

test('t923: a port that is not a usable integer yields null — the t30a rule, at the composer', () => {
  for (const port of [undefined, null, 0, -1, 70000, 65536, 8080.5, '8080', NaN, Infinity]) {
    assert.strictEqual(directWebUrl('http://box.example:7900', port), null,
      `${JSON.stringify(port)} → null: an absent or nonsense port means "no web host", never "try something"`);
  }
  assert.equal(directWebUrl('http://box.example', 65535), 'http://box.example:65535',
    'the top of the range is still in');
  assert.equal(directWebUrl('http://box.example', 1), 'http://box.example:1');
});

test('t923: CREDENTIALS in the record never reach the composed address', () => {
  assert.equal(directWebUrl('http://user:pass@box.example:7900', 7902), 'http://box.example:7902',
    'userinfo handed to openExternal would put the operator`s password in a browser history and a shell log');
  assert.equal(directWebUrl('http://user@evil.com@good.com', 7902), 'http://good.com:7902',
    'the host is what follows the LAST @ — reading up to the first would dial evil.com');
});

test('t923: an unreadable or non-http url yields null rather than throwing into a repaint', () => {
  for (const url of [
    undefined, null, '', '   ', 'box.example:7900', '/relative', 'not a url',
    'ftp://box.example', 'file:///etc/passwd', 'javascript:alert(1)', {}, 42,
  ]) {
    assert.strictEqual(directWebUrl(url, 7902), null,
      `${JSON.stringify(url)} → null: this runs inside renderPeers, where a throw takes out the whole `
      + 'sidebar repaint, and a non-http scheme handed to openExternal would launch a helper app');
  }
});
