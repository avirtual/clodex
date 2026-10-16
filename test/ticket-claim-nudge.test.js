'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { TICKET_CLAIM_RE, ticketClaimNudges } = require('../ticket-claim-nudge');
const { parseIntent, looksLikeIntent } = require('../intent-scanner');
const { mk } = require('./lib/session-fixtures');

const MGR_DEPS = {
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  parseIntent,
  looksLikeIntent,
  execBodyCap: 64 * 1024,
};

function intentsOf(text) {
  return mk(MGR_DEPS)._extractIntents(text);
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

test('each reply row fires its wording or stays silent', () => {
  const rows = [
    { what: 'claim, no verb', text: 'I filed the ticket for the parser.', taskSeat: true,
      want: [WORDING_1('filed')] },
    { what: 'claim, task add with body', text: 'I filed the ticket.\n[agent:task add] fix the parser\n[agent:end]', taskSeat: true,
      want: [] },
    { what: 'claim, reject with empty body', text: 't1851 is rejected.\n[agent:task reject t1851]\n[agent:end]', taskSeat: true,
      want: [WORDING_2('[agent:task reject t1851]')] },
    { what: 'no claim, respec with empty body', text: 'Moving on.\n[agent:task respec t1849]\n[agent:end]', taskSeat: true,
      want: [WORDING_2('[agent:task respec t1849]')] },
    { what: 'empty task add, no prose', text: '[agent:task add]\n[agent:end]', taskSeat: true,
      want: [WORDING_2('[agent:task add]')] },
    { what: 'claim inside a fence', text: 'Draft:\n```\nI filed the ticket\n```\nDone.', taskSeat: true,
      want: [] },
    { what: 'claim in an escaped intent line', text: '\\[agent:task add] the ticket was filed here', taskSeat: true,
      want: [] },
    { what: 'hand seat, claim, no verb', text: 'I filed the ticket for the parser.', taskSeat: false,
      want: [] },
    { what: 'quoted loop notice, no claim verb', text: 'ticket t1850 MERGED', taskSeat: true,
      want: [] },
    { what: 'claim inside a task done body', text: '[agent:task done t1852] t1851 was rejected upstream\n[agent:end]', taskSeat: true,
      want: [] },
  ];
  const fired = [];
  for (const row of rows) {
    const got = ticketClaimNudges({ text: row.text, intents: intentsOf(row.text), taskSeat: row.taskSeat }).map((n) => n.text);
    assert.deepStrictEqual(got, row.want, row.what);
    if (got.length) fired.push(row.what);
  }
  assert.ok(fired.includes('claim, no verb'));
  assert.ok(fired.includes('claim, reject with empty body'));
  assert.ok(fired.includes('no claim, respec with empty body'));
});

test('the manager injects a firing nudge parkable on a task-intent seat only', () => {
  const text = 'I filed the ticket for the parser.';
  const m = mk({
    ...MGR_DEPS,
    getPersistence: () => ({ list: () => [], get: (n) => (n === 'lead' ? { intents: ['*'] } : { intents: ['dm'] }) }),
  });
  const injected = [];
  m._injectText = (s, t, o) => injected.push([s.name, t, o]);
  m._handleIntent = () => {};
  m._maybeSpeak = () => {};
  m._publishAgentText = () => {};
  m.sessions.set('lead', { name: 'lead', agentType: 'claude' });
  m.sessions.set('hand', { name: 'hand', agentType: 'claude' });
  m._scanJsonlText(text, 'lead', []);
  m._scanJsonlText(text, 'hand', []);
  assert.deepStrictEqual(injected, [['lead', WORDING_1('filed'), { parkable: true }]]);
});
