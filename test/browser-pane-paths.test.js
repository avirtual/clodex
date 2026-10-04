'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { resolveTo, scopeCwd, sanitizeName, landedInside, directHref, NAME_MAX } = require('../plugins/browser-pane/paths');

function fixture() {
  const top = fs.realpathSync(mkTmpRoot('clodex-bp-paths-'));
  const cwd = path.join(top, 'cwd');
  const old = path.join(top, 'cwd-old');
  const outside = path.join(top, 'outside');
  for (const d of [cwd, old, outside, path.join(cwd, 'bills')]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(outside, path.join(cwd, 'out-link'));
  return { top, cwd, old, outside };
}

const refusal = (cwd) => ({ message: `--to must name a folder inside your working directory (${cwd})` });

test('resolveTo: literal cases', () => {
  const { cwd, old, outside } = fixture();
  const rows = [
    ['relative inside', 'bills', path.join(cwd, 'bills')],
    ['absolute inside', path.join(cwd, 'bills'), path.join(cwd, 'bills')],
    ['the cwd itself', '.', cwd],
    ['the cwd itself, absolute', cwd, cwd],
    ['a nested non-existent dir is created', 'bills/2026/08', path.join(cwd, 'bills', '2026', '08')],
  ];
  for (const [label, to, want] of rows) {
    assert.strictEqual(resolveTo(cwd, to), want, label);
    assert.ok(fs.statSync(want).isDirectory(), label);
  }
  const bad = [
    ['.. escape', '../outside'],
    ['.. escape to a new dir', '../made-up'],
    ['symlink-out escape', 'out-link'],
    ['symlink-out escape, nested new dir', 'out-link/new'],
    ['the prefix sibling, relative', '../cwd-old'],
    ['the prefix sibling, absolute', old],
    ['absolute outside', outside],
    ['empty', ''],
  ];
  for (const [label, to] of bad) assert.throws(() => resolveTo(cwd, to), refusal(cwd), label);
  assert.ok(!fs.existsSync(path.join(path.dirname(cwd), 'made-up')));
  assert.ok(!fs.existsSync(path.join(outside, 'new')));
});

test('scopeCwd: fsScope errors', () => {
  assert.strictEqual(scopeCwd({ cwd: '/repo/a' }), '/repo/a');
  assert.throws(() => scopeCwd({ error: 'remote' }), { message: 'downloads to a folder need a local session (this one is remote)' });
  assert.throws(() => scopeCwd({ error: 'Session not found' }),
    { message: 'downloads to a folder need a session with a working directory (Session not found)' });
  assert.throws(() => scopeCwd({ error: 'Session has no working directory' }),
    { message: 'downloads to a folder need a session with a working directory (Session has no working directory)' });
});

test('landedInside: a file reached through a symlink out of the cwd is outside', () => {
  const { cwd, outside } = fixture();
  fs.writeFileSync(path.join(cwd, 'bills', 'a.pdf'), 'x');
  fs.writeFileSync(path.join(outside, 'b.pdf'), 'x');
  assert.strictEqual(landedInside(cwd, path.join(cwd, 'bills', 'a.pdf')), true);
  assert.strictEqual(landedInside(cwd, path.join(cwd, 'out-link', 'b.pdf')), false);
  assert.strictEqual(landedInside(cwd, path.join(cwd, 'missing.pdf')), false);
});

test('sanitizeName: literal cases', () => {
  const rows = [
    ['2026-08.pdf', 'application/pdf', '2026-08.pdf'],
    ['../../etc/passwd', null, 'passwd'],
    ['a\\b\\bill.pdf', null, 'bill.pdf'],
    ['bi\u0000ll\u001f\u007f.pdf', null, 'bill.pdf'],
    ['', 'application/pdf', 'download.pdf'],
    ['', null, 'download'],
    ['..', null, 'download'],
    ['/', null, 'download'],
    ['statement', 'application/pdf', 'statement.pdf'],
    ['statement', 'application/pdf; charset=binary', 'statement.pdf'],
    ['report', 'text/csv', 'report.csv'],
    ['notes', 'application/x-unknown', 'notes'],
    ['.hidden.pdf', null, 'hidden.pdf'],
    ['a:b?.pdf', null, 'a_b_.pdf'],
  ];
  for (const [name, mime, want] of rows) assert.strictEqual(sanitizeName(name, mime), want, JSON.stringify(name));
  const long = sanitizeName('x'.repeat(500) + '.pdf', null);
  assert.strictEqual(long.length, NAME_MAX);
  assert.ok(long.endsWith('.pdf'));
});

test('directHref: download strategy 1 only for a link that leaves the page', () => {
  const page = 'https://portal.example.com/bills?m=2026-08';
  const rows = [
    ['https://portal.example.com/bills/2026-08.pdf', true],
    ['https://cdn.example.com/x.pdf', true],
    ['https://portal.example.com/bills?m=2026-08#', false],
    ['https://portal.example.com/bills?m=2026-08#row-3', false],
    ['https://portal.example.com/bills?m=2026-08', false],
    ['#', false],
    ['javascript:void(0)', false],
    ['', false],
  ];
  for (const [href, want] of rows) assert.strictEqual(directHref(href, page), want, href);
});
