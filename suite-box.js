'use strict';

const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const { resolveFs } = require('./resolve-fs');

const fs = resolveFs();

const IMAGE_RE = /^sha256:[0-9a-f]{64}$/;
const MOUNT_REL_RE = /^[A-Za-z0-9._@+/-]+$/;
const DEADMAN = 'mkdir -p "$HOME"; exec 3<&0; "$@" </dev/null & pid=$!; { cat <&3 >/dev/null; kill -KILL $$; } & wait $pid; exit $?';
const BOX_ENV = {
  HOME: '/tmp/home',
  TMPDIR: '/tmp',
  GIT_CEILING_DIRECTORIES: '/job',
  LANG: 'C.UTF-8',
  TZ: 'UTC',
  USER: 'box',
  LOGNAME: 'box',
  SHELL: '/bin/sh',
};
const PROBE_MS = 5000;
const PROBE_TTL_MS = 30000;
const CLEAR_MS = 10000;
const CLEAR_ROUNDS = 3;
const BOX_LABEL = 'clodex.box';
const DOCKER_ARCH = { aarch64: 'arm64', x86_64: 'amd64' };
const DEFAULT_TIMERS = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) };

function createDocker({ spawn = childProcess.spawn, timeoutMs = CLEAR_MS, timers = DEFAULT_TIMERS } = {}) {
  function call(args, { timeoutMs: ms = timeoutMs } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ ok: false, code: null, stdout: '', stderr: '', notFound: e.code === 'ENOENT', timedOut: false, error: e.message });
        return;
      }
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      if (child.stdout) child.stdout.on('data', (d) => { stdout += d; });
      if (child.stderr) child.stderr.on('data', (d) => { stderr += d; });
      const settle = (r) => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(timer);
        resolve({ stdout, stderr, timedOut, ...r });
      };
      const timer = timers.setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch {}
        settle({ ok: false, code: null, notFound: false, error: `docker ${args[0]} timed out after ${ms} ms` });
      }, ms);
      child.on('error', (e) => settle({ ok: false, code: null, notFound: e.code === 'ENOENT', error: e.message }));
      child.on('close', (code) => settle({ ok: code === 0, code, notFound: false, error: code === 0 ? null : `docker ${args[0]} exited ${code}` }));
    });
  }
  return { call };
}

function firstLine(s) {
  return String(s || '').trim().split('\n')[0];
}

function callError(r) {
  return firstLine(r.stderr) || r.error || 'no answer';
}

function removeTree(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return; }
  if (st.isDirectory()) {
    try { fs.chmodSync(p, 0o700); } catch {}
    for (const name of fs.readdirSync(p)) removeTree(path.join(p, name));
  }
  fs.rmSync(p, { recursive: true, force: true });
}

function makeReadOnly(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) for (const name of fs.readdirSync(p)) makeReadOnly(path.join(p, name));
  fs.chmodSync(p, (st.mode & 0o555) | 0o444 | (st.isDirectory() ? 0o111 : 0));
}

function runnerKeyOf(stateDir) {
  return crypto.createHash('sha256').update(String(stateDir)).digest('hex').slice(0, 12);
}

function boxPlatform(identity) {
  return `linux/${identity.arch === 'x64' ? 'amd64' : identity.arch}`;
}

function runArgv({ image, runnerKey, n, uid, gid, jobDir, job, argv, env }) {
  const rels = (job.setup && job.depsEntry) ? job.setup.paths : [];
  const mounts = [];
  for (const rel of rels) {
    if (!MOUNT_REL_RE.test(rel)) throw new Error(`setup path not mountable: ${JSON.stringify(rel)}`);
    const src = path.join(job.depsEntry, rel);
    if (fs.existsSync(src)) mounts.push('--mount', `type=bind,src=${src},dst=/job/tree/${rel},readonly`);
  }
  const envArgs = [];
  for (const k of Object.keys(BOX_ENV)) envArgs.push('-e', `${k}=${BOX_ENV[k]}`);
  for (const [k, v] of Object.entries(env || {})) if (!(k in BOX_ENV)) envArgs.push('-e', `${k}=${v}`);
  return [
    'docker', 'run', '-i', '--rm',
    '--name', `clodex-suite-${runnerKey}-${path.basename(jobDir)}-${n}`,
    '--label', 'clodex.suite=1', '--label', `clodex.suite.runner=${runnerKey}`, '--label', `clodex.suite.job=${job.id}`,
    '--platform', boxPlatform(job.identity), '--pull', 'never', '--init', '--log-driver', 'none',
    '--entrypoint', '/bin/sh', '--workdir', '/job/tree', '--user', `${uid}:${gid}`,
    '--network', 'bridge', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '4096', '--shm-size', '1g',
    '--mount', `type=bind,src=${path.join(jobDir, 'tree')},dst=/job/tree`,
    ...mounts,
    ...envArgs,
    image,
    '-c', DEADMAN,
    'sh', ...argv,
  ];
}

function boxIdentity({ imageId, arch, cpus, definitionHash = null, rev = null, env = process.env, platform = process.platform, hostArch = process.arch }) {
  const boxArch = arch === 'amd64' ? 'x64' : arch;
  let clodex = null;
  try { clodex = require('./package.json').version; } catch {}
  return {
    runner: env.CLODEX_NODE_NAME || os.hostname(),
    clodex,
    imageVersion: null,
    imageRev: null,
    imageDigest: null,
    platform: 'linux',
    arch: boxArch,
    osRelease: null,
    node: null,
    git: null,
    cpus,
    tz: 'UTC',
    lang: 'C.UTF-8',
    isolation: 'container',
    box: { imageId, definitionHash, rev },
    host: { platform, arch: hostArch },
    envKey: crypto.createHash('sha256').update(JSON.stringify(['container', imageId, 'linux', boxArch, cpus, 'UTC', 'C.UTF-8'])).digest('hex').slice(0, 12),
  };
}

function boxIsolation({
  image, work, stateDir, docker = createDocker(), kill = process.kill.bind(process),
  uid = process.getuid(), gid = process.getgid(), now = Date.now, env = process.env,
  platform = process.platform, arch = process.arch,
}) {
  const runnerKey = runnerKeyOf(stateDir);
  let counter = 0;
  let cached = null;

  async function clear(label) {
    let last = '';
    for (let round = 0; round < CLEAR_ROUNDS; round++) {
      const r = await docker.call(['ps', '-aq', '--filter', `label=${label}`], { timeoutMs: CLEAR_MS });
      if (!r.ok) { last = `docker ps failed: ${callError(r)}`; continue; }
      const ids = String(r.stdout).split('\n').map((s) => s.trim()).filter(Boolean);
      if (!ids.length) return;
      last = ids.join(' ');
      await docker.call(['rm', '-f', ...ids], { timeoutMs: CLEAR_MS });
    }
    throw new Error(`box cleanup not confirmed: ${last}`);
  }

  function hostWhy() {
    if (uid === 0) return 'the suite runner must not run as uid 0';
    if (String(work).includes(',')) return `the work root contains a comma: ${work}`;
    return null;
  }

  async function daemon() {
    const d = await docker.call(['info', '--format', '{{.ServerVersion}} {{.OSType}} {{.Architecture}} {{.NCPU}}'], { timeoutMs: PROBE_MS });
    if (d.notFound) return { why: 'docker not found on PATH' };
    if (!d.ok) return { why: `docker daemon not reachable: ${callError(d)}` };
    const [, daemonOs, daemonArch, ncpu] = String(d.stdout).trim().split(/\s+/);
    return { os: daemonOs, arch: DOCKER_ARCH[daemonArch] || daemonArch, cpus: Number(ncpu) };
  }

  async function look() {
    if (!IMAGE_RE.test(String(image))) return { state: 'unavailable', why: 'CLODEX_SUITE_BOX_IMAGE must be an image id (sha256:…), not a tag' };
    const host = hostWhy();
    if (host) return { state: 'unavailable', why: host };
    const id12 = image.slice('sha256:'.length, 'sha256:'.length + 12);
    const d = await daemon();
    if (d.why) return { state: 'unavailable', why: d.why };
    const i = await docker.call(['image', 'inspect', '--format', '{{.Id}} {{.Os}} {{.Architecture}}', image], { timeoutMs: PROBE_MS });
    const [imageId, imageOs, imageArch] = i.ok ? String(i.stdout).trim().split(/\s+/) : [];
    if (!i.ok || imageId !== image) return { state: 'unavailable', why: `image ${id12} is not present on this runner` };
    if (d.os !== 'linux') return { state: 'unavailable', why: `docker daemon OS is ${d.os}, not linux` };
    if (imageOs !== 'linux' || imageArch !== d.arch) return { state: 'unavailable', why: `image ${id12} is ${imageOs}/${imageArch}, the daemon is linux/${d.arch}` };
    return { state: 'ready', env: boxIdentity({ imageId: image, arch: imageArch, cpus: d.cpus, env, platform, hostArch: arch }) };
  }

  async function lookNamed({ definitionHash, rev = null }) {
    const hash12 = String(definitionHash).slice(0, 12);
    const host = hostWhy();
    if (host) return { state: 'unavailable', why: host };
    const d = await daemon();
    if (d.why) return { state: 'unavailable', why: d.why };
    if (d.os !== 'linux') return { state: 'unavailable', why: `docker daemon OS is ${d.os}, not linux` };
    const ls = await docker.call(['image', 'ls', '-q', '--no-trunc', '--filter', `label=${BOX_LABEL}=${definitionHash}`], { timeoutMs: PROBE_MS });
    if (!ls.ok) return { state: 'unavailable', why: `docker image ls failed: ${callError(ls)}` };
    const ids = [...new Set(String(ls.stdout).split('\n').map((s) => s.trim()).filter((s) => IMAGE_RE.test(s)))];
    if (!ids.length) return { state: 'no-image', why: `no image for box ${hash12} on this runner` };
    const i = await docker.call(['image', 'inspect', '--format', '{{.Id}} {{.Os}} {{.Architecture}}', ...ids], { timeoutMs: PROBE_MS });
    if (!i.ok) return { state: 'unavailable', why: `docker image inspect failed: ${callError(i)}` };
    const fit = new Set();
    for (const line of String(i.stdout).split('\n')) {
      const [imageId, imageOs, imageArch] = line.trim().split(/\s+/);
      if (ids.includes(imageId) && imageOs === 'linux' && imageArch === d.arch) fit.add(imageId);
    }
    if (!fit.size) return { state: 'no-image', why: `no image for box ${hash12} on this runner for linux/${d.arch}` };
    if (fit.size > 1) return { state: 'ambiguous', why: `more than one image carries box ${hash12} on this runner: ${[...fit].join(', ')}` };
    return { state: 'ready', env: boxIdentity({ imageId: [...fit][0], arch: d.arch, cpus: d.cpus, definitionHash, rev, env, platform, hostArch: arch }) };
  }

  return {
    mode: 'container',
    user: 'box',
    node: 'node',
    detach: true,
    runnerKey,
    clear,
    async probe(want = null) {
      if (want) return lookNamed(want);
      if (cached && now() - cached.at < PROBE_TTL_MS) return cached.answer;
      const answer = await look();
      cached = { at: now(), answer };
      return answer;
    },
    sweep: () => clear(`clodex.suite.runner=${runnerKey}`),
    env() { return { ...BOX_ENV }; },
    async prepare() {},
    spawn({ jobDir, argv, env: jobEnv, spawn, job }) {
      counter += 1;
      const stamped = job.identity && job.identity.box ? job.identity.box.imageId : null;
      const full = runArgv({ image: stamped || image, runnerKey, n: counter, uid, gid, jobDir, job, argv, env: jobEnv });
      return spawn(full[0], full.slice(1), { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    },
    async kill(child, jobDir, job) {
      if (child && child.pid > 0) { try { kill(-child.pid, 'SIGKILL'); } catch {} }
      await clear(`clodex.suite.job=${job.id}`);
    },
    attach(deps, tree, rels) {
      for (const rel of rels) {
        if (!fs.existsSync(path.join(deps.entry, rel))) continue;
        const at = path.join(tree, rel);
        removeTree(at);
        fs.mkdirSync(at, { recursive: true });
      }
    },
    async seal(jobDir, entry, rels) {
      const tree = path.join(jobDir, 'tree');
      for (const rel of rels) {
        const from = path.join(tree, rel);
        const to = path.join(entry, rel);
        if (!fs.existsSync(from)) continue;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        makeReadOnly(to);
        fs.mkdirSync(from);
      }
    },
    async reap(jobDir, entry, job) {
      await clear(`clodex.suite.job=${job.id}`);
      removeTree(jobDir);
    },
  };
}

module.exports = { createDocker, boxIsolation, runArgv, boxIdentity, runnerKeyOf, BOX_ENV, DEADMAN };
