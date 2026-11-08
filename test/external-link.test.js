'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isExternallyOpenable, blobChildAllowed } = require('../external-link');

test('isExternallyOpenable: http/https are openable', () => {
  assert.equal(isExternallyOpenable('http://example.com'), true);
  assert.equal(isExternallyOpenable('https://example.com'), true);
  assert.equal(isExternallyOpenable('https://example.com/path?q=1#frag'), true);
  assert.equal(isExternallyOpenable('http://example.com:8080/x'), true);
  assert.equal(isExternallyOpenable('https://user:pass@example.com'), true);
});

test('isExternallyOpenable: scheme casing is normalized', () => {
  assert.equal(isExternallyOpenable('HTTP://example.com'), true);
  assert.equal(isExternallyOpenable('HTTPS://example.com'), true);
  assert.equal(isExternallyOpenable('HtTpS://example.com'), true);
});

test('isExternallyOpenable: non-http(s) schemes are denied', () => {
  assert.equal(isExternallyOpenable('file:///etc/passwd'), false);
  assert.equal(isExternallyOpenable('javascript:alert(1)'), false);
  assert.equal(isExternallyOpenable('data:text/html,<h1>x</h1>'), false);
  assert.equal(isExternallyOpenable('blob:https://example.com/uuid'), false);
  assert.equal(isExternallyOpenable('vbscript:msgbox(1)'), false);
  assert.equal(isExternallyOpenable('chrome://settings'), false);
  assert.equal(isExternallyOpenable('about:blank'), false);
  assert.equal(isExternallyOpenable('ftp://example.com'), false);
});

test('isExternallyOpenable: non-string values are denied', () => {
  assert.equal(isExternallyOpenable(null), false);
  assert.equal(isExternallyOpenable(undefined), false);
  assert.equal(isExternallyOpenable(42), false);
  assert.equal(isExternallyOpenable({}), false);
  assert.equal(isExternallyOpenable(['http://example.com']), false);
});

test('isExternallyOpenable: unparseable / schemeless values are denied', () => {
  assert.equal(isExternallyOpenable(''), false);
  assert.equal(isExternallyOpenable('not a url'), false);
  assert.equal(isExternallyOpenable('example.com'), false);
  assert.equal(isExternallyOpenable('//example.com'), false); // protocol-relative, no scheme
  assert.equal(isExternallyOpenable('/local/path'), false);
});

test('blobChildAllowed: a blob from the opener origin is allowed', () => {
  assert.equal(blobChildAllowed('blob:https://node.example:8443/0b6c-uuid', 'https://node.example:8443/ui/index.html'), true);
  assert.equal(blobChildAllowed('blob:http://127.0.0.1:7777/uuid', 'http://127.0.0.1:7777/'), true);
});

test('blobChildAllowed: other origins and non-blob schemes are denied', () => {
  const opener = 'https://node.example:8443/ui/';
  assert.equal(blobChildAllowed('blob:https://evil.example/uuid', opener), false);
  assert.equal(blobChildAllowed('blob:https://node.example:9999/uuid', opener), false);
  assert.equal(blobChildAllowed('blob:http://node.example:8443/uuid', opener), false);
  assert.equal(blobChildAllowed('javascript:alert(1)', opener), false);
  assert.equal(blobChildAllowed('file:///etc/passwd', opener), false);
  assert.equal(blobChildAllowed('https://node.example:8443/x.png', opener), false);
  assert.equal(blobChildAllowed('blob:file:///uuid', 'file:///app/renderer/index.html'), false);
  assert.equal(blobChildAllowed('blob:null/uuid', 'file:///app/renderer/index.html'), false);
  assert.equal(blobChildAllowed(null, opener), false);
  assert.equal(blobChildAllowed('blob:https://node.example:8443/uuid', ''), false);
});
