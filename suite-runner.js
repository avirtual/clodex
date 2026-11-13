'use strict';

const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const snapshot = require('./suite-snapshot');
const { git } = require('./git-worktree');
const { resolveFs } = require('./resolve-fs');

const fs = resolveFs();

const LIVE = new Set(['awaiting-pack', 'queued', 'setup', 'running']);
const KIND_ORDER = { 'post-merge': 0, verify: 1, hand: 2 };
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BOX_HASH_RE = /^[0-9a-f]{64}$/;
const BOX_DEFINITION_MAX = 16384;
const BOX_REFUSALS = { 'no-image': 'no-image', ambiguous: 'ambiguous-image' };
const REF_RE = /^(?![-/.])(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const FLAG_KEYS = ['CLODEX_TEST_LOCK', 'CLODEX_TEST_SLOW_ADVISORY'];
const BASE_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'USER', 'LOGNAME', 'SHELL', 'ELECTRON_RUN_AS_NODE', 'GIT_CEILING_DIRECTORIES'];
const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const HOMEBREW_ARM_PATH = '/opt/homebrew/bin:/opt/homebrew/sbin';

function jobPath(platform, arch) {
  return platform === 'darwin' && arch === 'arm64' ? `${HOMEBREW_ARM_PATH}:${SAFE_PATH}` : SAFE_PATH;
}

function jobLang(platform) {
  return platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
}
const HELPER = '/usr/local/libexec/clodex-suite-exec';
const SUITE_USER = 'clodex-suite';
const TEST_ARGV = ['scripts/run-tests.js', '--reporter=dot'];
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

const DEFAULT_LIMITS = {
  packMaxBytes: snapshot.DEFAULT_PACK_MAX,
  chunkMax: 4 * 1024 ** 2,
  readChunk: 1024 ** 2,
  queueMax: 32,
  leaseMs: 2 * MIN,
  keepMs: DAY,
  keepCount: 50,
  treeCap: 2 * 1024 ** 3,
  timeoutMs: 21 * MIN,
  maxTimeoutMs: 36 * MIN,
  setupTimeoutMs: 15 * MIN,
  outputMax: 64 * 1024 ** 2,
  peekMax: 1024 ** 2,
  waitMax: 25 * 1000,
  cacheMaxBytes: 10 * 1024 ** 3,
  cacheIdleMs: 14 * DAY,
  tickMs: 15 * 1000,
};

const DEFAULT_TIMERS = { setTimeout, clearTimeout, setInterval, clearInterval };

function fail(status, error, extra) {
  return { ok: false, status, error, ...extra };
}

function relSafe(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= 1024 && !p.startsWith('-') && !path.isAbsolute(p)
    && !p.split(/[\\/]/).some((seg) => seg === '..' || seg === '') && !p.includes('\0');
}

function writeJson(file, value, mode) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  if (mode != null) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function movePath(from, to) {
  try { fs.renameSync(from, to); return; } catch (e) { if (e.code !== 'EXDEV') throw e; }
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  forceRemove(from);
}

function statePaths(root) {
  const dir = path.join(root, 'suite-runner');
  return { dir, jobs: path.join(dir, 'jobs'), cache: path.join(dir, 'cache.json'), ledger: path.join(dir, 'ledger.jsonl') };
}

function moveState(from, to) {
  if (!from || path.resolve(from.dir) === path.resolve(to.dir) || !fs.existsSync(from.dir)) return;
  for (const id of (fs.existsSync(from.jobs) ? fs.readdirSync(from.jobs) : [])) {
    if (!fs.existsSync(path.join(to.jobs, id))) movePath(path.join(from.jobs, id), path.join(to.jobs, id));
  }
  if (fs.existsSync(from.cache) && !fs.existsSync(to.cache)) movePath(from.cache, to.cache);
  if (fs.existsSync(from.ledger)) {
    if (fs.existsSync(to.ledger)) fs.writeFileSync(to.ledger, Buffer.concat([fs.readFileSync(from.ledger), fs.readFileSync(to.ledger)]));
    else movePath(from.ledger, to.ledger);
  }
  forceRemove(from.dir);
}

function closeDeps(depsRoot) {
  fs.chmodSync(depsRoot, 0o711);
  for (const repo of fs.readdirSync(depsRoot)) {
    const dir = path.join(depsRoot, repo);
    if (!fs.lstatSync(dir).isDirectory()) continue;
    fs.chmodSync(dir, 0o711);
    for (const name of fs.readdirSync(dir)) {
      const st = fs.lstatSync(path.join(dir, name));
      if (st.isDirectory()) fs.chmodSync(path.join(dir, name), 0o700);
      else if (st.isFile()) fs.chmodSync(path.join(dir, name), 0o600);
    }
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function forceRemove(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return; }
  if (st.isDirectory()) {
    try { fs.chmodSync(p, 0o700); } catch {}
    for (const name of fs.readdirSync(p)) forceRemove(path.join(p, name));
  }
  fs.rmSync(p, { recursive: true, force: true });
}

function makeReadOnly(p, io = fs) {
  const st = io.lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) for (const name of io.readdirSync(p)) makeReadOnly(path.join(p, name), io);
  io.chmodSync(p, (st.mode & 0o555) | 0o444 | (st.isDirectory() ? 0o111 : 0));
}

function bytesOf(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of fs.readdirSync(p)) total += bytesOf(path.join(p, name));
  return total;
}

function utf8Slice(buf) {
  let start = 0;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  let end = buf.length;
  let back = end - 1;
  while (back >= start && (buf[back] & 0xc0) === 0x80) back--;
  if (back >= start) {
    const lead = buf[back];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (end - back < need) end = back;
  }
  return { skip: start, text: buf.subarray(start, end).toString('utf8') };
}

function waitChild(child) {
  return new Promise((resolve) => {
    let err = '';
    if (child.stderr) child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, error: err.trim() }));
  });
}

function jobPaths(work, id) {
  const dir = path.join(work, 'jobs', crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 8));
  return { dir, tree: path.join(dir, 'tree'), home: path.join(dir, 'home'), tmp: path.join(dir, 'tmp') };
}

function enclosingRepo(dir) {
  let p = path.resolve(dir);
  const rest = [];
  while (!fs.existsSync(p) && path.dirname(p) !== p) {
    rest.unshift(path.basename(p));
    p = path.dirname(p);
  }
  p = path.join(fs.realpathSync(p), ...rest);
  for (;;) {
    if (fs.existsSync(path.join(p, '.git'))) return p;
    const up = path.dirname(p);
    if (up === p) return null;
    p = up;
  }
}

function noneIsolation({ user = os.userInfo().username, kill = process.kill.bind(process), fs: io = fs } = {}) {
  return {
    mode: 'none',
    user,
    async probe() { return { mode: 'none' }; },
    async prepare() {},
    spawn({ cwd, argv, env, spawn }) {
      return spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    },
    kill(child) {
      try { kill(-child.pid, 'SIGKILL'); } catch {}
    },
    async seal(jobDir, entry, rels) {
      const tree = path.join(jobDir, 'tree');
      for (const rel of rels) {
        const from = path.join(tree, rel);
        const to = path.join(entry, rel);
        if (!io.existsSync(from)) continue;
        io.mkdirSync(path.dirname(to), { recursive: true });
        io.renameSync(from, to);
        makeReadOnly(to, io);
        io.symlinkSync(to, from);
      }
    },
    async reap(jobDir) { forceRemove(jobDir); },
  };
}

const entryArg = (entry) => (entry ? [entry] : []);

function userIsolation({ helper = HELPER, user = SUITE_USER, spawn = childProcess.spawn } = {}) {
  const call = (args) => waitChild(spawn('sudo', ['-n', ...args], { env: { PATH: SAFE_PATH }, stdio: ['ignore', 'ignore', 'pipe'] }));
  const must = async (verb, args) => {
    const r = await call([helper, verb, ...args]);
    if (!r.ok) throw new Error(`clodex-suite-exec ${verb} failed: ${r.error}`);
  };
  return {
    mode: 'user',
    user,
    async probe() {
      const r = await call(['-l', helper]);
      return r.ok ? { mode: 'user' } : { mode: 'unavailable', why: r.error || `sudo -n ${helper} is not allowed` };
    },
    prepare: (jobDir, mirror, entry) => must('prepare', [jobDir, mirror, ...entryArg(entry)]),
    spawn({ jobDir, argv, env, spawn: sp }) {
      const pairs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
      return sp('sudo', ['-n', helper, 'run', jobDir, ...pairs, '--', ...argv], {
        env: { PATH: SAFE_PATH }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    },
    kill(child, jobDir) { return call([helper, 'reap', jobDir]); },
    seal: (jobDir, entry, rels) => must('seal', [jobDir, entry, ...rels]),
    reap: (jobDir, entry) => must('reap', [jobDir, ...entryArg(entry)]),
  };
}

async function envIdentity({ isolation, env = process.env, imageFile = '/etc/clodex/image.json', platform = process.platform } = {}) {
  const gitRun = await git(os.tmpdir(), ['--version']);
  const image = readJson(imageFile, {});
  let clodex = null;
  try { clodex = require('./package.json').version; } catch {}
  const id = {
    runner: env.CLODEX_NODE_NAME || os.hostname(),
    clodex,
    imageVersion: image.version || null,
    imageRev: image.rev || null,
    imageDigest: env.CLODEX_IMAGE_DIGEST || null,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    node: process.version,
    git: gitRun.ok ? String(gitRun.stdout).trim().replace(/^git version /, '') : null,
    cpus: os.cpus().length,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    lang: jobLang(platform),
    isolation: isolation || null,
  };
  const { runner, ...rest } = id;
  id.envKey = crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 12);
  return id;
}

function validateSubmit(b, limits) {
  if (!b || typeof b !== 'object') return 'body must be an object';
  if (!ID_RE.test(String(b.id))) return 'bad id';
  if (b.attempt != null && !(Number.isInteger(b.attempt) && b.attempt >= 1)) return 'bad attempt';
  for (const k of ['repoKey', 'snap', 'treeHash', 'indexTree', 'sha']) if (!SHA_RE.test(String(b[k]))) return `bad ${k}`;
  if (!(b.kind in KIND_ORDER)) return 'bad kind';
  if (b.branch != null && !REF_RE.test(String(b.branch))) return 'bad branch';
  if (b.trunk != null && !REF_RE.test(String(b.trunk))) return 'bad trunk';
  const refs = b.refs || {};
  if (typeof refs !== 'object' || Array.isArray(refs)) return 'bad refs';
  for (const [name, sha] of Object.entries(refs)) if (!REF_RE.test(name) || !SHA_RE.test(String(sha))) return `bad ref ${name}`;
  if (b.candidates != null && (!Array.isArray(b.candidates) || b.candidates.length > 64)) return 'bad candidates';
  if (b.files != null && (!Array.isArray(b.files) || !b.files.every(relSafe))) return 'bad files';
  const flags = b.flags || {};
  for (const [k, v] of Object.entries(flags)) if (!FLAG_KEYS.includes(k) || typeof v !== 'string') return `flag not allowed: ${k}`;
  const env = b.env || {};
  if (typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 32) return 'bad env';
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME_RE.test(k) || BASE_ENV_KEYS.includes(k) || k.startsWith('CLODEX_')) return `env key not allowed: ${k}`;
    if (typeof v !== 'string' || v.length > 1000 || v.includes('\0')) return `bad env value: ${k}`;
  }
  if (b.setup != null) {
    const s = b.setup;
    if (typeof s.run !== 'string' || !s.run || s.run.length > 2000) return 'bad setup.run';
    if (!Array.isArray(s.key) || s.key.length > 16 || !s.key.every(relSafe)) return 'bad setup.key';
    if (!Array.isArray(s.paths) || s.paths.length > 8 || !s.paths.every(relSafe)) return 'bad setup.paths';
    if (s.timeoutMs != null && !(s.timeoutMs >= 10000 && s.timeoutMs <= 30 * MIN)) return 'bad setup.timeoutMs';
  }
  if (b.timeoutMs != null && !(b.timeoutMs > 0 && b.timeoutMs <= limits.maxTimeoutMs)) return 'bad timeoutMs';
  if (b.isolation != null && b.isolation !== 'container') return 'bad isolation';
  if (b.box != null) {
    const x = b.box;
    if (typeof x !== 'object' || Array.isArray(x) || b.isolation !== 'container') return 'bad box';
    if (!BOX_HASH_RE.test(String(x.definitionHash))) return 'bad box.definitionHash';
    if (!(Number.isInteger(x.rev) && x.rev >= 1)) return 'bad box.rev';
    if (x.definition != null && !(typeof x.definition === 'string' && Buffer.byteLength(x.definition) <= BOX_DEFINITION_MAX)) return 'bad box.definition';
  }
  return null;
}

function fileSha256({ file, bytes }, readChunk) {
  if (!bytes) return Promise.resolve(crypto.createHash('sha256').digest('hex'));
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file, { highWaterMark: readChunk, start: 0, end: bytes - 1 });
    input.on('data', (d) => hash.update(d));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function createSuiteRunner({
  root, oldRoot = null, work, isolation = userIsolation(), limits = {}, spawn = childProcess.spawn,
  now = Date.now, log = () => {}, timers = DEFAULT_TIMERS, platform = process.platform, arch = process.arch,
  box = null, boxSweep = null,
}) {
  const repo = enclosingRepo(work);
  if (repo) throw new Error(`the work root is inside the git repository ${repo}; choose a work folder outside any repository`);
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const state = statePaths(root);
  const storeDir = state.jobs;
  const ledgerFile = state.ledger;
  fs.mkdirSync(storeDir, { recursive: true });
  fs.chmodSync(state.dir, 0o700);
  moveState(oldRoot ? statePaths(oldRoot) : null, state);
  fs.mkdirSync(path.join(work, 'jobs'), { recursive: true });
  work = fs.realpathSync(work);
  fs.chmodSync(work, 0o711);
  for (const d of ['mirrors', 'deps']) {
    fs.mkdirSync(path.join(work, d), { recursive: true });
    fs.chmodSync(path.join(work, d), 0o711);
  }
  for (const name of fs.readdirSync(path.join(work, 'mirrors'))) {
    if (name.endsWith('.git')) fs.chmodSync(path.join(work, 'mirrors', name), 0o700);
  }
  closeDeps(path.join(work, 'deps'));
  const cacheFile = state.cache;
  const workCache = path.join(work, 'cache.json');
  if (fs.existsSync(workCache)) {
    if (!fs.existsSync(cacheFile)) writeJson(cacheFile, readJson(workCache, {}));
    fs.rmSync(workCache, { force: true });
  }
  const bootId = crypto.randomUUID();
  const jobs = new Map();
  const waiters = new Set();
  let seq = 0;
  let active = null;
  let running = null;
  let maintenance = null;
  let interval = null;
  let closed = false;
  let recovering = true;
  let pumpAfterRecovery = false;
  let isoState = null;
  let identity = null;
  const holdFile = path.join(state.dir, 'box-hold.json');
  let boxHold = readJson(holdFile, null);
  let sweeping = null;
  const sweepBox = box ? () => box.sweep() : boxSweep;

  const isBox = (job) => job.isolation === 'container';
  const namedBox = (job) => Boolean(job.identity && job.identity.box && job.identity.box.definitionHash);
  const isoOf = (job) => (isBox(job) ? box : isolation);
  const jobArg = (job) => (isBox(job) ? [job] : []);
  const jobStore = (id) => path.join(storeDir, id);
  const jobWork = (id) => jobPaths(work, id).dir;
  const outFile = (id, stream) => path.join(jobStore(id), stream);
  const packFile = (id) => path.join(jobStore(id), 'pack');
  const save = (job) => writeJson(path.join(jobStore(job.id), 'job.json'), job);
  const anyLive = () => [...jobs.values()].some((j) => LIVE.has(j.state));

  function queue() {
    return [...jobs.values()].filter((j) => j.state === 'queued')
      .sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (a.seq - b.seq));
  }

  function positionOf(job) {
    return job.state === 'queued' ? queue().indexOf(job) + 1 : null;
  }

  function notify(id) {
    for (const w of [...waiters]) if (w.ids.has(id)) w.wake();
  }

  function setState(job, state, patch = {}) {
    Object.assign(job, patch, { state });
    save(job);
    notify(job.id);
  }

  function view(job) {
    const queueMs = job.startedAt != null ? job.startedAt - job.queuedAt : null;
    return {
      id: job.id, attempt: job.attempt, state: job.state, position: positionOf(job), reason: job.reason,
      exit: job.exit, treeHash: job.treeHash, queueMs, setupMs: job.setupMs, runMs: job.runMs,
      env: job.identity || null, out: job.out, record: job.record || null,
    };
  }

  function touchCache(rel) {
    const cache = readJson(cacheFile, {});
    cache[rel] = now();
    writeJson(cacheFile, cache);
  }

  async function ensureIdentity() {
    if (!isoState) isoState = await isolation.probe();
    if (!identity) identity = await envIdentity({ isolation: isoState.mode, platform });
    return identity;
  }

  function setHold(next) {
    boxHold = next;
    if (next) writeJson(holdFile, next, 0o600);
    else fs.rmSync(holdFile, { force: true });
  }

  function enterHold(why, dirs) {
    setHold({ why, dirs: [...new Set([...(boxHold ? boxHold.dirs : []), ...dirs])] });
    log(`suite-runner: box cleanup held: ${why}`);
  }

  function sweepOnce() {
    if (!sweeping) {
      sweeping = Promise.resolve().then(() => sweepBox()).then(() => null, (e) => e.message)
        .finally(() => { sweeping = null; });
    }
    return sweeping;
  }

  function clearHold(held) {
    for (const dir of held.dirs) forceRemove(dir);
    setHold(null);
  }

  async function releaseHold() {
    const held = boxHold;
    if (!held || !sweepBox) return false;
    const error = await sweepOnce();
    if (boxHold !== held) return false;
    if (error != null) { setHold({ ...held, why: error }); return false; }
    clearHold(held);
    return true;
  }

  async function recoverBox(interrupted) {
    const dirs = interrupted.map((job) => jobWork(job.id));
    if (!box) {
      if (dirs.length) enterHold('no box is configured to confirm cleanup', dirs);
      await releaseHold();
      return;
    }
    const error = await sweepOnce();
    if (error != null) { enterHold(error, dirs); return; }
    if (boxHold) clearHold(boxHold);
    for (const job of interrupted) {
      try { await box.reap(jobWork(job.id), null, job); } catch (e) { enterHold(e.message, [jobWork(job.id)]); }
    }
  }

  function recover() {
    const reaps = [];
    const boxed = [];
    for (const id of fs.readdirSync(storeDir)) {
      const job = readJson(path.join(jobStore(id), 'job.json'), null);
      if (!job || job.id !== id) { forceRemove(jobStore(id)); continue; }
      seq = Math.max(seq, job.seq || 0);
      if (job.state === 'awaiting-pack') { forceRemove(jobStore(id)); continue; }
      jobs.set(id, job);
      if (job.state === 'queued') job.lastSeen = now();
      if (job.state === 'queued' && isBox(job) && (!box || (box.labelsOnly && !namedBox(job)))) {
        finishRecord(job, { reason: 'box-unavailable', exit: null });
        save(job);
      }
      if (job.state === 'setup' || job.state === 'running') {
        finishRecord(job, { reason: 'runner-restart', exit: null });
        save(job);
        if (isBox(job)) boxed.push(job);
        else reaps.push(Promise.resolve().then(() => isolation.reap(jobWork(id))).catch((e) => log(`suite-runner: reap ${id} after restart failed: ${e.message}`)));
      }
    }
    if ((box && !box.labelsOnly) || boxed.length || boxHold) reaps.push(recoverBox(boxed).catch((e) => log(`suite-runner: box recovery failed: ${e.message}`)));
    return Promise.all(reaps);
  }

  function reconcile() {
    const cache = readJson(cacheFile, {});
    const kept = {};
    for (const [rel, at] of Object.entries(cache)) if (fs.existsSync(path.join(work, rel))) kept[rel] = at;
    const depsRoot = path.join(work, 'deps');
    for (const repo of fs.readdirSync(depsRoot)) {
      const dir = path.join(depsRoot, repo);
      if (!fs.lstatSync(dir).isDirectory()) continue;
      const names = fs.readdirSync(dir);
      const isDir = (name) => fs.lstatSync(path.join(dir, name)).isDirectory();
      const dirs = new Set();
      for (const name of names.filter(isDir)) {
        const rel = path.join('deps', repo, name);
        let marker = null;
        try { marker = fs.lstatSync(path.join(dir, `${name}.json`)); } catch {}
        if (rel in kept && marker && marker.isFile()) { dirs.add(name); continue; }
        forceRemove(path.join(dir, name));
        delete kept[rel];
      }
      for (const name of names) {
        if (dirs.has(name) || (name.endsWith('.json') && dirs.has(name.slice(0, -5)))) continue;
        forceRemove(path.join(dir, name));
      }
    }
    if (JSON.stringify(kept) !== JSON.stringify(cache)) writeJson(cacheFile, kept);
  }

  function finishRecord(job, { reason, exit }) {
    const endedAt = now();
    job.state = 'done';
    job.reason = reason;
    job.exit = exit;
    job.endedAt = endedAt;
    job.record = {
      id: job.id, jobId: job.id, attempt: job.attempt, kind: job.kind, scope: job.scope || null,
      team: job.team || null, ticket: job.ticket || null, seat: job.seat || null,
      sha: job.sha, branch: job.branch || null, treeHash: job.treeHash, pid: job.pid || null,
      queuedAt: job.queuedAt, startedAt: job.startedAt != null ? job.startedAt : null, endedAt,
      durationMs: job.startedAt != null ? endedAt - job.startedAt : null,
      outcome: reason == null ? null : 'unknown', reason, exit,
      pass: null, fail: null, tests: null,
      queueMs: job.startedAt != null ? job.startedAt - job.queuedAt : null,
      setupMs: job.setupMs != null ? job.setupMs : null, runMs: job.runMs != null ? job.runMs : null,
      env: job.identity || null, where: 'runner',
    };
    try { fs.appendFileSync(ledgerFile, `${JSON.stringify(job.record)}\n`); } catch (e) { log(`suite-runner: ledger write failed: ${e.message}`); }
  }

  async function finish(job, outcome, killing = null) {
    if (job.state === 'done') return;
    finishRecord(job, outcome);
    save(job);
    notify(job.id);
    if (job.startedAt == null) return;
    if (killing) await killing;
    try {
      await isoOf(job).reap(jobWork(job.id), job.depsEntry || null, ...jobArg(job));
    } catch (e) {
      log(`suite-runner: reap ${job.id} failed: ${e.message}`);
      if (isBox(job)) enterHold(e.message, [jobWork(job.id)]);
    }
  }

  function enqueue(job) {
    seq += 1;
    setState(job, 'queued', { seq, committedAt: now() });
    const answer = { ok: true, id: job.id, state: job.state, position: positionOf(job) };
    pump();
    return answer;
  }

  function pump() {
    if (recovering) { pumpAfterRecovery = true; return; }
    if (closed || active || maintenance) return;
    const next = queue().find((j) => !isBox(j) || !boxHold);
    if (!next) return;
    active = next.id;
    runJob(next)
      .catch(async (e) => {
        try { fs.appendFileSync(outFile(next.id, 'stderr'), `suite-runner: ${e.message}\n`); } catch {}
        await finish(next, { reason: 'setup-failed', exit: null });
      })
      .finally(() => {
        active = null;
        running = null;
        retain();
        if (!anyLive()) maintain().catch((e) => log(`suite-runner: maintenance failed: ${e.message}`));
        else pump();
      });
  }

  function depsEntry(job, tree) {
    const h = crypto.createHash('sha256');
    h.update(`run\0${job.setup.run}\0`);
    for (const rel of job.setup.key) {
      h.update(`key\0${rel}\0`);
      const p = path.join(tree, rel);
      let st = null;
      try { st = fs.lstatSync(p); } catch {}
      if (!st) h.update('missing\0');
      else if (st.isSymbolicLink()) h.update(`link\0${fs.readlinkSync(p)}\0`);
      else if (st.isFile()) h.update(fs.readFileSync(p));
      else h.update('other\0');
    }
    h.update(`env\0${job.identity.envKey}`);
    const key = h.digest('hex');
    const rel = path.join('deps', job.repoKey, key);
    const entry = path.join(work, rel);
    return { key, rel, entry, marker: `${entry}.json`, hit: fs.existsSync(`${entry}.json`) };
  }

  function linkDeps(deps, tree, rels) {
    for (const rel of rels) {
      const target = path.join(deps.entry, rel);
      if (!fs.existsSync(target)) continue;
      const at = path.join(tree, rel);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      forceRemove(at);
      fs.symlinkSync(target, at);
    }
  }

  function resetOutputs(job) {
    for (const s of ['stdout', 'stderr']) fs.writeFileSync(outFile(job.id, s), '');
    job.out = { stdoutBytes: 0, stderrBytes: 0, truncated: false };
  }

  function childEnv(job, jobDir) {
    const env = { ...(job.env || {}) };
    for (const k of FLAG_KEYS) if (job.flags && typeof job.flags[k] === 'string') env[k] = job.flags[k];
    const iso = isoOf(job);
    if (iso.env) return Object.assign(env, iso.env(jobDir));
    Object.assign(env, {
      PATH: jobPath(platform, arch),
      HOME: path.join(jobDir, 'home'),
      TMPDIR: path.join(jobDir, 'tmp'),
      GIT_CEILING_DIRECTORIES: jobDir,
      LANG: jobLang(platform),
      TZ: 'UTC',
      USER: isolation.user,
      LOGNAME: isolation.user,
      SHELL: '/bin/sh',
    });
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    return env;
  }

  function killRunning(state, child, jobDir, job) {
    if (state.killing) return;
    try { state.killing = Promise.resolve(isoOf(job).kill(child, jobDir, ...jobArg(job))).catch((e) => log(`suite-runner: kill failed: ${e.message}`)); } catch (e) { log(`suite-runner: kill failed: ${e.message}`); }
  }

  function exec(job, jobDir, argv, ms) {
    return new Promise((resolve) => {
      const fds = { stdout: fs.openSync(outFile(job.id, 'stdout'), 'a'), stderr: fs.openSync(outFile(job.id, 'stderr'), 'a') };
      const closeFds = () => { for (const fd of Object.values(fds)) { try { fs.closeSync(fd); } catch {} } };
      let child;
      try {
        child = isoOf(job).spawn({ jobDir, cwd: path.join(jobDir, 'tree'), argv, env: childEnv(job, jobDir), spawn, ...(isBox(job) ? { job } : {}) });
      } catch (e) {
        fs.writeSync(fds.stderr, `suite-runner: spawn failed: ${e.message}\n`);
        closeFds();
        resolve({ code: null, signal: null, error: e.message, spawnFailed: true });
        return;
      }
      const state = { timedOut: false, stopped: null, killing: null };
      running = { job, child, jobDir, state };
      job.pid = child.pid || null;
      const timer = timers.setTimeout(() => { state.timedOut = true; killRunning(state, child, jobDir, job); }, ms);
      for (const s of ['stdout', 'stderr']) {
        if (!child[s]) continue;
        child[s].on('data', (chunk) => {
          const used = job.out.stdoutBytes + job.out.stderrBytes;
          const room = Math.max(0, lim.outputMax - used);
          const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
          if (part.length < chunk.length) job.out.truncated = true;
          if (part.length) fs.writeSync(fds[s], part);
          job.out[`${s}Bytes`] += part.length;
        });
      }
      let settled = false;
      const done = (code, signal, error) => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(timer);
        closeFds();
        running = null;
        resolve({ code, signal, error, timedOut: state.timedOut, stopped: state.stopped, killing: state.killing });
      };
      child.on('error', (e) => done(null, null, e.message));
      child.on('close', (code, signal) => done(code, signal));
    });
  }

  async function runJob(job) {
    const isolation = isoOf(job);
    const startedAt = now();
    setState(job, 'setup', { startedAt });
    resetOutputs(job);
    const jobDir = jobWork(job.id);
    const tree = path.join(jobDir, 'tree');
    const mirror = snapshot.mirrorPath(work, job.repoKey);
    forceRemove(jobDir);
    for (const d of ['home', 'tmp']) fs.mkdirSync(path.join(jobDir, d), { recursive: true });
    touchCache(path.join('mirrors', `${job.repoKey}.git`));
    const built = await snapshot.materialize({
      mirror, dir: tree, snap: job.snap, treeHash: job.treeHash,
      indexTree: job.indexTree, head: job.sha, branch: job.branch || null, refs: job.refs || {},
      treeCap: lim.treeCap, tmpRoot: jobDir,
    });
    if (job.stop) return finish(job, { reason: job.stop, exit: null });
    if (!built.ok) {
      fs.appendFileSync(outFile(job.id, 'stderr'), `suite-runner: ${built.reason}${built.treeHash ? ` (${built.treeHash} != ${job.treeHash})` : ''}\n`);
      return finish(job, { reason: built.reason, exit: null });
    }
    if (isolation.detach) {
      const detached = await snapshot.detachTree(tree);
      log(`suite-runner: detached ${job.id} in ${detached.ms} ms`);
      if (job.stop) return finish(job, { reason: job.stop, exit: null });
      if (!detached.ok) {
        fs.appendFileSync(outFile(job.id, 'stderr'), `suite-runner: detach failed: ${detached.error}\n`);
        return finish(job, { reason: 'setup-failed', exit: null });
      }
    }
    const deps = job.setup ? depsEntry(job, tree) : null;
    if (deps) {
      fs.mkdirSync(path.dirname(deps.entry), { recursive: true });
      fs.chmodSync(path.dirname(deps.entry), 0o711);
      if (!deps.hit) forceRemove(deps.entry);
      fs.mkdirSync(deps.entry, { recursive: true });
      fs.chmodSync(deps.entry, 0o700);
      job.depsEntry = deps.entry;
    }
    if (deps && deps.hit) {
      if (isolation.attach) isolation.attach(deps, tree, job.setup.paths);
      else linkDeps(deps, tree, job.setup.paths);
      writeJson(deps.marker, { ...readJson(deps.marker, {}), usedAt: now() }, 0o600);
      touchCache(deps.rel);
    }
    await isolation.prepare(jobDir, mirror, deps ? deps.entry : null);
    if (job.stop) return finish(job, { reason: job.stop, exit: null });
    if (deps && !deps.hit) {
      const r = await exec(job, jobDir, ['/bin/sh', '-c', job.setup.run], job.setup.timeoutMs || lim.setupTimeoutMs);
      if (job.stop) return finish(job, { reason: job.stop, exit: null }, r.killing);
      if (r.spawnFailed && isolation.mode === 'container') return finish(job, { reason: 'setup-failed', exit: null });
      if (r.code !== 0) return finish(job, { reason: 'setup-failed', exit: { code: r.code, signal: r.signal || null } }, r.killing);
      await isolation.seal(jobDir, deps.entry, job.setup.paths);
      writeJson(deps.marker, { createdAt: now(), usedAt: now() }, 0o600);
      touchCache(deps.rel);
      resetOutputs(job);
    }
    const runStartedAt = now();
    setState(job, 'running', { setupMs: runStartedAt - startedAt, runStartedAt });
    const ms = Math.min(job.timeoutMs || lim.timeoutMs, lim.maxTimeoutMs);
    const r = await exec(job, jobDir, [isolation.node || process.execPath, ...TEST_ARGV, ...(job.files || [])], ms);
    job.runMs = now() - runStartedAt;
    const boxed = isolation.mode === 'container';
    if (boxed && r.spawnFailed && !job.stop) return finish(job, { reason: 'setup-failed', exit: null });
    const reason = job.stop || (r.timedOut ? 'timeout' : null) || (boxed && (r.code === 125 || r.error) ? 'box-failed' : null);
    return finish(job, { reason, exit: { code: r.code, signal: r.signal || null } }, r.killing);
  }

  function retain() {
    const done = [...jobs.values()].filter((j) => j.state === 'done').sort((a, b) => b.endedAt - a.endedAt);
    done.forEach((job, i) => {
      if (i >= lim.keepCount || now() - job.endedAt > lim.keepMs) {
        jobs.delete(job.id);
        forceRemove(jobStore(job.id));
      }
    });
  }

  function cacheEntries() {
    const out = [];
    const mirrors = path.join(work, 'mirrors');
    for (const name of (fs.existsSync(mirrors) ? fs.readdirSync(mirrors) : [])) {
      if (name.endsWith('.git')) out.push({ rel: path.join('mirrors', name), paths: [path.join(mirrors, name)] });
    }
    const deps = path.join(work, 'deps');
    for (const repo of (fs.existsSync(deps) ? fs.readdirSync(deps) : [])) {
      for (const name of fs.readdirSync(path.join(deps, repo))) {
        if (name.endsWith('.json')) continue;
        const entry = path.join(deps, repo, name);
        out.push({ rel: path.join('deps', repo, name), paths: [entry, `${entry}.json`] });
      }
    }
    return out;
  }

  async function maintain() {
    if (recovering || maintenance || anyLive()) return { ran: false };
    maintenance = (async () => {
      const mirrors = path.join(work, 'mirrors');
      for (const name of (fs.existsSync(mirrors) ? fs.readdirSync(mirrors) : [])) {
        if (anyLive()) return { ran: false };
        if (name.endsWith('.git')) await snapshot.gcMirror(path.join(mirrors, name));
      }
      if (anyLive()) return { ran: false };
      const cache = readJson(cacheFile, {});
      const entries = cacheEntries().map((e) => ({ ...e, usedAt: cache[e.rel] || 0, bytes: e.paths.reduce((n, p) => n + bytesOf(p), 0) }));
      let total = entries.reduce((n, e) => n + e.bytes, 0);
      const removed = [];
      for (const e of entries.sort((a, b) => a.usedAt - b.usedAt)) {
        if (now() - e.usedAt > lim.cacheIdleMs || total > lim.cacheMaxBytes) {
          for (const p of e.paths) forceRemove(p);
          delete cache[e.rel];
          total -= e.bytes;
          removed.push(e.rel);
        }
      }
      writeJson(cacheFile, cache);
      return { ran: true, removed };
    })();
    try { return await maintenance; } finally { maintenance = null; pump(); }
  }

  async function boxState(want = null) {
    if (!box || (!want && box.labelsOnly)) return null;
    if (boxHold) return { state: 'unavailable', why: `cleanup not confirmed: ${boxHold.why}` };
    let found;
    try { found = await (want ? box.probe(want) : box.probe()); } catch (e) { return { state: 'unavailable', why: e.message }; }
    if (want && found && BOX_REFUSALS[found.state]) return { state: found.state, why: found.why };
    return found && found.state === 'ready' ? { state: 'ready', env: found.env } : { state: 'unavailable', why: (found && found.why) || 'no answer' };
  }

  async function info() {
    const env = await ensureIdentity();
    return {
      ok: true, bootId, env, isolation: isoState, box: await boxState(),
      limits: { packMaxBytes: lim.packMaxBytes, chunkMax: lim.chunkMax, queueMax: lim.queueMax },
      queue: { running: active, queued: queue().map((j) => j.id) },
    };
  }

  async function submit(body) {
    const bad = validateSubmit(body, lim);
    if (bad) return fail(400, bad);
    const existing = jobs.get(body.id);
    if (existing) {
      if (existing.treeHash !== body.treeHash) return fail(409, 'job id already submitted with a different treeHash');
      existing.lastSeen = now();
      return { ok: true, id: existing.id, state: existing.state, position: positionOf(existing), have: existing.have || [] };
    }
    const boxed = body.isolation === 'container';
    let stamp;
    if (boxed) {
      const want = body.box ? { definitionHash: body.box.definitionHash, rev: body.box.rev } : null;
      if (!box || (!want && box.labelsOnly)) return fail(409, 'this runner has no box image configured');
      const b = await boxState(want);
      if (BOX_REFUSALS[b.state]) return fail(409, b.why, { code: BOX_REFUSALS[b.state] });
      if (b.state !== 'ready') return fail(503, `box unavailable: ${b.why}`, want ? { code: 'box-unavailable' } : undefined);
      stamp = b.env;
    } else {
      stamp = await ensureIdentity();
      if (isoState.mode === 'unavailable') return fail(503, `isolation unavailable: ${isoState.why}`);
    }
    const waiting = [...jobs.values()].filter((j) => j.state === 'awaiting-pack' || j.state === 'queued').length;
    if (waiting >= lim.queueMax) return fail(429, 'queue full');
    const job = {
      id: body.id, attempt: body.attempt || 1, repoKey: body.repoKey, kind: body.kind, scope: body.scope || null,
      team: body.team || null, ticket: body.ticket || null, seat: body.seat || null,
      snap: body.snap, indexTree: body.indexTree, treeHash: body.treeHash, sha: body.sha,
      branch: body.branch || null, trunk: body.trunk || null, refs: body.refs || {},
      files: body.files || [], flags: body.flags || {}, setup: body.setup || null, env: body.env || {},
      timeoutMs: body.timeoutMs || null, state: 'awaiting-pack', reason: null, exit: null,
      queuedAt: now(), lastSeen: now(), identity: stamp, out: { stdoutBytes: 0, stderrBytes: 0, truncated: false },
      ...(boxed ? { isolation: 'container' } : {}),
    };
    jobs.set(job.id, job);
    fs.mkdirSync(jobStore(job.id), { recursive: true });
    fs.writeFileSync(packFile(job.id), '');
    save(job);
    const mirror = snapshot.mirrorPath(work, job.repoKey);
    if (!body.full && await snapshot.mirrorHolds(mirror, [job.snap, job.indexTree, ...Object.values(job.refs)])) {
      if (job.state !== 'awaiting-pack') return { ok: true, id: job.id, state: job.state };
      await keep(job, mirror);
      if (job.state !== 'awaiting-pack') return fail(409, `job is ${job.state}`, { state: job.state });
      return enqueue(job);
    }
    job.have = body.full ? [] : await snapshot.mirrorHave(mirror, (body.candidates || []).map(String));
    save(job);
    return { ok: true, id: job.id, state: job.state, have: job.have };
  }

  async function keep(job, mirror) {
    await snapshot.keepRefs(mirror, {
      stamp: now(), id: job.id, snap: job.snap, indexTree: job.indexTree,
      trunkSha: job.trunk && job.refs[job.trunk] ? job.refs[job.trunk] : null,
    });
  }

  async function putPack(id, offset, chunk) {
    const job = jobs.get(id);
    if (!job) return fail(404, 'no such job');
    if (job.state !== 'awaiting-pack') return fail(409, `job is ${job.state}`, { state: job.state });
    job.lastSeen = now();
    const size = fs.statSync(packFile(id)).size;
    if (offset !== size) return fail(409, 'offset is not the current size', { have: size });
    if (chunk.length > lim.chunkMax) return fail(413, 'chunk too large');
    if (size + chunk.length > lim.packMaxBytes) return fail(413, 'pack too large');
    fs.appendFileSync(packFile(id), chunk);
    return { ok: true, size: size + chunk.length };
  }

  async function commit(id, { bytes, sha256 } = {}) {
    const job = jobs.get(id);
    if (!job) return fail(404, 'no such job');
    if (job.state !== 'awaiting-pack') return fail(409, `job is ${job.state}`, { state: job.state });
    job.lastSeen = now();
    const pack = { file: packFile(id), bytes: fs.statSync(packFile(id)).size };
    if (pack.bytes !== bytes) return fail(400, 'pack size mismatch', { have: pack.bytes });
    if (await fileSha256(pack, lim.readChunk) !== sha256) return fail(400, 'pack hash mismatch');
    while (maintenance) await maintenance.catch(() => {});
    const mirror = snapshot.mirrorPath(work, job.repoKey);
    const res = await snapshot.ingestPack(pack, {
      workDir: work, repoKey: job.repoKey, snap: job.snap, indexTree: job.indexTree, refs: job.refs, maxInputSize: lim.packMaxBytes, readChunk: lim.readChunk,
    });
    if (job.state !== 'awaiting-pack') return fail(409, `job is ${job.state}`, { state: job.state });
    if (!res.ok) {
      fs.writeFileSync(packFile(id), '');
      if (res.reason === 'incomplete') return fail(409, 'objects missing after indexing', { incomplete: true });
      return fail(400, `bad pack: ${res.error || res.reason}`);
    }
    await keep(job, mirror);
    if (job.state !== 'awaiting-pack') return fail(409, `job is ${job.state}`, { state: job.state });
    touchCache(path.join('mirrors', `${job.repoKey}.git`));
    forceRemove(packFile(id));
    return enqueue(job);
  }

  function touch(ids) {
    for (const id of ids) {
      const job = jobs.get(id);
      if (job && LIVE.has(job.state)) job.lastSeen = now();
    }
  }

  async function poll(ids, { wait = 0 } = {}) {
    const list = [...new Set((ids || []).map(String))].filter((id) => ID_RE.test(id));
    touch(list);
    const before = list.map((id) => (jobs.get(id) || {}).state).join(',');
    const settled = list.some((id) => !jobs.has(id) || jobs.get(id).state === 'done');
    if (wait > 0 && list.length && !settled) {
      await new Promise((resolve) => {
        const w = { ids: new Set(list) };
        const timer = timers.setTimeout(() => w.wake(), Math.min(wait, lim.waitMax));
        w.wake = () => { timers.clearTimeout(timer); waiters.delete(w); resolve(); };
        waiters.add(w);
        if (list.map((id) => (jobs.get(id) || {}).state).join(',') !== before) w.wake();
      });
      touch(list);
    }
    return {
      ok: true, bootId,
      jobs: list.map((id) => (jobs.has(id) ? view(jobs.get(id)) : { id, state: 'gone' })),
    };
  }

  async function output(id, { stream = 'stdout', offset = 0, length = lim.peekMax } = {}) {
    const job = jobs.get(id);
    if (!job) return fail(404, 'no such job');
    if (stream !== 'stdout' && stream !== 'stderr') return fail(400, 'bad stream');
    let total = 0;
    try { total = fs.statSync(outFile(id, stream)).size; } catch { return { ok: true, total: 0, offset: 0, text: '' }; }
    const start = Math.max(0, Math.min(Number(offset) || 0, total));
    const len = Math.max(0, Math.min(Number(length) || 0, lim.peekMax, total - start));
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(outFile(id, stream), 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    const { skip, text } = utf8Slice(buf);
    return { ok: true, total, offset: start + skip, text };
  }

  async function stop(id, reason) {
    const job = jobs.get(id);
    if (!job || job.state === 'done') return;
    if (job.state === 'awaiting-pack' || job.state === 'queued') {
      await finish(job, { reason, exit: null });
      forceRemove(packFile(id));
      return;
    }
    job.stop = reason;
    if (running && running.job === job) {
      running.state.stopped = reason;
      killRunning(running.state, running.child, running.jobDir, job);
    }
  }

  async function cancel(id) {
    await stop(String(id), 'cancelled');
    return { ok: true };
  }

  async function tick() {
    for (const job of [...jobs.values()]) {
      if (LIVE.has(job.state) && !job.stop && now() - job.lastSeen > lim.leaseMs) {
        log(`suite-runner: job ${job.id} lease expired`);
        await stop(job.id, 'lease-expired');
      }
    }
    retain();
    const boxActive = active && jobs.has(active) && isBox(jobs.get(active));
    if (boxHold && !boxActive && !recovering) await releaseHold();
    if (!anyLive()) return maintain();
    pump();
    return { ran: false };
  }

  function start() {
    if (!interval) {
      interval = timers.setInterval(() => { tick().catch((e) => log(`suite-runner: tick failed: ${e.message}`)); }, lim.tickMs);
      if (interval && interval.unref) interval.unref();
    }
    pump();
  }

  function close() {
    closed = true;
    if (interval) timers.clearInterval(interval);
    interval = null;
    for (const w of [...waiters]) w.wake();
  }

  recover().then(reconcile).catch((e) => log(`suite-runner: reconcile failed: ${e.message}`)).then(() => { recovering = false; if (pumpAfterRecovery) pump(); });

  return { info, submit, putPack, commit, poll, output, cancel, tick, start, close, busy: anyLive };
}

module.exports = { createSuiteRunner, noneIsolation, resolveFs, userIsolation, envIdentity, jobPaths, statePaths, jobPath, jobLang, DEFAULT_LIMITS };
