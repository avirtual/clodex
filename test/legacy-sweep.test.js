// Run: node --test
// Covers the one-time legacy flat-file sweep + the log-only orphan pass. The
// discipline under test: the sweep is NAME-DRIVEN — it deletes only
// {knownName}{knownSuffix}, never touches a shared file that structurally looks
// per-agent (wire-shadow.jsonl, codex-session-hook.sh), a shared dir
// (messages/, pending/), or a decoy unknown file. Marker-gated to run once.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runLegacySweep, findOrphans, deriveOwner } = require('../legacy-sweep');
const { legacyPathsFor, runDirFor } = require('../clodex-paths');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-sweep-')); }
const touch = (p, body = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const exists = (p) => fs.existsSync(p);

test('runLegacySweep: deletes a known session\'s flat artifacts, spares shared files/dirs and a decoy', () => {
  const root = tmp();
  // Legacy flat artifacts for a KNOWN session.
  for (const p of legacyPathsFor(root, 'trader')) touch(p);
  // A second known session, partial artifacts.
  touch(path.join(root, 'stocks-hook.sh'));
  touch(path.join(root, 'stocks.jsonl'));
  // Shared files that STRUCTURALLY match per-agent suffixes — must survive.
  touch(path.join(root, 'wire-shadow.jsonl'));       // matches .jsonl
  touch(path.join(root, 'codex-session-hook.sh'));   // matches -hook.sh
  touch(path.join(root, 'clodex.log'));              // matches nothing
  // Shared dirs with per-agent subdirs — must survive untouched.
  touch(path.join(root, 'messages', 'trader', 'msg-1.txt'));
  touch(path.join(root, 'pending', 'trader', 'x.json'));
  // A decoy: a flat file for a name that is NOT a candidate — the name-driven
  // sweep must not reach it (only the orphan pass logs it).
  touch(path.join(root, 'ghost-hook.sh'));

  const res = runLegacySweep({ root, names: ['trader', 'stocks'] });
  assert.strictEqual(res.skipped, false);
  assert.strictEqual(res.swept, legacyPathsFor(root, 'trader').length + 2);

  // Known sessions' flat artifacts gone.
  for (const p of legacyPathsFor(root, 'trader')) assert.ok(!exists(p), `swept: ${p}`);
  assert.ok(!exists(path.join(root, 'stocks-hook.sh')));
  assert.ok(!exists(path.join(root, 'stocks.jsonl')));
  // Shared files survive.
  assert.ok(exists(path.join(root, 'wire-shadow.jsonl')), 'shared wire log spared');
  assert.ok(exists(path.join(root, 'codex-session-hook.sh')), 'shared codex hook spared');
  assert.ok(exists(path.join(root, 'clodex.log')));
  // Shared dirs survive.
  assert.ok(exists(path.join(root, 'messages', 'trader', 'msg-1.txt')), 'messages/ untouched');
  assert.ok(exists(path.join(root, 'pending', 'trader', 'x.json')), 'pending/ untouched');
  // Decoy (non-candidate) survives the sweep.
  assert.ok(exists(path.join(root, 'ghost-hook.sh')), 'non-candidate flat file not swept');
  // Marker written.
  assert.ok(exists(path.join(root, 'run', '.migrated')));
});

test('runLegacySweep: marker-gated — a second run is a no-op', () => {
  const root = tmp();
  touch(path.join(root, 'run', '.migrated'), 'already\n');
  touch(path.join(root, 'a-hook.sh'));
  const res = runLegacySweep({ root, names: ['a'] });
  assert.strictEqual(res.skipped, true);
  assert.strictEqual(res.swept, 0);
  assert.ok(exists(path.join(root, 'a-hook.sh')), 'gated run leaves everything alone');
});

test('runLegacySweep: idempotent artifact set (deletes each once, counts what existed)', () => {
  const root = tmp();
  touch(path.join(root, 'x.jsonl'));   // only one of x's artifacts present
  const res = runLegacySweep({ root, names: ['x'] });
  assert.strictEqual(res.swept, 1);
});

test('deriveOwner: strips the LONGEST matching suffix', () => {
  assert.strictEqual(deriveOwner('foo-hook-output.json'), 'foo');
  assert.strictEqual(deriveOwner('foo.json'), 'foo');
  assert.strictEqual(deriveOwner('foo-ctxwarn.sh'), 'foo');
  assert.strictEqual(deriveOwner('foo-ctxwarn'), 'foo');
  assert.strictEqual(deriveOwner('no-suffix-here.txt'), null);
});

test('findOrphans: flags dead run dirs + stray root files, excludes shared + candidates', () => {
  const candidates = new Set(['trader', 'stocks']);
  const runEntries = ['trader', 'stocks', 'zombie', '.migrated'];
  const rootEntries = [
    'ghost-hook.sh',           // stray, non-candidate → flagged
    'trader.jsonl',            // candidate leftover → NOT flagged (belongs to a known name)
    'wire-shadow.jsonl',       // shared → excluded
    'codex-session-hook.sh',   // shared → excluded
    'messages', 'pending', 'clodex.log', // no per-agent suffix → ignored
  ];
  const { orphanDirs, orphanRootFiles } = findOrphans({ runEntries, rootEntries, candidates });
  assert.deepStrictEqual(orphanDirs, ['zombie']);          // .migrated + candidates excluded
  assert.deepStrictEqual(orphanRootFiles, ['ghost-hook.sh']);
});
