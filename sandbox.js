// sandbox.js — one-button local Docker sandbox lifecycle (docs/sandbox-plan.md M1).
//
// A desktop user clicks Start and gets the web-frontend container (docker/web/
// {Dockerfile,compose.yaml}) running as a LOCAL peer: engine + web frontend +
// wirescope + peer wire, all published to loopback. The sandbox IS a peer
// (id `sandbox`) whose lifecycle this module owns; sandbox sessions then appear
// in the sidebar's peer section like any other peer's.
//
// Electron-free, deps-injected like session-manager — so it's unit-testable with
// spawn/docker mocked and never require()s electron. The pure parts (compose
// bytes, port-bump, image resolution, ps parsing) are exported directly for the
// unit suite; createSandbox(deps) wraps them with the stateful config + spawn I/O.
//
// Config authoritative, file derived: <userData>/sandbox/compose.yaml is
// regenerated from the ui-settings `sandbox` config on EVERY Start — never
// hand-edited, never the source of truth. The M4 auth env_file is a SEPARATE
// file referenced by path; secrets are NEVER written into the compose bytes.
'use strict';

const cp = require('child_process');
const crypto = require('crypto');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { readEnvFile, writeEnvFile } = require('./env-file');

// Host-port defaults — Clodex's service neighborhood (web 7810, wirescope 7811,
// peer wire 7820), matching docker/web/compose.yaml. Collision-bumped at
// generation time by probing listeners (resolvePorts).
const DEFAULT_PORTS = { web: 7810, wirescope: 7811, wire: 7820 };

// Full persisted config shape (ui-settings `sandbox`). workDir null = a named
// volume (work survives `down` but lives inside Docker); a host path = bind mount
// (work lands on the user's disk). image null = default resolution (resolveImage).
const DEFAULT_CONFIG = {
  workDir: null,
  webPort: DEFAULT_PORTS.web,
  wirescopePort: DEFAULT_PORTS.wirescope,
  wirePort: DEFAULT_PORTS.wire,
  autoStart: false,
  image: null,
};

// Container-side ports — FIXED by the image (docker/web/Dockerfile env), so the
// host publishes map host<config> → container<these>. Not user-configurable.
const CONTAINER_PORTS = { web: 8080, wirescope: 7800, wire: 7900 };

// Host library dirs bind-mounted READ-ONLY into the box so its skill/agent/
// prompt/exec catalogs mirror the host's live (M5, docs/sandbox-plan.md
// Decision 7). One `library` bind covers both prompts (library/prompts) and
// exec (library/exec). These layer ON TOP of the clodex-dot named volume,
// SHADOWING these subpaths — intended: the box READS host libraries but still
// WRITES run/, messages/, pending/, registry into the volume underneath, so its
// own agent IPC is untouched. Libraries are live-read (no boot snapshot), so
// host edits reach a running box on its next access, no restart.
const LIBRARY_MOUNT_DIRS = ['skills', 'agents', 'library'];

const GHCR_REPO = 'ghcr.io/avirtual/clodex';

// The managed peer's stable identity — the row the app adds/updates on the peer
// list. id is what registerPeer keys off (idempotent, never duplicated).
const SANDBOX_PEER_ID = 'sandbox';
const SANDBOX_PEER_LABEL = 'sandbox';

// `docker info` guard — a hung daemon shouldn't wedge detection forever.
const DETECT_TIMEOUT_MS = 4000;
// How far past each desired port to probe for a free one when bumping.
const PORT_SCAN_WINDOW = 40;

// ── Pure helpers (unit-tested; no I/O) ──────────────────────────────────────

// Resolve the compose image directive. Packaged app → a pinned GHCR tag (DMG
// users have no checkout to `docker compose build` from). Dev (!isPackaged) →
// a `build:` block from the repo checkout — exactly today's docker/web/
// compose.yaml, keeping the dev loop free of GHCR. An explicit override always
// wins, in any state.
function resolveImage({ isPackaged, appVersion, override, repoRoot }) {
  if (override) return { kind: 'image', image: override };
  if (isPackaged) return { kind: 'image', image: `${GHCR_REPO}:${appVersion}` };
  return { kind: 'build', context: repoRoot, dockerfile: 'docker/web/Dockerfile' };
}

// First free port at or above `desired`, skipping any a listener already holds
// (isBusy) AND any an earlier port in the same generation already claimed
// (taken) — so the three publishes can never collapse onto one number. isBusy
// is injected so the probe is testable; `taken` accumulates across the three.
function nextFreePort(desired, isBusy, taken) {
  const claimed = taken || new Set();
  let p = desired;
  while (isBusy(p) || claimed.has(p)) p++;
  claimed.add(p);
  return p;
}

// Bump all three host ports off collisions, in order (web, wirescope, wire).
// isBusy(port) is a SYNC predicate — the factory pre-probes into a Set so this
// stays pure and testable.
function resolvePorts(config, isBusy) {
  const c = { ...DEFAULT_CONFIG, ...(config || {}) };
  const taken = new Set();
  return {
    web: nextFreePort(c.webPort, isBusy, taken),
    wirescope: nextFreePort(c.wirescopePort, isBusy, taken),
    wire: nextFreePort(c.wirePort, isBusy, taken),
  };
}

// Generate the compose.yaml bytes from a config. Mirrors docker/web/compose.yaml
// (hostname sandbox, three loopback publishes, named vols, init, restart:always,
// healthcheck) with image/ports/work-volume swapped in. `image` is a
// resolveImage() result, `ports` a resolvePorts() result. authEnvFile (M4) is a
// path to a SEPARATE env file — referenced via env_file, never inlined; null in
// M1 so no secrets ever land in these bytes.
function generateCompose({ image, ports, workDir, authEnvFile, libDir }) {
  const L = [];
  L.push('# GENERATED by Clodex (sandbox.js) — do NOT edit.');
  L.push('# Regenerated from the ui-settings `sandbox` config on every Start; edits are lost.');
  L.push('# Source of truth: docs/sandbox-plan.md + docker/web/compose.yaml.');
  L.push('');
  L.push('services:');
  L.push('  clodex:');
  // Stable hostname = the engine's SELF_LABEL on the peer wire (DM reply routing
  // breaks without it — docker/web/compose.yaml learned this live, 34dbe31).
  L.push('    hostname: sandbox');
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
  // M4 hook point: reference the auth env_file ONLY when one exists on disk.
  // Quoted like the workDir bind: userData paths carry spaces ("Application
  // Support") and an unquoted ` #` would truncate the YAML scalar.
  if (authEnvFile) {
    L.push('    env_file:');
    L.push(`      - "${authEnvFile}"`);
  }
  L.push('    volumes:');
  L.push('      - clodex-data:/data');
  L.push('      - clodex-dot:/home/clodex/.clodex');
  // Read-only host library binds layered ON TOP of clodex-dot (see
  // LIBRARY_MOUNT_DIRS) — they SHADOW those subpaths so box catalogs mirror the
  // host, live, while the volume underneath keeps the box's own writes (run/,
  // messages/, pending/, registry). Double-quoted like the workDir bind:
  // ~/.clodex can sit under a home path with spaces, and an unquoted ` #` would
  // truncate the YAML scalar.
  if (libDir) {
    for (const d of LIBRARY_MOUNT_DIRS) {
      L.push(`      - "${path.join(libDir, d)}:/home/clodex/.clodex/${d}:ro"`);
    }
  }
  L.push('      - claude-auth:/home/clodex/.claude');
  // A host bind-mount when workDir is set (work lands on the user's disk),
  // else a named volume (survives `down` but lives inside Docker).
  if (workDir) {
    // Double-quoted: a host path with YAML-special chars (`#` truncates, leading
    // specials can change the node type) must survive verbatim as the source.
    L.push(`      - "${workDir}:/home/clodex/work"`);
  } else {
    L.push('      - clodex-work:/home/clodex/work');
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
  // The work named volume is only declared when it's actually used (no workDir).
  if (!workDir) L.push('  clodex-work:');
  L.push('');
  return L.join('\n');
}

// Extract the three host ports an EXISTING generated compose.yaml already
// publishes — the `127.0.0.1:<host>:<container>` lines. These are OURS: on a
// re-up (container running, or Start clicked twice, or autoStart with the box
// up) a live-connect probe would read our own published ports as busy and bump
// all three, drifting the ports (and the peer url) upward on every Start. The
// caller subtracts these from the busy set so holding our own ports is never a
// collision — keeping ports stable across re-ups while still regenerating on
// every Start. Returns [] for missing/garbage input.
function parseOwnPorts(yamlText) {
  const out = [];
  if (!yamlText) return out;
  for (const m of yamlText.matchAll(/127\.0\.0\.1:(\d+):\d+/g)) {
    const p = parseInt(m[1], 10);
    if (Number.isInteger(p)) out.push(p);
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

// Reduce compose ps rows to one lifecycle state for the clodex service:
// 'running' | 'exited' | 'absent'. No rows = never created / fully removed.
function parseComposeState(stdout) {
  const rows = parsePsRows(stdout);
  if (!rows.length) return 'absent';
  const svc = rows.find((r) => r && r.Service === 'clodex') || rows[0];
  const state = String((svc && (svc.State || svc.Status)) || '').toLowerCase();
  if (state.includes('running') || state.includes('up')) return 'running';
  return 'exited';
}

// ── Factory ─────────────────────────────────────────────────────────────────

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
  // Host ~/.clodex root — the source of the read-only library binds. Injected by
  // engine.js as REGISTRY_DIR; defaults to ~/.clodex for standalone/test use.
  const registryDir = deps.registryDir || path.join(os.homedir(), '.clodex');

  function sandboxDir() { return path.join(getUserDataPath(), 'sandbox'); }
  function composePath() { return path.join(sandboxDir(), 'compose.yaml'); }
  function authEnvPath() { return path.join(sandboxDir(), 'auth.env'); }

  // Config read/write through the ui-settings `sandbox` key, defaults filled.
  // hasToken is DERIVED from the auth.env file's existence (M4) — never stored:
  // the token value lives only in that 0600 file, never in ui-settings or any
  // result payload. getConfig surfaces the boolean so the dialog can show the
  // "configured" state; setConfig strips it before persisting.
  function getConfig() {
    let s = {};
    try { s = getUiSettings().get().sandbox || {}; } catch { s = {}; }
    return { ...DEFAULT_CONFIG, ...s, hasToken: hasAuthToken() };
  }
  function setConfig(partial) {
    const next = { ...getConfig(), ...(partial || {}) };
    delete next.hasToken;   // derived, file-backed — never persisted to ui-settings
    getUiSettings().set({ sandbox: next });
    return getConfig();
  }

  // ── Auth env file (M4 + remote-auth chunk 4) ────────────────────────────────
  // <userData>/sandbox/auth.env (mode 0600) holds a set of KEY=value lines, ALL
  // referenced by the generated compose via env_file — so their values reach the
  // container's environment yet never enter the compose bytes, the config store,
  // logs, or any IPC result. Two keys live here:
  //   CLAUDE_CODE_OAUTH_TOKEN  — the host's Claude OAuth token (`claude
  //                              setup-token`), user-seeded, drives hasAuthToken.
  //   CLODEX_REMOTE_TOKEN      — an auto-generated operator secret for the peer
  //                              wire (remote.js gate), provisioned on first up;
  //                              the same value feeds the sandbox peer entry's
  //                              Bearer (registerPeer), closing the wire end-to-end.
  // The file is a multi-key set so setting/clearing one token never disturbs the
  // other. Writes are atomic (tmp + rename); an empty set deletes the file. The
  // atomic KEY=value primitives are shared with the host's remote.env (env-file.js).
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

  // The peer-wire operator secret. remoteToken() reads it (null if absent or the
  // path can't resolve — registerPeer calls this even in settings-only tests with
  // no userData); ensureRemoteToken() mints one on first up and persists it,
  // idempotent thereafter so the value (and the peer's Bearer) stay stable.
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

  // Detection: `docker info` distinguishes "not installed" (spawn ENOENT →
  // present:false) from "daemon not running" (CLI runs, non-zero exit →
  // present:true, running:false) from healthy (exit 0 → running:true). A hung
  // daemon trips DETECT_TIMEOUT_MS and reads as present-but-not-running.
  function detect() {
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

  // Probe each desired port (and a small window above it) so resolvePorts' sync
  // predicate is a plain Set lookup. Best-effort; a probe error reads as free.
  // `ownPorts` (the ports the existing compose.yaml already publishes) are
  // subtracted — they're ours, so a live-connect hit on them is not a collision;
  // subtracting them keeps ports stable across re-ups (see parseOwnPorts).
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

  // Regenerate compose.yaml from the authoritative config. Returns the resolved
  // ports + image so the caller (up) can register the peer at the real wire port.
  async function writeComposeFile() {
    const config = getConfig();
    const image = resolveImage({
      isPackaged: isPackaged(), appVersion, override: config.image, repoRoot,
    });
    // Our own already-published ports (if a compose.yaml exists) are not
    // collisions — subtract them so re-up keeps the ports byte-stable.
    let ownPorts = [];
    try { ownPorts = parseOwnPorts(fs.readFileSync(composePath(), 'utf8')); } catch { /* no prior file */ }
    const busy = await buildBusySet(config, ownPorts);
    const ports = resolvePorts(config, (p) => busy.has(p));
    // M4 hook: reference the auth env_file only when it already exists — secrets
    // never enter the compose bytes, this only points at a separate file.
    const authFile = fs.existsSync(authEnvPath()) ? authEnvPath() : null;
    // Ensure the host library source dirs exist — docker errors on a bind whose
    // source is missing (a fresh install may not have authored them yet). Cheap
    // and keeps the mount set unconditional (deterministic bytes) rather than
    // config-dependent. Idempotent: recursive mkdir no-ops when they exist.
    for (const d of LIBRARY_MOUNT_DIRS) {
      try { fs.mkdirSync(path.join(registryDir, d), { recursive: true }); } catch {}
    }
    const yaml = generateCompose({
      image, ports, workDir: config.workDir || null, authEnvFile: authFile, libDir: registryDir,
    });
    fs.mkdirSync(sandboxDir(), { recursive: true });
    fs.writeFileSync(composePath(), yaml, { mode: 0o600 });
    return { path: composePath(), ports, image };
  }

  function composeArgs(extra) { return ['compose', '-f', composePath(), ...extra]; }

  // Spawn `docker compose …`, buffering stdout/stderr. Never throws — a spawn
  // failure (ENOENT) resolves as { ok:false } with the message in stderr, the
  // model peers-ui deploy toasts follow.
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

  // Start (or recreate) the sandbox: regenerate compose from config, `up -d`,
  // then register the managed peer at the resolved wire port. stderr surfaces on
  // failure and the peer is NOT registered.
  async function up() {
    // Provision the peer-wire token BEFORE composing: it must land in auth.env so
    // writeComposeFile references the env_file, and so registerPeer can read it.
    try { ensureRemoteToken(); } catch (e) {
      return { ok: false, error: `token provision failed: ${(e && e.message) || e}` };
    }
    let gen;
    try { gen = await writeComposeFile(); } catch (e) {
      return { ok: false, error: `compose write failed: ${(e && e.message) || e}` };
    }
    const r = await runCompose(['up', '-d']);
    if (!r.ok) return { ok: false, error: r.stderr.trim() || `docker compose up exited ${r.code}` };
    registerPeer(gen.ports.wire);
    log.info('sandbox', `up — wire peer http://127.0.0.1:${gen.ports.wire}`);
    return { ok: true, ports: gen.ports };
  }

  // Stop the sandbox. The peer row STAYS (goes offline) — it's the affordance to
  // start it again later, so down never touches the peers list.
  async function down() {
    const r = await runCompose(['down']);
    if (!r.ok) return { ok: false, error: r.stderr.trim() || `docker compose down exited ${r.code}` };
    return { ok: true };
  }

  // running / exited / absent (compose ps). A spawn failure reads as absent.
  async function status() {
    const r = await runCompose(['ps', '--format', 'json']);
    if (!r.ok && !r.stdout.trim()) {
      return { state: 'absent', error: r.stderr.trim() || undefined };
    }
    return { state: parseComposeState(r.stdout) };
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

  // Idempotent peer registration through the settings write path — peer-wiring
  // reconciles off the uiSettings `peers` array (78f65bd shows the offline row
  // immediately). First up adds the row; a moved wire port updates the url in
  // place; an unchanged url writes nothing. Never duplicates.
  function registerPeer(wirePort) {
    const url = `http://127.0.0.1:${wirePort}`;
    const token = remoteToken();   // the operator secret this peer authenticates with
    const store = getUiSettings();
    const peers = (store.get().peers || []).map((p) => ({ ...p }));
    const existing = peers.find((p) => p && p.id === SANDBOX_PEER_ID);
    if (existing) {
      // Already correct (url AND token) → no write, no reconcile churn.
      if (existing.url === url && (existing.token || null) === (token || null)) return;
      existing.url = url;
      if (token) existing.token = token; else delete existing.token;
    } else {
      const entry = { id: SANDBOX_PEER_ID, label: SANDBOX_PEER_LABEL, url };
      if (token) entry.token = token;
      peers.push(entry);
    }
    store.set({ peers });
    syncPeerManager();
  }

  return {
    detect, getConfig, setConfig, writeComposeFile,
    up, down, status, logsTail, registerPeer,
    hasAuthToken, setAuthToken, clearAuthToken,
    composePath, sandboxDir,
  };
}

// Best-effort sync-ish port probe: a 127.0.0.1 connect that succeeds means
// something is LISTENING (busy); ECONNREFUSED/timeout means free. Async so the
// factory can await a full scan before the pure resolvePorts runs.
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
  createSandbox,
  // Pure parts, exported for the unit suite.
  resolveImage, resolvePorts, nextFreePort, generateCompose,
  parseOwnPorts, parsePsRows, parseComposeState, defaultIsPortInUse,
  DEFAULT_CONFIG, DEFAULT_PORTS, CONTAINER_PORTS,
  SANDBOX_PEER_ID, SANDBOX_PEER_LABEL,
};
