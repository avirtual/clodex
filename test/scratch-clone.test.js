'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert');
const { mk } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { AGENT_NAME_RE } = require('../catalogs');
const { parseIntent } = require('../intent-scanner');
const registry = require('../intent-registry');
const { SCRATCH_CLONE_REFUSAL, scratchCloneBrief } = require('../scratch-clone');
const { unionEnabled } = require('../scope-util');
const fs = require('node:fs');

const SID = 'aaaa1111-2222-3333-4444-555566667777';
const BASE = 'http://127.0.0.1:9999';
const CEILING_MS = 45 * 60 * 1000;

const AGENT_LIB = [{ name: 'clodex-locate', meta: {} }];
const effectiveFrom = (lib) => (name, list) => {
  const byName = new Map(lib.map((x) => [x.name, x]));
  return unionEnabled(list, lib, name).map((n) => byName.get(n)).filter(Boolean);
};

function mkClone({ record: over = {}, asserted = null, stripFail = false, poller = null, agentLib = AGENT_LIB, skillLib = [] } = {}) {
  const root = mkTmpRoot('scratch-clone-');
  const seq = [];
  const creates = [];
  const injected = [];
  const delivered = [];
  const parked = [];
  const kills = [];
  const strips = [];
  const hints = [];
  const removed = [];
  const store = new Map();
  const record = {
    name: 'a', type: 'claude', cwd: root, sessionId: SID, workspaceId: 'ws1',
    extraArgs: ['--model', 'claude-opus-x', '--plugin-dir', '/plugins/p'],
    env: { CLAUDE_CONFIG_DIR: '/accounts/opsguru' },
    denyBuiltins: ['WebFetch'], disabledTools: ['NotebookEdit'], plugins: ['p1'],
    agents: ['clodex-locate'], execCommands: ['clodex-run-tests'], intents: ['dm', 'scratch'],
    mcp: 'cfg', effort: 'high', stripLevel: 2, appendPromptFiles: ['/a.md'],
    ...over,
  };
  store.set('a', record);
  const persistence = {
    list: () => [...store.values()], get: (n) => store.get(n) || null,
    upsert(e) { seq.push(`upsert:${e.name}`); store.set(e.name, { ...(store.get(e.name) || {}), ...e }); },
    remove(n) { removed.push(n); store.delete(n); },
    setStripLevel() {}, setLabel() {}, setSessionId() {},
  };
  const ProxyClient = {
    stripThinking: async (base, sid, level, explicitZero) => {
      seq.push('strip');
      if (stripFail && level) throw new Error('proxy down');
      strips.push({ base, sid, level, explicitZero: !!explicitZero });
    },
    spawnerHint: async (base, agent, opts) => { hints.push({ base, agent, ...opts }); },
  };
  const team = { name: 'clodex', root, lead: 'lead', roles: {} };
  const m = mk({
    getPersistence: () => persistence,
    ProxyClient,
    AGENT_NAME_RE,
    stripLevelOf: (e) => (e && (e.stripLevel === 1 || e.stripLevel === 2) ? e.stripLevel : 0),
    resolveTeam: () => team,
    findProjectRoot: () => root,
    parkDelivery: (dir, name, text) => { parked.push({ name, text }); },
    writeClaudeDigestFile: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    DEFAULT_WORKSPACE_ID: 'default',
    REGISTRY_DIR: root,
    effectiveInjectedAgents: effectiveFrom(agentLib),
    effectiveInjectedSkills: effectiveFrom(skillLib),
  });
  m._broadcast = () => {};
  const sent = [];
  m._sendToSession = (...args) => sent.push(args);
  m._injectText = (s, text) => injected.push({ to: s.name, text });
  const passive = [];
  const realPassive = m._injectTextPassive.bind(m);
  m._injectTextPassive = (s, text) => { passive.push({ to: s.name, text }); realPassive(s, text); };
  m._buildDeliveryText = (target, from, body) => `[agent:from ${from}] ${body}`;
  const realDeliver = m._deliverMessage.bind(m);
  m._deliverMessage = (to, from, body, mtype) => {
    delivered.push({ to, from, body });
    if (m.sessions.get(to) && m.sessions.get(to).clone) realDeliver(to, from, body, mtype);
  };
  m.kill = async (name) => { kills.push(name); };
  m.create = async (...args) => {
    seq.push('create');
    creates.push({ args, spawning: m._scratchCloneSpawning && m._scratchCloneSpawning.get(args[0]) });
    const fresh = {
      name: args[0], agentType: 'claude', type: 'claude', cwd: args[2], sessionId: args[4],
      proxyBase: BASE, proxyAgent: `clodex-${args[0]}`, activityState: 'idle',
      ...m._scratchCloneMarkerFields(args[0]),
    };
    m.sessions.set(args[0], fresh);
    return fresh;
  };
  if (asserted) m._proxyPoller = { stripAsserted: new Map([['a', asserted]]), snapshot: () => null };
  if (poller) m._proxyPoller = { stripAsserted: new Map(), last: new Map(), stripCapBases: new Map(), snapshot: () => null, ...poller };
  const s = {
    name: 'a', agentType: 'claude', type: 'claude', cwd: root, sessionId: SID, workspaceId: 'ws1',
    proxyBase: BASE, proxyAgent: 'clodex-a', activityState: 'idle',
  };
  m.sessions.set('a', s);
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', type: 'claude', cwd: root, activityState: 'idle' });
  const replies = () => injected.filter((i) => i.to === 'a').map((i) => i.text);
  const cloneName = () => creates.length ? creates[0].args[0] : null;
  const clone = () => m.sessions.get(cloneName());
  const begin = (body = 'read the poller and say where strip levels live') =>
    m._handleScratchIntent(s, { type: 'scratch', sub: 'begin', label: null, replay: false, body });
  return {
    m, s, root, record, store, seq, creates, injected, delivered, parked, kills, strips, hints, removed, passive, sent,
    replies, cloneName, clone, begin,
  };
}

test('t1539 bodied begin: one create() with fork=true on the parent sid, the parent record\'s args plus --session-id, brief as the first turn, clone flag set, nothing persisted', async () => {
  const f = mkClone();
  await f.m._scratchRespawn('a', f.record);
  const parentArgs = f.creates.shift().args;
  f.seq.length = 0;
  await f.begin();
  assert.strictEqual(f.creates.length, 1, 'exactly one create()');
  const args = f.creates[0].args;
  const name = args[0];
  assert.match(name, /^a-scratch-[0-9a-f]{4}$/);
  assert.ok(AGENT_NAME_RE.test(name));
  assert.strictEqual(args[7], true, 'fork=true');
  assert.strictEqual(args[4], SID, 'resumeId is the parent sid');
  const sidAt = args[3].indexOf('--session-id');
  assert.ok(sidAt >= 0, '--session-id present');
  const cloneSid = args[3][sidAt + 1];
  assert.match(cloneSid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notStrictEqual(cloneSid, SID);
  const strip = (list) => list.map((v, i) => (i === 0 || i === 7 ? '<own>' : i === 3 ? v.filter((x, j) => j !== sidAt && j !== sidAt + 1) : v));
  assert.deepStrictEqual(strip(args), strip(parentArgs),
    'every create() argument but the name, fork and --session-id is the one the parent\'s own respawn builds from its record');
  assert.strictEqual(f.creates[0].spawning.parent, 'a', 'create() sees the clone marker, so its live record carries clone and its upsert is skipped');
  assert.ok(!f.seq.some((x) => x.startsWith('upsert')), 'nothing persisted');
  assert.strictEqual(f.clone().clone, 'a');
  const first = f.injected.filter((i) => i.to === name);
  assert.strictEqual(first.length, 1, 'the clone gets exactly one turn: its brief');
  assert.strictEqual(first[0].text, scratchCloneBrief('a', 'read the poller and say where strip levels live'));
  assert.ok(first[0].text.startsWith('You are a scratch clone of a. Do exactly this, then end with [agent:scratch end] <summary>'));
  assert.strictEqual(f.s._scratchClone, name);
  assert.deepStrictEqual(f.replies(), [], 'the success ack never wakes the parent');
  assert.deepStrictEqual(f.passive.filter((p) => p.to === 'a').map((p) => p.text),
    [`[agent:scratch] clone ${name} forked — it reads, you idle; its summary arrives as a message from scratch.`]);
  assert.ok(f.parked.some((p) => p.name === 'a' && /forked/.test(p.text)), 'the ack parks for the parent\'s next turn');
});

test('t1539 ORDER: the strip level lands on the clone sid BEFORE create(), at the parent\'s level', async () => {
  const f = mkClone();
  await f.begin();
  assert.deepStrictEqual(f.seq, ['strip', 'create']);
  const cloneSid = f.creates[0].args[3][f.creates[0].args[3].indexOf('--session-id') + 1];
  assert.deepStrictEqual(f.strips, [{ base: BASE, sid: cloneSid, level: 2, explicitZero: false }]);

  const g = mkClone({ asserted: { sessionId: SID, level: 1, ts: 1 } });
  await g.begin();
  assert.strictEqual(g.strips[0].level, 1, 'the level the poller last asserted for the parent sid wins over the record');
  assert.ok(g.seq.indexOf('strip') < g.seq.indexOf('create'));

  const h = mkClone({ record: { stripLevel: undefined } });
  await h.begin();
  assert.deepStrictEqual(h.strips, [], 'no override recorded for the parent: no POST');
  assert.deepStrictEqual(h.seq, ['create']);
});

test('t1539 a failed strip POST forks nothing', async () => {
  const f = mkClone({ stripFail: true });
  await f.begin();
  assert.strictEqual(f.creates.length, 0);
  assert.match(f.replies().at(-1), /begin refused: setting the clone's strip level failed/);
  assert.strictEqual(f.s._scratchClone, null, 'a later begin is not blocked');
});

test('t1539 refusals: codex seat, a second begin while a clone lives, begin from a clone, an empty body — one line each, zero create()', async () => {
  const f = mkClone();
  f.s.agentType = 'codex';
  await f.begin();
  assert.strictEqual(f.creates.length, 0);
  assert.strictEqual(f.replies().length, 1);
  assert.match(f.replies()[0], /Claude seats only/);
  f.s.agentType = 'claude';

  const g = mkClone();
  await g.begin('   \n  ');
  assert.strictEqual(g.creates.length, 0);
  assert.strictEqual(g.replies().length, 1);
  assert.match(g.replies()[0], /begin refused: the brief is empty/);

  await g.begin();
  assert.strictEqual(g.creates.length, 1);
  const before = g.replies().length;
  await g.begin('another one');
  assert.strictEqual(g.creates.length, 1, 'no second clone');
  assert.strictEqual(g.replies().length, before + 1);
  assert.match(g.replies().at(-1), /begin refused: clone a-scratch-[0-9a-f]{4} is still running/);

  const clone = g.clone();
  await g.m._handleIntent(clone.name, parseIntent('[agent:scratch begin] nested'));
  assert.strictEqual(g.creates.length, 1, 'a clone forks nothing');
  const toClone = g.injected.filter((i) => i.to === clone.name).map((i) => i.text);
  assert.deepStrictEqual(toClone.slice(1), [`[agent:scratch] ${SCRATCH_CLONE_REFUSAL}`]);
});

test('t1539 a clone\'s other intents are refused with one line and dispatch nothing', async () => {
  const f = mkClone();
  await f.begin();
  const clone = f.clone();
  const handled = [];
  f.m._handleTaskIntent = () => handled.push('task');
  f.m._handleMemoryIntent = () => handled.push('memory');
  f.m._gatedDeliver = () => { handled.push('dm'); return {}; };
  for (const line of ['[agent:dm a] look', '[agent:task add] do it', '[agent:memory remember] fact']) {
    await f.m._handleIntent(clone.name, parseIntent(line));
  }
  assert.deepStrictEqual(handled, []);
  const lines = f.injected.filter((i) => i.to === clone.name).map((i) => i.text).slice(1);
  assert.deepStrictEqual(lines, [
    `[agent:dm] ${SCRATCH_CLONE_REFUSAL}`,
    `[agent:task] ${SCRATCH_CLONE_REFUSAL}`,
    `[agent:memory] ${SCRATCH_CLONE_REFUSAL}`,
  ]);
  assert.ok(!f.delivered.some((d) => d.to === 'a'), 'nothing reached the parent');
});

test('t1539 scratch end from the clone: empty summary refused; a summary reaches the parent once from scratch and the clone retires quietly', async () => {
  const f = mkClone();
  await f.begin();
  const clone = f.clone();
  const cloneSid = clone._scratchCloneSid;
  await f.m._handleIntent(clone.name, { type: 'scratch', sub: 'end', label: null, replay: false, body: '  ' });
  assert.match(f.injected.at(-1).text, /^\[agent:scratch\] end refused: the summary body is empty/);
  assert.deepStrictEqual(f.kills, []);

  f.delivered.length = 0;
  f.parked.length = 0;
  await f.m._handleIntent(clone.name, { type: 'scratch', sub: 'end', label: null, replay: false, body: 'strip levels live in stripAsserted\nsee wirescope-proxy.js' });
  assert.deepStrictEqual(f.delivered, [{ to: 'a', from: 'scratch', body: '[scratch] clone summary:\nstrip levels live in stripAsserted\nsee wirescope-proxy.js' }]);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(f.kills, [clone.name]);
  assert.ok(f.removed.includes(clone.name), 'record dropped');
  assert.ok(f.strips.some((x) => x.sid === cloneSid && x.level === 0), 'strip override cleared');
  assert.ok(f.hints.some((h) => h.agent === clone.proxyAgent && h.clear === true), 'spawner hint cleared');
  assert.strictEqual(f.s._scratchClone, null);
  f.m._notifyComposition(clone, 'retired');
  const toLead = f.parked.filter((p) => p.name === 'lead').map((p) => p.text);
  assert.ok(!toLead.some((t) => t.includes(clone.name)), `the lead hears nothing about ${clone.name}: ${toLead}`);
});

test('t1539 mute: a roster push, a reminder and a dm addressed to the clone never reach it; the dm answers not addressable', async () => {
  const f = mkClone();
  await f.begin();
  const clone = f.clone();
  const before = f.injected.filter((i) => i.to === clone.name).length;
  f.m._deliverPassive(clone.name, 'team', 'roster', 'dm');
  f.m._deliverMessage(clone.name, 'reminder', 'ping', 'dm');
  f.m._injectTextPassive(clone, 'passive');
  await f.m._handleIntent('a', parseIntent(`[agent:dm ${clone.name}] hello`));
  assert.strictEqual(f.injected.filter((i) => i.to === clone.name).length, before);
  assert.deepStrictEqual(f.parked.filter((p) => p.name === clone.name), []);
  assert.match(f.replies().at(-1), new RegExp(`^\\[agent:dm\\] ${clone.name} is a scratch clone — not addressable`));
  assert.ok(!f.m._teamLiveSeats(f.root).some((x) => x.name === clone.name), 'not in the roster');
  assert.match(f.m._gatedDeliver(clone.name, 'x', 'y', false).error, /not addressable/);
});

test('t1539 the composition notice skips a clone, so the lead never hears it spawn or retire', async () => {
  const f = mkClone();
  await f.begin();
  const clone = f.clone();
  f.m._notifyComposition(clone, 'spawned');
  f.m._notifyComposition(clone, 'retired');
  assert.deepStrictEqual(f.parked.filter((p) => p.name === 'lead'), []);
  f.m._notifyComposition(f.s, 'retired');
  assert.strictEqual(f.parked.filter((p) => p.name === 'lead').length, 1, 'the rig does deliver a real seat\'s notice');
});

test('t1539 ceiling: past 45m the clone is killed and the parent hears why', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = mkClone();
  await f.begin();
  const clone = f.clone();
  t.mock.timers.tick(CEILING_MS - 1);
  assert.deepStrictEqual(f.kills, []);
  t.mock.timers.tick(1);
  assert.deepStrictEqual(f.delivered.filter((d) => d.to === 'a'),
    [{ to: 'a', from: 'scratch', body: `[scratch] clone ${clone.name} ended without a summary (45m ceiling)` }]);
  t.mock.timers.reset();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(f.kills, [clone.name]);
});

test('t1539 parent kill kills the clone; parent cancel kills it with no summary', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = mkClone();
  await f.begin();
  const clone = f.clone();
  delete f.m.kill;
  f.s.stream = { kill() {} };
  const kills = [];
  const realKill = f.m.kill.bind(f.m);
  f.m.kill = async (name) => { kills.push(name); if (name === 'a') return realKill(name); };
  await f.m.kill('a');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(kills, ['a', clone.name]);
  t.mock.timers.reset();

  const g = mkClone();
  await g.begin();
  const c2 = g.clone();
  g.m._handleScratchIntent(g.s, { type: 'scratch', sub: 'cancel', label: null, replay: false, body: '' });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(g.kills, [c2.name]);
  assert.strictEqual(g.replies().at(-1), '[scratch] clone cancelled, no summary');
  assert.ok(!g.delivered.some((d) => d.to === 'a'), 'no summary delivered');
});

test('t1539 grammar: a bodied begin is greedy, a bare begin is not', () => {
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:scratch begin] look at x')), 'greedy');
  assert.strictEqual(registry.bodyModeFor(parseIntent('[agent:scratch begin]')), 'none');
});

test('t1541 the clone carries the parent\'s effective agents and skills, so items scoped to the parent\'s name by sessions: survive the new name', async () => {
  const agentLib = [{ name: 'clodex-locate', meta: {} }, { name: 'parent-agent', meta: { sessions: 'a' } }];
  const skillLib = [{ name: 'lib-skill', meta: {} }, { name: 'parent-skill', meta: { sessions: 'a, other' } }];
  const f = mkClone({ agentLib, skillLib, record: { injectSkills: ['lib-skill'] } });
  await f.m._scratchRespawn('a', f.record);
  const parentArgs = f.creates.shift().args;
  await f.begin();
  const args = f.creates[0].args;
  const names = (list) => list.map((x) => x.name);
  const agentsOf = effectiveFrom(agentLib);
  const skillsOf = effectiveFrom(skillLib);
  assert.deepStrictEqual(args[9], ['clodex-locate', 'parent-agent']);
  assert.deepStrictEqual(args[13], ['lib-skill', 'parent-skill']);
  assert.deepStrictEqual(names(agentsOf(args[0], args[9])), names(agentsOf('a', parentArgs[9])),
    'create() derives the same agent set for the clone as for the parent');
  assert.deepStrictEqual(names(skillsOf(args[0], args[13])), names(skillsOf('a', parentArgs[13])),
    'create() derives the same skill set for the clone as for the parent');
});

test('t1541 refusals and failures stay active: a refused begin wakes the parent, nothing goes passive', async () => {
  const f = mkClone({ stripFail: true });
  await f.begin();
  assert.strictEqual(f.replies().length, 1);
  assert.deepStrictEqual(f.passive, []);
});

test('t1541 a summary after retire is dropped: a second end, and an end after cancel, deliver nothing more', async () => {
  const f = mkClone();
  await f.begin();
  const clone = f.clone();
  const end = (body) => f.m._handleScratchIntent(clone, { type: 'scratch', sub: 'end', label: null, replay: false, body });
  end('first');
  end('second');
  assert.deepStrictEqual(f.delivered.filter((d) => d.to === 'a').map((d) => d.body), ['[scratch] clone summary:\nfirst']);

  const g = mkClone();
  await g.begin();
  const c2 = g.clone();
  g.m._handleScratchIntent(g.s, { type: 'scratch', sub: 'cancel', label: null, replay: false, body: '' });
  const before = g.injected.length;
  g.m._handleScratchIntent(c2, { type: 'scratch', sub: 'end', label: null, replay: false, body: 'late' });
  assert.deepStrictEqual(g.delivered.filter((d) => d.to === 'a'), []);
  assert.strictEqual(g.injected.length, before, 'nothing reaches the parent or the clone');
});

test('t1541 strip level: an explicit 0 under a global default is mirrored, and the record fallback is clamped to the proxy\'s max_level', async () => {
  const f = mkClone({
    record: { stripLevel: 0 },
    poller: { last: new Map([['a', { sessionId: SID, strip: { configuredLevel: 0, source: 'override', globalDefaultLevel: 1 } }]]) },
  });
  await f.begin();
  const cloneSid = f.creates[0].args[3][f.creates[0].args[3].indexOf('--session-id') + 1];
  assert.deepStrictEqual(f.strips, [{ base: BASE, sid: cloneSid, level: 0, explicitZero: true }]);
  assert.deepStrictEqual(f.seq, ['strip', 'create']);

  const g = mkClone({ poller: { stripCapBases: new Map([[BASE, { available: true, max_level: 1 }]]) } });
  await g.begin();
  assert.strictEqual(g.strips[0].level, 1, 'record level 2 rides as 1 on a proxy whose max_level is 1');
  assert.strictEqual(g.strips[0].explicitZero, false);
});

test('t1541 a clone gone when create() resolves: the parent hears the begin failed', async () => {
  const f = mkClone();
  const realCreate = f.m.create;
  f.m.create = async (...args) => { await realCreate(...args); f.m.sessions.delete(args[0]); };
  await f.begin();
  assert.strictEqual(f.s._scratchClone, null);
  assert.match(f.replies().at(-1), /^\[agent:scratch\] begin failed: the clone a-scratch-[0-9a-f]{4} exited as it started/);
});

test('t1541 the spawning marker carries the clone sid and strip base, so a clone dying before create() returns still clears its override', async () => {
  const f = mkClone();
  await f.begin();
  const { spawning } = f.creates[0];
  const cloneSid = f.creates[0].args[3][f.creates[0].args[3].indexOf('--session-id') + 1];
  assert.deepStrictEqual(spawning, { parent: 'a', sid: cloneSid, stripBase: BASE });
  const clone = f.clone();
  assert.strictEqual(clone._scratchCloneSid, cloneSid);
  assert.strictEqual(clone._scratchCloneStripBase, BASE);
});

test('t1541 retire removes the clone\'s seat dir after the kill', async () => {
  const f = mkClone();
  await f.begin();
  const clone = f.clone();
  const dir = require('../clodex-paths').seatDirFor(f.root, clone.name);
  fs.mkdirSync(dir, { recursive: true });
  f.m._handleScratchIntent(clone, { type: 'scratch', sub: 'end', label: null, replay: false, body: 'done' });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(f.kills, [clone.name]);
  assert.strictEqual(fs.existsSync(dir), false);
});

test('t1541 a throw before the spawn try is caught at the scratch call site, not left unhandled', async () => {
  const f = mkClone();
  const errors = [];
  f.m._scratchCloneSpawn = async () => { throw new Error('boom'); };
  const onUnhandled = (e) => errors.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    await f.m._handleIntent('a', parseIntent('[agent:scratch begin] look\n[agent:end]'));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepStrictEqual(errors, []);
});

test('t1543 F3 a clone that exits inside create(): the parent hears one notice, not the exit notice plus "exited as it started"', async () => {
  const f = mkClone();
  const realCreate = f.m.create;
  f.m.create = async (...args) => {
    await realCreate(...args);
    f.m._scratchCloneOnExit(f.m.sessions.get(args[0]));
    f.m.sessions.delete(args[0]);
  };
  await f.begin();
  const notices = [...f.delivered.filter((d) => d.to === 'a').map((d) => d.body), ...f.replies()];
  assert.deepStrictEqual(notices, [`[scratch] clone ${f.cloneName()} exited without a summary`]);
  assert.strictEqual(f.s._scratchClone, null);
});

test('t1543 F3 a throw before the spawn try replies begin failed and frees the parent for a second begin', async () => {
  const f = mkClone();
  const realStrip = f.m._scratchCloneStripLevel;
  f.m._scratchCloneStripLevel = () => { throw new Error('poller gone'); };
  await f.begin();
  assert.deepStrictEqual(f.replies(), ['[agent:scratch] begin failed: poller gone. Nothing was forked.']);
  assert.strictEqual(f.s._scratchClone, null);
  f.m._scratchCloneStripLevel = realStrip;
  await f.begin();
  assert.strictEqual(f.creates.length, 1);
});

test('t1544 a throw after create() resolved retires the clone and says so instead of "Nothing was forked"', async () => {
  const f = mkClone();
  const realInject = f.m._injectText;
  f.m._injectText = (sess, text, opts) => {
    if (sess.clone) throw new Error('inject broke');
    return realInject(sess, text, opts);
  };
  await f.begin();
  await new Promise((r) => setImmediate(r));
  const name = f.cloneName();
  assert.strictEqual(f.creates.length, 1);
  assert.deepStrictEqual(f.replies(), [`[agent:scratch] begin failed after the fork: inject broke; the clone was retired.`]);
  assert.strictEqual(f.s._scratchClone, null);
  assert.strictEqual(f.clone()._scratchCloneRetired, true);
  assert.strictEqual(f.clone()._scratchCloneTimer, null);
  assert.deepStrictEqual(f.kills, [name]);
  assert.deepStrictEqual(f.strips.at(-1), { base: f.strips[0].base, sid: f.strips[0].sid, level: 0, explicitZero: false });
});

test('t1546 a successful begin sends the clone one background reattach naming its parent, and the parent none', async () => {
  const f = mkClone();
  await f.begin();
  const ctx = (n) => f.sent.filter((a) => a[0] === n && a[1] === 'session:context-action');
  const pushes = ctx(f.cloneName());
  assert.strictEqual(pushes.length, 1);
  const p = pushes[0][2];
  assert.deepStrictEqual({ action: p.action, name: p.name, type: p.type, io: p.io, background: p.background, clone: p.clone },
    { action: 'reattach', name: f.cloneName(), type: 'claude', io: 'pty', background: true, clone: 'a' });
  assert.deepStrictEqual(ctx('a'), []);
});

test('t1546 list() carries clone on the clone row and no clone key on the parent', async () => {
  const f = mkClone();
  await f.begin();
  f.m.accountFor = () => null;
  f.m.modelFor = () => null;
  const rows = f.m.list();
  const pick = (n) => { const r = rows.find((x) => x.name === n); return 'clone' in r ? { name: n, clone: r.clone } : { name: n }; };
  assert.deepStrictEqual(pick(f.cloneName()), { name: f.cloneName(), clone: 'a' });
  assert.deepStrictEqual(pick('a'), { name: 'a' });
});

test('t1547 a clone retired in the same tick as its spawn (parent dead) gets no reattach push, so no row flashes', async () => {
  const f = mkClone();
  const realCreate = f.m.create;
  f.m.create = async (...args) => { const r = await realCreate(...args); f.s._dead = true; return r; };
  await f.begin();
  assert.deepStrictEqual(f.sent.filter((a) => a[1] === 'session:context-action'), []);
  assert.strictEqual(f.clone()._scratchCloneRetired, true);
});

for (const row of [
  { verb: 'rename', call: (m, n) => m.rename(n, 'renamed-clone') },
  { verb: 'moveToWorkspace', call: (m, n) => m.moveToWorkspace(n, 'ws2') },
  { verb: 'moveToPeer', call: (m, n) => m.moveToPeer(n, 'peer1') },
]) {
  test(`t1547 ${row.verb} on a scratch clone is refused in the main process`, async () => {
    const f = mkClone();
    await f.begin();
    const res = await row.call(f.m, f.cloneName());
    assert.deepStrictEqual(res, { ok: false, error: `${f.cloneName()} is a scratch clone — cancel it from its parent instead` });
  });
}
