'use strict';

// Run: node --test test/tickets-migrate.test.js
//
// The one-time copy of each team's board onto the PROJECT board. What can break
// here and stay invisible: a second run duplicating every record, a merge
// renumbering an id that a branch name and a task dir already reference, and a
// team with no root scattering its records onto a board derived from nothing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runTicketsMigration, mergeBoards, reconcileBoard, MARKER } = require('../tickets-migrate');
const { createTicketsStore } = require('../tickets-store');
const { projectDirFor } = require('../clodex-paths');

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-mig-'));
}

// A team on disk: teams/<name>/{team.json,tickets.json}. `root` omitted on
// purpose when null — a team.json WITHOUT the key is the case under test, not a
// team.json carrying `root: null`.
function mkTeam(home, name, { root, tickets, manifest } = {}) {
  const dir = path.join(home, 'teams', name);
  fs.mkdirSync(dir, { recursive: true });
  const man = manifest !== undefined ? manifest : (root ? { name, root } : { name });
  if (man !== null) fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify(man));
  if (tickets !== undefined) fs.writeFileSync(path.join(dir, 'tickets.json'), JSON.stringify(tickets));
  return dir;
}

test('tickets-migrate: a team board is COPIED onto its project board, source left in place', () => {
  const home = mkHome();
  const root = '/proj/alpha';
  const src = [{ id: 't1', state: 'open', assignee: 'hand' }, { id: 't2', state: 'done', assignee: null }];
  const teamDir = mkTeam(home, 'alpha', { root, tickets: src });

  const res = runTicketsMigration({ root: home, fs });

  const board = createTicketsStore({ clodexHome: home }).load(root);
  assert.strictEqual(board.length, 2, 'ENTER: both records must reach the project board');
  assert.deepStrictEqual(board, [
    { id: 't1', state: 'open', assignee: 'hand', originTeam: 'alpha' },
    { id: 't2', state: 'done', assignee: null, originTeam: 'alpha' },
  ], 'copied verbatim but for the provenance stamp — no id changed, no field dropped');
  assert.ok(fs.existsSync(path.join(projectDirFor(home, root), 'tickets.json')));
  // Copy, never move: the legacy file is the only backup of a migration that
  // cannot be re-run once the marker is down.
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(teamDir, 'tickets.json'), 'utf-8')), src,
    'the source board must survive untouched');
  assert.ok(fs.existsSync(path.join(teamDir, MARKER)), 'the per-team marker is written');
  assert.strictEqual(res.migrated, 2);
});

// The pass is no longer SKIPPED on the second run — it reruns and reconciles —
// but it must still change nothing when the source has not moved. The marker's
// timestamp is checked too: it dates the initial copy, and a run that restamps
// it destroys the only record of when that was.
test('tickets-migrate: a SECOND run changes nothing when the source has not moved', () => {
  const home = mkHome();
  const root = '/proj/alpha';
  const teamDir = mkTeam(home, 'alpha', { root, tickets: [{ id: 't1', state: 'open', lastActivityAt: 1000 }] });
  const store = createTicketsStore({ clodexHome: home });

  runTicketsMigration({ root: home, fs });
  const first = store.load(root);
  assert.strictEqual(first.length, 1, 'ENTER: the first run must have populated the board');
  const stamp = fs.readFileSync(path.join(teamDir, MARKER), 'utf-8');
  const res = runTicketsMigration({ root: home, fs });

  assert.deepStrictEqual(store.load(root), first, 'the board is byte-identical after the second run');
  assert.strictEqual(res.migrated, 0);
  assert.deepStrictEqual(res.teams, [{ team: 'alpha', added: 0, reconciled: 0, projectRoot: root }]);
  assert.strictEqual(fs.readFileSync(path.join(teamDir, MARKER), 'utf-8'), stamp,
    'the marker still dates the INITIAL copy, not the latest pass');
});

test('tickets-migrate: with the marker DELETED by hand, a re-run still adds nothing (provenance, not the marker)', () => {
  const home = mkHome();
  const root = '/proj/alpha';
  const teamDir = mkTeam(home, 'alpha', { root, tickets: [{ id: 't1', state: 'open' }, { id: 't2', state: 'open' }] });
  const store = createTicketsStore({ clodexHome: home });

  runTicketsMigration({ root: home, fs });
  const first = store.load(root);
  assert.strictEqual(first.length, 2, 'ENTER: the first run must actually have populated the board');
  fs.rmSync(path.join(teamDir, MARKER));

  runTicketsMigration({ root: home, fs });

  assert.deepStrictEqual(store.load(root), first,
    'the id+originTeam match is what prevents the duplicate — the marker is only the fast path');
});

test('tickets-migrate: a team with NO root in team.json is skipped and logged, never guessed at', () => {
  const home = mkHome();
  const teamDir = mkTeam(home, 'rootless', { tickets: [{ id: 't1', state: 'open' }] });
  const lines = [];

  const res = runTicketsMigration({ root: home, fs, log: { info: (_c, m) => lines.push(m) } });

  assert.deepStrictEqual(res.teams, [{ team: 'rootless', skipped: 'no root in team.json' }]);
  assert.strictEqual(res.migrated, 0);
  assert.ok(!fs.existsSync(path.join(teamDir, MARKER)),
    'no marker: the team is not migrated, so a later team.json carrying a root must still migrate it');
  assert.ok(lines.some((l) => /rootless/.test(l)), 'the skip is logged, not silent');
  assert.ok(!fs.existsSync(path.join(home, 'projects')),
    'no project board was derived from a root that does not exist');
});

test('tickets-migrate: a team with no tickets.json at all is untouched', () => {
  const home = mkHome();
  const teamDir = mkTeam(home, 'fresh', { root: '/proj/fresh' });
  const res = runTicketsMigration({ root: home, fs });
  assert.deepStrictEqual(res.teams, [], 'a team that never opened a ticket is not a migration');
  assert.ok(!fs.existsSync(path.join(teamDir, MARKER)));
});

test('tickets-migrate: two teams on ONE project merge into one board', () => {
  const home = mkHome();
  const root = '/proj/shared';
  mkTeam(home, 'alpha', { root, tickets: [{ id: 't1', state: 'open' }] });
  mkTeam(home, 'beta', { root, tickets: [{ id: 't5', state: 'open' }] });

  runTicketsMigration({ root: home, fs });

  const board = createTicketsStore({ clodexHome: home }).load(root);
  assert.deepStrictEqual(board.map((t) => [t.id, t.originTeam]), [['t1', 'alpha'], ['t5', 'beta']],
    'both teams land on the one project board, each stamped with where it came from');
});

// The property in the name IS the ruling: an id is a public reference (branch
// names, artifact dirs, commit messages), so a record that did not move must
// still answer to the id those things already use, and no two records may share
// one — a duplicate resolves to the wrong work with no symptom.
test('tickets-migrate: after a colliding merge no two records share an id, and a record that did NOT move keeps its id', () => {
  const home = mkHome();
  const root = '/proj/shared';
  // alpha migrates first (names are walked sorted), so beta's t1 is the collider.
  mkTeam(home, 'alpha', { root, tickets: [{ id: 't1', state: 'open', spec: 'alpha work' }, { id: 't2', state: 'open' }] });
  mkTeam(home, 'beta', { root, tickets: [{ id: 't1', state: 'open', spec: 'beta work' }] });

  runTicketsMigration({ root: home, fs });

  const board = createTicketsStore({ clodexHome: home }).load(root);
  assert.strictEqual(board.length, 3, 'ENTER: all three records must be on the board for the id claim to mean anything');
  const ids = board.map((t) => t.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'no two records share an id after the merge');

  // Did NOT move → kept its id. Identified by its payload, not its position.
  const kept = board.find((t) => t.spec === 'alpha work');
  assert.strictEqual(kept.id, 't1', 'the record already on the board keeps the id every branch name already uses');
  assert.strictEqual(kept.formerId, undefined, 'and is not stamped as re-issued');

  // Arrived into a taken id → re-issued ABOVE the max, carrying its old id.
  const moved = board.find((t) => t.spec === 'beta work');
  assert.strictEqual(moved.id, 't3', 're-issued above the merged max, never into the gap');
  assert.strictEqual(moved.formerId, 't1', 'its previous id survives on the record');
  assert.strictEqual(moved.originTeam, 'beta');
});

test('mergeBoards: two colliding arrivals get two DIFFERENT new ids', () => {
  // Both source ids are taken on the destination, so both re-issue. The max has
  // to be recomputed per arrival: computed once up front, the second would be
  // handed the same new id as the first and the merge would ship a duplicate.
  const dest = [{ id: 't1', k: 'dest1' }, { id: 't2', k: 'dest2' }];
  const merged = mergeBoards(dest, [{ id: 't1', k: 'a' }, { id: 't2', k: 'b' }], 'beta');
  const ids = merged.map((t) => t.id);
  assert.strictEqual(ids.length, 4, 'ENTER: both arrivals must be on the merged board');
  assert.strictEqual(new Set(ids).size, 4, 'no two records share an id');
  assert.deepStrictEqual(ids, ['t1', 't2', 't3', 't4']);
  assert.deepStrictEqual(merged.map((t) => t.formerId), [undefined, undefined, 't1', 't2']);
});

// Not a case the app can produce (nextTicketId makes source ids unique), but the
// merge is fed a hand-editable file, and the answer must be to drop the repeat
// rather than to mint a second record with the same provenance — that record
// would be re-copied as a NEW ticket on every later run whose marker was cleared.
test('mergeBoards: a source board repeating one id contributes it ONCE', () => {
  const merged = mergeBoards([], [{ id: 't1', k: 'a' }, { id: 't1', k: 'b' }], 'beta');
  assert.deepStrictEqual(merged, [{ id: 't1', k: 'a', originTeam: 'beta' }]);
});

test('mergeBoards: a NATIVE destination record does not suppress a team record with the same id', () => {
  // A native record has no originTeam, so its key is null and can never match an
  // arriving record's `<team> <id>`. Without that, the project's own t1 would be
  // read as "alpha's t1, already migrated" and alpha's real t1 would be dropped.
  const merged = mergeBoards([{ id: 't1', state: 'open' }], [{ id: 't1', state: 'open' }], 'alpha');
  assert.strictEqual(merged.length, 2, 'the arriving record is a collision to re-issue, not a duplicate to drop');
  assert.strictEqual(merged[1].id, 't2');
  assert.strictEqual(merged[1].formerId, 't1');
});

test('tickets-migrate: no teams dir at all is a silent no-op', () => {
  const res = runTicketsMigration({ root: mkHome(), fs });
  assert.deepStrictEqual(res, { migrated: 0, reconciled: 0, teams: [] });
});

test('tickets-migrate: an unparseable source board contributes nothing rather than throwing', () => {
  const home = mkHome();
  mkTeam(home, 'alpha', { root: '/proj/alpha', tickets: [{ id: 't1', state: 'open' }] });
  const badDir = path.join(home, 'teams', 'broken');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'team.json'), JSON.stringify({ name: 'broken', root: '/proj/broken' }));
  fs.writeFileSync(path.join(badDir, 'tickets.json'), '{ not json');

  const res = runTicketsMigration({ root: home, fs });

  const alpha = res.teams.find((t) => t.team === 'alpha');
  assert.ok(alpha && alpha.added === 1, 'ENTER: the healthy team must still have migrated');
  assert.deepStrictEqual(createTicketsStore({ clodexHome: home }).load('/proj/broken'), [],
    'the unreadable board reads as empty, the way the store reads every broken board');
});

// The PER-TEAM catch, which the unparseable-board case above does NOT reach —
// that one is absorbed by the best-effort parse and passes just as happily
// without any isolation at all. This needs a failure the inner guards cannot
// swallow, so it breaks the SAVE: a file sitting where the project dir must be
// makes ensureDir throw for that team and no other.
test('tickets-migrate: a team whose SAVE throws does not cost another team its migration', () => {
  const home = mkHome();
  mkTeam(home, 'alpha', { root: '/proj/alpha', tickets: [{ id: 't1', state: 'open' }] });
  mkTeam(home, 'wedged', { root: '/proj/wedged', tickets: [{ id: 't1', state: 'open' }] });
  const blocked = projectDirFor(home, '/proj/wedged');
  fs.mkdirSync(path.dirname(blocked), { recursive: true });
  fs.writeFileSync(blocked, 'a file where the project dir must be');

  const res = runTicketsMigration({ root: home, fs });

  const wedged = res.teams.find((t) => t.team === 'wedged');
  assert.ok(wedged && wedged.error, 'ENTER: the wedged team must really have thrown, or this proves nothing');
  const alpha = res.teams.find((t) => t.team === 'alpha');
  assert.ok(alpha && alpha.added === 1, 'the healthy team migrated anyway');
  assert.ok(!fs.existsSync(path.join(home, 'teams', 'wedged', MARKER)),
    'and the failed team is NOT marked, so a later run retries it');
});

// The destination is read DIRECTLY, not through store.load, which is best-effort
// and cannot distinguish "no board yet" from "board is there but I could not read
// it". Merging onto the [] that best-effort read returns and then saving replaces
// the operator's own board with source-only content — the exact opposite of this
// module's copy-never-move contract, and silent.
test('tickets-migrate: a CORRUPT destination board is never overwritten', () => {
  const home = mkHome();
  const root = '/proj/alpha';
  mkTeam(home, 'alpha', { root, tickets: [{ id: 't1', state: 'open' }] });
  const destFile = path.join(projectDirFor(home, root), 'tickets.json');
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, '{ this is not valid json');

  const res = runTicketsMigration({ root: home, fs });

  const alpha = res.teams.find((t) => t.team === 'alpha');
  assert.ok(alpha && alpha.error, 'ENTER: the team must be recorded as an ERROR, not silently migrated');
  assert.strictEqual(fs.readFileSync(destFile, 'utf-8'), '{ this is not valid json',
    'the unreadable destination survives byte for byte');
  assert.ok(!fs.existsSync(path.join(home, 'teams', 'alpha', MARKER)),
    'no marker, so the next launch retries once the operator has fixed the board');
  assert.strictEqual(res.migrated, 0);
});

// The same defect with a live board rather than a corrupt one: this is what the
// operator actually loses if "unreadable" is treated as "empty".
test('tickets-migrate: an UNREADABLE destination keeps its native records', () => {
  const home = mkHome();
  const root = '/proj/alpha';
  const native = [{ id: 't1', state: 'open', title: 'the project own ticket' }];
  mkTeam(home, 'alpha', { root, tickets: [{ id: 't1', state: 'open', title: 'the team ticket' }] });
  const destFile = path.join(projectDirFor(home, root), 'tickets.json');
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, JSON.stringify(native));
  fs.chmodSync(destFile, 0o000);

  // Probe the PRECONDITION, not the outcome. Running as root defeats chmod, and
  // this case then cannot be staged at all. Deciding that by asking whether the
  // migration reported an error would make the skip fire on exactly the failure
  // under test — the first draft did that and passed against the unfixed code.
  let staged = true;
  try { fs.readFileSync(destFile, 'utf-8'); staged = false; } catch { staged = true; }

  let res;
  try {
    res = runTicketsMigration({ root: home, fs });
  } finally {
    fs.chmodSync(destFile, 0o600);
  }
  if (!staged) return; // running as root; the file stayed readable

  const alpha = res.teams.find((t) => t.team === 'alpha');
  assert.ok(alpha && alpha.error, 'ENTER: the unreadable destination must be an error');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(destFile, 'utf-8')), native,
    'the native records are still there — this is the data the bug would have destroyed');
  assert.ok(!fs.existsSync(path.join(home, 'teams', 'alpha', MARKER)), 'not marked, so it retries');
});

// The guard must not fire on the ordinary case, or it blocks every first-ever
// migration: a destination that has never existed is an empty board, not an error.
test('tickets-migrate: an ABSENT destination board is empty, not an error', () => {
  const home = mkHome();
  const root = '/proj/alpha';
  mkTeam(home, 'alpha', { root, tickets: [{ id: 't1', state: 'open' }] });

  const res = runTicketsMigration({ root: home, fs });

  assert.deepStrictEqual(res.teams, [{ team: 'alpha', added: 1, reconciled: 0, projectRoot: root }]);
  assert.strictEqual(createTicketsStore({ clodexHome: home }).load(root).length, 1);
});

// ── reconcile-by-recency (t302) ────────────────────────────────────────────────
// The incident: the copy ran two minutes before a ticket closed, so the
// destination got a snapshot of work still in flight and the marker guaranteed
// that snapshot could never be corrected. Every case below stages exactly that
// shape — a destination record that is STALE, asserted stale before the run —
// because a fixture where source and destination already agree tests nothing.

test('tickets-migrate: a destination snapshot taken mid-flight is RE-SYNCED from a newer source', () => {
  const home = mkHome();
  const root = '/proj/alpha';
  const teamDir = mkTeam(home, 'alpha', { root, tickets: [{ id: 't1', state: 'open', lastActivityAt: 1000 }] });
  const store = createTicketsStore({ clodexHome: home });

  runTicketsMigration({ root: home, fs });   // the mid-flight snapshot

  // The team board moves on: the ticket closes AFTER the copy was taken.
  fs.writeFileSync(path.join(teamDir, 'tickets.json'), JSON.stringify([
    { id: 't1', state: 'done', closedBy: 'hand', lastActivityAt: 2000 },
  ]));

  // ENTER: the destination must really be stale before the run, or the assertion
  // after it is satisfied by a fixture that never needed reconciling.
  const before = store.load(root);
  assert.deepStrictEqual(before, [{ id: 't1', state: 'open', lastActivityAt: 1000, originTeam: 'alpha' }],
    'ENTER: the destination holds the STALE open snapshot going in');

  const res = runTicketsMigration({ root: home, fs });

  assert.deepStrictEqual(store.load(root), [
    { id: 't1', state: 'done', closedBy: 'hand', lastActivityAt: 2000, originTeam: 'alpha' },
  ], 'the whole record is replaced from the newer source, provenance kept');
  assert.strictEqual(res.reconciled, 1);
  assert.strictEqual(res.migrated, 0, 'a re-sync is not an arrival — nothing was added');
});

test('tickets-migrate: a destination NEWER than the source is left alone', () => {
  const home = mkHome();
  const root = '/proj/alpha';
  mkTeam(home, 'alpha', { root, tickets: [{ id: 't1', state: 'open', lastActivityAt: 1000 }] });
  const store = createTicketsStore({ clodexHome: home });

  runTicketsMigration({ root: home, fs });

  // Post-cutover work: the PROJECT board advances, the frozen team board does not.
  const advanced = [{ id: 't1', state: 'done', closedBy: 'lead', lastActivityAt: 9000, originTeam: 'alpha' }];
  store.save(root, advanced);
  assert.strictEqual(store.load(root)[0].lastActivityAt, 9000, 'ENTER: the destination is the newer side going in');

  const res = runTicketsMigration({ root: home, fs });

  assert.deepStrictEqual(store.load(root), advanced,
    'the frozen team board must never drag a live project record backwards');
  assert.strictEqual(res.reconciled, 0);
});

// The self-termination property, driven rather than argued: once the destination
// has moved past the frozen source, repeated runs are permanent no-ops. This is
// what replaces an end-date, a version check and a second marker.
test('tickets-migrate: reconcile self-terminates — once the destination leads, further runs are no-ops', () => {
  const home = mkHome();
  const root = '/proj/alpha';
  const teamDir = mkTeam(home, 'alpha', { root, tickets: [{ id: 't1', state: 'open', lastActivityAt: 1000 }] });
  const store = createTicketsStore({ clodexHome: home });

  runTicketsMigration({ root: home, fs });
  fs.writeFileSync(path.join(teamDir, 'tickets.json'), JSON.stringify([
    { id: 't1', state: 'done', lastActivityAt: 2000 },
  ]));
  const resynced = runTicketsMigration({ root: home, fs });
  assert.strictEqual(resynced.reconciled, 1, 'ENTER: a re-sync must have happened, or termination is vacuous');

  // The project board now advances on its own; the team board is frozen forever.
  store.save(root, [{ ...store.load(root)[0], state: 'open', lastActivityAt: 3000 }]);
  const settled = store.load(root);

  for (let i = 0; i < 3; i++) {
    const res = runTicketsMigration({ root: home, fs });
    assert.strictEqual(res.reconciled, 0, `run ${i + 2} must reconcile nothing`);
    assert.deepStrictEqual(store.load(root), settled, `run ${i + 2} must not touch the board`);
  }
});

test('tickets-migrate: a re-sync keeps the RE-ISSUED id and its provenance, not the source id', () => {
  const home = mkHome();
  const root = '/proj/shared';
  mkTeam(home, 'alpha', { root, tickets: [{ id: 't1', state: 'open', lastActivityAt: 1000 }] });
  const betaDir = mkTeam(home, 'beta', { root, tickets: [{ id: 't1', state: 'open', spec: 'beta', lastActivityAt: 1000 }] });
  const store = createTicketsStore({ clodexHome: home });

  runTicketsMigration({ root: home, fs });
  const moved = store.load(root).find((t) => t.originTeam === 'beta');
  assert.strictEqual(moved.id, 't2', 'ENTER: beta\'s record must really have been re-issued');
  assert.strictEqual(moved.formerId, 't1');
  assert.strictEqual(moved.state, 'open', 'ENTER: and its destination copy is the stale one');

  fs.writeFileSync(path.join(betaDir, 'tickets.json'), JSON.stringify([
    { id: 't1', state: 'done', spec: 'beta', lastActivityAt: 5000 },
  ]));

  const res = runTicketsMigration({ root: home, fs });

  const after = store.load(root).find((t) => t.originTeam === 'beta');
  assert.strictEqual(res.reconciled, 1);
  assert.strictEqual(after.state, 'done', 'the newer content arrived');
  assert.strictEqual(after.id, 't2', 'the id every branch name and artifact dir already uses is kept');
  assert.strictEqual(after.formerId, 't1', 'and its provenance survives the replacement');
  assert.strictEqual(store.load(root).length, 2, 'a re-sync replaces in place — it never appends');
});

test('reconcileBoard: a NATIVE destination record is never reconciled against a same-id source', () => {
  // A native record has no originTeam, so it is not this team's to overwrite —
  // even when the team's own t1 happens to be newer.
  const dest = [{ id: 't1', state: 'open', lastActivityAt: 1 }];
  const { board, reconciled } = reconcileBoard(dest, [{ id: 't1', state: 'done', lastActivityAt: 9999 }], 'alpha');
  assert.strictEqual(reconciled, 0);
  assert.deepStrictEqual(board, dest, 'the project\'s own ticket is not a stale copy of anyone\'s');
});

test('reconcileBoard: equal timestamps do not reconcile — strictly newer, or nothing', () => {
  const dest = [{ id: 't1', state: 'open', lastActivityAt: 500, originTeam: 'alpha' }];
  const { board, reconciled } = reconcileBoard(dest, [{ id: 't1', state: 'done', lastActivityAt: 500 }], 'alpha');
  assert.strictEqual(reconciled, 0);
  assert.deepStrictEqual(board, dest, 'an equal stamp is the same write — replacing on it would churn every launch');
});

test('reconcileBoard: a source with no usable timestamp never wins', () => {
  const dest = [{ id: 't1', state: 'done', lastActivityAt: 500, originTeam: 'alpha' }];
  for (const bad of [undefined, null, 'yesterday', NaN]) {
    const { board, reconciled } = reconcileBoard(dest, [{ id: 't1', state: 'open', lastActivityAt: bad }], 'alpha');
    assert.strictEqual(reconciled, 0, `lastActivityAt=${String(bad)} must not reconcile`);
    assert.deepStrictEqual(board, dest);
  }
});

// A destination that has NO timestamp is an unmodified copy — every write path
// in session-manager stamps lastActivityAt — so a stamped source is the newer of
// the two and must win. Without this the exact records the migration copied
// before the field existed would be frozen stale forever.
test('reconcileBoard: a destination with no timestamp loses to a stamped source', () => {
  const dest = [{ id: 't1', state: 'open', originTeam: 'alpha' }];
  const { board, reconciled } = reconcileBoard(dest, [{ id: 't1', state: 'done', lastActivityAt: 5 }], 'alpha');
  assert.strictEqual(reconciled, 1);
  assert.deepStrictEqual(board, [{ id: 't1', state: 'done', lastActivityAt: 5, originTeam: 'alpha' }]);
});

// Provenance is taken from the DESTINATION, deleted when absent there — a
// formerId sitting on the source (the team board is hand-editable, and a record
// re-issued in some other migration carries one) must not be adopted as this
// board's provenance.
test('reconcileBoard: a source formerId/migratedAt does not leak into the replacement', () => {
  const dest = [{ id: 't1', state: 'open', lastActivityAt: 1, originTeam: 'alpha' }];
  const src = [{ id: 't1', state: 'done', lastActivityAt: 2, formerId: 't99', migratedAt: 'bogus' }];
  const { board, reconciled } = reconcileBoard(dest, src, 'alpha');
  assert.strictEqual(reconciled, 1, 'ENTER: the replacement must have happened for the absence below to mean anything');
  assert.deepStrictEqual(board, [{ id: 't1', state: 'done', lastActivityAt: 2, originTeam: 'alpha' }]);
});

// Ruling 2 keeps must-fix 3 from the t301 review intact: the reconcile path runs
// AFTER readDestination, so an unreadable destination is still a per-team error
// with no marker and no save — the reconcile must not open a way around it.
test('tickets-migrate: reconcile does not bypass the unreadable-destination guard', () => {
  const home = mkHome();
  const root = '/proj/alpha';
  mkTeam(home, 'alpha', { root, tickets: [{ id: 't1', state: 'done', lastActivityAt: 9999 }] });
  const destFile = path.join(projectDirFor(home, root), 'tickets.json');
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, '{ not json');
  fs.writeFileSync(path.join(home, 'teams', 'alpha', MARKER), 'already migrated\n');

  const res = runTicketsMigration({ root: home, fs });

  const alpha = res.teams.find((t) => t.team === 'alpha');
  assert.ok(alpha && alpha.error, 'ENTER: a corrupt destination is still an ERROR on a marked team');
  assert.strictEqual(fs.readFileSync(destFile, 'utf-8'), '{ not json', 'and is never overwritten');
  assert.strictEqual(res.reconciled, 0);
});
