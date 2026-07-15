'use strict';
// Unit tests for renderer/lib/drop-paths.js — shell-quoting for drag-dropped
// file paths. The quoting branch is the part with sharp edges (spaces, single
// quotes, shell metacharacters), so it's pinned here.

const test = require('node:test');
const assert = require('node:assert');
const { shellQuotePath, dropText } = require('../renderer/lib/drop-paths');

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
