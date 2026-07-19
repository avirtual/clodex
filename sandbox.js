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
const { createDetectCache } = require('./detect-cache');

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
  // M6a: user-defined extra bind mounts. Each entry is { host, container?, ro? }
  // — host an absolute host folder, container an optional explicit target
  // (derived from the host basename when omitted), ro an optional read-only flag
  // (defaults to read-WRITE: agents are meant to work in mounted folders). These
  // are ADDITIVE to workDir and the library binds; they attach only at container
  // create, so a change takes effect on the next Start.
  mounts: [],
};

// Load-bearing container paths a user mount must never shadow — the box's data
// volume, work dir, IPC/.clodex tree, and Claude auth. A user target that equals,
// nests under, or is an ancestor of any of these would break the box, so
// normalizeMounts refuses it rather than silently generating a broken compose.
const RESERVED_MOUNT_TARGETS = ['/data', '/home/clodex/work', '/home/clodex/.clodex', '/home/clodex/.claude'];
// Where derived mount targets land — beside the work dir, so a mounted project
// sits next to it in the box's home.
const MOUNT_TARGET_ROOT = '/home/clodex';
// Container path the work dir binds to (generateCompose's `/home/clodex/work`
// literal + placement.js SANDBOX_PLACEMENT_CWD). Named here as the host→container
// translation authority; the compose bytes keep their pinned literal.
const WORK_CONTAINER_DIR = '/home/clodex/work';

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

// The charset a NEWLY-created box id must satisfy (M6b P2). Tighter than the
// session-name charset stores.sanitizeBoxes admits: docker derives the compose
// PROJECT name from the box's compose-dir basename (sandbox-<id>), and project
// names disallow dots + uppercase (`[a-z0-9][a-z0-9_-]*`) — two ids differing only
// in case/dots would collapse to one project and share volumes. So creation, the
// only path minting new ids, is gated here; the sanitizer stays broad so an
// already-persisted row (or the legacy 'sandbox' id) is never eaten.
const BOX_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Reserved box ids (M6b P3). The New Session placement selector carries the box id
// as its <option> value, with 'host' meaning "this Mac" — so a box literally named
// 'host' would shadow the host option and make its placement unaddressable. Reject
// it at create (and drop it in the store's sanitizer) so the two value-spaces never
// collide. BOX_ID_RE alone WOULD admit 'host'; this is the extra gate.
const RESERVED_BOX_IDS = new Set(['host']);

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

// Default container path for a host folder: /home/clodex/<basename>. Mirrors the
// work dir's neighborhood so mounted projects sit beside it in the box's home.
function defaultMountTarget(hostPath) {
  return path.posix.join(MOUNT_TARGET_ROOT, path.basename(hostPath));
}

// Two container targets conflict when either contains the other (equal, one
// nested in the other) — a bind at /home/clodex would swallow every reserved
// subpath, a bind at /home/clodex/.clodex/x sits inside a reserved one.
function mountTargetsConflict(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// Normalize + validate the user mounts array into resolved { host, container, ro }
// binds. PURE (no fs — host-existence is a separate on-save check): returns
// { mounts } on success, or { error } on the first violation. Rules: host and any
// explicit target must be absolute; a target must not shadow a RESERVED_MOUNT_TARGET
// (equal/nested/ancestor); explicit duplicate targets are rejected. An omitted
// target derives from the host basename, with deterministic `-N` suffixes when two
// hosts share a basename. Blank rows (no host) are skipped — the editor may hold one.
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

// The docker-compose PROJECT name for a box (M6b P2). Passed explicitly via
// `-p` so per-box volume/network/container namespaces are keyed off the box id
// rather than the compose-file's parent-dir basename (which docker would derive
// otherwise). Compose project names allow only `[a-z0-9][a-z0-9_-]*`, so any junk
// is lowercased and coerced; box ids are already gated to that charset at create,
// so this is defensive. Empty/degenerate input falls back to the shared id.
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

// Translate a HOST folder to its container path IF the box can already see it:
// under the work dir (→ /home/clodex/work[/rel]) or under any configured mount
// (→ that mount's container target + rel). normalizeMounts is the derivation
// authority for mounts without an explicit target (basename + `-N` collisions) —
// NOT reimplemented here. Longest matching host prefix wins, so a mount nested
// under workDir maps to the (more specific) mount. Returns { container } when
// reachable, else { reachable: false } so the caller can offer to add a mount.
// PURE over an explicit config; the factory method wraps it with getConfig().
function translatePath({ hostPath, workDir, mounts }) {
  const host = String(hostPath || '').trim();
  if (!host || !path.isAbsolute(host)) return { reachable: false };
  const candidates = [];
  if (workDir) candidates.push({ host: workDir, container: WORK_CONTAINER_DIR });
  const norm = normalizeMounts(mounts);
  if (!norm.error) for (const m of norm.mounts) candidates.push({ host: m.host, container: m.container });
  // Longest host prefix first — the most specific mount wins over an ancestor.
  candidates.sort((a, b) => b.host.length - a.host.length);
  for (const c of candidates) {
    const rel = relUnder(host, c.host);
    if (rel !== null) return { container: rel ? path.posix.join(c.container, rel) : c.container };
  }
  return { reachable: false };
}

// Generate the compose.yaml bytes from a config. Mirrors docker/web/compose.yaml
// (hostname sandbox, three loopback publishes, named vols, init, restart:always,
// healthcheck) with image/ports/work-volume swapped in. `image` is a
// resolveImage() result, `ports` a resolvePorts() result. authEnvFile (M4) is a
// path to a SEPARATE env file — referenced via env_file, never inlined; null in
// M1 so no secrets ever land in these bytes.
function generateCompose({ image, ports, workDir, authEnvFile, libDir, mounts, hostname }) {
  // The container hostname IS the engine's SELF_LABEL on the peer wire, so it must
  // be UNIQUE per managed box or two boxes would both self-identify as 'sandbox'
  // and DM reply routing would collide (M6b). Defaults to the shared box's id so
  // the single-box bytes stay byte-identical (the compose tests pin `sandbox`).
  const boxHostname = hostname || SANDBOX_PEER_ID;
  const L = [];
  L.push('# GENERATED by Clodex (sandbox.js) — do NOT edit.');
  L.push('# Regenerated from the ui-settings `sandbox` config on every Start; edits are lost.');
  L.push('# Source of truth: docs/sandbox-plan.md + docker/web/compose.yaml.');
  L.push('');
  L.push('services:');
  L.push('  clodex:');
  // Stable hostname = the engine's SELF_LABEL on the peer wire (DM reply routing
  // breaks without it — docker/web/compose.yaml learned this live, 34dbe31).
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
  // M6a: user-defined extra bind mounts, appended after the box's own volumes so
  // they never precede (and can't be shadowed by) the load-bearing binds above.
  // normalizeMounts derives targets, refuses reserved-path shadows, and rejects
  // duplicates — a violation THROWS here so up/rebuild surface it instead of
  // writing a broken compose. Sources double-quoted like the workDir/lib binds
  // (a host path with spaces or a ` #` would otherwise truncate the YAML scalar).
  const resolvedMounts = normalizeMounts(mounts);
  if (resolvedMounts.error) throw new Error(resolvedMounts.error);
  for (const mnt of resolvedMounts.mounts) {
    L.push(`      - "${mnt.host}:${mnt.container}${mnt.ro ? ':ro' : ''}"`);
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

// Map an existing generated compose.yaml's published host ports back to their
// roles by the CONTAINER port each targets — the `127.0.0.1:<host>:<container>`
// lines. Unlike parseOwnPorts' flat list, this is order-independent (keyed off the
// fixed CONTAINER_PORTS) so status() can report the EFFECTIVE (possibly bumped)
// host ports per role. Returns { web?, wirescope?, wire? } with only the roles
// present; {} for missing/garbage input.
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

// ── Docker detection: probe + cache + error mapping ─────────────────────────

// Raw `docker info` probe (the old inline detect body, hoisted so the manager's
// cache can drive it with one shared `spawn`). `docker info` distinguishes "not
// installed" (spawn ENOENT → present:false) from "daemon not running" (CLI runs,
// non-zero exit → present:true, running:false) from healthy (exit 0 →
// running:true). A hung daemon trips DETECT_TIMEOUT_MS and reads as
// present-but-not-running. Never rejects.
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

// createDetectCache lives in the shared detect-cache.js leaf now (Task 12) so
// tool-doctor.js can reuse the same TTL+dedupe without depending on this whole
// module. Re-exported below so this file's unit suite still imports it from here.

// Operator-facing docker-remedy copy. KEEP IN SYNC with
// renderer/lib/sandbox-view.js detectNotice — the dialog shows the same two
// messages for a down/absent daemon, and a late compose failure (daemon died
// between probe and click) must surface the SAME copy rather than raw stderr.
const DOCKER_ABSENT_MSG = 'Docker isn’t installed — sandboxes need Docker Desktop.';
const DOCKER_DOWN_MSG = 'Docker daemon isn’t running — start Docker Desktop.';

// Map a compose stderr / spawn-error string to the friendly docker-unavailable
// copy, or null when the failure is a genuine compose error (which keeps its own
// stderr). Callers that get a non-null result also invalidate the detect cache so
// the dialog reflects the daemon that just went away.
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
  // Docker detection + cache-invalidation seams. The manager injects the shared
  // (cached, docker-wide) probe so s.detect() returns the stamped payload and a
  // late compose failure can invalidate it. A BARE createSandbox() (unit tests,
  // standalone) falls back to the raw uncached probe and a no-op invalidate.
  const detect = deps.detect || (() => probeDocker(spawn));
  const invalidateDetect = deps.invalidateDetect || (() => {});
  // Host ~/.clodex root — the source of the read-only library binds. Injected by
  // engine.js as REGISTRY_DIR; defaults to ~/.clodex for standalone/test use.
  const registryDir = deps.registryDir || path.join(os.homedir(), '.clodex');

  // ── Box identity (M6b P1: N instances, one shape) ───────────────────────────
  // Every field defaults to the shared box so a bare createSandbox() (and every
  // existing single-box test) behaves EXACTLY as before. The manager overrides
  // them per box:
  //   id/boxLabel — the peer row id/label AND the container hostname (SELF_LABEL
  //                 on the wire), so each box self-identifies uniquely.
  //   subdir      — the per-box compose dir under <userData> (isolates each box's
  //                 generated compose.yaml + auth.env). The compose PROJECT name
  //                 (which prefixes every named volume, giving per-box volume
  //                 namespaces) is set EXPLICITLY via -p composeProjectName(id).
  //   readBoxConfig/writeBoxConfig — the config seam. The manager routes these to
  //                 the box's row in the `boxes` registry; the bare default here
  //                 reads/writes a top-level `sandbox` key and exists only for
  //                 standalone/unit-test use (no production caller constructs a
  //                 sandbox without the manager's seams).
  //   serialize   — chains bringUp across instances so N boxes can't race the
  //                 shared port probe. Default runs inline (no cross-box chain).
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

  // Config read/write through the ui-settings `sandbox` key, defaults filled.
  // hasToken is DERIVED from the auth.env file's existence (M4) — never stored:
  // the token value lives only in that 0600 file, never in ui-settings or any
  // result payload. getConfig surfaces the boolean so the dialog can show the
  // "configured" state; setConfig strips it before persisting.
  function getConfig() {
    let s = {};
    try { s = readBoxConfig() || {}; } catch { s = {}; }
    return { ...DEFAULT_CONFIG, ...s, hasToken: hasAuthToken() };
  }
  function setConfig(partial) {
    const next = { ...getConfig(), ...(partial || {}) };
    delete next.hasToken;   // derived, file-backed — never persisted to ui-settings
    // M6a: when mounts are being set, validate them (structure/shadow/duplicate +
    // host-folder existence) BEFORE persisting, so the store never holds a mount
    // that would fail at Start. On a violation nothing is written and the GUI gets
    // an { ok:false, error } to surface; otherwise the cleaned shape is stored.
    if (partial && 'mounts' in partial) {
      const checked = validateMountsForSave(next.mounts);
      if (checked.error) return { ok: false, error: checked.error };
      next.mounts = checked.mounts;
    }
    writeBoxConfig(next);
    return getConfig();
  }

  // On-save mount validation = the pure normalizeMounts rules PLUS a host-folder
  // existence check (fs, so it can't live in the pure helper). Returns { error }
  // on the first failure, else { mounts } cleaned to the persisted shape ({ host,
  // ro, container? } — the explicit target only when the user set one, so derived
  // targets stay dynamic across basename collisions).
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

  // Translate a host folder (from the New Session picker) to its container path
  // against the LIVE config (workDir + mounts). { container } when the box already
  // sees it, else { reachable:false } so the renderer can offer to add a mount.
  function translateHostPath(hostPath) {
    const config = getConfig();
    return translatePath({ hostPath, workDir: config.workDir, mounts: config.mounts });
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

  // Shared bring-up: provision the peer-wire token, regenerate compose from the
  // authoritative config, run the caller's compose command(s), then register the
  // managed peer at the resolved wire port. up() and rebuild() differ ONLY in the
  // compose invocation between compose-write and register — token provisioning,
  // compose bytes, error shaping, and peer registration are one path, so a
  // rebuild that succeeds leaves the peer registered exactly like up(). `runSteps`
  // gets the writeComposeFile() result (so it can branch on gen.image.kind) and
  // returns a runCompose() result; a non-ok result skips registration. `label`
  // names the op in the error/log strings.
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
        // Daemon died between the probe and this click → surface the friendly
        // docker copy (not raw compose stderr) and drop the stale detect cache.
        const gone = dockerUnavailableError(r.stderr);
        if (gone) { invalidateDetect(); return { ok: false, error: gone }; }
        return { ok: false, error: r.stderr.trim() || `docker compose ${label} exited ${r.code}` };
      }
      registerPeer(gen.ports.wire);
      log.info('sandbox', `${id} ${label} — wire peer http://127.0.0.1:${gen.ports.wire}`);
      return { ok: true, ports: gen.ports };
    });
  }

  // Start (or recreate) the sandbox: regenerate compose from config, `up -d`,
  // then register the managed peer at the resolved wire port. stderr surfaces on
  // failure and the peer is NOT registered.
  async function up() {
    return bringUp((_gen) => runCompose(['up', '-d']), 'up');
  }

  // Rebuild the sandbox on the CURRENT code, then recreate the container — the
  // one-click path for getting tree IPC/prompt changes into a running box. The
  // mechanic branches on the resolved image kind: a dev checkout (kind 'build')
  // rebuilds the image from the repo with `up -d --build`; a packaged install
  // (pinned GHCR tag) has no build context, so it `pull`s the newer image first
  // and then `up -d`. Same token + compose + register flow as up(); the box
  // --resumes its sessions at boot, so the recreate is survivable by design.
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
      // Stop is never capability-gated, but if it fails because docker is gone we
      // still give the friendly copy + invalidate the cache (same as up/rebuild).
      const gone = dockerUnavailableError(r.stderr);
      if (gone) { invalidateDetect(); return { ok: false, error: gone }; }
      return { ok: false, error: r.stderr.trim() || `docker compose down exited ${r.code}` };
    }
    return { ok: true };
  }

  // running / exited / absent (compose ps). A spawn failure reads as absent.
  async function status() {
    const r = await runCompose(['ps', '--format', 'json']);
    if (!r.ok && !r.stdout.trim()) {
      return { state: 'absent', error: r.stderr.trim() || undefined };
    }
    const state = parseComposeState(r.stdout);
    const out = { state };
    // Effective (last-generated) host ports, keyed by role — for the renderer's
    // Open-in-browser link + bumped-port hint. Only meaningful while RUNNING: the
    // compose file persists after Stop, but then its ports describe no live
    // listener (and Start regenerates them). resolvePorts can bump on collision,
    // so these can differ from the configured field values (e.g. box 2 on 7812).
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

  // Idempotent peer registration through the settings write path — peer-wiring
  // reconciles off the uiSettings `peers` array (78f65bd shows the offline row
  // immediately). First up adds the row; a moved wire port updates the url in
  // place; an unchanged url writes nothing. Never duplicates.
  function registerPeer(wirePort) {
    const url = `http://127.0.0.1:${wirePort}`;
    const token = remoteToken();   // the operator secret this peer authenticates with
    const store = getUiSettings();
    const peers = (store.get().peers || []).map((p) => ({ ...p }));
    const existing = peers.find((p) => p && p.id === id);
    if (existing) {
      // Already correct (url AND token) → no write, no reconcile churn.
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

  // Remove THIS box's peer row (delete path, M6b P2) — the symmetric inverse of
  // registerPeer. down() only stops the container (the row stays as the restart
  // affordance); deleting the box drops the row entirely. A no-op (no reconcile
  // churn) when the row is already absent.
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

// ── Manager (M6b P1: own N sandbox instances behind one Map) ──────────────────
//
// Lazily instantiates a createSandbox() per box in the ui-settings `boxes`
// registry, memoizing by id. Every instance shares the injected infra deps
// (spawn, userData, settings, registryDir, syncPeerManager, …) and gets its
// identity + config seam bound to its registry row. A single serialize chain is
// threaded through ALL instances so their bringUp port-probes never race.
//
// The shared box is NOT special-cased beyond its migrated id 'sandbox' (which is
// also get()'s default, so the existing single-box IPC — boxId omitted — resolves
// to it). Box rows: { id, label, config } where config is the DEFAULT_CONFIG shape.
function createSandboxManager(deps = {}) {
  const getUiSettings = deps.getUiSettings;
  const listBoxes = deps.listBoxes
    || (() => { try { return getUiSettings().get().boxes || []; } catch { return []; } });

  // One docker-wide detection cache shared by every box (detect is `docker info`
  // — no per-box state). Warmed once here at launch so the first dialog open /
  // action gate reads a fresh result without a cold spawn; boxes get its get/
  // invalidate as seams so s.detect() returns the stamped payload and a late
  // compose failure invalidates it.
  const managerSpawn = deps.spawn || cp.spawn;
  const now = deps.now || Date.now;
  const detectCache = createDetectCache({ probe: () => probeDocker(managerSpawn), now });
  detectCache.get().catch(() => {});

  const instances = new Map();
  // One promise chain shared by every instance's bringUp — serialized so N boxes
  // coming up together (e.g. autostart) can't read each other's mid-probe ports.
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
      // Shared docker-wide detect cache (every box probes the same daemon).
      detect: () => detectCache.get(),
      invalidateDetect: () => detectCache.invalidate(),
      // Config seam onto this box's row in the registry — read fresh each time so
      // an external settings write (or another instance) is always reflected.
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

  // Resolve a box instance by id (default: the shared box). Memoized; null when no
  // such box exists in the registry so a caller can 404 an unknown id.
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

  // The registry rows, identity only — for autostart iteration and the P2 list UI.
  function list() {
    return listBoxes().map((b) => ({ id: b.id, label: b.label || b.id }));
  }

  // Create a new box row (M6b P2). id is gated to BOX_ID_RE (the compose
  // project-name charset — see the const) and the RESERVED_BOX_IDS set ('host'
  // collides with the placement selector's Mac option — M6b P3), rejected on
  // collision with an existing box (including the shared 'sandbox'). The row starts from DEFAULT_CONFIG; ports
  // stay at the shared defaults on purpose — resolvePorts collision-bumps at Start
  // and the serialize chain keeps concurrent starts from racing the probe, so a
  // second box on the default ports simply bumps off the first. Returns { ok, box }
  // or { ok:false, error }. No container is touched; Start is a separate action.
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

  // Delete a box (M6b P2): stop its container, drop its peer row, and remove its
  // registry row + memoized instance. ANY box is deletable — 'sandbox' has no
  // special status; it's merely the default-created box name, and sanitizeBoxes
  // does NOT reseed a non-empty (or deliberately emptied) registry, so a delete
  // sticks. Docker VOLUMES are intentionally left behind (data-preservation
  // stance, like the restore-failure rule); reclaiming them needs a human
  // `docker volume rm`. Best-effort down: a stop failure doesn't block the
  // registry removal (the row shouldn't outlive the user's intent to delete),
  // but it's surfaced.
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

  // detect/invalidateDetect are docker-wide (not box-scoped) — exposed so a
  // caller can probe/refresh without resolving a box instance.
  return { get, list, create, remove, detect: () => detectCache.get(), invalidateDetect: () => detectCache.invalidate() };
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
  createSandbox, createSandboxManager,
  // Pure parts, exported for the unit suite.
  createDetectCache, dockerUnavailableError,
  resolveImage, resolvePorts, nextFreePort, generateCompose,
  parseOwnPorts, parseOwnPortMap, parsePsRows, parseComposeState, defaultIsPortInUse,
  defaultMountTarget, normalizeMounts, translatePath, relUnder, composeProjectName,
  DEFAULT_CONFIG, DEFAULT_PORTS, CONTAINER_PORTS, RESERVED_MOUNT_TARGETS, WORK_CONTAINER_DIR,
  SANDBOX_PEER_ID, SANDBOX_PEER_LABEL, BOX_ID_RE, RESERVED_BOX_IDS,
};
