// Run: node --test
// Covers session-discovery's pure fs logic against a synthetic ~/.claude/projects
// tree: transcriptCwd extraction, the global disk scan (age cutoff, newest-first),
// and discoverAdoptable's tracked-id subtraction. Live-process detection is not
// exercised here (it shells out to pgrep/lsof); its Windows short-circuit is.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const d = require('../session-discovery');
const { mkTmpRoot } = require('./lib/tmp-roots');

// Build a fake projects root; monkeypatch os.homedir so scanClaudeDisk reads it.
function fakeProjects(records) {
  const home = mkTmpRoot('clodex-disc-');
  const projects = path.join(home, '.claude', 'projects');
  for (const rec of records) {
    const slugDir = path.join(projects, rec.slug);
    fs.mkdirSync(slugDir, { recursive: true });
    const file = path.join(slugDir, `${rec.sessionId}.jsonl`);
    const line = JSON.stringify({ type: 'user', cwd: rec.cwd, timestamp: '2026-07-09T00:00:00.000Z' });
    fs.writeFileSync(file, line + '\n');
    if (rec.mtimeMs) fs.utimesSync(file, new Date(rec.mtimeMs), new Date(rec.mtimeMs));
  }
  return home;
}

function withHome(home, fn) {
  const orig = os.homedir;
  os.homedir = () => home;
  try { return fn(); } finally { os.homedir = orig; }
}

test('transcriptCwd: pulls the embedded cwd from a transcript head', () => {
  const dir = mkTmpRoot('clodex-tc-');
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: '/Users/x/proj' }) + '\n');
  assert.strictEqual(d.transcriptCwd(file), '/Users/x/proj');
});

test('transcriptCwd: null when absent / unreadable', () => {
  const dir = mkTmpRoot('clodex-tc2-');
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'summary' }) + '\n');
  assert.strictEqual(d.transcriptCwd(file), null);
  assert.strictEqual(d.transcriptCwd(path.join(dir, 'nope.jsonl')), null);
});

test('scanClaudeDisk: finds all recent transcripts across slugs, newest-first', () => {
  const now = Date.now();
  const home = fakeProjects([
    { slug: '-a', sessionId: 'aaaa', cwd: '/a', mtimeMs: now - 1000 },
    { slug: '-b', sessionId: 'bbbb', cwd: '/b', mtimeMs: now - 5000 },
  ]);
  const rows = withHome(home, () => d.scanClaudeDisk());
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].sessionId, 'aaaa'); // newest first
  assert.strictEqual(rows[0].cwd, '/a');
  assert.strictEqual(rows[0].type, 'claude');
});

test('scanClaudeDisk: sorts by the displayed key (lastActive) when it diverges from mtime', () => {
  const now = Date.now();
  // 'newfile' has the newer mtime but the OLDER lastActive; 'newmeta' is the
  // reverse. The rows must come back in lastActive order (newmeta first) so the
  // list matches what the picker shows (relTime(lastActive || mtime)).
  const home = fakeProjects([
    { slug: '-a', sessionId: 'newfile', cwd: '/a', mtimeMs: now - 1000 },
    { slug: '-b', sessionId: 'newmeta', cwd: '/b', mtimeMs: now - 5000 },
  ]);
  const readMeta = (file) => ({
    title: null,
    turns: null,
    last: file.includes('newfile') ? now - 6000 : now - 500,
  });
  const rows = withHome(home, () => d.scanClaudeDisk({ readMeta }));
  assert.deepStrictEqual(rows.map((r) => r.sessionId), ['newmeta', 'newfile']);
});

test('scanClaudeDisk: honors the age cutoff', () => {
  const now = Date.now();
  const home = fakeProjects([
    { slug: '-a', sessionId: 'fresh', cwd: '/a', mtimeMs: now - 1000 },
    { slug: '-b', sessionId: 'stale', cwd: '/b', mtimeMs: now - 40 * 24 * 3600 * 1000 },
  ]);
  const rows = withHome(home, () => d.scanClaudeDisk({ maxAgeMs: 7 * 24 * 3600 * 1000 }));
  assert.deepStrictEqual(rows.map((r) => r.sessionId), ['fresh']);
});

test('scanClaudeDisk: missing store → empty list, never throws', () => {
  const home = mkTmpRoot('clodex-empty-');
  assert.deepStrictEqual(withHome(home, () => d.scanClaudeDisk()), []);
});

test('discoverAdoptable: subtracts tracked session ids', () => {
  const now = Date.now();
  const home = fakeProjects([
    { slug: '-a', sessionId: 'keep', cwd: '/a', mtimeMs: now - 1000 },
    { slug: '-b', sessionId: 'owned', cwd: '/b', mtimeMs: now - 2000 },
  ]);
  const rows = withHome(home, () => d.discoverAdoptable({ tracked: new Set(['owned']) }));
  assert.deepStrictEqual(rows.map((r) => r.sessionId), ['keep']);
});

test('discoverLiveProcesses: empty on win32 (no pgrep/lsof)', async () => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    assert.deepStrictEqual(await d.discoverLiveProcesses(), []);
  } finally {
    Object.defineProperty(process, 'platform', orig);
  }
});
