// preseedClaudeOnboarding: a claude spawn seeds ~/.claude.json with
// hasCompletedOnboarding + theme and with projects[cwd].hasTrustDialogAccepted,
// so neither the wizard nor the "trust this folder?" prompt appears inside an
// unwatched PTY. Merge-only contract: nothing-to-change writes nothing,
// unparseable files untouched, failures degrade to the prompt.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { preseedClaudeOnboarding } = require('../session-manager');
const { mkTmpRoot } = require('./lib/tmp-roots');

function tmpHome() {
  return mkTmpRoot('preseed-');
}

test('fresh home: seeds hasCompletedOnboarding + theme, 0600', () => {
  const home = tmpHome();
  assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home }), true);
  const p = path.join(home, '.claude.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(j.hasCompletedOnboarding, true);
  assert.strictEqual(j.theme, 'dark');
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600);
});

test('already-onboarded file is left byte-untouched', () => {
  const home = tmpHome();
  const p = path.join(home, '.claude.json');
  const orig = '{"hasCompletedOnboarding":true,"theme":"light","userID":"u1"}';
  fs.writeFileSync(p, orig);
  assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home }), false);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), orig);
});

test('partial file merges: existing keys kept, onboarding flag added, theme not overridden', () => {
  const home = tmpHome();
  const p = path.join(home, '.claude.json');
  fs.writeFileSync(p, '{"theme":"light","numStartups":3}');
  assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home }), true);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(j.hasCompletedOnboarding, true);
  assert.strictEqual(j.theme, 'light');
  assert.strictEqual(j.numStartups, 3);
});

test('unparseable JSON is never clobbered', () => {
  const home = tmpHome();
  const p = path.join(home, '.claude.json');
  fs.writeFileSync(p, '{not json');
  assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home }), false);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), '{not json');
});

test('non-object JSON (array) is left alone', () => {
  const home = tmpHome();
  const p = path.join(home, '.claude.json');
  fs.writeFileSync(p, '[1,2]');
  assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home }), false);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), '[1,2]');
});

test('fs failure degrades to false, never throws', () => {
  const brokenFs = { ...fs, existsSync: () => { throw new Error('boom'); } };
  assert.strictEqual(preseedClaudeOnboarding({ fs: brokenFs, path, homeDir: '/nope' }), false);
});

test('fresh home + cwd: seeds onboarding and marks the cwd trusted', () => {
  const home = tmpHome();
  assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home, cwd: '/tmp/p1' }), true);
  const j = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.strictEqual(j.hasCompletedOnboarding, true);
  assert.strictEqual(j.projects['/tmp/p1'].hasTrustDialogAccepted, true);
});

test('already-onboarded file gains only the new project entry', () => {
  const home = tmpHome();
  const p = path.join(home, '.claude.json');
  fs.writeFileSync(p, JSON.stringify({
    hasCompletedOnboarding: true,
    theme: 'light',
    userID: 'u1',
    projects: { '/tmp/other': { hasTrustDialogAccepted: true, allowedTools: ['x'] } },
  }));
  assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home, cwd: '/tmp/p1' }), true);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(j.hasCompletedOnboarding, true);
  assert.strictEqual(j.theme, 'light');
  assert.strictEqual(j.userID, 'u1');
  assert.deepStrictEqual(j.projects, {
    '/tmp/other': { hasTrustDialogAccepted: true, allowedTools: ['x'] },
    '/tmp/p1': { hasTrustDialogAccepted: true },
  });
});

test('onboarded and cwd already trusted is left byte-untouched', () => {
  const home = tmpHome();
  const p = path.join(home, '.claude.json');
  const orig = '{"hasCompletedOnboarding":true,"projects":{"/tmp/p1":{"hasTrustDialogAccepted":true,"allowedTools":["x"]}}}';
  fs.writeFileSync(p, orig);
  assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home, cwd: '/tmp/p1' }), false);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), orig);
});

test('hasTrustDialogAccepted:false is flipped to true, sibling keys kept', () => {
  const home = tmpHome();
  const p = path.join(home, '.claude.json');
  fs.writeFileSync(p, JSON.stringify({
    hasCompletedOnboarding: true,
    projects: { '/tmp/p1': { hasTrustDialogAccepted: false, allowedTools: ['x'], mcpServers: {} } },
  }));
  assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home, cwd: '/tmp/p1' }), true);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepStrictEqual(j.projects['/tmp/p1'], {
    hasTrustDialogAccepted: true, allowedTools: ['x'], mcpServers: {},
  });
});

test('no cwd passed: onboarding seeded, no projects key created', () => {
  const home = tmpHome();
  const p = path.join(home, '.claude.json');
  fs.writeFileSync(p, '{"theme":"light"}');
  assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home }), true);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(j.hasCompletedOnboarding, true);
  assert.strictEqual(j.projects, undefined);
});

test('cwd plus two added dirs: each gets the cwd\'s entry shape', () => {
  const home = tmpHome();
  const a = fs.realpathSync(tmpHome());
  const b = fs.realpathSync(tmpHome());
  assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home, cwd: '/tmp/p1', addDirs: [a, b] }), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')), {
    hasCompletedOnboarding: true,
    theme: 'dark',
    projects: {
      '/tmp/p1': { hasTrustDialogAccepted: true },
      [a]: { hasTrustDialogAccepted: true },
      [b]: { hasTrustDialogAccepted: true },
    },
  });
});

test('a symlinked added dir is seeded under both its raw path and its realpath', () => {
  const home = tmpHome();
  const real = fs.realpathSync(tmpHome());
  const link = path.join(fs.realpathSync(tmpHome()), 'messages-link');
  fs.symlinkSync(real, link);
  assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home, addDirs: [link] }), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')), {
    hasCompletedOnboarding: true,
    theme: 'dark',
    projects: {
      [link]: { hasTrustDialogAccepted: true },
      [real]: { hasTrustDialogAccepted: true },
    },
  });
});

test('a config dir set: its .claude.json is written and the home file is untouched', () => {
  const home = tmpHome();
  const configDir = tmpHome();
  const homeFile = path.join(home, '.claude.json');
  const orig = '{"hasCompletedOnboarding":true}';
  fs.writeFileSync(homeFile, orig);
  const dir = fs.realpathSync(tmpHome());
  assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home, configDir, cwd: '/tmp/p1', addDirs: [dir] }), true);
  assert.strictEqual(fs.readFileSync(homeFile, 'utf8'), orig);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8')), {
    hasCompletedOnboarding: true,
    theme: 'dark',
    projects: {
      '/tmp/p1': { hasTrustDialogAccepted: true },
      [dir]: { hasTrustDialogAccepted: true },
    },
  });
});

test('an existing file keeps another project\'s entry intact beside the added dirs', () => {
  const home = tmpHome();
  const p = path.join(home, '.claude.json');
  fs.writeFileSync(p, JSON.stringify({
    hasCompletedOnboarding: true,
    userID: 'u1',
    projects: { '/tmp/other': { hasTrustDialogAccepted: true, allowedTools: ['x'] } },
  }));
  const dir = fs.realpathSync(tmpHome());
  assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home, cwd: '/tmp/p1', addDirs: [dir] }), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), {
    hasCompletedOnboarding: true,
    userID: 'u1',
    projects: {
      '/tmp/other': { hasTrustDialogAccepted: true, allowedTools: ['x'] },
      '/tmp/p1': { hasTrustDialogAccepted: true },
      [dir]: { hasTrustDialogAccepted: true },
    },
  });
});

test('cwd and added dirs all trusted already: no write, false', () => {
  const home = tmpHome();
  const p = path.join(home, '.claude.json');
  const dir = fs.realpathSync(tmpHome());
  const orig = JSON.stringify({ hasCompletedOnboarding: true, projects: { '/tmp/p1': { hasTrustDialogAccepted: true }, [dir]: { hasTrustDialogAccepted: true } } });
  fs.writeFileSync(p, orig);
  assert.strictEqual(preseedClaudeOnboarding({ fs, path, homeDir: home, cwd: '/tmp/p1', addDirs: [dir] }), false);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), orig);
});
