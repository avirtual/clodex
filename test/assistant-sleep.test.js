'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { BRIEF_MAX_BYTES, BRIEF_TAIL, briefPathFor, composeBrief, idleDecision, pickMaxAwakeVictim } = require('../assistant-sleep');

const pairs = (n) => {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({ role: 'user', text: `question ${i}`, interim: false });
    rows.push({ role: 'assistant', text: `answer ${i}`, interim: false });
  }
  return rows;
};

test('constants and the brief path', () => {
  assert.strictEqual(BRIEF_MAX_BYTES, 3072);
  assert.strictEqual(BRIEF_TAIL, 10);
  assert.strictEqual(briefPathFor('/r', 'asst'), path.join('/r', 'sessions', 'asst', 'brief.md'));
});

test('composeBrief keeps the last tail exchanges under the heading', () => {
  const brief = composeBrief({ messages: pairs(12), tail: 10, maxBytes: 3072 });
  assert.strictEqual(brief.split('\n')[0], '## Before you slept');
  assert.ok(brief.includes('**player:** question 3\n\n**you:** answer 3'), brief);
  assert.ok(brief.includes('**you:** answer 12'), brief);
  assert.ok(!brief.includes('question 2\n') && !brief.includes('question 1\n'), brief);
  assert.ok(!/answer 1\n|answer 2\n/.test(brief), brief);
});

test('composeBrief drops intent lines and interim rows', () => {
  const brief = composeBrief({
    messages: [
      { role: 'user', text: 'hi', interim: false },
      { role: 'assistant', text: 'thinking aloud', interim: true },
      { role: 'assistant', text: 'ok\n[agent:memory remember] x\nbye', interim: false },
    ],
    tail: 10, maxBytes: 3072,
  });
  assert.ok(brief.includes('**you:** ok'), brief);
  assert.ok(!brief.includes('[agent:'), brief);
  assert.ok(!brief.includes('thinking aloud'), brief);
});

test('composeBrief over maxBytes drops the oldest rows, then cuts the last row\'s head', () => {
  const dropped = composeBrief({ messages: pairs(12), tail: 10, maxBytes: 200 });
  assert.ok(Buffer.byteLength(dropped, 'utf8') <= 200, dropped);
  assert.ok(dropped.endsWith('**you:** answer 12'), dropped);
  assert.ok(!dropped.includes('question 3'), dropped);
  const long = 'é'.repeat(300) + ' omega';
  const cut = composeBrief({ messages: [{ role: 'user', text: 'q', interim: false }, { role: 'assistant', text: long, interim: false }], tail: 10, maxBytes: 200 });
  assert.ok(Buffer.byteLength(cut, 'utf8') <= 200, cut);
  assert.ok(cut.startsWith('## Before you slept\n\n**you:** é'), cut);
  assert.ok(cut.endsWith(' omega'), cut);
  assert.ok(!cut.includes('�'), 'cut at a code point');
});

test('composeBrief with nothing to keep is null', () => {
  assert.strictEqual(composeBrief({ messages: [], tail: 10, maxBytes: 3072 }), null);
});

test('idleDecision sleeps only an idle, empty, unblocked seat past idleMs', () => {
  const base = { now: 600000, activityTs: 0, idleMs: 600000, state: 'idle', outbox: 0, permissions: 0 };
  assert.strictEqual(idleDecision(base), 'sleep');
  for (const [label, patch] of [
    ['short of idleMs', { now: 599999 }],
    ['thinking', { state: 'thinking' }],
    ['outbox', { outbox: 1 }],
    ['permissions', { permissions: 1 }],
    ['no policy', { idleMs: 0 }],
  ]) assert.strictEqual(idleDecision({ ...base, ...patch }), 'keep', label);
});

test('pickMaxAwakeVictim picks the idlest non-busy seat only at the cap', () => {
  const rows = [{ name: 'a', activityTs: 5, busy: false }, { name: 'b', activityTs: 1, busy: false }, { name: 'c', activityTs: 0, busy: true }];
  assert.strictEqual(pickMaxAwakeVictim(rows, 3), 'b');
  assert.strictEqual(pickMaxAwakeVictim(rows, 4), null);
  assert.strictEqual(pickMaxAwakeVictim(rows.map((r) => ({ ...r, busy: true })), 3), null);
});
