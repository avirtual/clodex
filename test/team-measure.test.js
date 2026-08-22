// Run: node --test
// Covers team-measure: the five findings against real fixture directories in a
// temp dir, including every `absent` arm.
//
// Findings are asserted as WHOLE OBJECTS (deepStrictEqual), never by a regex
// over `claim`. That is not style. A claim sentence is exactly the kind of
// string a loose regex matches in ALL of its arms, and this repo has a measured
// instance: t472's /CHANGELOG/ was true of all three outcomes and stayed green
// through nine wrong firings. A whole-object compare also catches the shape
// bugs a field probe reads around — an `evidence` that never got set, a
// `status` that came back undefined.
//
// Where a test reduces the array before asserting, it first asserts the
// interesting row SURVIVED the reduction (`ENTER:`): a .find() returning
// undefined makes every assertion downstream of it vacuous.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { createTeamMeasure, FINDING_IDS, STATUSES } = require('../team-measure');

function gitAvailable() {
  try { childProcess.execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

// A fixture directory: { 'package.json': '…', 'sub/x': '…' } written verbatim.
function fixture(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-tm-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

function gitInit(dir, { commit = true } = {}) {
  const run = (...a) => childProcess.execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 't@example.com');
  run('config', 'user.name', 'Test');
  if (commit) {
    fs.writeFileSync(path.join(dir, '.keep'), '\n');
    run('add', '-A');
    run('commit', '-qm', 'init');
  }
  return dir;
}

function measurer() {
  return createTeamMeasure({ fs, path, childProcess });
}

// Reduce-with-a-guard: the ENTER assertion is what keeps a typo'd id from
// vacuuming out the deepStrictEqual that follows it.
function pick(findings, id) {
  const hit = findings.find((f) => f.id === id);
  assert.ok(hit, `ENTER: no finding with id "${id}" — every assertion about it below is vacuous`);
  return hit;
}

// ---- the invariant that governs the whole module ---------------------------

test('measure: always returns all five ids, in order, whatever the repo looks like', () => {
  // Throwing git stub: no real binary needed, so this — the governing invariant —
  // runs on every machine, and an empty tmpdir cannot accidentally measure vcs
  // through a checkout it happens to sit inside.
  const m = createTeamMeasure({
    fs,
    path,
    childProcess: { execFileSync: () => { throw new Error('not a repository'); } },
  });
  // An empty directory is the worst case for the rule: nothing is measurable,
  // and the array must STILL carry five findings rather than shrink.
  const bare = m.measure(fixture());
  assert.deepStrictEqual(bare.map((f) => f.id), FINDING_IDS);
  assert.strictEqual(bare.length, 5);
  // Every one of them absent — and absent with a real claim sentence, not a
  // blank. A default value here is the failure this module exists to prevent.
  assert.deepStrictEqual(bare.map((f) => f.status), ['absent', 'absent', 'absent', 'absent', 'absent']);
  for (const f of bare) {
    assert.strictEqual(f.evidence, null, `absent ${f.id} must carry null evidence`);
    assert.ok(f.claim.length > 20, `absent ${f.id} must carry an operator-readable claim`);
  }

});

test('measure: a fully-populated repo returns the same five ids, in the same order', { skip: !gitAvailable() }, () => {
  // Split from the invariant test above: that half is the one that must hold on
  // every machine, and calling gitInit inside it turned a git-less box from a
  // tolerated skip into a red suite.
  const rich = measurer().measure(gitInit(fixture({
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    'package-lock.json': '{}',
    '.gitignore': 'dist/\n',
  })));
  assert.deepStrictEqual(rich.map((f) => f.id), FINDING_IDS);
  assert.deepStrictEqual(rich.map((f) => f.status), ['measured', 'measured', 'measured', 'measured', 'measured']);
  for (const f of rich) assert.ok(STATUSES.includes(f.status), `status ${f.status} outside the enum`);
});

// ---- 1. suite --------------------------------------------------------------

test('suite: a node repo with scripts.test', () => {
  const dir = fixture({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
  assert.deepStrictEqual(pick(measurer().measure(dir), 'suite'), {
    id: 'suite',
    claim: 'Your hands will run the suite with `npm test`, not directly.',
    status: 'measured',
    evidence: 'package.json scripts.test',
  });
});

test('suite: NO test command anywhere — absent, with the gap named as a claim', () => {
  // package.json present but scriptless: the near-miss, not just an empty dir.
  const dir = fixture({ 'package.json': JSON.stringify({ name: 'x' }) });
  const findings = measurer().measure(dir);
  // The array does not shrink around the gap.
  assert.deepStrictEqual(findings.map((f) => f.id), FINDING_IDS);
  // The absent claim's WORDING is the contract: the operator has to be able to
  // read the gap and fill it. A guessed `npm test` here would produce a hand
  // running a command nothing in the project defines.
  assert.deepStrictEqual(pick(findings, 'suite'), {
    id: 'suite',
    claim: 'Your hands will NOT have a verified suite command — nothing in this project names one, '
      + 'so tell them how to run the tests or they will not run them.',
    status: 'absent',
    evidence: null,
  });
});

test('suite: an empty scripts.test string is not a command', () => {
  const dir = fixture({ 'package.json': JSON.stringify({ scripts: { test: '' } }) });
  assert.strictEqual(pick(measurer().measure(dir), 'suite').status, 'absent');
});

test('suite: unparseable package.json degrades to absent, never throws', () => {
  const dir = fixture({ 'package.json': '{ not json' });
  assert.strictEqual(pick(measurer().measure(dir), 'suite').status, 'absent');
});

test('suite: Makefile test: target, below package.json in precedence', () => {
  assert.deepStrictEqual(pick(measurer().measure(fixture({ 'Makefile': 'all:\n\techo hi\ntest:\n\techo t\n' })), 'suite'), {
    id: 'suite',
    claim: 'Your hands will run the suite with `make test`, not directly.',
    status: 'measured',
    evidence: 'Makefile test: target',
  });
  // package.json wins when both are present — first hit in the spec's order.
  const both = fixture({
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    'Makefile': 'test:\n\techo t\n',
  });
  assert.strictEqual(pick(measurer().measure(both), 'suite').evidence, 'package.json scripts.test');
});

test('suite: a .PHONY declaration is not a test target', () => {
  const dir = fixture({ 'Makefile': '.PHONY: test\nall:\n\techo hi\n' });
  assert.strictEqual(pick(measurer().measure(dir), 'suite').status, 'absent');
});

test('suite: python / rust / go fallbacks, in the spec order', () => {
  const cases = [
    [{ 'pytest.ini': '[pytest]\n' }, 'pytest', 'pytest.ini'],
    [{ 'tox.ini': '[tox]\n' }, 'tox', 'tox.ini'],
    // The real-world spelling is [tool.pytest.ini_options], not [tool.pytest].
    [{ 'pyproject.toml': '[tool.pytest.ini_options]\nminversion = "6.0"\n' }, 'pytest', 'pyproject.toml [tool.pytest]'],
    [{ 'Cargo.toml': '[package]\nname = "x"\n' }, 'cargo test', 'Cargo.toml'],
    [{ 'go.mod': 'module x\n' }, 'go test ./...', 'go.mod'],
  ];
  for (const [files, cmd, evidence] of cases) {
    assert.deepStrictEqual(pick(measurer().measure(fixture(files)), 'suite'), {
      id: 'suite',
      claim: `Your hands will run the suite with \`${cmd}\`, not directly.`,
      status: 'measured',
      evidence,
    }, `fixture ${evidence}`);
  }
});

test('suite: a pyproject.toml with no [tool.pytest] is not a suite', () => {
  const dir = fixture({ 'pyproject.toml': '[project]\nname = "x"\n' });
  assert.strictEqual(pick(measurer().measure(dir), 'suite').status, 'absent');
});

// ---- 2. packageManager -----------------------------------------------------

test('packageManager: one lockfile decides it', () => {
  const cases = [
    ['package-lock.json', 'npm'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
  ];
  for (const [file, manager] of cases) {
    assert.deepStrictEqual(pick(measurer().measure(fixture({ [file]: '' })), 'packageManager'), {
      id: 'packageManager',
      claim: `Your hands will use \`${manager}\` for installs and script runs, because \`${file}\` is this project's lockfile.`,
      status: 'measured',
      evidence: file,
    }, `lockfile ${file}`);
  }
});

test('packageManager: TWO lockfiles is absent, naming the ambiguity — never a pick', () => {
  const dir = fixture({ 'package-lock.json': '{}', 'pnpm-lock.yaml': '' });
  assert.deepStrictEqual(pick(measurer().measure(dir), 'packageManager'), {
    id: 'packageManager',
    claim: 'Your hands will NOT assume a package manager — this project has more than one lockfile '
      + '(`package-lock.json`, `pnpm-lock.yaml`), so nothing here can say which one is real. '
      + 'Tell them which to use.',
    status: 'absent',
    evidence: null,
  });
});

test("packageManager: a stale `packageManager` FIELD does not override the lockfile", () => {
  // The field says pnpm; the lockfile on disk says npm. The lockfile wins,
  // because the field is frequently stale and believing it installs the wrong
  // dependency graph.
  const dir = fixture({
    'package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
    'package-lock.json': '{}',
  });
  assert.strictEqual(pick(measurer().measure(dir), 'packageManager').evidence, 'package-lock.json');
});

test("packageManager: a field alone, with no lockfile, measures nothing", () => {
  const dir = fixture({ 'package.json': JSON.stringify({ packageManager: 'yarn@4.0.0' }) });
  assert.deepStrictEqual(pick(measurer().measure(dir), 'packageManager'), {
    id: 'packageManager',
    claim: 'Your hands will NOT assume a package manager — this project has no lockfile to name one.',
    status: 'absent',
    evidence: null,
  });
});

test("packageManager: bun's two lockfile names are one manager, not an ambiguity", () => {
  const dir = fixture({ 'bun.lockb': '', 'bun.lock': '' });
  assert.deepStrictEqual(pick(measurer().measure(dir), 'packageManager'), {
    id: 'packageManager',
    claim: "Your hands will use `bun` for installs and script runs, because `bun.lockb` is this project's lockfile.",
    status: 'measured',
    evidence: 'bun.lockb',
  });
});

// ---- 3. vcs ----------------------------------------------------------------

test('vcs: a .git DIRECTORY', { skip: !gitAvailable() }, () => {
  const dir = gitInit(fixture());
  assert.deepStrictEqual(pick(measurer().measure(dir), 'vcs'), {
    id: 'vcs',
    claim: 'Your hands will commit their work to git, on a branch of their own.',
    status: 'measured',
    evidence: '.git (directory)',
  });
});

test('vcs: a .git FILE (a worktree checkout) is still git', () => {
  // The bug this pins: requiring isDirectory() reads every worktree checkout as
  // "no git" — and a worktree IS the tree the hands are dispatched into, so
  // that failure fires on the common case, not an exotic one. No git binary
  // needed: the .git file's presence is the whole measurement.
  const dir = fixture({ '.git': 'gitdir: /somewhere/.git/worktrees/wt\n' });
  assert.deepStrictEqual(pick(measurer().measure(dir), 'vcs'), {
    id: 'vcs',
    claim: 'Your hands will commit their work to git, on a branch of their own.',
    status: 'measured',
    evidence: '.git (file)',
  });
});

test('vcs: no .git at all, and none above the root either', () => {
  // A throwing git stub is what makes this the NO-GIT-ANYWHERE arm rather than
  // "wherever the temp dir happens to live": with the real binary, a tmpdir
  // inside a checkout would measure through the fallback and this would be
  // asserting a different arm than its name claims.
  const m = createTeamMeasure({
    fs,
    path,
    childProcess: { execFileSync: () => { throw new Error('not a repository'); } },
  });
  assert.deepStrictEqual(pick(m.measure(fixture()), 'vcs'), {
    id: 'vcs',
    claim: 'Your hands will NOT have version control here — there is no git checkout at or above this root, '
      + 'so nothing records or undoes what they change.',
    status: 'absent',
    evidence: null,
  });
});

test('vcs: a root INSIDE a checkout with no .git of its own still measures', { skip: !gitAvailable() }, () => {
  // The monorepo case: the operator points the helper at a package directory.
  // Claiming "no version control" there is false for that tree, and a false
  // claim marked measured is the failure this module exists to prevent.
  const repo = gitInit(fixture());
  const pkgDir = path.join(repo, 'packages', 'thing');
  fs.mkdirSync(pkgDir, { recursive: true });
  const vcs = pick(measurer().measure(pkgDir), 'vcs');
  assert.strictEqual(vcs.status, 'measured');
  assert.strictEqual(vcs.claim, 'Your hands will commit their work to git, on a branch of their own.');
  // evidence names what was actually found, not a `.git` that is not there.
  // Anchored and requiring a non-empty interior: the loose prefix form stayed
  // green on `git rev-parse --git-dir ()`, which is this file's own documented
  // failure shape.
  assert.match(vcs.evidence, /^git rev-parse --git-dir \(\S.*\)$/, `evidence was ${vcs.evidence}`);
});

// ---- 4. worktreeSupport ----------------------------------------------------

test('worktreeSupport: git with at least one commit', { skip: !gitAvailable() }, () => {
  const dir = gitInit(fixture());
  assert.deepStrictEqual(pick(measurer().measure(dir), 'worktreeSupport'), {
    id: 'worktreeSupport',
    claim: 'Your hands will each work in their own `git worktree`, on a branch minted for the ticket.',
    status: 'measured',
    evidence: 'git rev-parse --verify HEAD',
  });
});

test('worktreeSupport: a git dir with ZERO commits is absent', { skip: !gitAvailable() }, () => {
  const dir = gitInit(fixture(), { commit: false });
  const findings = measurer().measure(dir);
  // vcs still measures — the two findings are independent, and collapsing them
  // would hide a real git checkout behind a worktree limitation.
  assert.strictEqual(pick(findings, 'vcs').status, 'measured');
  assert.deepStrictEqual(pick(findings, 'worktreeSupport'), {
    id: 'worktreeSupport',
    claim: 'Your hands will NOT get a worktree of their own yet — this project is a git checkout with no '
      + 'commits, and `git worktree` needs one. Make the first commit and this becomes available.',
    status: 'absent',
    evidence: null,
  });
});

test('worktreeSupport: no git means no worktree, and rev-parse HEAD is never reached', () => {
  // vcs now probes `rev-parse --git-dir` before declaring absence, so git IS
  // invoked here. What must NOT happen is the HEAD probe: once vcs came back
  // absent, worktreeSupport short-circuits on it rather than shelling out again.
  const argvs = [];
  const m = createTeamMeasure({
    fs,
    path,
    childProcess: {
      execFileSync: (file, args) => { argvs.push(args.join(' ')); throw new Error('not a repository'); },
    },
  });
  assert.deepStrictEqual(pick(m.measure(fixture()), 'worktreeSupport'), {
    id: 'worktreeSupport',
    claim: 'Your hands will NOT get a worktree of their own — this project is not a git checkout, '
      + 'so they will all be editing the same tree.',
    status: 'absent',
    evidence: null,
  });
  assert.ok(argvs.length > 0, 'ENTER: no git call at all — the argv assertions below are vacuous');
  assert.ok(argvs.every((a) => a.includes('--git-dir')), `expected only the git-dir probe, got: ${argvs.join(' | ')}`);
  assert.ok(!argvs.some((a) => a.includes('--verify HEAD')), 'HEAD must not be probed once vcs is absent');
});

// ---- 5. generatedPaths -----------------------------------------------------

test('generatedPaths: directory-shaped .gitignore entries, capped at five', () => {
  const dir = fixture({
    '.gitignore': [
      '# a comment', '', 'node_modules/', 'dist/', 'build/', 'coverage/', 'tmp/', 'vendor/', 'out/',
    ].join('\n'),
  });
  assert.deepStrictEqual(pick(measurer().measure(dir), 'generatedPaths'), {
    id: 'generatedPaths',
    claim: "Your hands will not hand-edit this project's generated paths: `node_modules/`, `dist/`, "
      + '`build/`, `coverage/`, `tmp/` (and 2 more).',
    status: 'measured',
    evidence: '.gitignore',
  });
});

test('generatedPaths: five or fewer carries no "and N more" tail', () => {
  const dir = fixture({ '.gitignore': 'dist/\nbuild/\n' });
  assert.deepStrictEqual(pick(measurer().measure(dir), 'generatedPaths'), {
    id: 'generatedPaths',
    claim: "Your hands will not hand-edit this project's generated paths: `dist/`, `build/`.",
    status: 'measured',
    evidence: '.gitignore',
  });
});

test('generatedPaths: globs, negations, comments and bare names are all skipped', () => {
  // A bare `node_modules` with no trailing slash can name a FILE — calling it a
  // directory would be the guess this module refuses. `*.log` names a shape, not
  // a path a hand can be pointed at. `!cli/deploy/` re-includes.
  const dir = fixture({
    '.gitignore': ['*.log', '__pycache__/', 'node_modules', '!cli/deploy/', '# comment', '  ', '/dist/'].join('\n'),
  });
  assert.deepStrictEqual(pick(measurer().measure(dir), 'generatedPaths'), {
    id: 'generatedPaths',
    claim: "Your hands will not hand-edit this project's generated paths: `__pycache__/`, `dist/`.",
    status: 'measured',
    evidence: '.gitignore',
  });
});

test('generatedPaths: a .gitignore naming no directories is absent, not an empty list', () => {
  const dir = fixture({ '.gitignore': '*.log\n.DS_Store\nnode_modules\n' });
  assert.deepStrictEqual(pick(measurer().measure(dir), 'generatedPaths'), {
    id: 'generatedPaths',
    claim: "Your hands will NOT know which paths are generated — this project's `.gitignore` names no directories.",
    status: 'absent',
    evidence: null,
  });
});

test('generatedPaths: no .gitignore at all', () => {
  assert.deepStrictEqual(pick(measurer().measure(fixture()), 'generatedPaths'), {
    id: 'generatedPaths',
    claim: 'Your hands will NOT know which paths are generated — this project has no `.gitignore` to name them.',
    status: 'absent',
    evidence: null,
  });
});

// ---- the module must not execute the project ------------------------------

test('measure: never runs the project test command', () => {
  // The spec's hard fence: childProcess is for `git rev-parse` and nothing
  // else. Running an unknown repo's scripts as a side effect of DESCRIBING it
  // is not something this module may do, so every invocation is asserted to be
  // git — a reach for `npm test` shows up here as a non-git argv.
  const seen = [];
  const m = createTeamMeasure({
    fs,
    path,
    childProcess: { execFileSync: (file, args) => { seen.push([file, args]); throw new Error('no HEAD'); } },
  });
  const dir = fixture({
    '.git': 'gitdir: /elsewhere\n',
    'package.json': JSON.stringify({ scripts: { test: 'rm -rf /' } }),
  });
  const findings = m.measure(dir);
  assert.ok(seen.length > 0, 'ENTER: no child process was spawned at all — the argv assertion below is vacuous');
  for (const [file, args] of seen) {
    assert.strictEqual(file, 'git', `spawned ${file}, which is not git`);
    assert.ok(args.includes('rev-parse'), `git called with ${args.join(' ')}, which is not rev-parse`);
  }
  // The suite command was READ and reported, never run.
  assert.strictEqual(pick(findings, 'suite').status, 'measured');
});

// ---- nit 1: npm's scaffolded default is not a suite ------------------------

test('suite: npm init\'s placeholder test script is NOT a command', () => {
  // The exact string `npm init` writes. It declares a test script that exits 1
  // on purpose, so reading it as a suite produces a hand running a command the
  // project guarantees will fail — reached without guessing, which is why the
  // never-guess rule alone does not catch it.
  const dir = fixture({
    'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
  });
  assert.deepStrictEqual(pick(measurer().measure(dir), 'suite'), {
    id: 'suite',
    claim: 'Your hands will NOT have a verified suite command — nothing in this project names one, '
      + 'so tell them how to run the tests or they will not run them.',
    status: 'absent',
    evidence: null,
  });
});

test('suite: the placeholder falls THROUGH to the rest of the probe order', () => {
  // Not merely rejected — the probe continues. A repo with the npm placeholder
  // and a real Makefile target has a suite, and it is the Makefile's.
  const dir = fixture({
    'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    'Makefile': 'test:\n\techo t\n',
  });
  assert.deepStrictEqual(pick(measurer().measure(dir), 'suite'), {
    id: 'suite',
    claim: 'Your hands will run the suite with `make test`, not directly.',
    status: 'measured',
    evidence: 'Makefile test: target',
  });
});

// ---- nit 2: make ASSIGNMENTS are not targets ------------------------------

test('suite: a `test :=` variable assignment is not a make target', () => {
  // GNU make's simply-expanded assignment at column 0. Reading it as a target
  // yields a confident `make test` for a Makefile that has no such rule.
  for (const line of ['test := ./run.sh', 'test ::= x', 'test::=y', 'test ?= z', 'test += w']) {
    const dir = fixture({ 'Makefile': `${line}\nall:\n\techo hi\n` });
    assert.strictEqual(
      pick(measurer().measure(dir), 'suite').status, 'absent',
      `Makefile line "${line}" was read as a test target`
    );
  }
});

test('suite: real make targets still measure, including the double-colon rule', () => {
  for (const line of ['test:', 'test:  ## run the suite', 'test: dep', 'test:: dep']) {
    const dir = fixture({ 'Makefile': `${line}\n\techo t\n` });
    assert.strictEqual(
      pick(measurer().measure(dir), 'suite').evidence, 'Makefile test: target',
      `Makefile line "${line}" was not read as a test target`
    );
  }
});

test('suite: a TAB-INDENTED `test:` is a recipe line, not a target', () => {
  // The module comment credits the `^` anchor with excluding this and nothing
  // pinned it, so a future loosening to /^\s*test/m would pass silently. A
  // `test:` inside another target's recipe is a shell command, not a rule.
  const dir = fixture({ 'Makefile': 'all:\n\ttest:\n\techo t\n' });
  assert.strictEqual(pick(measurer().measure(dir), 'suite').status, 'absent');
});

test('suite: `testing:` is a different target and does not count', () => {
  const dir = fixture({ 'Makefile': 'testing:\n\techo t\n' });
  assert.strictEqual(pick(measurer().measure(dir), 'suite').status, 'absent');
});

// ---- nit 5: the suite runner is composed with the lockfile -----------------

test('suite: the JS runner follows the LOCKFILE, not a hardcoded npm', () => {
  // `npm test` in a pnpm-lock repo runs against a dependency graph npm never
  // installed. Both findings come from the same pass, so composing them is
  // measurement rather than a guess.
  //
  // The third column is a LITERAL, deliberately. Building it as `${manager}
  // test` would be the same concatenation the implementation performs, so every
  // row would assert only that the code agrees with itself — structurally
  // incapable of catching a per-manager exception, which is exactly how the
  // `bun test` defect stayed green. Each row now states an independent fact.
  // This is CLAUDE.md's regex-matching-all-arms rule in table form.
  for (const [file, expected] of [
    ['package-lock.json', 'npm test'],
    ['pnpm-lock.yaml', 'pnpm test'],
    ['yarn.lock', 'yarn test'],
    // NOT `bun test`: that is bun's own reserved runner subcommand and shadows
    // the package script the evidence field points at.
    ['bun.lockb', 'bun run test'],
    ['bun.lock', 'bun run test'],
  ]) {
    const dir = fixture({
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      [file]: '',
    });
    assert.deepStrictEqual(pick(measurer().measure(dir), 'suite'), {
      id: 'suite',
      claim: `Your hands will run the suite with \`${expected}\`, not directly.`,
      status: 'measured',
      evidence: 'package.json scripts.test',
    }, `lockfile ${file}`);
  }
});

test('suite: every runner command actually runs the package script', () => {
  // The invariant the bun row violated: `evidence` says the command came from
  // package.json scripts.test, so the command emitted must be one that EXECUTES
  // that script. `bun test` runs bun's own test runner instead — a finding whose
  // evidence and claim contradict each other.
  const seen = new Set();
  for (const [file, manager] of [
    ['package-lock.json', 'npm'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
  ]) {
    const dir = fixture({
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      [file]: '',
    });
    const claim = pick(measurer().measure(dir), 'suite').claim;
    const m = claim.match(/`([^`]+)`/);
    assert.ok(m, `ENTER: no command found in the claim for ${file} — the assertion below is vacuous`);
    const cmd = m[1];
    seen.add(manager);
    assert.ok(cmd.startsWith(`${manager} `), `${file}: command "${cmd}" is not a ${manager} invocation`);
    // bun is the one manager whose bare `test` is a different program.
    if (manager === 'bun') {
      assert.strictEqual(cmd, 'bun run test',
        'bare `bun test` runs bun\'s own runner, not the package script the evidence names');
    }
  }
  assert.deepStrictEqual([...seen].sort(), ['bun', 'npm', 'pnpm', 'yarn'],
    'ENTER: not every manager was exercised');
});

test('suite: an AMBIGUOUS lockfile set falls back to npm rather than picking', () => {
  // packageManager is absent here, so there is no measured runner to compose.
  // The suite claim must not silently adopt one of the contenders.
  const dir = fixture({
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    'package-lock.json': '{}',
    'pnpm-lock.yaml': '',
  });
  const findings = measurer().measure(dir);
  assert.strictEqual(pick(findings, 'packageManager').status, 'absent');
  assert.strictEqual(
    pick(findings, 'suite').claim,
    'Your hands will run the suite with `npm test`, not directly.'
  );
});

test('suite: a NON-JS suite is unaffected by the lockfile', () => {
  // A pnpm lockfile does not change how cargo runs its tests. The composition
  // applies to the package.json arm only.
  const dir = fixture({ 'Cargo.toml': '[package]\nname = "x"\n', 'pnpm-lock.yaml': '' });
  assert.deepStrictEqual(pick(measurer().measure(dir), 'suite'), {
    id: 'suite',
    claim: 'Your hands will run the suite with `cargo test`, not directly.',
    status: 'measured',
    evidence: 'Cargo.toml',
  });
});
