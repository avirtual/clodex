'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { TICKET_CLAIM_RE, RETROSPECTIVE_RE, FOLLOWUPS_RE, MINTING_WORD_RE, TICKET_ID_RE } = require('../ticket-claim-nudge');
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

test('the sentence-filter regexes are pinned to their literals', () => {
  assert.strictEqual(RETROSPECTIVE_RE.source,
    '\\b(already|earlier|previously|was|were|had|has been|have been|last (night|time|turn|session)|yesterday|since)\\b');
  assert.strictEqual(RETROSPECTIVE_RE.flags, 'i');
  assert.strictEqual(FOLLOWUPS_RE.source, 'followups');
  assert.strictEqual(FOLLOWUPS_RE.flags, 'i');
  assert.strictEqual(MINTING_WORD_RE.source, '^(?:filed|dispatched)$');
  assert.strictEqual(MINTING_WORD_RE.flags, 'i');
  assert.strictEqual(TICKET_ID_RE.source, '\\bt\\d{2,5}\\b');
  assert.strictEqual(TICKET_ID_RE.flags, 'i');
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
    { what: 'claim in an escaped intent line', seat: 'lead', text: '\\[agent:task add] I filed the ticket here',
      want: [] },
    { what: 'hand seat, claim, no verb', seat: 'hand', text: 'I filed the ticket for the parser.',
      want: [] },
    { what: 'quoted loop notice, no claim verb', seat: 'lead', text: 'ticket t1850 MERGED',
      want: [] },
    { what: 'filed in FOLLOWUPS', seat: 'lead', text: 't1851 sat 20 minutes at suite-in-flight; filed in FOLLOWUPS.',
      want: [] },
    { what: 'already filed and closed', seat: 'lead', text: 'tickets already filed and closed (t1855, t1856) passed review.',
      want: [] },
    { what: 'retrospective, no id', seat: 'lead', text: 'The parser ticket was filed this morning.',
      want: [] },
    { what: 'FOLLOWUPS, no id', seat: 'lead', text: 'The parser ticket is filed in FOLLOWUPS.',
      want: [] },
    { what: 'filed with a named id', seat: 'lead', text: 'I filed t1860 for the parser.',
      want: [] },
    { what: 'rejected with a named id, no verb', seat: 'lead', text: 'rejected t1851 with one must-fix',
      want: [WORDING_1('rejected')] },
    { what: 'non-claim retrospective sentence, then a live claim', seat: 'lead', text: 'Already filed earlier. I filed the ticket for the parser now.',
      want: [WORDING_1('filed')] },
    { what: 'dropped claim sentence, then a live claim', seat: 'lead', text: 'The ticket was already filed. I filed the ticket for the parser now.',
      want: [WORDING_1('filed')] },
    { what: 'question sentence, then a live claim', seat: 'lead', text: 'Was it picked up? I filed the ticket.',
      want: [WORDING_1('filed')] },
    { what: 'semicolon half without the id, live claim', seat: 'lead', text: 'I filed the ticket; it is t12 already done',
      want: [WORDING_1('filed')] },
    { what: 'semicolon half with the id skips', seat: 'lead', text: 'I filed t12; it is already done',
      want: [] },
    { what: 'claim inside a task done body', seat: 'lead', text: '[agent:task done t1852] t1851 rejected upstream\n[agent:end]',
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
  assert.ok(fired.includes('rejected with a named id, no verb'));
  assert.ok(fired.includes('non-claim retrospective sentence, then a live claim'));
  assert.ok(fired.includes('dropped claim sentence, then a live claim'));
  assert.ok(fired.includes('question sentence, then a live claim'));
});

test('a verb in an earlier step of the turn silences a later claim', async () => {
  const { injected, step } = mkMgr();
  step('lead', '[agent:task add] fix the parser\n[agent:end]', false);
  step('lead', 'Filed the ticket for the parser.', true);
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
  step('lead', 'Filed the ticket.', true);
  assert.deepStrictEqual(injected, []);
  m._nudgeTicketClaims(m.sessions.get('lead'), 'Filed the ticket.', [], { turnEnd: true });
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
  m._nudgeTicketClaims(lead, 'Filed the ticket.', [], { turnEnd: true });
  assert.deepStrictEqual(injected, [['lead', WORDING_1('filed'), { parkable: true }]]);
});
