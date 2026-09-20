const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  migrateSeatLayout, ensureSeatLink, seatLayoutActive, readMarker,
  renameSeat, removeSeat,
  MARKER, DEFERRED_KINDS, LEGACY_MARKER_KINDS,
} = require('../seat-layout');
const { runDirFor, seatPathFor, legacySeatPathFor, SEAT_KINDS } = require('../clodex-paths');
const { createCliHooks } = require('../cli-hooks');
const { createMemoryStore } = require('../memory-store');
const { sweepSpilledMessages } = require('../engine');
const { mkTmpRoot } = require('./lib/tmp-roots');

function tmp() { return mkTmpRoot('clodex-seatlayout-'); }

const ROWS = [
  ['messages', 'sessions/ana/messages'],
  ['notices', 'sessions/ana/notices'],
  ['promptcache', 'sessions/ana/promptcache'],
  ['memory', 'sessions/ana/memory'],
  ['spill', 'sessions/ana/spill'],
  ['monitors', 'sessions/ana/monitors'],
];

function seedAllSeven(root, name) {
  for (const kind of Object.keys(SEAT_KINDS)) {
    const old = legacySeatPathFor(root, name, kind);
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, `${kind}.txt`), `${kind}-body`);
  }
}

test('migration moves the 6 durable kinds and leaves a link at every old spelling', () => {
  const root = tmp();
  seedAllSeven(root, 'ana');

  const res = migrateSeatLayout({ root, names: ['ana'], fs });
  assert.strictEqual(res.skipped, false);
  assert.strictEqual(res.migrated, 6);

  for (const [kind, expectedTail] of ROWS) {
    const old = legacySeatPathFor(root, 'ana', kind);
    const neu = path.join(root, ...expectedTail.split('/'));
    assert.ok(fs.lstatSync(old).isSymbolicLink(), `${kind}: old spelling should be a symlink`);
    assert.strictEqual(fs.realpathSync(old), fs.realpathSync(neu), `${kind}: link must resolve to the new dir`);
    assert.strictEqual(fs.readFileSync(path.join(neu, `${kind}.txt`), 'utf8'), `${kind}-body`,
      `${kind}: the seeded body must be readable at the new path`);
    fs.writeFileSync(path.join(old, 'through-old'), 'o');
    assert.strictEqual(fs.readFileSync(path.join(neu, 'through-old'), 'utf8'), 'o',
      `${kind}: a write through the old spelling must land in the real dir — a passthrough, `
      + 'not a name that merely lstats as a symlink');
    fs.writeFileSync(path.join(neu, 'through-new'), 'n');
    assert.strictEqual(fs.readFileSync(path.join(old, 'through-new'), 'utf8'), 'n',
      `${kind}: and back the other way`);
  }
});

test('migration REMOVES run/<name> rather than moving it, and mints no link for it', () => {
  const root = tmp();
  seedAllSeven(root, 'ana');
  assert.ok(fs.existsSync(runDirFor(root, 'ana')), 'ENTER: the fixture must have a run dir to remove');

  migrateSeatLayout({ root, names: ['ana'], fs });

  assert.strictEqual(fs.existsSync(runDirFor(root, 'ana')), false);
  assert.strictEqual(fs.existsSync(path.join(root, 'sessions', 'ana', 'run')), false);
});

test('already-migrated is a no-op: the target dir is not re-moved or re-created', () => {
  const root = tmp();
  seedAllSeven(root, 'ana');
  migrateSeatLayout({ root, names: ['ana'], fs });
  fs.rmSync(path.join(root, 'sessions', MARKER));

  const neu = seatPathFor(root, 'ana', 'notices');
  const before = fs.statSync(neu);
  const logged = [];

  const res = migrateSeatLayout({ root, names: ['ana'], fs, log: { info: (t, m) => logged.push(m) } });
  assert.strictEqual(res.migrated, 0);
  assert.deepStrictEqual(
    logged.filter((m) => /not migrated/.test(m)), [],
    'a linked kind must be SKIPPED, not attempted and caught: a rename onto the dir the link '
    + 'already points at fails, so without the skip every re-run logs a failure it survived',
  );

  const after = fs.statSync(neu);
  assert.strictEqual(after.ino, before.ino);
  assert.strictEqual(after.mtimeMs, before.mtimeMs);
  assert.ok(fs.lstatSync(legacySeatPathFor(root, 'ana', 'notices')).isSymbolicLink());
  assert.ok(seatLayoutActive(root, fs), 'the marker must be present after a skipped-seat run');
});

test('a fully stamped marker short-circuits migration: an un-migrated seat is left alone', () => {
  const root = tmp();
  seedAllSeven(root, 'ana');
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  const kinds = {};
  for (const kind of Object.keys(SEAT_KINDS)) kinds[kind] = '2026-09-20T00:27:51.133Z';
  fs.writeFileSync(path.join(root, 'sessions', MARKER), `${JSON.stringify({ kinds })}\n`);

  const old = legacySeatPathFor(root, 'ana', 'notices');
  assert.ok(fs.lstatSync(old).isDirectory() && !fs.lstatSync(old).isSymbolicLink(),
    'ENTER: the fixture must hold a REAL un-migrated dir, or "untouched" below is a statement '
    + 'about a seat that had nothing to migrate');

  const res = migrateSeatLayout({ root, names: ['ana'], fs });
  assert.deepStrictEqual(res, { migrated: 0, skipped: true });
  assert.ok(fs.lstatSync(old).isDirectory() && !fs.lstatSync(old).isSymbolicLink());
  assert.strictEqual(fs.existsSync(path.join(root, 'sessions', 'ana')), false);
});

test('one failing kind does not cost the seat its other five, and the kind is STILL stamped', () => {
  const root = tmp();
  seedAllSeven(root, 'ana');
  const logged = [];
  const log = { info: (tag, msg) => logged.push(`${tag}: ${msg}`) };
  const failing = seatPathFor(root, 'ana', 'notices');
  const fsStub = {
    ...fs,
    renameSync(from, to) {
      if (to === failing) throw new Error('EXDEV: simulated cross-device rename');
      return fs.renameSync(from, to);
    },
  };

  const res = migrateSeatLayout({ root, names: ['ana'], fs: fsStub, log });
  assert.strictEqual(res.migrated, 5);

  const old = legacySeatPathFor(root, 'ana', 'notices');
  assert.ok(!fs.lstatSync(old).isSymbolicLink(),
    'the failed kind stays a real dir at its old spelling — the point of continuing past it');
  assert.strictEqual(fs.readFileSync(path.join(old, 'notices.txt'), 'utf8'), 'notices-body',
    'and stays readable there');
  assert.ok(logged.some((l) => /notices/.test(l)), `the failure must be logged: ${logged.join(' | ')}`);
  assert.ok(readMarker(root, fs).kinds.notices,
    'the kind is stamped even though one seat threw inside its loop: L-A\'s posture is that a '
    + 'per-seat failure is logged and left readable at the old spelling, not retried at every '
    + 'launch forever — a kind that re-runs on a box with one bad seat never finishes');
  assert.ok(fs.lstatSync(legacySeatPathFor(root, 'ana', 'spill')).isSymbolicLink());
});

test('a seat with none of the 7 gets an empty home, not seven pre-minted dirs', () => {
  const root = tmp();
  const res = migrateSeatLayout({ root, names: ['ghost'], fs });
  assert.strictEqual(res.migrated, 0);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'sessions', 'ghost')), []);
  for (const kind of Object.keys(SEAT_KINDS)) {
    assert.strictEqual(fs.existsSync(legacySeatPathFor(root, 'ghost', kind)), false, kind);
  }
});

test('socket budget: run/<seat>/agent.sock is the shorter path, by exactly 9 bytes', () => {
  const why = 'WHY runDirFor stays the bind path: a socket binds by its path STRING against a '
    + '104-byte sun_path, and sessions/<seat>/run/ spends 9 more of them than run/<seat>/';
  const root = `/Users/${'u'.repeat(32)}/.clodex`;
  const name = 'n'.repeat(64);
  const legacy = path.join(runDirFor(root, name), 'agent.sock');
  const seat = path.join(seatPathFor(root, name, 'run'), 'agent.sock');
  assert.strictEqual(legacy.length, 127, why);
  assert.strictEqual(seat.length, 136, why);
  assert.strictEqual(seat.length - legacy.length, 9, why);
});

test('memory-store.agents() survives the re-embed-loop guard: a migrated seat is still listed', () => {
  const why = 'agents() filters readdir Dirents, and isDirectory() is FALSE for a symlink. It is '
    + 'the ONLY caller feeding engine liveKeys, and hint-embed flush DELETES every vector key '
    + 'outside that set — an empty list here prunes the whole cache and re-embeds it on the next '
    + 'backfill, forever. That is the measured pathology hint-embed says it already fixed once';
  const root = tmp();
  const store = createMemoryStore(path.join(root, 'library', 'memory'));
  store.remember('ana', { scope: 'proj', text: 'The seat layout moved.' });
  assert.deepStrictEqual(store.agents(), ['ana'], 'ENTER: the store must list the seat BEFORE migration');

  migrateSeatLayout({ root, names: ['ana'], fs });

  assert.ok(fs.lstatSync(legacySeatPathFor(root, 'ana', 'memory')).isSymbolicLink(),
    'ENTER: memory must actually have MOVED, or this subject is about an ordinary directory');
  assert.deepStrictEqual(store.agents(), ['ana'], why);
  assert.strictEqual(store.list('ana').length, 1, 'and the units are still readable through the link');

  fs.symlinkSync(seatPathFor(root, 'ana', 'memory'), path.join(root, 'library', 'memory', 'thief'));
  assert.deepStrictEqual(store.agents(), ['ana'],
    'a link aimed at a SIBLING seat is not an agent: agents() takes a symlink only at its own seat '
    + 'spelling, the same rule the message sweep and the memory viewer enforce');
});

test('the spill sweep keeps the migrated messages link AND keeps collecting through it', () => {
  const why = 'sweepSpilledMessages tests Dirents with isDirectory(), FALSE for a symlink, and its '
    + 'else-branch statSync FOLLOWS the link to a dir whose mtime is almost always past MSG_MAX_AGE '
    + '— so an unrepaired sweep unlinkSyncs the SPELLING every 5 minutes, stranding the migrated '
    + 'files and dangling every spill pointer already delivered to a seat';
  const root = tmp();
  const msgDir = path.join(root, 'messages');
  const pendingDir = path.join(root, 'pending');
  fs.mkdirSync(path.join(msgDir, 'ana'), { recursive: true });
  fs.mkdirSync(pendingDir, { recursive: true });
  const body = path.join(msgDir, 'ana', 'msg-55910-39.txt');
  fs.writeFileSync(body, 'From: bob\n\nbody');
  const now = 1_800_000_000_000;
  const stale = (now - 1860 * 1000) / 1000;
  fs.utimesSync(body, stale, stale);
  fs.utimesSync(path.join(msgDir, 'ana'), stale, stale);

  migrateSeatLayout({ root, names: ['ana'], fs });
  assert.ok(fs.lstatSync(path.join(msgDir, 'ana')).isSymbolicLink(),
    'ENTER: messages must have MOVED, or the sweep below never meets a symlink at all');

  sweepSpilledMessages(msgDir, pendingDir, 1800, now);

  assert.ok(fs.lstatSync(path.join(msgDir, 'ana')).isSymbolicLink(), why);
  assert.strictEqual(fs.existsSync(body), false,
    'and the sweep still collects the stale body it exists to collect: taking the symlink down the '
    + 'DIRECTORY branch is what keeps the per-seat GC on for a migrated seat');

  const fresh = path.join(msgDir, 'ana', 'msg-55910-40.txt');
  fs.writeFileSync(fresh, 'From: bob\n\nfresh');
  assert.strictEqual(
    fs.readFileSync(path.join(seatPathFor(root, 'ana', 'messages'), 'msg-55910-40.txt'), 'utf8'),
    'From: bob\n\nfresh',
    'a write through the OLD spelling still lands in sessions/<n>/messages — the whole point of '
    + 'keeping the link alive rather than letting the sweep replace it with a fresh real dir');
});

test('the sweep descends a seat link only: a planted link out of the root keeps its files', () => {
  const why = 'the sweep DELETES, so "symlink whose target is a directory" is too wide a door: any '
    + 'seat with a shell can write messages/<x> -> ~/Desktop, and a bare statIsDir would have the '
    + '5-minute timer unlink every file directly inside it, permanently and silently. Only the '
    + 'migrated seat spelling earns the directory branch; anything else falls to the unlink '
    + 'else-branch, whose blast radius is the LINK NAME (unlink does not follow)';
  const root = tmp();
  const outside = mkTmpRoot('clodex-seatlayout-outside-');
  const msgDir = path.join(root, 'messages');
  const pendingDir = path.join(root, 'pending');
  fs.mkdirSync(path.join(msgDir, 'ana'), { recursive: true });
  fs.mkdirSync(pendingDir, { recursive: true });
  const now = 1_800_000_000_000;
  const stale = (now - 1860 * 1000) / 1000;
  const seatBody = path.join(msgDir, 'ana', 'msg-55910-41.txt');
  fs.writeFileSync(seatBody, 'From: bob\n\nseat');
  fs.utimesSync(seatBody, stale, stale);
  const loot = path.join(outside, 'private.txt');
  fs.writeFileSync(loot, 'not a message');
  fs.utimesSync(loot, stale, stale);

  migrateSeatLayout({ root, names: ['ana'], fs });
  fs.symlinkSync(outside, path.join(msgDir, 'evil'));

  sweepSpilledMessages(msgDir, pendingDir, 1800, now);

  assert.strictEqual(fs.readFileSync(loot, 'utf8'), 'not a message', why);
  assert.strictEqual(fs.existsSync(seatBody), false,
    'CONTROL: the migrated seat link is still collected through, so the refusal above is about '
    + 'containment and not about the sweep having stopped following links at all');
});

test('pending is NOT a seat kind: it stays at the shared root permanently', () => {
  const why = 'pending/<seat> is a transient delivery QUEUE, not seat state. Two independent '
    + 'claimers — drainPending and the byte-pinned pending.sh hook body — both claim by '
    + 'renameSync(dir, claim) then rm the claim, which on a symlink moves and deletes the LINK and '
    + 'orphans the target. One of the two is bash inside a byte-pinned hook, so it cannot be taught '
    + 'to claim through the link without breaking the pin. It never moves; a move-to-peer drains it';
  assert.strictEqual(Object.prototype.hasOwnProperty.call(SEAT_KINDS, 'pending'), false, why);
  assert.throws(() => seatPathFor('/root/.clodex', 'ana', 'pending'), /unknown seat kind 'pending'/, why);
  assert.throws(() => legacySeatPathFor('/root/.clodex', 'ana', 'pending'), /unknown seat kind 'pending'/, why);
});

test('a legacy TIMESTAMP marker is read as the 5 kinds L-A had moved, and the rest then migrate', () => {
  const why = 'every box that ran L-A holds a marker whose whole content is one ISO timestamp. '
    + 'Read as "nothing is stamped" it would re-run the moved kinds; read as "everything is '
    + 'stamped" memory and messages would never move on any box that already launched';
  const root = tmp();
  seedAllSeven(root, 'ana');
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sessions', MARKER), '2026-09-20T00:27:51.133Z\n');

  const rec = readMarker(root, fs);
  assert.deepStrictEqual(Object.keys(rec.kinds).sort(), [...LEGACY_MARKER_KINDS].sort(), why);
  for (const kind of LEGACY_MARKER_KINDS) {
    assert.strictEqual(rec.kinds[kind], '2026-09-20T00:27:51.133Z', why);
  }

  const res = migrateSeatLayout({ root, names: ['ana'], fs });
  assert.strictEqual(res.skipped, false, why);
  assert.strictEqual(res.migrated, 2, 'exactly memory and messages move — the other 5 are stamped');
  for (const kind of ['memory', 'messages']) {
    assert.ok(fs.lstatSync(legacySeatPathFor(root, 'ana', kind)).isSymbolicLink(), kind);
  }
  const after = readMarker(root, fs);
  assert.deepStrictEqual(Object.keys(after.kinds).sort(), Object.keys(SEAT_KINDS).sort(),
    'and the marker is rewritten in the per-kind shape, all 7 stamped');
  assert.strictEqual(after.kinds.notices, '2026-09-20T00:27:51.133Z',
    'a kind carried over from the legacy marker keeps ITS timestamp, not this run\'s');
});

test('a kind already stamped is never revisited, even with a real legacy dir sitting there', () => {
  const why = 'the stamp is the whole retry policy: a kind whose loop already ran is not re-run, '
    + 'so a dir a seat re-created at its old spelling afterwards is left alone rather than '
    + 'silently swallowed by a second migration nobody asked for';
  const root = tmp();
  seedAllSeven(root, 'ana');
  migrateSeatLayout({ root, names: ['ana'], fs });
  fs.rmSync(legacySeatPathFor(root, 'ana', 'notices'));
  fs.mkdirSync(legacySeatPathFor(root, 'ana', 'notices'), { recursive: true });
  fs.writeFileSync(path.join(legacySeatPathFor(root, 'ana', 'notices'), 'later.txt'), 'later');
  const old = legacySeatPathFor(root, 'ana', 'notices');
  assert.ok(fs.lstatSync(old).isDirectory() && !fs.lstatSync(old).isSymbolicLink(),
    'ENTER: the legacy path must be a REAL dir again, or "left alone" is a statement about a link');

  const res = migrateSeatLayout({ root, names: ['ana'], fs });

  assert.deepStrictEqual(res, { migrated: 0, skipped: true }, why);
  assert.ok(fs.lstatSync(old).isDirectory() && !fs.lstatSync(old).isSymbolicLink(), why);
  assert.strictEqual(fs.readFileSync(path.join(old, 'later.txt'), 'utf8'), 'later', why);
});

test('an unreadable or corrupt marker is treated as ABSENT, and the re-run is idempotent', () => {
  const why = 'a marker we cannot parse tells us nothing about what moved. Migrating again is safe '
    + '— every kind skips a legacy path that is already a symlink — while trusting the corrupt '
    + 'file would strand whatever it failed to record';
  const root = tmp();
  seedAllSeven(root, 'ana');
  migrateSeatLayout({ root, names: ['ana'], fs });
  const inode = fs.statSync(seatPathFor(root, 'ana', 'notices')).ino;
  fs.writeFileSync(path.join(root, 'sessions', MARKER), '{not json at all');

  assert.deepStrictEqual(readMarker(root, fs), { kinds: {} }, why);

  const logged = [];
  const res = migrateSeatLayout({ root, names: ['ana'], fs, log: { info: (t, m) => logged.push(m) } });

  assert.strictEqual(res.skipped, false, why);
  assert.strictEqual(res.migrated, 0, 'nothing moves twice: the symlink-skip carries the idempotence');
  assert.deepStrictEqual(logged.filter((m) => /not migrated/.test(m)), [],
    'and nothing is attempted-and-caught either');
  assert.strictEqual(fs.statSync(seatPathFor(root, 'ana', 'notices')).ino, inode, why);
  assert.deepStrictEqual(Object.keys(readMarker(root, fs).kinds).sort(), Object.keys(SEAT_KINDS).sort(),
    'and the marker is rewritten in the good shape, so the next launch is a clean skip');
});

test('DEFERRED_KINDS is empty: every kind that stayed a seat kind now has a link-aware reader', () => {
  assert.deepStrictEqual([...DEFERRED_KINDS], [],
    'the constant is kept, empty, as the place a future kind is parked. The membership criterion '
    + 'is in docs/notes/seat-layout.md: a kind belongs here while any operator over its shared '
    + 'parent refuses or destroys a symlink, and ensureSeatLink must keep honouring it');
  const root = tmp();
  migrateSeatLayout({ root, names: [], fs });
  for (const kind of Object.keys(SEAT_KINDS)) {
    assert.strictEqual(ensureSeatLink({ root, name: 'bo', kind, fs }), true, kind);
  }
});

test('ensureSeatLink mints the link when the legacy path is absent', () => {
  const root = tmp();
  migrateSeatLayout({ root, names: [], fs });

  assert.strictEqual(ensureSeatLink({ root, name: 'bo', kind: 'run', fs }), true);
  const old = runDirFor(root, 'bo');
  assert.ok(fs.lstatSync(old).isSymbolicLink());
  assert.strictEqual(fs.realpathSync(old), fs.realpathSync(seatPathFor(root, 'bo', 'run')));
  assert.strictEqual(ensureSeatLink({ root, name: 'bo', kind: 'run', fs }), true,
    'idempotent: a second call over the link it just made changes nothing');
  assert.ok(fs.lstatSync(old).isSymbolicLink());
});

test('ensureSeatLink re-creates the TARGET of a link that survived its dir', () => {
  const root = tmp();
  migrateSeatLayout({ root, names: [], fs });
  ensureSeatLink({ root, name: 'bo', kind: 'run', fs });
  fs.rmSync(seatPathFor(root, 'bo', 'run'), { recursive: true, force: true });
  assert.throws(() => fs.statSync(runDirFor(root, 'bo')), /ENOENT/,
    'ENTER: the link must be DANGLING here, or the repair below is about a healthy one');

  assert.strictEqual(ensureSeatLink({ root, name: 'bo', kind: 'run', fs }), true);

  assert.ok(fs.statSync(runDirFor(root, 'bo')).isDirectory(),
    'the link alone is not enough: cleanup drops the real dir at every exit and the next spawn '
    + 'writes THROUGH the surviving link, so the target has to be re-made or every hook write ENOENTs');
});

test('ensureSeatLink leaves a REAL legacy dir alone rather than replacing it', () => {
  const why = 'a seat created while the marker was absent, or a foreign dir: clobbering it would '
    + 'destroy state nothing has copied yet';
  const root = tmp();
  migrateSeatLayout({ root, names: [], fs });
  const old = runDirFor(root, 'bo');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'keep'), 'k');

  assert.strictEqual(ensureSeatLink({ root, name: 'bo', kind: 'run', fs }), false, why);
  assert.ok(!fs.lstatSync(old).isSymbolicLink(), why);
  assert.strictEqual(fs.readFileSync(path.join(old, 'keep'), 'utf8'), 'k', why);
  assert.strictEqual(fs.existsSync(seatPathFor(root, 'bo', 'run')), false,
    'and it mints no empty sessions/<n>/run either: the bail comes before both mkdirs, or every '
    + 'exempt seat leaves an unused dir nothing ever writes to');
});

test('ensureSeatLink is inert before the marker exists', () => {
  const root = tmp();
  assert.strictEqual(ensureSeatLink({ root, name: 'bo', kind: 'run', fs }), false);
  assert.strictEqual(fs.existsSync(path.join(root, 'sessions')), false);
  assert.strictEqual(fs.existsSync(runDirFor(root, 'bo')), false);
});

test('cleanupClaudeHook through the link leaves neither path, and keeps the seat home', () => {
  const why = 'a cleanup naming only the old spelling unlinks it and strands the real run dir '
    + 'under sessions/<seat>/ forever — nothing else ever looks there';
  const root = tmp();
  migrateSeatLayout({ root, names: [], fs });
  const hooks = createCliHooks({
    REGISTRY_DIR: root,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });

  hooks.setupClaudeHook('bo');
  const old = runDirFor(root, 'bo');
  const real = seatPathFor(root, 'bo', 'run');
  assert.ok(fs.lstatSync(old).isSymbolicLink(),
    'ENTER: setup must mint the run link before writing, or the cleanup below is a statement '
    + 'about an ordinary directory');
  assert.ok(fs.existsSync(path.join(real, 'hook.sh')), 'the hook bytes must land in the REAL dir');

  hooks.cleanupClaudeHook('bo');

  assert.strictEqual(fs.existsSync(real), false, why);
  assert.throws(() => fs.lstatSync(old), /ENOENT/, 'the link must be gone too');
  assert.ok(fs.statSync(path.join(root, 'sessions', 'bo')).isDirectory(), 'the seat home survives exit');
});

const ALL_KINDS = Object.keys(SEAT_KINDS);

function migratedSeat(root, name) {
  seedAllSeven(root, name);
  migrateSeatLayout({ root, names: [name], fs });
}

test('renameSeat moves the one home and re-mints every legacy link at the NEW name', () => {
  const why = 'the L-B1 readers accept a legacy symlink ONLY when it resolves to sessions/<same '
    + 'name>/<kind>. A rename that moved the LINKS instead would leave library/memory/<new> '
    + 'pointing at sessions/<old>/memory, which every reader refuses and the sweep unlinks';
  const root = tmp();
  migratedSeat(root, 'ana');
  assert.ok(fs.lstatSync(legacySeatPathFor(root, 'ana', 'memory')).isSymbolicLink(),
    'ENTER: the fixture must be migrated, or this subject is about plain dirs');

  const res = renameSeat({ root, oldName: 'ana', newName: 'bea', fs });
  assert.deepStrictEqual(res.failed, [], 'no kind failed');

  assert.ok(fs.existsSync(path.join(root, 'sessions', 'bea')), 'sessions/<new> exists');
  assert.strictEqual(fs.existsSync(path.join(root, 'sessions', 'ana')), false, 'sessions/<old> is gone');

  for (const kind of ALL_KINDS) {
    assert.strictEqual(exists(legacySeatPathFor(root, 'ana', kind)), false,
      `${kind}: nothing is left at the OLD legacy spelling`);
  }
  for (const [kind] of ROWS) {
    const link = legacySeatPathFor(root, 'bea', kind);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${kind}: the NEW legacy spelling is a symlink`);
    assert.strictEqual(fs.realpathSync(link), fs.realpathSync(seatPathFor(root, 'bea', kind)),
      `${kind}: and it resolves to the renamed seat's own dir — ${why}`);
    assert.strictEqual(fs.readFileSync(path.join(link, `${kind}.txt`), 'utf8'), `${kind}-body`,
      `${kind}: the seeded body travelled with the home`);
  }
  assert.strictEqual(exists(legacySeatPathFor(root, 'bea', 'run')), false,
    'run/<new> is NOT re-minted here: ensureSeatLink mints it at the next spawn, and a link to a '
    + 'dir cleanup drops at every exit would dangle until then');
});

function exists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

test('the L-B1 readers accept the seat at its NEW name after renameSeat', () => {
  const why = 'this is the whole point of re-minting the links: memory-store.agents() and the '
    + 'memory viewer both take a legacy symlink only at its own seat spelling';
  const root = tmp();
  const store = createMemoryStore(path.join(root, 'library', 'memory'));
  store.remember('ana', { scope: 'proj', text: 'The seat layout moved.' });
  migrateSeatLayout({ root, names: ['ana'], fs });
  assert.deepStrictEqual(store.agents(), ['ana'], 'ENTER: listed under the old name before the rename');

  renameSeat({ root, oldName: 'ana', newName: 'bea', fs });

  assert.deepStrictEqual(store.agents(), ['bea'], why);
  assert.strictEqual(store.list('bea').length, 1, 'and the units are readable through the new link');

  fs.symlinkSync(seatPathFor(root, 'bea', 'memory'), path.join(root, 'library', 'memory', 'thief'));
  assert.deepStrictEqual(store.agents(), ['bea'],
    'the sibling refusal still holds after a rename: a link aimed at ANOTHER seat is not an agent');
});

test('renameSeat moves an UNMIGRATED kind as a real dir and mints no link for it', () => {
  const why = 'a seat created while the marker lacked that kind holds a real dir at the legacy '
    + 'spelling. Today rename MOVES it; replacing that with a link would strand the contents';
  const root = tmp();
  fs.mkdirSync(path.join(root, 'sessions', 'ana'), { recursive: true });
  const oldNotices = legacySeatPathFor(root, 'ana', 'notices');
  fs.mkdirSync(oldNotices, { recursive: true });
  fs.writeFileSync(path.join(oldNotices, 'queue.jsonl'), 'a line\n');
  assert.ok(!fs.lstatSync(oldNotices).isSymbolicLink(), 'ENTER: the fixture kind is a REAL dir, not a link');

  const res = renameSeat({ root, oldName: 'ana', newName: 'bea', fs });

  const newNotices = legacySeatPathFor(root, 'bea', 'notices');
  assert.ok(fs.lstatSync(newNotices).isDirectory() && !fs.lstatSync(newNotices).isSymbolicLink(),
    `notices/<new> is still a REAL dir — ${why}`);
  assert.strictEqual(fs.readFileSync(path.join(newNotices, 'queue.jsonl'), 'utf8'), 'a line\n',
    'and it carries the old contents');
  assert.ok(res.moved.includes('notices'), `moved names it (got ${JSON.stringify(res.moved)})`);
  assert.ok(!res.relinked.includes('notices'), 'and it is not in relinked — there is nothing to link to');
});

test('renameSeat throws when sessions/<new> already exists, and moves nothing', () => {
  const root = tmp();
  migratedSeat(root, 'ana');
  fs.mkdirSync(path.join(root, 'sessions', 'bea'), { recursive: true });

  assert.throws(() => renameSeat({ root, oldName: 'ana', newName: 'bea', fs }), /already exists/);

  assert.ok(fs.existsSync(path.join(root, 'sessions', 'ana')),
    'ENTER-and-assert: the old home still stands — the refusal came before the renameSync');
  assert.ok(fs.lstatSync(legacySeatPathFor(root, 'ana', 'memory')).isSymbolicLink(),
    'and the old links are untouched');
});

test('renameSeat refuses a name outside the seat-name rule', () => {
  const root = tmp();
  migratedSeat(root, 'ana');
  assert.throws(() => renameSeat({ root, oldName: 'ana', newName: '../escape', fs }), /refusing seat name/);
  assert.throws(() => renameSeat({ root, oldName: 'ana', newName: '..', fs }), /refusing seat name/);
});

test('removeSeat takes the home AND every legacy spelling, and leaves pending/ alone', () => {
  const why = 'Delete Session… is the one true delete. Today it removes run/ only, and the '
    + 'messages/promptcache/notices/memory left behind are exactly what the "already owns … a '
    + 'leftover from an earlier seat" refusal on rename exists to catch';
  const root = tmp();
  migratedSeat(root, 'ana');
  const pending = path.join(root, 'pending', 'ana');
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, 'dm-1.json'), '{}');
  assert.ok(fs.existsSync(path.join(pending, 'dm-1.json')), 'ENTER: pending/<name> is seeded before the delete');

  removeSeat({ root, name: 'ana', fs });

  assert.strictEqual(fs.existsSync(path.join(root, 'sessions', 'ana')), false, 'the home is gone');
  for (const kind of ALL_KINDS) {
    assert.strictEqual(exists(legacySeatPathFor(root, 'ana', kind)), false,
      `${kind}: the legacy spelling is gone too — ${why}`);
  }
  assert.strictEqual(fs.readFileSync(path.join(pending, 'dm-1.json'), 'utf8'), '{}',
    'pending/<name> is NOT a seat kind and survives: the hook body drains it at the shared root');
});

test('removeSeat removes a legacy path that is still a REAL dir', () => {
  const why = 'an unmigrated seat keeps everything at the legacy spellings; unlinking only '
    + 'symlinks would leak the whole seat on the boxes that need the delete most';
  const root = tmp();
  seedAllSeven(root, 'ana');
  assert.ok(!fs.lstatSync(legacySeatPathFor(root, 'ana', 'messages')).isSymbolicLink(),
    'ENTER: the fixture is UNmigrated — every legacy path is a real dir');

  removeSeat({ root, name: 'ana', fs });

  for (const kind of ALL_KINDS) {
    assert.strictEqual(exists(legacySeatPathFor(root, 'ana', kind)), false, `${kind}: removed — ${why}`);
  }
});
