'use strict';

const test = require('node:test');
const assert = require('node:assert');
const K = require('../plugins/browser-pane/keys');

const O = 'https://www.e-bloc.ro';

test('keys: well-known volatile params are dropped from the href, real ones kept and sorted by name', () => {
  assert.strictEqual(K.normHref(`${O}/index.php?utm_source=x&page=1&fbclid=a&gclid=b&msclkid=c&_=1&_t=2&cb=3&nocache=4`, O, []), '/index.php?page=1');
  assert.strictEqual(K.normHref(`${O}/a?z=1&b=2&m=3#frag`, O, []), '/a?b=2&m=3&z=1');
  assert.strictEqual(K.normHref('https://other.example/x?id=4', O, []), 'https://other.example/x?id=4');
});

test('keys: t/ts/time/timestamp/rand/r/v are volatile only with a 9+ digit or 16+ alnum value', () => {
  assert.strictEqual(K.normHref(`${O}/index.php?page=1&t=1791145507`, O, []), '/index.php?page=1');
  assert.strictEqual(K.normHref(`${O}/x?v=3`, O, []), '/x?v=3');
  assert.strictEqual(K.normHref(`${O}/x?t=12345678`, O, []), '/x?t=12345678');
  assert.strictEqual(K.normHref(`${O}/x?r=9f8e7d6c5b4a39281706`, O, []), '/x');
  assert.strictEqual(K.normHref(`${O}/x?rand=abc`, O, []), '/x?rand=abc');
});

test('keys: a learned param is dropped; HN item ids and pagination stay distinct', () => {
  assert.strictEqual(K.normHref(`${O}/x?sess=42&a=1`, O, ['sess']), '/x?a=1');
  const hn = 'https://news.ycombinator.com';
  assert.notStrictEqual(K.normHref(`${hn}/item?id=1`, hn, []), K.normHref(`${hn}/item?id=2`, hn, []));
  assert.notStrictEqual(K.normHref(`${hn}/news?p=2`, hn, []), K.normHref(`${hn}/news?p=3`, hn, []));
});

test('keys: key assembly, ordinal+context stored keys and their parse', () => {
  const base = K.keyOf({ kind: 'link', label: 'hide', href: '/hide?id=1' });
  assert.strictEqual(base, 'link\u0000hide\u0000/hide?id=1');
  const s = K.storedKey(base, 2, '  12 points by pg   3 hours ago | hide | 40 comments ');
  assert.strictEqual(s, `${base}#2|12 points by pg 3 hours ago | hide | 40`);
  assert.deepStrictEqual(K.parseStored(s), { base, kind: 'link', label: 'hide', ordinal: 2, context: '12 points by pg 3 hours ago | hide | 40' });
  assert.strictEqual(K.storedKey(base, 0, 'x'), base);
  assert.deepStrictEqual(K.parseStored(K.keyOf({ kind: 'clickable', label: 'C# #1', href: '' })),
    { base: 'clickable\u0000C# #1\u0000', kind: 'clickable', label: 'C# #1', ordinal: 0, context: '' });
});

const el = (label, href) => ({ kind: 'link', label, href });

test('keys: learnVolatile learns a param that differs on a reload of the same document', () => {
  const url = (t) => `${O}/index.php?page=1&t=${t}`;
  assert.deepStrictEqual(K.learnVolatile([el('Mobil', '/index.php?page=1&k=111')], [el('Mobil', '/index.php?page=1&k=222')],
    url(1791145507), url(1791145567), []), ['k']);
  assert.deepStrictEqual(K.learnVolatile([el('Mobil', '/m?page=1&tok=a')], [el('Mobil', '/m?page=1&tok=b')], `${O}/m`, `${O}/m#x`, []), ['tok']);
});

test('keys: learnVolatile never learns across two different pages, an unchanged reload, or a two-param change', () => {
  const hn = 'https://news.ycombinator.com';
  assert.deepStrictEqual(K.learnVolatile([el('More', '/news?p=2')], [el('More', '/news?p=3')], `${hn}/news`, `${hn}/news?p=2`, []), []);
  assert.deepStrictEqual(K.learnVolatile([el('More', '/news?p=3')], [el('More', '/news?p=4')], `${hn}/news?p=2`, `${hn}/news?p=3`, []), []);
  assert.deepStrictEqual(K.learnVolatile([el('item', '/item?id=1'), el('item2', '/item?id=2')], [el('item', '/item?id=1'), el('item2', '/item?id=2')],
    `${hn}/news`, `${hn}/news`, []), []);
  assert.deepStrictEqual(K.learnVolatile([el('Mobil', '/m?a=1&b=1')], [el('Mobil', '/m?a=2&b=2')], `${O}/x`, `${O}/x`, []), []);
});

test('keys: twclid is a well-known volatile param', () => {
  assert.strictEqual(K.normHref('https://x.com/a?twclid=2-abc&q=1', 'https://x.com'), '/a?q=1');
});

test('keys: counterMask blanks a count next to a counter word; amounts and dates keep their digits', () => {
  const rows = [
    ['248 Likes. Like', '# Likes. Like'], ['1.2K views. View post analytics', '# views. View post analytics'],
    ['12 replies. Reply', '# replies. Reply'], ['Following 3', 'Following #'], ['3,104 posts', '# posts'],
    ['19,486', '19,486'], ['Lista de plată 08/2026', 'Lista de plată 08/2026'], ['Index 19,486 lei', 'Index 19,486 lei'],
  ];
  for (const [label, want] of rows) assert.strictEqual(K.counterMask(label), want, label);
  assert.strictEqual(K.counterMask('Notifications (2 unread notifications)'), 'Notifications (# unread notifications)');
  assert.strictEqual(K.actionOf(K.counterMask('248 Likes. Like')), 'like');
  assert.strictEqual(K.actionOf('Like'), 'like');
  assert.strictEqual(K.actionOf(K.counterMask('12 replies. Reply')), 'reply');
  assert.strictEqual(K.actionOf(K.counterMask('1.2K views. View post analytics')), '');
  assert.strictEqual(K.actionOf('19,486'), '');
});
