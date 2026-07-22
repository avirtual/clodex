// preseedClaudeOnboarding: first claude spawn on a fresh box seeds
// ~/.claude.json (hasCompletedOnboarding + theme) so headless nodes never
// show the interactive wizard inside an unwatched PTY. Merge-only contract:
// completed files untouched, unparseable files untouched, failures degrade
// to the wizard.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { preseedClaudeOnboarding } = require('../session-manager');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'preseed-'));
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
