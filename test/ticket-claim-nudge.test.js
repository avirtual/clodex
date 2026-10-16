'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { TICKET_CLAIM_RE } = require('../ticket-claim-nudge');
const { parseIntent, looksLikeIntent } = require('../intent-scanner');
const { mk } = require('./lib/session-fixtures');

const MGR_DEPS = {
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  parseIntent,
  looksLikeIntent,
  execBodyCap: 64 * 1024,
};

function mkMgr() {
  const m = mk({
    ...MGR_DEPS,
    getPersistence: () => ({ list: () => [], get: (n) => (n === 'lead' ? { intents: ['*'] } : { intents: ['dm'] }) }),
  });
  const injected = [];
  m._injectText = (s, t, o) => injected.push([s.name, t, o]);
  m._handleTask = () => {};
  m._maybeSpeak = () => {};
  m._publishAgentText = () => {};
  m.sessions.set('lead', { name: 'lead', agentType: 'claude' });
  m.sessions.set('hand', { name: 'hand', agentType: 'claude' });
  const step = (seat, text, turnEnd, extra = {}) => m._scanJsonlText(text, seat, [], { turnEnd, ...extra });
  return { m, injected, step };
}

async function settle() {
  await new Promise((r) => setImmediate(r));
}

const WORDING_1 = (w) => `[agent:intent] your prose says a ticket was ${w} but this turn carried no [agent:task ...] intent — `
  + 'nothing was filed. Emit the intent with its full body, closed by [agent:end].';
const WORDING_2 = (head) => `[agent:intent] ${head} carried an EMPTY body — the hand received only a reopen/title. `
  + 'Re-emit it with the full body, closed by [agent:end].';

test('the claim regex is pinned to its literal', () => {
  assert.strictEqual(TICKET_CLAIM_RE.source,
    "\\b(?:ticket|t\\d{2,5})\\b[^.\\n]{0,80}\\b(?:filed|dispatched|rejected|respec'?d|cancell?ed)\\b|\\b(?:filed|dispatched|rejected|respec'?d|cancell?ed)\\b[^.\\n]{0,80}\\b(?:ticket|t\\d{2,5})\\b");
  assert.strictEqual(TICKET_CLAIM_RE.flags, 'i');
});

test('each one-step reply row fires its wording, parkable, or stays silent', async () => {
  const rows = [
    { what: 'claim, no verb', seat: 'lead', text: 'I filed the ticket for the parser.',
      want: [WORDING_1('filed')] },
    { what: 'claim, task add with body', seat: 'lead', text: 'I filed the ticket.\n[agent:task add] fix the parser\n[agent:end]',
      want: [] },
    { what: 'claim, reject with empty body', seat: 'lead', text: 't1851 is rejected.\n[agent:task reject t1851]\n[agent:end]',
      want: [WORDING_2('[agent:task reject t1851]')] },
    { what: 'no claim, respec with empty body', seat: 'lead', text: 'Moving on.\n[agent:task respec t1849]\n[agent:end]',
      want: [WORDING_2('[agent:task respec t1849]')] },
    { what: 'empty task add, no prose', seat: 'lead', text: '[agent:task add]\n[agent:end]',
      want: [WORDING_2('[agent:task add]')] },
    { what: 'bare cancel, reason optional', seat: 'lead', text: 'Cancelled t1840.\n[agent:task cancel t1840]\n[agent:end]',
      want: [] },
    { what: 'claim inside a fence', seat: 'lead', text: 'Draft:\n```\nI filed the ticket\n```\nDone.',
      want: [] },
    { what: 'claim in an escaped intent line', seat: 'lead', text: '\\[agent:task add] the ticket was filed here',
      want: [] },
    { what: 'hand seat, claim, no verb', seat: 'hand', text: 'I filed the ticket for the parser.',
      want: [] },
    { what: 'quoted loop notice, no claim verb', seat: 'lead', text: 'ticket t1850 MERGED',
      want: [] },
    { what: 'claim inside a task done body', seat: 'lead', text: '[agent:task done t1852] t1851 was rejected upstream\n[agent:end]',
      want: [] },
  ];
  const fired = [];
  for (const row of rows) {
    const { injected, step } = mkMgr();
    step(row.seat, row.text, true);
    await settle();
    assert.deepStrictEqual(injected, row.want.map((t) => [row.seat, t, { parkable: true }]), row.what);
    if (injected.length) fired.push(row.what);
  }
  assert.ok(fired.includes('claim, no verb'));
  assert.ok(fired.includes('claim, reject with empty body'));
  assert.ok(fired.includes('no claim, respec with empty body'));
});

test('a verb in an earlier step of the turn silences a later claim', async () => {
  const { injected, step } = mkMgr();
  step('lead', '[agent:task add] fix the parser\n[agent:end]', false);
  step('lead', 'Filed t1853 for the parser.', true);
  await settle();
  assert.deepStrictEqual(injected, []);
});

test('a claim in an earlier step is silenced by a verb in a later step', async () => {
  const { injected, step } = mkMgr();
  step('lead', 'Rejecting t1851 — t1851 will be rejected after I check the diff.', false);
  step('lead', '[agent:task reject t1851] the pin is not red-proofed\n[agent:end]', true);
  await settle();
  assert.deepStrictEqual(injected, []);
});

test('a claim repeated across steps with no verb fires once, at turn end, and the next turn starts clean', async () => {
  const { injected, step } = mkMgr();
  step('lead', 'I filed the ticket.', false);
  assert.deepStrictEqual(injected, []);
  step('lead', 'The ticket was filed, as said.', false);
  step('lead', 'Done for now.', true);
  assert.deepStrictEqual(injected, [['lead', WORDING_1('filed'), { parkable: true }]]);
  step('lead', 'Done again.', true);
  assert.strictEqual(injected.length, 1);
});

test('a ticket verb sent over the socket silences a later claim', async () => {
  const { m, injected, step } = mkMgr();
  await m._dispatchSocketIntent(m.sessions.get('lead'), { type: 'task', sub: 'add', body: 'fix the parser' }, {});
  step('lead', 'Filed t1853.', true);
  assert.deepStrictEqual(injected, []);
  m._nudgeTicketClaims(m.sessions.get('lead'), 'Filed t1854.', [], { turnEnd: true });
  assert.deepStrictEqual(injected, [['lead', WORDING_1('filed'), { parkable: true }]]);
});

test('an interrupted turn drops its claim instead of carrying it to the next turn end', async () => {
  const { injected, step } = mkMgr();
  step('lead', 'I filed the ticket.', true, { interrupted: true });
  step('lead', 'Starting over.', true);
  assert.deepStrictEqual(injected, []);
});

test('a text-borne verb dispatched after its turn end does not silence the next turn', async () => {
  const { m, injected } = mkMgr();
  const lead = m.sessions.get('lead');
  const addText = '[agent:task add] fix the parser\n[agent:end]';
  const intents = m._extractIntents(addText);
  m._nudgeTicketClaims(lead, addText, intents, { turnEnd: true });
  for (const intent of intents) await m._handleIntent('lead', intent);
  assert.deepStrictEqual(injected, []);
  m._nudgeTicketClaims(lead, 'Filed t1854.', [], { turnEnd: true });
  assert.deepStrictEqual(injected, [['lead', WORDING_1('filed'), { parkable: true }]]);
});
