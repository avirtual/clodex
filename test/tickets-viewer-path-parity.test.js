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
const { ticketCloseLine } = require('../session-manager');
const viewer = require('../plugins/tickets-viewer/engine')._internals;

// t353: the close verb is the same copied-utility situation as projectDirFor,
// with the same failure mode — silent, and green. A diverged copy still delivers
// a spec, so nothing throws and nothing looks wrong; the seat dispatched through
// the viewer simply learns a different rule (or none) from the seat dispatched
// through core, and the observed defect is exactly a seat not knowing the verb.
// The two literals are asserted byte-for-byte because the WORDING is what does
// the work here: both false beliefs that cost three tickets are denied by name,
// and a paraphrase that dropped either would pass a shape check.
test('viewer close line agrees with core _deliverTicketSpec byte for byte', () => {
  for (const id of ['t1', 't42', 't1000']) {
    assert.strictEqual(viewer.closeLine(id), ticketCloseLine(id),
      `close line must match core's for ${id}`);
  }
  const line = ticketCloseLine('t7');
  assert.match(line, /^CLOSE WITH: \[agent:task done t7\]/,
    'the verb, with the id already filled in — the seat should not have to assemble it');
  assert.match(line, /NOT an exec command, and nothing needs to be granted/,
    'denies the belief that closing is exec-gated — one hand reported by dm for exactly this reason');
  assert.match(line, /A dm carrying your report does NOT close the ticket/,
    'denies the belief that a report-shaped dm closes it — invisible from the lead side, since the report arrives either way');
  assert.ok(line.endsWith('\n'), 'ends the line, or the spec text runs on into it');
});

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

// ── the dispatch-time task-dir gate (t435) ──────────────────────────────────
//
// The sixth copy, and the first that REFUSES rather than computes. t431 put this
// gate on both intent verbs (`_taskStart`, `_taskAssign`); the viewer's assign is
// the other dispatch path, so without a copy here a lead who CLICKS assign gets
// the pre-t431 behaviour — the hand does the whole job and dies at verify — while
// the same action typed as an intent is refused. Two doors into one state, one
// of them open, is the gap this closes.
//
// Its drift is silent in the expensive direction: a copy that stopped refusing
// leaves no error anywhere, it just spends two no-op rounds. The SENTENCE is
// pinned byte-for-byte for the same reason the close line is — the wording
// carries the fix instruction (`respec`), and a paraphrase that dropped it would
// pass a shape check while leaving the lead with a refusal they cannot act on.
//
// Reachable from here because the method uses no `this`: the mixin is built with
// stub deps purely to get at the function.
const coreTaskDirRefusal = require('../team-tickets')
  .createTicketMethods({}, {})._ticketTaskDirRefusal;

test('viewer task-dir refusal agrees with core team-tickets, byte for byte', () => {
  const cases = [
    // [team, ticket, verb, reSend]
    [{}, { id: 't1' }, 'assign', false],                       // THE refusal
    [{}, { id: 't1', taskDir: 'tasks/x' }, 'assign', false],   // has one → allowed
    [{}, { id: 't1', taskDir: '' }, 'assign', false],          // empty is not one
    [{ solo: true }, { id: 't1' }, 'assign', false],           // solo carve-out
    [{ solo: false }, { id: 't1' }, 'assign', false],          // explicitly not solo
    [null, { id: 't1' }, 'assign', false],                     // no team object at all
    [{}, { id: 't1' }, 'assign', true],                        // re-send exemption
    [{ solo: true }, { id: 't1' }, 'assign', true],            // both exemptions at once
    // The verb decides one word of the sentence ("started" vs "assigned"), so a
    // copy that hardcoded either still agrees on half the table.
    [{}, { id: 't1' }, 'start', false],
    [{}, { id: 't99' }, 'assign', false],                      // the id is interpolated twice
  ];

  // ENTER: the loop is the reduction, and every exemption row returns null — a
  // table that somehow lost the one REFUSING row would be satisfied by a copy
  // that returns null unconditionally, which is precisely the regression.
  assert.ok(cases.some(([team, t, , reSend]) => !t.taskDir && !(team && team.solo) && !reSend),
    'the table must reach the case that actually refuses');

  for (const [team, ticket, verb, reSend] of cases) {
    assert.strictEqual(
      viewer.ticketTaskDirRefusal(team, ticket, verb, reSend),
      coreTaskDirRefusal(team, ticket, verb, reSend),
      `diverged on ${JSON.stringify({ team, ticket, verb, reSend })}`);
  }

  // The anchors, so two copies that drifted TOGETHER still fail here. Equality
  // above is satisfied by any pair of identically-wrong functions — including the
  // pair where both stopped refusing.
  const line = viewer.ticketTaskDirRefusal({}, { id: 't7' }, 'assign', false);
  assert.strictEqual(line, coreTaskDirRefusal({}, { id: 't7' }, 'assign', false));
  assert.match(line, /^ticket t7 has no task dir, so nothing was assigned/,
    'names the ticket and says outright that nothing happened');
  assert.match(line, /its spec names no `tasks\/…` path on any line/,
    'says WHY, in terms of the spec the lead can go and fix');
  assert.match(line, /the review step has nowhere to write its diff/,
    'and what it costs — the reason this is refused at dispatch rather than at verify');
  assert.match(line, /Nothing was changed\./,
    'the promise the placement above every write is what makes true');
  assert.match(line, /\[agent:task respec t7\]/,
    'the fix instruction, with the id filled in — respec and NOT reject, since the ticket is still open');

  // And the exemptions said outright, so a copy that refuses everything fails
  // here rather than passing a table where the exempt rows are merely equal.
  assert.strictEqual(viewer.ticketTaskDirRefusal({ solo: true }, { id: 't7' }, 'assign', false), null,
    'a solo board mints no worktree and gets no loop step, so it never reaches the cost this prevents');
  assert.strictEqual(viewer.ticketTaskDirRefusal({}, { id: 't7' }, 'assign', true), null,
    'a re-send is a redelivery, which is how a respawned or stuck seat recovers');
  assert.strictEqual(viewer.ticketTaskDirRefusal({}, { id: 't7', taskDir: 'tasks/x' }, 'assign', false), null,
    'a ticket that HAS a task dir is the ordinary case and must pass through');
});

// ── the dispatch's TASK DIR line (t458) ─────────────────────────────────────
//
// The seventh copy, and the one whose drift is the most expensive: the viewer's
// `deliverSpec` is a THIRD renderer of a dispatch body, and until t458 it
// carried no TASK DIR line at all. 260 of the live board's 368 pointers are
// relative and ~37% of those collide by name with a directory in the repo's
// gitignored `tasks/` decoy, so a viewer-dispatched hand resolved its pointer
// against its CWD, FOUND a directory, and read another ticket's artifacts.
//
// Same false-green class as projectDirFor, and strictly worse than a diverged
// `confine`: nothing throws, nothing renders empty, and the hand reports success
// over the wrong tree.
//
// Three things are pinned, because each fails independently:
//   - `resolveTaskDir` — WHICH directory, and that an escaping pointer still
//     refuses on both sides (confinement is the security half of this copy).
//   - `ticketTaskDirLine` — the WORDING. A paraphrase names the same directory
//     and teaches a different rule.
//   - `ticketTaskDirLineFor` against core's `_ticketTaskDirRender().line` — the
//     GATE. Both halves can be byte-identical while the viewer renders under a
//     different condition, or never renders at all.
const coreCost = require('../team-cost');
const { ticketTaskDirLine: coreTaskDirLine } = require('../session-manager');

// Core takes REGISTRY_DIR through deps and DESTRUCTURES it at factory time, so
// it must hold its final value before createTicketMethods runs — a getter over a
// box rebound per test would be read once and never again. The fixture home is
// therefore module-scope, and the viewer is pointed at the SAME one inside each
// test: two roots would make every comparison below one between two trees.
//
// Shaped as a real `~/.clodex` (home + a `.clodex` leaf) rather than a bare temp
// dir, for the resolveTaskDir test BELOW and only that one: it is the single
// place `homedir` is wired (see the `env` it builds), so it is the only place a
// `~/…` row resolves INSIDE the projects root instead of escaping it and
// refusing. The dispatch-parity test further down passes no homedir, so both
// halves there see the real `os.homedir()` and its `~` row agrees by REFUSING —
// which is agreement for the wrong reason, and not what pins the gate. What
// pins the empty-clause gate there is the ABSOLUTE row, which resolves and must
// still render '' (asserted outright at the end of that test).
const PARITY_HOMEDIR = path.join(os.tmpdir(), 'parity-taskdir-home');
const PARITY_CLODEX = path.join(PARITY_HOMEDIR, '.clodex');
const PARITY_PROJECTS = path.join(PARITY_CLODEX, 'projects');
const PARITY_TEAM_ROOT = '/Users/someone/projects/wb-wrap-ui';
const PARITY_PROJECT_DIR = core.projectDirFor(PARITY_CLODEX, PARITY_TEAM_ROOT);

const coreTicketMethods = require('../team-tickets').createTicketMethods(
  // The three deps `_ticketDiffDest` reads. The mixin uses no `this` on this
  // path, so stub deps are enough to reach the method.
  { REGISTRY_DIR: PARITY_CLODEX, path, os }, {});

// The shapes real tickets carry, plus the one that must be REFUSED. The `~` and
// absolute rows are here because they are where the rule clause is EMPTY: a copy
// that dropped the gate agrees on the directory and disagrees on the line.
const TASK_DIR_CASES = [
  'tasks/viewer-deliver-spec-taskdir',
  'tasks/wire-off/SPEC.md',                    // file tail dropped
  'tasks/wire-off/',                           // a trailing slash is not a segment
  'tasks/v1.2',                                // a dotted DIRECTORY is kept whole
  'tasks/audit/specs/P4.md',                   // nested, tail dropped
  '~/.clodex/projects/p-1234abcd/tasks/x',     // already placed — no rule clause
  path.join(PARITY_PROJECT_DIR, 'tasks', 'x'), // absolute — no rule clause either
  'tasks/../../../../etc/passwd',              // escapes: must refuse on both sides
  '',                                          // no pointer at all
];

test('viewer resolveTaskDir agrees with core team-cost, refusals included', () => {
  const env = { projectDir: PARITY_PROJECT_DIR, projectsRoot: PARITY_PROJECTS, homedir: PARITY_HOMEDIR };

  // ENTER: the table is the reduction, and most rows RESOLVE. A table that lost
  // the escaping row would be satisfied by a pair of copies that both stopped
  // confining, which is exactly the security half of this copy.
  assert.ok(TASK_DIR_CASES.some((raw) => raw.includes('..')),
    'the table must reach the pointer that escapes the projects root');

  let threw = 0;
  for (const raw of TASK_DIR_CASES) {
    let mine; let theirs; let myErr = null; let theirErr = null;
    try { mine = viewer.resolveTaskDir({ taskDir: raw, ...env }); } catch (e) { myErr = e.message; }
    try { theirs = coreCost.resolveTaskDir({ taskDir: raw, ...env }); } catch (e) { theirErr = e.message; }
    assert.strictEqual(myErr, theirErr, `refusal diverged on ${JSON.stringify(raw)}`);
    assert.strictEqual(mine, theirs, `resolution diverged on ${JSON.stringify(raw)}`);
    if (myErr) threw += 1;
  }
  // Equality alone is satisfied by two copies that refuse EVERYTHING, which is
  // the drift that would silently strip the line from every dispatch.
  assert.strictEqual(threw, 1, 'exactly the escaping row refused');

  // The anchor, so two copies that drifted together still fail: a relative
  // pointer lands under the PROJECT dir and nowhere else.
  assert.strictEqual(
    viewer.resolveTaskDir({ taskDir: 'tasks/wire-off/SPEC.md', ...env }),
    path.join(PARITY_PROJECT_DIR, 'tasks', 'wire-off'),
    'a relative pointer resolves under the project artifact dir, with the spec file dropped');
});

test('viewer ticketTaskDirLine agrees with core team-tickets byte for byte', () => {
  const dir = path.join(PARITY_PROJECT_DIR, 'tasks', 'thing');

  // ENTER: both a relative raw (clause rendered) and an already-placed one
  // (clause empty) must be in the set — the gate lives inside the helper, so a
  // table of only relative pointers is satisfied by a copy with no gate at all.
  assert.ok(TASK_DIR_CASES.some((raw) => raw && !raw.startsWith('~') && !path.isAbsolute(raw)),
    'the table must reach a relative pointer, which is what renders the clause');
  assert.ok(TASK_DIR_CASES.some((raw) => raw.startsWith('~') || path.isAbsolute(raw)),
    'and an already-placed one, which is what must NOT');

  for (const raw of TASK_DIR_CASES) {
    assert.strictEqual(viewer.ticketTaskDirLine(dir, raw), coreTaskDirLine(dir, raw),
      `diverged on ${JSON.stringify(raw)}`);
  }

  // The wording anchors, so two copies that drifted TOGETHER still fail here.
  // Each sentence answers a way a hand has actually gone wrong.
  const line = viewer.ticketTaskDirLine(dir, 'tasks/thing/SPEC.md');
  assert.strictEqual(line, coreTaskDirLine(dir, 'tasks/thing/SPEC.md'));
  assert.ok(line.startsWith(`TASK DIR: ${dir}`),
    'the RESOLVED directory, first — nothing for the seat to assemble');
  assert.match(line, /relative to the PROJECT'S ARTIFACT DIR/,
    'says what the raw pointer is relative TO — resolving it against cwd is the whole defect');
  assert.match(line, /a same-named directory inside the repo is NOT it/,
    "names the decoy by shape — a hand that finds one reads another ticket's artifacts and reports success");
  assert.match(line, /the pointer may name a file inside it/,
    'the pointer usually ends in SPEC.md, and this line names the DIRECTORY');
  assert.match(line, /its absence is not evidence that there is no artifact/,
    'a hand that found it missing worked without one — that is the reported failure');
  assert.match(line, /So create it rather than working without one\./,
    'the dispatch-only half: this seat can WRITE, unlike the reviewer the clause is shared with');
  assert.ok(line.endsWith('\n'), 'ends the line, or the close line runs on into it');

  // And the gate said outright, so a copy that renders the clause
  // unconditionally fails here rather than passing a table where the placed rows
  // merely agree.
  for (const raw of ['~/.clodex/projects/p/tasks/x', '/tmp/elsewhere/tasks/x']) {
    assert.strictEqual(viewer.ticketTaskDirLine(dir, raw), `TASK DIR: ${dir}\n`,
      'an already-placed pointer means to an agent what it means here, so it earns no prose');
  }
});

test('the viewer dispatch renders the same TASK DIR line core does, under the same gate', () => {
  viewer.setClodexHomeForTest(PARITY_CLODEX);
  try {
    const team = { root: PARITY_TEAM_ROOT };
    const coreLine = (raw) => coreTicketMethods._ticketTaskDirRender(team, { id: 't1', taskDir: raw }).line;

    // ENTER: the comparison is only interesting on rows core actually RENDERS.
    // Without this, a viewer that returned '' for every input would agree with
    // core on every row in the table — the exact pre-t458 behaviour.
    const rendered = TASK_DIR_CASES.filter((raw) => coreLine(raw));
    assert.ok(rendered.length >= 2, `the table must reach rows core renders (got ${rendered.length})`);

    for (const raw of TASK_DIR_CASES) {
      assert.strictEqual(
        viewer.ticketTaskDirLineFor(PARITY_PROJECT_DIR, { id: 't1', taskDir: raw }),
        coreLine(raw),
        `dispatch rendering diverged on ${JSON.stringify(raw)}`);
    }

    // A record with no `taskDir` KEY at all — the legacy shape, and the one an
    // unguarded read crashes on rather than skips.
    assert.strictEqual(viewer.ticketTaskDirLineFor(PARITY_PROJECT_DIR, { id: 't1' }), '');
    assert.strictEqual(viewer.ticketTaskDirLineFor(PARITY_PROJECT_DIR, null), '');

    // The suppressions said outright, so a copy that renders a bare
    // `TASK DIR: <dir>` line into every dispatch fails here: every dispatch
    // already spills past the 500-byte threshold, so a line that says nothing
    // costs each of those seats a Read turn.
    assert.strictEqual(
      viewer.ticketTaskDirLineFor(PARITY_PROJECT_DIR, { id: 't1', taskDir: path.join(PARITY_PROJECT_DIR, 'tasks', 'x') }), '',
      'an absolute pointer suppresses the WHOLE line, not merely the clause');
    assert.strictEqual(viewer.ticketTaskDirLineFor(PARITY_PROJECT_DIR, { id: 't1', taskDir: '~/.clodex/projects/p/tasks/y' }), '',
      'and so does a ~-prefixed one');
    assert.strictEqual(viewer.ticketTaskDirLineFor(PARITY_PROJECT_DIR, { id: 't1', taskDir: 'tasks/../../../etc' }), '',
      'a pointer that escapes confinement drops the line — a dispatch must not die over a display line');
  } finally { viewer.setClodexHomeForTest(null); }
});
