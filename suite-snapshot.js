'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { git, mergeTargetFor } = require('./git-worktree');
const { safeGitArgsFor } = require('./git-safe');

const SNAP_IDENT = {
  GIT_AUTHOR_NAME: 'Clodex',
  GIT_AUTHOR_EMAIL: 'clodex@localhost',
  GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Clodex',
  GIT_COMMITTER_EMAIL: 'clodex@localhost',
  GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z',
};
const CANDIDATES_PER_LINE = 16;
const NEAR_CONFIG = ['-c', 'core.splitIndex=false'];
const RUNNER_CONFIG = ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.splitIndex=false'];
const DEFAULT_TREE_CAP = 2 * 1024 ** 3;
const DEFAULT_PACK_MAX = 256 * 1024 ** 2;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const KEEP_JOBS = 20;
const GC_PACKS = 50;

function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return Object.assign(env, extra);
}

async function run(cwd, args, opts = {}) {
  const r = await git(cwd, args, { maxBuffer: 64 * 1024 * 1024, ...opts, env: cleanEnv(opts.env) });
  if (!r.ok) throw new Error(`git ${args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c')} failed: ${String(r.stderr).trim()}`);
  return r;
}

async function tryRun(cwd, args, opts = {}) {
  return git(cwd, args, { maxBuffer: 64 * 1024 * 1024, ...opts, env: cleanEnv(opts.env) });
}

const text = (r) => String(r.stdout).trim();
const lines = (r) => text(r).split('\n').filter(Boolean);

function scratchStore(tmpRoot) {
  const dir = fs.mkdtempSync(path.join(tmpRoot || os.tmpdir(), 'clodex-snap-'));
  fs.mkdirSync(path.join(dir, 'objects'));
  return dir;
}

function storeEnv(dir, alternate, index) {
  return {
    GIT_OBJECT_DIRECTORY: path.join(dir, 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate,
    GIT_INDEX_FILE: path.join(dir, index),
  };
}

async function repoPaths(dir) {
  const [top, common, index] = lines(await run(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-path', 'index']));
  return { top, objects: path.join(common, 'objects'), index };
}

async function commitOf(cwd, rev) {
  const r = await tryRun(cwd, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]);
  return r.ok ? text(r) : null;
}

async function snapshotTree(treeDir, { trunk, tmpRoot } = {}) {
  const { top, objects, index } = await repoPaths(treeDir);
  const head = await commitOf(top, 'HEAD');
  if (!head) throw new Error(`${top} has no commit to snapshot`);
  const branchRun = await tryRun(top, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = branchRun.ok ? text(branchRun) || null : null;
  const trunkName = trunk || await mergeTargetFor({ root: top }, null);
  const trunkSha = trunkName ? await commitOf(top, trunkName) : null;
  const tmpDir = scratchStore(tmpRoot);
  try {
    const hasIndex = fs.existsSync(index);
    if (hasIndex) {
      const st = fs.statSync(index);
      for (const copy of ['index', 'index-staged']) {
        fs.copyFileSync(index, path.join(tmpDir, copy));
        fs.utimesSync(path.join(tmpDir, copy), st.atime, st.mtime);
      }
    }
    const env = storeEnv(tmpDir, objects, 'index');
    const headTree = text(await run(top, ['rev-parse', `${head}^{tree}`]));
    const staged = await tryRun(top, [...NEAR_CONFIG, 'write-tree'], { env: storeEnv(tmpDir, objects, 'index-staged') });
    const indexTree = hasIndex && staged.ok ?text(staged) : headTree;
    await run(top, [...NEAR_CONFIG, 'add', '-A'], { env });
    const treeHash = text(await run(top, [...NEAR_CONFIG, 'write-tree'], { env }));
    const snap = text(await run(top, ['commit-tree', treeHash, '-p', head, '-m', `clodex suite snapshot\n\nindex-tree ${indexTree}`], { env: { ...env, ...SNAP_IDENT } }));
    const tip = trunkSha || head;
    const roots = lines(await run(top, ['rev-list', '--max-parents=0', tip]));
    const repoKey = roots[roots.length - 1];
    const refs = {};
    if (trunkSha) refs[trunkName] = trunkSha;
    if (branch) refs[branch] = head;
    const candidates = new Set(lines(await run(top, ['rev-list', '--first-parent', '-n', String(CANDIDATES_PER_LINE), head])));
    if (trunkSha) {
      for (const c of lines(await run(top, ['rev-list', '--first-parent', '-n', String(CANDIDATES_PER_LINE), trunkSha]))) candidates.add(c);
      const base = await tryRun(top, ['merge-base', head, trunkSha]);
      if (base.ok && text(base)) candidates.add(text(base));
    }
    return {
      snap, treeHash, indexTree, headTree, head, branch, trunk: trunkSha ? trunkName : null, repoKey, refs,
      candidates: [...candidates], cwd: top, alternate: objects, tmpDir,
    };
  } catch (e) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }
}

function releaseSnapshot(snapshot) {
  if (snapshot && snapshot.tmpDir) fs.rmSync(snapshot.tmpDir, { recursive: true, force: true });
}

async function buildPack(snapshot, { have = [], maxBytes = Infinity } = {}) {
  const env = storeEnv(snapshot.tmpDir, snapshot.alternate, 'index');
  const asked = have.filter((h) => SHA_RE.test(h));
  let known = [];
  if (asked.length) {
    const check = await run(snapshot.cwd, ['cat-file', '--batch-check'], { env, input: `${asked.join('\n')}\n` });
    known = lines(check).filter((l) => / commit /.test(l)).map((l) => l.split(' ')[0]);
  }
  const revs = [snapshot.snap, snapshot.indexTree, ...Object.values(snapshot.refs), ...known.map((h) => `^${h}`)];
  const argv = await safeGitArgsFor(snapshot.cwd, ['pack-objects', '--revs', '--stdout', '-q', '--delta-base-offset']);
  const file = path.join(snapshot.tmpDir, `pack-${crypto.randomUUID()}.pack`);
  const fd = fs.openSync(file, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let over = false;
  let stderr = '';
  let failed = null;
  const child = spawn('git', argv, { env: cleanEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise((resolve) => {
    child.on('error', (e) => { failed = e; });
    child.on('close', (code) => resolve(code));
  });
  child.stdin.on('error', () => {});
  child.stdin.end(`${revs.join('\n')}\n`);
  child.stderr.on('data', (d) => { if (stderr.length < 4096) stderr += String(d); });
  child.stdout.on('data', (chunk) => {
    if (over || failed) return;
    if (bytes + chunk.length > maxBytes) {
      over = true;
      bytes += chunk.length;
      child.kill('SIGKILL');
      return;
    }
    try {
      fs.writeSync(fd, chunk);
    } catch (e) {
      failed = e;
      child.kill('SIGKILL');
      return;
    }
    hash.update(chunk);
    bytes += chunk.length;
  });
  const code = await closed;
  fs.closeSync(fd);
  if (over) return { file, bytes, over: true };
  if (failed || code !== 0) {
    fs.rmSync(file, { force: true });
    throw new Error(`git pack-objects failed: ${failed ? failed.message : stderr.trim()}`);
  }
  return { file, bytes, sha256: hash.digest('hex') };
}

function assertShas(shas) {
  for (const sha of shas) if (!SHA_RE.test(String(sha))) throw new Error(`bad object id: ${sha}`);
}

function mirrorPath(workDir, repoKey) {
  if (!SHA_RE.test(String(repoKey))) throw new Error(`bad repoKey: ${repoKey}`);
  return path.join(workDir, 'mirrors', `${repoKey}.git`);
}

async function gitFromFile(cwd, args, { file, bytes }, readChunk) {
  const argv = await safeGitArgsFor(cwd, args);
  return new Promise((resolve) => {
    const child = spawn('git', argv, { env: cleanEnv(), stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    let failed = null;
    child.stderr.on('data', (d) => { if (stderr.length < 4096) stderr += String(d); });
    child.stdin.on('error', () => {});
    const input = fs.createReadStream(file, { highWaterMark: readChunk, start: 0, end: Math.max(bytes - 1, 0) });
    input.on('error', (e) => { failed = e; child.kill('SIGKILL'); });
    input.pipe(child.stdin);
    child.on('error', (e) => { failed = e; });
    child.on('close', (code) => resolve({ ok: !failed && code === 0, code, stderr: failed ? failed.message : stderr }));
  });
}

async function ingestPack(pack, { workDir, repoKey, snap, indexTree, refs = {}, maxInputSize = DEFAULT_PACK_MAX, readChunk = 1024 ** 2 }) {
  assertShas([snap, indexTree, ...Object.values(refs)]);
  const mirror = mirrorPath(workDir, repoKey);
  if (!fs.existsSync(path.join(mirror, 'HEAD'))) {
    fs.mkdirSync(mirror, { recursive: true });
    fs.chmodSync(mirror, 0o700);
    await run(path.dirname(mirror), [...RUNNER_CONFIG, 'init', '-q', '--bare', mirror]);
  }
  const indexArgs = [...RUNNER_CONFIG, 'index-pack', '--stdin', '--fsck-objects', `--max-input-size=${maxInputSize}`];
  const indexed = Buffer.isBuffer(pack)
    ? await tryRun(mirror, indexArgs, { input: pack })
    : await gitFromFile(mirror, indexArgs, pack, readChunk);
  if (!indexed.ok) return { ok: false, reason: 'bad-pack', mirror, error: String(indexed.stderr).trim() };
  const tips = [snap, indexTree, ...Object.values(refs)];
  const connected = await tryRun(mirror, [...RUNNER_CONFIG, 'rev-list', '--objects', '--quiet', ...tips]);
  if (!connected.ok) return { ok: false, reason: 'incomplete', mirror };
  return { ok: true, mirror };
}

async function treeSize(mirror, snap) {
  const r = await run(mirror, [...RUNNER_CONFIG, 'ls-tree', '-r', '-l', '-z', snap], { maxBuffer: 256 * 1024 * 1024 });
  let total = 0;
  for (const entry of String(r.stdout).split('\0')) {
    const size = Number(entry.split('\t')[0].trim().split(/\s+/)[3]);
    if (Number.isFinite(size)) total += size;
  }
  return total;
}

async function treeHashOf(dir, { base = 'HEAD', tmpRoot } = {}) {
  const { top, objects } = await repoPaths(dir);
  const tmpDir = scratchStore(tmpRoot);
  try {
    const env = storeEnv(tmpDir, objects, 'index');
    await run(top, [...RUNNER_CONFIG, 'read-tree', base], { env });
    await run(top, [...RUNNER_CONFIG, 'add', '-A'], { env });
    return text(await run(top, [...RUNNER_CONFIG, 'write-tree'], { env }));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function materialize({ mirror, dir, snap, treeHash, indexTree, head, branch = null, refs = {}, treeCap = DEFAULT_TREE_CAP, tmpRoot }) {
  assertShas([snap, treeHash, indexTree, head, ...Object.values(refs)]);
  if (await treeSize(mirror, snap) > treeCap) return { ok: false, reason: 'too-large' };
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await run(path.dirname(dir), [...RUNNER_CONFIG, 'init', '-q', dir]);
  fs.writeFileSync(path.join(dir, '.git', 'objects', 'info', 'alternates'), `${path.join(mirror, 'objects')}\n`);
  await run(dir, ['config', 'core.autocrlf', 'false']);
  await run(dir, ['config', 'core.hooksPath', '/dev/null']);
  for (const [name, sha] of Object.entries(refs)) await run(dir, [...RUNNER_CONFIG, 'update-ref', `refs/heads/${name}`, sha]);
  if (branch) {
    await run(dir, [...RUNNER_CONFIG, 'update-ref', `refs/heads/${branch}`, head]);
    await run(dir, [...RUNNER_CONFIG, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  } else {
    await run(dir, [...RUNNER_CONFIG, 'update-ref', '--no-deref', 'HEAD', head]);
  }
  await run(dir, [...RUNNER_CONFIG, 'read-tree', '--reset', '-u', snap]);
  await run(dir, [...RUNNER_CONFIG, 'read-tree', '-m', indexTree]);
  await run(dir, [...RUNNER_CONFIG, 'update-index', '-q', '--refresh']);
  const proof = await treeHashOf(dir, { base: snap, tmpRoot });
  if (proof !== treeHash) return { ok: false, reason: 'tree-mismatch', treeHash: proof };
  return { ok: true, dir };
}

async function mirrorHave(mirror, candidates = []) {
  const asked = candidates.filter((c) => SHA_RE.test(String(c)));
  if (!asked.length || !fs.existsSync(mirror)) return [];
  const reachable = await tryRun(mirror, [...RUNNER_CONFIG, 'rev-list', '--all']);
  if (!reachable.ok) return [];
  const all = new Set(lines(reachable));
  return asked.filter((c) => all.has(c));
}

async function mirrorHolds(mirror, tips) {
  assertShas(tips);
  if (!fs.existsSync(mirror)) return false;
  return (await tryRun(mirror, [...RUNNER_CONFIG, 'rev-list', '--objects', '--quiet', ...tips])).ok;
}

async function keepRefs(mirror, { stamp, id, snap, indexTree, trunkSha = null, keep = KEEP_JOBS }) {
  assertShas([snap, indexTree, ...(trunkSha ? [trunkSha] : [])]);
  const tag = `${String(stamp).padStart(15, '0')}-${id}`;
  if (!/^[0-9]{15}-[A-Za-z0-9._-]{1,64}$/.test(tag)) throw new Error(`bad keep tag: ${tag}`);
  if (trunkSha) await run(mirror, [...RUNNER_CONFIG, 'update-ref', 'refs/keep/trunk', trunkSha]);
  await run(mirror, [...RUNNER_CONFIG, 'update-ref', `refs/keep/job/${tag}`, snap]);
  await run(mirror, [...RUNNER_CONFIG, 'update-ref', `refs/keep/index/${tag}`, indexTree]);
  for (const kind of ['job', 'index']) {
    const names = lines(await run(mirror, [...RUNNER_CONFIG, 'for-each-ref', '--format=%(refname)', `refs/keep/${kind}/`])).sort();
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
      await run(mirror, [...RUNNER_CONFIG, 'update-ref', '-d', name]);
    }
  }
}

function packCount(mirror) {
  try {
    return fs.readdirSync(path.join(mirror, 'objects', 'pack')).filter((f) => f.endsWith('.pack')).length;
  } catch { return 0; }
}

async function gcMirror(mirror, { maxPacks = GC_PACKS } = {}) {
  if (packCount(mirror) <= maxPacks) return false;
  await run(mirror, [...RUNNER_CONFIG, 'gc', '-q', '--prune=now']);
  return true;
}

module.exports = {
  snapshotTree, releaseSnapshot, buildPack, ingestPack, materialize, treeHashOf,
  mirrorPath, mirrorHave, mirrorHolds, keepRefs, packCount, gcMirror, DEFAULT_PACK_MAX,
};
