'use strict';
// wire-shadow-retention.test.js — t187. ~/.clodex/wire-shadow.jsonl was
// append-only with no cap, no rotation and no retention; the operator found it
// at 61MB. Retention is now split by record TYPE, so the failure this file
// exists to catch is not "the file didn't shrink" — it is "it shrank by
// deleting the wrong half".
//
// Every case below therefore asserts the SURVIVORS AND THE CASUALTIES by
// identity, never by size or count alone. A retention bug that keeps the newest
// 14 days of the wrong lane, or that silently drops diagnostics while trimming
// bulk, passes any "the file got smaller" assertion and fails these.
//
// Records are driven through the real append path across a simulated day
// boundary (an injected clock), not synthesised directly into the file, so the
// classification the app uses at write time is the one under test.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ShadowLog, isBulkType, BULK_TYPES, BULK_MAX_AGE_MS, BULK_MAX_BYTES, DIAG_MAX_BYTES,
  CHECK_INTERVAL_MS,
} = require('../wire/shadow-log');

const DAY = 24 * 60 * 60 * 1000;

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-ret-'));
  let clock = Date.parse('2026-08-15T12:00:00Z');
  const log = new ShadowLog({ fs, path, dir, now: () => clock });
  return {
    dir, log,
    at(ms) { clock = ms; },
    advance(ms) { clock += ms; },
    now() { return clock; },
    // Synchronous append: the hot path is fs.appendFile (callback), so a read
    // straight after would race. Tests drive the same classification through a
    // sync write so ordering is deterministic.
    write(rec, ts) {
      const payload = { ts: ts ?? clock, ...rec };
      const file = isBulkType(payload.type) ? log.bulkPath() : log.diagPath();
      fs.appendFileSync(file, JSON.stringify(payload) + '\n');
    },
    read(file) {
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    bulk() { return this.read(log.bulkPath()); },
    diag() { return this.read(log.diagPath()); },
  };
}

const ids = (recs) => recs.map((r) => r.id);
const types = (recs) => [...new Set(recs.map((r) => r.type))].sort();

test('t187: the four measured bulk types are exactly the aged lane, everything else is kept', () => {
  assert.deepStrictEqual([...BULK_TYPES].sort(), [
    'autocompact-suppressed', 'wire-hold', 'wire-telemetry-diff', 'wire-turn',
  ], 'the bulk allow-list is the four types the 61MB measurement found; adding one is a decision to delete it after 14 days');

  // The direction that matters: an unknown/new type must NOT be treated as bulk.
  for (const unknown of ['wire-error', 'intent-drop', 'sighting', 'some-type-invented-next-year', undefined, null, '']) {
    assert.strictEqual(isBulkType(unknown), false,
      `unknown type ${String(unknown)} must default to diagnostic — misclassifying a rare type as bulk deletes the evidence the log exists for`);
  }
});

test('t187: across the 14-day boundary, old bulk dies and old diagnostics live', async () => {
  const r = rig();
  const t0 = r.now();

  // Old: 20 days back — outside the bulk window on both lanes.
  r.write({ type: 'wire-turn', id: 'old-bulk' }, t0 - 20 * DAY);
  r.write({ type: 'wire-telemetry-diff', id: 'old-bulk-2' }, t0 - 20 * DAY);
  r.write({ type: 'wire-error', id: 'old-diag' }, t0 - 20 * DAY);
  r.write({ type: 'intent-drop', id: 'old-diag-2' }, t0 - 400 * DAY); // >1yr
  // Fresh: 2 days back — inside the window.
  r.write({ type: 'wire-hold', id: 'new-bulk' }, t0 - 2 * DAY);
  r.write({ type: 'unmatched', id: 'new-diag' }, t0 - 2 * DAY);

  await r.log.rotate();

  assert.deepStrictEqual(ids(r.bulk()), ['new-bulk'],
    'the aged bulk records are gone and the in-window one survived');
  assert.deepStrictEqual(ids(r.diag()).sort(), ['new-diag', 'old-diag', 'old-diag-2'],
    'NO diagnostic was dropped — not the 20-day-old one, not the 400-day-old one');
});

test('t187: a record exactly at the boundary is kept; one just past it is dropped', async () => {
  const r = rig();
  const t0 = r.now();
  // Written oldest-first, as append() produces them: the cheap head probe reads
  // the FIRST record to decide whether the file needs work at all, so a fixture
  // in reverse order would skip the compaction and pass this test vacuously.
  r.write({ type: 'wire-turn', id: 'just-outside' }, t0 - BULK_MAX_AGE_MS - 1000);
  r.write({ type: 'wire-turn', id: 'on-the-line' }, t0 - BULK_MAX_AGE_MS);
  r.write({ type: 'wire-turn', id: 'just-inside' }, t0 - BULK_MAX_AGE_MS + 1000);

  const report = await r.log.rotate();

  assert.ok(report.bulk && report.bulk.dropped === 1,
    'ENTER: the compaction actually ran and dropped exactly one record, so the survivor list below is a real result');
  assert.deepStrictEqual(ids(r.bulk()), ['on-the-line', 'just-inside'],
    'the cutoff is exclusive at the boundary — only strictly-older records go');
});

test('t187: a fresh record at the head only DELAYS compaction, never corrupts it', async () => {
  // The head probe assumes append-order by ts. If that assumption were ever
  // violated the danger would be a wrong compaction; this pins that the failure
  // mode is instead a deferred one, and that the filter still judges per-record.
  const r = rig();
  const t0 = r.now();
  const bulkPath = r.log.bulkPath();
  fs.writeFileSync(bulkPath, [
    JSON.stringify({ ts: t0, type: 'wire-turn', id: 'fresh-at-head' }),
    JSON.stringify({ ts: t0 - 30 * DAY, type: 'wire-turn', id: 'stale-behind' }),
  ].join('\n') + '\n');

  assert.strictEqual(await r.log.rotate().then((x) => x.bulk), null,
    'the probe saw a fresh head and skipped the file — no rewrite');
  assert.deepStrictEqual(ids(r.bulk()), ['fresh-at-head', 'stale-behind'],
    'and crucially nothing was dropped: a skipped check costs disk, never data');

  // Once the head itself expires, the deferred work happens and is correct.
  r.advance(BULK_MAX_AGE_MS + DAY);
  await r.log.rotate();
  assert.deepStrictEqual(ids(r.bulk()), [], 'both records are now genuinely out of window');
});

test('t187: the legacy mixed file is MIGRATED, not truncated — diagnostics move out', async () => {
  // The one file that exists in the wild today: 43 days of both lanes mixed
  // together. The first compaction after an upgrade is also the migration, so
  // its rare records must land in the diag lane rather than being aged out
  // along with the bulk they were interleaved with.
  const r = rig();
  const t0 = r.now();
  const bulkPath = r.log.bulkPath();
  const lines = [];
  for (let day = 43; day >= 0; day--) {
    const ts = t0 - day * DAY;
    lines.push(JSON.stringify({ ts, type: 'wire-turn', id: `turn-d${day}` }));
    lines.push(JSON.stringify({ ts, type: 'wire-telemetry-diff', id: `diff-d${day}` }));
    if (day % 7 === 0) lines.push(JSON.stringify({ ts, type: 'wire-error', id: `err-d${day}` }));
  }
  fs.writeFileSync(bulkPath, lines.join('\n') + '\n');

  await r.log.rotate();

  const diag = r.diag();
  assert.deepStrictEqual(ids(diag).sort(), ['err-d0', 'err-d14', 'err-d21', 'err-d28', 'err-d35', 'err-d42', 'err-d7'].sort(),
    'every wire-error from all 43 days was moved into the diag lane, including the 42-day-old one');
  assert.deepStrictEqual(types(diag), ['wire-error'], 'ENTER: the diag lane received only diagnostics, so the assertion above is about the split and not a copy of everything');

  const bulk = r.bulk();
  assert.deepStrictEqual(types(bulk), ['wire-telemetry-diff', 'wire-turn'],
    'the bulk lane kept only bulk types — the diagnostics were moved, not duplicated');
  const days = bulk.map((rec) => Number(rec.id.split('-d')[1]));
  assert.strictEqual(Math.max(...days), 14, 'nothing older than 14 days survived in the bulk lane');
  assert.strictEqual(Math.min(...days), 0, 'and today\'s records are still there');
  assert.strictEqual(bulk.length, 30, 'days 0..14 inclusive, two bulk records each');
});

test('t187: undatable records are kept, never aged out on a guess', async () => {
  const r = rig();
  const t0 = r.now();
  const bulkPath = r.log.bulkPath();
  fs.writeFileSync(bulkPath, [
    JSON.stringify({ ts: t0 - 30 * DAY, type: 'wire-turn', id: 'aged' }),
    JSON.stringify({ type: 'wire-turn', id: 'no-ts' }),              // ts absent
    JSON.stringify({ ts: 'yesterday', type: 'wire-turn', id: 'bad-ts' }), // ts unparseable
    '{ not json at all',                                              // corrupt line
    JSON.stringify({ ts: t0, type: 'wire-turn', id: 'fresh' }),
  ].join('\n') + '\n');

  await r.log.rotate();

  const kept = fs.readFileSync(bulkPath, 'utf8').split('\n').filter(Boolean);
  const parsed = kept.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  assert.deepStrictEqual(ids(parsed).sort(), ['bad-ts', 'fresh', 'no-ts'],
    'a record whose ts is absent or unparseable is KEPT — only the one with a real, expired timestamp was dropped');

  // A line that will not parse has no type either, so it takes the unknown-type
  // route and is kept forever in the diag lane. Kept, in some lane, is the
  // property that matters: a torn line is evidence of a failure worth recording.
  const diagRaw = fs.readFileSync(r.log.diagPath(), 'utf8').split('\n').filter(Boolean);
  assert.deepStrictEqual(diagRaw, ['{ not json at all'],
    'the corrupt line survived verbatim, routed to the kept-forever lane rather than aged out on a guess');
});

test('t187: the size cap is a backstop that keeps the NEWEST records', async () => {
  const r = rig();
  const t0 = r.now();
  const diagPath = r.log.diagPath();
  // Diagnostics have no age window at all, so the cap is their only bound.
  // Oversize the lane with records that are all "recent".
  const pad = 'x'.repeat(2000);
  const lines = [];
  for (let i = 0; i < 40000; i++) lines.push(JSON.stringify({ ts: t0 - i, type: 'wire-error', id: i, pad }));
  fs.writeFileSync(diagPath, lines.join('\n') + '\n');
  const before = fs.statSync(diagPath).size;
  assert.ok(before > DIAG_MAX_BYTES, `ENTER: the fixture is actually over the ${DIAG_MAX_BYTES}-byte cap (${before}), so the trim below is exercised`);

  await r.log.rotate();

  const after = fs.statSync(diagPath).size;
  assert.ok(after <= DIAG_MAX_BYTES / 2 + 4096, `trimmed to about half the cap, not parked at it (${after})`);
  const recs = r.diag();
  // Records were written newest-first, so the trim must keep the TAIL of the
  // file. Whichever end it kept, the survivors must be contiguous and end at
  // the last line written.
  assert.strictEqual(recs[recs.length - 1].id, 39999, 'the last-written record survived — the trim dropped from the front');
  assert.ok(recs.length < 40000, 'and something was actually dropped');
  assert.strictEqual(recs.length, new Set(ids(recs)).size, 'no record was duplicated by the rewrite');
  // Every surviving line is a whole record: a byte-offset trim that cut mid-line
  // would have thrown in r.diag()'s JSON.parse above.
  assert.ok(recs.every((rec) => rec.pad === pad), 'every survivor is a complete, intact record');
});

test('t187: caps sit far above steady state — the backstop must not shape normal operation', () => {
  // Measured: 1.87 MB/day average over 14 days => ~26MB steady state for bulk;
  // diagnostics project to ~3.4MB/YEAR. A cap near those would silently become
  // the primary control and quietly re-truncate the window this ticket widened.
  const steadyBulk = 1.87 * 1024 * 1024 * 14;
  assert.ok(BULK_MAX_BYTES > steadyBulk * 3,
    `bulk cap ${BULK_MAX_BYTES} must clear steady state ${Math.round(steadyBulk)} by a wide margin`);
  const diagPerYear = 3.4 * 1024 * 1024;
  assert.ok(DIAG_MAX_BYTES > diagPerYear * 10,
    'the diag cap must not fire for a decade of normal diagnostics — it exists only to stop a runaway');
});

test('t187: records appended DURING a compaction survive the rename', async () => {
  // The constraint: rotation must not lose records across a restart or a second
  // instance. ~/.clodex is shared, so another Clodex can append while we filter.
  const r = rig();
  const t0 = r.now();
  const bulkPath = r.log.bulkPath();
  r.write({ type: 'wire-turn', id: 'stale' }, t0 - 30 * DAY);
  r.write({ type: 'wire-turn', id: 'kept' }, t0);

  // Inject the concurrent writer between the filter read and the rename by
  // wrapping writeFile, which _compact calls after filtering and before the
  // stable-tail loop.
  const realWriteFile = fs.promises.writeFile;
  let fired = false;
  const log = new ShadowLog({
    fs: { ...fs, promises: {
      ...fs.promises,
      writeFile: async (...args) => {
        const out = await realWriteFile.apply(fs.promises, args);
        if (!fired) {
          fired = true;
          fs.appendFileSync(bulkPath, JSON.stringify({ ts: t0, type: 'wire-turn', id: 'concurrent' }) + '\n');
        }
        return out;
      },
    } },
    path, dir: r.dir, now: () => t0,
  });

  await log.rotate();

  assert.ok(fired, 'ENTER: the concurrent append actually ran mid-compaction, so this test exercised the race it names');
  assert.deepStrictEqual(ids(r.bulk()).sort(), ['concurrent', 'kept'],
    'the record written by the other instance rode onto the new file; only the stale one was dropped');
});

test('t187 r1: a FAILED spill write must not let the rename delete the diagnostics', async () => {
  // The dangerous interleaving is the one-shot migration: the first rotation
  // after an upgrade carries the entire pre-split history of rare records in
  // the spill array. If that append fails but the tmp write and rename succeed,
  // the records are in neither file and are gone permanently — a rotation that
  // SUCCEEDS while losing data, which is the one outcome this design forbids.
  const r = rig();
  const t0 = r.now();
  const bulkPath = r.log.bulkPath();
  fs.writeFileSync(bulkPath, [
    JSON.stringify({ ts: t0 - 40 * DAY, type: 'wire-error', id: 'ancient-diag' }),
    JSON.stringify({ ts: t0 - 40 * DAY, type: 'wire-turn', id: 'ancient-bulk' }),
    JSON.stringify({ ts: t0 - 2 * DAY, type: 'intent-drop', id: 'recent-diag' }),
    JSON.stringify({ ts: t0, type: 'wire-turn', id: 'fresh-bulk' }),
  ].join('\n') + '\n');

  let spillAttempted = false;
  const log = new ShadowLog({
    fs: { ...fs, promises: { ...fs.promises,
      appendFile: async (target, ...rest) => {
        if (String(target).endsWith('wire-shadow-diag.jsonl')) {
          spillAttempted = true;
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        return fs.promises.appendFile(target, ...rest);
      },
    } },
    path, dir: r.dir, now: () => t0,
  });

  const report = await log.rotate();

  assert.ok(spillAttempted, 'ENTER: the spill append really was attempted and really did fail, so this test exercised the loss path it names');
  // The property that matters is "still exists SOMEWHERE" — which lane is an
  // implementation choice, losing them is not.
  const everywhere = [...r.bulk(), ...r.diag()];
  assert.ok(ids(everywhere).includes('ancient-diag'),
    'the 40-day-old diagnostic survived a failed spill — the migration did not erase the history it was moving');
  assert.ok(ids(everywhere).includes('recent-diag'), 'and so did the recent one');
  assert.ok(!ids(everywhere).includes('ancient-bulk'), 'while the aged BULK record was still correctly dropped');
  assert.ok(ids(everywhere).includes('fresh-bulk'), 'and the in-window bulk record is untouched');
  assert.strictEqual(report.bulk.spilled, 0, 'the report does not claim a spill that did not happen');

  // Once the diag lane is writable again the retry completes the migration.
  await r.log.rotate();
  assert.deepStrictEqual(ids(r.diag()).sort(), ['ancient-diag', 'recent-diag'],
    'the next pass re-spills them into the diag lane, so the failure only deferred the move');
});

test('t187 r1: concurrent compactions do not share a tmp path', () => {
  // A single shared tmp name lets two instances interleave writes into it and
  // rename a TORN file into place — corruption, not just a dropped rotation.
  const r = rig();
  const tmpNames = new Set();
  const realWriteFile = fs.promises.writeFile;
  const log = new ShadowLog({
    fs: { ...fs, promises: { ...fs.promises,
      writeFile: (p, ...rest) => { tmpNames.add(String(p)); return realWriteFile.call(fs.promises, p, ...rest); },
    } },
    path, dir: r.dir, now: r.now.bind(r),
  });
  r.write({ type: 'wire-turn', id: 'stale' }, r.now() - 30 * DAY);

  return log.rotate().then(() => {
    assert.strictEqual(tmpNames.size, 1, 'ENTER: exactly one tmp file was written, so the name below is the one under test');
    const name = [...tmpNames][0];
    assert.ok(name.includes(String(process.pid)),
      `the tmp path is scoped to this process (${name}) — two instances cannot interleave on it`);
  });
});

test('t187: a failed compaction leaves the original intact and drops no records', async () => {
  const r = rig();
  const t0 = r.now();
  r.write({ type: 'wire-turn', id: 'stale' }, t0 - 30 * DAY);
  r.write({ type: 'wire-turn', id: 'kept' }, t0);
  const before = fs.readFileSync(r.log.bulkPath(), 'utf8');

  const log = new ShadowLog({
    fs: { ...fs, promises: { ...fs.promises, rename: async () => { throw new Error('disk full'); } } },
    path, dir: r.dir, now: () => t0,
  });
  await log.rotate(); // must not throw

  assert.strictEqual(fs.readFileSync(r.log.bulkPath(), 'utf8'), before,
    'the rotation was lost, the data was not — a crash before the rename is recoverable by construction');
  assert.ok(!fs.existsSync(r.log.bulkPath() + '.rot'), 'and the tmp file was cleaned up');
});

test('t187: append never throws, whatever the filesystem does', () => {
  const log = new ShadowLog({
    fs: { appendFile: () => { throw new Error('EACCES'); }, promises: {} },
    path, dir: '/nonexistent/nope', now: () => Date.now(),
  });
  assert.doesNotThrow(() => log.append({ type: 'wire-turn' }), 'observer-grade: the sink must never surface into a turn');
  assert.doesNotThrow(() => log.append({ type: 'wire-error' }));
});

test('t187: the rotation check is throttled, and the first append always checks', async () => {
  const r = rig();
  let rotations = 0;
  r.log.rotate = async () => { rotations++; };

  r.log.append({ type: 'wire-turn', id: 1 });
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(rotations, 1, 'the first append checks, so an already-oversized log starts shrinking at launch');

  r.advance(CHECK_INTERVAL_MS - 1000);
  for (let i = 0; i < 50; i++) r.log.append({ type: 'wire-turn', id: i });
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(rotations, 1, 'nothing re-checks inside the interval — the hot path stays a bare appendFile');

  r.advance(2000);
  r.log.append({ type: 'wire-turn', id: 'later' });
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(rotations, 2, 'and the check resumes once the interval has passed');
});

test('t187: a healthy log within its window is not rewritten at all', async () => {
  // A rotation that rewrites an in-policy file every 15 minutes would burn the
  // disk for nothing and widen the concurrent-append window pointlessly.
  const r = rig();
  const t0 = r.now();
  r.write({ type: 'wire-turn', id: 'a' }, t0 - DAY);
  r.write({ type: 'wire-error', id: 'b' }, t0 - DAY);
  const bulkBefore = fs.statSync(r.log.bulkPath()).mtimeMs;
  const diagBefore = fs.statSync(r.log.diagPath()).mtimeMs;

  const report = await r.log.rotate();

  assert.deepStrictEqual(report, { bulk: null, diag: null }, 'neither lane needed work');
  assert.strictEqual(fs.statSync(r.log.bulkPath()).mtimeMs, bulkBefore, 'the bulk file was not touched');
  assert.strictEqual(fs.statSync(r.log.diagPath()).mtimeMs, diagBefore, 'the diag file was not touched');
});

test('t187: append routes each type to its own lane', async () => {
  const r = rig();
  r.log.rotate = async () => {};
  for (const type of ['wire-turn', 'wire-telemetry-diff', 'wire-hold', 'autocompact-suppressed']) {
    r.log.append({ type, id: type });
  }
  for (const type of ['wire-error', 'wire-tee-failure', 'intent-drop', 'sighting', 'match', 'wire-up']) {
    r.log.append({ type, id: type });
  }
  await new Promise((res) => setTimeout(res, 50));

  assert.deepStrictEqual(types(r.bulk()), ['autocompact-suppressed', 'wire-hold', 'wire-telemetry-diff', 'wire-turn']);
  assert.deepStrictEqual(types(r.diag()), ['intent-drop', 'match', 'sighting', 'wire-error', 'wire-tee-failure', 'wire-up']);
  assert.ok(r.bulk().every((rec) => typeof rec.ts === 'number'), 'every record is stamped, which is what makes the age window enforceable');
});
