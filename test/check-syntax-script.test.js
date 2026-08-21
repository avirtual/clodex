// Pins for scripts/check-syntax.sh, the `check-syntax` exec registry entry.
//
// WHY THIS EXISTS. The script's whole job is to be TRUSTED without being read:
// a hand runs it, gets one line back, and reports on that. So its failure mode
// is not a crash, it is a GREEN over code it never opened — and it has now had
// that bug twice, through two different doors. The header names the first
// (wrong tree) and calls it worse than no check at all. The second was the
// commit door: the file list came from `git diff --name-only HEAD`, hands are
// instructed to commit as they go, and after a commit HEAD *is* the change, so
// the list came back empty and the empty case was a SUCCESS path. Reproduced
// both ways on one worktree in 2026-08: identical broken bytes gave
// "SYNTAX: ... exit 1" uncommitted and "syntax OK" once committed.
//
// These tests run the REAL script against throwaway git repos rather than
// reimplementing its logic — a reimplementation would stay green while the
// script rotted, which is precisely the class of bug being pinned. Each one
// asserts the digest it got is the digest for the state it BUILT: a fixture
// that quietly failed to reach "clean tree, commits on branch" would sail
// through an assertion that only said "not green".

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-syntax.sh');

const BROKEN_JS = 'function (((broken {\n';   // the byte sequence from the live repro
const GOOD_JS = 'const a = 1;\n';

function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Runs the script the way the dispatcher does: JSON payload on stdin, and only
// the LAST stderr line is the answer (200-char slice). The full line list comes
// back too, because "one bounded line" IS the contract — a script that printed a
// diagnostic before its verdict would look fine to a test reading only the tail.
function runScript(script, cwd, payload) {
  const res = spawnSync('sh', [script], {
    cwd, input: JSON.stringify(payload), encoding: 'utf-8', timeout: 30000,
  });
  // A spawn that never ANSWERED, told apart from one that answered wrongly: a
  // starved harness must not read as "the script wrote nothing", which is a
  // claim about the code under test.
  if (res.error) assert.fail(`script never answered: ${res.error.code || res.error.message}`);
  if (res.status === null && res.signal) assert.fail(`script killed by ${res.signal}`);
  const lines = String(res.stderr || '').split('\n').filter((l) => l.length > 0);
  return { digest: lines[lines.length - 1] || '', lines, status: res.status };
}

// A repo with the real script inside it (the script locates its root from its
// own path, so it has to live in the fixture), plus a worktree on a branch —
// the shape every hand actually runs in.
function withFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-check-syntax-'));
  try {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'master']);
    fs.mkdirSync(path.join(repo, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(repo, 'scripts', 'check-syntax.sh'));
    fs.writeFileSync(path.join(repo, 'seed.js'), GOOD_JS);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);
    const wt = path.join(dir, 'wt-feat');
    git(repo, ['worktree', 'add', '-q', '-b', 'feat', wt, 'master']);
    const script = path.join(repo, 'scripts', 'check-syntax.sh');
    const check = (tree) => runScript(script, repo, { tree });
    return fn({ dir, repo, wt, check });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// THE TICKET. Same bytes, both sides of a commit — the pair is the test, since
// either half alone is satisfied by a script that always says one thing.
test('check-syntax: a syntax error is caught whether or not it has been committed', () => {
  withFixture(({ wt, check }) => {
    fs.writeFileSync(path.join(wt, 'broken.js'), BROKEN_JS);

    const dirty = check(wt);
    assert.match(dirty.digest, /^SYNTAX: broken\.js: /, 'uncommitted breakage must be reported');
    assert.strictEqual(dirty.status, 1);

    git(wt, ['add', 'broken.js']);
    git(wt, ['commit', '-qm', 'commit the breakage']);

    // ENTER: the state this test exists for is "clean tree, commits on branch".
    // A fixture that failed to commit would leave the tree dirty and pass the
    // assertions below off the HEAD path, testing nothing new.
    assert.strictEqual(git(wt, ['status', '--porcelain']).trim(), '',
      'ENTER: the tree must be CLEAN — otherwise this is still the vs-HEAD path');
    assert.strictEqual(git(wt, ['rev-list', '--count', 'master..feat']).trim(), '1',
      'ENTER: the branch must carry the breakage as a commit');

    const committed = check(wt);
    assert.match(committed.digest, /^SYNTAX: broken\.js: /,
      'a committed syntax error must NOT read as green — this is the false green t452 fixed');
    assert.strictEqual(committed.status, 1);
  });
});

test('check-syntax: a clean tree with good commits reports the files the BRANCH changed, and its base', () => {
  withFixture(({ wt, check }) => {
    fs.writeFileSync(path.join(wt, 'added.js'), GOOD_JS);
    fs.writeFileSync(path.join(wt, 'seed.js'), 'const a = 2;\n');
    git(wt, ['add', 'added.js', 'seed.js']);
    git(wt, ['commit', '-qm', 'two files']);
    assert.strictEqual(git(wt, ['status', '--porcelain']).trim(), '', 'ENTER: tree must be clean');

    const r = check(wt);
    assert.strictEqual(r.status, 0);
    // ENTER, in the digest itself: a nonzero COUNT is the proof it opened the
    // committed files. "syntax OK" alone is also what the old false green said.
    const m = r.digest.match(/^syntax OK \((\d+) files vs base (\S+)/);
    assert.ok(m, `digest must name a file count and a base, got: ${r.digest}`);
    assert.strictEqual(m[1], '2', 'both committed .js files must have been checked');
    assert.match(m[2], /^master@[0-9a-f]{7}$/, 'the base used must be named, ref and sha');
  });
});

// BASE PRECEDENCE, and why it is not a detail. The base decides what the digest
// is a claim ABOUT. Preferring `origin/HEAD` (as git-worktree.js `defaultBranch`
// does, for the different question of where a branch forks FROM) measured 14
// changed files on a branch that changed 1, because origin/master sat 42 commits
// behind local master — 13 files already merged and already checked. That gap
// grows without bound between releases, so a green drifts from "this branch is
// clean" toward "the repo is clean". `isMerged` rejects `defaultBranch` for this
// same reason: the base has to be the branch the operator actually merges into.
test('check-syntax: the base is the LOCAL master, not a stale origin/HEAD', () => {
  withFixture(({ repo, wt, check }) => {
    // A stale remote: origin/master (and origin/HEAD) pinned at the seed commit
    // while local master moves on, which is this repo's steady state between
    // releases.
    const staleSha = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['update-ref', 'refs/remotes/origin/master', staleSha]);
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);

    // Local master advances by a file that is NOT this branch's work.
    fs.writeFileSync(path.join(repo, 'already-merged.js'), GOOD_JS);
    git(repo, ['add', 'already-merged.js']);
    git(repo, ['commit', '-qm', 'someone else, already merged']);

    // The branch does its own single-file work on top.
    git(wt, ['merge', '-q', 'master']);
    fs.writeFileSync(path.join(wt, 'mine.js'), GOOD_JS);
    git(wt, ['add', 'mine.js']);
    git(wt, ['commit', '-qm', 'my work']);

    // ENTER: the two bases must genuinely DISAGREE, or this test pins nothing —
    // it would pass under either precedence.
    assert.strictEqual(git(wt, ['status', '--porcelain']).trim(), '', 'ENTER: tree must be clean');
    const viaLocal = git(wt, ['diff', '--name-only', 'master', 'HEAD', '--', '*.js']).trim();
    const viaRemote = git(wt, ['diff', '--name-only', 'origin/master', 'HEAD', '--', '*.js']).trim();
    assert.strictEqual(viaLocal, 'mine.js', 'ENTER: local master must see exactly the branch work');
    assert.strictEqual(viaRemote.split('\n').sort().join(','), 'already-merged.js,mine.js',
      'ENTER: the stale remote must see MORE — otherwise the bases agree and nothing is pinned');

    const r = check(wt);
    assert.strictEqual(r.status, 0);
    const m = r.digest.match(/^syntax OK \((\d+) files vs base (\S+)@/);
    assert.ok(m, `digest must name a count and a base, got: ${r.digest}`);
    assert.strictEqual(m[1], '1', 'only the branch\'s own file may be counted, not already-merged work');
    assert.strictEqual(m[2], 'master', 'the base named must be the LOCAL branch, not origin/master');
  });
});

// The FALLBACK arm of that precedence, which the fixture above cannot reach: it
// always has a local master, so a build that deleted the origin/HEAD fallback
// outright stayed green across every other test here. A repo whose trunk lives
// only on the remote is the case that distinguishes "prefer local" from "ignore
// the remote", and only this test enters it.
test('check-syntax: with no local main/master, the base falls back to origin/HEAD', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-check-syntax-remote-'));
  try {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'dev']);
    fs.mkdirSync(path.join(repo, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(repo, 'scripts', 'check-syntax.sh'));
    fs.writeFileSync(path.join(repo, 'seed.js'), GOOD_JS);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);
    const trunk = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['update-ref', 'refs/remotes/origin/trunk', trunk]);
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);

    const wt = path.join(dir, 'wt-feat');
    git(repo, ['worktree', 'add', '-q', '-b', 'feat', wt, 'dev']);
    fs.writeFileSync(path.join(wt, 'mine.js'), GOOD_JS);
    git(wt, ['add', 'mine.js']);
    git(wt, ['commit', '-qm', 'my work']);

    // ENTER: no local main/master may exist, or this never reaches the fallback.
    const heads = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']).trim().split('\n');
    assert.ok(!heads.includes('main') && !heads.includes('master'),
      `ENTER: no local main/master, got: ${heads.join(',')}`);
    assert.strictEqual(git(wt, ['status', '--porcelain']).trim(), '', 'ENTER: tree must be clean');

    const r = runScript(path.join(repo, 'scripts', 'check-syntax.sh'), repo, { tree: wt });
    assert.strictEqual(r.status, 0, `expected a green, got: ${r.lines.join(' | ')}`);
    const m = r.digest.match(/^syntax OK \((\d+) files vs base (\S+)@/);
    assert.ok(m, `digest must name a count and a base, got: ${r.digest}`);
    assert.strictEqual(m[1], '1');
    assert.strictEqual(m[2], 'origin/trunk', 'the remote trunk must be named as the base actually used');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('check-syntax: a clean tree on a branch with NO commits is the one truthful empty answer', () => {
  withFixture(({ wt, check }) => {
    assert.strictEqual(git(wt, ['rev-list', '--count', 'master..feat']).trim(), '0',
      'ENTER: the branch must genuinely have no commits');

    const r = check(wt);
    assert.strictEqual(r.status, 0);
    assert.match(r.digest, /^syntax OK \(no changed \.js files vs base master@[0-9a-f]{7}/,
      'empty is truthful here, but it must still say what it compared against');
  });
});

// THE LAST RESORT, and the one green in this script that is worth distrusting.
// With no local main/master and no origin/HEAD, the base degrades to the current
// branch — which compares the branch to ITSELF and therefore reports zero files
// on a clean tree. That is a green over nothing, the shape this whole script was
// fixed for. What keeps it honest is that the digest names the base it used, so
// a reader sees `vs base feat@…` — the branch's own name — rather than a bare
// "syntax OK". This test exists to keep that arm reachable and that wording
// intact; the wording IS the mitigation, so a build that dropped the base from
// the digest here would be indistinguishable from the original bug.
test('check-syntax: with no trunk at all, the base degrades to the branch and SAYS so', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-check-syntax-notrunk-'));
  try {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'dev']);
    fs.mkdirSync(path.join(repo, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(repo, 'scripts', 'check-syntax.sh'));
    fs.writeFileSync(path.join(repo, 'seed.js'), GOOD_JS);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);
    const wt = path.join(dir, 'wt-feat');
    git(repo, ['worktree', 'add', '-q', '-b', 'feat', wt, 'dev']);
    fs.writeFileSync(path.join(wt, 'mine.js'), GOOD_JS);
    git(wt, ['add', 'mine.js']);
    git(wt, ['commit', '-qm', 'my work']);

    // ENTER: neither a local main/master nor an origin/HEAD may exist, or the
    // run never reaches the last resort and this asserts about another arm.
    const heads = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']).trim().split('\n');
    assert.ok(!heads.includes('main') && !heads.includes('master'), 'ENTER: no local trunk');
    assert.strictEqual(
      spawnSync('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: repo }).status !== 0,
      true, 'ENTER: no origin/HEAD either');
    assert.strictEqual(git(wt, ['status', '--porcelain']).trim(), '', 'ENTER: tree must be clean');

    const r = runScript(path.join(repo, 'scripts', 'check-syntax.sh'), repo, { tree: wt });
    assert.strictEqual(r.status, 0);
    // The degraded answer, stated in full rather than matched loosely: it is a
    // zero, and it must carry the branch's own name as the base.
    assert.match(r.digest, /^syntax OK \(no changed \.js files vs base feat@[0-9a-f]{7}/,
      `a self-comparison must name the branch as its base, got: ${r.digest}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('check-syntax: the digest is a single bounded line in every state', () => {
  withFixture(({ wt, check }) => {
    const states = [];
    states.push(check(wt));                                          // clean, no commits
    fs.writeFileSync(path.join(wt, 'broken.js'), BROKEN_JS);
    states.push(check(wt));                                          // dirty, broken
    git(wt, ['add', 'broken.js']);
    git(wt, ['commit', '-qm', 'x']);
    states.push(check(wt));                                          // clean, broken commit
    states.push(check(path.join(wt, 'nope')));                       // refusal
    assert.strictEqual(states.length, 4);
    for (const s of states) {
      assert.strictEqual(s.lines.length, 1, `expected exactly one stderr line, got: ${s.lines.join(' | ')}`);
      assert.ok(s.digest.length <= 200, `digest exceeds the 200-char dispatcher slice: ${s.digest.length}`);
    }
  });
});

// NOT WEAKENED BY t452. The allowlist walk is a security property: membership in
// `git worktree list` IS the authorization, and both the refusal and its
// loudness are load-bearing — a fallback to the root here rebuilds the original
// false green.
test('check-syntax: a path outside the repo is refused, not silently checked against the root', () => {
  withFixture(({ check }) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-not-a-worktree-'));
    try {
      const r = check(outside);
      assert.strictEqual(r.status, 1);
      assert.match(r.digest, /^refused, nothing checked: not a worktree of this repo/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('check-syntax: an empty tree value is refused rather than falling through to the root', () => {
  withFixture(({ repo }) => {
    const r = runScript(path.join(repo, 'scripts', 'check-syntax.sh'), repo, { tree: '' });
    assert.strictEqual(r.status, 1);
    assert.match(r.digest, /^refused, nothing checked: not a worktree of this repo/);
  });
});

// The clean-tree path can only be honest if a base EXISTS. Where none resolves,
// the answer is "I did not check", never "OK" — that is the same distinction the
// wrong-tree path draws, and dropping it here would reintroduce the bug behind a
// clean tree instead of a committed one.
test('check-syntax: a clean tree with no resolvable base refuses instead of reporting green', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-check-syntax-unborn-'));
  try {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'master']);
    fs.mkdirSync(path.join(repo, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(repo, 'scripts', 'check-syntax.sh'));
    // ENTER: unborn HEAD — no commit, so no ref to compare a clean tree against.
    assert.strictEqual(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repo }).status !== 0,
      true, 'ENTER: HEAD must be unborn');

    const r = runScript(path.join(repo, 'scripts', 'check-syntax.sh'), repo, { tree: repo });
    assert.strictEqual(r.status, 1, `expected a refusal, got: ${r.lines.join(' | ')}`);
    assert.match(r.digest, /^refused, nothing checked: clean tree and no base ref/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
