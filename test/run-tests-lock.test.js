'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ROOT = path.join(__dirname, '..');
const DEAD_PID = '999999';

function mkRoot(stubBody = "require('node:test').test('stub', () => {});\n") {
  const root = mkTmpRoot('runner-lock-');
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const f of ['run-tests.js', 'test-escapes.js']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(root, 'scripts', f));
  }
  fs.writeFileSync(path.join(root, 'stub.test.js'), stubBody);
  return { root, lockDir: path.join(root, '.test-digest.lock') };
}

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.CLODEX_TEST_LOCK_DIR;
  delete env.CLODEX_TEST_LOCK_NOTE_FD;
  if (!('CLODEX_TEST_LOCK_WAIT_MS' in extra)) delete env.CLODEX_TEST_LOCK_WAIT_MS;
  if (!('CLODEX_TEST_LOCK_MERGE' in extra)) delete env.CLODEX_TEST_LOCK_MERGE;
  return env;
}

function runSync(root, argv = []) {
  return spawnSync(process.execPath, [...argv, path.join(root, 'scripts', 'run-tests.js')],
    { encoding: 'utf-8', cwd: root, timeout: 120000, env: childEnv() });
}

test('lock: a live holder makes a waiting runner queue, and it takes the lock once the dir is gone', async () => {
  const { root, lockDir } = mkRoot();
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
  try {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'run-tests.js')],
      { cwd: root, env: childEnv({ CLODEX_TEST_LOCK_WAIT_MS: '100000' }) });
    let out = '';
    let err = '';
    let released = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => {
      err += d;
      if (!released && /queued behind pid/.test(err)) {
        released = true;
        assert.ok(fs.existsSync(path.join(lockDir, 'pid')), 'the live holder\'s lock was not reclaimed while queued');
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.ok(released, `ENTER: the runner never queued behind pid ${process.pid}; stderr ${JSON.stringify(err)}`);
    assert.match(err, /lock acquired after/);
    assert.match(out, /TOTALS: [1-9]\d* pass, 0 fail, [1-9]\d* tests/);
    assert.strictEqual(code, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lock: a lock whose pid file names a dead pid is reclaimed', () => {
  const { root, lockDir } = mkRoot();
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), DEAD_PID);
  try {
    const res = runSync(root);
    assert.match(res.stdout, /TOTALS: [1-9]\d* pass, 0 fail, [1-9]\d* tests/);
    assert.strictEqual(res.status, 0);
    assert.ok(!fs.existsSync(lockDir), 'the run released the lock it reclaimed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lock: release leaves a lock whose pid file names another pid', () => {
  const { root, lockDir } = mkRoot("const fs = require('fs'); require('node:test').test('stub', () => {"
    + ` fs.writeFileSync('.test-digest.lock/pid', '${DEAD_PID}'); });\n`);
  try {
    const res = runSync(root);
    assert.match(res.stdout, /TOTALS: [1-9]\d* pass, 0 fail, [1-9]\d* tests/);
    assert.ok(fs.existsSync(lockDir), 'the runner removed a lock it no longer owns');
    assert.strictEqual(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), DEAD_PID);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lock: the lock dir appears with its pid and tree already inside', () => {
  const { root, lockDir } = mkRoot();
  const log = path.join(root, 'lock-events.txt');
  const hook = path.join(root, 'observe.js');
  fs.writeFileSync(hook, `const fs = require('fs');
const LOCK = ${JSON.stringify(fs.realpathSync(root))} + '/.test-digest.lock';
const LOG = ${JSON.stringify(log)};
const mk = fs.mkdirSync; const mv = fs.renameSync; const ap = fs.appendFileSync; const ex = fs.existsSync;
const real = (p) => { try { return fs.realpathSync(require('path').dirname(p)) + '/' + require('path').basename(p); } catch { return p; } };
fs.mkdirSync = function (p, ...rest) { if (real(String(p)) === LOCK) ap(LOG, 'mkdir-lock\\n'); return mk.call(this, p, ...rest); };
fs.renameSync = function (a, b) {
  if (real(String(b)) === LOCK) ap(LOG, 'rename-lock pid=' + ex(a + '/pid') + ' tree=' + ex(a + '/tree') + '\\n');
  return mv.call(this, a, b);
};
`);
  try {
    const res = runSync(root, ['-r', hook]);
    assert.match(res.stdout, /TOTALS: [1-9]\d* pass, 0 fail, [1-9]\d* tests/);
    assert.strictEqual(fs.readFileSync(log, 'utf8'), 'rename-lock pid=true tree=true\n');
    assert.deepStrictEqual(fs.readdirSync(root).filter((n) => n.startsWith('.test-digest.lock')), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lock: a contender whose stale probe raced another reclaim leaves the winner\'s live lock in place', () => {
  const { root, lockDir } = mkRoot();
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), DEAD_PID);
  const hook = path.join(root, 'race.js');
  fs.writeFileSync(hook, `const fs = require('fs');
const LOCK = ${JSON.stringify(lockDir)};
const kill = process.kill; let raced = false;
process.kill = function (pid, sig) {
  if (!raced && pid === ${DEAD_PID} && sig === 0) {
    raced = true;
    fs.rmSync(LOCK, { recursive: true, force: true });
    fs.mkdirSync(LOCK);
    fs.writeFileSync(LOCK + '/pid', '${process.pid}');
  }
  return kill.call(this, pid, sig);
};
`);
  try {
    const res = runSync(root, ['-r', hook]);
    assert.doesNotMatch(res.stdout, /TOTALS:/, 'the second contender ran a suite beside the live holder');
    assert.match(res.stderr, new RegExp(`another suite run is already going \\(pid ${process.pid}`));
    assert.notStrictEqual(res.status, 0);
    assert.strictEqual(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), String(process.pid));
    assert.deepStrictEqual(fs.readdirSync(root).filter((n) => n.startsWith('.test-digest.lock')), ['.test-digest.lock']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function clockHook(root, nowMs) {
  const hook = path.join(root, 'clock.js');
  fs.writeFileSync(hook, `const real = Date.now; const shift = ${nowMs} - real(); Date.now = () => real() + shift;\n`);
  return hook;
}

function plantMergeMarker(root, ticket, at) {
  fs.writeFileSync(path.join(root, '.test-digest.merge-waiting'), `${JSON.stringify({ ticket, at })}\n`);
}

test('merge marker: a fresh marker makes a hand run wait without the lock, then it proceeds once the marker clears', async () => {
  const { root, lockDir } = mkRoot();
  plantMergeMarker(root, 't9', 1_000_000);
  const hook = clockHook(root, 1_060_000);
  try {
    const child = spawn(process.execPath, ['-r', hook, path.join(root, 'scripts', 'run-tests.js')],
      { cwd: root, env: childEnv({ CLODEX_TEST_LOCK_WAIT_MS: '100000' }) });
    let out = '';
    let err = '';
    let cleared = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => {
      err += d;
      if (!cleared && /waiting for the queued merge of t9 to take the suite lock first/.test(err)) {
        cleared = true;
        assert.ok(!fs.existsSync(lockDir), 'the waiting run took the lock ahead of the merge');
        fs.rmSync(path.join(root, '.test-digest.merge-waiting'));
      }
    });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.ok(cleared, `ENTER: the run never waited on the marker; stderr ${JSON.stringify(err)}`);
    assert.match(out, /TOTALS: [1-9]\d* pass, 0 fail, [1-9]\d* tests/);
    assert.strictEqual(code, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const row of [
  { age: 'three minutes', now: 1_180_000, removed: false },
  { age: 'six minutes', now: 1_360_000, removed: true },
]) {
  test(`merge marker: a marker ${row.age} old is stale and ignored${row.removed ? ', and removed' : ''}`, () => {
    const { root } = mkRoot();
    plantMergeMarker(root, 't9', 1_000_000);
    const hook = clockHook(root, row.now);
    try {
      const res = spawnSync(process.execPath, ['-r', hook, path.join(root, 'scripts', 'run-tests.js')],
        { encoding: 'utf-8', cwd: root, timeout: 120000, env: childEnv({ CLODEX_TEST_LOCK_WAIT_MS: '2000' }) });
      assert.match(res.stdout, /TOTALS: [1-9]\d* pass, 0 fail, [1-9]\d* tests/);
      assert.doesNotMatch(res.stderr, /waiting for the queued merge/);
      assert.strictEqual(fs.existsSync(path.join(root, '.test-digest.merge-waiting')), !row.removed);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('merge marker: a run already queued behind a holder yields to a marker written while it waited', async () => {
  const { root, lockDir } = mkRoot();
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
  const hook = clockHook(root, 1_060_000);
  const marker = path.join(root, '.test-digest.merge-waiting');
  try {
    const child = spawn(process.execPath, ['-r', hook, path.join(root, 'scripts', 'run-tests.js')],
      { cwd: root, env: childEnv({ CLODEX_TEST_LOCK_WAIT_MS: '100000' }) });
    let out = '';
    let err = '';
    let phase = 'queue';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => {
      err += d;
      if (phase === 'queue' && /queued behind pid/.test(err)) {
        phase = 'yield';
        plantMergeMarker(root, 't9', 1_000_000);
        fs.rmSync(lockDir, { recursive: true, force: true });
      } else if (phase === 'yield' && /waiting for the queued merge of t9 to take the suite lock first/.test(err)) {
        phase = 'done';
        assert.ok(!fs.existsSync(lockDir), 'the queued run took the freed lock ahead of the merge');
        fs.rmSync(marker);
      }
    });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.strictEqual(phase, 'done', `ENTER: the queued run never yielded to the marker; stderr ${JSON.stringify(err)}`);
    assert.match(out, /TOTALS: [1-9]\d* pass, 0 fail, [1-9]\d* tests/);
    assert.strictEqual(code, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('merge marker: the merge\'s own suite run does not wait on a fresh marker', () => {
  const { root } = mkRoot();
  plantMergeMarker(root, 't9', 1_000_000);
  const hook = clockHook(root, 1_060_000);
  try {
    const res = spawnSync(process.execPath, ['-r', hook, path.join(root, 'scripts', 'run-tests.js')],
      { encoding: 'utf-8', cwd: root, timeout: 120000, env: childEnv({ CLODEX_TEST_LOCK_WAIT_MS: '2000', CLODEX_TEST_LOCK_MERGE: '1' }) });
    assert.match(res.stdout, /TOTALS: [1-9]\d* pass, 0 fail, [1-9]\d* tests/);
    assert.doesNotMatch(res.stderr, /waiting for the queued merge/);
    assert.ok(fs.existsSync(path.join(root, '.test-digest.merge-waiting')), 'ENTER: the marker was fresh, so nothing removed it');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
