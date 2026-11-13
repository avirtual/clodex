'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { imagesDocker } = require('./lib/box-images');
const { createDocker, boxIsolation, runArgv } = require('../suite-box');

const IMAGE = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const STATE = '/state/suite-runner';
const RUNNER_KEY = '68ce9ee28045';
const WRAPPER = 'mkdir -p "$HOME"; exec 3<&0; "$@" </dev/null & pid=$!; { cat <&3 >/dev/null; kill -KILL $$; } & wait $pid; exit $?';
const CLODEX_VERSION = require('../package.json').version;

function stubDocker(answer) {
  const calls = [];
  return {
    calls,
    call: async (args, opts) => {
      calls.push({ args, opts });
      return { ok: true, code: 0, stdout: '', stderr: '', notFound: false, timedOut: false, error: null, ...answer(args, calls.length) };
    },
  };
}

function adapter(over = {}) {
  return boxIsolation({ image: IMAGE, work: '/w', stateDir: STATE, uid: 501, gid: 20, docker: stubDocker(() => ({})), ...over });
}

const ARM_JOB = { id: 'j-1', identity: { arch: 'arm64' } };

test('runArgv: a tests exec with no deps is the section 2 line', () => {
  const argv = runArgv({
    image: IMAGE, runnerKey: RUNNER_KEY, n: 2, uid: 501, gid: 20, jobDir: '/w/jobs/abcd1234',
    job: { id: 'j-1', identity: { arch: 'x64' } },
    argv: ['node', 'scripts/run-tests.js', '--reporter=dot', 'test/a.test.js'],
    env: { FOO: 'bar', HOME: '/tmp/home', CLODEX_TEST_SHARD: '1/2' },
  });
  assert.deepStrictEqual(argv, [
    'docker', 'run', '-i', '--rm',
    '--name', 'clodex-suite-68ce9ee28045-abcd1234-2',
    '--label', 'clodex.suite=1', '--label', 'clodex.suite.runner=68ce9ee28045', '--label', 'clodex.suite.job=j-1',
    '--platform', 'linux/amd64', '--pull', 'never', '--init', '--log-driver', 'none',
    '--entrypoint', '/bin/sh', '--workdir', '/job/tree', '--user', '501:20',
    '--network', 'bridge', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '4096', '--shm-size', '1g',
    '--mount', 'type=bind,src=/w/jobs/abcd1234/tree,dst=/job/tree',
    '-e', 'HOME=/tmp/home', '-e', 'TMPDIR=/tmp', '-e', 'GIT_CEILING_DIRECTORIES=/job', '-e', 'LANG=C.UTF-8', '-e', 'TZ=UTC',
    '-e', 'USER=box', '-e', 'LOGNAME=box', '-e', 'SHELL=/bin/sh',
    '-e', 'FOO=bar', '-e', 'CLODEX_TEST_SHARD=1/2',
    IMAGE,
    '-c', WRAPPER,
    'sh', 'node', 'scripts/run-tests.js', '--reporter=dot', 'test/a.test.js',
  ]);
});

test('runArgv: deps mounts appear only for setup paths present in the entry', () => {
  const root = mkTmpRoot('suite-box-');
  const entry = path.join(root, 'deps', 'r', 'k');
  const jobDir = path.join(root, 'jobs', 'ffff0000');
  const job = { id: 'j-2', identity: { arch: 'arm64' }, depsEntry: entry, setup: { run: 'npm ci', key: [], paths: ['node_modules', 'vendor/lib'] } };
  const call = () => runArgv({ image: IMAGE, runnerKey: RUNNER_KEY, n: 1, uid: 501, gid: 20, jobDir, job, argv: ['/bin/sh', '-c', 'npm ci'], env: {} });
  fs.mkdirSync(entry, { recursive: true });
  const setup = call();
  assert.ok(setup.includes(`type=bind,src=${jobDir}/tree,dst=/job/tree`), 'ENTER: the tree mount is there');
  assert.deepStrictEqual(setup.filter((a) => a.includes('readonly')), []);
  fs.mkdirSync(path.join(entry, 'node_modules'));
  const tests = call();
  const at = tests.indexOf(`type=bind,src=${jobDir}/tree,dst=/job/tree`);
  assert.deepStrictEqual(tests.slice(at - 1, at + 4), [
    '--mount', `type=bind,src=${jobDir}/tree,dst=/job/tree`,
    '--mount', `type=bind,src=${entry}/node_modules,dst=/job/tree/node_modules,readonly`,
    '-e',
  ]);
  assert.deepStrictEqual(tests.slice(-6), ['-c', WRAPPER, 'sh', '/bin/sh', '-c', 'npm ci']);
  assert.strictEqual(tests.indexOf('--platform') + 1, tests.indexOf('linux/arm64'));
});

test('runArgv refuses a setup path that would rewrite the mount record', () => {
  const root = mkTmpRoot('suite-box-');
  const entry = path.join(root, 'deps', 'r', 'k');
  const rows = [
    { rel: 'node_modules', ok: true },
    { rel: 'x,src=/Users/runner/.ssh', ok: false },
    { rel: 'x,dst=/job/tree/x\ny', ok: false },
    { rel: 'x"y', ok: false },
  ];
  for (const { rel, ok } of rows) {
    fs.mkdirSync(path.join(entry, rel), { recursive: true });
    const job = { id: 'j-3', identity: { arch: 'arm64' }, depsEntry: entry, setup: { run: 'true', key: [], paths: [rel] } };
    const call = () => runArgv({ image: IMAGE, runnerKey: RUNNER_KEY, n: 1, uid: 501, gid: 20, jobDir: path.join(root, 'jobs', 'a'), job, argv: ['true'], env: {} });
    if (ok) assert.ok(call().includes(`type=bind,src=${entry}/node_modules,dst=/job/tree/node_modules,readonly`), 'ENTER: a plain path mounts');
    else assert.throws(call, { message: `setup path not mountable: ${JSON.stringify(rel)}` });
  }
});

test('spawn: detached, three pipes, a fresh name per exec, and no stdin write', () => {
  const box = adapter();
  const spawned = [];
  const spawn = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { pid: 7 }; };
  const jobDir = '/w/jobs/abcd1234';
  box.spawn({ jobDir, cwd: `${jobDir}/tree`, argv: ['/bin/sh', '-c', 'true'], env: box.env(jobDir), spawn, job: ARM_JOB });
  box.spawn({ jobDir, cwd: `${jobDir}/tree`, argv: ['node', 'x'], env: box.env(jobDir), spawn, job: ARM_JOB });
  assert.deepStrictEqual(spawned.map((s) => [s.cmd, s.opts, s.args[s.args.indexOf('--name') + 1]]), [
    ['docker', { detached: true, stdio: ['pipe', 'pipe', 'pipe'] }, 'clodex-suite-68ce9ee28045-abcd1234-1'],
    ['docker', { detached: true, stdio: ['pipe', 'pipe', 'pipe'] }, 'clodex-suite-68ce9ee28045-abcd1234-2'],
  ]);
  assert.strictEqual(spawned[0].args.filter((a) => a === '-e').length, 8);
});

test('adapter shape and fixed env', () => {
  const box = adapter();
  assert.deepStrictEqual(
    { mode: box.mode, user: box.user, node: box.node, detach: box.detach, runnerKey: box.runnerKey },
    { mode: 'container', user: 'box', node: 'node', detach: true, runnerKey: '68ce9ee28045' },
  );
  assert.deepStrictEqual(box.env('/w/jobs/x'), {
    HOME: '/tmp/home', TMPDIR: '/tmp', GIT_CEILING_DIRECTORIES: '/job', LANG: 'C.UTF-8', TZ: 'UTC', USER: 'box', LOGNAME: 'box', SHELL: '/bin/sh',
  });
});

const DOWN = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
const PROBE_ROWS = [
  { name: 'a tag', over: { image: 'clodex-suite:latest' }, info: {}, inspect: {}, want: { state: 'unavailable', why: 'CLODEX_SUITE_BOX_IMAGE must be an image id (sha256:…), not a tag' }, calls: 0 },
  { name: 'docker absent', info: { ok: false, notFound: true, error: 'spawn docker ENOENT' }, inspect: {}, want: { state: 'unavailable', why: 'docker not found on PATH' }, calls: 1 },
  { name: 'daemon down', info: { ok: false, code: 1, stderr: `${DOWN}\nsecond line\n` }, inspect: {}, want: { state: 'unavailable', why: `docker daemon not reachable: ${DOWN}` }, calls: 1 },
  { name: 'no answer in 5 s', info: { ok: false, timedOut: true, error: 'docker info timed out after 5000 ms' }, inspect: {}, want: { state: 'unavailable', why: 'docker daemon not reachable: docker info timed out after 5000 ms' }, calls: 1 },
  { name: 'image absent', info: { stdout: '27.3.1 linux aarch64 8\n' }, inspect: { ok: false, code: 1, stderr: 'Error: No such image' }, want: { state: 'unavailable', why: 'image 0123456789ab is not present on this runner' }, calls: 2 },
  { name: 'image id differs', info: { stdout: '27.3.1 linux aarch64 8\n' }, inspect: { stdout: 'sha256:ffff linux arm64\n' }, want: { state: 'unavailable', why: 'image 0123456789ab is not present on this runner' }, calls: 2 },
  { name: 'arch differs', info: { stdout: '27.3.1 linux aarch64 8\n' }, inspect: { stdout: `${IMAGE} linux amd64\n` }, want: { state: 'unavailable', why: 'image 0123456789ab is linux/amd64, the daemon is linux/arm64' }, calls: 2 },
  { name: 'daemon not linux', info: { stdout: '27.3.1 windows x86_64 8\n' }, inspect: { stdout: `${IMAGE} linux amd64\n` }, want: { state: 'unavailable', why: 'docker daemon OS is windows, not linux' }, calls: 2 },
  { name: 'uid 0', over: { uid: 0 }, info: {}, inspect: {}, want: { state: 'unavailable', why: 'the suite runner must not run as uid 0' }, calls: 0 },
  { name: 'comma in work root', over: { work: '/w,x' }, info: {}, inspect: {}, want: { state: 'unavailable', why: 'the work root contains a comma: /w,x' }, calls: 0 },
  {
    name: 'ready arm64', info: { stdout: '27.3.1 linux aarch64 8\n' }, inspect: { stdout: `${IMAGE} linux arm64\n` }, calls: 2,
    want: { state: 'ready', env: {
      runner: 'node-a', clodex: CLODEX_VERSION, imageVersion: null, imageRev: null, imageDigest: null,
      platform: 'linux', arch: 'arm64', osRelease: null, node: null, git: null, cpus: 8, tz: 'UTC', lang: 'C.UTF-8',
      isolation: 'container', box: { imageId: IMAGE, definitionHash: null, rev: null }, host: { platform: 'darwin', arch: 'arm64' }, envKey: 'b2d0badeb218',
    } },
  },
  {
    name: 'ready amd64', info: { stdout: '27.3.1 linux x86_64 4\n' }, inspect: { stdout: `${IMAGE} linux amd64\n` }, calls: 2,
    want: { state: 'ready', env: {
      runner: 'node-a', clodex: CLODEX_VERSION, imageVersion: null, imageRev: null, imageDigest: null,
      platform: 'linux', arch: 'x64', osRelease: null, node: null, git: null, cpus: 4, tz: 'UTC', lang: 'C.UTF-8',
      isolation: 'container', box: { imageId: IMAGE, definitionHash: null, rev: null }, host: { platform: 'darwin', arch: 'arm64' }, envKey: 'b4bedef734e4',
    } },
  },
];

for (const row of PROBE_ROWS) {
  test(`probe: ${row.name}`, async () => {
    const docker = stubDocker((args) => (args[0] === 'info' ? row.info : row.inspect));
    const box = adapter({ docker, env: { CLODEX_NODE_NAME: 'node-a' }, platform: 'darwin', arch: 'arm64', ...row.over });
    assert.deepStrictEqual(await box.probe(), row.want);
    assert.deepStrictEqual(docker.calls.map((c) => c.opts), Array(row.calls).fill({ timeoutMs: 5000 }));
  });
}

test('probe: the two docker calls, cached for 30 s', async () => {
  let t = 1000;
  const docker = stubDocker((args) => (args[0] === 'info' ? { stdout: '27.3.1 linux aarch64 8\n' } : { stdout: `${IMAGE} linux arm64\n` }));
  const box = adapter({ docker, now: () => t });
  assert.strictEqual((await box.probe()).state, 'ready');
  assert.deepStrictEqual(docker.calls.map((c) => c.args), [
    ['info', '--format', '{{.ServerVersion}} {{.OSType}} {{.Architecture}} {{.NCPU}}'],
    ['image', 'inspect', '--format', '{{.Id}} {{.Os}} {{.Architecture}}', IMAGE],
  ]);
  t += 29999;
  await box.probe();
  assert.strictEqual(docker.calls.length, 2);
  t += 1;
  await box.probe();
  assert.strictEqual(docker.calls.length, 4);
});

const HASH_A = 'a'.repeat(64);
const IMG_A = `sha256:${'1'.repeat(64)}`;
const IMG_A2 = `sha256:${'2'.repeat(64)}`;
const IMG_X = `sha256:${'3'.repeat(64)}`;
const NAMED_ENV = (imageId, envKey) => ({
  runner: 'node-a', clodex: CLODEX_VERSION, imageVersion: null, imageRev: null, imageDigest: null,
  platform: 'linux', arch: 'arm64', osRelease: null, node: null, git: null, cpus: 8, tz: 'UTC', lang: 'C.UTF-8',
  isolation: 'container', box: { imageId, definitionHash: HASH_A, rev: 3 }, host: { platform: 'darwin', arch: 'arm64' }, envKey,
});
const LABEL_A = 'clodex.box=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NAMED_ROWS = [
  { name: 'one labelled image', images: [{ id: IMG_A, labels: [LABEL_A] }], want: { state: 'ready', env: NAMED_ENV(IMG_A, 'b10f4e11e71d') }, verbs: ['info', 'ls', 'inspect'] },
  { name: 'one labelled image and no boxImage', over: { image: null }, images: [{ id: IMG_A, labels: [LABEL_A] }], want: { state: 'ready', env: NAMED_ENV(IMG_A, 'b10f4e11e71d') }, verbs: ['info', 'ls', 'inspect'] },
  { name: 'one labelled image under two tags', images: [{ id: IMG_A, labels: [LABEL_A] }, { id: IMG_A, labels: [LABEL_A] }], want: { state: 'ready', env: NAMED_ENV(IMG_A, 'b10f4e11e71d') }, verbs: ['info', 'ls', 'inspect'] },
  { name: 'no image carries the label', images: [{ id: IMAGE, labels: [] }], want: { state: 'no-image', why: 'no image for box aaaaaaaaaaaa on this runner' }, verbs: ['info', 'ls'] },
  { name: 'only a wrong-arch image carries it', images: [{ id: IMG_X, arch: 'amd64', labels: [LABEL_A] }], want: { state: 'no-image', why: 'no image for box aaaaaaaaaaaa on this runner for linux/arm64' }, verbs: ['info', 'ls', 'inspect'] },
  { name: 'a newer wrong-arch image beside the right one', images: [{ id: IMG_A, labels: [LABEL_A] }, { id: IMG_X, arch: 'amd64', labels: [LABEL_A] }], want: { state: 'ready', env: NAMED_ENV(IMG_A, 'b10f4e11e71d') }, verbs: ['info', 'ls', 'inspect'] },
  {
    name: 'two compatible images carry it', images: [{ id: IMG_A, labels: [LABEL_A] }, { id: IMG_A2, labels: [LABEL_A] }],
    want: { state: 'ambiguous', why: `more than one image carries box aaaaaaaaaaaa on this runner: ${IMG_A}, ${IMG_A2}` }, verbs: ['info', 'ls', 'inspect'],
  },
  { name: 'daemon not linux', info: '29.9.2 windows x86_64 8\n', images: [{ id: IMG_A, labels: [LABEL_A] }], want: { state: 'unavailable', why: 'docker daemon OS is windows, not linux' }, verbs: ['info'] },
  { name: 'image ls fails', fail: { 'image ls': { ok: false, code: 1, stderr: 'Error: boom\n' } }, images: [], want: { state: 'unavailable', why: 'docker image ls failed: Error: boom' }, verbs: ['info', 'ls'] },
  { name: 'uid 0', over: { uid: 0 }, images: [{ id: IMG_A, labels: [LABEL_A] }], want: { state: 'unavailable', why: 'the suite runner must not run as uid 0' }, verbs: [] },
];

for (const row of NAMED_ROWS) {
  test(`probe(want): ${row.name}`, async () => {
    const docker = imagesDocker(row.images, { ...(row.info ? { info: row.info } : {}), ...(row.fail ? { fail: row.fail } : {}) });
    const box = adapter({ docker, env: { CLODEX_NODE_NAME: 'node-a' }, platform: 'darwin', arch: 'arm64', ...row.over });
    assert.deepStrictEqual(await box.probe({ definitionHash: HASH_A, rev: 3 }), row.want);
    assert.deepStrictEqual(docker.calls.map((c) => (c.args[0] === 'image' ? c.args[1] : c.args[0])), row.verbs);
    assert.deepStrictEqual(docker.calls.map((c) => c.opts), Array(row.verbs.length).fill({ timeoutMs: 5000 }));
  });
}

test('probe(want): labels are read only through image ls --filter, ids go as separate argv entries, and every named look is fresh', async () => {
  let t = 1000;
  const docker = imagesDocker([{ id: IMG_A, labels: [LABEL_A] }, { id: IMG_X, arch: 'amd64', labels: [LABEL_A] }, { id: IMAGE, labels: [] }]);
  const box = adapter({ docker, now: () => t });
  assert.strictEqual((await box.probe({ definitionHash: HASH_A, rev: 1 })).state, 'ready');
  assert.deepStrictEqual(docker.calls.map((c) => c.args), [
    ['info', '--format', '{{.ServerVersion}} {{.OSType}} {{.Architecture}} {{.NCPU}}'],
    ['image', 'ls', '-q', '--no-trunc', '--filter', `label=${LABEL_A}`],
    ['image', 'inspect', '--format', '{{.Id}} {{.Os}} {{.Architecture}}', IMG_A, IMG_X],
  ]);
  t += 1;
  await box.probe({ definitionHash: HASH_A, rev: 1 });
  assert.strictEqual(docker.calls.length, 6);
  assert.strictEqual((await box.probe()).env.box.imageId, IMAGE);
  assert.strictEqual(docker.calls.length, 8, 'a named look leaves the default cache empty');
});

test('spawn runs the image stamped on the job, not the adapter default', () => {
  const box = adapter();
  const spawned = [];
  const spawn = (cmd, args) => { spawned.push(args[args.indexOf('-c') - 1]); return { pid: 7 }; };
  const jobDir = '/w/jobs/abcd1234';
  box.spawn({ jobDir, argv: ['node', 'x'], env: box.env(jobDir), spawn, job: { id: 'j-a', identity: { arch: 'arm64', box: { imageId: IMG_A, definitionHash: HASH_A, rev: 1 } } } });
  box.spawn({ jobDir, argv: ['node', 'x'], env: box.env(jobDir), spawn, job: { id: 'j-d', identity: { arch: 'arm64', box: { imageId: IMAGE, definitionHash: null, rev: null } } } });
  assert.deepStrictEqual(spawned, [IMG_A, IMAGE]);
});

const PS =(label) => ['ps', '-aq', '--filter', `label=${label}`];

test('kill: process-group SIGKILL, then ps, rm, ps on the job label', async () => {
  const log = [];
  const docker = stubDocker((args, n) => { log.push(args); return { stdout: n === 1 ? 'c1\nc2\n' : '' }; });
  const box = adapter({ docker, kill: (pid, sig) => log.push(['kill', pid, sig]) });
  await box.kill({ pid: 4242 }, '/w/jobs/abcd1234', ARM_JOB);
  assert.deepStrictEqual(log, [['kill', -4242, 'SIGKILL'], PS('clodex.suite.job=j-1'), ['rm', '-f', 'c1', 'c2'], PS('clodex.suite.job=j-1')]);
  assert.deepStrictEqual(docker.calls.map((c) => c.opts), Array(3).fill({ timeoutMs: 10000 }));
});

test('clear: an empty list returns at once; three non-empty lists throw', async () => {
  const quiet = stubDocker(() => ({ stdout: '' }));
  await adapter({ docker: quiet }).clear('clodex.suite.job=j-1');
  assert.deepStrictEqual(quiet.calls.map((c) => c.args), [PS('clodex.suite.job=j-1')]);
  const stuck = stubDocker((args) => (args[0] === 'ps' ? { stdout: 'c1\n' } : { ok: false, code: 1 }));
  await assert.rejects(adapter({ docker: stuck }).clear('clodex.suite.job=j-1'), { message: 'box cleanup not confirmed: c1' });
  assert.deepStrictEqual(stuck.calls.map((c) => c.args[0]), ['ps', 'rm', 'ps', 'rm', 'ps', 'rm']);
});

test('clear: a failed docker ps is never an empty list (R5)', async () => {
  const ok = stubDocker(() => ({ stdout: '' }));
  await adapter({ docker: ok }).clear('clodex.suite.runner=68ce9ee28045');
  assert.strictEqual(ok.calls.length, 1, 'ENTER: a list that answers empty confirms');
  const down = stubDocker(() => ({ ok: false, code: 1, stdout: '', stderr: `${DOWN}\n` }));
  await assert.rejects(adapter({ docker: down }).clear('clodex.suite.runner=68ce9ee28045'), { message: `box cleanup not confirmed: docker ps failed: ${DOWN}` });
  assert.deepStrictEqual(down.calls.map((c) => c.args[0]), ['ps', 'ps', 'ps']);
  const flaky = stubDocker((args, n) => (n === 1 ? { stdout: 'c1\n' } : args[0] === 'rm' ? {} : { ok: false, code: 1, stdout: '', stderr: `${DOWN}\n` }));
  await assert.rejects(adapter({ docker: flaky }).clear('clodex.suite.job=j-1'), /box cleanup not confirmed: docker ps failed/);
  assert.deepStrictEqual(flaky.calls.map((c) => c.args[0]), ['ps', 'rm', 'ps', 'ps']);
});

test('sweep clears the runner label', async () => {
  const docker = stubDocker(() => ({ stdout: '' }));
  await adapter({ docker }).sweep();
  assert.deepStrictEqual(docker.calls.map((c) => c.args), [PS('clodex.suite.runner=68ce9ee28045')]);
});

test('reap clears the job label then removes the job dir; a failed clear keeps the dir', async () => {
  const root = mkTmpRoot('suite-box-');
  const jobDir = path.join(root, 'jobs', 'abcd1234');
  fs.mkdirSync(path.join(jobDir, 'tree', 'ro'), { recursive: true });
  fs.chmodSync(path.join(jobDir, 'tree', 'ro'), 0o555);
  const down = stubDocker(() => ({ ok: false, code: 1, stderr: DOWN }));
  await assert.rejects(adapter({ docker: down }).reap(jobDir, null, ARM_JOB), /box cleanup not confirmed/);
  assert.ok(fs.existsSync(jobDir));
  const docker = stubDocker(() => ({ stdout: '' }));
  await adapter({ docker }).reap(jobDir, null, ARM_JOB);
  assert.deepStrictEqual(docker.calls.map((c) => c.args), [PS('clodex.suite.job=j-1')]);
  assert.strictEqual(fs.existsSync(jobDir), false);
});

test('seal then attach leave a real empty directory, never a symlink', async () => {
  const root = mkTmpRoot('suite-box-');
  const entry = path.join(root, 'deps', 'r', 'k');
  const jobDir = path.join(root, 'jobs', 'a');
  const tree = path.join(jobDir, 'tree');
  fs.mkdirSync(path.join(tree, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'node_modules', 'x', 'i.js'), 'x');
  fs.mkdirSync(entry, { recursive: true });
  const box = adapter();
  await box.seal(jobDir, entry, ['node_modules', 'vendor']);
  const sealed = fs.lstatSync(path.join(tree, 'node_modules'));
  assert.strictEqual(sealed.isDirectory() && !sealed.isSymbolicLink(), true);
  assert.deepStrictEqual(fs.readdirSync(path.join(tree, 'node_modules')), []);
  assert.strictEqual(fs.readFileSync(path.join(entry, 'node_modules', 'x', 'i.js'), 'utf8'), 'x');
  assert.strictEqual(fs.statSync(path.join(entry, 'node_modules', 'x', 'i.js')).mode & 0o222, 0);
  assert.strictEqual(fs.existsSync(path.join(entry, 'vendor')), false);
  const tree2 = path.join(root, 'jobs', 'b', 'tree');
  fs.mkdirSync(path.join(tree2, 'node_modules', 'stale'), { recursive: true });
  box.attach({ entry }, tree2, ['node_modules', 'vendor']);
  const attached = fs.lstatSync(path.join(tree2, 'node_modules'));
  assert.strictEqual(attached.isDirectory() && !attached.isSymbolicLink(), true);
  assert.deepStrictEqual(fs.readdirSync(path.join(tree2, 'node_modules')), []);
  assert.strictEqual(fs.existsSync(path.join(tree2, 'vendor')), false);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = (sig) => child.kills.push(sig);
  return child;
}

test('createDocker.call: output, ENOENT and a timeout that kills the CLI', async () => {
  const pending = [];
  const timers = { setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length; }, clearTimeout: () => {} };
  const children = [];
  const spawned = [];
  const spawn = (cmd, args, opts) => { spawned.push([cmd, args, opts]); const c = fakeChild(); children.push(c); return c; };
  const docker = createDocker({ spawn, timers, timeoutMs: 10000 });
  const okP = docker.call(['ps', '-aq']);
  children[0].stdout.emit('data', 'c1\n');
  children[0].emit('close', 0);
  assert.deepStrictEqual(await okP, { ok: true, code: 0, stdout: 'c1\n', stderr: '', notFound: false, timedOut: false, error: null });
  assert.deepStrictEqual(spawned[0], ['docker', ['ps', '-aq'], { stdio: ['ignore', 'pipe', 'pipe'] }]);
  const missingP = docker.call(['info']);
  children[1].emit('error', Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }));
  assert.strictEqual((await missingP).notFound, true);
  const slowP = docker.call(['info'], { timeoutMs: 5000 });
  assert.strictEqual(pending[2].ms, 5000);
  pending[2].fn();
  const slow = await slowP;
  assert.deepStrictEqual([slow.ok, slow.timedOut, slow.error, children[2].kills], [false, true, 'docker info timed out after 5000 ms', ['SIGKILL']]);
  const failP = docker.call(['ps', '-aq']);
  children[3].stderr.emit('data', `${DOWN}\n`);
  children[3].emit('close', 1);
  assert.deepStrictEqual(await failP, { ok: false, code: 1, stdout: '', stderr: `${DOWN}\n`, notFound: false, timedOut: false, error: 'docker ps exited 1' });
});

function loadBoxWith(builtins) {
  const Module = require('node:module');
  const fresh = [require.resolve('../suite-box'), require.resolve('../resolve-fs')];
  const saved = fresh.map((k) => require.cache[k]);
  const load = Module._load;
  for (const k of fresh) delete require.cache[k];
  Module._load = function (request, ...rest) {
    return Object.hasOwn(builtins, request) ? builtins[request] : load.call(this, request, ...rest);
  };
  try {
    return require('../suite-box');
  } finally {
    Module._load = load;
    fresh.forEach((k, i) => { if (saved[i]) require.cache[k] = saved[i]; else delete require.cache[k]; });
  }
}

test('seal and reap walk an Electron archive as a file under the resolved fs', async (t) => {
  const realFs = require('../resolve-fs').resolveFs();
  const root = mkTmpRoot('suite-box-asar-');
  t.after(() => { require('node:child_process').spawnSync('chmod', ['-R', 'u+w', root]); realFs.rmSync(root, { recursive: true, force: true }); });
  const jobDir = path.join(root, 'jobs', 'a');
  const entry = path.join(root, 'deps', 'r', 'k');
  const app = path.join(jobDir, 'tree', 'node_modules', 'electron');
  const putArchive = () => { realFs.mkdirSync(app, { recursive: true }); realFs.writeFileSync(path.join(app, 'default_app.asar'), 'archive'); };
  putArchive();
  const isArchive = (p) => String(p).endsWith('.asar');
  const inArchive = (p) => String(p).includes('.asar/');
  const beneath = [];
  const watch = (name, real) => (p, ...rest) => { if (inArchive(p)) beneath.push(`${name} ${p}`); return real(p, ...rest); };
  const electronFs = {
    ...realFs,
    lstatSync: watch('lstatSync', (p) => {
      if (inArchive(p)) return { mode: 0o644, isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true };
      if (isArchive(p)) return { mode: realFs.lstatSync(p).mode, isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false };
      return realFs.lstatSync(p);
    }),
    readdirSync: (p, ...rest) => (isArchive(p) ? ['default_app.js'] : realFs.readdirSync(p, ...rest)),
    chmodSync: watch('chmodSync', (p, mode) => {
      if (inArchive(p)) throw Object.assign(new Error(`ENOTDIR: not a directory, chmod '${p}'`), { code: 'ENOTDIR' });
      realFs.chmodSync(p, mode);
    }),
    rmSync: watch('rmSync', (p, opts) => { if (!inArchive(p)) realFs.rmSync(p, opts); }),
  };
  const chmods = [];
  const originalFs = {
    ...realFs,
    lstatSync: watch('lstatSync', realFs.lstatSync),
    readdirSync: watch('readdirSync', realFs.readdirSync),
    chmodSync: watch('chmodSync', (p, mode) => { chmods.push(p); realFs.chmodSync(p, mode); }),
    rmSync: watch('rmSync', realFs.rmSync),
  };
  const { boxIsolation: box } = loadBoxWith({ fs: electronFs, 'original-fs': originalFs });
  const docker = stubDocker(() => ({ stdout: '' }));
  const adapterAsar = box({ image: IMAGE, work: root, stateDir: STATE, uid: 501, gid: 20, docker });
  await adapterAsar.seal(jobDir, entry, ['node_modules']);
  const archive = path.join(entry, 'node_modules', 'electron', 'default_app.asar');
  assert.ok(chmods.includes(archive), `ENTER: ${chmods.join(', ')}`);
  assert.strictEqual(realFs.lstatSync(archive).mode & 0o222, 0);
  putArchive();
  await adapterAsar.reap(jobDir, entry, ARM_JOB);
  assert.strictEqual(realFs.existsSync(jobDir), false);
  assert.deepStrictEqual(beneath, []);
});
