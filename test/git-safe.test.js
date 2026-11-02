'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { safeGitArgs, safeGitArgsFor, filterOverrides, readOperatorGitConfig, LAZY_FETCH_OPT, gitVersion, detectGitVersion, lazyFetchOpt } = require('../git-safe');
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

test('safeGitArgs: status gets the config prefix and --ignore-submodules=all', () => {
  assert.deepStrictEqual(safeGitArgs(['status']), [
    ...LAZY_FETCH_OPT, '-c', 'core.fsmonitor=',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'diff.external=',
    '-c', 'core.sshCommand=ssh',
    '-c', 'core.pager=cat',
    '-c', 'log.showSignature=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'gpg.program=', '-c', 'gpg.ssh.program=',
    '-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'fetch.all=false',
    '-c', 'protocol.ext.allow=never', '-c', 'protocol.git.allow=never', '-c', 'gpg.x509.program=', '-c', 'gpg.openpgp.program=',
    '-c', 'merge.verifySignatures=false', '-c', 'pull.verifySignatures=false',
    '-c', 'diff.ignoreSubmodules=all', '-c', 'status.submoduleSummary=false', '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=no', '-c', 'push.recurseSubmodules=no',
    '-c', 'core.alternateRefsCommand=',
    'status', '--ignore-submodules=all',
  ]);
});

test('safeGitArgs: diff/show/log get --no-ext-diff --no-textconv, diff also --ignore-submodules=all, ahead of any pathspec separator', () => {
  const prefix = [
    ...LAZY_FETCH_OPT, '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=',
    '-c', 'core.sshCommand=ssh', '-c', 'core.pager=cat',
    '-c', 'log.showSignature=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'gpg.program=', '-c', 'gpg.ssh.program=',
    '-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'fetch.all=false',
    '-c', 'protocol.ext.allow=never', '-c', 'protocol.git.allow=never', '-c', 'gpg.x509.program=', '-c', 'gpg.openpgp.program=',
    '-c', 'merge.verifySignatures=false', '-c', 'pull.verifySignatures=false',
    '-c', 'diff.ignoreSubmodules=all', '-c', 'status.submoduleSummary=false', '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=no', '-c', 'push.recurseSubmodules=no', '-c', 'core.alternateRefsCommand=',
  ];
  assert.deepStrictEqual(safeGitArgs(['diff', 'HEAD']), [...prefix, 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', 'HEAD']);
  assert.deepStrictEqual(safeGitArgs(['-C', '/r', 'diff', 'HEAD', '--', 'f']),
    [...prefix, '-C', '/r', 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', 'HEAD', '--', 'f']);
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
    ...LAZY_FETCH_OPT, '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/op/hooks', '-c', 'diff.external=',
    '-c', 'core.sshCommand=ssh -i /op/k', '-c', 'core.pager=cat',
    '-c', 'log.showSignature=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'gpg.program=', '-c', 'gpg.ssh.program=',
    '-c', 'credential.helper=', '-c', 'credential.helper=osxkeychain', '-c', 'credential.https://gh.example.helper=!gh auth git-credential',
    '-c', 'core.askPass=/op/ask', '-c', 'fetch.all=false',
    '-c', 'protocol.ext.allow=never', '-c', 'protocol.git.allow=never', '-c', 'gpg.x509.program=', '-c', 'gpg.openpgp.program=',
    '-c', 'merge.verifySignatures=false', '-c', 'pull.verifySignatures=false',
    '-c', 'diff.ignoreSubmodules=all', '-c', 'status.submoduleSummary=false', '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=no', '-c', 'push.recurseSubmodules=no', '-c', 'core.alternateRefsCommand=', 'merge', 'b',
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
  assert.deepStrictEqual(none.slice(-4), ['-C', '/r', 'status', '--ignore-submodules=all']);
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

test('a clean filter planted in a nested repo behind a gitlink does not run under safeGitArgsFor status or diff, and does without it', async (t) => {
  if (!hasGit()) { t.skip('git not installed'); return; }
  const { repo, run } = plantedRepo();
  run('checkout', '--', 'README.md');
  const sub = path.join(repo, 'sub');
  const marker = path.join(repo, '..', `${path.basename(repo)}-nested-filter-ran`);
  const runSub = (...a) => execFileSync('git', ['-C', sub, ...a], { stdio: 'ignore' });
  fs.mkdirSync(sub);
  runSub('init', '-q');
  runSub('config', 'user.email', 't@t.co');
  runSub('config', 'user.name', 't');
  fs.writeFileSync(path.join(sub, 'f'), 'hi\n');
  runSub('add', 'f');
  runSub('commit', '-qm', 's');
  runSub('config', 'filter.evil.clean', `sh -c "touch '${marker}'; cat"`);
  fs.writeFileSync(path.join(sub, '.git', 'info', 'attributes'), '* filter=evil\n');
  const head = execFileSync('git', ['-C', sub, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  run('update-index', '--add', '--cacheinfo', `160000,${head},sub`);
  run('commit', '-qm', 'sm');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(sub, 'f'), later, later);
  try {
    execFileSync('git', await safeGitArgsFor(repo, ['status', '--porcelain=v1', '-z', '--branch']), { stdio: 'ignore' });
    assert.strictEqual(fs.existsSync(marker), false, 'the nested clean filter ran under safeGitArgsFor status');
    execFileSync('git', await safeGitArgsFor(repo, ['diff', 'HEAD']), { stdio: 'ignore' });
    assert.strictEqual(fs.existsSync(marker), false, 'the nested clean filter ran under safeGitArgsFor diff');
    execFileSync('git', ['-C', repo, 'status', '--porcelain=v1'], { stdio: 'ignore' });
    assert.strictEqual(fs.existsSync(marker), true, 'control: the nested clean filter runs on a raw status');
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

function markerScript(repo, tag) {
  const marker = path.join(repo, '..', `${path.basename(repo)}-${tag}-ran`);
  const script = path.join(repo, '..', `${path.basename(repo)}-${tag}.sh`);
  fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  return { marker, script };
}

function gitTry(argv) {
  try { execFileSync('git', argv, { stdio: 'ignore', timeout: 20000 }); } catch {}
}

test('a planted core.gitProxy command does not run on a git:// fetch under safeGitArgsFor, and does without it', async (t) => {
  if (!hasGit()) { t.skip('git not installed'); return; }
  const { repo, run } = plantedRepo();
  const { marker, script } = markerScript(repo, 'gitproxy');
  run('config', 'core.gitProxy', script);
  run('config', 'remote.origin.url', 'git://example.invalid/x');
  try {
    gitTry(await safeGitArgsFor(repo, ['fetch', 'origin']));
    assert.strictEqual(fs.existsSync(marker), false, 'core.gitProxy ran under safeGitArgsFor');
    gitTry(['-C', repo, 'fetch', 'origin']);
    assert.strictEqual(fs.existsSync(marker), true, 'control: the planted core.gitProxy runs on a raw fetch');
  } finally {
    fs.rmSync(marker, { force: true });
    fs.rmSync(script, { force: true });
  }
});

test('an ext:: remote allowed by the repo config does not run under safeGitArgsFor, and does without it', async (t) => {
  if (!hasGit()) { t.skip('git not installed'); return; }
  const { repo, run } = plantedRepo();
  const marker = path.join(repo, '..', `${path.basename(repo)}-ext-ran`);
  run('config', 'protocol.ext.allow', 'always');
  run('config', 'remote.ext.url', `ext::sh -c touch% ${marker}`);
  try {
    gitTry(await safeGitArgsFor(repo, ['fetch', 'ext']));
    assert.strictEqual(fs.existsSync(marker), false, 'the ext:: remote ran under safeGitArgsFor');
    gitTry(['-C', repo, 'fetch', 'ext']);
    assert.strictEqual(fs.existsSync(marker), true, 'control: the ext:: remote runs on a raw fetch');
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('a url.insteadOf rewrite of a normal remote to ext:: does not run under safeGitArgsFor, and does without it', async (t) => {
  if (!hasGit()) { t.skip('git not installed'); return; }
  const { repo, run } = plantedRepo();
  const marker = path.join(repo, '..', `${path.basename(repo)}-insteadof-ran`);
  run('config', 'protocol.ext.allow', 'always');
  run('config', 'remote.origin.url', 'https://example.invalid/x');
  run('config', `url.ext::sh -c touch% ${marker}% #.insteadOf`, 'https://example.invalid/');
  try {
    gitTry(await safeGitArgsFor(repo, ['fetch', 'origin']));
    assert.strictEqual(fs.existsSync(marker), false, 'the insteadOf ext:: rewrite ran under safeGitArgsFor');
    gitTry(['-C', repo, 'fetch', 'origin']);
    assert.strictEqual(fs.existsSync(marker), true, 'control: the insteadOf ext:: rewrite runs on a raw fetch');
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('a planted core.alternateRefsCommand does not run on fetch under safeGitArgsFor, and does without it', async (t) => {
  if (!hasGit()) { t.skip('git not installed'); return; }
  const { repo, run } = plantedRepo();
  const alt = plantedRepo();
  const origin = plantedRepo();
  const marker = path.join(repo, '..', `${path.basename(repo)}-altrefs-ran`);
  fs.writeFileSync(path.join(repo, '.git', 'objects', 'info', 'alternates'), `${path.join(alt.repo, '.git', 'objects')}\n`);
  run('config', 'core.alternateRefsCommand', `touch '${marker}'; true`);
  run('remote', 'add', 'origin', origin.repo);
  try {
    gitTry(await safeGitArgsFor(repo, ['fetch', 'origin']));
    assert.strictEqual(fs.existsSync(marker), false, 'core.alternateRefsCommand ran under safeGitArgsFor');
    origin.run('commit', '-qm', 'two', '--', 'README.md');
    gitTry(['-C', repo, 'fetch', 'origin']);
    assert.strictEqual(fs.existsSync(marker), true, 'control: the planted core.alternateRefsCommand runs on a raw fetch');
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('--no-lazy-fetch leads the prefix only on git 2.45 or newer, and is dropped when git --version fails', () => {
  const rows = [
    ['git version 2.39.5', '2.39.5', []],
    ['git version 2.39.5 (Apple Git-154)\n', '2.39.5', []],
    ['git version 2.44.2', '2.44.2', []],
    ['git version 2.45.0', '2.45.0', ['--no-lazy-fetch']],
    ['git version 2.52.0\n', '2.52.0', ['--no-lazy-fetch']],
    ['git version 3.0.1', '3.0.1', ['--no-lazy-fetch']],
    [new Error('spawn git ENOENT'), null, []],
  ];
  for (const [out, version, opt] of rows) {
    const run = (file, argv) => {
      assert.deepStrictEqual([file, argv], ['git', ['--version']]);
      if (out instanceof Error) throw out;
      return out;
    };
    assert.strictEqual(detectGitVersion(run), version, String(out));
    assert.deepStrictEqual(lazyFetchOpt(detectGitVersion(run)), opt, String(out));
  }
  assert.deepStrictEqual(LAZY_FETCH_OPT, lazyFetchOpt(gitVersion));
});

test('a partial clone does not lazily fetch through a planted remote uploadpack under safeGitArgsFor diff, and does without it', async (t) => {
  if (!hasGit()) { t.skip('git not installed'); return; }
  if (!LAZY_FETCH_OPT.length) { t.skip(`git ${gitVersion} predates --no-lazy-fetch (2.45)`); return; }
  const up = plantedRepo();
  up.run('commit', '-qm', 'two', '--', 'README.md');
  up.run('config', 'uploadpack.allowFilter', 'true');
  const clone = () => {
    const seat = path.join(mkTmpRoot('clx-gitsafe-seat-'), 'seat');
    execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${up.repo}`, seat], { stdio: 'ignore' });
    const marker = `${seat}-lazy-ran`;
    execFileSync('git', ['-C', seat, 'config', 'remote.origin.uploadpack', `touch '${marker}'; git-upload-pack`], { stdio: 'ignore' });
    return { seat, marker };
  };
  const safe = clone();
  const raw = clone();
  try {
    gitTry(await safeGitArgsFor(safe.seat, ['diff', 'HEAD~1', 'HEAD']));
    assert.strictEqual(fs.existsSync(safe.marker), false, 'the planted uploadpack ran from a lazy fetch under safeGitArgsFor');
    gitTry(['-C', raw.seat, 'diff', 'HEAD~1', 'HEAD']);
    assert.strictEqual(fs.existsSync(raw.marker), true, 'control: a raw diff lazily fetches through the planted uploadpack');
  } finally {
    fs.rmSync(safe.marker, { force: true });
    fs.rmSync(raw.marker, { force: true });
  }
});

function x509SignedHead(repo) {
  const rev = (r) => execFileSync('git', ['-C', repo, 'rev-parse', r], { encoding: 'utf8' }).trim();
  const parent = rev('HEAD');
  const body = `tree ${rev('HEAD^{tree}')}\nparent ${parent}\nauthor t <t@t.co> 1 +0000\ncommitter t <t@t.co> 1 +0000\n`
    + 'gpgsig -----BEGIN SIGNED MESSAGE-----\n MIIB\n -----END SIGNED MESSAGE-----\n\nsigned\n';
  const signed = execFileSync('git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: body, encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', repo, 'update-ref', 'HEAD', signed], { stdio: 'ignore' });
  return { parent, signed };
}

test('a planted gpg.x509.program does not run on log --show-signature under safeGitArgsFor, and does without it', async (t) => {
  if (!hasGit()) { t.skip('git not installed'); return; }
  const { repo, run } = plantedRepo();
  x509SignedHead(repo);
  const { marker, script } = markerScript(repo, 'x509log');
  run('config', 'gpg.x509.program', script);
  try {
    gitTry(await safeGitArgsFor(repo, ['log', '-1', '--show-signature']));
    assert.strictEqual(fs.existsSync(marker), false, 'gpg.x509.program ran under safeGitArgsFor');
    gitTry(['-C', repo, 'log', '-1', '--show-signature']);
    assert.strictEqual(fs.existsSync(marker), true, 'control: the planted gpg.x509.program runs on a raw log --show-signature');
  } finally {
    fs.rmSync(marker, { force: true });
    fs.rmSync(script, { force: true });
  }
});

test('a planted gpg.x509.program does not verify an incoming signed commit on pull under safeGitArgsFor, and does without it', async (t) => {
  if (!hasGit()) { t.skip('git not installed'); return; }
  const up = plantedRepo();
  const repo = mkTmpRoot('clx-gitsafe-');
  execFileSync('git', ['clone', '-q', up.repo, repo], { stdio: 'ignore' });
  const { parent } = x509SignedHead(up.repo);
  const { marker, script } = markerScript(repo, 'x509');
  const run = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  run('config', 'gpg.format', 'x509');
  run('config', 'gpg.x509.program', script);
  run('config', 'merge.verifySignatures', 'true');
  try {
    gitTry(await safeGitArgsFor(repo, ['pull', '--ff-only']));
    assert.strictEqual(fs.existsSync(marker), false, 'gpg.x509.program ran under safeGitArgsFor');
    run('reset', '-q', '--hard', parent);
    gitTry(['-C', repo, 'pull', '--ff-only']);
    assert.strictEqual(fs.existsSync(marker), true, 'control: the planted gpg.x509.program runs on a raw pull');
  } finally {
    fs.rmSync(marker, { force: true });
    fs.rmSync(script, { force: true });
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
  "git-safe.js:run('git', VERSION_ARGV",
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
