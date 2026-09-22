'use strict';

const REQUIRED_MUSE_FILES = ['auth.json', 'trust.json'];
const DEFAULT_MUSE_SETTINGS = { schema_version: 1 };

function uuidv7(crypto) {
  const b = crypto.randomBytes(16);
  b.writeUIntBE(Date.now(), 0, 6);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isPlainObject(over)) return over;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(out[k], v);
  return out;
}

function exists(fs, p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

function bootstrapSeatConfig(deps, { source, seatDir, settingsMerge = null }) {
  const { fs, path } = deps;
  const museSrc = path.join(source, 'muse');
  for (const f of REQUIRED_MUSE_FILES) {
    if (!exists(fs, path.join(museSrc, f))) {
      throw new Error(`muse is not logged in / has no trust file: ${path.join(museSrc, f)} is missing`);
    }
  }
  fs.rmSync(seatDir, { recursive: true, force: true });
  fs.mkdirSync(seatDir, { recursive: true, mode: 0o700 });
  let entries = [];
  try { entries = fs.readdirSync(source); } catch { entries = []; }
  for (const entry of entries) {
    if (entry === 'muse') continue;
    fs.symlinkSync(path.join(source, entry), path.join(seatDir, entry));
  }
  const museDir = path.join(seatDir, 'muse');
  fs.mkdirSync(museDir, { mode: 0o700 });
  for (const f of REQUIRED_MUSE_FILES) {
    fs.writeFileSync(path.join(museDir, f), fs.readFileSync(path.join(museSrc, f)), { mode: 0o600 });
  }
  let settings = DEFAULT_MUSE_SETTINGS;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(museSrc, 'settings.json'), 'utf-8'));
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  const merged = settingsMerge ? deepMerge(settings, settingsMerge) : settings;
  fs.writeFileSync(path.join(museDir, 'settings.json'), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return { seatDir, museDir };
}

function museDataHome(deps) {
  const { env, os, path } = deps;
  return (env && env.XDG_DATA_HOME) || path.join(os.homedir(), '.local', 'share');
}

function listDir(fs, d) {
  try { return fs.readdirSync(d); } catch { return []; }
}

function findMuseTranscript(deps, dataHome, sid) {
  const { fs, path } = deps;
  const root = path.join(dataHome, 'muse', 'sessions');
  for (const y of listDir(fs, root)) {
    for (const m of listDir(fs, path.join(root, y))) {
      for (const d of listDir(fs, path.join(root, y, m))) {
        const p = path.join(root, y, m, d, sid, 'session.jsonl');
        try { if (fs.statSync(p).isFile()) return p; } catch {}
      }
    }
  }
  return null;
}

function newestMuseTranscript(deps, dataHome, sinceMs, excludePaths) {
  const { fs, path } = deps;
  const root = path.join(dataHome, 'muse', 'sessions');
  const skip = new Set(excludePaths || []);
  let best = null;
  for (const y of listDir(fs, root)) {
    for (const m of listDir(fs, path.join(root, y))) {
      for (const d of listDir(fs, path.join(root, y, m))) {
        for (const sid of listDir(fs, path.join(root, y, m, d))) {
          const p = path.join(root, y, m, d, sid, 'session.jsonl');
          if (skip.has(p)) continue;
          let st;
          try { st = fs.statSync(p); } catch { continue; }
          if (!st.isFile() || st.mtimeMs < sinceMs) continue;
          if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
        }
      }
    }
  }
  return best ? best.path : null;
}

function museRegistryFor(deps, dataHome, pid) {
  const { fs, path } = deps;
  const dir = path.join(dataHome, 'muse', 'runtime', 'muse', 'sessions');
  const hint = `pid=${pid}`;
  let byPid = null;
  for (const n of listDir(fs, dir)) {
    if (!n.endsWith('.json')) continue;
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8')); } catch { continue; }
    if (!isPlainObject(rec)) continue;
    if (rec.process_generation_hint === hint) return rec;
    if (rec.pid === pid && !byPid) byPid = rec;
  }
  return byPid;
}

function linkTranscript(deps, linkPath, target) {
  const { fs } = deps;
  const tmp = `${linkPath}.tmp.${process.pid}`;
  try { fs.unlinkSync(tmp); } catch {}
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, linkPath);
}

module.exports = {
  uuidv7, deepMerge, bootstrapSeatConfig, museDataHome, findMuseTranscript, newestMuseTranscript, museRegistryFor, linkTranscript,
  REQUIRED_MUSE_FILES, DEFAULT_MUSE_SETTINGS,
};
