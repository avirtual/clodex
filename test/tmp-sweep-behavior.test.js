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

// Aged LAST, and that ordering is the whole correctness of the fixture: writing
// anything inside a directory resets its mtime to now, so a root aged before its
// contents are filled in reads as fresh and the age gate skips it.
function plant(parent, name, ageDays, fill) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'payload'), 'x');
  if (fill) fill(dir);
  if (ageDays) age(dir, ageDays);
  return dir;
}

function fixture() {
  const parent = path.join(mkTmpRoot('clodex-sweeptest-'), 'T');
  fs.mkdirSync(parent, { recursive: true });
  return parent;
}

function run(parent, args = []) {
  return cp.spawnSync('bash', [SCRIPT, ...args], {
    env: { ...process.env, TMPDIR: parent }, encoding: 'utf8',
  });
}

test('ENTER: the scratch parent satisfies the per-user-temp gate, or every case below is only testing a refusal', () => {
  const parent = fixture();
  plant(parent, 'clodex-aaaaaa', AGED_DAYS);
  const r = run(parent);
  assert.strictEqual(r.status, 0,
    `ENTER: the script must accept a TMPDIR nested under the real one, got status ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /would remove 1 director/,
    'ENTER: the planted aged+matching root must be found, or the gates below are measured against an empty scan');
});

test('a bare invocation removes nothing — dry-run is the default, not an option', () => {
  const parent = fixture();
  const aged = plant(parent, 'clodex-bbbbbb', AGED_DAYS);
  const r = run(parent);
  assert.strictEqual(r.status, 0);
  assert.ok(fs.existsSync(aged), 'a bare run must leave the directory on disk');
  assert.match(r.stdout, /DRY RUN — nothing was removed/);
  assert.doesNotMatch(r.stdout, /^tmp-sweep: removed/m, 'a bare run must not claim to have removed anything');
});

test('--yes removes the aged matching root and spares everything else', () => {
  const parent = fixture();
  const aged = plant(parent, 'clodex-cccccc', AGED_DAYS);
  const fresh = plant(parent, 'clodex-dddddd', 0);
  const foreign = plant(parent, 'somebody-eeeeee', AGED_DAYS);
  const shortSuffix = plant(parent, 'clodex-short', AGED_DAYS);
  const agedFile = path.join(parent, 'clodex-ffffff');
  fs.writeFileSync(agedFile, 'not a directory');
  age(agedFile, AGED_DAYS);

  const r = run(parent, ['--yes']);
  assert.strictEqual(r.status, 0, `expected a clean exit, got ${r.status}: ${r.stderr}`);
  assert.ok(!fs.existsSync(aged), 'the aged matching root is the one thing that must go');
  assert.ok(fs.existsSync(fresh), 'a fresh root is a running suite\'s live fixture — the age gate must spare it');
  assert.ok(fs.existsSync(foreign), 'a prefix we do not mint belongs to another process');
  assert.ok(fs.existsSync(shortSuffix), 'mkdtemp appends six characters; `clodex-short` was not minted by us');
  assert.ok(fs.existsSync(agedFile), 'a matching FILE is not a scratch root');
});

test('--older-than widens the age gate but never reaches a root younger than it', () => {
  const parent = fixture();
  const twoDays = plant(parent, 'clodex-gggggg', 2);
  const tenDays = plant(parent, 'clodex-hhhhhh', 10);

  // 120h, not 240h: a 10-day root is exactly 240h old, and `-mmin +N` is
  // strictly greater, so 240 would be a boundary this test has no reason to sit
  // on. The gate erring young-side-exclusive is the conservative direction.
  const narrow = run(parent, ['--older-than', '120']);
  assert.match(narrow.stdout, /would remove 1 director/, 'a 120h gate must reach only the 10-day root');
  assert.ok(narrow.stdout.includes(path.basename(tenDays)));
  assert.ok(!narrow.stdout.includes(path.basename(twoDays)));

  const wide = run(parent, ['--older-than', '24', '--yes']);
  assert.strictEqual(wide.status, 0, wide.stderr);
  assert.ok(!fs.existsSync(twoDays), 'a 24h gate reaches the 2-day root');
  assert.ok(!fs.existsSync(tenDays));
});

test('a root that cannot be removed is reported, not fatal, and the rest of the batch still goes', () => {
  const parent = fixture();
  const poisoned = plant(parent, 'clodex-iiiiii', AGED_DAYS,
    (dir) => fs.mkdirSync(path.join(dir, 'inner'), { recursive: true }));
  const ordinary = plant(parent, 'clodex-jjjjjj', AGED_DAYS);
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
