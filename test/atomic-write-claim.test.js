'use strict';
// atomic-write-claim.test.js — fs-util's header claims "All JSON stores route
// through this so a torn write can never truncate a whole store" (F010). Two
// stores had their own write+rename instead: team-manifest's atomicWrite and
// pending-store's park/restore. Same atomic rename, but no fsync of the bytes
// and no fsync of the directory entry — so the claim was true of the code that
// happened to call it, not of the stores.
//
// HOW THIS IS PINNED BEHAVIOURALLY, not by reading source. The observable
// difference between "renamed into place" and "fsynced then renamed into place"
// is the fsync itself, so the test counts fs.fsyncSync calls made during a
// write. A local write+rename produces zero; the audited primitive produces two
// (the file, then the parent dir). No spy on the module under test, no source
// scanning — this fails on the pre-fix code and passes on the fixed code for
// exactly the reason the fix exists.
//
// AND THE OPPOSITE GUARD. pending-store uses renameSync for a second job: the
// drain CLAIM, which is a lock implementing at-most-once delivery, not a write.
// Converting it to a write primitive would turn the claim into a copy and
// deliver every parked message twice. The last test pins the claim's destructive
// half so that conversion cannot pass unnoticed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parkDelivery, drainPending, agentDir } = require('../pending-store');
const { createTeamManifest } = require('../team-manifest');

function tmpRoot(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `clodex-${tag}-`)); }

// Count fsyncs during fn. Patching the real fs module is what makes this an
// end-to-end check: every module here shares that one instance.
function countingFsync(fn) {
  const orig = fs.fsyncSync;
  let calls = 0;
  fs.fsyncSync = function (...args) { calls += 1; return orig.apply(this, args); };
  try { return { result: fn(), calls }; } finally { fs.fsyncSync = orig; }
}

test('parking a message fsyncs the bytes AND the directory entry (F010)', () => {
  const root = tmpRoot('atomic-park');
  const { calls } = countingFsync(() => parkDelivery(root, 'alice', 'hello', '1000.1'));
  assert.ok(calls >= 2, `a park must fsync the file and its dir, saw ${calls}`);
  // The durability change must not have altered what a drain sees.
  assert.deepStrictEqual(drainPending(root, 'alice', 'c1'), ['hello']);
});

test('writing a team manifest fsyncs the bytes AND the directory entry (F010)', () => {
  const home = tmpRoot('atomic-team');
  const projectRoot = tmpRoot('atomic-proj');
  const tm = createTeamManifest({ fs, clodexHome: home });
  const { calls } = countingFsync(() =>
    tm.createTeam({ name: 'shop', root: projectRoot, lead: 'shop' }));
  assert.ok(calls >= 2, `a manifest write must fsync the file and its dir, saw ${calls}`);
  const team = tm.loadManifest('shop');
  assert.ok(team && team.roles && team.roles.lead, 'the manifest is still readable and correct');

  // Mutating it goes through the same write, and the team dir keeps 0700 —
  // atomicWriteFileSync's own mkdir carries no mode, so this would silently
  // widen to the umask default if the ensureDir were dropped.
  // A role createTeam does NOT seed, so this is a real second write.
  const after = countingFsync(() => tm.addRole('shop', 'wire', { brief: 'does things' }));
  assert.ok(after.calls >= 2, `a role mutation must fsync too, saw ${after.calls}`);
  assert.strictEqual(fs.statSync(path.dirname(tm.loadManifest('shop').file)).mode & 0o777, 0o700);
});

test('the drain CLAIM stays a rename, not a write — at-most-once survives (F010)', () => {
  const root = tmpRoot('atomic-claim');
  parkDelivery(root, 'bob', 'once', '1000.1');
  const dir = agentDir(root, 'bob');

  assert.deepStrictEqual(drainPending(root, 'bob', 'c1'), ['once']);
  // DESTRUCTIVE by design: the dir was renamed away, so it is gone. A claim
  // reimplemented as a copy would leave it — and hand the same message to the
  // next drainer.
  assert.ok(!fs.existsSync(dir), 'the claim must MOVE the store, not copy it');
  assert.deepStrictEqual(drainPending(root, 'bob', 'c2'), [], 'no second delivery');
});
