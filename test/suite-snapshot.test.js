'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { snapshotTree, releaseSnapshot, buildPack, ingestPack, materialize, treeHashOf, keepRefs, mirrorHave, detachTree, DEFAULT_PACK_MAX } = require('../suite-snapshot');

const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' };
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false'];

function g(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...IDENT, ...args], { env: ENV, encoding: 'utf8' });
}

function write(dir, rel, content) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

async function packOf(snap, opts) {
  return fs.readFileSync((await buildPack(snap, opts)).file);
}

function baseRepo() {
  const root = mkTmpRoot('suite-snap-');
  const repo = path.join(root, 'near');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'master');
  write(repo, 'a.txt', 'alpha\n');
  write(repo, 'b.txt', 'bravo\n');
  write(repo, 'c.txt', 'charlie\n');
  write(repo, '.gitignore', 'ignored.log\n');
  g(repo, 'add', 'a.txt', 'b.txt', 'c.txt', '.gitignore');
  g(repo, 'commit', '-q', '-m', 'one');
  write(repo, 'a.txt', 'alpha two\n');
  g(repo, 'commit', '-q', '-am', 'two');
  g(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, 'd.txt', 'delta\n');
  g(repo, 'add', 'd.txt');
  g(repo, 'commit', '-q', '-m', 'three');
  return { root, repo };
}

async function roundTrip(root, near, { have = [] } = {}) {
  const status = g(near, 'status', '--porcelain');
  const snap = await snapshotTree(near);
  try {
    const pack = await packOf(snap, { have });
    const workDir = path.join(root, 'work');
    const ingest = await ingestPack(pack, { workDir, repoKey: snap.repoKey, snap: snap.snap, indexTree: snap.indexTree, refs: snap.refs });
    assert.deepStrictEqual(ingest, { ok: true, mirror: path.join(workDir, 'mirrors', `${snap.repoKey}.git`) });
    const dir = path.join(root, 'job', 'tree');
    const done = await materialize({ mirror: ingest.mirror, dir, snap: snap.snap, treeHash: snap.treeHash, indexTree: snap.indexTree, head: snap.head, branch: snap.branch, refs: snap.refs });
    assert.deepStrictEqual(done, { ok: true, dir });
    assert.strictEqual(await treeHashOf(dir, { base: snap.snap }), snap.treeHash);
    assert.strictEqual(g(dir, 'status', '--porcelain'), status);
    return { snap, dir, status };
  } finally {
    releaseSnapshot(snap);
  }
}

const ROWS = [
  {
    name: 'modified tracked file',
    mutate: (r) => write(r, 'a.txt', 'alpha modified\n'),
    status: ' M a.txt\n',
    check: (d) => assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'alpha modified\n'),
  },
  {
    name: 'staged-only change',
    mutate: (r) => { write(r, 'b.txt', 'bravo staged\n'); g(r, 'add', 'b.txt'); },
    status: 'M  b.txt\n',
    check: (d) => assert.strictEqual(fs.readFileSync(path.join(d, 'b.txt'), 'utf8'), 'bravo staged\n'),
  },
  {
    name: 'staged then modified',
    mutate: (r) => { write(r, 'b.txt', 'bravo staged\n'); g(r, 'add', 'b.txt'); write(r, 'b.txt', 'bravo worktree\n'); },
    status: 'MM b.txt\n',
    check: (d) => {
      assert.strictEqual(fs.readFileSync(path.join(d, 'b.txt'), 'utf8'), 'bravo worktree\n');
      assert.strictEqual(g(d, 'show', ':b.txt'), 'bravo staged\n');
    },
  },
  {
    name: 'deleted file',
    mutate: (r) => fs.rmSync(path.join(r, 'c.txt')),
    status: ' D c.txt\n',
    check: (d) => assert.strictEqual(fs.existsSync(path.join(d, 'c.txt')), false),
  },
  {
    name: 'untracked file',
    mutate: (r) => write(r, 'new/untracked.txt', 'untracked body\n'),
    status: '?? new/\n',
    check: (d) => assert.strictEqual(fs.readFileSync(path.join(d, 'new/untracked.txt'), 'utf8'), 'untracked body\n'),
  },
  {
    name: 'ignored file absent on the far side',
    mutate: (r) => write(r, 'ignored.log', 'ignored body\n'),
    status: '',
    check: (d, near) => {
      assert.strictEqual(fs.readFileSync(path.join(near, 'ignored.log'), 'utf8'), 'ignored body\n');
      assert.strictEqual(fs.existsSync(path.join(d, 'ignored.log')), false);
    },
  },
  {
    name: 'symlink',
    mutate: (r) => fs.symlinkSync('a.txt', path.join(r, 'link-to-a')),
    status: '?? link-to-a\n',
    check: (d) => assert.strictEqual(fs.readlinkSync(path.join(d, 'link-to-a')), 'a.txt'),
  },
  {
    name: 'exec bit',
    mutate: (r) => { write(r, 'run.sh', '#!/bin/sh\necho hi\n'); fs.chmodSync(path.join(r, 'run.sh'), 0o755); },
    status: '?? run.sh\n',
    check: (d) => assert.strictEqual(fs.statSync(path.join(d, 'run.sh')).mode & 0o100, 0o100),
  },
  {
    name: 'CRLF content',
    mutate: (r) => write(r, 'crlf.txt', 'one\r\ntwo\r\n'),
    status: '?? crlf.txt\n',
    check: (d) => assert.deepStrictEqual(fs.readFileSync(path.join(d, 'crlf.txt')), Buffer.from('one\r\ntwo\r\n')),
  },
  {
    name: 'clean tree',
    mutate: () => {},
    status: '',
    check: (d, near, snap) => assert.strictEqual(snap.treeHash, g(near, 'rev-parse', 'HEAD^{tree}').trim()),
  },
];

for (const row of ROWS) {
  test(`round trip: ${row.name}`, async () => {
    const { root, repo } = baseRepo();
    row.mutate(repo);
    const { snap, dir, status } = await roundTrip(root, repo);
    assert.strictEqual(status, row.status);
    row.check(dir, repo, snap);
    assert.strictEqual(g(dir, 'rev-parse', 'HEAD'), g(repo, 'rev-parse', 'HEAD'));
    assert.strictEqual(g(dir, 'symbolic-ref', '--short', 'HEAD').trim(), 'feature');
    assert.strictEqual(g(dir, 'rev-parse', 'master'), g(repo, 'rev-parse', 'master'));
  });
}

test('round trip: a linked worktree as the source', async () => {
  const { root, repo } = baseRepo();
  const wt = path.join(root, 'linked');
  g(repo, 'worktree', 'add', '-q', '-b', 'side', wt, 'master');
  write(wt, 'a.txt', 'worktree change\n');
  write(wt, 'w.txt', 'worktree untracked\n');
  const { snap, dir, status } = await roundTrip(root, wt);
  assert.strictEqual(status, ' M a.txt\n?? w.txt\n');
  assert.strictEqual(snap.branch, 'side');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'worktree change\n');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'w.txt'), 'utf8'), 'worktree untracked\n');
  assert.strictEqual(fs.existsSync(path.join(dir, 'd.txt')), false);
});

test('a snapshot leaves the source repo untouched: refs, objects, real index bytes', async () => {
  const { repo } = baseRepo();
  write(repo, 'a.txt', 'alpha dirty\n');
  write(repo, 'b.txt', 'bravo staged\n');
  g(repo, 'add', 'b.txt');
  write(repo, 'fresh.txt', 'fresh untracked\n');
  g(repo, 'status', '--porcelain');
  const indexPath = path.join(repo, '.git', 'index');
  const before = { refs: g(repo, 'for-each-ref'), head: g(repo, 'rev-parse', 'HEAD'), objects: g(repo, 'count-objects', '-v'), index: fs.readFileSync(indexPath) };
  const snap = await snapshotTree(repo);
  try {
    const pack = await packOf(snap);
    assert.ok(pack.length > 0);
    assert.notStrictEqual(snap.treeHash, g(repo, 'rev-parse', 'HEAD^{tree}').trim());
  } finally {
    releaseSnapshot(snap);
  }
  const after = { refs: g(repo, 'for-each-ref'), head: g(repo, 'rev-parse', 'HEAD'), objects: g(repo, 'count-objects', '-v'), index: fs.readFileSync(indexPath) };
  assert.deepStrictEqual(after, before);
});

test('buildPack streams to a file under the snapshot tmpDir and stops git once the file would pass maxBytes', async () => {
  const { repo } = baseRepo();
  write(repo, 'big.bin', require('node:crypto').randomBytes(4 * 1024 * 1024));
  const snap = await snapshotTree(repo);
  try {
    const full = await buildPack(snap);
    assert.strictEqual(path.dirname(full.file), snap.tmpDir);
    assert.ok(full.bytes > 4 * 1024 * 1024, `ENTER: the full pack holds the 4 MiB blob (${full.bytes} bytes)`);
    const body = fs.readFileSync(full.file);
    assert.deepStrictEqual([full.over, body.length, full.sha256], [undefined, full.bytes, require('node:crypto').createHash('sha256').update(body).digest('hex')]);
    const limit = 64 * 1024;
    const capped = await buildPack(snap, { maxBytes: limit });
    assert.deepStrictEqual([capped.over, capped.signal], [true, 'SIGKILL']);
    assert.ok(capped.bytes > limit, `the refused pack reports the bytes it saw past the limit (${capped.bytes})`);
    assert.ok(fs.statSync(capped.file).size <= limit, `the file stayed within the limit (${fs.statSync(capped.file).size})`);
  } finally {
    releaseSnapshot(snap);
  }
});

test('ingestPack reads a pack file in readChunk slices and the tree materializes with the same hash', async () => {
  const { root, repo } = baseRepo();
  write(repo, 'a.txt', 'alpha from a file\n');
  const snap = await snapshotTree(repo);
  try {
    const built = await buildPack(snap);
    assert.ok(built.bytes > 4 * 64, `ENTER: the pack spans several read chunks (${built.bytes} bytes)`);
    const workDir = path.join(root, 'work');
    const r = await ingestPack({ file: built.file, bytes: built.bytes }, { workDir, repoKey: snap.repoKey, snap: snap.snap, indexTree: snap.indexTree, refs: snap.refs, readChunk: 64 });
    assert.deepStrictEqual(r, { ok: true, mirror: path.join(workDir, 'mirrors', `${snap.repoKey}.git`) });
    const dir = path.join(root, 'job', 'tree');
    const done = await materialize({ mirror: r.mirror, dir, snap: snap.snap, treeHash: snap.treeHash, indexTree: snap.indexTree, head: snap.head, branch: snap.branch, refs: snap.refs });
    assert.deepStrictEqual(done, { ok: true, dir });
    assert.strictEqual(await treeHashOf(dir, { base: snap.snap }), snap.treeHash);
  } finally {
    releaseSnapshot(snap);
  }
});

test('the same tree snapshotted twice gives the same id', async () => {
  const { repo } = baseRepo();
  write(repo, 'a.txt', 'alpha twice\n');
  write(repo, 'u.txt', 'untracked twice\n');
  const first = await snapshotTree(repo);
  releaseSnapshot(first);
  const second = await snapshotTree(repo);
  releaseSnapshot(second);
  assert.strictEqual(first.snap, 'b662f690a302a59c67704aedf068d18a1cc5f1fd');
  assert.strictEqual(second.snap, first.snap);
  assert.strictEqual(second.treeHash, first.treeHash);
});

test('a pack missing its prerequisites fails ingestPack as incomplete', async () => {
  const { root, repo } = baseRepo();
  write(repo, 'a.txt', 'alpha incremental\n');
  const snap = await snapshotTree(repo);
  try {
    const pack = await packOf(snap, { have: [g(repo, 'rev-parse', 'HEAD~1').trim()] });
    const workDir = path.join(root, 'work');
    const r = await ingestPack(pack, { workDir, repoKey: snap.repoKey, snap: snap.snap, indexTree: snap.indexTree, refs: snap.refs });
    assert.deepStrictEqual(r, { ok: false, reason: 'incomplete', mirror: path.join(workDir, 'mirrors', `${snap.repoKey}.git`) });
    assert.strictEqual(fs.existsSync(path.join(root, 'job')), false);
  } finally {
    releaseSnapshot(snap);
  }
});

test('an incremental pack over a mirror that has the base ingests and round-trips', async () => {
  const { root, repo } = baseRepo();
  const first = await snapshotTree(repo);
  const workDir = path.join(root, 'work');
  try {
    const r = await ingestPack(await packOf(first), { workDir, repoKey: first.repoKey, snap: first.snap, indexTree: first.indexTree, refs: first.refs });
    assert.strictEqual(r.ok, true);
  } finally {
    releaseSnapshot(first);
  }
  write(repo, 'a.txt', 'alpha second job\n');
  const second = await snapshotTree(repo);
  try {
    const pack = await packOf(second, { have: [first.head] });
    const r = await ingestPack(pack, { workDir, repoKey: second.repoKey, snap: second.snap, indexTree: second.indexTree, refs: second.refs });
    assert.strictEqual(r.ok, true);
    const dir = path.join(root, 'job2', 'tree');
    const done = await materialize({ mirror: r.mirror, dir, snap: second.snap, treeHash: second.treeHash, indexTree: second.indexTree, head: second.head, branch: second.branch, refs: second.refs });
    assert.deepStrictEqual(done, { ok: true, dir });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'alpha second job\n');
  } finally {
    releaseSnapshot(second);
  }
});

test('a racily clean entry in the real index is re-read, not trusted from a copied index', async () => {
  const { root, repo } = baseRepo();
  g(repo, 'config', 'core.trustctime', 'false');
  const T = new Date('2020-01-01T00:00:00Z');
  const file = path.join(repo, 'a.txt');
  write(repo, 'a.txt', 'aaaa\n');
  fs.utimesSync(file, T, T);
  g(repo, 'add', 'a.txt');
  write(repo, 'a.txt', 'bbbb\n');
  fs.utimesSync(file, T, T);
  fs.utimesSync(path.join(repo, '.git', 'index'), T, T);
  const snap = await snapshotTree(repo);
  try {
    const workDir = path.join(root, 'work');
    const r = await ingestPack(await packOf(snap), { workDir, repoKey: snap.repoKey, snap: snap.snap, indexTree: snap.indexTree, refs: snap.refs });
    const dir = path.join(root, 'job', 'tree');
    const done = await materialize({ mirror: r.mirror, dir, snap: snap.snap, treeHash: snap.treeHash, indexTree: snap.indexTree, head: snap.head, branch: snap.branch, refs: snap.refs });
    assert.deepStrictEqual(done, { ok: true, dir });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'bbbb\n');
  } finally {
    releaseSnapshot(snap);
  }
  assert.strictEqual(g(repo, 'status', '--porcelain'), 'MM a.txt\n');
});

test('ingestPack and materialize refuse an object id that is not a sha', async () => {
  const { root, repo } = baseRepo();
  const snap = await snapshotTree(repo);
  try {
    const workDir = path.join(root, 'work');
    const job = { workDir, repoKey: snap.repoKey, snap: snap.snap, indexTree: '--index-output=/tmp/x', refs: snap.refs };
    await assert.rejects(ingestPack(Buffer.alloc(0), job), /bad object id: --index-output=\/tmp\/x/);
    assert.strictEqual(fs.existsSync(path.join(workDir, 'mirrors')), false);
    const far = { mirror: path.join(workDir, 'm.git'), dir: path.join(root, 'job', 'tree'), snap: snap.snap, treeHash: snap.treeHash, indexTree: snap.indexTree, head: snap.head, branch: snap.branch, refs: { master: '-q' } };
    await assert.rejects(materialize(far), /bad object id: -q/);
    assert.strictEqual(fs.existsSync(path.join(root, 'job')), false);
  } finally {
    releaseSnapshot(snap);
  }
});

test('a far tree altered after checkout fails the proof', async () => {
  const { root, repo } = baseRepo();
  write(repo, 'a.txt', 'alpha proof\n');
  const { snap, dir } = await roundTrip(root, repo);
  write(dir, 'a.txt', 'tampered\n');
  assert.notStrictEqual(await treeHashOf(dir, { base: snap.snap }), snap.treeHash);
});

test('materialize ends tree-mismatch when the checkout does not hash to the job treeHash', async () => {
  const { root, repo } = baseRepo();
  write(repo, 'a.txt', 'alpha mismatch\n');
  const snap = await snapshotTree(repo);
  try {
    const workDir = path.join(root, 'work');
    const r = await ingestPack(await packOf(snap), { workDir, repoKey: snap.repoKey, snap: snap.snap, indexTree: snap.indexTree, refs: snap.refs });
    const headTree = g(repo, 'rev-parse', 'HEAD^{tree}').trim();
    const done = await materialize({ mirror: r.mirror, dir: path.join(root, 'job', 'tree'), snap: snap.snap, treeHash: headTree, indexTree: snap.indexTree, head: snap.head, branch: snap.branch, refs: snap.refs });
    assert.deepStrictEqual(done, { ok: false, reason: 'tree-mismatch', treeHash: snap.treeHash });
  } finally {
    releaseSnapshot(snap);
  }
});

test('materialize refuses a tree over the cap before any checkout', async () => {
  const { root, repo } = baseRepo();
  const snap = await snapshotTree(repo);
  try {
    const workDir = path.join(root, 'work');
    const r = await ingestPack(await packOf(snap), { workDir, repoKey: snap.repoKey, snap: snap.snap, indexTree: snap.indexTree, refs: snap.refs });
    const dir = path.join(root, 'job', 'tree');
    const done = await materialize({ mirror: r.mirror, dir, snap: snap.snap, treeHash: snap.treeHash, indexTree: snap.indexTree, head: snap.head, branch: snap.branch, refs: snap.refs, treeCap: 10 });
    assert.deepStrictEqual(done, { ok: false, reason: 'too-large' });
    assert.strictEqual(fs.existsSync(dir), false);
  } finally {
    releaseSnapshot(snap);
  }
});

test('the default pack limit is 1 GiB', () => {
  assert.strictEqual(DEFAULT_PACK_MAX, 1073741824);
});

test('materialize pins core.autocrlf=false in the far checkout over a global autocrlf=true', async () => {
  const { root, repo } = baseRepo();
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[core]\n\tautocrlf = true\n');
  const snap = await snapshotTree(repo);
  const savedHome = process.env.HOME;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  try {
    const homeEnv = { ...ENV, HOME: home };
    delete homeEnv.XDG_CONFIG_HOME;
    assert.strictEqual(execFileSync('git', ['config', '--global', 'core.autocrlf'], { env: homeEnv, encoding: 'utf8' }).trim(), 'true');
    const workDir = path.join(root, 'work');
    const r = await ingestPack(await packOf(snap), { workDir, repoKey: snap.repoKey, snap: snap.snap, indexTree: snap.indexTree, refs: snap.refs });
    const dir = path.join(root, 'job', 'tree');
    const done = await materialize({ mirror: r.mirror, dir, snap: snap.snap, treeHash: snap.treeHash, indexTree: snap.indexTree, head: snap.head, branch: snap.branch, refs: snap.refs });
    assert.deepStrictEqual(done, { ok: true, dir });
    assert.strictEqual(execFileSync('git', ['-C', dir, 'config', 'core.autocrlf'], { env: homeEnv, encoding: 'utf8' }).trim(), 'false');
  } finally {
    process.env.HOME = savedHome;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
    releaseSnapshot(snap);
  }
});

test('keepRefs keeps the trunk and the newest 20 job heads; mirrorHave answers only kept commits', async () => {
  const { root, repo } = baseRepo();
  const snap = await snapshotTree(repo);
  try {
    const workDir = path.join(root, 'work');
    const r = await ingestPack(await packOf(snap), { workDir, repoKey: snap.repoKey, snap: snap.snap, indexTree: snap.indexTree, refs: snap.refs });
    assert.deepStrictEqual(await mirrorHave(r.mirror, [snap.head]), []);
    for (let i = 1; i <= 22; i++) {
      await keepRefs(r.mirror, { stamp: i, id: `job${i}`, snap: snap.snap, indexTree: snap.indexTree, trunkSha: snap.refs.master });
    }
    const jobRefs = g(r.mirror, 'for-each-ref', '--format=%(refname)', 'refs/keep/job/').trim().split('\n');
    assert.strictEqual(jobRefs.length, 20);
    assert.strictEqual(jobRefs[0], 'refs/keep/job/000000000000003-job3');
    assert.strictEqual(jobRefs[19], 'refs/keep/job/000000000000022-job22');
    assert.strictEqual(g(r.mirror, 'rev-parse', 'refs/keep/trunk').trim(), snap.refs.master);
    assert.deepStrictEqual(await mirrorHave(r.mirror, [snap.head, 'f'.repeat(40)]), [snap.head]);
  } finally {
    releaseSnapshot(snap);
  }
});

test('detachTree: the tree works with its mirror moved away, and fails without it', async () => {
  for (const detach of [false, true]) {
    const { root, repo } = baseRepo();
    write(repo, 'a.txt', 'alpha modified\n');
    const { snap, dir, status } = await roundTrip(root, repo);
    const alternates = path.join(dir, '.git', 'objects', 'info', 'alternates');
    assert.ok(fs.existsSync(alternates), 'ENTER: the far tree borrows the mirror');
    if (detach) {
      const r = await detachTree(dir);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.error, null);
      assert.strictEqual(typeof r.ms, 'number');
      assert.strictEqual(fs.existsSync(alternates), false);
    }
    const mirror = path.join(root, 'work', 'mirrors', `${snap.repoKey}.git`);
    fs.renameSync(mirror, `${mirror}.moved`);
    const cmds = [['status', '--porcelain'], ['log', '-1'], ['diff', '--cached'], ['fsck']];
    if (!detach) {
      for (const c of cmds) assert.throws(() => g(dir, ...c), undefined, `ENTER: git ${c[0]} fails without detachTree`);
      await assert.rejects(treeHashOf(dir));
      continue;
    }
    assert.strictEqual(g(dir, 'status', '--porcelain'), status);
    assert.match(g(dir, 'log', '-1'), /three/);
    assert.strictEqual(g(dir, 'diff', '--cached'), '');
    g(dir, 'fsck');
    assert.strictEqual(await treeHashOf(dir), snap.treeHash);
  }
});

test('detachTree on a --shared clone leaves no alternates and fsck passes with the source moved away', async () => {
  const { root, repo } = baseRepo();
  const clone = path.join(root, 'clone');
  execFileSync('git', ['clone', '-q', '--shared', repo, clone], { env: ENV });
  const alternates = path.join(clone, '.git', 'objects', 'info', 'alternates');
  assert.ok(fs.existsSync(alternates), 'ENTER: the clone borrows the source');
  const r = await detachTree(clone);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.existsSync(alternates), false);
  fs.renameSync(repo, `${repo}.moved`);
  g(clone, 'fsck');
  assert.match(g(clone, 'log', '-1'), /three/);
});

test('detachTree reports a failed repack', async () => {
  const root = mkTmpRoot('suite-snap-');
  const r = await detachTree(path.join(root, 'nope'));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /^git repack failed: /);
});
