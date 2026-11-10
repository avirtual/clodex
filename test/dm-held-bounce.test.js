'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mk, mkPark } = require('./lib/session-fixtures');

async function bounce(verdict) {
  const injected = [];
  const broadcasts = [];
  const m = mk();
  m._injectText = (_s, text) => injected.push(text);
  m._broadcast = (ch, msg) => broadcasts.push({ ch, msg });
  m._gatedDeliver = () => verdict;
  m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1' });
  m.sessions.set('contrarian', { name: 'contrarian', agentType: 'codex', workspaceId: 'ws1' });
  await m._handleIntent('a', { type: 'dm', target: 'contrarian', body: 'the payload' });
  const notice = injected.find((t) => t.startsWith('[agent:dm]')) || '';
  const ipc = broadcasts.find((b) => b.ch === 'ipc-message');
  return { notice, ipcBody: ipc ? ipc.msg.body : '' };
}

const REASON = 'idle 5h with a cold cache — would re-read the whole context';

const rows = [
  {
    name: 'held behind a dialog',
    verdict: { held: 'blocked on a permission dialog', noUrgent: true },
    has: ['NOT delivered to contrarian: blocked on a permission dialog', 'Nothing was kept. Resend after contrarian is unblocked'],
    ipc: 'HELD (blocked on a permission dialog): the payload',
  },
  {
    name: 'parked',
    verdict: { parked: 'p1', reason: REASON },
    has: [`parked for contrarian (${REASON}) as p1`],
    ipc: `PARKED (${REASON}, p1): the payload`,
  },
];

for (const row of rows) {
  test(`t1647 dm bounce, ${row.name}: real reason, no false delivery promise`, async () => {
    const { notice, ipcBody } = await bounce(row.verdict);
    for (const s of row.has) assert.ok(notice.includes(s), `notice ${JSON.stringify(notice)} lacks ${JSON.stringify(s)}`);
    assert.ok(!notice.includes('undefined'), notice);
    assert.ok(!notice.includes('cheapest right after'), notice);
    assert.strictEqual(ipcBody, row.ipc);
  });
}

test('t1647 the dm bounce block reads the reason through why, never ${r.reason}', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');
  const start = src.indexOf('if (r.parked || r.held) {');
  assert.ok(start > 0);
  const end = src.indexOf('break;', start);
  const block = src.slice(start, end);
  assert.ok(block.includes('const why = r.parked ? r.reason : r.held;'));
  assert.ok(!block.includes('${r.reason}'));
  assert.ok(block.includes('Nothing was kept'));
});

function coldSeat(agentType, extra = {}) {
  const { m, injected } = mkPark({ shouldHoldDm: require('../proxy-util').shouldHoldDm });
  m._proxyPoller = { snapshot: () => ({ linked: true, warmth: { state: 'cold' }, ts: Date.now() }) };
  m._sendToSession = () => {};
  m._armDmConfirm = () => {};
  m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1', activityState: 'idle', activityTs: Date.now() });
  m.sessions.set('t', { name: 't', agentType, workspaceId: 'ws1', activityState: 'idle', activityTs: Date.now() - 2 * 3600_000, ...extra });
  return { m, injected };
}

for (const agentType of ['clodent', 'codex']) {
  test(`t2238 a plain dm to a cold idle ${agentType} seat is delivered, and the sender hears nothing`, async () => {
    const { m, injected } = coldSeat(agentType);
    await m._handleIntent('a', { type: 'dm', target: 't', body: 'the question' });
    assert.ok(injected.some((t) => t.startsWith('[agent:from a]') && t.includes('the question')), JSON.stringify(injected));
    assert.deepStrictEqual(injected.filter((t) => t.startsWith('[agent:dm]')), []);
  });

  test(`t2238 a plain dm to a ${agentType} seat on a permission dialog is still held with the dialog wording`, async () => {
    const { m, injected } = coldSeat(agentType, { needsAttention: { kind: 'permission' } });
    await m._handleIntent('a', { type: 'dm', target: 't', body: 'the question' });
    assert.deepStrictEqual(injected, ['[agent:dm] NOT delivered to t: blocked on a permission dialog — injecting now would answer the dialog. Nothing was kept. Resend after t is unblocked (a human has to answer the dialog).']);
  });
}

test('t2238 a plain dm to a cold idle claude seat is still parked, not delivered', async () => {
  const { m, injected } = coldSeat('claude');
  await m._handleIntent('a', { type: 'dm', target: 't', body: 'the question' });
  assert.ok(!injected.some((t) => t.startsWith('[agent:from a]')), JSON.stringify(injected));
  assert.ok(injected.some((t) => t.startsWith('[agent:dm] parked for t (idle 2h with a cold cache')), JSON.stringify(injected));
});
