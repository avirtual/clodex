'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { mkTmpRoot } = require('./lib/tmp-roots');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'clodex-commit.js');

function git(root, ...args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return String(r.stdout || '');
}

function put(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function mkRepo() {
  const root = fs.realpathSync(mkTmpRoot('cx-commit-'));
  git(root, 'init', '-q', '-b', 'master');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'T');
  put(root, 'lib/widget.js', "'use strict';\nmodule.exports = 1;\n");
  put(root, 'scripts/comment-delta.js', fs.readFileSync(path.join(REPO, 'scripts', 'comment-delta.js')));
  put(root, 'comment-census.js', fs.readFileSync(path.join(REPO, 'comment-census.js')));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'checkout', '-q', '-b', 'feature');
  return root;
}

function run(root, payload) {
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 60000,
  });
  const lines = String(res.stderr || '').split('\n').filter((l) => l.trim());
  return { code: res.status, digest: lines.length ? lines[lines.length - 1] : '' };
}

function headFiles(root) {
  return git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
}

test('the green path: the named files are staged, committed, and the digest names the sha', () => {
  const root = mkRepo();
  try {
    put(root, 'lib/widget.js', "'use strict';\nmodule.exports = 2;\n");
    put(root, 'lib/other.js', "'use strict';\nmodule.exports = 3;\n");
    const r = run(root, { paths: ['lib/widget.js'], message: 'widget: bump\n\nbody' });
    assert.strictEqual(r.code, 0, r.digest);
    const sha = git(root, 'rev-parse', '--short', 'HEAD').trim();
    assert.strictEqual(r.digest, `committed ${sha}: 1 file(s) — widget: bump`);
    assert.deepStrictEqual(headFiles(root), ['lib/widget.js'],
      'ENTER: the whole reason a hand may not reach for `git add -A` — a file it did not name '
      + '(another seat\'s work, a red-proof\'s in-flight revert) must not ride along');
    assert.ok(fs.existsSync(path.join(root, 'lib/other.js')), 'the unnamed file survives on disk');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a comment added to a tracked .js is refused, and NOTHING is staged', () => {
  const root = mkRepo();
  try {
    put(root, 'lib/widget.js', "'use strict';\n// a new comment line\nmodule.exports = 2;\n");
    const before = git(root, 'rev-parse', 'HEAD').trim();
    const r = run(root, { paths: ['lib/widget.js'], message: 'widget: bump' });
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.digest, 'refused: comment ratchet +1 in lib/widget.js');
    assert.strictEqual(git(root, 'rev-parse', 'HEAD').trim(), before, 'no commit was made');
    assert.strictEqual(git(root, 'diff', '--cached', '--name-only').trim(), '',
      'ENTER: the refusal must come BEFORE staging — a run that staged and then refused would leave '
      + 'an index the seat did not build and cannot see');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a path outside the tree is refused before git is asked to stage anything', () => {
  const root = mkRepo();
  try {
    put(root, 'lib/widget.js', "'use strict';\nmodule.exports = 2;\n");
    const r = run(root, { paths: ['../escape.js'], message: 'nope' });
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.digest, 'refused: path escapes the tree — ../escape.js');
    assert.strictEqual(git(root, 'diff', '--cached', '--name-only').trim(), '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an absolute path is refused too — the escape is not spelled only with ..', () => {
  const root = mkRepo();
  try {
    const abs = path.join(root, 'lib', 'widget.js');
    put(root, 'lib/widget.js', "'use strict';\nmodule.exports = 2;\n");
    const r = run(root, { paths: [abs], message: 'nope' });
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.digest, `refused: path must be relative to the tree — ${abs}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a directory is refused — a whole-tree add must be unrepresentable', () => {
  const root = mkRepo();
  try {
    put(root, 'lib/widget.js', "'use strict';\nmodule.exports = 2;\n");
    const r = run(root, { paths: ['lib'], message: 'nope' });
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.digest, 'refused: a directory is not a file — lib');
    assert.strictEqual(git(root, 'diff', '--cached', '--name-only').trim(), '',
      'ENTER: `git add -- lib` is exactly the sweep this command exists to make impossible; a refusal '
      + 'that still staged the subtree would be no guard');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an empty paths list is refused, and so is a missing one', () => {
  const root = mkRepo();
  try {
    assert.strictEqual(run(root, { paths: [], message: 'x' }).digest,
      'refused: `paths` must be a non-empty array of relative file paths');
    assert.strictEqual(run(root, { paths: [], message: 'x' }).code, 1);
    assert.strictEqual(run(root, { message: 'x' }).code, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an empty message is refused', () => {
  const root = mkRepo();
  try {
    put(root, 'lib/widget.js', "'use strict';\nmodule.exports = 2;\n");
    const r = run(root, { paths: ['lib/widget.js'], message: '   ' });
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.digest, 'refused: `message` must be a non-empty string');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('named files with no changes: refused as nothing to commit, not a silent empty commit', () => {
  const root = mkRepo();
  try {
    const before = git(root, 'rev-parse', 'HEAD').trim();
    const r = run(root, { paths: ['lib/widget.js'], message: 'noop' });
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.digest, 'refused: nothing to commit for the given paths');
    assert.strictEqual(git(root, 'rev-parse', 'HEAD').trim(), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a tree outside this repo is refused and nothing is committed', () => {
  const root = mkRepo();
  const other = fs.realpathSync(mkTmpRoot('cx-commit-other-'));
  try {
    const r = run(root, { tree: other, paths: ['lib/widget.js'], message: 'x' });
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.digest, `refused, nothing committed: not a worktree of this repo — ${other}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('the bin never spells `git add -A`, `.` or `--amend`', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/['"]-A['"]/.test(src),
    'a whole-tree add may not appear at all: reachable only by editing the bin, which is exactly the '
    + 'edit that would undo the guard, so the source is the only place to pin it');
  assert.ok(!/--amend/.test(src), 'rewriting a commit is not this command\'s job');
  assert.ok(!/['"]push['"]/.test(src), 'pushing is the operator\'s');
});
