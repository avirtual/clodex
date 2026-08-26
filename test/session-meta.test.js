// Run: node --test
// Covers session-meta: last-activity timestamp from the transcript symlink,
// metaFor batching (dedupe PR lookups by cwd, includePr toggle), and PR-status
// TTL caching. The git/gh calls are exercised only via the includePr:false path
// (no network); the timestamp path uses a real symlink under a temp REGISTRY_DIR.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionMeta } = require('../session-meta');
const { pathFor, runDirFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

function tmpRegistry() {
  return mkTmpRoot('clodex-meta-');
}

// Create a per-agent transcript symlink → a real file with a known mtime.
function seedTranscript(REGISTRY_DIR, name, mtimeMs) {
  fs.mkdirSync(runDirFor(REGISTRY_DIR, name), { recursive: true });
  const target = path.join(REGISTRY_DIR, `${name}-real.jsonl`);
  fs.writeFileSync(target, '{}\n');
  if (mtimeMs) fs.utimesSync(target, new Date(mtimeMs), new Date(mtimeMs));
  const link = pathFor(REGISTRY_DIR, name, 'transcript');
  try { fs.unlinkSync(link); } catch {}
  fs.symlinkSync(target, link);
}

test('lastActivityTs: reads the transcript symlink target mtime', () => {
  const REGISTRY_DIR = tmpRegistry();
  const meta = createSessionMeta({ REGISTRY_DIR });
  const when = Date.now() - 60000;
  seedTranscript(REGISTRY_DIR, 'alice', when);
  const ts = meta.lastActivityTs('alice');
  assert.ok(Math.abs(ts - when) < 2000, `ts ~= ${when}, got ${ts}`);
});

test('lastActivityTs: null when there is no transcript', () => {
  const REGISTRY_DIR = tmpRegistry();
  const meta = createSessionMeta({ REGISTRY_DIR });
  assert.strictEqual(meta.lastActivityTs('ghost'), null);
});

test('metaFor: timestamps for all, no PR work when includePr:false', async () => {
  const REGISTRY_DIR = tmpRegistry();
  const meta = createSessionMeta({ REGISTRY_DIR });
  seedTranscript(REGISTRY_DIR, 'a', Date.now() - 1000);
  seedTranscript(REGISTRY_DIR, 'b', Date.now() - 2000);
  const out = await meta.metaFor(
    [{ name: 'a', cwd: '/x' }, { name: 'b', cwd: '/y' }],
    { includePr: false });
  assert.ok(out.a.lastActivityTs > 0);
  assert.ok(out.b.lastActivityTs > 0);
  // No PR lookup ran, so the PR keys are ABSENT — not null. A present null is a
  // claim ("computed, unknowable"); absent is "not asked". The renderer merges
  // these two differently, and shipping the first for the second is what wiped
  // the boot tier's PR chip 30s after launch.
  assert.ok(!('prState' in out.a), 'prState is absent on the fast tier, not null');
  assert.ok(!('branch' in out.a));
  assert.ok(!('prNumber' in out.a));
  assert.deepStrictEqual(out.a._tiers, ['activity'], 'and the payload says which tier it asked');
});

test('metaFor: the PR tier is claimed, and reports null as a PRESENT unknown', async () => {
  const REGISTRY_DIR = tmpRegistry();
  const meta = createSessionMeta({ REGISTRY_DIR });
  seedTranscript(REGISTRY_DIR, 'a', Date.now() - 1000);
  // No cwd → prStatus is never consulted, so the row keeps the unknown filler.
  // That filler must still be PRESENT: this tier asked, and "unknown" is its
  // answer — the renderer has to be able to clear a stale chip on it.
  const out = await meta.metaFor([{ name: 'a', cwd: null }], { includePr: true });
  assert.deepStrictEqual(out.a._tiers, ['activity', 'pr']);
  assert.ok('prState' in out.a, 'the claimed tier reports its keys');
  assert.strictEqual(out.a.prState, null);
  assert.strictEqual(out.a.branch, null);
  assert.strictEqual(out.a.prNumber, null);
});

// The shipped defect, end to end across BOTH real modules: the boot refresh
// answers the PR question, the 30s refresh does not ask it, and the chip must
// still be there afterwards. Pinned here rather than only in meta-tiers.test.js
// because the bug lived in the pairing — each side was self-consistent.
test('metaFor + mergeMeta: the 30s tier does not erase the boot tier\'s PR answer', async () => {
  const { mergeMeta } = require('../meta-tiers');
  const REGISTRY_DIR = tmpRegistry();
  const meta = createSessionMeta({ REGISTRY_DIR });
  seedTranscript(REGISTRY_DIR, 'a', Date.now() - 5000);

  // Boot tier, with a real PR answer substituted for the git/gh work.
  const boot = (await meta.metaFor([{ name: 'a', cwd: null }], { includePr: true })).a;
  const cache = mergeMeta({}, { ...boot, branch: 'master', prState: 'open', prNumber: 42 });
  assert.strictEqual(cache.prState, 'open', 'ENTER: the chip is painted before the timer runs');

  seedTranscript(REGISTRY_DIR, 'a', Date.now());
  const tick = (await meta.metaFor([{ name: 'a', cwd: null }], { includePr: false })).a;
  const after = mergeMeta(cache, tick);
  assert.strictEqual(after.prState, 'open', 'the chip survives the cheap refresh');
  assert.strictEqual(after.prNumber, 42);
  assert.ok(after.lastActivityTs > cache.lastActivityTs, 'ENTER: the cheap refresh really ran');
});

test('prStatus: a git repo with no PR reports prState "none" (groupable), not null', async () => {
  // Uses a real throwaway repo so the git branch resolves; gh will report no PR
  // for the branch (exit ≠ 0), which must map to 'none' — the distinction that
  // makes PR-grouping bucket unmerged branches correctly. Skipped without git.
  let hasGit = true;
  try { require('child_process').execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }
  if (!hasGit) return;
  const { execFileSync } = require('child_process');
  const repo = mkTmpRoot('clodex-pr-');
  execFileSync('git', ['-C', repo, 'init', '-q'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.co'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'f'), 'x');
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'i'], { stdio: 'ignore' });
  const meta = createSessionMeta({ REGISTRY_DIR: tmpRegistry() });
  const r = await meta.prStatus(repo);
  assert.strictEqual(r.isRepo, true);
  assert.ok(r.branch, 'branch resolved');
  // With gh installed → 'none' (no PR); with gh absent → null (unknown). Both are
  // acceptable; the bug we guard against is a repo-with-no-PR ever being 'open'.
  assert.ok(r.prState === 'none' || r.prState === null, `prState is none|null, got ${r.prState}`);
  assert.notStrictEqual(r.prState, 'open');
});

test('prStatus: non-repo cwd → isRepo:false, cached within the TTL', async () => {
  const REGISTRY_DIR = tmpRegistry();
  const meta = createSessionMeta({ REGISTRY_DIR, prTtlMs: 60000 });
  const notRepo = mkTmpRoot('clodex-nr-');
  const r1 = await meta.prStatus(notRepo);
  assert.strictEqual(r1.isRepo, false);
  assert.strictEqual(r1.prState, null);
  // Second call within TTL returns the cached value object.
  assert.ok(meta._prCache.has(notRepo));
  const r2 = await meta.prStatus(notRepo);
  assert.deepStrictEqual(r2, r1);
});
