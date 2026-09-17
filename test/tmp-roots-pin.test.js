'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { codeOnly } = require('../comment-census.js');

const TEST_DIR = __dirname;
const HELPER = path.join('lib', 'tmp-roots.js');
const RAW = `mkdtemp${'Sync'}`;
const CALL = new RegExp(`\\bmkdtemp${'(Sync)?'}\\s*\\(`);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, out);
    else if (/\.(c|m)?js$/.test(ent.name)) out.push(abs);
  }
  return out;
}

test('ENTER: the detector reads code, not text — a URL does not hide a call, a comment and a string do not forge one', () => {
  const behindUrl = `const u = 'http://x'; fs.mkdtemp${'Sync'}(p);`;
  const lines = (src) => codeOnly(src).split('\n').filter((l) => CALL.test(l)).length;

  assert.strictEqual(lines(behindUrl), 1,
    'splitting a line on `//` truncates it at the `//` of a URL and drops everything after — including the '
    + 'raw mint the scan exists to find. Every leaked root the old detector missed looked exactly like this.');
  assert.strictEqual(lines(`// fs.mkdtemp${'Sync'}(p);`), 0, 'prose naming the call is not a call');
  assert.strictEqual(lines(`const s = 'fs.mkdtemp${'Sync'}(p)';`), 0, 'nor is a string that spells it');
});

test(`no test file outside ${HELPER} mints a scratch root with a raw ${RAW}`, () => {
  const files = walk(TEST_DIR);
  assert.ok(files.length > 300,
    `ENTER: the scan must actually visit the suite — it found ${files.length} .js files under ${TEST_DIR}, `
    + 'which means the walk is broken and every assertion below passes vacuously');

  const helper = files.filter((f) => path.relative(TEST_DIR, f) === HELPER);
  assert.strictEqual(helper.length, 1, `ENTER: ${HELPER} must exist for the conversion to have a target`);
  assert.ok(CALL.test(codeOnly(fs.readFileSync(helper[0], 'utf8'))),
    `ENTER: ${HELPER} is the one place that may call ${RAW}, and it no longer does — `
    + `the detector below matches nothing, so its green means nothing`);

  const offenders = [];
  for (const abs of files) {
    const rel = path.relative(TEST_DIR, abs);
    if (rel === HELPER) continue;
    const lines = codeOnly(fs.readFileSync(abs, 'utf8')).split('\n');
    lines.forEach((line, i) => { if (CALL.test(line)) offenders.push(`test/${rel}:${i + 1}`); });
  }

  assert.deepStrictEqual(offenders, [],
    `These call sites mint a scratch directory that NOTHING ever removes. A full suite run used to leave `
    + `thousands behind in $TMPDIR and they accumulated into the hundreds of thousands, pegging fseventsd at `
    + `100% CPU (t498, t927). Call mkTmpRoot('prefix') from test/lib/tmp-roots.js instead — it mints the same `
    + `directory and registers it for the top-level sweep. For a directory inside a root that is ALREADY `
    + `tracked, call mkTmpDirIn(parent, 'prefix'). Do NOT add an exemption here: an exempt file leaks exactly `
    + `as much as an unconverted one, and the next reader takes it as precedent.`);
});

test('mkTmpDirIn refuses a parent that is not already tracked', () => {
  const { mkTmpRoot, mkTmpDirIn } = require('./lib/tmp-roots');

  const tracked = mkTmpRoot('tmp-roots-pin-');
  const nested = mkTmpDirIn(tracked, 'child-');
  assert.ok(fs.existsSync(nested), 'ENTER: the sanctioned call really does mint, so the throws below are the guard');
  assert.ok(fs.existsSync(mkTmpDirIn(nested, 'grandchild-')),
    'ENTER: and a directory deeper inside a tracked root is sanctioned too');

  assert.throws(() => mkTmpDirIn(os.tmpdir(), 'tmp-roots-pin-escape-'), /ALREADY tracks/,
    'the message the pin advertises would otherwise be a second, unswept route into $TMPDIR');
  assert.throws(() => mkTmpDirIn(path.join(tracked, '..'), 'tmp-roots-pin-dotdot-'), /ALREADY tracks/,
    'and a `..` back out of a tracked root reaches the same untracked parent');

  assert.throws(() => mkTmpDirIn(`${tracked}/../tmp-roots-pin-untracked-sibling`, 'tmp-roots-pin-escape-'), /ALREADY tracks/,
    'an UN-NORMALIZED `<root>/../<sibling>` is a string that starts with the tracked root and resolves outside '
    + 'the directory the caller named, so a raw startsWith waves it through and mints where the sweep will not look');

  fs.mkdirSync(path.join(tracked, 'b'));
  const normalized = mkTmpDirIn(`${tracked}/a/../b`, 'tmp-roots-pin-norm-');
  assert.strictEqual(path.dirname(normalized), path.join(tracked, 'b'),
    'and a `..` that resolves back INSIDE the tracked root is accepted and mints at the resolved path — '
    + 'the check and the mint must agree on which directory the caller meant');

  const escaped = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('tmp-roots-pin-escape-') || n.startsWith('tmp-roots-pin-dotdot-'));
  assert.deepStrictEqual(escaped, [],
    'the refusal happens BEFORE the mint — a throw that left a directory behind leaks exactly what it refused. '
    + "Scanned by this file's OWN prefixes rather than by an entry count: $TMPDIR is shared with every other "
    + 'process on the box, so a total is not stable across two reads.');
});
