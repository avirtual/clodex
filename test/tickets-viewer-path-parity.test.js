'use strict';

// The tickets-viewer plugin CANNOT require core's clodex-paths — §12 of
// plugins/plugin-api.md refuses a require that leaves the plugin's directory,
// and test/plugin-boundary.test.js enforces it. So §4's sanctioned pattern
// applies: the utility is copied in. This test is the enforcement that pattern
// otherwise lacks — the boundary lint says nothing about whether a copy still
// AGREES with its original, and the copy drifts the first time core's hashing
// changes.
//
// This file lives in test/, which is not under the boundary lint, so it may
// require both halves and compare them directly.
//
// Why projectDirFor gets a parity test and the neighbouring `confine` copy does
// not: the failure modes are not alike. A diverged `confine` REJECTS a path —
// loud, and someone sees it. A diverged projectDirFor computes a different hash,
// reads a directory that does not exist, and the viewer renders an EMPTY board.
// That is a false green, and refusing false greens is the whole design of that
// plugin. The test is warranted by the failure mode, not by the copying.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../clodex-paths');
const coreStore = require('../tickets-store');
const viewer = require('../plugins/tickets-viewer/engine')._internals;

test('viewer projectDirFor agrees with core clodex-paths byte for byte', () => {
  const home = path.join(os.tmpdir(), 'parity-home');
  const roots = [
    '/Users/someone/projects/wb-wrap-ui',
    '/Users/someone/projects/wb-wrap-ui/',        // trailing slash normalises away
    '/tmp/a b/proj with spaces',
    '/tmp/proj',
    'relative/path/proj',                          // resolved against cwd, both sides
    '/tmp/../tmp/proj',                            // resolve() collapses this
  ];

  // ENTER: the loop below is the reduction. A roots list that somehow arrived
  // empty would make every assertion inside it vacuous, so pin that the case the
  // copy exists to serve is actually in the set.
  assert.ok(roots.includes('/tmp/proj'), 'the roots list must reach the plain case');

  for (const r of roots) {
    assert.strictEqual(viewer.projectDirFor(home, r), core.projectDirFor(home, r),
      `diverged on ${r}`);
  }
});

test('viewer projectDirFor agrees on a root reached through a symlink', () => {
  // THE case a "cleaner" realpath in either copy would break, and the only one
  // where resolve() and realpath() give different answers. The board is written
  // under the hash of the RESOLVED path, never the real one, so a copy that
  // started calling realpath would hash the link target, look in a directory
  // nobody wrote, and render an empty board. A parity test over non-symlinked
  // paths alone would stay green through exactly that change.
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'parity-'));
  const real = path.join(tmp, 'real-project');
  const link = path.join(tmp, 'link-to-project');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);

  const home = path.join(tmp, 'home');
  const viaLink = viewer.projectDirFor(home, link);

  assert.strictEqual(viaLink, core.projectDirFor(home, link), 'copy diverged on a symlinked root');
  // And the property that makes the agreement meaningful rather than two copies
  // being equally wrong: the link is NOT silently followed by either side.
  assert.notStrictEqual(viaLink, core.projectDirFor(home, real),
    'a symlinked root must hash as itself, not as its target — otherwise realpath crept in');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── the record-shaping copies (t304) ────────────────────────────────────────
//
// The viewer WRITES since t304, so it also had to copy tickets-store's
// nextTicketId / ticketTitle / extractTaskDir. These get parity tests for the
// same reason projectDirFor does and `confine` does not: every one of them
// fails SILENTLY when it drifts.
//
// A diverged nextTicketId re-issues a live id — and an id is a public reference
// (branch names, artifact dirs, commit messages), so the duplicate still
// resolves, to the wrong work. A diverged ticketTitle or extractTaskDir writes a
// record whose summary line or artifact path disagrees with the one core would
// have written for the same spec, and the artifact path is what a fresh seat
// follows to pick up a dead worker's task. None of the three throws; all three
// just quietly write the wrong bytes into a file two other programs read.

test('viewer nextTicketId agrees with core tickets-store', () => {
  const boards = [
    [],
    [{ id: 't1' }],
    // The case the whole function exists for: max+1, NOT length+1 and NOT
    // "highest open". A closed record still owns its number.
    [{ id: 't1', state: 'done' }, { id: 't7', state: 'cancelled' }, { id: 't3' }],
    [{ id: 't9' }, { id: 't10' }, { id: 't2' }],
    // Records a hand-edit or another writer could leave behind: ignored for the
    // max by both sides, never a throw.
    [{ id: 'not-a-ticket' }, { id: '' }, { id: null }, {}, null, 'garbage', { id: 't4' }],
    [{ id: 't007' }],
  ];

  // ENTER: the loop is the reduction, and the interesting board is the one with
  // a closed record holding the highest number — an empty or single-row list
  // would agree under a length+1 implementation too.
  assert.ok(boards.some((b) => b.length === 3 && b[1] && b[1].id === 't7'),
    'the boards list must reach the closed-record case');

  for (const b of boards) {
    assert.strictEqual(viewer.nextTicketId(b), coreStore.nextTicketId(b),
      `diverged on ${JSON.stringify(b)}`);
  }
  // Both sides agree AND agree on the right answer: two copies that drifted
  // together would satisfy the equality above and nothing else.
  assert.strictEqual(viewer.nextTicketId(boards[2]), 't8');
});

test('viewer ticketTitle agrees with core tickets-store', () => {
  const long = 'x'.repeat(200);
  const specs = [
    'a plain title',
    '\n\n   \nthe first NON-EMPTY line wins\nsecond line',
    '   leading and trailing   ',
    long,                     // the 80-char cap and its ellipsis
    `${'y'.repeat(77)}zzz`,   // straddles the cap boundary exactly
    '',
    '\n\n',
    null,
    undefined,
    42,
  ];

  assert.ok(specs.includes(long), 'ENTER: the specs list must reach the capped case');

  for (const s of specs) {
    assert.strictEqual(viewer.ticketTitle(s), coreStore.ticketTitle(s),
      `diverged on ${JSON.stringify(s)}`);
  }
  assert.strictEqual(viewer.ticketTitle(''), '(untitled)');
  assert.strictEqual(viewer.ticketTitle(long).length, 78, 'capped at 77 + the ellipsis');
});

test('viewer extractTaskDir agrees with core tickets-store', () => {
  const specs = [
    'tasks/some-task — do the thing',
    // THE case the ordering in both copies exists for: `tasks/` appears inside
    // the absolute form, so a bare-pattern-first implementation truncates this
    // to its tail. Both sides must return the whole absolute path.
    '/Users/someone/.clodex/projects/proj-1234abcd/tasks/deep-work — go',
    '~/.clodex/projects/proj-1234abcd/tasks/deep-work — go',
    'no artifact path anywhere in this line',
    // Both copies scan every line, so both must find this one — a copy left on
    // the first-line-only rule returns null here and diverges loudly.
    'a title\n\ntasks/on-line-three — the natural place a lead writes it',
    // The tie-break, which the two copies must agree on: earliest LINE wins, so
    // a whole-text scan in one copy (absolute anywhere beats bare) diverges.
    'tasks/first-one/spec.md\nbody names /Users/x/.clodex/projects/p-1234abcd/tasks/second-one',
    'tasks/with.dots-and_underscores/nested',
    '',
    null,
  ];

  assert.ok(specs.some((s) => typeof s === 'string' && s.startsWith('/Users/')),
    'ENTER: the specs list must reach the absolute-path case');
  assert.ok(specs.some((s) => typeof s === 'string' && s.includes('\n\ntasks/on-line-three')),
    'ENTER: the specs list must reach the later-line case');

  for (const s of specs) {
    assert.strictEqual(viewer.extractTaskDir(s), coreStore.extractTaskDir(s),
      `diverged on ${JSON.stringify(s)}`);
  }
  // The anti-truncation property said outright, so a pair that drifted together
  // into the bare-first order still fails here.
  assert.strictEqual(
    viewer.extractTaskDir('/Users/someone/.clodex/projects/proj-1234abcd/tasks/deep-work — go'),
    '/Users/someone/.clodex/projects/proj-1234abcd/tasks/deep-work',
    'the absolute form must not be truncated to its tasks/ tail');
  // Said outright as well, so a pair that drifted together back to the
  // first-line-only rule fails here rather than agreeing on null.
  assert.strictEqual(viewer.extractTaskDir('a title\n\ntasks/found'), 'tasks/found',
    'every line is scanned, not just the first');
  assert.strictEqual(
    viewer.extractTaskDir('tasks/one\n/Users/x/.clodex/projects/p-1234abcd/tasks/two'),
    'tasks/one',
    'the earliest LINE wins — abs-before-rel applies within a line, not across the text');
});

test('viewer ticketStarted agrees with core tickets-store', () => {
  // The fourth copy (t329), and it fails silently in BOTH directions, which is
  // why the table covers both. Reading a started ticket as unstarted exempts it
  // from the stall flag and from core's watchdog — a seat holds it, goes quiet
  // for a week, and the board stays calm. Reading an unstarted one as started
  // flags 28 backlog tickets as stalls core can neither produce nor clear.
  const tickets = [
    { startedAt: 123 },                              // stamped → started
    { startedAt: null },                             // filed, never dispatched
    {},                                              // legacy: absent → STARTED
    { parked: true },                                // absent + parked → never dispatched
    { startedAt: null, role: 'hand' },               // second reading: a role means dispatch
    { startedAt: null, worktree: { path: '/x' } },   // and so does a minted tree
    { startedAt: null, worktree: {} },               // but an EMPTY worktree is not a path
    null,
  ];

  // ENTER: the loop is the reduction, and the interesting rows are the two
  // absent-key ones — every other row agrees under an implementation that
  // dropped the legacy arm entirely.
  assert.ok(tickets.some((t) => t && !Object.prototype.hasOwnProperty.call(t, 'startedAt') && !t.parked),
    'the table must reach the bare absent-key case');
  assert.ok(tickets.some((t) => t && !Object.prototype.hasOwnProperty.call(t, 'startedAt') && t.parked),
    'and the absent-key-but-parked case');

  for (const t of tickets) {
    assert.strictEqual(viewer.ticketStarted(t), coreStore.ticketStarted(t),
      `diverged on ${JSON.stringify(t)}`);
  }

  // The anchors, so two copies that drifted TOGETHER still fail: the equality
  // above is satisfied by any pair of identically-wrong functions.
  assert.strictEqual(viewer.ticketStarted({}), true,
    'a record predating the field was dispatched by the old add — absent means STARTED');
  assert.strictEqual(viewer.ticketStarted({ parked: true }), false,
    'except a parked one, the shape the old add returned before delivering');
  assert.strictEqual(viewer.ticketStarted({ startedAt: null }), false,
    'an explicit null is a ticket filed and never dispatched');
});
