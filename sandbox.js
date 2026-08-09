// Electron-free and deps-injected: this module must never require('electron'),
// so the unit suite can drive it with spawn/docker mocked.
// <userData>/<subdir>/compose.yaml is regenerated from the config on every
// Start — never hand-edited, never the source of truth.
'use strict';

const cp = require('child_process');
const crypto = require('crypto');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { readEnvFile, writeEnvFile } = require('./env-file');
const { createDetectCache } = require('./detect-cache');

const DEFAULT_PORTS = { web: 7810, wirescope: 7811, wire: 7820 };

const DEFAULT_CONFIG = {
  workDir: null,
  webPort: DEFAULT_PORTS.web,
  wirescopePort: DEFAULT_PORTS.wirescope,
  wirePort: DEFAULT_PORTS.wire,
  autoStart: false,
  image: null,
  mounts: [],
};

const RESERVED_MOUNT_TARGETS = ['/data', '/home/clodex/work', '/home/clodex/.clodex', '/home/clodex/.claude'];
const MOUNT_TARGET_ROOT = '/home/clodex';
const WORK_CONTAINER_DIR = '/home/clodex/work';

// Container-side ports — FIXED by the image (docker/web/Dockerfile env), so the
// host publishes map host<config> → container<these>. Not user-configurable.
const CONTAINER_PORTS = { web: 8080, wirescope: 7800, wire: 7900 };

// Read-only host binds layered on top of the clodex-dot volume, deliberately
// SHADOWING these subpaths: the box reads host libraries live while still
// writing run/, messages/, pending/, registry into the volume underneath.
const LIBRARY_MOUNT_DIRS = ['skills', 'agents', 'library'];

const GHCR_REPO = 'ghcr.io/avirtual/clodex';

const SANDBOX_PEER_ID = 'sandbox';
const SANDBOX_PEER_LABEL = 'sandbox';

// Docker derives the compose project name from this id, and project names
// disallow dots and uppercase — two ids differing only in case would collapse
// to one project and share volumes. Creation is gated here; the store's
// sanitizer stays broader so a persisted row is never eaten.
const BOX_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// 'host' is the placement selector's value for "this Mac", so a box with that
// id would be unaddressable. BOX_ID_RE alone would admit it.
const RESERVED_BOX_IDS = new Set(['host']);

const DETECT_TIMEOUT_MS = 4000;
const PORT_SCAN_WINDOW = 40;


function resolveImage({ isPackaged, appVersion, override, repoRoot }) {
  if (override) return { kind: 'image', image: override };
  if (isPackaged) return { kind: 'image', image: `${GHCR_REPO}:${appVersion}` };
  return { kind: 'build', context: repoRoot, dockerfile: 'docker/web/Dockerfile' };
}

function nextFreePort(desired, isBusy, taken) {
  const claimed = taken || new Set();
  let p = desired;
  while (isBusy(p) || claimed.has(p)) p++;
  claimed.add(p);
  return p;
}

function resolvePorts(config, isBusy) {
  const c = { ...DEFAULT_CONFIG, ...(config || {}) };
  const taken = new Set();
  return {
    web: nextFreePort(c.webPort, isBusy, taken),
    wirescope: nextFreePort(c.wirescopePort, isBusy, taken),
    wire: nextFreePort(c.wirePort, isBusy, taken),
  };
}

function defaultMountTarget(hostPath) {
  return path.posix.join(MOUNT_TARGET_ROOT, path.basename(hostPath));
}

// True when either container target equals or nests under the other — in BOTH
// directions, because a user bind that CONTAINS a reserved path shadows it just
// as surely as one nested inside it.
// The parent's separator is appended only when it is not already there. Without
// that, `/` built the prefix `'//'`, which no reserved path starts with, so the
// single target that dominates all four — root — was the one value this guard
// admitted. Every enumerated reserved path was refused correctly; the value that
// is not a member but a prefix of every member was not.
function mountTargetsConflict(a, b) {
  if (a === b) return true;
  const under = (child, parent) => child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
  return under(a, b) || under(b, a);
}

function normalizeMounts(rawMounts) {
  const out = [];
  const taken = new Set();
  for (const m of (rawMounts || [])) {
    const host = String((m && m.host) || '').trim();
    if (!host) continue;
    if (!path.isAbsolute(host)) return { error: `Mount source must be an absolute path: ${host}` };
    const ro = !!(m && m.ro);
    let target = String((m && m.container) || '').trim();
    if (target) {
      if (!path.posix.isAbsolute(target)) return { error: `Mount target must be an absolute path: ${target}` };
    } else {
      target = defaultMountTarget(host);
      if (taken.has(target)) {
        let n = 2;
        while (taken.has(`${target}-${n}`)) n++;
        target = `${target}-${n}`;
      }
    }
    for (const reserved of RESERVED_MOUNT_TARGETS) {
      if (mountTargetsConflict(target, reserved)) {
        return { error: `Mount target ${target} would shadow the sandbox's ${reserved}` };
      }
    }
    if (taken.has(target)) return { error: `Duplicate mount target: ${target}` };
    taken.add(target);
    out.push({ host, container: target, ro });
  }
  return { mounts: out };
}

// Passed explicitly via -p so each box's volume/network namespace keys off the
// box id rather than the compose file's parent-dir basename, which docker
// would otherwise derive.
function composeProjectName(id) {
  const cleaned = String(id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '');
  return cleaned || SANDBOX_PEER_ID;
}

// The `/`-joined remainder if `child` equals or sits under `parent`, else null.
// Boundary-safe via path.relative (so /a/bc is NOT under /a/b); '' when equal.
// Host paths compare with the host separator; the remainder is returned posix so
// it can be joined onto a container target.
function relUnder(child, parent) {
  const rel = path.relative(parent, child);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function translatePath({ hostPath, workDir, mounts }) {
  const host = String(hostPath || '').trim();
  if (!host || !path.isAbsolute(host)) return { reachable: false };
  const candidates = [];
  if (workDir) candidates.push({ host: workDir, container: WORK_CONTAINER_DIR });
  const norm = normalizeMounts(mounts);
  if (!norm.error) for (const m of norm.mounts) candidates.push({ host: m.host, container: m.container });
  candidates.sort((a, b) => b.host.length - a.host.length);
  for (const c of candidates) {
    const rel = relUnder(host, c.host);
    if (rel !== null) return { container: rel ? path.posix.join(c.container, rel) : c.container };
  }
  return { reachable: false };
}

// YAML double-quoted escapes for the C0 controls that have one. Anything else
// in that range falls back to `\xNN`, which is also valid double-quoted YAML.
const YAML_ESCAPES = {
  '\0': '\\0', '\b': '\\b', '\t': '\\t', '\n': '\\n',
  '\v': '\\v', '\f': '\\f', '\r': '\\r', '\x1b': '\\e',
};

// Emit `value` as a YAML double-quoted scalar that parses back to `value`
// EXACTLY. Double-quoted (not single) because only that style can express
// control characters at all.
//
// The two characters that must be escaped are the two the style is built from:
// a bare `"` closes the scalar early (`/tmp/a"b` produced `- "/tmp/a"b:/x"`,
// which is not the path and may not even parse), and a bare `\` is read as the
// start of an escape sequence — `\b` silently becomes a backspace, `\U` is a
// parse error. A raw newline is worse than either: it splits one volume entry
// across two lines, so the second half is parsed as its own list item.
// Everything else — spaces, `#`, `:`, leading specials — needs no escape and
// survives verbatim, which is what the quoting was there for in the first place.
function yamlQuote(value) {
  const escaped = String(value)
    .replace(/[\\"]/g, (c) => `\\${c}`)
    .replace(/[\x00-\x1f\x7f]/g, (c) => YAML_ESCAPES[c] || `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return `"${escaped}"`;
}

function generateCompose({ image, ports, workDir, authEnvFile, libDir, mounts, hostname }) {
  // The container hostname IS the engine's SELF_LABEL on the peer wire, so it must
  // be UNIQUE per managed box or two boxes would both self-identify as 'sandbox'
  // and DM reply routing would collide (M6b). Defaults to the shared box's id so
  // the single-box bytes stay byte-identical (the compose tests pin `sandbox`).
  const boxHostname = hostname || SANDBOX_PEER_ID;
  const L = [];
  L.push('# GENERATED by Clodex (sandbox.js) — do NOT edit.');
  L.push('# Regenerated from the ui-settings `sandbox` config on every Start; edits are lost.');
  L.push('# Source of truth: sandbox.js + docker/web/compose.yaml.');
  L.push('');
  L.push('services:');
  L.push('  clodex:');
  L.push(`    hostname: ${boxHostname}`);
  if (image.kind === 'build') {
    L.push('    build:');
    L.push(`      context: ${image.context}`);
    L.push(`      dockerfile: ${image.dockerfile}`);
  } else {
    L.push(`    image: ${image.image}`);
  }
  // Loopback publishes — the v1 trust boundary (only this machine reaches them).
  L.push('    ports:');
  L.push(`      - "127.0.0.1:${ports.web}:${CONTAINER_PORTS.web}"`);
  L.push(`      - "127.0.0.1:${ports.wirescope}:${CONTAINER_PORTS.wirescope}"`);
  L.push(`      - "127.0.0.1:${ports.wire}:${CONTAINER_PORTS.wire}"`);
  L.push('    environment:');
  // Compose ${VAR:-default} interpolations — single-quoted here so JS never
  // touches them; the wirescope public URL tracks the (possibly bumped) host port.
  L.push('      CLODEX_WEB_TOKEN: "${CLODEX_WEB_TOKEN:-}"');
  L.push('      CLODEX_WORKSPACES: "${CLODEX_WORKSPACES:-default}"');
  L.push(`      CLODEX_WIRESCOPE_PUBLIC_URL: "\${CLODEX_WIRESCOPE_PUBLIC_URL:-http://localhost:${ports.wirescope}}"`);
  if (authEnvFile) {
    L.push('    env_file:');
    L.push(`      - ${yamlQuote(authEnvFile)}`);
  }
  L.push('    volumes:');
  L.push('      - clodex-data:/data');
  L.push('      - clodex-dot:/home/clodex/.clodex');
  if (libDir) {
    for (const d of LIBRARY_MOUNT_DIRS) {
      L.push(`      - ${yamlQuote(`${path.join(libDir, d)}:/home/clodex/.clodex/${d}:ro`)}`);
    }
  }
  L.push('      - claude-auth:/home/clodex/.claude');
  if (workDir) {
    // Quoted via yamlQuote, not by hand: a host path with YAML-special chars
    // (`#` truncates, leading specials can change the node type) survives
    // verbatim as the source — and the quoting style's OWN characters (`"`,
    // `\`, newline) are escaped rather than assumed absent, which is exactly
    // the case hand-rolled quotes get wrong.
    L.push(`      - ${yamlQuote(`${workDir}:/home/clodex/work`)}`);
  } else {
    L.push('      - clodex-work:/home/clodex/work');
  }
  // Appended AFTER the box's own volumes so a user bind can never precede (and
  // shadow) the load-bearing ones. A normalizeMounts violation throws rather
  // than writing a broken compose.
  const resolvedMounts = normalizeMounts(mounts);
  if (resolvedMounts.error) throw new Error(resolvedMounts.error);
  for (const mnt of resolvedMounts.mounts) {
    L.push(`      - ${yamlQuote(`${mnt.host}:${mnt.container}${mnt.ro ? ':ro' : ''}`)}`);
  }
  L.push('    init: true');
  L.push('    restart: always');
  L.push('    healthcheck:');
  L.push(`      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:${CONTAINER_PORTS.web}/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]`);
  L.push('      interval: 30s');
  L.push('      timeout: 5s');
  L.push('      retries: 3');
  L.push('      start_period: 10s');
  L.push('');
  L.push('volumes:');
  L.push('  clodex-data:');
  L.push('  clodex-dot:');
  L.push('  claude-auth:');
  if (!workDir) L.push('  clodex-work:');
  L.push('');
  return L.join('\n');
}

// The ports an existing generated compose.yaml already publishes are OURS: a
// live-connect probe would read them as busy and bump all three, drifting the
// ports (and the peer url) upward on every re-up. Callers subtract these from
// the busy set.
function parseOwnPorts(yamlText) {
  const out = [];
  if (!yamlText) return out;
  for (const m of yamlText.matchAll(/127\.0\.0\.1:(\d+):\d+/g)) {
    const p = parseInt(m[1], 10);
    if (Number.isInteger(p)) out.push(p);
  }
  return out;
}

function parseOwnPortMap(yamlText) {
  const out = {};
  if (!yamlText) return out;
  const roleByContainer = {
    [CONTAINER_PORTS.web]: 'web',
    [CONTAINER_PORTS.wirescope]: 'wirescope',
    [CONTAINER_PORTS.wire]: 'wire',
  };
  for (const m of yamlText.matchAll(/127\.0\.0\.1:(\d+):(\d+)/g)) {
    const host = parseInt(m[1], 10);
    const role = roleByContainer[parseInt(m[2], 10)];
    if (role && Number.isInteger(host)) out[role] = host;
  }
  return out;
}

// `docker compose ps --format json` emits EITHER a single JSON array OR
// newline-delimited JSON objects (version-dependent). Parse both, tolerant of
// partial/garbage lines.
function parsePsRows(stdout) {
  const text = (stdout || '').trim();
  if (!text) return [];
  try {
    const arr = JSON.parse(text);
    if (Array.isArray(arr)) return arr;
    if (arr && typeof arr === 'object') return [arr];
  } catch { /* fall through to NDJSON */ }
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { /* skip a bad line */ }
  }
  return rows;
}

function parseComposeState(stdout) {
  const rows = parsePsRows(stdout);
  if (!rows.length) return 'absent';
  const svc = rows.find((r) => r && r.Service === 'clodex') || rows[0];
  const state = String((svc && (svc.State || svc.Status)) || '').toLowerCase();
  if (state.includes('running') || state.includes('up')) return 'running';
  return 'exited';
}


function probeDocker(spawn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('docker', ['info', '--format', '{{.ServerVersion}}'],
        { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      resolve({ present: false, running: false });
      return;
    }
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done({ present: true, running: false, timedOut: true });
    }, DETECT_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ present: e && e.code !== 'ENOENT', running: false });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      done({ present: true, running: code === 0 });
    });
  });
}


// Operator-facing docker-remedy copy. KEEP IN SYNC with
// renderer/lib/sandbox-view.js detectNotice — the dialog shows the same two
// messages for a down/absent daemon, and a late compose failure (daemon died
// between probe and click) must surface the SAME copy rather than raw stderr.
const DOCKER_ABSENT_MSG = 'Docker isn’t installed — sandboxes need Docker Desktop.';
const DOCKER_DOWN_MSG = 'Docker daemon isn’t running — start Docker Desktop.';

function dockerUnavailableError(stderr) {
  const s = String(stderr || '');
  if (/cannot connect to the docker daemon|is the docker daemon running|docker daemon is not running|error during connect/i.test(s)) {
    return DOCKER_DOWN_MSG;
  }
  if (/\bENOENT\b|spawn docker|command not found|executable file not found|docker: not found|not recognized as/i.test(s)) {
    return DOCKER_ABSENT_MSG;
  }
  return null;
}


function createSandbox(deps = {}) {
  // Individual consts (not a destructure-with-defaults) so each dep name is
  // visible to the leak-scanner's ownDefinitions — engine.js's seam pattern, for
  // the same reason. Injected for testability; production defaults need no wiring.
  const spawn = deps.spawn || cp.spawn;
  const getUserDataPath = deps.getUserDataPath;
  const getUiSettings = deps.getUiSettings;
  const syncPeerManager = deps.syncPeerManager || (() => {});
  const appVersion = deps.appVersion || require('./package.json').version;
  const isPackaged = deps.isPackaged || (() => false);
  const repoRoot = deps.repoRoot || __dirname;
  const isPortInUse = deps.isPortInUse || defaultIsPortInUse;
  const log = deps.log || { info() {}, error() {} };
  const detect = deps.detect || (() => probeDocker(spawn));
  const invalidateDetect = deps.invalidateDetect || (() => {});
  const registryDir = deps.registryDir || path.join(os.homedir(), '.clodex');

  const id = deps.id || SANDBOX_PEER_ID;
  const boxLabel = deps.label || SANDBOX_PEER_LABEL;
  const subdir = deps.subdir || 'sandbox';
  const readBoxConfig = deps.readBoxConfig
    || (() => { try { return getUiSettings().get().sandbox || {}; } catch { return {}; } });
  const writeBoxConfig = deps.writeBoxConfig
    || ((next) => { getUiSettings().set({ sandbox: next }); });
  const serialize = deps.serialize || ((fn) => fn());

  function sandboxDir() { return path.join(getUserDataPath(), subdir); }
  function composePath() { return path.join(sandboxDir(), 'compose.yaml'); }
  function authEnvPath() { return path.join(sandboxDir(), 'auth.env'); }

  function getConfig() {
    let s = {};
    try { s = readBoxConfig() || {}; } catch { s = {}; }
    return { ...DEFAULT_CONFIG, ...s, hasToken: hasAuthToken() };
  }
  function setConfig(partial) {
    const next = { ...getConfig(), ...(partial || {}) };
    delete next.hasToken;   // derived, file-backed — never persisted to ui-settings
    if (partial && 'mounts' in partial) {
      const checked = validateMountsForSave(next.mounts);
      if (checked.error) return { ok: false, error: checked.error };
      next.mounts = checked.mounts;
    }
    writeBoxConfig(next);
    return getConfig();
  }

  function validateMountsForSave(rawMounts) {
    const norm = normalizeMounts(rawMounts);
    if (norm.error) return norm;
    const clean = [];
    for (const m of (rawMounts || [])) {
      const host = String((m && m.host) || '').trim();
      if (!host) continue;
      try {
        if (!fs.statSync(host).isDirectory()) return { error: `Mount source is not a folder: ${host}` };
      } catch { return { error: `Mount source does not exist: ${host}` }; }
      const entry = { host, ro: !!(m && m.ro) };
      const target = String((m && m.container) || '').trim();
      if (target) entry.container = target;
      clean.push(entry);
    }
    return { mounts: clean };
  }

  function translateHostPath(hostPath) {
    const config = getConfig();
    return translatePath({ hostPath, workDir: config.workDir, mounts: config.mounts });
  }

  // <userData>/<subdir>/auth.env (mode 0600), referenced by the generated compose
  // via env_file — so CLAUDE_CODE_OAUTH_TOKEN and CLODEX_REMOTE_TOKEN reach the
  // container's environment yet never enter the compose bytes, the config store,
  // logs, or any IPC result. Multi-key on purpose: setting or clearing one token
  // must not disturb the other. Writes are atomic; an empty set deletes the file.
  function readAuthEnv() { return readEnvFile(authEnvPath()); }
  function writeAuthEnv(env) { writeEnvFile(authEnvPath(), env); }

  // hasAuthToken tracks the OAuth key SPECIFICALLY (not mere file existence) —
  // the auth.env file may exist for the remote token alone, which must not read
  // as an OAuth "configured" state in the dialog.
  function hasAuthToken() {
    try { return !!readAuthEnv().CLAUDE_CODE_OAUTH_TOKEN; } catch { return false; }
  }
  function setAuthToken(token) {
    const t = String(token == null ? '' : token).trim();
    if (!t) return { ok: false, error: 'empty token' };
    try {
      const env = readAuthEnv();
      env.CLAUDE_CODE_OAUTH_TOKEN = t;   // preserves any CLODEX_REMOTE_TOKEN line
      writeAuthEnv(env);
      return { ok: true, hasToken: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  function clearAuthToken() {
    try {
      const env = readAuthEnv();
      delete env.CLAUDE_CODE_OAUTH_TOKEN;   // keeps the remote token; file goes if now empty
      writeAuthEnv(env);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    return { ok: true, hasToken: false };
  }

  function remoteToken() {
    try { return readAuthEnv().CLODEX_REMOTE_TOKEN || null; } catch { return null; }
  }
  function ensureRemoteToken() {
    const existing = remoteToken();
    if (existing) return existing;
    const env = readAuthEnv();
    const tok = crypto.randomBytes(32).toString('hex');
    env.CLODEX_REMOTE_TOKEN = tok;   // preserves any CLAUDE_CODE_OAUTH_TOKEN line
    writeAuthEnv(env);
    return tok;
  }

  async function buildBusySet(config, ownPorts) {
    const own = new Set(ownPorts || []);
    const set = new Set();
    for (const start of [config.webPort, config.wirescopePort, config.wirePort]) {
      for (let p = start; p < start + PORT_SCAN_WINDOW; p++) {
        try { if (await isPortInUse(p) && !own.has(p)) set.add(p); } catch { /* treat as free */ }
      }
    }
    return set;
  }

  async function writeComposeFile() {
    const config = getConfig();
    const image = resolveImage({
      isPackaged: isPackaged(), appVersion, override: config.image, repoRoot,
    });
    let ownPorts = [];
    try { ownPorts = parseOwnPorts(fs.readFileSync(composePath(), 'utf8')); } catch { /* no prior file */ }
    const busy = await buildBusySet(config, ownPorts);
    const ports = resolvePorts(config, (p) => busy.has(p));
    const authFile = fs.existsSync(authEnvPath()) ? authEnvPath() : null;
    // Ensure the host library source dirs exist — docker errors on a bind whose
    // source is missing (a fresh install may not have authored them yet). Cheap
    // and keeps the mount set unconditional (deterministic bytes) rather than
    // config-dependent. Idempotent: recursive mkdir no-ops when they exist.
    for (const d of LIBRARY_MOUNT_DIRS) {
      try { fs.mkdirSync(path.join(registryDir, d), { recursive: true }); } catch {}
    }
    const yaml = generateCompose({
      image, ports, workDir: config.workDir || null, authEnvFile: authFile,
      libDir: registryDir, mounts: config.mounts, hostname: id,
    });
    fs.mkdirSync(sandboxDir(), { recursive: true });
    fs.writeFileSync(composePath(), yaml, { mode: 0o600 });
    return { path: composePath(), ports, image };
  }

  // -p pins the compose project to the box id (per-box volume namespace, M6b P2);
  // -f points at this box's generated compose file. Both precede the subcommand.
  function composeArgs(extra) { return ['compose', '-p', composeProjectName(id), '-f', composePath(), ...extra]; }

  function runCompose(extra) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn('docker', composeArgs(extra), { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ ok: false, code: null, stdout: '', stderr: String((e && e.message) || e) });
        return;
      }
      let stdout = '', stderr = '';
      if (child.stdout) child.stdout.on('data', (d) => { stdout += d; });
      if (child.stderr) child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => resolve({ ok: false, code: null, stdout, stderr: stderr || String((e && e.message) || e) }));
      child.on('exit', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
    });
  }

  function bringUp(runSteps, label) {
    // serialize() chains this across every box the manager owns (default: inline),
    // so the port probe + compose regen can't race when two boxes come up at once.
    return serialize(async () => {
      // Provision the peer-wire token BEFORE composing: it must land in auth.env so
      // writeComposeFile references the env_file, and so registerPeer can read it.
      try { ensureRemoteToken(); } catch (e) {
        return { ok: false, error: `token provision failed: ${(e && e.message) || e}` };
      }
      let gen;
      try { gen = await writeComposeFile(); } catch (e) {
        return { ok: false, error: `compose write failed: ${(e && e.message) || e}` };
      }
      const r = await runSteps(gen);
      if (!r.ok) {
        const gone = dockerUnavailableError(r.stderr);
        if (gone) { invalidateDetect(); return { ok: false, error: gone }; }
        return { ok: false, error: r.stderr.trim() || `docker compose ${label} exited ${r.code}` };
      }
      registerPeer(gen.ports.wire);
      log.info('sandbox', `${id} ${label} — wire peer http://127.0.0.1:${gen.ports.wire}`);
      return { ok: true, ports: gen.ports };
    });
  }

  async function up() {
    return bringUp((_gen) => runCompose(['up', '-d']), 'up');
  }

  async function rebuild() {
    return bringUp(async (gen) => {
      if (gen.image.kind === 'build') return runCompose(['up', '-d', '--build']);
      const pulled = await runCompose(['pull']);
      if (!pulled.ok) return pulled;   // pull failed → skip up, surface its stderr
      return runCompose(['up', '-d']);
    }, 'rebuild');
  }

  // Stop the sandbox. The peer row STAYS (goes offline) — it's the affordance to
  // start it again later, so down never touches the peers list.
  async function down() {
    const r = await runCompose(['down']);
    if (!r.ok) {
      const gone = dockerUnavailableError(r.stderr);
      if (gone) { invalidateDetect(); return { ok: false, error: gone }; }
      return { ok: false, error: r.stderr.trim() || `docker compose down exited ${r.code}` };
    }
    return { ok: true };
  }

  async function status() {
    const r = await runCompose(['ps', '--format', 'json']);
    if (!r.ok && !r.stdout.trim()) {
      return { state: 'absent', error: r.stderr.trim() || undefined };
    }
    const state = parseComposeState(r.stdout);
    const out = { state };
    // Only meaningful while running: the compose file persists after Stop, but its
    // ports then describe no live listener, and Start regenerates them.
    if (state === 'running') {
      let ports;
      try { ports = parseOwnPortMap(fs.readFileSync(composePath(), 'utf8')); } catch { /* no prior file */ }
      if (ports && Object.keys(ports).length) out.ports = ports;
    }
    return out;
  }

  async function logsTail(n = 200) {
    const count = Number.isInteger(n) && n > 0 ? n : 200;
    const r = await runCompose(['logs', '--no-color', '--tail', String(count)]);
    return {
      ok: r.ok,
      output: r.stdout + (r.stderr || ''),
      error: r.ok ? undefined : (r.stderr.trim() || undefined),
    };
  }

  function registerPeer(wirePort) {
    const url = `http://127.0.0.1:${wirePort}`;
    const token = remoteToken();   // the operator secret this peer authenticates with
    const store = getUiSettings();
    const peers = (store.get().peers || []).map((p) => ({ ...p }));
    const existing = peers.find((p) => p && p.id === id);
    if (existing) {
      if (existing.url === url && (existing.token || null) === (token || null)) return;
      existing.url = url;
      if (token) existing.token = token; else delete existing.token;
    } else {
      const entry = { id, label: boxLabel, url };
      if (token) entry.token = token;
      peers.push(entry);
    }
    store.set({ peers });
    syncPeerManager();
  }

  function unregisterPeer() {
    const store = getUiSettings();
    const peers = store.get().peers || [];
    if (!peers.some((p) => p && p.id === id)) return;
    store.set({ peers: peers.filter((p) => !(p && p.id === id)) });
    syncPeerManager();
  }

  return {
    id, label: boxLabel,
    detect, getConfig, setConfig, writeComposeFile, translateHostPath,
    up, rebuild, down, status, logsTail, registerPeer, unregisterPeer,
    hasAuthToken, setAuthToken, clearAuthToken,
    composePath, sandboxDir,
  };
}

function createSandboxManager(deps = {}) {
  const getUiSettings = deps.getUiSettings;
  const listBoxes = deps.listBoxes
    || (() => { try { return getUiSettings().get().boxes || []; } catch { return []; } });

  const managerSpawn = deps.spawn || cp.spawn;
  const now = deps.now || Date.now;
  const detectCache = createDetectCache({ probe: () => probeDocker(managerSpawn), now });
  detectCache.get().catch(() => {});

  const instances = new Map();
  let chain = Promise.resolve();
  const serialize = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});   // swallow so one failure doesn't wedge the chain
    return run;
  };

  function subdirFor(boxId) { return boxId === SANDBOX_PEER_ID ? 'sandbox' : `sandbox-${boxId}`; }

  function instantiate(box) {
    const boxId = box.id;
    return createSandbox({
      ...deps,
      id: boxId,
      label: box.label || boxId,
      subdir: subdirFor(boxId),
      serialize,
      detect: () => detectCache.get(),
      invalidateDetect: () => detectCache.invalidate(),
      readBoxConfig: () => {
        const row = listBoxes().find((b) => b && b.id === boxId);
        return (row && row.config) || {};
      },
      writeBoxConfig: (next) => {
        const boxes = listBoxes().map((b) => ({ ...b }));
        const row = boxes.find((b) => b && b.id === boxId);
        if (row) row.config = next;
        else boxes.push({ id: boxId, label: box.label || boxId, config: next });
        getUiSettings().set({ boxes });
      },
    });
  }

  function get(boxId) {
    const wantId = boxId || SANDBOX_PEER_ID;
    const cached = instances.get(wantId);
    if (cached) return cached;
    const box = listBoxes().find((b) => b && b.id === wantId);
    if (!box) return null;
    const inst = instantiate(box);
    instances.set(wantId, inst);
    return inst;
  }

  function list() {
    return listBoxes().map((b) => ({ id: b.id, label: b.label || b.id }));
  }

  // Ports stay at the shared defaults on purpose: resolvePorts collision-bumps at
  // Start and the serialize chain keeps concurrent starts from racing the probe,
  // so a second box on the default ports simply bumps off the first.
  function create(rawId, rawLabel) {
    const boxId = String(rawId || '').trim();
    if (!BOX_ID_RE.test(boxId)) {
      return { ok: false, error: 'Sandbox id must be lowercase letters, digits, dashes or underscores (no dots, no spaces).' };
    }
    if (RESERVED_BOX_IDS.has(boxId)) {
      return { ok: false, error: `"${boxId}" is a reserved name — pick a different sandbox id.` };
    }
    const boxes = listBoxes().map((b) => ({ ...b }));
    if (boxes.some((b) => b && b.id === boxId)) return { ok: false, error: `A sandbox named "${boxId}" already exists.` };
    const label = String(rawLabel || '').trim().slice(0, 64) || boxId;
    boxes.push({ id: boxId, label, config: { ...DEFAULT_CONFIG } });
    getUiSettings().set({ boxes });
    return { ok: true, box: { id: boxId, label } };
  }

  // Docker VOLUMES are intentionally left behind (data-preservation stance);
  // reclaiming them needs a human `docker volume rm`. Best-effort down: a stop
  // failure is surfaced but does not block removal of the registry row.
  async function remove(rawId) {
    const boxId = String(rawId || '').trim();
    const box = listBoxes().find((b) => b && b.id === boxId);
    if (!box) return { ok: false, error: `no such sandbox: ${boxId}` };
    const inst = get(boxId);
    let downError;
    try { const d = await inst.down(); if (d && d.ok === false) downError = d.error; }
    catch (e) { downError = String((e && e.message) || e); }
    inst.unregisterPeer();
    const boxes = listBoxes().filter((b) => !(b && b.id === boxId));
    getUiSettings().set({ boxes });
    instances.delete(boxId);
    return { ok: true, downError };
  }

  return { get, list, create, remove, detect: () => detectCache.get(), invalidateDetect: () => detectCache.invalidate() };
}

function defaultIsPortInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { socket.destroy(); } catch { /* noop */ } resolve(v); };
    socket.setTimeout(250);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

module.exports = {
  createSandbox, createSandboxManager,
  // Pure parts, exported for the unit suite.
  createDetectCache, dockerUnavailableError,
  resolveImage, resolvePorts, nextFreePort, generateCompose,
  parseOwnPorts, parseOwnPortMap, parsePsRows, parseComposeState, defaultIsPortInUse,
  defaultMountTarget, normalizeMounts, translatePath, relUnder, composeProjectName,
  DEFAULT_CONFIG, DEFAULT_PORTS, CONTAINER_PORTS, RESERVED_MOUNT_TARGETS, WORK_CONTAINER_DIR,
  SANDBOX_PEER_ID, SANDBOX_PEER_LABEL, BOX_ID_RE, RESERVED_BOX_IDS,
};
