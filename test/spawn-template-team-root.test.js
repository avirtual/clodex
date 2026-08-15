// `[agent:spawn template:X]` where the template's cwd is "${TEAM_ROOT}" (t415).
//
// The trap this closes: a shipped/copied hand template carrying another
// project's absolute cwd boots the seat in THAT repo while its ticket lives
// here. team-root-expand.test.js pins the pure function; this pins that the
// spawn path actually calls it — resolving from the SPAWNER's team — and, more
// importantly, that an unresolved root REFUSES rather than spawning somewhere
// plausible-looking. A green expansion test over a call site that never expands
// is exactly the false pass this file exists to prevent.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { createSessionManager } = require('../session-manager');

const TEAM_ROOT = path.join(os.tmpdir(), `t415-root-${process.pid}`);

function harness({ teamRoot }) {
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
    // The seam under test: the spawn path must resolve the root from the
    // SPAWNER's cwd, so one shipped template serves every team.
    resolveTeam: (cwd) => (teamRoot ? { name: 'someteam', root: teamRoot, roles: {}, cwd } : null),
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    DEFAULT_WORKSPACE_ID: 'default',
  });
  const m = new SessionManager();
  m.sessions = new Map();
  m._injectText = (_s, t) => replies.push(t);
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m.create = async (...args) => { calls.push(args); return undefined; };
  return { m, calls, replies };
}

const CWD_ARG = 2; // 0-based index of cwd in create()'s signature

async function spawnWith({ tplCwd, teamRoot, intentCwd }) {
  const { m, calls, replies } = harness({ teamRoot });
  const tmpl = path.join(os.tmpdir(), `tpl-t415-${process.pid}-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(tmpl, JSON.stringify({ type: 'claude', cwd: tplCwd }));
  try {
    m._handleSpawnIntent(
      { name: 'lead', cwd: os.tmpdir(), workspaceId: 'default', type: 'claude' },
      { name: 'child', template: tmpl, ...(intentCwd ? { cwd: intentCwd } : {}) },
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return { calls, replies };
  } finally { fs.rmSync(tmpl, { force: true }); }
}

test('a ${TEAM_ROOT} template cwd spawns the seat in the SPAWNER team\'s root', async () => {
  const { calls, replies } = await spawnWith({ tplCwd: '${TEAM_ROOT}', teamRoot: TEAM_ROOT });
  assert.strictEqual(calls.length, 1, `create was called (replies: ${JSON.stringify(replies)})`);
  assert.strictEqual(calls[0][CWD_ARG], TEAM_ROOT,
    'the seat boots in its own team root, not in the template author\'s repo');
});

test('an unresolved ${TEAM_ROOT} REFUSES the spawn and says why', async () => {
  // The whole point. Before expansion existed the literal token fell through to
  // path.resolve() and produced a directory under the process cwd — a seat that
  // starts, in the wrong tree, reporting success.
  const { calls, replies } = await spawnWith({ tplCwd: '${TEAM_ROOT}', teamRoot: null });
  assert.strictEqual(calls.length, 0, 'NO session may be created on an unresolved root');
  assert.strictEqual(replies.length, 1, 'the spawner is told, on its own channel');
  assert.match(replies[0], /^\[agent:spawn\] error:/);
  assert.match(replies[0], /does not resolve/);
  assert.match(replies[0], /explicit cwd:/, 'the reply names the remedy');
});

test('an explicit cwd: overrides the template and still expands', async () => {
  const { calls } = await spawnWith({
    tplCwd: '/authored/elsewhere', teamRoot: TEAM_ROOT, intentCwd: '${TEAM_ROOT}/sub',
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][CWD_ARG], path.join(TEAM_ROOT, 'sub'),
    'the token means the same thing whichever arm supplies it');
});

test('a template with an ABSOLUTE cwd is unaffected by expansion', async () => {
  // Our live clodex-hand-seat.json is exactly this shape and must not change
  // behaviour when the team resolves.
  const abs = path.join(os.tmpdir(), 't415-absolute');
  const { calls } = await spawnWith({ tplCwd: abs, teamRoot: TEAM_ROOT });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][CWD_ARG], abs, 'an absolute cwd wins verbatim, team or no team');
});

test('a template with an absolute cwd spawns even with NO team at all', async () => {
  // The refusal must be scoped to the token. A spawner outside any team spawning
  // a normal template is the common case and may not start failing.
  const abs = path.join(os.tmpdir(), 't415-absolute-noteam');
  const { calls, replies } = await spawnWith({ tplCwd: abs, teamRoot: null });
  assert.strictEqual(calls.length, 1, `create was called (replies: ${JSON.stringify(replies)})`);
  assert.strictEqual(calls[0][CWD_ARG], abs);
});
