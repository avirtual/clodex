'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { commentDelta } = require('../scripts/comment-delta.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'comment-delta.js');

const A_BASE = [
  "'use strict';",
  '',
  '// a note at the base',
  'module.exports = 1;',
  '',
].join('\n');

const A_AFTER = [
  "'use strict';",
  '',
  '// a note at the base',
  '/* */',
  'module.exports = 1;',
  '',
].join('\n');

const T_BASE = [
  "'use strict';",
  'module.exports = 2;',
  '',
].join('\n');

const T_AFTER = [
  "'use strict';",
  '// x',
  'module.exports = 2;',
  '',
].join('\n');

function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clx-cdelta-')));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
  execFileSync('git', ['init', '-q', '-b', 'master', root], { stdio: 'ignore' });
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'a.js'), A_BASE);
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test', 't.js'), T_BASE);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { root, head };
}

function addComments(root) {
  fs.writeFileSync(path.join(root, 'a.js'), A_AFTER);
  fs.writeFileSync(path.join(root, 'test', 't.js'), T_AFTER);
}

test('a test/ file that gains a comment line is reported — the row the ratchet drops', () => {
  const { root, head } = makeRepo();
  addComments(root);

  const res = commentDelta({ repo: root, base: head });

  assert.strictEqual(res.added, 2, 'one line added in a.js and one in test/t.js');

  const row = res.files.find((f) => f.file === 'test/t.js');
  assert.ok(
    row,
    'ENTER: the test-dir row must be PRESENT in the result. This is the assertion the '
      + 'whole script exists for: the ratchet excludes every test/ tree at any depth, so a '
      + 'hand reading its green learns nothing about test files. If this row is ever filtered '
      + 'out again, the script is back to duplicating the ratchet and buys nothing.',
  );
  assert.deepStrictEqual(row, { file: 'test/t.js', before: 0, after: 1 });
});

test('a bare /* */ block counts, which a //-only regex would miss', () => {
  const { root, head } = makeRepo();
  addComments(root);

  const res = commentDelta({ repo: root, base: head });
  const row = res.files.find((f) => f.file === 'a.js');

  assert.ok(row, 'a.js must be among the changed files');
  assert.strictEqual(
    row.after,
    row.before + 1,
    'ENTER: the added line in a.js is an EMPTY /* */ block and nothing else. A grep for '
      + "'^+\\s*//' scores it zero, which is exactly how hand-878's rework passed while the "
      + 'block was still there; only the census tokenizer sees it.',
  );
});

test('a clean tree is 0 added and the CLI exits 0; the additions make it exit 1 and name the test file', () => {
  const { root } = makeRepo();

  const clean = commentDelta({ repo: root });
  assert.strictEqual(clean.added, 0, 'an unchanged tree against its own HEAD adds nothing');

  const green = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(green.status, 0, `clean tree should exit 0, got ${green.status}: ${green.stderr}`);
  assert.match(green.stdout, /^comment-delta: 0 added across \d+ changed \.js files \(base [0-9a-f]{7}\)$/m);

  addComments(root);

  const red = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(red.status, 1, `a positive delta should exit 1, got ${red.status}: ${red.stderr}`);
  assert.match(red.stdout, /^test\/t\.js: 0 -> 1 \(\+1\)$/m);
});
