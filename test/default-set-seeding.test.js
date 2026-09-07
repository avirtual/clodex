'use strict';

// The create seam's three default sets: tools, skills and built-in agents.
//
// The seam is a tri-state read, and the state that matters is the one the
// RENDERER never produces — it always sends arrays, so the seeding branch runs
// only for headless/API callers that omit the field. That makes the interesting
// case invisible from the UI: a build that seeded nothing would look correct in
// the app and silently hand an API-spawned seat the untrimmed roster.
//
// An omitted field and an explicitly-empty one must NOT agree: `[]` is a caller
// saying "deny nothing", and collapsing the two would make the defaults
// impossible to opt out of.

const { test } = require('node:test');
const assert = require('node:assert');

const { registerIpcHandlers } = require('../ipc-handlers');

const TOOL_DEFAULT = ['Workflow', 'LSP'];
const SKILL_DEFAULT = ['code-review'];
const BUILTIN_DEFAULT = ['Plan', 'statusline-setup'];

// manager.create's positional argument list, by the names ipc-handlers passes.
const ARG = { agents: 9, denyBuiltins: 10, disabledTools: 11, disabledSkills: 12 };

function harness() {
  const calls = [];
  const handlers = new Map();
  const stub = () => () => {};
  const base = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: () => {},
    manager: {
      sessions: new Map(),
      create: async (...args) => { calls.push(args); return { name: args[0] }; },
    },
    persistence: { get: () => null, setStripLevel: () => {} },
    agentDefaults: {
      getStrip: () => 0,
      getDefaultDeny: () => TOOL_DEFAULT.slice(),
      getDefaultSkillDeny: () => SKILL_DEFAULT.slice(),
      getDefaultBuiltinDeny: () => BUILTIN_DEFAULT.slice(),
    },
    workspaceOfSender: () => 'ws-1',
  };
  registerIpcHandlers(new Proxy(base, { get(t, k) { return k in t ? t[k] : stub(); } }));
  return { calls, create: handlers.get('session:create') };
}

// (e, name, type, cwd, extraArgs, systemPromptBody, resumeId, fork, proxy,
//  agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, ...)
function spawnArgs({ denyBuiltins, disabledTools, disabledSkills }) {
  return ['seat', 'claude', '/tmp', [], null, null, false, null,
    [], denyBuiltins, disabledTools, disabledSkills, []];
}

test('an omitted set is seeded from the stored default — all three, independently', async () => {
  const h = harness();
  await h.create({}, ...spawnArgs({
    denyBuiltins: undefined, disabledTools: undefined, disabledSkills: undefined,
  }));
  assert.strictEqual(h.calls.length, 1, 'ENTER: manager.create ran — every assertion below reads its args');
  const args = h.calls[0];

  // ENTER: the params really did arrive undefined. If the spawn helper drifts
  // and starts sending arrays, the seeding branch never runs and each
  // assertion below would be comparing the caller's own value to itself.
  const sent = spawnArgs({ denyBuiltins: undefined, disabledTools: undefined, disabledSkills: undefined });
  for (const [i, what] of [[9, 'denyBuiltins'], [10, 'disabledTools'], [11, 'disabledSkills']]) {
    assert.strictEqual(sent[i], undefined, `ENTER: ${what} was sent as undefined`);
  }

  assert.deepStrictEqual(args[ARG.disabledTools], TOOL_DEFAULT);
  assert.deepStrictEqual(args[ARG.disabledSkills], SKILL_DEFAULT);
  assert.deepStrictEqual(args[ARG.denyBuiltins], BUILTIN_DEFAULT);
});

test('an explicit set wins, and an explicit EMPTY set is not the default', async () => {
  const h = harness();
  await h.create({}, ...spawnArgs({
    denyBuiltins: ['claude'], disabledTools: ['Bash'], disabledSkills: [],
  }));
  assert.strictEqual(h.calls.length, 1, 'ENTER: manager.create ran');
  const args = h.calls[0];
  assert.deepStrictEqual(args[ARG.disabledTools], ['Bash'], "the caller's list, not the default");
  assert.deepStrictEqual(args[ARG.denyBuiltins], ['claude']);
  // The half a `|| []` fallback would get wrong: an empty array is falsy-adjacent
  // in every idiom this file uses, so "deny nothing" must survive the seam.
  assert.deepStrictEqual(args[ARG.disabledSkills], [], 'an explicit [] means deny nothing');
});

test('settings:get serves all three sets, so the renderer caches can be filled', () => {
  const handlers = new Map();
  const stub = () => () => {};
  const base = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: () => {},
    manager: { sessions: new Map(), create: async () => ({}) },
    persistence: { get: () => null },
    agentDefaults: {
      getStrip: () => 0,
      getDefaultDeny: () => TOOL_DEFAULT.slice(),
      getDefaultSkillDeny: () => SKILL_DEFAULT.slice(),
      getDefaultBuiltinDeny: () => BUILTIN_DEFAULT.slice(),
    },
    uiSettings: { get: () => ({ statusline: {} }) },
    workspaceOfSender: () => 'ws-1',
  };
  registerIpcHandlers(new Proxy(base, { get(t, k) { return k in t ? t[k] : stub(); } }));
  const get = handlers.get('settings:get');
  assert.ok(typeof get === 'function', 'ENTER: settings:get is registered');
  const s = get({});
  assert.deepStrictEqual(s.defaultToolDeny, TOOL_DEFAULT);
  assert.deepStrictEqual(s.defaultSkillDeny, SKILL_DEFAULT);
  assert.deepStrictEqual(s.defaultBuiltinDeny, BUILTIN_DEFAULT);
});

test('the two setters store what they are given and answer with the stored list', () => {
  const stored = { skills: null, builtins: null };
  const handlers = new Map();
  const stub = () => () => {};
  const base = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: () => {},
    manager: { sessions: new Map() },
    persistence: { get: () => null },
    agentDefaults: {
      setDefaultSkillDeny: (l) => { stored.skills = l; },
      getDefaultSkillDeny: () => stored.skills,
      setDefaultBuiltinDeny: (l) => { stored.builtins = l; },
      getDefaultBuiltinDeny: () => stored.builtins,
    },
    workspaceOfSender: () => 'ws-1',
  };
  registerIpcHandlers(new Proxy(base, { get(t, k) { return k in t ? t[k] : stub(); } }));

  const setSkills = handlers.get('defaults:setSkillDeny');
  const setBuiltins = handlers.get('defaults:setBuiltinDeny');
  assert.ok(setSkills && setBuiltins, 'ENTER: both setters are registered');

  assert.deepStrictEqual(setSkills({}, ['a', 'b']), ['a', 'b']);
  assert.deepStrictEqual(setBuiltins({}, ['Plan']), ['Plan']);
  // A non-array must not reach the store as-is: the renderer sends the result
  // of a checklist collect, but the channel is reachable by anything.
  assert.deepStrictEqual(setSkills({}, 'nope'), []);
  assert.deepStrictEqual(setBuiltins({}, null), []);
});
