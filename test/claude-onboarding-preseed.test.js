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
