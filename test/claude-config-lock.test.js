const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { acquireClaudeConfigLock, claudeConfigLockPath, withClaudeConfigLock, CLI_CONFIG_LOCK_STALE_MS, CONFIG_LOCK_WAITS_MS } = require('../claude-config-lock');
const { preseedClaudeOnboarding } = require('../session-manager');
const { createAccounts } = require('../accounts');
const { mkTmpRoot } = require('./lib/tmp-roots');

const seededTrust = (p) => JSON.parse(fs.readFileSync(p, 'utf8')).projects['/tmp/p1'];
const setAge = (dir, ageMs) => { const t = new Date(Date.now() - ageMs); fs.utimesSync(dir, t, t); };

test('the CLI constants: stale after 10000 ms, waits sum to 1975 ms', () => {
  assert.strictEqual(CLI_CONFIG_LOCK_STALE_MS, 10000);
  assert.deepStrictEqual(CONFIG_LOCK_WAITS_MS, [25, 50, 100, 200, 400, 400, 400, 400]);
  assert.strictEqual(claudeConfigLockPath('/h/.claude.json'), '/h/.claude.json.lock');
});

test('success: the seed runs inside a mkdir lock at <config>.lock and leaves no lock behind', () => {
  const home = mkTmpRoot('cfglock-');
  const p = path.join(home, '.claude.json');
  const seen = [];
  const spyFs = { ...fs, renameSync: (a, b) => { seen.push(fs.statSync(`${p}.lock`).isDirectory()); fs.renameSync(a, b); } };
  assert.strictEqual(preseedClaudeOnboarding({ fs: spyFs, path, homeDir: home, cwd: '/tmp/p1', sleepFn: () => assert.fail('no wait on a free lock') }), true);
  assert.deepStrictEqual(seen, [true]);
  assert.deepStrictEqual(seededTrust(p), { hasTrustDialogAccepted: true });
  assert.deepStrictEqual(fs.readdirSync(home), ['.claude.json']);
});

for (const [label, ageMs, released, sleepsWant] of [
  ['a fresh lock released after the second wait', 0, 2, [25, 50]],
  ['a 9000 ms old lock (under the 10000 ms stale rule) released after the first wait', 9000, 1, [25]],
]) {
  test(`held: ${label} is waited for, then the seed takes it`, () => {
    const home = mkTmpRoot('cfglock-');
    const p = path.join(home, '.claude.json');
    fs.mkdirSync(`${p}.lock`);
    setAge(`${p}.lock`, ageMs);
    const sleeps = [];
    const warns = [];
    const sleepFn = (ms) => { sleeps.push(ms); if (sleeps.length === released) fs.rmdirSync(`${p}.lock`); };
    assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home, cwd: '/tmp/p1', sleepFn, log: { warn: (...a) => warns.push(a) } }), true);
    assert.deepStrictEqual(sleeps, sleepsWant);
    assert.deepStrictEqual(warns, []);
    assert.deepStrictEqual(seededTrust(p), { hasTrustDialogAccepted: true });
    assert.deepStrictEqual(fs.readdirSync(home), ['.claude.json']);
  });
}

test('held past the 1975 ms bound: the seed runs unlocked, logs one line, and leaves the holder\'s lock as it was', () => {
  const home = mkTmpRoot('cfglock-');
  const p = path.join(home, '.claude.json');
  fs.mkdirSync(`${p}.lock`);
  const before = fs.statSync(`${p}.lock`).mtimeMs;
  const sleeps = [];
  const warns = [];
  assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home, cwd: '/tmp/p1', sleepFn: (ms) => sleeps.push(ms), log: { warn: (...a) => warns.push(a) } }), true);
  assert.deepStrictEqual(sleeps, [25, 50, 100, 200, 400, 400, 400, 400]);
  assert.deepStrictEqual(warns, [['session', `config lock ${p}.lock: not taken (held for over 1975 ms); writing ${p} without it`]]);
  assert.deepStrictEqual(seededTrust(p), { hasTrustDialogAccepted: true });
  assert.strictEqual(fs.statSync(`${p}.lock`).mtimeMs, before);
});

test('lock unobtainable (mkdir EACCES): the seed runs unlocked with one log line, no wait, and no lock is left', () => {
  const home = mkTmpRoot('cfglock-');
  const p = path.join(home, '.claude.json');
  const warns = [];
  const noMkdirFs = { ...fs, mkdirSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } };
  assert.strictEqual(preseedClaudeOnboarding({ fs: noMkdirFs, path, homeDir: home, cwd: '/tmp/p1', sleepFn: () => assert.fail('no wait'), log: { warn: (...a) => warns.push(a) } }), true);
  assert.deepStrictEqual(warns, [['session', `config lock ${p}.lock: not taken (EACCES); writing ${p} without it`]]);
  assert.deepStrictEqual(fs.readdirSync(home), ['.claude.json']);
});

test('stale: an 11000 ms old lock is taken over without a wait, and removed after the seed', () => {
  const home = mkTmpRoot('cfglock-');
  const p = path.join(home, '.claude.json');
  fs.mkdirSync(`${p}.lock`);
  setAge(`${p}.lock`, 11000);
  assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home, cwd: '/tmp/p1', sleepFn: () => assert.fail('no wait on a stale lock') }), true);
  assert.deepStrictEqual(seededTrust(p), { hasTrustDialogAccepted: true });
  assert.deepStrictEqual(fs.readdirSync(home), ['.claude.json']);
});

test('throw mid-seed: the write throws between acquire and rename, the seed returns false, no lock is left', () => {
  const home = mkTmpRoot('cfglock-');
  const brokenFs = { ...fs, writeFileSync: () => { throw new Error('EROFS: read-only file system'); } };
  assert.strictEqual(preseedClaudeOnboarding({ fs: brokenFs, path, homeDir: home, cwd: '/tmp/p1' }), false);
  assert.deepStrictEqual(fs.readdirSync(home), []);
});

test('throw inside the helper: the error propagates and the lock is removed', () => {
  const home = mkTmpRoot('cfglock-');
  const file = path.join(home, '.claude.json');
  assert.throws(() => withClaudeConfigLock({ fs, file, fn: () => { assert.ok(fs.existsSync(`${file}.lock`), 'ENTER: held'); throw new Error('mid-seed'); } }), /mid-seed/);
  assert.deepStrictEqual(fs.readdirSync(home), []);
});

test('a CLI save that tries to lock inside the seed\'s read-to-rename window is refused and lands after, keeping the seed', () => {
  const home = mkTmpRoot('cfglock-');
  const p = path.join(home, '.claude.json');
  fs.writeFileSync(p, JSON.stringify({ hasCompletedOnboarding: true, numStartups: 7 }));
  const events = [];
  let pending = false;
  const cliSave = () => {
    const lock = acquireClaudeConfigLock({ fs, file: p, waitsMs: [] });
    if (!lock.release) { events.push('cli-refused'); pending = true; return; }
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      fs.writeFileSync(`${p}.cli`, JSON.stringify({ ...j, numStartups: 8 }));
      fs.renameSync(`${p}.cli`, p);
      events.push('cli-save');
    } finally { lock.release(); }
  };
  let reads = 0;
  const seedFs = {
    ...fs,
    readFileSync: (...a) => { const r = fs.readFileSync(...a); if (a[0] === p && ++reads === 1) { events.push('seed-read'); cliSave(); } return r; },
    renameSync: (a, b) => { fs.renameSync(a, b); if (b === p) events.push('seed-rename'); },
  };
  assert.strictEqual(preseedClaudeOnboarding({ fs: seedFs, path, homeDir: home, cwd: '/tmp/p1', sleepFn: () => {} }), true);
  if (pending) cliSave();
  assert.deepStrictEqual(events, ['seed-read', 'cli-refused', 'seed-rename', 'cli-save']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { hasCompletedOnboarding: true, numStartups: 8, projects: { '/tmp/p1': { hasTrustDialogAccepted: true } } });
  assert.deepStrictEqual(fs.readdirSync(home), ['.claude.json']);
});

test('a symlinked config dir: the lock is <link>/.claude.json.lock, unresolved, as the CLI spells it', () => {
  const root = mkTmpRoot('cfglock-');
  const real = path.join(root, 'real');
  const link = path.join(root, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);
  const lock = acquireClaudeConfigLock({ fs, file: path.join(link, '.claude.json') });
  try {
    assert.strictEqual(lock.lockPath, path.join(root, 'link', '.claude.json.lock'));
    assert.ok(fs.statSync(path.join(root, 'real', '.claude.json.lock')).isDirectory());
  } finally { lock.release(); }
  assert.deepStrictEqual(fs.readdirSync(real), []);
});

test('a 40 MB config: the lock is held far under the 10000 ms stale threshold, so no mtime refresh is needed', () => {
  const home = mkTmpRoot('cfglock-');
  const p = path.join(home, '.claude.json');
  const projects = {};
  for (let i = 0; i < 20000; i++) projects[`/work/p${i}`] = { allowedTools: [], history: 'x'.repeat(2000), hasTrustDialogAccepted: true };
  fs.writeFileSync(p, JSON.stringify({ hasCompletedOnboarding: true, projects }));
  assert.ok(fs.statSync(p).size >= 40e6, 'ENTER: the fixture is at least 40 MB');
  let heldAt = 0;
  let heldMs = -1;
  const timedFs = {
    ...fs,
    mkdirSync: (d, ...r) => { const v = fs.mkdirSync(d, ...r); if (d === `${p}.lock`) heldAt = performance.now(); return v; },
    rmdirSync: (d, ...r) => { const v = fs.rmdirSync(d, ...r); if (d === `${p}.lock`) heldMs = performance.now() - heldAt; return v; },
  };
  assert.strictEqual(preseedClaudeOnboarding({ fs: timedFs, path, homeDir: home, cwd: '/tmp/p1' }), true);
  assert.ok(heldMs >= 0, 'ENTER: the lock was taken and released');
  assert.ok(heldMs < 5000, `held ${heldMs} ms`);
});

test('accounts: mint and mergeTrust write an account\'s .claude.json under the same lock', () => {
  const root = mkTmpRoot('cfglock-acct-');
  const clodexHome = path.join(root, 'clodex');
  const claudeHome = path.join(root, 'home', '.claude');
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.writeFileSync(path.join(root, 'home', '.claude.json'), JSON.stringify({ projects: { '/w/a': { hasTrustDialogAccepted: true } } }));
  const dir = path.join(clodexHome, 'accounts', 'sub-2');
  const file = path.join(dir, '.claude.json');
  fs.mkdirSync(`${file}.lock`, { recursive: true });
  const sleeps = [];
  const sleepFn = (ms) => { sleeps.push(ms); fs.rmdirSync(`${file}.lock`); };
  const accounts = createAccounts({ fs, path, os, clodexHome, claudeHome, sleepFn });
  assert.strictEqual(accounts.mint('sub-2'), dir);
  assert.deepStrictEqual(sleeps, [25]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects, { '/w/a': { hasTrustDialogAccepted: true } });
  accounts.add({ label: 'sub-2', plan: 'max', configDir: dir });
  fs.writeFileSync(file, JSON.stringify({ projects: {} }));
  fs.mkdirSync(`${file}.lock`);
  assert.strictEqual(accounts.mergeTrust('sub-2'), 1);
  assert.deepStrictEqual(sleeps, [25, 25]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects, { '/w/a': { hasTrustDialogAccepted: true } });
  assert.strictEqual(fs.existsSync(`${file}.lock`), false);
});
