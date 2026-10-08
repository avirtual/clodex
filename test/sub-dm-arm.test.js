'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { mk } = require('./lib/session-fixtures');

const ALICE = { agentId: 'A', agentType: 'gp', label: 'a/alice' };

function harness() {
  const m = mk();
  const delivered = [];
  const broadcasts = [];
  m._broadcast = (ch, msg) => { if (ch === 'ipc-message') broadcasts.push(msg); };
  const verdicts = [];
  m._gatedDeliver = (target, tag, body, urgent) => { delivered.push({ target, tag, body, urgent }); return verdicts.shift() || {}; };
  m._armDmConfirm = () => {};
  m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1' });
  m.sessions.set('b', { name: 'b', agentType: 'claude', workspaceId: 'ws1' });
  const send = async (intent, fromIdent, fromLabel = null) => {
    const replies = [];
    await m._handleIntent('a', { type: 'dm', target: 'b', body: 'hi', ...intent }, { replyTo: (t) => { replies.push(t); return true; }, fromLabel, fromIdent });
    return replies;
  };
  return { m, delivered, broadcasts, send, verdicts };
}

function withNow(fn) {
  const real = Date.now;
  let t = 1_000_000;
  Date.now = () => t;
  return Promise.resolve().then(() => fn((v) => { t = v; })).finally(() => { Date.now = real; });
}

test('a verified subagent dm is delivered and broadcast as its label; the main agent sends as the seat', async () => {
  const h = harness();
  assert.deepStrictEqual(await h.send({}, ALICE, 'a/agent'), []);
  assert.deepStrictEqual(h.delivered, [{ target: 'b', tag: 'a/alice', body: 'hi', urgent: false }]);
  assert.deepStrictEqual(h.broadcasts.map((b) => b.from), ['a/alice']);
  await h.send({}, null, null);
  assert.strictEqual(h.delivered[1].tag, 'a');
  assert.strictEqual(h.broadcasts[1].from, 'a');
});

test('a subagent dm that is urgent or names an @peer is refused to the caller and nothing is sent', async () => {
  const h = harness();
  assert.deepStrictEqual(await h.send({ urgent: true }, ALICE), ['[agent:dm] refused: a subagent dm is never urgent']);
  assert.deepStrictEqual(await h.send({ target: 'b@box' }, ALICE), ['[agent:dm] refused: a subagent can dm local seats only (no @peer)']);
  assert.deepStrictEqual(h.delivered, []);
  assert.deepStrictEqual(h.broadcasts, []);
});

test('a subagent dm is capped at 10 per 60 s per agent', () => withNow(async (setNow) => {
  const h = harness();
  for (let i = 0; i < 10; i++) assert.deepStrictEqual(await h.send({}, ALICE), []);
  assert.deepStrictEqual(await h.send({}, { ...ALICE, agentId: 'B', label: 'a/bob' }), []);
  setNow(1_000_000 + 59_000);
  assert.deepStrictEqual(await h.send({}, ALICE), ['dm: rate limit — 10 in 60 s from a/alice']);
  assert.strictEqual(h.delivered.length, 11);
  setNow(1_000_000 + 61_000);
  assert.deepStrictEqual(await h.send({}, ALICE), []);
  assert.strictEqual(h.delivered.length, 12);
}));

const MAIN_HELD = "[agent:dm] NOT delivered to b: cold. Nothing was kept (b cannot park messages). Resend as `[agent:dm b urgent] <message>` to deliver it now.";

test('a parked or held subagent dm answers without the resend or urgent clause; the dialog texts and main texts are unchanged', async () => {
  const h = harness();
  h.verdicts.push({ parked: 'p1', reason: 'cold' });
  assert.deepStrictEqual(await h.send({}, ALICE), ["[agent:dm] parked for b (cold) as p1 — it'll be delivered with b's next turn."]);
  h.verdicts.push({ held: 'cold' });
  assert.deepStrictEqual(await h.send({}, ALICE), ['[agent:dm] NOT delivered to b: cold. Nothing was kept (b cannot park messages).']);
  h.verdicts.push({ parked: 'p1', reason: 'dialog', noUrgent: true });
  assert.deepStrictEqual(await h.send({}, ALICE), ["[agent:dm] parked for b (dialog) as p1 — it'll be delivered after the human answers the dialog."]);
  h.verdicts.push({ held: 'cold' });
  assert.deepStrictEqual(await h.send({}, null), [MAIN_HELD]);
});

test('the subagent rate map drops an agent whose newest send left the window', () => withNow(async (setNow) => {
  const h = harness();
  await h.send({}, ALICE);
  assert.ok(h.m._subDmSent.has('A'));
  setNow(1_000_000 + 60_000);
  await h.send({}, { ...ALICE, agentId: 'B', label: 'a/bob' });
  assert.strictEqual(h.m._subDmSent.has('A'), false);
  assert.ok(h.m._subDmSent.has('B'));
  const h2 = harness();
  setNow(1_000_000);
  await h2.send({}, ALICE);
  setNow(1_000_000 + 59_000);
  await h2.send({}, { ...ALICE, agentId: 'B', label: 'a/bob' });
  assert.ok(h2.m._subDmSent.has('A'));
}));

test('a subagent dm to <gone>/<name> reports NOT delivered first, so it classifies as error', async () => {
  const h = harness();
  const replies = await h.send({ target: 'gone/alice' }, ALICE);
  assert.match(replies[0], /^\[agent:dm\] NOT delivered: no agent named "gone"/);
  assert.strictEqual(require('../intent-registry').classifyReplyLine('dm', replies[0]), 'error');
  assert.ok(!replies.some((l) => /not running/.test(l)));
});

test('on the fallback the outcome line comes first and the routed notice after it', async () => {
  const h = harness();
  h.verdicts.push({ held: 'cold' });
  assert.deepStrictEqual(await h.send({ target: 'b/alice' }, ALICE), ['[agent:dm] NOT delivered to b: cold. Nothing was kept (b cannot park messages).', '[agent:dm] subagent alice is not running; routed to b']);
});
