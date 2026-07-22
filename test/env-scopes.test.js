// Run: node --test
// Covers env-scopes.js — the pure scope-merge module that feeds a wrapper PTY's
// env. Pins the canonical precedence (base < global < workspace < session <
// override-file), the deny-list + key/value validation, and — load-bearing for
// T46 — the NO-SCOPES IDENTITY: with nothing set anywhere the merge must reduce
// to exactly `{ ...base }` so session-manager's `{ ...process.env, TERM }` stays
// byte-identical to today.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const {
  DENY_KEYS, envKeyError, flattenScope, sanitizeFlat, mergeSessionEnv,
} = require('../env-scopes');

function tmpFile(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-scopes-'));
  const f = path.join(dir, 'env-override.env');
  fs.writeFileSync(f, body);
  return f;
}

// ── precedence ───────────────────────────────────────────────────────────────
test('precedence: base < global < workspace < session < override', () => {
  const f = tmpFile('K=fromOverride\n');
  const merged = mergeSessionEnv({
    base: { K: 'fromBase', BASEONLY: 'b' },
    global: { K: { value: 'fromGlobal' } },
    workspace: { K: { value: 'fromWorkspace' } },
    session: { K: 'fromSession' },
    overrideFile: f,
  });
  assert.strictEqual(merged.K, 'fromOverride'); // override wins the whole chain
  assert.strictEqual(merged.BASEONLY, 'b');     // base pass-through survives
});

test('each layer wins over the one below when higher layers are absent', () => {
  const base = { K: 'base' };
  assert.strictEqual(mergeSessionEnv({ base, global: { K: { value: 'g' } } }).K, 'g');
  assert.strictEqual(mergeSessionEnv({ base, global: { K: { value: 'g' } }, workspace: { K: { value: 'w' } } }).K, 'w');
  assert.strictEqual(mergeSessionEnv({ base, workspace: { K: { value: 'w' } }, session: { K: 's' } }).K, 's');
});

test('override file beats a session var (box operator has final say)', () => {
  const f = tmpFile('AWS_PROFILE=box-local\n');
  const merged = mergeSessionEnv({
    base: {}, session: { AWS_PROFILE: 'remote-sent' }, overrideFile: f,
  });
  assert.strictEqual(merged.AWS_PROFILE, 'box-local');
});

// ── no-scopes identity (the byte-identical constraint) ───────────────────────
test('no scopes anywhere ⇒ merge is exactly { ...base }', () => {
  const base = { PATH: '/usr/bin', HOME: '/home/x', TERM: 'dumb' };
  const merged = mergeSessionEnv({ base });
  assert.deepStrictEqual(merged, base);
  assert.notStrictEqual(merged, base); // a copy, not the same ref
});

test('empty scope objects + missing override file ⇒ still identity', () => {
  const base = { PATH: '/usr/bin' };
  const merged = mergeSessionEnv({
    base, global: {}, workspace: {}, session: {},
    overrideFile: '/nonexistent/env-override.env',
  });
  assert.deepStrictEqual(merged, base);
});

test('a scope with only null/unset values ⇒ identity', () => {
  const base = { PATH: '/usr/bin' };
  const merged = mergeSessionEnv({
    base, global: { NOPE: { value: null } }, session: { ALSO: undefined },
  });
  assert.deepStrictEqual(merged, base);
});

// ── deny-list ────────────────────────────────────────────────────────────────
test('CLODEX_REMOTE_TOKEN is deny-listed in the merge (every scope)', () => {
  assert.ok(DENY_KEYS.has('CLODEX_REMOTE_TOKEN'));
  const base = { CLODEX_REMOTE_TOKEN: 'real-gate' };
  const merged = mergeSessionEnv({
    base,
    global: { CLODEX_REMOTE_TOKEN: { value: 'via-global' } },
    workspace: { CLODEX_REMOTE_TOKEN: { value: 'via-workspace' } },
    session: { CLODEX_REMOTE_TOKEN: 'via-session' },
    overrideFile: tmpFile('CLODEX_REMOTE_TOKEN=via-override\n'),
  });
  // Base gate value is never clobbered by any scope surface.
  assert.strictEqual(merged.CLODEX_REMOTE_TOKEN, 'real-gate');
});

test('envKeyError rejects deny-listed key, invalid key, newline value', () => {
  assert.match(envKeyError('CLODEX_REMOTE_TOKEN', 'x'), /not allowed/);
  assert.match(envKeyError('1BAD', 'x'), /invalid env key/);
  assert.match(envKeyError('has-dash', 'x'), /invalid env key/);
  assert.match(envKeyError('OK', 'line1\nline2'), /newline/);
  assert.strictEqual(envKeyError('AWS_PROFILE', 'prod'), null);
  assert.strictEqual(envKeyError('_UNDERSCORE_OK', ''), null);
});

// ── flatten / sanitize drop junk ─────────────────────────────────────────────
test('flattenScope drops invalid/denied/newline entries, keeps valid', () => {
  const flat = flattenScope({
    GOOD: { value: 'yes', secret: false },
    SECRETY: { value: 'shh', secret: true }, // value flattened regardless of secret
    'bad-key': { value: 'x' },
    CLODEX_REMOTE_TOKEN: { value: 'x' },
    NL: { value: 'a\nb' },
    UNSET: { value: null },
  });
  assert.deepStrictEqual(flat, { GOOD: 'yes', SECRETY: 'shh' });
});

test('flattenScope tolerates a flat { KEY: value } shape too', () => {
  assert.deepStrictEqual(flattenScope({ A: 'x', B: 'y' }), { A: 'x', B: 'y' });
});

test('sanitizeFlat drops junk from the session/CLI/wire flat shape', () => {
  assert.deepStrictEqual(
    sanitizeFlat({ AWS_PROFILE: 'p', 'no': undefined, CLODEX_REMOTE_TOKEN: 'x', '2bad': 'v', OK_2: '2' }),
    { AWS_PROFILE: 'p', OK_2: '2' },
  );
});

test('values are coerced to strings', () => {
  const merged = mergeSessionEnv({ base: {}, session: { N: 5 } });
  assert.strictEqual(merged.N, '5');
});

// ── driving case ─────────────────────────────────────────────────────────────
test('driving case: AWS_PROFILE + AWS_ROLE_SESSION_NAME per session', () => {
  const merged = mergeSessionEnv({
    base: { PATH: '/usr/bin' },
    session: { AWS_PROFILE: 'clientA', AWS_ROLE_SESSION_NAME: 'agent-bob' },
  });
  assert.strictEqual(merged.AWS_PROFILE, 'clientA');
  assert.strictEqual(merged.AWS_ROLE_SESSION_NAME, 'agent-bob');
  assert.strictEqual(merged.PATH, '/usr/bin');
});
