'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTicketsStore, nextTicketId, ticketTitle, extractTaskDir } = require('../tickets-store');
const { projectDirFor } = require('../clodex-paths');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-tickets-'));
}

// A project ROOT is now the store's key — any absolute path will do, since the
// board dir is derived from it by hashing, not by existing on disk.
function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-proj-'));
}

test('tickets-store: a missing registry loads as empty (never throws)', () => {
  const store = createTicketsStore({ clodexHome: tmpHome() });
  assert.deepStrictEqual(store.load(tmpRoot()), []);
});

test('tickets-store: the board resolves to the PROJECT dir, not any team dir', () => {
  const home = tmpHome();
  const root = tmpRoot();
  const store = createTicketsStore({ clodexHome: home });
  // The one authority on the grammar is clodex-paths; this asserts the store
  // agrees with it rather than re-deriving <leaf>-<hash8> in a second place.
  assert.strictEqual(store.ticketsPath(root), path.join(projectDirFor(home, root), 'tickets.json'));
  store.save(root, [{ id: 't1' }]);
  assert.ok(fs.existsSync(path.join(projectDirFor(home, root), 'tickets.json')));
});

test('tickets-store: two projects under one home get two separate boards', () => {
  const home = tmpHome();
  const a = tmpRoot();
  const b = tmpRoot();
  const store = createTicketsStore({ clodexHome: home });
  store.save(a, [{ id: 't1', title: 'a-work' }]);
  store.save(b, [{ id: 't1', title: 'b-work' }]);
  assert.deepStrictEqual(store.load(a), [{ id: 't1', title: 'a-work' }]);
  assert.deepStrictEqual(store.load(b), [{ id: 't1', title: 'b-work' }]);
});

test('tickets-store: save then load round-trips, atomic write leaves no temp file', () => {
  const home = tmpHome();
  const root = tmpRoot();
  const store = createTicketsStore({ clodexHome: home });
  const tickets = [{ id: 't1', title: 'a', state: 'open' }];
  store.save(root, tickets);
  assert.deepStrictEqual(store.load(root), tickets);
  assert.deepStrictEqual(fs.readdirSync(projectDirFor(home, root)), ['tickets.json'],
    'no lingering .tmp from the atomic rename');
});

test('tickets-store: save creates the project dir if absent (ensureDir)', () => {
  const home = path.join(tmpHome(), 'nested', 'home');
  const root = tmpRoot();
  const store = createTicketsStore({ clodexHome: home });
  store.save(root, [{ id: 't1' }]);
  assert.ok(fs.existsSync(path.join(projectDirFor(home, root), 'tickets.json')));
});

test('tickets-store: a corrupt registry loads as empty, not a throw', () => {
  const home = tmpHome();
  const root = tmpRoot();
  const store = createTicketsStore({ clodexHome: home });
  fs.mkdirSync(projectDirFor(home, root), { recursive: true });
  fs.writeFileSync(path.join(projectDirFor(home, root), 'tickets.json'), '{ not json');
  assert.deepStrictEqual(store.load(root), []);
});

// Three states, not two. A later refactor that reads `parked` as "the same as
// unassigned" collapses the middle one, and the record on disk is the only place
// the distinction lives: `parked` is written ONLY when true, so absent-vs-false
// must round-trip as absent (every pre-field record on the live board has no
// `parked` key at all).
test('tickets-store: null-assignee, parked-assigned and delivered-assigned are three DISTINCT round-tripping shapes', () => {
  const home = tmpHome();
  const root = tmpRoot();
  const store = createTicketsStore({ clodexHome: home });
  const backlog = { id: 't1', state: 'open', assignee: null };
  const parked = { id: 't2', state: 'open', assignee: 'hand', parked: true };
  const delivered = { id: 't3', state: 'open', assignee: 'hand' };
  store.save(root, [backlog, parked, delivered]);
  const back = store.load(root);
  assert.deepStrictEqual(back, [backlog, parked, delivered]);
  // `parked` absent stays ABSENT, never normalized to false.
  assert.ok(!Object.prototype.hasOwnProperty.call(back[0], 'parked'));
  assert.ok(!Object.prototype.hasOwnProperty.call(back[2], 'parked'));
  // The two "nobody is working on this right now" states are not each other.
  assert.notDeepStrictEqual(back[0], back[1]);
  assert.notDeepStrictEqual(back[1], back[2]);
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
  // Artifacts moved out of the repo, so the absolute form must survive WHOLE.
  // `tasks/` occurs inside it, so a bare-pattern-first implementation would
  // silently truncate an absolute path to its tail — the failure this pins.
  const abs = '/Users/x/.clodex/projects/api-1a2b3c4d/tasks/durable-state';
  assert.strictEqual(extractTaskDir(`sweep ${abs} now`), abs);
  assert.strictEqual(extractTaskDir('~/.clodex/projects/api-1a2b3c4d/tasks/foo'),
    '~/.clodex/projects/api-1a2b3c4d/tasks/foo');
});
