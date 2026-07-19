'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTicketsStore, nextTicketId, ticketTitle, extractTaskDir } = require('../tickets-store');

function tmpTeamDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-tickets-'));
}

test('tickets-store: a missing registry loads as empty (never throws)', () => {
  const store = createTicketsStore();
  assert.deepStrictEqual(store.load(tmpTeamDir()), []);
});

test('tickets-store: save then load round-trips, atomic write leaves no temp file', () => {
  const dir = tmpTeamDir();
  const store = createTicketsStore();
  const tickets = [{ id: 't1', title: 'a', state: 'open' }];
  store.save(dir, tickets);
  assert.deepStrictEqual(store.load(dir), tickets);
  assert.deepStrictEqual(fs.readdirSync(dir), ['tickets.json'], 'no lingering .tmp from the atomic rename');
});

test('tickets-store: save creates the team dir if absent (ensureDir)', () => {
  const parent = tmpTeamDir();
  const dir = path.join(parent, 'nested', 'team');
  const store = createTicketsStore();
  store.save(dir, [{ id: 't1' }]);
  assert.ok(fs.existsSync(path.join(dir, 'tickets.json')));
});

test('tickets-store: a corrupt registry loads as empty, not a throw', () => {
  const dir = tmpTeamDir();
  fs.writeFileSync(path.join(dir, 'tickets.json'), '{ not json');
  assert.deepStrictEqual(createTicketsStore().load(dir), []);
});

test('nextTicketId: monotonic from the max, never reuses even past a gap', () => {
  assert.strictEqual(nextTicketId([]), 't1');
  assert.strictEqual(nextTicketId([{ id: 't1' }]), 't2');
  // A cancelled/removed middle id doesn't lower the ceiling — max+1 always.
  assert.strictEqual(nextTicketId([{ id: 't1' }, { id: 't3' }]), 't4');
  assert.strictEqual(nextTicketId([{ id: 't3' }, { id: 't1' }, { id: 'bogus' }]), 't4');
});

test('ticketTitle: first non-empty line, trimmed and capped; empty → (untitled)', () => {
  assert.strictEqual(ticketTitle('  build the widget\nmore detail'), 'build the widget');
  assert.strictEqual(ticketTitle('\n\n   second-first line'), 'second-first line');
  assert.strictEqual(ticketTitle('   \n  '), '(untitled)');
  assert.strictEqual(ticketTitle(''), '(untitled)');
  const long = 'x'.repeat(200);
  assert.ok(ticketTitle(long).length <= 80 && ticketTitle(long).endsWith('…'));
});

test('extractTaskDir: captures a tasks/<dir> path on the FIRST line only', () => {
  assert.strictEqual(extractTaskDir('do tasks/25-team-tickets/spec.md now'), 'tasks/25-team-tickets/spec.md');
  assert.strictEqual(extractTaskDir('no path here'), null);
  // Only the first line is scanned.
  assert.strictEqual(extractTaskDir('first line\nsee tasks/9-foo'), null);
  assert.strictEqual(extractTaskDir(''), null);
});
