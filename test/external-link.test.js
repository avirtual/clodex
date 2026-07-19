'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isExternallyOpenable } = require('../external-link');

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
