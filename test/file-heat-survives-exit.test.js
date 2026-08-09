'use strict';
// file-heat-survives-exit.test.js — the boiling pot's 14-day window must outlive
// a PTY exit (F003).
//
// THE STATE THIS CONSTRUCTS, rather than asserting around. file-heat.json used
// to be a clodex-paths KIND, i.e. a file inside run/<name>/ — and
// cleanupClaudeHook rm -rf's that whole dir, on EVERY exit path (_cleanup calls
// it on kill, restart, archive and app quit, right after flushing the heat into
// it). So the fixture does the real sequence: write heat, run the REAL
// cleanupClaudeHook, then look. A test that only asserted "heat is readable
// after a write" would pass on the broken code, because the write was never the
// broken half.
//
// REAL on both ends: the real createFileHeat writing through fs-util's atomic
// write to a real temp dir, and the real cli-hooks cleanup doing the real rm
// -rf. The decoy planted at the OLD path is what proves the sweep is still
// destructive — without it, "the heat survived" could just mean the cleanup
// silently did nothing.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFileHeat, heatPath, heatDir, aggregateStates, normalizeState } = require('../file-heat');
const { runDirFor } = require('../clodex-paths');
const { createCliHooks } = require('../cli-hooks');
const { readJsonSafe } = require('../fs-util');
const { loadStates } = require('../pot-cli');
const { createSessionManager } = require('../session-manager');

const DAY = 86_400_000;
const T0 = Date.parse('2026-07-16T12:00:00Z');

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-heat-')); }

// The REAL cleanup, with the same minimal fakes cli-hooks.test.js injects — none
// of them are on the cleanup path, which only needs REGISTRY_DIR.
function cleanupFor(REGISTRY_DIR) {
  return createCliHooks({
    REGISTRY_DIR,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  }).cleanupClaudeHook;
}

// A seat with heat on two days: one 13 days back (inside the 14-day window,
// which is the whole point) and one today.
async function seedHeat(root, name, { now = T0 } = {}) {
  const target = path.join(root, `${name}-subject.js`);
  fs.writeFileSync(target, 'x'.repeat(4000)); // 4000 bytes → 1000 tokens whole-file
  let clock = now - 13 * DAY;
  const heat = createFileHeat({ filePath: heatPath(root, name), now: () => clock, flushMs: 30_000 });
  await heat.recordRead(target, null, null);
  clock = now;
  await heat.recordRead(target, null, null);
  heat.close(); // flush, exactly as _cleanup does before cleanupClaudeHook
  return target;
}

test('the heat file is NOT inside the dir the exit deletes (F003)', async () => {
  const root = tmpRoot();
  const target = await seedHeat(root, 'alice');

  // The state the finding names: what the OLD grammar wrote, in the dir the
  // exit sweeps. Planted alongside a second run artifact so a no-op cleanup
  // cannot masquerade as a fix.
  const runDir = runDirFor(root, 'alice');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'file-heat.json'), '{"version":1,"days":{}}');
  fs.writeFileSync(path.join(runDir, 'hook.sh'), '#!/bin/sh\n');

  cleanupFor(root)('alice');

  assert.ok(!fs.existsSync(runDir), 'the exit must still destroy run/<name>/ — the sweep is not what changed');
  assert.ok(!fs.existsSync(path.join(runDir, 'file-heat.json')), 'a heat file left in run/ would still be destroyed');

  const state = readJsonSafe(heatPath(root, 'alice'));
  assert.ok(state, 'the heat file must survive the exit');
  const snap = aggregateStates([normalizeState(state)], { now: T0, topN: 10 });
  assert.strictEqual(snap.files.length, 1);
  assert.strictEqual(snap.files[0].file, target);
  assert.strictEqual(snap.files[0].reads, 2, 'both days survive, not only the last one');
  assert.strictEqual(snap.files[0].window.from, '2026-07-03', '13 days back is still in the window');
});

test('a restarted seat resumes the SAME window instead of starting empty (F003)', async () => {
  const root = tmpRoot();
  const old = await seedHeat(root, 'bob');
  cleanupFor(root)('bob');

  // The respawn: a brand-new recorder at the same path, as _fileHeatFor builds
  // for the replacement session.
  const fresh = path.join(root, 'fresh.js');
  fs.writeFileSync(fresh, 'y'.repeat(400));
  const heat = createFileHeat({ filePath: heatPath(root, 'bob'), now: () => T0, flushMs: 30_000 });
  await heat.recordRead(fresh, null, null);
  heat.close();

  const snap = createFileHeat({ filePath: heatPath(root, 'bob'), now: () => T0 }).snapshot(10);
  const byFile = new Map(snap.files.map((f) => [f.file, f]));
  assert.ok(byFile.has(fresh), 'the new life records');
  assert.ok(byFile.has(old), 'the PREVIOUS life is still in the window — this is the bug the fix is about');
  assert.strictEqual(byFile.get(old).approxReadTokens, 2000, 'carriage accumulated across the exit');
});

test('the pot CLI reads heat where the recorder writes it (F003)', async () => {
  const root = tmpRoot();
  const target = await seedHeat(root, 'carol');
  await seedHeat(root, 'dave');
  cleanupFor(root)('carol');
  cleanupFor(root)('dave');

  // loadStates enumerates the shared heat/ root, not run/ — a seat that is
  // currently STOPPED (no run dir at all) must still contribute its window.
  const states = loadStates(root);
  assert.strictEqual(states.length, 2, 'both stopped seats contribute');
  const snap = aggregateStates(states, { now: T0, topN: 10 });
  assert.ok(snap.files.some((f) => f.file === target));
  assert.ok(fs.existsSync(heatDir(root, 'carol')));
});

test('the drawer reader (potSnapshot) finds a stopped seat\'s heat too (F003)', async () => {
  const root = tmpRoot();
  // Seeded against the REAL clock, not T0: potSnapshot aggregates at Date.now()
  // (the drawer has no injected clock), so a fixed-date fixture would age out of
  // the 14-day window and the test would pass for the wrong reason.
  const target = await seedHeat(root, 'erin', { now: Date.now() });
  cleanupFor(root)('erin');

  // The REAL SessionManager over an empty live map — which is the fixture: the
  // seat is stopped, so if potSnapshot still enumerated run/ it would find
  // nothing at all. Only the deps potSnapshot touches are wired.
  const SessionManager = createSessionManager({
    REGISTRY_DIR: root,
    // fs AND path are both injected seams in this module — potSnapshot's
    // enumeration is `fs.readdirSync(path.join(REGISTRY_DIR, 'heat'))`, wrapped
    // in a swallowing try, so an unwired `path` degrades to "no heat" rather
    // than to a visible error.
    fs: require('node:fs'),
    path: require('node:path'),
    ProxyClient: { potSeries: async () => ({ ok: false, files: [] }) },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    getPersistence: () => null,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
  });
  const snap = await new SessionManager().potSnapshot(10);
  // potSnapshot swallows every throw into { window: null, files: [] }, so pin
  // the window too — otherwise a missing dep would look like "no heat found".
  assert.ok(snap.window, 'potSnapshot must have aggregated, not degraded');
  assert.ok(snap.files.some((f) => f.file === target), 'a stopped seat still contributes its window');
});

test('a seat with no heat yet is not an error for either reader', () => {
  const root = tmpRoot();
  assert.deepStrictEqual(loadStates(root), [], 'a missing heat/ root is a legal, silent state');
  assert.strictEqual(readJsonSafe(heatPath(root, 'nobody')), null);
});
