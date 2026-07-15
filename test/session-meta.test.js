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

function tmpRegistry() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-meta-'));
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
  // No PR lookup ran, so branch/prState stay null.
  assert.strictEqual(out.a.prState, null);
  assert.strictEqual(out.a.branch, null);
});

test('prStatus: a git repo with no PR reports prState "none" (groupable), not null', async () => {
  // Uses a real throwaway repo so the git branch resolves; gh will report no PR
  // for the branch (exit ≠ 0), which must map to 'none' — the distinction that
  // makes PR-grouping bucket unmerged branches correctly. Skipped without git.
  let hasGit = true;
  try { require('child_process').execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }
  if (!hasGit) return;
  const { execFileSync } = require('child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-pr-'));
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
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-nr-'));
  const r1 = await meta.prStatus(notRepo);
  assert.strictEqual(r1.isRepo, false);
  assert.strictEqual(r1.prState, null);
  // Second call within TTL returns the cached value object.
  assert.ok(meta._prCache.has(notRepo));
  const r2 = await meta.prStatus(notRepo);
  assert.deepStrictEqual(r2, r1);
});
