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
const { defaultClodexHome } = require('./clodex-paths');
const { createDetectCache } = require('./detect-cache');
const { repoToplevel, checkoutDetached, headSha, removeWorktree } = require('./git-worktree');

const DEFAULT_PORTS = { web: 7810, wirescope: 7811, wire: 7820 };

const DEFAULT_CONFIG = {
  workDir: null,
  webPort: DEFAULT_PORTS.web,
  wirescopePort: DEFAULT_PORTS.wirescope,
  wirePort: DEFAULT_PORTS.wire,
  autoStart: false,
  image: null,
  ref: null,
  mounts: [],
  ports: [],
  limits: { cpus: null, memory: null, pids: null, shmSize: null },
  platform: null,
  relay: false,
};

const RELAY_HOST_ONLY_MSG = 'relay is a host setting';
const OPERATOR_ONLY_MSG = 'limits and platform are operator settings: change them in the Sandbox panel';
const PLATFORMS = ['linux/amd64', 'linux/arm64'];
const CPUS_MIN = 0.25;
const MEMORY_MIN_BYTES = 512 * 1024 * 1024;
const PIDS_MIN = 64;
const GIB = 1024 * 1024 * 1024;
const SIZE_RE = /^(\d+)([mg])$/;
const GATEWAY_LIMITS = { cpus: '0.5', memory: '256m' };

function sizeToBytes(raw) {
  const m = SIZE_RE.exec(String(raw == null ? '' : raw).trim().toLowerCase());
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'g' ? GIB : 1024 * 1024);
}

function gibText(bytes) {
  const gib = bytes / GIB;
  return Number.isInteger(gib) ? String(gib) : gib.toFixed(1);
}

function blank(v) { return v == null || (typeof v === 'string' && v.trim() === ''); }

function validateLimitsForSave(raw, { figures } = {}) {
  if (raw == null) return { limits: { ...DEFAULT_CONFIG.limits } };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'limits must be an object with cpus, memory, pids and shmSize.' };
  }
  const ncpu = figures && Number.isFinite(figures.ncpu) && figures.ncpu > 0 ? figures.ncpu : null;
  const memTotal = figures && Number.isFinite(figures.memTotal) && figures.memTotal > 0 ? figures.memTotal : null;
  const out = { cpus: null, memory: null, pids: null, shmSize: null };
  if (!blank(raw.cpus)) {
    const cpus = Number(raw.cpus);
    const ok = Number.isFinite(cpus) && cpus >= CPUS_MIN && (ncpu == null || cpus <= ncpu);
    if (!ok) {
      return { error: ncpu == null
        ? `limits.cpus must be a number of at least ${CPUS_MIN}`
        : `limits.cpus must be between ${CPUS_MIN} and ${ncpu} (the Docker VM has ${ncpu} cores)` };
    }
    out.cpus = cpus;
  }
  if (!blank(raw.memory)) {
    const bytes = sizeToBytes(raw.memory);
    const ok = bytes != null && bytes >= MEMORY_MIN_BYTES && (memTotal == null || bytes <= memTotal);
    if (!ok) {
      return { error: memTotal == null
        ? 'limits.memory must be a size of at least 512m (like 512m or 4g)'
        : `limits.memory must be between 512m and ${Math.floor(memTotal / GIB)}g (the Docker VM has ${gibText(memTotal)} GiB)` };
    }
    out.memory = String(raw.memory).trim().toLowerCase();
  }
  if (!blank(raw.pids)) {
    const pids = Number(raw.pids);
    if (!Number.isInteger(pids) || pids < PIDS_MIN) {
      return { error: `limits.pids must be a whole number of at least ${PIDS_MIN}` };
    }
    out.pids = pids;
  }
  if (!blank(raw.shmSize)) {
    const bytes = sizeToBytes(raw.shmSize);
    if (!bytes) return { error: 'limits.shmSize must be a size of at least 1m (like 64m or 1g)' };
    out.shmSize = String(raw.shmSize).trim().toLowerCase();
  }
  return { limits: out };
}

function normalizePlatform(raw) {
  if (blank(raw)) return { platform: null };
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!PLATFORMS.includes(s)) {
    return { error: `platform must be ${PLATFORMS.join(' or ')}, or empty for the host's architecture` };
  }
  return { platform: s };
}

function limitsSet(limits) {
  const l = limits || {};
  return ['cpus', 'memory', 'pids'].filter((k) => l[k] != null);
}

const REF_RE = /^[A-Za-z0-9._/-]+$/;
const REF_MAX = 128;
const NO_REPO_FOR_REF = 'this Clodex was not launched from a git checkout; tracking a ref needs one';

function normalizeRef(raw) {
  if (raw == null) return { ref: null };
  if (typeof raw !== 'string') return { error: 'Track git ref must be text (a branch, tag or commit).' };
  const s = raw.trim();
  if (!s) return { ref: null };
  if (s.length > REF_MAX) return { error: `Track git ref is too long (${s.length} characters, max ${REF_MAX}).` };
  if (!REF_RE.test(s) || s.includes('..')) {
    return { error: `Track git ref may only contain letters, digits, dot, dash, underscore and slash (no ".."): ${s}` };
  }
  return { ref: s };
}

const RUN_TMPFS_TARGET = '/home/clodex/.clodex/run';
const RUN_TMPFS_OPTIONS = 'exec,mode=1777';
const RESERVED_MOUNT_TARGETS = ['/data', '/home/clodex/work', '/home/clodex/.clodex', RUN_TMPFS_TARGET, '/home/clodex/.claude', '/home/clodex/.config/muse', '/home/clodex/.local/share'];
const MOUNT_TARGET_ROOT = '/home/clodex';
const WORK_CONTAINER_DIR = '/home/clodex/work';

// Container-side ports — FIXED by the image (docker/web/Dockerfile env), so the
// host publishes map host<config> → container<these>. Not user-configurable.
const CONTAINER_PORTS = { web: 8080, wirescope: 7800, wire: 7900 };

const PORT_PROTOS = ['tcp', 'http', 'https'];
const PORT_LABEL_MAX = 32;
const APP_HOST_PORT_MIN = 1024;
const PORT_FORWARDER_PATH = '/app/sandbox-port-forwarder.js';
const PORTS_RECORD_FILE = 'sandbox-ports.json';
const LOCAL_DOCKER_CONTEXTS = new Set(['default', 'desktop-linux']);

function gatewayServiceName(hostname) { return `${hostname}-ports`; }

function toPortNumber(raw) {
  const n = typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? parseInt(raw, 10) : raw;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function normalizePorts(rawPorts) {
  if (rawPorts == null) return { ports: [] };
  if (!Array.isArray(rawPorts)) return { error: 'Ports must be a list.' };
  const ports = [];
  for (const raw of rawPorts) {
    const e = raw || {};
    const container = toPortNumber(e.container);
    if (container === null) return { error: `Container port must be a whole number 1–65535 (got ${JSON.stringify(e.container)}).` };
    const role = Object.keys(CONTAINER_PORTS).find((k) => CONTAINER_PORTS[k] === container);
    if (role) return { error: `Container port ${container} is Clodex's own ${role} port inside the box; run the app on another port.` };
    const host = (e.host == null || e.host === '') ? container : toPortNumber(e.host);
    if (host === null || host < APP_HOST_PORT_MIN) {
      return { error: `Host port must be a whole number ${APP_HOST_PORT_MIN}–65535 (got ${JSON.stringify(e.host == null || e.host === '' ? container : e.host)}).` };
    }
    const proto = e.proto == null || e.proto === '' ? 'tcp' : e.proto;
    if (!PORT_PROTOS.includes(proto)) return { error: `Port protocol must be one of ${PORT_PROTOS.join(', ')} (got ${JSON.stringify(e.proto)}).` };
    const label = e.label == null ? '' : String(e.label).trim();
    if (label.length > PORT_LABEL_MAX) return { error: `Port label is too long (${label.length} characters, max ${PORT_LABEL_MAX}).` };
    ports.push({ container, host, allInterfaces: e.allInterfaces === true, proto, label });
  }
  return { ports };
}

function samePortPair(a, b) { return a.container === b.container && a.host === b.host; }

function samePortEntry(a, b) {
  return samePortPair(a, b) && a.allInterfaces === b.allInterfaces && a.proto === b.proto && a.label === b.label;
}

function portUrl(entry, local) {
  if (!local) return undefined;
  return entry.proto === 'tcp' ? `localhost:${entry.host}` : `${entry.proto}://localhost:${entry.host}`;
}

// Read-only host binds layered on top of the clodex-dot volume, deliberately
// SHADOWING these subpaths: the box reads host libraries live while still
// writing messages/, pending/, registry into the volume underneath.
const LIBRARY_MOUNT_DIRS = [
  'skills', 'agents',
  'library/prompts', 'library/templates', 'library/kits',
  'library/teams', 'library/plugins', 'library/exec',
];

const GHCR_REPO = 'ghcr.io/avirtual/clodex';

const SANDBOX_PEER_ID = 'sandbox';
const SANDBOX_PEER_LABEL = 'sandbox';

const SANDBOX_BOX_ENV = 'CLODEX_IN_SANDBOX';

function runningInSandboxBox(env) {
  return ((env || {})[SANDBOX_BOX_ENV] || '') === '1';
}

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


function resolveImage({ isPackaged, appVersion, override, repoRoot, ref, srcDir, sha }) {
  if (override) return { kind: 'image', image: override };
  if (ref) return { kind: 'build', context: srcDir, dockerfile: 'docker/web/Dockerfile', ref, sha: sha || null };
  if (isPackaged) return { kind: 'image', image: `${GHCR_REPO}:${appVersion}` };
  return { kind: 'build', context: repoRoot, dockerfile: 'docker/web/Dockerfile' };
}

function describeImage(image) {
  if (image && image.kind === 'image') return { kind: 'image', image: image.image };
  if (image && image.ref) return { kind: 'build', ref: image.ref, sha: image.sha || null };
  return { kind: 'build', ref: null, sha: null };
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
// single target that dominates all five — root — was the one value this guard
// admitted. Every enumerated reserved path was refused correctly; the value that
// is not a member but a prefix of every member was not.
function mountTargetsConflict(a, b) {
  if (a === b) return true;
  const under = (child, parent) => child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
  return under(a, b) || under(b, a);
}

function canonicalMountTarget(target) {
  return path.posix.normalize(target).replace(/(.)\/+$/, '$1');
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
      target = canonicalMountTarget(target);
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

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_CONFIG_FILES_LABEL = 'com.docker.compose.project.config_files';

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

function generateCompose({ image, ports, workDir, authEnvFile, libDir, mounts, hostname, stateDir, hostUser, appPorts, limits, platform, hostLabel }) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) {
    throw new Error('generateCompose: stateDir must be an absolute path');
  }
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
    L.push(`      context: ${yamlQuote(image.context)}`);
    L.push(`      dockerfile: ${yamlQuote(image.dockerfile)}`);
  } else {
    L.push(`    image: ${image.image}`);
  }
  if (platform) L.push(`    platform: ${platform}`);
  if (hostUser) L.push('    user: "0:0"');
  // Loopback publishes — the v1 trust boundary (only this machine reaches them).
  L.push('    ports:');
  L.push(`      - "127.0.0.1:${ports.web}:${CONTAINER_PORTS.web}"`);
  L.push(`      - "127.0.0.1:${ports.wirescope}:${CONTAINER_PORTS.wirescope}"`);
  L.push(`      - "127.0.0.1:${ports.wire}:${CONTAINER_PORTS.wire}"`);
  L.push('    environment:');
  // Compose ${VAR:-default} interpolations — single-quoted here so JS never
  // touches them; the wirescope public URL tracks the (possibly bumped) host port.
  L.push('      CLODEX_WORKSPACES: "${CLODEX_WORKSPACES:-default}"');
  L.push(`      CLODEX_WIRESCOPE_PUBLIC_URL: "\${CLODEX_WIRESCOPE_PUBLIC_URL:-http://localhost:${ports.wirescope}}"`);
  L.push('      TBH_CREDENTIAL_BACKEND: file');
  L.push('      XDG_DATA_HOME: /home/clodex/.local/share');
  if (hostUser) {
    L.push(`      CLODEX_HOST_UID: "${hostUser.uid}"`);
    L.push(`      CLODEX_HOST_GID: "${hostUser.gid}"`);
    if (!workDir) L.push('      CLODEX_WORK_VOLUME: "1"');
  }
  if (hostLabel) L.push(`      CLODEX_HOST_LABEL: ${yamlQuote(hostLabel)}`);
  if (authEnvFile) {
    L.push('    env_file:');
    L.push(`      - ${yamlQuote(authEnvFile)}`);
  }
  L.push('    volumes:');
  L.push(`      - ${yamlQuote(`${path.join(stateDir, 'data')}:/data`)}`);
  L.push(`      - ${yamlQuote(`${path.join(stateDir, 'dot')}:/home/clodex/.clodex`)}`);
  if (libDir) {
    for (const d of LIBRARY_MOUNT_DIRS) {
      const src = path.join(libDir, d);
      if (d.startsWith('library/') && !fs.existsSync(src)) continue;
      L.push(`      - ${yamlQuote(`${src}:/home/clodex/.clodex/${d}:ro`)}`);
    }
  }
  L.push(`      - ${yamlQuote(`${path.join(stateDir, 'claude')}:/home/clodex/.claude`)}`);
  L.push(`      - ${yamlQuote(`${path.join(stateDir, 'muse')}:/home/clodex/.config/muse`)}`);
  L.push(`      - ${yamlQuote(`${path.join(stateDir, 'muse-data')}:/home/clodex/.local/share`)}`);
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
  L.push('    tmpfs:');
  L.push(`      - ${RUN_TMPFS_TARGET}:${RUN_TMPFS_OPTIONS}`);
  L.push('    init: true');
  L.push('    restart: always');
  const boxLimits = limits || {};
  const setKeys = limitsSet(boxLimits);
  if (setKeys.length) {
    L.push('    deploy:');
    L.push('      resources:');
    L.push('        limits:');
    if (boxLimits.cpus != null) L.push(`          cpus: "${boxLimits.cpus}"`);
    if (boxLimits.memory != null) L.push(`          memory: ${boxLimits.memory}`);
    if (boxLimits.pids != null) L.push(`          pids: ${boxLimits.pids}`);
  }
  if (boxLimits.shmSize != null) L.push(`    shm_size: ${boxLimits.shmSize}`);
  L.push('    healthcheck:');
  L.push(`      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:${CONTAINER_PORTS.web}/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]`);
  L.push('      interval: 30s');
  L.push('      timeout: 5s');
  L.push('      retries: 3');
  L.push('      start_period: 10s');
  L.push('');
  const published = normalizePorts(appPorts);
  if (published.error) throw new Error(published.error);
  if (published.ports.length) {
    L.push(`  ${gatewayServiceName(boxHostname)}:`);
    if (image.kind === 'build') {
      L.push('    build:');
      L.push(`      context: ${yamlQuote(image.context)}`);
      L.push(`      dockerfile: ${yamlQuote(image.dockerfile)}`);
    } else {
      L.push(`    image: ${image.image}`);
    }
    if (platform) L.push(`    platform: ${platform}`);
    L.push(`    entrypoint: ["node", "${PORT_FORWARDER_PATH}"]`);
    L.push('    ports:');
    for (const p of published.ports) {
      L.push(`      - "${p.allInterfaces ? '0.0.0.0' : '127.0.0.1'}:${p.host}:${p.host}"`);
    }
    const map = published.ports.map((p) => ({ host: p.host, target: `clodex:${p.container}` }));
    L.push('    environment:');
    L.push(`      CLODEX_PORT_MAP: ${yamlQuote(JSON.stringify(map))}`);
    L.push('    read_only: true');
    L.push('    cap_drop:');
    L.push('      - ALL');
    L.push('    restart: unless-stopped');
    L.push('    deploy:');
    L.push('      resources:');
    L.push('        limits:');
    L.push(`          cpus: "${GATEWAY_LIMITS.cpus}"`);
    L.push(`          memory: ${GATEWAY_LIMITS.memory}`);
    L.push('');
  }
  if (!workDir) {
    L.push('volumes:');
    L.push('  clodex-work:');
  }
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
  for (const m of yamlText.matchAll(/(?:127\.0\.0\.1|0\.0\.0\.0):(\d+):\d+/g)) {
    const p = parseInt(m[1], 10);
    if (Number.isInteger(p)) out.push(p);
  }
  return out;
}

function parsePortOwners(yamlText) {
  if (!yamlText) return [];
  const named = /^\s+hostname:\s*(\S+)\s*$/m.exec(yamlText);
  const boxId = named ? named[1] : null;
  return parseOwnPorts(yamlText).map((port) => ({ port, boxId }));
}

function clodexServiceText(yamlText) {
  const gateway = /^  \S+-ports:\s*$/m.exec(yamlText);
  return gateway ? yamlText.slice(0, gateway.index) : yamlText;
}

function parseComposePlatform(yamlText) {
  const m = /^    platform: (\S+)\s*$/m.exec(clodexServiceText(yamlText || ''));
  return m ? m[1] : null;
}

function parseOwnPortMap(yamlText) {
  const out = {};
  if (!yamlText) return out;
  const roleByContainer = {
    [CONTAINER_PORTS.web]: 'web',
    [CONTAINER_PORTS.wirescope]: 'wirescope',
    [CONTAINER_PORTS.wire]: 'wire',
  };
  for (const m of clodexServiceText(yamlText).matchAll(/127\.0\.0\.1:(\d+):(\d+)/g)) {
    const host = parseInt(m[1], 10);
    const role = roleByContainer[parseInt(m[2], 10)];
    if (role && Number.isInteger(host)) out[role] = host;
  }
  return out;
}

const HEALTH_POLL_MS = 2000;
const HEALTH_TIMEOUT_MS = 180000;

async function waitHealthy({ id, url, timeoutMs, fetch, now, sleep } = {}) {
  const boxId = id || SANDBOX_PEER_ID;
  if (!url) return { ok: false, error: `box ${boxId} has no web port to health-check` };
  const doFetch = fetch || globalThis.fetch;
  const clock = now || Date.now;
  const nap = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : HEALTH_TIMEOUT_MS;
  const started = clock();
  const target = `${String(url).replace(/\/+$/, '')}/healthz`;
  for (let polls = 1; ; polls += 1) {
    let res = null;
    try { res = await doFetch(target); } catch { res = null; }
    if (res && res.status >= 200 && res.status < 300) {
      return { ok: true, polls, ms: clock() - started };
    }
    if (clock() - started >= limit) {
      return { ok: false, error: `box ${boxId} not healthy after ${Math.round(limit / 1000)}s`, polls };
    }
    await nap(HEALTH_POLL_MS);
  }
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


function probeChild(spawn, args, onSpawnError, onTimeout, onError, onExit) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('docker', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      resolve(onSpawnError());
      return;
    }
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done(onTimeout());
    }, DETECT_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      done(onError(e));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      done(onExit(code));
    });
  });
}

async function probeDocker(spawn) {
  const info = await probeChild(spawn, ['info', '--format', '{{.ServerVersion}}'],
    () => ({ present: false, running: false }),
    () => ({ present: true, running: false, timedOut: true }),
    (e) => ({ present: e && e.code !== 'ENOENT', running: false }),
    (code) => ({ present: true, running: code === 0 }));
  if (!info.running) return { ...info, compose: false };
  const compose = await probeChild(spawn, ['compose', 'version'],
    () => false, () => false, () => false, (code) => code === 0);
  return { ...info, compose };
}

const NO_FIGURES = Object.freeze({ ncpu: null, memTotal: null });

function parseFigures(stdout) {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(String(stdout || ''));
  if (!m) return { ...NO_FIGURES };
  const ncpu = Number(m[1]);
  const memTotal = Number(m[2]);
  return { ncpu: ncpu > 0 ? ncpu : null, memTotal: memTotal > 0 ? memTotal : null };
}

function probeDockerFigures(spawn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('docker', ['info', '--format', '{{.NCPU}} {{.MemTotal}}'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ ...NO_FIGURES });
      return;
    }
    let stdout = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done({ ...NO_FIGURES });
    }, DETECT_TIMEOUT_MS);
    if (child.stdout) child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', () => done({ ...NO_FIGURES }));
    child.on('exit', (code) => done(code === 0 ? parseFigures(stdout) : { ...NO_FIGURES }));
  });
}

function parseStatsLine(stdout) {
  const m = /^\s*([\d.]+)%\s+([\d.]+)\s*([KMGT]?i?B)\s*\//i.exec(String(stdout || ''));
  if (!m) return null;
  const units = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 };
  const unit = units[m[3].toLowerCase()];
  if (unit == null) return null;
  return { cpuPercent: Number(m[1]), memBytes: Math.round(Number(m[2]) * unit) };
}

function parseAppliedLimits(hostConfigJson) {
  let hc;
  try { hc = JSON.parse(String(hostConfigJson || '').trim()); } catch { return null; }
  if (!hc || typeof hc !== 'object') return null;
  const pos = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  return {
    cpus: pos(hc.NanoCpus) == null ? null : hc.NanoCpus / 1e9,
    memory: pos(hc.Memory),
    pids: pos(hc.PidsLimit),
    shmSize: pos(hc.ShmSize),
  };
}

function probeDockerLocal(spawn, env) {
  if ((env || {}).DOCKER_HOST) return Promise.resolve({ local: false });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('docker', ['context', 'show'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ local: false });
      return;
    }
    let out = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done({ local: false });
    }, DETECT_TIMEOUT_MS);
    if (child.stdout) child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => done({ local: false }));
    child.on('exit', (code) => done({ local: code === 0 && LOCAL_DOCKER_CONTEXTS.has(out.trim()) }));
  });
}


// Operator-facing docker-remedy copy. KEEP IN SYNC with
// renderer/lib/sandbox-view.js detectNotice — the dialog shows the same
// messages, and a late compose failure (daemon died
// between probe and click) must surface the SAME copy rather than raw stderr.
const DOCKER_ABSENT_MSG = 'Docker isn’t installed — sandboxes need Docker Desktop.';
const DOCKER_DOWN_MSG = 'Docker daemon isn’t running — start Docker Desktop.';
const DOCKER_NO_COMPOSE_MSG = 'Docker Compose plugin isn’t installed — on Debian/Ubuntu run `sudo apt-get install docker-compose-v2`; elsewhere install Docker Desktop.';

function dockerUnavailableError(stderr) {
  const s = String(stderr || '');
  if (/unknown shorthand flag: 'p' in -p|docker: unknown command: docker compose|'compose' is not a docker command/i.test(s)) {
    return DOCKER_NO_COMPOSE_MSG;
  }
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
  const log = deps.log || { info() {}, warn() {}, error() {} };
  const detect = deps.detect || (() => probeDocker(spawn));
  const invalidateDetect = deps.invalidateDetect || (() => {});
  const registryDir = deps.registryDir || defaultClodexHome();

  const id = deps.id || SANDBOX_PEER_ID;
  const boxLabel = deps.label || SANDBOX_PEER_LABEL;
  const subdir = deps.subdir || 'sandbox';
  const readBoxConfig = deps.readBoxConfig
    || (() => { try { return getUiSettings().get().sandbox || {}; } catch { return {}; } });
  const writeBoxConfig = deps.writeBoxConfig
    || ((next) => { getUiSettings().set({ sandbox: next }); });
  const serialize = deps.serialize || ((fn) => fn());
  const boxExists = deps.boxExists || (() => true);
  const siblingComposePaths = deps.siblingComposePaths || (() => []);
  const platform = deps.platform || process.platform;
  const userInfo = deps.userInfo || os.userInfo;
  const env = deps.env || process.env;
  const localCache = createDetectCache({ probe: () => probeDockerLocal(spawn, env) });
  const dockerIsLocal = deps.dockerIsLocal || (() => localCache.get().then((r) => r.local));
  const getFigures = deps.getFigures || (() => NO_FIGURES);

  function sandboxDir() { return path.join(getUserDataPath(), subdir); }
  function composePath() { return path.join(sandboxDir(), 'compose.yaml'); }
  function authEnvPath() { return path.join(sandboxDir(), 'auth.env'); }
  function srcDir() { return path.join(sandboxDir(), 'src'); }
  function stateDir() { return path.join(registryDir, 'boxes', id); }

  async function syncSrcToRef(ref) {
    if (!await repoToplevel(repoRoot)) return { ok: false, error: NO_REPO_FOR_REF };
    fs.mkdirSync(sandboxDir(), { recursive: true });
    return checkoutDetached({ repoTop: repoRoot, dir: srcDir(), ref });
  }

  async function resolveImageForConfig(config) {
    const ref = config.ref || null;
    return resolveImage({
      isPackaged: isPackaged(), appVersion, override: config.image, repoRoot,
      ref, srcDir: ref ? srcDir() : null, sha: ref ? await headSha(srcDir()) : null,
    });
  }

  function getConfig() {
    let s = {};
    try { s = readBoxConfig() || {}; } catch { s = {}; }
    return { ...DEFAULT_CONFIG, ...s, hasToken: hasAuthToken() };
  }
  function setConfig(partial, opts = {}) {
    const writer = opts.writer === 'panel' || opts.writer === 'host' ? opts.writer : 'intent';
    const operatorKeys = !!partial && ('limits' in partial || 'platform' in partial);
    if (operatorKeys && writer !== 'panel') return { ok: false, error: OPERATOR_ONLY_MSG };
    if (partial && 'relay' in partial && writer === 'intent') return { ok: false, error: RELAY_HOST_ONLY_MSG };
    const before = getConfig();
    const next = { ...before, ...(partial || {}) };
    delete next.hasToken;   // derived, file-backed — never persisted to ui-settings
    let portsChanged = false;
    if (partial && 'ports' in partial) {
      const checked = validatePortsForSave(next.ports, { writer, prior: before.ports });
      if (checked.error) return { ok: false, error: checked.error };
      next.ports = checked.ports;
      portsChanged = JSON.stringify(normalizePorts(before.ports).ports || []) !== JSON.stringify(next.ports);
    }
    if (partial && 'mounts' in partial) {
      const checked = validateMountsForSave(next.mounts);
      if (checked.error) return { ok: false, error: checked.error };
      next.mounts = checked.mounts;
    }
    if (partial && 'ref' in partial) {
      const checked = normalizeRef(next.ref);
      if (checked.error) return { ok: false, error: checked.error };
      next.ref = checked.ref;
    }
    if (partial && 'limits' in partial) {
      const checked = validateLimitsForSave(next.limits, { figures: getFigures() });
      if (checked.error) return { ok: false, error: checked.error };
      next.limits = checked.limits;
    }
    if (partial && 'platform' in partial) {
      const checked = normalizePlatform(next.platform);
      if (checked.error) return { ok: false, error: checked.error };
      next.platform = checked.platform;
    }
    if (partial && 'relay' in partial) next.relay = next.relay === true;
    if (writeBoxConfig(next) === false) return { ok: false, error: 'no such sandbox' };
    if (portsChanged) {
      return serialize(async () => (await isRunning() ? applyPortsNow() : null))
        .then((applied) => (applied && !applied.ok ? { ...getConfig(), portsError: applied.error } : getConfig()));
    }
    return getConfig();
  }

  function ownClodexHostPorts() {
    const c = getConfig();
    const out = new Set([c.webPort, c.wirescopePort, c.wirePort]);
    try {
      for (const p of Object.values(parseOwnPortMap(fs.readFileSync(composePath(), 'utf8')))) out.add(p);
    } catch {}
    return out;
  }

  function siblingPortOwners() {
    const owners = new Map();
    for (const file of siblingComposePaths()) {
      try {
        for (const row of parsePortOwners(fs.readFileSync(file, 'utf8'))) {
          if (!owners.has(row.port)) owners.set(row.port, row.boxId);
        }
      } catch {}
    }
    return owners;
  }

  function validatePortsForSave(rawPorts, { writer = 'intent', prior = [] } = {}) {
    const norm = normalizePorts(rawPorts);
    if (norm.error) return norm;
    const ports = norm.ports;
    const priorList = normalizePorts(prior).ports || [];
    const clodexHost = ownClodexHostPorts();
    const owners = siblingPortOwners();
    const listed = new Set(ports.map((p) => p.host));
    const seen = new Set();
    const nextFree = (from) => {
      let p = from + 1;
      while (p <= 65535 && (owners.has(p) || clodexHost.has(p) || listed.has(p))) p++;
      return p <= 65535 ? p : null;
    };
    for (const p of ports) {
      if (seen.has(p.host)) return { error: `Host port ${p.host} is listed twice.` };
      seen.add(p.host);
      if (clodexHost.has(p.host)) return { error: `Host port ${p.host} is one of this box's Clodex ports; pick another host port.` };
      if (owners.has(p.host)) {
        const free = nextFree(p.host);
        const hint = free ? `; use ${p.container}:${free}` : '';
        return { error: `${p.host} is published by sandbox ${owners.get(p.host) || '(unknown)'}${hint}` };
      }
    }
    const priorWide = priorList.filter((p) => p.allInterfaces);
    if (writer !== 'panel') {
      for (const was of priorWide) {
        const now = ports.find((p) => samePortPair(p, was));
        if (!now || !samePortEntry(now, was)) {
          return { error: `${was.container}:${was.host} is published on all IPv4 interfaces; only the Sandbox panel may change it.` };
        }
      }
      if (ports.some((p) => p.allInterfaces && !priorWide.some((was) => samePortEntry(p, was)))) {
        return { error: 'All-interfaces exposure can only be turned on from the Sandbox panel.' };
      }
    }
    const wideDropped = priorWide.some((was) => !ports.some((q) => samePortPair(q, was)));
    for (const p of ports) {
      if (p.allInterfaces && wideDropped && !priorWide.some((was) => samePortPair(p, was))) p.allInterfaces = false;
    }
    return { ports };
  }

  function portsRecordPath() { return path.join(sandboxDir(), PORTS_RECORD_FILE); }
  function boxPortsRecordPath() { return path.join(stateDir(), 'dot', PORTS_RECORD_FILE); }

  function writePortsRecord(rows) {
    const text = `${JSON.stringify(rows, null, 2)}\n`;
    for (const file of [portsRecordPath(), boxPortsRecordPath()]) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, text);
    }
  }

  function readPortsRecord() {
    try {
      const rows = JSON.parse(fs.readFileSync(portsRecordPath(), 'utf8'));
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }

  async function recordPorts(ports, result) {
    const local = result.ok && ports.length ? await dockerIsLocal() : false;
    const error = result.ok ? undefined : String(result.stderr || '').trim().slice(-200) || `docker compose exited ${result.code}`;
    const rows = ports.map((p) => {
      const row = { container: p.container, host: p.host, proto: p.proto, allInterfaces: p.allInterfaces, applied: !!result.ok };
      if (error) row.error = error;
      const url = result.ok ? portUrl(p, local) : undefined;
      if (url) row.url = url;
      return row;
    });
    writePortsRecord(rows);
    return rows;
  }

  async function isRunning() {
    return parseComposeState((await runCompose(['ps', '--format', 'json'])).stdout) === 'running';
  }

  async function applyPortsNow() {
    const owner = await foreignOwner();
    if (owner) return foreignError(owner);
    const ports = normalizePorts(getConfig().ports).ports || [];
    const svc = gatewayServiceName(id);
    const rewrite = async () => {
      try { await writeComposeFile({ keepPlatform: true }); return null; } catch (e) {
        return { ok: false, error: `compose write failed: ${(e && e.message) || e}` };
      }
    };
    let r;
    if (ports.length) {
      const failed = await rewrite();
      if (failed) return failed;
      r = await runCompose(['up', '-d', '--no-deps', svc]);
    } else {
      r = await runCompose(['rm', '-sf', svc]);
      if (!r.ok) return { ok: false, error: r.stderr.trim() || `docker compose exited ${r.code}`, ports: [] };
      const failed = await rewrite();
      if (failed) {
        await recordPorts([], r);
        return failed;
      }
    }
    const rows = await recordPorts(ports, r);
    if (!r.ok) return { ok: false, error: rows.length ? rows[0].error : (r.stderr.trim() || `docker compose exited ${r.code}`), ports: rows };
    return { ok: true, ports: rows };
  }

  function applyPorts() { return serialize(applyPortsNow); }

  function portsState() {
    return { ports: normalizePorts(getConfig().ports).ports || [], applied: readPortsRecord() };
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
      if (target) entry.container = canonicalMountTarget(target);
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
  function authToken() {
    try { return readAuthEnv().CLAUDE_CODE_OAUTH_TOKEN || null; } catch { return null; }
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
  function webToken() {
    try { return readAuthEnv().CLODEX_WEB_TOKEN || null; } catch { return null; }
  }
  function ensureBoxTokens() {
    const env = readAuthEnv();
    let changed = false;
    for (const key of ['CLODEX_REMOTE_TOKEN', 'CLODEX_WEB_TOKEN']) {
      if (env[key]) continue;
      env[key] = crypto.randomBytes(32).toString('hex');
      changed = true;
    }
    if (changed) writeAuthEnv(env);
    return { remote: env.CLODEX_REMOTE_TOKEN, web: env.CLODEX_WEB_TOKEN };
  }

  function siblingPorts() {
    const out = [];
    for (const file of siblingComposePaths()) {
      try { out.push(...parseOwnPorts(fs.readFileSync(file, 'utf8'))); } catch {}
    }
    return out;
  }

  async function buildBusySet(config, ownPorts) {
    const own = new Set(ownPorts || []);
    let ownLive = null;
    const isOwnLive = async () => {
      if (ownLive === null) ownLive = parseComposeState((await runCompose(['ps', '--format', 'json'])).stdout) === 'running';
      return ownLive;
    };
    const set = new Set(siblingPorts());
    for (const start of [config.webPort, config.wirescopePort, config.wirePort]) {
      for (let p = start; p < start + PORT_SCAN_WINDOW; p++) {
        try { if (!set.has(p) && await isPortInUse(p) && !(own.has(p) && await isOwnLive())) set.add(p); } catch { /* treat as free */ }
      }
    }
    return set;
  }

  function hostUser(config, image) {
    if (platform !== 'linux') return null;
    if (config.image) {
      log.info('sandbox', `box ${id}: image override ${config.image} runs as the image user; the host uid remap needs the bundled entrypoint`);
      return null;
    }
    if (image.kind === 'build' && !fs.existsSync(path.join(image.context, 'docker', 'web', 'entrypoint.sh'))) return null;
    let uid, gid;
    try {
      ({ uid, gid } = userInfo());
    } catch (e) {
      log.info('sandbox', `box ${id}: host uid unresolvable (${e.message}); box runs as the image user`);
      return null;
    }
    return Number.isInteger(uid) && Number.isInteger(gid) && uid >= 0 && gid >= 0 ? { uid, gid } : null;
  }

  async function writeComposeFile({ keepPlatform = false } = {}) {
    const config = getConfig();
    const image = await resolveImageForConfig(config);
    let ownPorts = [];
    let prior = null;
    try { prior = fs.readFileSync(composePath(), 'utf8'); } catch { /* no prior file */ }
    if (prior != null) ownPorts = parseOwnPorts(prior);
    const writtenPlatform = prior == null ? null : parseComposePlatform(prior);
    const busy = await buildBusySet(config, ownPorts);
    const appPorts = normalizePorts(config.ports).ports || [];
    for (const p of appPorts) busy.add(p.host);
    const ports = resolvePorts(config, (p) => busy.has(p));
    const authFile = fs.existsSync(authEnvPath()) ? authEnvPath() : null;
    for (const d of LIBRARY_MOUNT_DIRS) {
      if (d.startsWith('library/')) continue;
      try { fs.mkdirSync(path.join(registryDir, d), { recursive: true }); } catch {}
    }
    for (const d of ['data', 'dot', 'claude', 'muse', 'muse-data']) {
      fs.mkdirSync(path.join(stateDir(), d), { recursive: true, mode: 0o700 });
    }
    const yaml = generateCompose({
      image, ports, workDir: config.workDir || null, authEnvFile: authFile,
      libDir: registryDir, mounts: config.mounts, hostname: id, stateDir: stateDir(),
      hostUser: hostUser(config, image), appPorts, limits: config.limits, platform: keepPlatform ? writtenPlatform : config.platform,
      hostLabel: deps.selfLabel || null,
    });
    fs.mkdirSync(sandboxDir(), { recursive: true });
    fs.writeFileSync(composePath(), yaml, { mode: 0o600 });
    return { path: composePath(), ports, image };
  }

  // -p pins the compose project to the box id (per-box volume namespace, M6b P2);
  // -f points at this box's generated compose file. Both precede the subcommand.
  function composeArgs(extra) { return ['compose', '-p', composeProjectName(id), '-f', composePath(), ...extra]; }

  function runCompose(extra) { return runDocker(composeArgs(extra)); }

  async function containerStartedAt() {
    const ps = await runCompose(['ps', '--all', '-q']);
    const cid = ps.ok ? ps.stdout.split('\n').map((l) => l.trim()).find(Boolean) : null;
    if (!cid) return null;
    const r = await runDocker(['inspect', '-f', '{{.State.StartedAt}}', cid]);
    const at = r.ok ? r.stdout.trim() : '';
    return at || null;
  }

  function runDocker(args) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

  function composeOwner() {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn('docker', [
          'ps', '-a',
          '--filter', `label=${COMPOSE_PROJECT_LABEL}=${composeProjectName(id)}`,
          '--format', `{{.Label "${COMPOSE_CONFIG_FILES_LABEL}"}}`,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        resolve({ ok: false, owners: [] });
        return;
      }
      let stdout = '';
      if (child.stdout) child.stdout.on('data', (d) => { stdout += d; });
      if (child.stderr) child.stderr.on('data', () => {});
      child.on('error', () => resolve({ ok: false, owners: [] }));
      child.on('exit', (code) => {
        if (code !== 0) { resolve({ ok: false, owners: [] }); return; }
        const owners = [...new Set(stdout.split('\n').map((l) => l.trim()).filter(Boolean))];
        resolve({ ok: true, owners });
      });
    });
  }

  function canonicalPath(p) {
    try { return fs.realpathSync(p); } catch { return path.resolve(p); }
  }

  async function foreignOwner() {
    const r = await composeOwner();
    if (!r.ok || !r.owners.length) return null;
    const mine = canonicalPath(composePath());
    return r.owners.some((o) => canonicalPath(o) === mine) ? null : r.owners[0];
  }

  function foreignError(owner) {
    return { ok: false, code: 'foreign', error: `box ${id} belongs to another Clodex instance (${owner})` };
  }

  function bringUp(runSteps, label) {
    // serialize() chains this across every box the manager owns (default: inline),
    // so the port probe + compose regen can't race when two boxes come up at once.
    return serialize(async () => {
      if (!boxExists()) return { ok: false, error: `no such sandbox: ${id}` };
      const owner = await foreignOwner();
      if (owner) return foreignError(owner);
      const d = await detect();
      if (d && d.running && d.compose === false) {
        invalidateDetect();
        return { ok: false, error: DOCKER_NO_COMPOSE_MSG };
      }
      try { ensureBoxTokens(); } catch (e) {
        return { ok: false, error: `token provision failed: ${(e && e.message) || e}` };
      }
      const config = getConfig();
      if (config.ref && !config.image) {
        const synced = await syncSrcToRef(config.ref);
        if (!synced.ok) return { ok: false, error: synced.error };
      }
      let gen;
      try { gen = await writeComposeFile(); } catch (e) {
        return { ok: false, error: `compose write failed: ${(e && e.message) || e}` };
      }
      const r = await runSteps(gen);
      const appPorts = normalizePorts(config.ports).ports || [];
      if (appPorts.length || fs.existsSync(portsRecordPath())) {
        try { await recordPorts(appPorts, r); } catch {}
      }
      if (!r.ok) {
        const gone = dockerUnavailableError(r.stderr);
        if (gone) { invalidateDetect(); return { ok: false, error: gone }; }
        return { ok: false, error: r.stderr.trim() || `docker compose ${label} exited ${r.code}` };
      }
      try {
        registerPeer(gen.ports.wire);
      } catch (e) {
        const peerError = (e && e.message) || String(e);
        log.warn('sandbox', `${id} ${label} — wire peer on port ${gen.ports.wire} NOT registered: ${peerError}`);
        return { ok: true, ports: gen.ports, image: describeImage(gen.image), peerRegistered: false, peerError };
      }
      log.info('sandbox', `${id} ${label} — wire peer http://127.0.0.1:${gen.ports.wire}`);
      return { ok: true, ports: gen.ports, image: describeImage(gen.image), peerRegistered: true };
    });
  }

  async function up() {
    return bringUp((_gen) => runCompose(['up', '-d', '--remove-orphans']), 'up');
  }

  async function rebuild() {
    return bringUp(async (gen) => {
      if (gen.image.kind === 'build') return runCompose(['up', '-d', '--build', '--force-recreate', '--remove-orphans']);
      const pulled = await runCompose(['pull']);
      if (!pulled.ok) return pulled;   // pull failed → skip up, surface its stderr
      return runCompose(['up', '-d', '--force-recreate', '--remove-orphans']);
    }, 'rebuild');
  }

  // Stop the sandbox. The peer row STAYS (goes offline) — it's the affordance to
  // start it again later, so down never touches the peers list.
  async function down() {
    const owner = await foreignOwner();
    if (owner) return foreignError(owner);
    const r = await runCompose(['down', '--remove-orphans']);
    if (!r.ok) {
      const gone = dockerUnavailableError(r.stderr);
      if (gone) { invalidateDetect(); return { ok: false, error: gone }; }
      return { ok: false, error: r.stderr.trim() || `docker compose down exited ${r.code}` };
    }
    for (const file of [portsRecordPath(), boxPortsRecordPath()]) {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
    return { ok: true };
  }

  async function boxWaitHealthy(timeoutMs) {
    let ports = {};
    try { ports = parseOwnPortMap(fs.readFileSync(composePath(), 'utf8')); } catch { ports = {}; }
    const url = ports.web ? `http://127.0.0.1:${ports.web}` : null;
    return waitHealthy({ id, url, timeoutMs, fetch: deps.fetch, now: deps.now, sleep: deps.sleep });
  }

  function advancedStatus(config, live) {
    const configured = { ...DEFAULT_CONFIG.limits, ...(config.limits || {}) };
    return {
      limits: { configured, applied: live ? live.limits : null },
      platform: { configured: config.platform || null, applied: live ? live.platform : null },
      usage: live ? live.usage : null,
    };
  }

  async function liveBoxFigures() {
    const ps = await runCompose(['ps', '-q', 'clodex']);
    const cid = ps.ok ? ps.stdout.split('\n').map((l) => l.trim()).find(Boolean) : null;
    if (!cid) return null;
    const imagePlatform = async () => {
      const img = await runDocker(['inspect', cid, '--format', '{{.Image}}']);
      const imageId = img.ok ? img.stdout.trim() : '';
      if (!imageId) return null;
      const arch = await runDocker(['image', 'inspect', imageId, '--format', '{{.Os}}/{{.Architecture}}']);
      const text = arch.ok ? arch.stdout.trim() : '';
      return /^[a-z0-9]+\/[a-z0-9]+$/.test(text) ? text : null;
    };
    const [hc, platform, stats] = await Promise.all([
      runDocker(['inspect', cid, '--format', '{{json .HostConfig}}']),
      imagePlatform(),
      runDocker(['stats', '--no-stream', '--format', '{{.CPUPerc}} {{.MemUsage}}', cid]),
    ]);
    const limits = hc.ok ? parseAppliedLimits(hc.stdout) : null;
    const usage = stats.ok ? parseStatsLine(stats.stdout) : null;
    return { limits, platform, usage };
  }

  async function status(opts = {}) {
    const live = !!(opts && opts.live);
    const statusConfig = getConfig();
    const trackedRef = (statusConfig.ref && !statusConfig.image) ? statusConfig.ref : null;
    const owner = await foreignOwner();
    const r = await runCompose(['ps', '--format', 'json']);
    if (!r.ok && !r.stdout.trim()) {
      const absent = { state: 'absent', ref: trackedRef, sha: trackedRef ? await headSha(srcDir()) : null, error: r.stderr.trim() || undefined };
      if (owner) absent.foreign = owner;
      return { ...absent, ...advancedStatus(statusConfig, null) };
    }
    const state = parseComposeState(r.stdout);
    const out = { state, ref: trackedRef, sha: trackedRef ? await headSha(srcDir()) : null };
    if (owner) out.foreign = owner;
    Object.assign(out, advancedStatus(statusConfig, live && state === 'running' ? await liveBoxFigures() : null));
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
      if (existing.url === url && (existing.token || null) === (token || null) && existing.inbox === 'claim') return;
      existing.url = url;
      existing.inbox = 'claim';
      if (token) existing.token = token; else delete existing.token;
    } else {
      const entry = { id, label: boxLabel, url, inbox: 'claim' };
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
    detect, getConfig, setConfig, validatePortsForSave, applyPorts, portsState, writeComposeFile, translateHostPath,
    up, rebuild, down, status, logsTail, registerPeer, unregisterPeer, containerStartedAt,
    waitHealthy: boxWaitHealthy,
    hasAuthToken, authToken, setAuthToken, clearAuthToken,
    remoteToken, webToken,
    composePath, sandboxDir, srcDir, stateDir,
  };
}

function createSandboxManager(deps = {}) {
  const getUiSettings = deps.getUiSettings;
  const listBoxes = deps.listBoxes
    || (() => { try { return getUiSettings().get().boxes || []; } catch { return []; } });

  const managerSpawn = deps.spawn || cp.spawn;
  const now = deps.now || Date.now;
  const detectCache = createDetectCache({ probe: () => probeDocker(managerSpawn), now });
  const localCache = createDetectCache({ probe: () => probeDockerLocal(managerSpawn, deps.env || process.env), now });
  detectCache.get().catch(() => {});
  const figuresCache = createDetectCache({ probe: () => probeDockerFigures(managerSpawn), now });
  let lastFigures = NO_FIGURES;
  function figures() {
    return figuresCache.get().then(
      (r) => { lastFigures = { ncpu: r.ncpu, memTotal: r.memTotal }; return lastFigures; },
      () => lastFigures);
  }

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
      boxExists: () => listBoxes().some((b) => b && b.id === boxId),
      siblingComposePaths: () => listBoxes()
        .filter((b) => b && b.id && b.id !== boxId)
        .map((b) => get(b.id))
        .filter(Boolean)
        .map((inst) => inst.composePath()),
      detect: () => detectCache.get(),
      invalidateDetect: () => detectCache.invalidate(),
      getFigures: () => lastFigures,
      dockerIsLocal: deps.dockerIsLocal || (() => localCache.get().then((r) => r.local)),
      readBoxConfig: () => {
        const row = listBoxes().find((b) => b && b.id === boxId);
        return (row && row.config) || {};
      },
      writeBoxConfig: (next) => {
        const boxes = listBoxes().map((b) => ({ ...b }));
        const row = boxes.find((b) => b && b.id === boxId);
        if (!row) return false;
        row.config = next;
        getUiSettings().set({ boxes });
        return true;
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

  // Best-effort down: a stop failure is surfaced but does not block removal of
  // the registry row.
  function remove(rawId) {
    return serialize(() => removeNow(rawId));
  }

  async function removeNow(rawId) {
    const boxId = String(rawId || '').trim();
    const box = listBoxes().find((b) => b && b.id === boxId);
    if (!box) return { ok: false, error: `no such sandbox: ${boxId}` };
    const inst = get(boxId);
    let downError;
    try { const d = await inst.down(); if (d && d.ok === false) downError = d.error; }
    catch (e) { downError = String((e && e.message) || e); }
    try { if (fs.existsSync(inst.srcDir())) await removeWorktree(inst.srcDir()); } catch {}
    if (!downError) {
      const dir = inst.stateDir();
      if (path.basename(path.dirname(dir)) === 'boxes' && path.basename(dir) === boxId) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
      const own = inst.sandboxDir();
      if (path.dirname(own) === deps.getUserDataPath() && path.basename(own) === subdirFor(boxId)) {
        try { fs.rmSync(own, { recursive: true, force: true }); } catch {}
      }
    }
    inst.unregisterPeer();
    const boxes = listBoxes().filter((b) => !(b && b.id === boxId));
    getUiSettings().set({ boxes });
    instances.delete(boxId);
    return { ok: true, downError };
  }

  return { get, list, create, remove, figures, detect: () => detectCache.get(), invalidateDetect: () => detectCache.invalidate() };
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
  createDetectCache, dockerUnavailableError, probeDocker, probeDockerFigures, parseFigures, parseComposePlatform, parseStatsLine, parseAppliedLimits,
  validateLimitsForSave, normalizePlatform, sizeToBytes, OPERATOR_ONLY_MSG,
  resolveImage, describeImage, resolvePorts, nextFreePort, generateCompose,
  parseOwnPorts, parsePortOwners, parseOwnPortMap, normalizePorts, gatewayServiceName, probeDockerLocal, parsePsRows, parseComposeState, defaultIsPortInUse, waitHealthy,
  defaultMountTarget, normalizeMounts, translatePath, relUnder, composeProjectName,
  runningInSandboxBox,
  DEFAULT_CONFIG, DEFAULT_PORTS, CONTAINER_PORTS, RESERVED_MOUNT_TARGETS, WORK_CONTAINER_DIR,
  SANDBOX_PEER_ID, SANDBOX_PEER_LABEL, SANDBOX_BOX_ENV, BOX_ID_RE, RESERVED_BOX_IDS,
  DOCKER_ABSENT_MSG, DOCKER_DOWN_MSG, DOCKER_NO_COMPOSE_MSG,
};
