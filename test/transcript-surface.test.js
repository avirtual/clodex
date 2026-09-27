'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { surfaceOf, segmentSurface } = require('../renderer/lib/transcript-surface');

const C = 'conversation';
const I = 'internals';
const src = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const block = (text, open) => {
  const at = text.indexOf(open);
  assert.ok(at >= 0, `ENTER: ${open} is in the source`);
  return text.slice(at + open.length, text.indexOf('\n};', at));
};
const keysOf = (body) => [...body.matchAll(/^ {2}'?([a-z-]+)'?:/gm)].map((m) => m[1]);

const intent = (verb, sub = null) => ({ kind: 'intent', verb, sub, fields: {}, body: null, state: 'fire', spill: null, open: false, head: verb });
const prose = (text) => ({ kind: 'prose', text });
const said = (...segments) => ({ id: 'a', kind: 'assistant', ts: null, turn: 1, text: 'x', segments });

const KIND_ROWS = [
  ['prompt', { kind: 'prompt', text: 'hi', source: 'typed' }, C],
  ['prompt, mid-turn', { kind: 'prompt', text: 'hi', source: 'mid-turn', state: 'read' }, C],
  ['inbound from the operator', { kind: 'inbound', from: 'user', text: 'hi' }, C],
  ['inbound with a ticket marker', { kind: 'inbound', from: 'ticket-loop', text: '[ticket t1 ACCEPT] x', ticket: { id: 't1', tag: 'ACCEPT' } }, C],
  ['inbound with a bare ticket marker', { kind: 'inbound', from: 'ticket-watchdog', text: '[ticket t1] stalled', ticket: { id: 't1', tag: null } }, C],
  ['inbound ticket REPLAY', { kind: 'inbound', from: 'ticket-loop', text: '', ticket: { id: 't1', tag: 'REPLAY' } }, I],
  ['inbound ticket wake', { kind: 'inbound', from: 'ticket-loop', text: '', ticket: { id: 't1', tag: 'wake' } }, I],
  ['inbound ticket REDELIVERY', { kind: 'inbound', from: 'ticket-loop', text: '', ticket: { id: 't1', tag: 'REVIEW REDELIVERY' } }, I],
  ['inbound ticket merged aged nag', { kind: 'inbound', from: 'ticket-watchdog', text: '', ticket: { id: 't1', tag: 'merged 3h ago, not accepted' } }, I],
  ['inbound ticket merged short nag', { kind: 'inbound', from: 'ticket-watchdog', text: '', ticket: { id: 't1', tag: 'merged, not accepted' } }, I],
  ['inbound ticket MERGED', { kind: 'inbound', from: 'ticket-loop', text: '', ticket: { id: 't1', tag: 'MERGED' } }, C],
  ['inbound from a seat', { kind: 'inbound', from: 'clodex-hand-7', text: 'hi' }, C],
  ['inbound from a peer', { kind: 'inbound', from: 'bob@laptop', text: 'hi' }, C],
  ['inbound from reminder', { kind: 'inbound', from: 'reminder', text: 'continue' }, I],
  ['inbound from team', { kind: 'inbound', from: 'team', text: 'roster' }, I],
  ['inbound from clodex-team', { kind: 'inbound', from: 'clodex-team', text: 'roster' }, I],
  ['inbound from memory', { kind: 'inbound', from: 'memory', text: 'x' }, I],
  ['inbound from reboot', { kind: 'inbound', from: 'reboot', text: 'x' }, I],
  ['inbound from exec', { kind: 'inbound', from: 'exec', text: 'x' }, I],
  ['inbound from terminal', { kind: 'inbound', from: 'terminal', text: 'x' }, I],
  ['inbound from monitor', { kind: 'inbound', from: 'monitor', text: 'x' }, I],
  ['inbound from wirescope', { kind: 'inbound', from: 'wirescope', text: 'x' }, I],
  ['inbound from a -loop sender', { kind: 'inbound', from: 'merge-loop', text: 'x' }, I],
  ['inbound from a -watchdog sender', { kind: 'inbound', from: 'seat-watchdog', text: 'x' }, I],
  ['task reply with a ticket', { kind: 'reply', verb: 'task', text: 'ticket t1 created', ticket: { id: 't1', tag: null } }, C],
  ['task reply without a ticket', { kind: 'reply', verb: 'task', text: 'error: nope' }, I],
  ['dm reply', { kind: 'reply', verb: 'dm', text: 'delivered' }, I],
  ['exec reply', { kind: 'reply', verb: 'exec', text: 'ok' }, I],
  ['notice warning', { kind: 'notice', level: 'warning', text: 'Request interrupted' }, C],
  ['notice error', { kind: 'notice', level: 'error', text: 'boom' }, C],
  ['notice info', { kind: 'notice', level: 'info', text: 'compacted' }, I],
  ['notification', { kind: 'notification', text: 'agent finished' }, I],
  ['tool', { kind: 'tool', name: 'Bash', arg: 'ls', state: 'ok', sum: null }, I],
  ['command', { kind: 'command', name: '/clear', args: '' }, C],
  ['command-output', { kind: 'command-output', text: 'done' }, C],
  ['boundary', { kind: 'boundary', what: 'compact' }, C],
  ['turn-end', { kind: 'turn-end', durationMs: 5 }, I],
  ['assistant without segments', { kind: 'assistant', text: 'hello' }, C],
  ['assistant apiError', { kind: 'assistant', text: 'API Error', apiError: true, segments: [intent('exec')] }, C],
  ['assistant with a conversation segment', said(intent('exec'), prose('ran it')), C],
  ['assistant with only internal segments', said(intent('exec'), intent('remind')), I],
  ['assistant whose only prose is blank', said(prose('   '), intent('who')), I],
];

test('surfaceOf: one literal record per row of the classification table', () => {
  for (const [name, record, want] of KIND_ROWS) assert.strictEqual(surfaceOf(record), want, name);
});

test('ENTER: every record kind transcript-records.js emits has a row', () => {
  const emitted = new Set([...src('transcript-records.js').matchAll(/kind: '([a-z-]+)'/g)].map((m) => m[1]));
  for (const seg of ['intent', 'prose', 'inert']) emitted.delete(seg);
  assert.deepStrictEqual([...emitted].sort(),
    ['assistant', 'boundary', 'command', 'command-output', 'inbound', 'notice', 'notification', 'prompt', 'reply', 'tool', 'turn-end']);
  const covered = new Set(KIND_ROWS.map(([, r]) => r.kind));
  for (const kind of emitted) assert.ok(covered.has(kind), `${kind} has a row`);
});

const VERB_ROWS = [
  ['dm', C], ['resend', I], ['who', I], ['name', I], ['context', I], ['scratch', I], ['memory', I],
  ['file', C], ['term', I], ['exec', I], ['remind', I], ['shout', C], ['team-review', I],
  ['review-done', C], ['reboot', I], ['task', C], ['team-create', I], ['team', I], ['spawn', I],
];

test('segmentSurface: every CORE intent verb, literally', () => {
  for (const [verb, want] of VERB_ROWS) assert.strictEqual(segmentSurface(intent(verb)), want, verb);
});

test('ENTER: the verb table is exactly the CORE verbs in intent-glyphs.js', () => {
  assert.deepStrictEqual(VERB_ROWS.map(([v]) => v).sort(), keysOf(block(src('intent-glyphs.js'), 'const CORE = {')).sort());
});

const TASK_ROWS = [
  ['add', C], ['assign', C], ['start', C], ['park', C], ['respec', C], ['reject', C],
  ['cancel', C], ['accept', C], ['done', C], ['list', I],
];

test('segmentSurface: every task sub-verb, literally; only list is internals', () => {
  for (const [sub, want] of TASK_ROWS) assert.strictEqual(segmentSurface(intent('task', sub)), want, `task ${sub}`);
});

test('ENTER: the task table is add plus every TASK sub-verb in intent-glyphs.js', () => {
  assert.deepStrictEqual(TASK_ROWS.map(([s]) => s).sort(), ['add', ...keysOf(block(src('intent-glyphs.js'), 'const TASK = {'))].sort());
});

test('segmentSurface: prose, blank prose, inert and a plugin verb', () => {
  assert.strictEqual(segmentSurface(prose('hello')), C);
  assert.strictEqual(segmentSurface(prose('')), I);
  assert.strictEqual(segmentSurface(prose(' \n\t ')), I);
  assert.strictEqual(segmentSurface({ kind: 'inert', text: '[agent:nope' }), I);
  assert.strictEqual(segmentSurface(intent('branch')), I);
  assert.strictEqual(segmentSurface(intent('some-plugin-verb', 'x')), I);
});
