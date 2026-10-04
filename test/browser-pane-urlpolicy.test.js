'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { compile, compilePolicy, validate, typedUrl, MAX_PATTERNS, MAX_CHARS } = require('../plugins/browser-pane/urlpolicy');

const STAR = '"*" is allowed only as a leading "*." on the host or a trailing "/*" on the path';

test('urlpolicy: every grammar form matches what it names and nothing else', () => {
  const rows = [
    ['example.com', 'https://example.com/', 'example.com'],
    ['example.com', 'http://example.com/a/b?q=1', 'example.com'],
    ['example.com', 'https://deep.sub.example.com/x', 'example.com'],
    ['example.com', 'https://notexample.com/', null],
    ['example.com', 'https://example.com.evil.net/', null],
    ['*.example.com', 'https://example.com/', null],
    ['*.example.com', 'https://a.example.com/', '*.example.com'],
    ['*.example.com', 'https://a.b.example.com/', '*.example.com'],
    ['example.com/path/*', 'https://example.com/path/x', 'example.com/path/*'],
    ['example.com/path/*', 'https://example.com/path/', 'example.com/path/*'],
    ['example.com/path/*', 'https://example.com/path', null],
    ['example.com/path/*', 'https://example.com/other/path/x', null],
    ['example.com/path/*', 'https://sub.example.com/path/x', 'example.com/path/*'],
    ['example.com/exact', 'https://example.com/exact', 'example.com/exact'],
    ['example.com/exact', 'https://example.com/exact/more', null],
    ['http://example.com', 'http://example.com/', 'http://example.com'],
    ['http://example.com', 'https://example.com/', null],
    ['https://example.com/a/*', 'https://example.com/a/b', 'https://example.com/a/*'],
    ['127.0.0.1/blocked/*', 'http://127.0.0.1:4567/blocked/x', '127.0.0.1/blocked/*'],
    ['EXAMPLE.com', 'https://Example.COM/', 'EXAMPLE.com'],
    ['example.com/Path/*', 'https://example.com/path/x', null],
    ['example.com/Path/*', 'https://EXAMPLE.com/Path/x', 'example.com/Path/*'],
    ['example.com', 'about:blank', null],
    ['example.com', 'not a url', null],
  ];
  for (const [pattern, url, want] of rows) assert.strictEqual(compile([pattern])(url), want, `${pattern} vs ${url}`);
});

test('urlpolicy: an allow exception is checked before every deny, in either list', () => {
  const check = compile(['example.com', '!example.com/ok/*']);
  assert.strictEqual(check('https://example.com/ok/1'), null);
  assert.strictEqual(check('https://example.com/no'), 'example.com');
  assert.strictEqual(compile(['!example.com/ok/*', 'example.com'])('https://example.com/ok/1'), null);
  const policy = compilePolicy({ global: ['example.com', '!example.com/svc-ok/*'], service: ['ads.net', '!example.com/ok/*'] });
  assert.strictEqual(policy('https://example.com/ok/1'), null);
  assert.strictEqual(policy('https://example.com/svc-ok/1'), null);
  assert.deepStrictEqual(policy('https://example.com/x'), { pattern: 'example.com', list: 'global' });
  assert.deepStrictEqual(policy('https://cdn.ads.net/x'), { pattern: 'ads.net', list: 'service' });
  assert.strictEqual(compilePolicy(undefined)('https://example.com/'), null);
});

test('urlpolicy: invalid patterns are rejected with the reason and their 1-based line', () => {
  const rows = [
    ['ftp://example.com', 'only http:// or https:// may lead a pattern, not ftp://'],
    ['ex*ample.com', STAR],
    ['*example.com', STAR],
    ['example.com/a*/b', STAR],
    ['example.com:8080', 'ports and IPv6 hosts are not supported; a host pattern matches every port'],
    ['[::1]', 'ports and IPv6 hosts are not supported; a host pattern matches every port'],
    ['example.com/?q=1', 'queries, fragments and spaces are not supported'],
    ['exa mple.com', 'queries, fragments and spaces are not supported'],
    ['ex_am$ple.com', '"ex_am$ple.com" is not a valid host'],
    ['/only/path', 'no host'],
    ['!', 'no host'],
    ['x'.repeat(MAX_CHARS + 1), `longer than ${MAX_CHARS} characters`],
  ];
  for (const [pattern, error] of rows) assert.deepStrictEqual(validate(['ok.com', pattern]), { ok: false, error, line: 2 }, pattern);
  assert.deepStrictEqual(validate([42]), { ok: false, error: 'a pattern must be text', line: 1 });
  assert.deepStrictEqual(validate('example.com'), { ok: false, error: 'patterns must be a list', line: 0 });
});

test('urlpolicy: limits are 200 patterns per list and 512 characters each, blank lines skipped', () => {
  const many = Array.from({ length: MAX_PATTERNS }, (_, i) => `h${i}.example.com`);
  assert.strictEqual(MAX_PATTERNS, 200);
  assert.strictEqual(MAX_CHARS, 512);
  assert.deepStrictEqual(validate(['', ...many, '  ']), { ok: true, patterns: many });
  assert.deepStrictEqual(validate([...many, 'one-more.com']), { ok: false, error: 'more than 200 patterns', line: 201 });
  const long = `example.com/${'a'.repeat(MAX_CHARS - 12)}`;
  assert.strictEqual(long.length, MAX_CHARS);
  assert.deepStrictEqual(validate([long]), { ok: true, patterns: [long] });
  assert.deepStrictEqual(validate(['  example.com  ']), { ok: true, patterns: ['example.com'] });
});

test('urlpolicy: a typed address gains https:// unless it carries a scheme', () => {
  assert.strictEqual(typedUrl(' example.com/a '), 'https://example.com/a');
  assert.strictEqual(typedUrl('localhost:3000/x'), 'https://localhost:3000/x');
  assert.strictEqual(typedUrl('http://example.com'), 'http://example.com');
  assert.strictEqual(typedUrl('javascript:alert(1)'), 'javascript:alert(1)');
  assert.strictEqual(typedUrl('   '), '');
});
