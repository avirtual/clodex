'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { safeGitArgs, safeGitArgsFor, filterOverrides, readOperatorGitConfig } = require('../git-safe');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ROOT = path.join(__dirname, '..');

function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function plantedRepo() {
  const repo = mkTmpRoot('clx-gitsafe-');
  const run = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 't@t.co');
  run('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'README.md'), 'a\n');
  run('add', '-A');
  run('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'README.md'), 'b\n');
  return { repo, run };
}

test('safeGitArgs: status gets the config prefix and nothing else', () => {
  assert.deepStrictEqual(safeGitArgs(['status']), [
    '-c', 'core.fsmonitor=',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'diff.external=',
    '-c', 'core.sshCommand=ssh',
    '-c', 'core.pager=cat',
    '-c', 'log.showSignature=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'gpg.program=', '-c', 'gpg.ssh.program=',
    '-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'fetch.all=false',
    'status',
  ]);
});

test('safeGitArgs: diff/show/log get --no-ext-diff --no-textconv ahead of any pathspec separator', () => {
  const prefix = [
    '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=',
    '-c', 'core.sshCommand=ssh', '-c', 'core.pager=cat',
    '-c', 'log.showSignature=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'gpg.program=', '-c', 'gpg.ssh.program=',
    '-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'fetch.all=false',
  ];
  assert.deepStrictEqual(safeGitArgs(['diff', 'HEAD']), [...prefix, 'diff', '--no-ext-diff', '--no-textconv', 'HEAD']);
  assert.deepStrictEqual(safeGitArgs(['-C', '/r', 'diff', 'HEAD', '--', 'f']),
    [...prefix, '-C', '/r', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', 'f']);
  assert.deepStrictEqual(safeGitArgs(['-C', '/r', 'show', 'x']), [...prefix, '-C', '/r', 'show', '--no-ext-diff', '--no-textconv', 'x']);
  assert.deepStrictEqual(safeGitArgs(['-C', '/r', 'log', '-1']), [...prefix, '-C', '/r', 'log', '--no-ext-diff', '--no-textconv', '-1']);
  assert.deepStrictEqual(safeGitArgs(['-C', '/r', 'rev-parse', 'HEAD']), [...prefix, '-C', '/r', 'rev-parse', 'HEAD']);
  assert.deepStrictEqual(safeGitArgs(['-C', '/r', 'fetch', '--quiet']), [...prefix, '-C', '/r', 'fetch', '--upload-pack=git-upload-pack', '--quiet']);
  assert.deepStrictEqual(safeGitArgs(['pull', '--ff-only']), [...prefix, 'pull', '--upload-pack=git-upload-pack', '--ff-only']);
  assert.deepStrictEqual(safeGitArgs(['ls-remote', 'o']), [...prefix, 'ls-remote', '--upload-pack=git-upload-pack', 'o']);
  assert.deepStrictEqual(safeGitArgs(['push']), [...prefix, 'push', '--receive-pack=git-receive-pack']);
});

test('safeGitArgs takes the operator hooksPath, sshCommand, askPass and credential helpers in place of the defaults', () => {
  const credentialHelpers = [['credential.helper', 'osxkeychain'], ['credential.https://gh.example.helper', '!gh auth git-credential']];
  assert.deepStrictEqual(safeGitArgs(['merge', 'b'], { hooksPath: '/op/hooks', sshCommand: 'ssh -i /op/k', askPass: '/op/ask', credentialHelpers }), [
    '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/op/hooks', '-c', 'diff.external=',
    '-c', 'core.sshCommand=ssh -i /op/k', '-c', 'core.pager=cat',
    '-c', 'log.showSignature=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'gpg.program=', '-c', 'gpg.ssh.program=',
    '-c', 'credential.helper=', '-c', 'credential.helper=osxkeychain', '-c', 'credential.https://gh.example.helper=!gh auth git-credential',
    '-c', 'core.askPass=/op/ask', '-c', 'fetch.all=false', 'merge', 'b',
  ]);
});

test('readOperatorGitConfig takes the last system, global or unknown-scope value of each key and ignores local, worktree and command scopes', async () => {
  const asked = [];
  const out = {
    'core.hooksPath': 'system\0/s/hooks\0global\0/g/hooks\0local\0/l/hooks\0',
    'core.sshCommand': 'global\0ssh -i /g\0local\0ssh -i /l\0worktree\0ssh -i /w\0command\0ssh\0',
    'core.askPass': 'global\0/g/ask\0local\0/l/ask\0',
    '^credential\\..*helper$': 'unknown\0credential.helper\nosxkeychain\0global\0credential.https://gh.example.helper\n!gh auth\0'
      + 'local\0credential.helper\n!planted\0global\0credential.helper\0global\0credential.a=b.helper\nx\0',
  };
  const run = (file, argv, opts, cb) => {
    asked.push(argv.slice(argv.indexOf('-C')));
    process.nextTick(() => cb(null, out[argv[argv.length - 1]], ''));
  };
  assert.deepStrictEqual(await readOperatorGitConfig('/r', run), {
    hooksPath: '/g/hooks', sshCommand: 'ssh -i /g', askPass: '/g/ask',
    credentialHelpers: [['credential.helper', 'osxkeychain'], ['credential.https://gh.example.helper', '!gh auth']],
  });
  assert.deepStrictEqual(asked, [
    ['-C', '/r', 'config', '--null', '--show-scope', '--type=path', '--get-all', 'core.hooksPath'],
    ['-C', '/r', 'config', '--null', '--show-scope', '--type=path', '--get-all', 'core.sshCommand'],
    ['-C', '/r', 'config', '--null', '--show-scope', '--type=path', '--get-all', 'core.askPass'],
    ['-C', '/r', 'config', '--null', '--show-scope', '--get-regexp', '^credential\\..*helper$'],
  ]);
  const reply = (err, stdout) => (file, argv, opts, cb) => process.nextTick(() => cb(err, stdout, ''));
  assert.deepStrictEqual(await readOperatorGitConfig('/r', reply(Object.assign(new Error('x'), { code: 1 }), '')),
    { hooksPath: '/dev/null', sshCommand: 'ssh', askPass: '', credentialHelpers: [] });
  assert.deepStrictEqual(await readOperatorGitConfig('/r', reply(Object.assign(new Error('x'), { code: 128 }), '')),
    { hooksPath: '/dev/null', sshCommand: 'ssh', askPass: '', credentialHelpers: [] });
  assert.deepStrictEqual(await readOperatorGitConfig('/r', reply(null, 'local\0/l/hooks\0command\0ssh -i /c\0')),
    { hooksPath: '/dev/null', sshCommand: 'ssh', askPass: '', credentialHelpers: [] });
  assert.deepStrictEqual(await readOperatorGitConfig('/r', reply(null, 'global\0hooks\0')), { hooksPath: '/dev/null', sshCommand: 'hooks', askPass: 'hooks', credentialHelpers: [] });
});

test('filterOverrides blanks clean, smudge and process for each configured driver, dotted names included', () => {
  assert.deepStrictEqual(filterOverrides('filter.x.clean\0filter.x.required\0filter.a.b.smudge\0filter.lone\0'), [
    '-c', 'filter.x.clean=', '-c', 'filter.x.smudge=', '-c', 'filter.x.process=',
    '-c', 'filter.a.b.clean=', '-c', 'filter.a.b.smudge=', '-c', 'filter.a.b.process=',
  ]);
  assert.deepStrictEqual(filterOverrides(''), []);
  assert.throws(() => filterOverrides('filter.x.clean\0filter.a=b.clean\0'), /contains "="/);
  assert.deepStrictEqual(filterOverrides('merge.m.driver\0merge.m.name\0merge.a.b.driver\0merge.m.driver\0'), [
    '-c', 'merge.m.driver=', '-c', 'merge.a.b.driver=',
  ]);
  assert.throws(() => filterOverrides('merge.a=b.driver\0'), /contains "="/);
});

test('safeGitArgsFor rejects on any filter-lookup failure but exit 1 with no output', async () => {
  const runner = (err, stdout) => (file, argv, opts, cb) => {
    assert.strictEqual(opts.maxBuffer, 64 * 1024 * 1024);
    process.nextTick(() => cb(err, stdout, ''));
  };
  const maxBuf = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  const killed = Object.assign(new Error('Command failed'), { code: null, killed: true, signal: 'SIGTERM' });
  const other = Object.assign(new Error('Command failed'), { code: 128 });
  for (const err of [maxBuf, killed, other]) {
    await assert.rejects(safeGitArgsFor('/r', ['status'], { run: runner(err, '') }), /git filter lookup failed/);
  }
  await assert.rejects(safeGitArgsFor('/r', ['status'], { run: runner(Object.assign(new Error('x'), { code: 1 }), 'filter.x.clean\0') }));
  const none = await safeGitArgsFor('/r', ['status'], { run: runner(Object.assign(new Error('x'), { code: 1 }), '') });
  assert.deepStrictEqual(none.slice(-3), ['-C', '/r', 'status']);
  assert.ok(!none.some((a) => a.startsWith('filter.')));
});

test('a planted core.fsmonitor command does not run under safeGitArgs, and does without it', (t) => {
  if (!hasGit()) { t.skip('git not installed'); return; }
  const { repo, run } = plantedRepo();
  const marker = path.join(repo, '..', `${path.basename(repo)}-fsmonitor-ran`);
  run('config', 'core.fsmonitor', `touch '${marker}'; false`);
  try {
    execFileSync('git', safeGitArgs(['-C', repo, 'status', '--porcelain']), { stdio: 'ignore' });
    assert.strictEqual(fs.existsSync(marker), false, 'fsmonitor ran under safeGitArgs');
    try { execFileSync('git', ['-C', repo, 'status', '--porcelain'], { stdio: 'ignore' }); } catch {}
    if (!fs.existsSync(marker)) {
      console.log('# control skipped: this git did not invoke the core.fsmonitor hook on status');
      return;
    }
    assert.strictEqual(fs.existsSync(marker), true);
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('a planted diff.external command does not run under safeGitArgs, and does without it', (t) => {
  if (!hasGit()) { t.skip('git not installed'); return; }
  const { repo, run } = plantedRepo();
  const marker = path.join(repo, '..', `${path.basename(repo)}-extdiff-ran`);
  run('config', 'diff.external', `sh -c "touch '${marker}'"`);
  try {
    const out = execFileSync('git', safeGitArgs(['-C', repo, 'diff', 'HEAD', '--no-color', '--', 'README.md']), { encoding: 'utf8' });
    assert.strictEqual(fs.existsSync(marker), false, 'diff.external ran under safeGitArgs');
    assert.match(out, /^\+b$/m);
    try { execFileSync('git', ['-C', repo, 'diff', 'HEAD', '--', 'README.md'], { stdio: 'ignore' }); } catch {}
    assert.strictEqual(fs.existsSync(marker), true, 'control: the planted diff.external runs on a raw diff');
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('a planted clean filter does not run under safeGitArgsFor, and does without it', async (t) => {
  if (!hasGit()) { t.skip('git not installed'); return; }
  const { repo, run } = plantedRepo();
  const marker = path.join(repo, '..', `${path.basename(repo)}-filter-ran`);
  run('config', 'filter.x.clean', `touch '${marker}'; cat`);
  fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), 'README.md filter=x\n');
  try {
    const out = execFileSync('git', await safeGitArgsFor(repo, ['diff', 'HEAD', '--no-color', '--', 'README.md']), { encoding: 'utf8' });
    assert.strictEqual(fs.existsSync(marker), false, 'the clean filter ran under safeGitArgsFor');
    assert.match(out, /^\+b$/m);
    execFileSync('git', ['-C', repo, 'diff', 'HEAD', '--', 'README.md'], { stdio: 'ignore' });
    assert.strictEqual(fs.existsSync(marker), true, 'control: the planted clean filter runs on a raw diff');
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('a filter driver named a=b makes safeGitArgsFor refuse, and runs without it', async (t) => {
  if (!hasGit()) { t.skip('git not installed'); return; }
  const { repo, run } = plantedRepo();
  const marker = path.join(repo, '..', `${path.basename(repo)}-eqfilter-ran`);
  run('config', 'filter.a=b.clean', `touch '${marker}'; cat`);
  fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), 'README.md filter=a=b\n');
  try {
    await assert.rejects(safeGitArgsFor(repo, ['diff', 'HEAD', '--no-color', '--', 'README.md']), /contains "="/);
    assert.strictEqual(fs.existsSync(marker), false);
    execFileSync('git', ['-C', repo, 'diff', 'HEAD', '--', 'README.md'], { stdio: 'ignore' });
    assert.strictEqual(fs.existsSync(marker), true, 'control: the a=b driver runs on a raw diff');
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

function withGitConfigGlobal(file, fn) {
  const prior = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = file;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const restore = () => {
    for (const [k, v] of [['GIT_CONFIG_GLOBAL', prior.g], ['GIT_CONFIG_NOSYSTEM', prior.s]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  return Promise.resolve().then(fn).finally(restore);
}

test('a clean filter defined only in the global config is not blanked and cleans the staged blob', async (t) => {
  if (!hasGit()) { t.skip('git not installed'); return; }
  const { repo } = plantedRepo();
  const globalFile = path.join(repo, '..', `${path.basename(repo)}-global`);
  fs.writeFileSync(globalFile, '[filter "up"]\n\tclean = tr a-z A-Z\n\trequired = true\n');
  fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), 'f filter=up\n');
  fs.writeFileSync(path.join(repo, 'f'), 'hello\n');
  try {
    await withGitConfigGlobal(globalFile, async () => {
      const argv = await safeGitArgsFor(repo, ['add', '--', 'f']);
      assert.deepStrictEqual(argv.filter((a) => a.startsWith('filter.')), []);
      execFileSync('git', argv, { stdio: 'ignore' });
      assert.strictEqual(execFileSync('git', ['-C', repo, 'show', ':f'], { encoding: 'utf8' }), 'HELLO\n');
    });
  } finally {
    fs.rmSync(globalFile, { force: true });
  }
});

test('a clean filter planted through the repo config\'s include.path is still blanked', async (t) => {
  if (!hasGit()) { t.skip('git not installed'); return; }
  const { repo, run } = plantedRepo();
  const marker = path.join(repo, '..', `${path.basename(repo)}-incfilter-ran`);
  const included = path.join(repo, '..', `${path.basename(repo)}-included`);
  fs.writeFileSync(included, `[filter "inc"]\n\tclean = touch '${marker}'; cat\n`);
  run('config', 'include.path', included);
  fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), 'README.md filter=inc\n');
  try {
    const argv = await safeGitArgsFor(repo, ['diff', 'HEAD', '--no-color', '--', 'README.md']);
    assert.ok(argv.includes('filter.inc.clean='));
    execFileSync('git', argv, { stdio: 'ignore' });
    assert.strictEqual(fs.existsSync(marker), false, 'the included clean filter ran under safeGitArgsFor');
    execFileSync('git', ['-C', repo, 'diff', 'HEAD', '--', 'README.md'], { stdio: 'ignore' });
    assert.strictEqual(fs.existsSync(marker), true, 'control: the included clean filter runs on a raw diff');
  } finally {
    fs.rmSync(marker, { force: true });
    fs.rmSync(included, { force: true });
  }
});

test('safeGitArgsFor honours an includeIf sshCommand from the global config and ignores a repo-local one', async (t) => {
  if (!hasGit()) { t.skip('git not installed'); return; }
  const { repo, run } = plantedRepo();
  const other = plantedRepo();
  const real = fs.realpathSync(repo);
  const globalFile = path.join(repo, '..', `${path.basename(repo)}-global`);
  const included = path.join(repo, '..', `${path.basename(repo)}-work`);
  fs.writeFileSync(globalFile, `[includeIf "gitdir:${real}/"]\n\tpath = ${included}\n`);
  fs.writeFileSync(included, '[core]\n\tsshCommand = ssh -i /inc/key\n\thooksPath = /inc/hooks\n');
  run('config', 'core.sshCommand', 'ssh -i /local/key');
  run('config', 'core.hooksPath', '/local/hooks');
  other.run('config', 'core.sshCommand', 'ssh -i /local/key');
  try {
    await withGitConfigGlobal(globalFile, async () => {
      const argv = await safeGitArgsFor(repo, ['fetch']);
      assert.ok(argv.includes('core.sshCommand=ssh -i /inc/key'), argv.join(' '));
      assert.ok(argv.includes('core.hooksPath=/inc/hooks'), argv.join(' '));
      const plain = await safeGitArgsFor(other.repo, ['fetch']);
      assert.ok(plain.includes('core.sshCommand=ssh'), plain.join(' '));
      assert.ok(!plain.some((a) => a.includes('/local/key')), plain.join(' '));
    });
  } finally {
    fs.rmSync(globalFile, { force: true });
    fs.rmSync(included, { force: true });
  }
});

const SAFE_SITES = ['git-safe.js', 'engine.js', 'git-worktree.js', 'session-meta.js', 'plugins/workbench/git-scm.js', 'plugins/git-branches/engine.js'];
const GIT_SPAWN_RE = /\b(?:execFile|execFileSync|spawn|spawnSync|run)\(\s*'git',\s*([A-Za-z[]\w*\(?)/g;
const UNWRAPPED_ALLOWED = [
  "engine.js:execFile('git', argv",
  "git-worktree.js:execFile('git', argv",
  "plugins/workbench/git-scm.js:execFile('git', argv",
];

test('every git spawn in the app-process git sites goes through safeGitArgs', () => {
  const seen = [];
  const bad = [];
  for (const rel of SAFE_SITES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(GIT_SPAWN_RE)) {
      seen.push(rel);
      if (m[1] !== 'safeGitArgs(' && !UNWRAPPED_ALLOWED.includes(`${rel}:${m[0]}`)) bad.push(`${rel}: ${m[0]}`);
    }
  }
  assert.deepStrictEqual(bad, []);
  for (const allowed of UNWRAPPED_ALLOWED) {
    const [rel, site] = [allowed.slice(0, allowed.indexOf(':')), allowed.slice(allowed.indexOf(':') + 1)];
    const hits = [...fs.readFileSync(path.join(ROOT, rel), 'utf8').matchAll(GIT_SPAWN_RE)].filter((m) => m[0] === site);
    assert.strictEqual(hits.length, 1, allowed);
  }
  for (const rel of ['engine.js', 'git-worktree.js', 'plugins/workbench/git-scm.js']) {
    assert.ok(fs.readFileSync(path.join(ROOT, rel), 'utf8').includes('argv = await safeGitArgsFor(cwd, args); } catch'), rel);
  }
  assert.deepStrictEqual([...new Set(seen)].sort(), [...SAFE_SITES].sort(), 'ENTER: each listed file has a git spawn');
});

test('the plugin copies of git-safe.js match the root module byte for byte', () => {
  const root = fs.readFileSync(path.join(ROOT, 'git-safe.js'), 'utf8');
  for (const rel of ['plugins/workbench/git-safe.js', 'plugins/git-branches/git-safe.js']) {
    assert.strictEqual(fs.readFileSync(path.join(ROOT, rel), 'utf8'), root, rel);
  }
});
