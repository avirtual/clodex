// Run: node --test
// Covers claude-env.js — the tee-blind backend detector. A session whose
// effective env sets CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX routes the
// CLI to AWS/GCP and bypasses the ANTHROPIC_BASE_URL our wire tee depends on, so
// SessionManager must take its intents from the JsonlWatcher, not the wire.
// These pin the env-merge chain (process.env base < user < project < local,
// per-key later-wins) and the CLI truthiness rule the gate decision rides on.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { isEnvTruthy, readEffectiveClaudeEnv, teeBlindBackend } = require('../claude-env');

// A hermetic cwd + a clean home (no real ~/.claude leaking in). Each mk() call
// is torn down by the caller.
function mkDirs() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-cwd-'));
  return { home, cwd };
}
function rmDirs({ home, cwd }) {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
}
// Write a settings file with an `env` block at <dir>/.claude/<name>.
function writeSettings(dir, name, env) {
  const cd = path.join(dir, '.claude');
  fs.mkdirSync(cd, { recursive: true });
  fs.writeFileSync(path.join(cd, name), JSON.stringify({ env }));
}
// The detection a spawn makes: effective env → backend. baseEnv is emptied so a
// stray CLAUDE_CODE_USE_* in the real process env can't taint the fixture.
function backendFor({ home, cwd }) {
  return teeBlindBackend(readEffectiveClaudeEnv(cwd, { baseEnv: {}, homeDir: home }));
}

test('isEnvTruthy: unset/empty/"0"/"false" are OFF, anything else ON', () => {
  for (const off of [undefined, null, '', ' ', '0', 'false', 'FALSE', ' False ']) {
    assert.strictEqual(isEnvTruthy(off), false, `${JSON.stringify(off)} should be off`);
  }
  for (const on of ['1', 'true', 'yes', 'x', 'us-east-1']) {
    assert.strictEqual(isEnvTruthy(on), true, `${JSON.stringify(on)} should be on`);
  }
});

test('project settings CLAUDE_CODE_USE_BEDROCK=1 → bedrock (spawn takes jsonl)', () => {
  const d = mkDirs();
  try {
    writeSettings(d.cwd, 'settings.json', { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'opsguru-sso' });
    assert.strictEqual(backendFor(d), 'bedrock');
  } finally { rmDirs(d); }
});

test('project settings CLAUDE_CODE_USE_VERTEX=1 → vertex (spawn takes jsonl)', () => {
  const d = mkDirs();
  try {
    writeSettings(d.cwd, 'settings.json', { CLAUDE_CODE_USE_VERTEX: '1' });
    assert.strictEqual(backendFor(d), 'vertex');
  } finally { rmDirs(d); }
});

test('neither flag set → null (spawn keeps the wire)', () => {
  const d = mkDirs();
  try {
    writeSettings(d.cwd, 'settings.json', { SOME_OTHER: '1' });
    assert.strictEqual(backendFor(d), null);
  } finally { rmDirs(d); }
});

test('a later layer explicitly turning it off overrides an earlier "1"', () => {
  const d = mkDirs();
  try {
    // project turns Bedrock on, local ("0") wins per later-layer semantics.
    writeSettings(d.cwd, 'settings.json', { CLAUDE_CODE_USE_BEDROCK: '1' });
    writeSettings(d.cwd, 'settings.local.json', { CLAUDE_CODE_USE_BEDROCK: '0' });
    assert.strictEqual(backendFor(d), null);
  } finally { rmDirs(d); }
});

test('process.env-set Bedrock (no settings file) → bedrock', () => {
  const d = mkDirs();
  try {
    // No .claude anywhere; the shell-exported flag rides in as baseEnv.
    const env = readEffectiveClaudeEnv(d.cwd, { baseEnv: { CLAUDE_CODE_USE_BEDROCK: '1' }, homeDir: d.home });
    assert.strictEqual(teeBlindBackend(env), 'bedrock');
  } finally { rmDirs(d); }
});

test('global (~/.claude) layer marks a session tee-blind too', () => {
  const d = mkDirs();
  try {
    writeSettings(d.home, 'settings.json', { CLAUDE_CODE_USE_VERTEX: 'true' });
    assert.strictEqual(backendFor(d), 'vertex');
  } finally { rmDirs(d); }
});

test('teeBlindBackend: bedrock is reported first when both are set', () => {
  assert.strictEqual(
    teeBlindBackend({ CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1' }),
    'bedrock',
  );
});
