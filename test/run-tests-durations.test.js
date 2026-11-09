const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { parseJunit, durationRows, renderDurations } = require('../scripts/run-tests.js');

const ROOT = path.join(__dirname, '..');
const STUB = "require('node:test').test('stub', () => {});\n";

function tc(name, secs, file) {
  return `<testcase name="${name}" time="${secs}" classname="test" file="${file}"/>`;
}

function runRunner(args, { blockWrite = false, seed = null } = {}) {
  const root = fs.realpathSync(mkTmpRoot('clx-dur-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const f of ['run-tests.js', 'test-escapes.js']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(root, 'scripts', f));
  }
  fs.writeFileSync(path.join(root, 'stub.test.js'), STUB);
  if (blockWrite) fs.mkdirSync(path.join(root, 'last-run-durations.json.tmp'));
  if (seed) fs.writeFileSync(path.join(root, 'last-run-durations.json'), JSON.stringify(seed));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    const res = spawnSync(process.execPath, [path.join(root, 'scripts', 'run-tests.js'), ...args],
      { encoding: 'utf-8', cwd: root, timeout: 120000, env });
    const file = path.join(root, 'last-run-durations.json');
    return {
      out: `${res.stdout || ''}`,
      code: res.status,
      doc: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null,
      root,
    };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('durations: three files become three rows, slowest first, with test counts', () => {
  const xml = `<testsuites>
<testsuite name="s" time="9">
${tc('a1', 0.25, '/r/test/a.test.js')}
${tc('b1', 1.5, '/r/test/b.test.js')}
${tc('c1', 0.5, '/r/test/c.test.js')}
${tc('a2', 0.25, '/r/test/a.test.js')}
${tc('c2', 0.75, '/r/test/c.test.js')}
</testsuite>
</testsuites>`;
  const rows = durationRows(parseJunit(xml), '/r');
  assert.deepStrictEqual(rows, [
    { file: 'test/b.test.js', ms: 1500, tests: 1 },
    { file: 'test/c.test.js', ms: 1250, tests: 2 },
    { file: 'test/a.test.js', ms: 500, tests: 2 },
  ]);
  assert.strictEqual(rows[0].file, 'test/b.test.js');
  assert.strictEqual(rows[0].ms, 1500);
});

test('durations: a full run records the file, an own-style file run writes none', () => {
  const full = runRunner([]);
  assert.strictEqual(full.code, 0);
  assert.ok(full.doc, 'a full run writes last-run-durations.json');
  assert.deepStrictEqual(Object.keys(full.doc), ['at', 'head', 'runMs', 'files']);
  const stub = full.doc.files.find((f) => f.file === 'stub.test.js');
  assert.strictEqual(stub.tests, 1);
  const own = runRunner(['stub.test.js']);
  assert.strictEqual(own.code, 0);
  assert.strictEqual(own.doc, null);
});

test('durations: --durations prints rows and the sum line, and a placeholder with no file', () => {
  const doc = {
    at: 'x', head: null, runMs: 4000,
    files: [{ file: 'test/b.test.js', ms: 1500, tests: 3 }, { file: 'test/a.test.js', ms: 500, tests: 2 }],
  };
  assert.deepStrictEqual(renderDurations(doc), [
    '1500 ms  3 tests  test/b.test.js',
    '500 ms  2 tests  test/a.test.js',
    'sum of files 2000 ms  recorded runMs 4000 ms',
  ]);
  const many = { runMs: 1, files: Array.from({ length: 30 }, (_, i) => ({ file: `f${i}`, ms: 1, tests: 1 })) };
  assert.strictEqual(renderDurations(many).length, 26);

  const seeded = runRunner(['--durations'], { seed: doc });
  assert.strictEqual(seeded.code, 0);
  assert.strictEqual(seeded.out.trim(), renderDurations(doc).join('\n'));
  assert.ok(seeded.out.includes('1500 ms  3 tests  test/b.test.js'));

  const none = runRunner(['--durations']);
  assert.strictEqual(none.code, 0);
  assert.strictEqual(none.out.trim(), 'no recorded full run');
});

test('durations: an unwritable target changes neither exit code nor TOTALS line', () => {
  const r = runRunner([], { blockWrite: true });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.doc, null);
  assert.match(r.out, /^TOTALS: 2 pass, 0 fail, 2 tests$/m);
});
