// `# head:` in the digest's preserved failure dump names HEAD as it was when the
// run STARTED.
//
// WHY THIS EXISTS. The two `git` subshells used to sit inside
// save_failing_output(), which runs after `node --test` returns — so the header
// named whatever HEAD pointed at a whole suite later, and a commit landing
// mid-run was reported as the commit that had been measured. Observed on t517,
// 2026-08-27: a hand committed a0bf8b6 at 07:31:28Z and a run already in flight
// reported at 07:31:49Z carrying that sha and a still-failing test that passed
// 6/6 in isolation at the same HEAD.
//
// The damage is not the mislabel. "My fix is committed and the suite still reds
// at MY sha" reads as conclusive, and the action it invites is to edit correct
// work — a strictly harmful move made on evidence that only looks sound because
// the sha matched. The timestamps were the sole tell.
//
// THE MID-RUN COMMIT IS THE WHOLE SUBJECT. A run with no concurrent commit
// reports the same sha before and after the fix, so it proves nothing. This
// drives a real commit that lands between the script's capture and its dump.
//
// AGAINST THE SHIPPED SCRIPT, in a throwaway repo of its own: the script locates
// its lock and its measured tree from its own path, so a copy under a private
// tmpdir exercises the real text while colliding with nothing — this file
// usually runs inside a sweep that already holds the real lock, and the digest
// writes to ONE fixed path per box that a test must not clobber (CLODEX_HOME
// redirects it).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'test-digest.sh');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// A repo carrying the script, one always-red test, and a base commit. The red
// test is required, not incidental: the dump is written ONLY on a failing run,
// so a green fixture would assert about a file that is never created.
function mkScratch(testBody) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t518-')));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'test-digest.sh'));
  fs.chmodSync(path.join(dir, 'scripts', 'test-digest.sh'), 0o755);
  fs.writeFileSync(path.join(dir, 'test', 'red.test.js'), testBody);
  git(dir, ['init', '-q', '-b', 'master']);
  git(dir, ['config', 'user.email', 't@t.t']);
  git(dir, ['config', 'user.name', 'T']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'the commit the run measures']);
  return dir;
}

function runDigest(dir) {
  const home = path.join(dir, 'clodex-home');
  fs.mkdirSync(home, { recursive: true });
  // NODE_TEST_CONTEXT must not reach the child, the same scrub every spawn in
  // test-digest-lock.test.js makes: `node --test` sees it, decides it is already
  // inside a test run, and SKIPS every file. The run then produces no tap, the
  // digest takes its "suite did not run" arm, and the fixture's red test never
  // executes — so the mid-run commit never lands and the subject asserts about a
  // sha that could not have moved. Caught here by the ENTER guard below.
  const env = { ...process.env, CLODEX_HOME: home };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync('/bin/sh', [path.join(dir, 'scripts', 'test-digest.sh')], {
    cwd: dir,
    input: '{}',
    encoding: 'utf8',
    timeout: 60000,
    env,
  });
  // A spawn that never ANSWERED, told apart from one that answered wrongly —
  // test-digest-lock.test.js's rule, for its reason: a starved harness that
  // reads only the dump would report "the script wrote no header" and send the
  // reader to diff a script that is not at fault.
  if (res.error) assert.fail(`the fixture never got an answer from the script: ${res.error.code || res.error.message}`);
  const dump = path.join(home, 'test-failures', 'last.txt');
  assert.ok(fs.existsSync(dump),
    `ENTER: the failing run preserved a dump to read the header off (stderr: ${String(res.stderr).slice(0, 300)})`);
  return fs.readFileSync(dump, 'utf8');
}

test('t518: `# head:` names the commit the run STARTED at, not one that landed under it', () => {
  // The test file commits to its OWN repo as its first act. Ordered after the
  // script's capture by construction — the capture happens before `node --test`
  // is spawned at all — which a timer racing the run can only approximate.
  const dir = mkScratch(
    'const { test } = require("node:test");\n'
    + 'const { execFileSync } = require("node:child_process");\n'
    + 'const fs = require("node:fs");\n'
    + 'const path = require("node:path");\n'
    + 'const repo = path.join(__dirname, "..");\n'
    + 'fs.writeFileSync(path.join(repo, "mid.txt"), "landed mid-run\\n");\n'
    + 'execFileSync("git", ["add", "mid.txt"], { cwd: repo });\n'
    + 'execFileSync("git", ["commit", "-q", "-m", "landed UNDER the run"], { cwd: repo });\n'
    + 'test("deliberately red, so a dump is written at all", () => { throw new Error("red by design"); });\n',
  );
  const shaAtStart = git(dir, ['rev-parse', 'HEAD']);

  // try/finally, as every scratch-root subject in test-digest-lock.test.js does
  // it: cleanup on the success path alone leaks a repo under TMPDIR on every
  // RED run, which is exactly when a box is already accumulating them.
  try {
    const dump = runDigest(dir);

    const shaAfter = git(dir, ['rev-parse', 'HEAD']);
    assert.notStrictEqual(shaAfter, shaAtStart,
      'ENTER: the branch really moved DURING the run — with one sha the subject would '
      + 'pass against the very defect it exists to catch');

    const head = /^# head: .*$/m.exec(dump);
    assert.ok(head, `ENTER: the dump carries a head line at all (got: ${dump.slice(0, 300)})`);
    assert.match(head[0], new RegExp(shaAtStart.slice(0, 7)),
      `the header names HEAD as it was when the run started (got: ${JSON.stringify(head[0])})`);
    assert.ok(!new RegExp(shaAfter.slice(0, 7)).test(head[0]),
      `and NOT the commit that landed under it (got: ${JSON.stringify(head[0])})`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('t518: the dump carries a START time as well as a write time, so a stale run is legible', () => {
  // The two together are the only thing that says how far the tree could have
  // moved under a run. `# when:` alone cannot: a reader comparing it to a commit
  // timestamp has to already suspect the run is stale to think of looking, which
  // is exactly what nobody did on t517.
  // THE TEST SLEEPS, and that is what makes this subject discriminate. A bare
  // `start <= when` is true of two stamps at the same instant, and `date -u`
  // has 1s resolution — so it would stay green with the capture moved back
  // inside save_failing_output, i.e. against the defect. A run held open for
  // >1s forces the two stamps apart, and the assertion is on the GAP.
  const dir = mkScratch(
    'const { test } = require("node:test");\n'
    + 'test("deliberately red, and slow enough to separate the two stamps", async () => {\n'
    + '  await new Promise((r) => setTimeout(r, 2500));\n'
    + '  throw new Error("red by design");\n'
    + '});\n',
  );
  try {
    const dump = runDigest(dir);
    const start = /^# start: (\S+)$/m.exec(dump);
    const when = /^# when: {2}(\S+)$/m.exec(dump);
    assert.ok(start, `the dump records when the run STARTED (got: ${dump.slice(0, 300)})`);
    assert.ok(when, `and when it was written (got: ${dump.slice(0, 300)})`);
    // >=1000ms, not merely ordered: the suite demonstrably ran for ~2.5s
    // between the two, so a `# start:` captured at write time cannot satisfy
    // this. One second of slack against a 2.5s sleep absorbs the 1s stamp
    // resolution without letting the equal-instant case through.
    const gap = Date.parse(when[1]) - Date.parse(start[1]);
    assert.ok(gap >= 1000,
      `the start must precede the write by the run's duration, not merely not follow it `
      + `(start ${start[1]}, when ${when[1]}, gap ${gap}ms)`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
