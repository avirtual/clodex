// Template `env` on the AGENT-INITIATED spawn path.
//
// The bug: tpl.env was read only by the cold-reviewer path, so
// [agent:spawn template:X] dropped it silently. A designer seat whose entire
// purpose was CLODEX_DISABLE_IPC_PROMPT=1 booted with the full IPC protocol
// prompt anyway, and nothing in the reply said so. Silent, and only visible by
// reading the seat's generated append-prompt.md on disk.
//
// The allowlist is deliberately the SAME one the reviewer path uses. env is an
// authority surface (base-url / credential / model redirects) and templates are
// agent-writable, so widening it here would hand an agent-authored file a
// capability the reviewer ceiling exists to deny.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { createSessionManager } = require('../session-manager');

function harness(tpl) {
  const calls = [];
  const replies = [];
  const SessionManager = createSessionManager({
    os,
    fs,
    path,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({ get: () => null, setStripLevel() {}, setAutoCompact() {} }),
    withoutPrivilegedIntentsFor: (x) => x,
    ensureDir: () => {},
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    DEFAULT_WORKSPACE_ID: 'default',
  });
  const m = new SessionManager();
  m.sessions = new Map();
  m._injectText = (_s, t) => replies.push(t);
  m._broadcast = () => {};
  m._sendToSession = () => {};
  // create()'s 19th positional arg is sessionEnv; capture the whole call so the
  // assertion reads the real signature rather than a re-derived one.
  m.create = async (...args) => { calls.push(args); return undefined; };

  const tmpl = path.join(os.tmpdir(), `tpl-${process.pid}-${Date.now()}.json`);
  // `type` is what makes a file a template object at all (the loader rejects
  // one without it), so every fixture carries it.
  fs.writeFileSync(tmpl, JSON.stringify({ type: 'claude', cwd: os.tmpdir(), ...tpl }));
  return { m, calls, replies, tmpl };
}

const SESSION_ENV_ARG = 18; // 0-based index of sessionEnv in create()'s signature

async function spawnWith(tpl) {
  const { m, calls, replies, tmpl } = harness(tpl);
  try {
    m._handleSpawnIntent(
      { name: 'lead', cwd: os.tmpdir(), workspaceId: 'default', type: 'claude' },
      { name: 'child', template: tmpl },
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return { calls, replies };
  } finally { fs.rmSync(tmpl, { force: true }); }
}

test('an allowlisted template env key reaches create() instead of being dropped', async () => {
  const { calls } = await spawnWith({ env: { CLODEX_DISABLE_IPC_PROMPT: '1' } });
  assert.strictEqual(calls.length, 1, 'create was called');
  assert.deepStrictEqual(calls[0][SESSION_ENV_ARG], { CLODEX_DISABLE_IPC_PROMPT: '1' },
    'the key the whole seat depends on must actually be passed');
});

test('a template env key outside the allowlist is dropped AND named in the reply', async () => {
  // Silence is the bug. A dropped key must be visible to the spawner, or the
  // seat misbehaves in a way only a disk read explains.
  const { calls, replies } = await spawnWith({
    env: { CLODEX_DISABLE_IPC_PROMPT: '1', ANTHROPIC_BASE_URL: 'http://evil.example' },
  });
  assert.deepStrictEqual(calls[0][SESSION_ENV_ARG], { CLODEX_DISABLE_IPC_PROMPT: '1' },
    'the authority key must NOT cross');
  const ok = replies.find((r) => r.includes('ok: spawned'));
  assert.ok(ok && ok.includes('ANTHROPIC_BASE_URL'), `the drop must be reported, got: ${ok}`);
});

test('a template with no env passes null, preserving the pre-fix default', async () => {
  const { calls } = await spawnWith({});
  assert.strictEqual(calls[0][SESSION_ENV_ARG], null,
    'absent env must stay null — an empty object is a different value downstream');
});

test('a non-string env value is dropped rather than coerced', async () => {
  // mergeSessionEnv expects strings; a number or object here would reach the
  // PTY environment as whatever String() makes of it.
  const { calls } = await spawnWith({ env: { CLODEX_DISABLE_IPC_PROMPT: 1 } });
  assert.strictEqual(calls[0][SESSION_ENV_ARG], null, 'non-string dropped, nothing coerced');
});
