'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseIntent } = require('../intent-scanner');
const { mk } = require('./lib/session-fixtures');

const CHOICES = {
  claude: [{ id: 'allow', label: 'Allow', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }],
  codex: [{ id: 'accept', label: 'Allow', kind: 'allow' }, { id: 'acceptForSession', label: 'Allow for this session', kind: 'allow-always' }, { id: 'decline', label: 'Deny', kind: 'deny' }, { id: 'cancel', label: 'Deny and stop the turn', kind: 'deny' }],
  muse: [{ id: 'c-once', label: 'Allow once', kind: 'allow' }, { id: 'c-always', label: 'Always', kind: 'allow-always' }, { id: 'c-abort', label: 'Abort', kind: 'deny' }],
};

function mkRig({ io = 'stream', choices = CHOICES.claude } = {}) {
  const warns = [];
  const m = mk({
    log: { info: () => {}, warn: (tag, msg) => warns.push([tag, msg]), error: () => {}, debug: () => {} },
    getPersistence: () => ({ list: () => [], get: (n) => (n === 'hand-9' ? { ticketId: 't9' } : null) }),
  });
  const dms = [];
  const injected = [];
  const shadow = [];
  const encoded = [];
  const answered = [];
  m._gatedDeliver = (to, from, body, urgent, tag) => { dms.push({ to, from, body, urgent, tag }); return { queued: true }; };
  m._injectText = (s, text) => injected.push([s.name, text]);
  m._shadowLog = (rec) => shadow.push(rec);
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._streamSend = () => {};
  m.windowForSession = () => null;
  m._teamOfOrNull = (s) => (s && (s.name === 'hand-9' || s.name === 'L') ? { name: 'tm', lead: 'L' } : null);
  const realSeatPermission = m.seatPermission.bind(m);
  m.seatPermission = (name, id, choiceId) => { answered.push([name, id, choiceId]); return realSeatPermission(name, id, choiceId); };
  const hand = {
    name: 'hand-9', agentType: 'claude', io,
    streamCodec: { encodePermission: (id, choiceId) => { encoded.push([id, choiceId]); return id === 'gone' ? null : { answer: id, choiceId }; } },
  };
  m.sessions.set('hand-9', hand);
  m.sessions.set('L', { name: 'L', agentType: 'claude' });
  m.sessions.set('other', { name: 'other', agentType: 'claude' });
  const raise = (id, extra = {}) => m._onStreamPermission(hand, { id, toolName: 'Bash', displayName: 'Bash', preview: 'python3 - <<EOF', choices, ...extra });
  return { m, hand, dms, injected, shadow, encoded, answered, warns, raise };
}

for (const [codec, toolName] of [['claude', 'Bash'], ['codex', 'commandExecution'], ['muse', 'shell']]) {
  test(`relay (${codec}): a stream ticket seat's request reaches its lead as one permission dm`, () => {
    const r = mkRig({ choices: CHOICES[codec] });
    r.raise('req-1', { toolName });
    assert.strictEqual(r.dms.length, 1);
    const [first, second] = r.dms[0].body.split('\n');
    assert.strictEqual(first, `[permission hand-9 req-1] ticket t9: ${toolName} — python3 - <<EOF`);
    assert.strictEqual(second, 'Answer: [agent:permit hand-9 req-1 allow] or [agent:permit hand-9 req-1 deny]; the Requests list in the attention view still works.');
    assert.deepStrictEqual({ ...r.dms[0], body: null }, { to: 'L', from: 'permission', body: null, urgent: false, tag: '[permission hand-9 req-1]' });
    r.raise('req-1', { toolName });
    r.m._setAttention(r.hand, { kind: 'permission', ts: Date.now(), message: 'again' });
    assert.strictEqual(r.dms.length, 1, 'the same id is relayed once');
  });
}

test('relay: the preview is log-masked and cut to 300 chars', () => {
  const r = mkRig();
  r.raise('req-2', { preview: `curl --token abc123 ${'x'.repeat(400)}` });
  const first = r.dms[0].body.split('\n')[0];
  assert.ok(!first.includes('abc123'), first);
  assert.strictEqual(first.length, '[permission hand-9 req-2] ticket t9: Bash — '.length + 300);
});

test('relay: a request already cleared sends nothing', () => {
  const r = mkRig();
  r.hand.streamPermissions = new Map();
  r.m._relayPermissionToLead(r.hand, 'req-3');
  assert.deepStrictEqual(r.dms, []);
});

test('the inbox note carries the permit line for the pending request', () => {
  const notes = [];
  const m2 = mk({
    getPersistence: () => ({ list: () => [], get: () => ({ ticketId: 't9' }) }),
    getNotifications: () => ({ add: (n) => notes.push(n) }),
  });
  const ts = 1234;
  const s = { name: 'hand-9', streamPermissions: new Map([['req-4', { id: 'req-4', ts }]]) };
  m2._notePermissionInbox(s, { kind: 'permission', ts, message: 'Bash: ls' });
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].body.split('\n')[1], 'Its lead can answer it: [agent:permit hand-9 req-4 allow] or [agent:permit hand-9 req-4 deny]');
});

for (const [codec, verb, choiceId, word] of [
  ['claude', 'allow', 'allow', 'allowed'],
  ['claude', 'deny', 'deny', 'denied'],
  ['codex', 'allow', 'accept', 'allowed'],
  ['codex', 'deny', 'decline', 'denied'],
  ['muse', 'allow', 'c-once', 'allowed'],
  ['muse', 'deny', 'c-abort', 'denied'],
]) {
  test(`permit (${codec} ${verb}): the lead's answer goes through seatPermission with the ${choiceId} choice`, async () => {
    const r = mkRig({ choices: CHOICES[codec] });
    r.raise('req-5');
    const intent = parseIntent(`[agent:permit hand-9 req-5 ${verb}]`);
    assert.deepStrictEqual(intent, { type: 'permit', seat: 'hand-9', id: 'req-5', choice: verb });
    await r.m._handleIntent('L', intent);
    assert.deepStrictEqual(r.answered, [['hand-9', 'req-5', choiceId]]);
    assert.deepStrictEqual(r.encoded, [['req-5', choiceId]]);
    assert.deepStrictEqual(r.injected, [['L', `[agent:permit] hand-9 req-5: ${word}`]]);
    assert.deepStrictEqual(r.shadow.filter((x) => x.type === 'permit'), [{ type: 'permit', seat: 'hand-9', id: 'req-5', choice: choiceId, by: 'L' }]);
    assert.ok(r.warns.some(([tag, msg]) => tag === 'session' && msg === `hand-9: ${word} Bash by its lead L`), JSON.stringify(r.warns));
    assert.strictEqual(r.hand.streamPermissions.has('req-5'), false);
  });
}

test('permit: a non-lead sender is refused and seatPermission is not called', async () => {
  const r = mkRig();
  r.raise('req-6');
  await r.m._handleIntent('other', parseIntent('[agent:permit hand-9 req-6 allow]'));
  assert.deepStrictEqual(r.injected, [['other', "permit: only hand-9's lead can answer its requests"]]);
  assert.deepStrictEqual(r.answered, []);
  assert.strictEqual(r.hand.streamPermissions.has('req-6'), true);
});

test('permit: an id that is no longer pending is stale', async () => {
  const r = mkRig();
  r.raise('req-7');
  await r.m._handleIntent('L', parseIntent('[agent:permit hand-9 nope allow]'));
  assert.deepStrictEqual(r.injected, [['L', '[agent:permit] hand-9 nope: request is stale']]);
  assert.deepStrictEqual(r.answered, []);
});

test('permit: a request whose codec drops it at answer time reports seatPermission\'s stale error', async () => {
  const r = mkRig();
  r.raise('gone');
  await r.m._handleIntent('L', parseIntent('[agent:permit hand-9 gone deny]'));
  assert.deepStrictEqual(r.answered, [['hand-9', 'gone', 'deny']]);
  assert.deepStrictEqual(r.injected, [['L', '[agent:permit] hand-9 gone: request is stale']]);
  assert.deepStrictEqual(r.shadow.filter((x) => x.type === 'permit'), []);
});

test('permit: a request with no matching choice kind names the available ids', async () => {
  const r = mkRig({ choices: [{ id: 'only-deny', label: 'No', kind: 'deny' }] });
  r.raise('req-8');
  await r.m._handleIntent('L', parseIntent('[agent:permit hand-9 req-8 allow]'));
  assert.deepStrictEqual(r.injected, [['L', '[agent:permit] hand-9 req-8: no allow choice — available: only-deny']]);
  assert.deepStrictEqual(r.answered, []);
});

test('pty seat: the attention fires with no relay dm, and a permit is not a stream seat', async () => {
  const r = mkRig({ io: 'pty' });
  r.m._setAttention(r.hand, { kind: 'permission', ts: Date.now(), message: 'Bash: ls' });
  assert.strictEqual(r.hand.needsAttention.kind, 'permission');
  assert.deepStrictEqual(r.dms, []);
  await r.m._handleIntent('L', parseIntent('[agent:permit hand-9 req-9 allow]'));
  assert.deepStrictEqual(r.injected, [['L', '[agent:permit] hand-9 req-9: not a stream seat']]);
  assert.deepStrictEqual(r.answered, []);
});

test('the permit grammar rejects a choice other than allow or deny', () => {
  assert.strictEqual(parseIntent('[agent:permit hand-9 req-1 always]'), null);
});
