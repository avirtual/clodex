'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'resources', 'library', 'prompts', 'system');
const hand = fs.readFileSync(path.join(DIR, 'clodex-team-hand.md'), 'utf-8');
const reviewer = fs.readFileSync(path.join(DIR, 'clodex-team-reviewer.md'), 'utf-8');

function bullet(text, head) {
  const at = text.indexOf(head);
  assert.ok(at >= 0, `bullet "${head}" present`);
  const rest = text.slice(at + 1);
  const next = rest.search(/\n(- |\n|#)/);
  return text.slice(at, next < 0 ? undefined : at + 1 + next);
}

test('C11: a blocked hand dms its lead urgently', () => {
  assert.match(hand, /dm <lead> urgent/);
});

test('C8: a verdict-prescribed qualifier is allowed', () => {
  assert.match(hand, /unless a verdict prescribes the qualifier/);
});

test('G7: a hand touching the runner carries the empty-suite rule', () => {
  assert.ok(hand.includes('TOTALS: 0 pass, 0 fail, 0 tests'));
});

test('G1: the hand prompt says where the task artifact is', () => {
  assert.ok(hand.includes("task-dir path on your spec's title line"));
});

test('C6: the rework bullet carries no self-compact exception', () => {
  const b = bullet(hand, '- Compaction:');
  assert.ok(!b.includes('context compact'), b);
});

test('R3: the reviewer scope arrives from ticket-loop', () => {
  assert.ok(reviewer.includes('from ticket-loop'));
});

test('C2: the reviewer prompt no longer says the lead spawned it', () => {
  assert.ok(!reviewer.includes('The lead spawned you'));
});
