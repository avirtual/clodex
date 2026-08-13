'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTicketsStore, nextTicketId, ticketTitle, extractTaskDir, branchSlug } = require('../tickets-store');
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

test('extractTaskDir: captures a tasks/<dir> path on ANY line of the spec', () => {
  assert.strictEqual(extractTaskDir('do tasks/25-team-tickets/spec.md now'), 'tasks/25-team-tickets/spec.md');
  assert.strictEqual(extractTaskDir('no path here'), null);
  assert.strictEqual(extractTaskDir(''), null);
  // Artifacts moved out of the repo, so the absolute form must survive WHOLE.
  // `tasks/` occurs inside it, so a bare-pattern-first implementation would
  // silently truncate an absolute path to its tail — the failure this pins.
  const abs = '/Users/x/.clodex/projects/api-1a2b3c4d/tasks/durable-state';
  assert.strictEqual(extractTaskDir(`sweep ${abs} now`), abs);
  assert.strictEqual(extractTaskDir('~/.clodex/projects/api-1a2b3c4d/tasks/foo'),
    '~/.clodex/projects/api-1a2b3c4d/tasks/foo');
});

// THE defect this widening fixes. Measured over the live board at 03:30: six of
// seven queued tickets had taskDir=None, all of them written this way — a title,
// a blank, then the path. The loop reached its verify step, computed a diff (up
// to 78625 bytes) and had nowhere to write it.
test('extractTaskDir: a path under a title — line 3, the natural place — resolves', () => {
  const spec = [
    't320 — the loop hard-fails a finished ticket',
    '',
    '/Users/x/.clodex/projects/api-1a2b3c4d/tasks/taskdir-line1 — the artifact',
    '',
    'Body prose.',
  ].join('\n');
  assert.strictEqual(extractTaskDir(spec),
    '/Users/x/.clodex/projects/api-1a2b3c4d/tasks/taskdir-line1');
  // The bare form, equally far down.
  assert.strictEqual(extractTaskDir('a title\n\nsee tasks/9-foo for the spec'), 'tasks/9-foo');
  // A spec whose FIRST line is blank used to extract null even with the path on
  // line 2: the title comes from the first NON-EMPTY line but the scan read
  // lines[0] literally, so the two disagreed about where the ticket starts.
  assert.strictEqual(extractTaskDir('\ntasks/9-foo — go'), 'tasks/9-foo');
});

// The tie-break, stated so a rewrite cannot quietly pick the other one. It is
// EARLIEST LINE first — not "the absolute form anywhere beats a bare one". A
// whole-text scan applying abs-before-rel globally would return the line-4 path
// below, which changes the answer for a ticket that resolves correctly TODAY.
test('extractTaskDir: the earliest line wins, and abs beats rel only WITHIN a line', () => {
  const twoLines = [
    'tasks/first-one/spec.md — the title',
    'body mentions /Users/x/.clodex/projects/api-1a2b3c4d/tasks/second-one too',
  ].join('\n');
  assert.strictEqual(extractTaskDir(twoLines), 'tasks/first-one/spec.md',
    'the line-1 path wins even though the later one is absolute');
  // Within ONE line the absolute form still wins wherever it sits, because
  // `tasks/` occurs inside it: this is the anti-truncation ordering, unchanged.
  assert.strictEqual(
    extractTaskDir('tasks/bare and /Users/x/.clodex/projects/api-1a2b3c4d/tasks/abs'),
    '/Users/x/.clodex/projects/api-1a2b3c4d/tasks/abs');
});

// The regression this widening could plausibly cause, and the reason the fix is
// line-by-line inside extractTaskDir rather than anywhere near the title.
// branchSlug is called ONLY on ticket.title (session-manager `_mintTicketSeat`),
// and the title is the first NON-EMPTY line — so a path found on line 3 must be
// invisible to the slug. If it ever is not, a hand's worktree, its branch and
// the lead's merge target stop agreeing, silently.
test('branchSlug: a tasks/ path on a LATER line does not reach the branch name', () => {
  const spec = [
    't321 — trim the output buffer',
    '',
    'Artifact: /Users/x/.clodex/projects/api-1a2b3c4d/tasks/trim-buffer/SPEC.md',
    'Also see tasks/older-work/notes.md for the earlier attempt.',
  ].join('\n');
  // ENTER: the fixture must actually be one where the widening changed the
  // extraction — otherwise this pins the slug over a spec the fix never touched.
  assert.strictEqual(extractTaskDir(spec),
    '/Users/x/.clodex/projects/api-1a2b3c4d/tasks/trim-buffer/SPEC.md',
    'ENTER: the later-line path must be the one extractTaskDir now finds');
  assert.strictEqual(ticketTitle(spec), 't321 — trim the output buffer',
    'ENTER: the title must still be line 1');
  assert.strictEqual(branchSlug(ticketTitle(spec)), 'trim-the-output-buffer',
    'the branch is slugged from the title alone — no path, no line-3 words');
});

// The three branch names below were MINTED, not invented: each is what the
// pre-strip slugger produced for a real dispatch. The caller prepends the real
// ticket id to whatever comes back, so every assertion here is on the half that
// follows it.
test('branchSlug: the task-dir path on the first line is stripped, not slugged', () => {
  // Minted for t302: `t302-tasks-t302-migration-resync-spec-md-the`. The
  // documented dispatch format puts the path on this line, so this is the
  // protocol being followed correctly and still producing a nonsense branch.
  assert.strictEqual(
    branchSlug('tasks/t302-migration-resync/spec.md — the migration re-sync'),
    'the-migration-re-sync');
  const abs = '/Users/x/.clodex/projects/api-1a2b3c4d/tasks/t7-thing/spec.md';
  assert.strictEqual(branchSlug(`${abs} — rebuild the index`), 'rebuild-the-index');
});

test('branchSlug: a LEADING ticket id is dropped — the caller prepends the real one', () => {
  // Duplicate case, minted for t303: `t303-t303-solo-verbs-the-ticket-intents`.
  assert.strictEqual(branchSlug('t303 — solo verbs: the ticket intents'),
    'solo-verbs-the-ticket-intents');
  // WRONG-id case, minted for t305: the lead guessed t306 before the board
  // minted t305, so the branch asserted two different ids and the wrong one was
  // the readable half. This is why the slug must never trust an id in the title.
  assert.strictEqual(branchSlug('t306 — accept-and-retire, merge-gated'),
    'accept-and-retire-merge-gated');
  // Only LEADING. An id inside the prose is part of what the title says.
  assert.strictEqual(branchSlug('revert the t99 regression'), 'revert-the-t99-regression');
  // Not an id: `t` followed by a non-digit, and a bare number.
  assert.strictEqual(branchSlug('trim the buffer'), 'trim-the-buffer');
  assert.strictEqual(branchSlug('305 things'), '305-things');
});

test('branchSlug: a long title truncates on a word boundary, not mid-word', () => {
  // Asserted as an exact value: every bound worth stating here (<= 40, no
  // dangling separator, a prefix of the full slug) is ALSO true of the plain
  // slice(0, 40) this replaced, so a bounds-only test passes against the bug.
  // The mid-word cut is what produced `…-migration-resync-spec-md-the`.
  assert.strictEqual(
    branchSlug('make the branch slugger stop trusting identifiers in titles'),
    'make-the-branch-slugger-stop-trusting');
  // A single word longer than the cap has no boundary to cut on, so the
  // character cap still applies rather than emptying the slug.
  assert.strictEqual(branchSlug('x'.repeat(80)), 'x'.repeat(40));
  assert.strictEqual(branchSlug(`${'y'.repeat(45)} tail`), 'y'.repeat(40));
});

test('branchSlug: a title that is ONLY an id or a task dir slugs to empty, not to junk', () => {
  // The caller falls back to the bare ticket id on empty, which is the correct
  // outcome — a branch named for the id alone beats one named for a path.
  assert.strictEqual(branchSlug('t305'), '');
  assert.strictEqual(branchSlug('tasks/t305-foo/spec.md'), '');
  assert.strictEqual(branchSlug(''), '');
  assert.strictEqual(branchSlug(null), '');
  assert.strictEqual(branchSlug(undefined), '');
});
