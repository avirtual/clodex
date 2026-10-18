'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'tmp-sweep.sh');

const AGED_DAYS = 30;

function age(target, days) {
  const when = new Date(Date.now() - days * 86400_000);
  fs.utimesSync(target, when, when);
}

function plant(parent, name, ageDays, fill) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'payload'), 'x');
  if (fill) fill(dir);
  if (ageDays) age(dir, ageDays);
  return dir;
}

const MINE = 'clodex-sweeptest-';

function fixture() {
  const parent = path.join(mkTmpRoot(MINE), 'T');
  fs.mkdirSync(path.join(parent, 'clodex-suite'), { recursive: true });
  return parent;
}

function suite(parent) {
  return path.join(parent, 'clodex-suite');
}

function run(parent, args = []) {
  return cp.spawnSync('bash', [SCRIPT, ...args], {
    env: { ...process.env, TMPDIR: parent }, encoding: 'utf8',
  });
}

test('ENTER: plant() ages a root AFTER filling it, so the fixtures below are really as old as they claim', () => {
  const parent = fixture();
  const filled = plant(parent, `${MINE}aging`, AGED_DAYS,
    (dir) => fs.mkdirSync(path.join(dir, 'inner'), { recursive: true }));
  const ageMs = Date.now() - fs.statSync(filled).mtimeMs;
  assert.ok(ageMs > (AGED_DAYS - 1) * 86400_000,
    'writing inside a directory resets its mtime to now, so a root aged before its contents exist reads '
    + `as fresh and every age-gate case below would be measuring nothing. Age was ${Math.round(ageMs / 1000)}s.`);
});

test('ENTER: the scratch parent satisfies the per-user-temp gate, or every case below is only testing a refusal', () => {
  const parent = fixture();
  plant(suite(parent), 'aaaaaa', AGED_DAYS);
  const r = run(parent);
  assert.strictEqual(r.status, 0,
    `ENTER: the script must accept a TMPDIR nested under the real one, got status ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /would remove 1 director/,
    'ENTER: the planted aged child of the suite root must be found, or the gates below are measured against an empty scan');
});

test('a bare invocation removes nothing — dry-run is the default, not an option', () => {
  const parent = fixture();
  const aged = plant(suite(parent), 'bbbbbb', AGED_DAYS);
  const r = run(parent);
  assert.strictEqual(r.status, 0);
  assert.ok(fs.existsSync(aged), 'a bare run must leave the directory on disk');
  assert.match(r.stdout, /DRY RUN — nothing was removed/);
  assert.doesNotMatch(r.stdout, /^tmp-sweep: removed/m, 'a bare run must not claim to have removed anything');
});

test('--yes removes an aged child of the suite root and spares everything else', () => {
  const parent = fixture();
  const aged = plant(suite(parent), 'cccccc', AGED_DAYS);
  const fresh = plant(suite(parent), 'dddddd', 0);
  const outside = plant(parent, `${MINE}eeeeee`, AGED_DAYS);
  const agedFile = path.join(suite(parent), 'ffffff');
  fs.writeFileSync(agedFile, 'not a directory');
  age(agedFile, AGED_DAYS);

  const r = run(parent, ['--yes']);
  assert.strictEqual(r.status, 0, `expected a clean exit, got ${r.status}: ${r.stderr}`);
  assert.ok(!fs.existsSync(aged), 'the aged child of the suite root is the one thing that must go');
  assert.ok(fs.existsSync(fresh), 'a fresh root is a running suite\'s live fixture — the age gate must spare it');
  assert.ok(fs.existsSync(outside),
    'a child of $TMPDIR outside the suite root belongs to another process, however old it is');
  assert.ok(fs.existsSync(agedFile), 'a FILE in the suite root is not a scratch root');
  assert.ok(fs.existsSync(suite(parent)), 'the suite root itself is never removed');
});

test('--older-than widens the age gate but never reaches a root younger than it', () => {
  const parent = fixture();
  const twoDays = plant(suite(parent), 'gggggg', 2);
  const tenDays = plant(suite(parent), 'hhhhhh', 10);

  const narrow = run(parent, ['--older-than', '120']);
  assert.match(narrow.stdout, /would remove 1 director/,
    'a 120h gate must reach only the 10-day root (120 and not 240: a 10-day root is exactly 240h old '
    + 'and `-mmin +N` is strictly greater, so 240 is a boundary this test has no reason to sit on)');
  assert.ok(narrow.stdout.includes(path.basename(tenDays)));
  assert.ok(!narrow.stdout.includes(path.basename(twoDays)));

  const wide = run(parent, ['--older-than', '24', '--yes']);
  assert.strictEqual(wide.status, 0, wide.stderr);
  assert.ok(!fs.existsSync(twoDays), 'a 24h gate reaches the 2-day root');
  assert.ok(!fs.existsSync(tenDays));
});

test('a symlinked suite root is refused, not followed', () => {
  const parent = path.join(mkTmpRoot(MINE), 'T');
  const elsewhere = path.join(parent, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  const victim = plant(elsewhere, 'kkkkkk', AGED_DAYS);
  fs.symlinkSync(elsewhere, suite(parent));

  const r = run(parent, ['--yes']);
  assert.strictEqual(r.status, 2, `a symlinked suite root must refuse, got status ${r.status}: ${r.stdout}`);
  assert.match(r.stderr, /suite root is a symlink/);
  assert.ok(fs.existsSync(victim), 'the aged directory behind the symlink must survive');
});

test('no suite root means nothing to remove, not an error', () => {
  const parent = path.join(mkTmpRoot(MINE), 'T');
  fs.mkdirSync(parent, { recursive: true });
  const outside = plant(parent, 'llllll', AGED_DAYS);
  const r = run(parent, ['--yes']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing to remove — no suite root/);
  assert.ok(fs.existsSync(outside));
});

test('a root whose INNER directory blocks removal is still counted as a survivor', () => {
  const parent = fixture();
  const root = plant(suite(parent), 'mmmmmm', AGED_DAYS, (dir) => {
    fs.mkdirSync(path.join(dir, 'locked', 'deeper'), { recursive: true });
  });
  const inner = path.join(root, 'locked');
  fs.chmodSync(inner, 0o000);
  try {
    const r = run(parent, ['--yes']);
    assert.ok(fs.existsSync(root),
      'ENTER: the inner chmod must actually block the root\'s removal, or this proves nothing');
    const ageMs = Date.now() - fs.statSync(root).mtimeMs;
    assert.ok(ageMs < 60_000,
      `ENTER: a partial rm must have reset the root's mtime to now (it is ${Math.round(ageMs / 1000)}s old). `
      + 'That reset is the whole hazard: an aged re-enumeration would no longer select this survivor.');
    assert.strictEqual(r.status, 1,
      'the root is still on disk, so the sweep is incomplete. Counting survivors with a second aged '
      + 'enumeration reported 0 here and exited 0 — a false clean sweep over a directory it had not removed.');
    assert.match(r.stderr, /1 could not be removed/);
    assert.doesNotMatch(r.stdout, /^tmp-sweep: removed 1 directories\.$/m,
      'and it must not print the success line while a root it listed is still there');
  } finally {
    fs.chmodSync(inner, 0o755);
  }
});

test('a root that cannot be removed is reported, not fatal, and the rest of the batch still goes', () => {
  const parent = fixture();
  const poisoned = plant(suite(parent), 'iiiiii', AGED_DAYS,
    (dir) => fs.mkdirSync(path.join(dir, 'inner'), { recursive: true }));
  const ordinary = plant(suite(parent), 'jjjjjj', AGED_DAYS);
  fs.chmodSync(poisoned, 0o000);
  try {
    const r = run(parent, ['--yes']);
    assert.ok(fs.existsSync(poisoned), 'ENTER: the chmod must actually block removal, or this proves nothing');
    assert.ok(!fs.existsSync(ordinary), 'one poisoned root must not stop the others being removed');
    assert.strictEqual(r.status, 1, 'an incomplete sweep reports a nonzero status');
    assert.match(r.stderr, /could not be removed/);
  } finally {
    fs.chmodSync(poisoned, 0o755);
  }
});
