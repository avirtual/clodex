// import.js — seed contexts from the LOCAL machine's Clodex userData (T36b).
// "I shouldn't have to add my own laptop from my laptop." Read-only on the
// GUI's own files; the GUI exports nothing and changes by zero lines.
//
// STANDALONE: never require()s an app file. The env-file parse (env-file.js's
// shape) and the store layouts are reimplemented here from their on-disk
// contract. All reads degrade gracefully — an absent file is an empty
// contribution, never a crash.
//
// NEVER-TUNNEL INVARIANT: an imported entry carries url/ssh + token ONLY, built
// from typed string fields. An argv from any store — even a local one — is a
// code-execution surface; a transport field that isn't a plain string is
// refused, not imported.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CliError, EXIT } = require('./errors');

const DEFAULT_REMOTE_PORT = 7900;
const DEFAULT_SANDBOX_WIRE_PORT = 7820;   // sandbox.js DEFAULT_PORTS.wire
const SANDBOX_TOKEN_KEY = 'CLODEX_REMOTE_TOKEN';

// Parse an env-file (KEY=value lines) into { KEY: value }. Missing/unreadable →
// {}. Reimplements env-file.js:readEnvFile — a line needs a '=' not at index 0;
// value is the raw remainder after the first '='. (Trivial, so we don't couple
// to the app module.)
function parseEnvFile(file) {
  const out = {};
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    const i = t.indexOf('=');
    if (i <= 0) continue;
    out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

// Read + JSON-parse a file, tolerating absence/garbage (→ null).
function readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { return JSON.parse(raw); } catch { return null; }
}

// The platform's default userData parents, for BOTH the packaged (`Clodex`) and
// dev (`clodex`) app names. Order within a platform doesn't matter — the caller
// picks by ui-settings.json mtime when several exist.
function platformDataDirs(env = process.env, platform = process.platform, home = os.homedir()) {
  const names = ['Clodex', 'clodex'];
  if (platform === 'darwin') {
    return names.map((n) => path.join(home, 'Library', 'Application Support', n));
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return names.map((n) => path.join(appData, n));
  }
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return names.map((n) => path.join(xdg, n));
}

// Resolve which userData dir to import from, and report which was chosen + why.
//   --data-dir flag  > CLODEX_DATA_DIR env  > platform defaults (both names).
// When several defaults have a ui-settings.json, the NEWEST mtime wins (dev
// mirrors packaged on a mac dev box; the freshest is the live one). Returns
// { dir, source, note } or throws EXIT.NOTFOUND when nothing usable is found.
function resolveDataDir({ dataDirFlag, env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (dataDirFlag) {
    if (!dirExists(dataDirFlag)) throw new CliError(EXIT.NOTFOUND, `--data-dir not found: ${dataDirFlag}`);
    return { dir: dataDirFlag, source: '--data-dir', note: null };
  }
  if (env.CLODEX_DATA_DIR) {
    if (!dirExists(env.CLODEX_DATA_DIR)) throw new CliError(EXIT.NOTFOUND, `CLODEX_DATA_DIR not found: ${env.CLODEX_DATA_DIR}`);
    return { dir: env.CLODEX_DATA_DIR, source: 'CLODEX_DATA_DIR', note: null };
  }
  const candidates = platformDataDirs(env, platform, home)
    .map((dir) => ({ dir, mtime: uiSettingsMtime(dir) }))
    .filter((c) => c.mtime != null);
  if (candidates.length === 0) {
    throw new CliError(EXIT.NOTFOUND,
      'no Clodex userData found — pass --data-dir DIR or set CLODEX_DATA_DIR (looked for ui-settings.json in the platform defaults for both Clodex and clodex)');
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const note = candidates.length > 1
    ? `${candidates.length} userData dirs had ui-settings.json; picked the newest (${path.basename(candidates[0].dir)})`
    : null;
  return { dir: candidates[0].dir, source: 'platform default', note };
}

function dirExists(d) { try { return fs.statSync(d).isDirectory(); } catch { return false; } }
function uiSettingsMtime(dir) {
  try { return fs.statSync(path.join(dir, 'ui-settings.json')).mtimeMs; } catch { return null; }
}

// Guard the never-tunnel invariant: a transport value must be a non-empty
// plain string. An array (argv-shaped) or object is a code-execution surface
// smuggled through a store — refuse it.
function safeTransport(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Build the candidate context list from a userData dir. Each candidate:
//   { name, entry?, action:'add'|'skip', reason?, tokenState:'set'|'none' }
// `entry` is present only for importable ones (url|ssh + optional token). This
// does NOT consult the existing contexts store — collision handling is applied
// later in applyImport so --dry-run and --json share one shape.
function collectCandidates(dataDir) {
  const out = [];
  const ui = readJson(path.join(dataDir, 'ui-settings.json')) || {};

  // 1) The local engine itself → `local`.
  {
    const remotePort = Number.isInteger(ui.remotePort) ? ui.remotePort : DEFAULT_REMOTE_PORT;
    const token = parseEnvFile(path.join(dataDir, 'remote.env'))[SANDBOX_TOKEN_KEY] || null;
    const reasons = [];
    if (ui.remoteEnabled === false) reasons.push('wire is OFF — flip remote access in Preferences');
    out.push({
      name: 'local',
      entry: { url: `http://127.0.0.1:${remotePort}`, ...(token ? { token } : {}) },
      action: 'add',
      reason: reasons.length ? reasons.join('; ') : null,
      tokenState: token ? 'set' : 'none',
    });
  }

  // 2) Peers → one per label.
  for (const p of Array.isArray(ui.peers) ? ui.peers : []) {
    if (!p || typeof p !== 'object') continue;
    const label = typeof p.label === 'string' && p.label ? p.label : (p.sshHost || p.url || p.id);
    if (!safeTransport(label)) continue;
    if (p.disabled === true) {
      out.push({ name: String(label), action: 'skip', reason: 'peer disabled', tokenState: p.token ? 'set' : 'none' });
      continue;
    }
    const token = typeof p.token === 'string' && p.token ? p.token : null;
    let entry = null;
    if (safeTransport(p.sshHost)) {
      const remotePort = Number.isInteger(p.remotePort) ? p.remotePort : DEFAULT_REMOTE_PORT;
      entry = { ssh: p.sshHost, ...(remotePort !== DEFAULT_REMOTE_PORT ? { remotePort } : {}), ...(token ? { token } : {}) };
    } else if (safeTransport(p.url)) {
      entry = { url: p.url, ...(token ? { token } : {}) };
    } else {
      // Neither a string ssh nor a string url — refuse (never-tunnel guard).
      out.push({ name: String(label), action: 'skip', reason: 'no usable url/ssh transport (refused)', tokenState: token ? 'set' : 'none' });
      continue;
    }
    out.push({ name: String(label), entry, action: 'add', reason: null, tokenState: token ? 'set' : 'none' });
  }

  // 3) Sandboxes → one per box in the registry (the SOLE source of box state;
  // carries each box's own wirePort). subdir = 'sandbox' for id 'sandbox', else
  // 'sandbox-<id>'; token = CLODEX_REMOTE_TOKEN in <subdir>/auth.env.
  for (const box of Array.isArray(ui.boxes) ? ui.boxes : []) {
    if (!box || typeof box !== 'object' || !safeTransport(box.id)) continue;
    const id = box.id;
    const cfg = (box.config && typeof box.config === 'object') ? box.config : {};
    const wirePort = Number.isInteger(cfg.wirePort) ? cfg.wirePort : DEFAULT_SANDBOX_WIRE_PORT;
    const subdir = id === 'sandbox' ? 'sandbox' : `sandbox-${id}`;
    const token = parseEnvFile(path.join(dataDir, subdir, 'auth.env'))[SANDBOX_TOKEN_KEY] || null;
    if (!token) {
      out.push({ name: String(id), action: 'skip', reason: 'no auth.env wire token', tokenState: 'none' });
      continue;
    }
    out.push({
      name: String(id),
      entry: { url: `http://127.0.0.1:${wirePort}`, token },
      action: 'add', reason: null, tokenState: 'set',
    });
  }

  return out;
}

// Apply collected candidates against the existing store. Mutates a COPY of the
// store and returns { store, results }. results mirror candidates but resolve
// add→'added'/'skipped'(exists)/'overwritten' against collisions. `current` is
// never touched. Skipped candidates (disabled/tokenless) pass through as-is.
function applyImport(store, candidates, { force = false } = {}) {
  const next = { current: store.current || null, contexts: { ...(store.contexts || {}) } };
  const results = [];
  for (const c of candidates) {
    if (c.action === 'skip') { results.push({ ...c, result: 'skipped', reason: c.reason }); continue; }
    const exists = Object.prototype.hasOwnProperty.call(next.contexts, c.name);
    if (exists && !force) {
      results.push({ ...c, result: 'skipped', reason: 'exists, skipped — --force to overwrite' });
      continue;
    }
    next.contexts[c.name] = c.entry;
    results.push({ ...c, result: exists ? 'overwritten' : 'added', reason: c.reason || null });
  }
  return { store: next, results };
}

// Render the human report. One line per candidate; token state, never a value.
function renderReport(results, meta) {
  const lines = [];
  lines.push(`userData: ${meta.dir}  (${meta.source})`);
  if (meta.note) lines.push(`note: ${meta.note}`);
  if (meta.dryRun) lines.push('(dry-run — nothing written)');
  for (const r of results) {
    const tok = r.tokenState === 'set' ? 'token set' : 'no token';
    const tail = r.reason ? ` — ${r.reason}` : '';
    lines.push(`  ${r.result.padEnd(11)} ${r.name}  (${tok})${tail}`);
  }
  const added = results.filter((r) => r.result === 'added' || r.result === 'overwritten').length;
  lines.push(`${added} context(s) ${meta.dryRun ? 'would be written' : 'written'}, ${results.length - added} skipped`);
  return lines.join('\n');
}

module.exports = {
  DEFAULT_REMOTE_PORT, DEFAULT_SANDBOX_WIRE_PORT, SANDBOX_TOKEN_KEY,
  parseEnvFile, platformDataDirs, resolveDataDir, collectCandidates,
  applyImport, renderReport, safeTransport,
};
