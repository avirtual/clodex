'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');

const { mkPark } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');
const ticketsMod = require('../tickets-store');
const { recordsOf } = require('../transcript-records');
const { surfaceOf } = require('../renderer/lib/transcript-surface');

const SPILL = '/tmp/clodex-spill/msg-1.txt';
const THRESHOLD = 500;

function mkLoop() {
  const home = mkTmpRoot('clodex-t817-');
  const root = pathReal.join(home, 'proj');
  fsReal.mkdirSync(root, { recursive: true });
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root, lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      hand: { instantiate: 'session', brief: 'the hand' },
    },
  };
  const gated = [];
  const { m, injected } = mkPark({
    REGISTRY_DIR: home,
    fs: fsReal,
    path: pathReal,
    pathFor: require('../clodex-paths').pathFor,
    spillToFile: () => SPILL,
    MSG_SPILL_THRESHOLD: THRESHOLD,
    resolveTeam: (cwd) => (cwd && cwd.startsWith(root) ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith(root) ? root : null),
  });
  m._gatedDeliver = (target, sender, body, urgent, tag) => {
    gated.push({ target, sender, body, tag });
    return { queued: true };
  };
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._teamLiveSeatNames = () => ['lead', 'team-hand'];
  const seat = (name) => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd: root, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  seat('lead');
  const now = Date.now();
  tstore.save(root, [{
    id: 't1', state: 'open', spec: 'build the widget', assignee: 'team-hand', role: 'hand',
    openedAt: now, startedAt: now, lastActivityAt: now,
  }]);
  const deliver = (agentType) => {
    const g = gated[gated.length - 1];
    return m._buildDeliveryText({ name: g.target, agentType }, g.sender, g.body, 'dm', g.tag);
  };
  return { m, gated, seat, deliver, injected };
}

function recordOf(text) {
  const line = JSON.stringify({ type: 'user', uuid: 'u', message: { role: 'user', content: text } });
  const { records } = recordsOf(line);
  assert.strictEqual(records.length, 1, `ENTER: the delivery parses to one record. Got:\n${text}`);
  return records[0];
}

function verdict(f, kind, mustFix) {
  f.m._notifyLeadOfVerdict(f.m.sessions.get('lead'), 'lead', 't1',
    { verdict: kind, mustFix, reviewRound: 2 }, `VERDICT: ${kind}`, { ok: true, path: '/tmp/verdict.md' });
  assert.strictEqual(f.gated.length, 1, 'ENTER: the verdict was delivered');
}

test('an inline ACCEPT verdict opens with its ticket marker and lands as a conversation row', () => {
  const f = mkLoop();
  verdict(f, 'ACCEPT', null);
  assert.ok(f.gated[0].body.length <= THRESHOLD, 'ENTER: this verdict stays inline');
  const text = f.deliver('claude');
  assert.ok(!/attached:|saved to/.test(text), `ENTER: nothing spilled. Got:\n${text}`);
  const r = recordOf(text);
  assert.strictEqual(r.kind, 'inbound');
  assert.deepStrictEqual(r.ticket, { id: 't1', tag: 'ACCEPT' });
  assert.strictEqual(surfaceOf(r), 'conversation');
});

test('a spilled REWORK verdict keeps its marker on the pointer line, claude and codex forms alike', () => {
  const mf = Array.from({ length: 12 }, (_, i) => `- must-fix number ${i} with enough words to grow the brief`).join('\n');
  for (const [agentType, form] of [['claude', 'attached:'], ['codex', 'saved to']]) {
    const f = mkLoop();
    verdict(f, 'REWORK', mf);
    assert.ok(f.gated[0].body.length > THRESHOLD, `ENTER: this verdict is over the spill threshold (${f.gated[0].body.length})`);
    const text = f.deliver(agentType);
    assert.ok(text.includes(form), `ENTER: the ${agentType} delivery really spilled. Got:\n${text}`);
    const r = recordOf(text);
    assert.deepStrictEqual(r.ticket, { id: 't1', tag: 'REWORK' }, agentType);
    assert.strictEqual(surfaceOf(r), 'conversation', agentType);
  }
});

function done(f, report) {
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: report });
  const toLead = f.gated.filter((g) => g.target === 'lead');
  assert.strictEqual(toLead.length, 1, `ENTER: the done report went to the lead. Replies: ${JSON.stringify(f.injected)}`);
  f.gated.splice(0, f.gated.length, toLead[0]);
}

test('an inline done report lands as a conversation row with its ticket marker', () => {
  const f = mkLoop();
  done(f, 'shipped it');
  const text = f.deliver('claude');
  assert.ok(!/attached:|saved to/.test(text), `ENTER: nothing spilled. Got:\n${text}`);
  const r = recordOf(text);
  assert.deepStrictEqual(r.ticket, { id: 't1', tag: 'done' });
  assert.strictEqual(surfaceOf(r), 'conversation');
});

test('a spilled done report keeps its ticket marker on the pointer line, claude and codex forms alike', () => {
  for (const [agentType, form] of [['claude', 'attached:'], ['codex', 'saved to']]) {
    const f = mkLoop();
    done(f, 'r'.repeat(THRESHOLD + 50));
    const text = f.deliver(agentType);
    assert.ok(text.includes(form), `ENTER: the ${agentType} delivery really spilled. Got:\n${text}`);
    const r = recordOf(text);
    assert.deepStrictEqual(r.ticket, { id: 't1', tag: 'done' }, agentType);
    assert.strictEqual(surfaceOf(r), 'conversation', agentType);
  }
});

test('a spilled cancel reason keeps its ticket marker on the pointer line', () => {
  const f = mkLoop();
  f.seat('team-hand');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'cancel', id: 't1', who: null, body: 'c'.repeat(THRESHOLD + 50) });
  const g = f.gated.find((d) => d.target === 'team-hand' && d.tag === '[ticket t1 cancelled]');
  assert.ok(g, `ENTER: the cancel reason went to the hand. Gated: ${JSON.stringify(f.gated.map((d) => [d.target, d.tag]))}`);
  const text = f.m._buildDeliveryText({ name: g.target, agentType: 'claude' }, g.sender, g.body, 'dm', g.tag);
  assert.ok(text.includes('attached:'), `ENTER: the delivery really spilled. Got:\n${text}`);
  const r = recordOf(text);
  assert.deepStrictEqual(r.ticket, { id: 't1', tag: 'cancelled' });
  assert.strictEqual(surfaceOf(r), 'conversation');
});
