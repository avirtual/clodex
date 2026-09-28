'use strict';
// Unit tests for renderer/lib/drop-paths.js — shell-quoting for drag-dropped
// file paths. The quoting branch is the part with sharp edges (spaces, single
// quotes, shell metacharacters), so it's pinned here.

const test = require('node:test');
const assert = require('node:assert');
const { shellQuotePath, atMentionPath, dropText } = require('../renderer/lib/drop-paths');

test('shellQuotePath: a plain path stays bare', () => {
  assert.strictEqual(shellQuotePath('/Users/me/project/file.js'), '/Users/me/project/file.js');
  assert.strictEqual(shellQuotePath('~/notes/2026-07.md'), '~/notes/2026-07.md');
});

test('shellQuotePath: spaces force single-quoting (the Application Support case)', () => {
  assert.strictEqual(
    shellQuotePath('/Users/me/Library/Application Support/clodex/x.json'),
    `'/Users/me/Library/Application Support/clodex/x.json'`,
  );
});

test('shellQuotePath: embedded single quote is closed-escaped-reopened', () => {
  assert.strictEqual(shellQuotePath(`/tmp/it's here.txt`), `'/tmp/it'\\''s here.txt'`);
});

test('shellQuotePath: shell metacharacters are quoted, not interpreted', () => {
  assert.strictEqual(shellQuotePath('/tmp/$(rm -rf).txt'), `'/tmp/$(rm -rf).txt'`);
  assert.strictEqual(shellQuotePath('/tmp/a;b&c.txt'), `'/tmp/a;b&c.txt'`);
});

test('dropText: space-joins and appends ONE trailing space', () => {
  assert.strictEqual(dropText(['/a/b', '/c d']), `/a/b '/c d' `);
});

test('dropText: empty or all-falsy input produces the empty string (no lone space)', () => {
  assert.strictEqual(dropText([]), '');
  assert.strictEqual(dropText(null), '');
  assert.strictEqual(dropText([null, '']), '');
});

test('atMentionPath: plain path gets the @ prefix', () => {
  assert.strictEqual(atMentionPath('/Users/me/project/file.js'), '@/Users/me/project/file.js');
});

test('atMentionPath: spaces are backslash-escaped (the CLI completion form)', () => {
  assert.strictEqual(
    atMentionPath('/Users/me/Library/Application Support/x.json'),
    '@/Users/me/Library/Application\\ Support/x.json',
  );
});

test('atMentionPath: mention-breaking bytes bail to null (caller falls back to shell quoting)', () => {
  assert.strictEqual(atMentionPath(`/tmp/it's here.txt`), null);
  assert.strictEqual(atMentionPath('/tmp/$(x).txt'), null);
});

test('dropText claude style: @-mentions, per-path shell fallback for unmentionables', () => {
  assert.strictEqual(dropText(['/a/b.js', '/c d.txt'], 'claude'), '@/a/b.js @/c\\ d.txt ');
  assert.strictEqual(dropText([`/it's.txt`], 'claude'), `'/it'\\''s.txt' `);
});

test('dropText default style: shell quoting unchanged', () => {
  assert.strictEqual(dropText(['/a/b', '/c d']), `/a/b '/c d' `);
});

test('dropText never emits a raw control byte, whatever the filename contains', () => {
  const paths = ['/tmp/a\rb.txt', "/tmp/x'\recho pwned\r'.txt", '/tmp/e\x1b[A.txt', '/tmp/n\nl.txt', '/tmp/d\x7f\\.txt'];
  for (const p of paths) assert.match(p, /[\x00-\x1f\x7f]/u, `ENTER: ${JSON.stringify(p)} carries a control byte`);
  for (const style of [undefined, 'claude']) {
    const out = dropText(paths, style);
    assert.doesNotMatch(out, /[\x00-\x1f\x7f]/u, `style ${style}`);
  }
  assert.strictEqual(shellQuotePath('/tmp/a\rb.txt'), "$'/tmp/a\\x0db.txt'");
  assert.strictEqual(shellQuotePath("/tmp/x'\r\\y"), "$'/tmp/x\\'\\x0d\\\\y'");
});
