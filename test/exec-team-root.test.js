// ${TEAM_ROOT} in an exec def — the placeholder that makes ONE def serve every
// team.
//
// The bug this pins is not a crash, it is a WRONG ANSWER THAT LOOKS RIGHT. The
// live clodex-run-tests / clodex-repo-state defs hardcoded an absolute project
// path plus a matching cwd, so a second team's lead asking for its own test
// digest ran THIS repo's suite and got a plausible green back. A missing command
// is loud; this was silent, which is why it survived.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionManager } = require('../session-manager');
const { isFilenameToken, parseAndValidate } = require('../exec-schema');

// The dispatcher spawns on setImmediate, and the spawn itself is preceded by one
// more hop; two flushes is what the sibling clodex-home test settled on.
const settle = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

function harness({ resolveTeam, entry }) {
  const REGISTRY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-teamroot-'));
  const execDir = path.join(REGISTRY_DIR, 'library', 'exec');
  fs.mkdirSync(execDir, { recursive: true });
  fs.writeFileSync(path.join(execDir, 'digest.json'), JSON.stringify(entry));

  const spawned = [];
  const fakeChild = () => {
    const ee = new (require('node:events').EventEmitter)();
    ee.stdin = { write() {}, end() {} };
    ee.stderr = new (require('node:events').EventEmitter)();
    ee.kill = () => {};
    setImmediate(() => ee.emit('exit', 0, null));
    return ee;
  };
  const SessionManager = createSessionManager({
    REGISTRY_DIR,
    isFilenameToken,
    parseAndValidate,
    resolveTeam,
    os,
    fs,
    path,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({ list: () => [], get: () => ({ execCommands: ['digest'] }) }),
    childProcess: { spawn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return fakeChild(); } },
  });
  const m = new SessionManager();
  const replies = [];
  m._injectText = (_s, t) => replies.push(t);
  m._broadcast = () => {};
  return { m, spawned, replies, REGISTRY_DIR };
}

const DEF = {
  argv: ['/bin/sh', '${TEAM_ROOT}/scripts/test-digest.sh'],
  cwd: '${TEAM_ROOT}',
  timeoutMs: 5000,
  maxBytes: 1024,
  schema: { type: 'object', additionalProperties: false },
};

test('${TEAM_ROOT} resolves from the CALLING session, so one def serves every team', async () => {
  // Two teams, one def. If the placeholder resolved from anything but the
  // caller's cwd — a captured value, the app root, the first team found — both
  // calls would land in the same project, which is the shipped bug.
  const roots = { '/proj/alpha/src': '/proj/alpha', '/proj/beta': '/proj/beta' };
  const { m, spawned, REGISTRY_DIR } = harness({
    resolveTeam: (cwd) => (roots[cwd] ? { name: 't', root: roots[cwd] } : null),
    entry: DEF,
  });
  try {
    m._handleExecIntent({ name: 'a', agentType: 'claude', cwd: '/proj/alpha/src' }, 'digest', '{}');
    await settle();
    m._handleExecIntent({ name: 'b', agentType: 'claude', cwd: '/proj/beta' }, 'digest', '{}');
    await settle();

    assert.strictEqual(spawned.length, 2, 'both calls spawned');
    assert.deepStrictEqual(spawned[0].args, ['/proj/alpha/scripts/test-digest.sh']);
    assert.strictEqual(spawned[0].opts.cwd, '/proj/alpha');
    assert.deepStrictEqual(spawned[1].args, ['/proj/beta/scripts/test-digest.sh']);
    assert.strictEqual(spawned[1].opts.cwd, '/proj/beta');
  } finally { fs.rmSync(REGISTRY_DIR, { recursive: true, force: true }); }
});

test('a seat in no team leaves ${TEAM_ROOT} empty rather than substituting a wrong root', async () => {
  // Substituting SOMETHING here (the app root, the session cwd) would silently
  // run a different project's script — the exact class of bug the placeholder
  // exists to kill. An unresolved relative path fails loudly at spawn instead.
  const { m, spawned, REGISTRY_DIR } = harness({ resolveTeam: () => null, entry: DEF });
  try {
    m._handleExecIntent({ name: 'a', agentType: 'claude', cwd: '/somewhere/else' }, 'digest', '{}');
    await settle();
    assert.strictEqual(spawned.length, 1);
    assert.deepStrictEqual(spawned[0].args, ['/scripts/test-digest.sh'],
      'the token expands to empty, leaving a path that cannot be mistaken for a real project');
    assert.ok(!spawned[0].args[0].startsWith('/somewhere/else'),
      'the session cwd must NOT be used as a fallback root');
  } finally { fs.rmSync(REGISTRY_DIR, { recursive: true, force: true }); }
});

test('a throwing resolveTeam degrades to empty instead of killing the exec path', async () => {
  // resolveTeam reads every team.json on disk; one malformed manifest must not
  // take out an unrelated command.
  const { m, spawned, REGISTRY_DIR } = harness({
    resolveTeam: () => { throw new Error('broken manifest'); },
    entry: DEF,
  });
  try {
    m._handleExecIntent({ name: 'a', agentType: 'claude', cwd: '/proj/alpha' }, 'digest', '{}');
    await settle();
    assert.strictEqual(spawned.length, 1, 'the command still ran');
  } finally { fs.rmSync(REGISTRY_DIR, { recursive: true, force: true }); }
});

test('${CLODEX_BIN} and ${CLODEX_HOME} still expand alongside the new token', async () => {
  const { m, spawned, REGISTRY_DIR } = harness({
    resolveTeam: () => ({ name: 't', root: '/proj/alpha' }),
    entry: {
      argv: ['/usr/bin/env', 'node', '${CLODEX_BIN}/x.js', '${CLODEX_HOME}/lib', '${TEAM_ROOT}/s.sh'],
      timeoutMs: 5000, maxBytes: 1024, schema: { type: 'object', additionalProperties: false },
    },
  });
  try {
    m._handleExecIntent({ name: 'a', agentType: 'claude', cwd: '/proj/alpha' }, 'digest', '{}');
    await settle();
    assert.deepStrictEqual(spawned[0].args, [
      'node',
      path.join(REGISTRY_DIR, 'bin', 'x.js'),
      path.join(REGISTRY_DIR, 'lib'),
      '/proj/alpha/s.sh',
    ]);
  } finally { fs.rmSync(REGISTRY_DIR, { recursive: true, force: true }); }
});
