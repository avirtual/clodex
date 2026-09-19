const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { migrateSeatLayout, ensureSeatLink, seatLayoutActive, MARKER } = require('../seat-layout');
const { runDirFor, seatPathFor, legacySeatPathFor, SEAT_KINDS } = require('../clodex-paths');
const { createCliHooks } = require('../cli-hooks');
const { mkTmpRoot } = require('./lib/tmp-roots');

function tmp() { return mkTmpRoot('clodex-seatlayout-'); }

const ROWS = [
  ['messages', 'sessions/ana/messages'],
  ['pending', 'sessions/ana/pending'],
  ['notices', 'sessions/ana/notices'],
  ['promptcache', 'sessions/ana/promptcache'],
  ['memory', 'sessions/ana/memory'],
  ['spill', 'sessions/ana/spill'],
  ['monitors', 'sessions/ana/monitors'],
];

function seedAllEight(root, name) {
  for (const kind of Object.keys(SEAT_KINDS)) {
    const old = legacySeatPathFor(root, name, kind);
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, `${kind}.txt`), `${kind}-body`);
  }
}

test('migration moves the 7 durable kinds and leaves a link at every old spelling', () => {
  const root = tmp();
  seedAllEight(root, 'ana');

  const res = migrateSeatLayout({ root, names: ['ana'], fs });
  assert.strictEqual(res.skipped, false);
  assert.strictEqual(res.migrated, 7);

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
  seedAllEight(root, 'ana');
  assert.ok(fs.existsSync(runDirFor(root, 'ana')), 'ENTER: the fixture must have a run dir to remove');

  migrateSeatLayout({ root, names: ['ana'], fs });

  assert.strictEqual(fs.existsSync(runDirFor(root, 'ana')), false);
  assert.strictEqual(fs.existsSync(path.join(root, 'sessions', 'ana', 'run')), false);
});

test('already-migrated is a no-op: the target dir is not re-moved or re-created', () => {
  const root = tmp();
  seedAllEight(root, 'ana');
  migrateSeatLayout({ root, names: ['ana'], fs });
  fs.rmSync(path.join(root, 'sessions', MARKER));

  const neu = seatPathFor(root, 'ana', 'messages');
  const before = fs.statSync(neu);
  const logged = [];

  const res = migrateSeatLayout({ root, names: ['ana'], fs, log: { info: (t, m) => logged.push(m) } });
  assert.strictEqual(res.migrated, 0);
  assert.deepStrictEqual(
    logged.filter((m) => /not migrated/.test(m)), [],
    'a linked kind must be SKIPPED, not attempted and caught: a rename onto the dir the link '
    + 'already points at fails, so without the skip every re-run logs seven failures it survived',
  );

  const after = fs.statSync(neu);
  assert.strictEqual(after.ino, before.ino);
  assert.strictEqual(after.mtimeMs, before.mtimeMs);
  assert.ok(fs.lstatSync(legacySeatPathFor(root, 'ana', 'messages')).isSymbolicLink());
  assert.ok(seatLayoutActive(root, fs), 'the marker must be present after a skipped-seat run');
});

test('the marker short-circuits migration: an un-migrated seat is left alone', () => {
  const root = tmp();
  seedAllEight(root, 'ana');
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sessions', MARKER), 'x\n');

  const old = legacySeatPathFor(root, 'ana', 'messages');
  assert.ok(fs.lstatSync(old).isDirectory() && !fs.lstatSync(old).isSymbolicLink(),
    'ENTER: the fixture must hold a REAL un-migrated dir, or "untouched" below is a statement '
    + 'about a seat that had nothing to migrate');

  const res = migrateSeatLayout({ root, names: ['ana'], fs });
  assert.deepStrictEqual(res, { migrated: 0, skipped: true });
  assert.ok(fs.lstatSync(old).isDirectory() && !fs.lstatSync(old).isSymbolicLink());
  assert.strictEqual(fs.existsSync(path.join(root, 'sessions', 'ana')), false);
});

test('one failing kind does not cost the seat its other six, and the marker is still written', () => {
  const root = tmp();
  seedAllEight(root, 'ana');
  const logged = [];
  const log = { info: (tag, msg) => logged.push(`${tag}: ${msg}`) };
  const failing = seatPathFor(root, 'ana', 'pending');
  const fsStub = {
    ...fs,
    renameSync(from, to) {
      if (to === failing) throw new Error('EXDEV: simulated cross-device rename');
      return fs.renameSync(from, to);
    },
  };

  const res = migrateSeatLayout({ root, names: ['ana'], fs: fsStub, log });
  assert.strictEqual(res.migrated, 6);

  const old = legacySeatPathFor(root, 'ana', 'pending');
  assert.ok(!fs.lstatSync(old).isSymbolicLink(),
    'the failed kind stays a real dir at its old spelling — the point of continuing past it');
  assert.strictEqual(fs.readFileSync(path.join(old, 'pending.txt'), 'utf8'), 'pending-body',
    'and stays readable there');
  assert.ok(logged.some((l) => /pending/.test(l)), `the failure must be logged: ${logged.join(' | ')}`);
  assert.ok(seatLayoutActive(root, fs), 'the marker is written after the loop, so a partial run is not retried forever');
  assert.ok(fs.lstatSync(legacySeatPathFor(root, 'ana', 'messages')).isSymbolicLink());
});

test('a seat with none of the 8 gets an empty home, not eight pre-minted dirs', () => {
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
