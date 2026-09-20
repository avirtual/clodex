const path = require('path');
const { seatDirFor, seatPathFor, legacySeatPathFor, SEAT_KINDS } = require('./clodex-paths');

const MARKER = '.migrated';

const DEFERRED_KINDS = new Set([]);

const LEGACY_MARKER_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

const LEGACY_MARKER_KINDS = ['notices', 'promptcache', 'spill', 'monitors', 'run'];

function markerPathFor(root) {
  return path.join(root, 'sessions', MARKER);
}

function seatLayoutActive(root, fs = require('fs')) {
  try { return fs.existsSync(markerPathFor(root)); } catch { return false; }
}

function readMarker(root, fs) {
  let raw;
  try { raw = fs.readFileSync(markerPathFor(root), 'utf8'); } catch { return { kinds: {} }; }
  const text = String(raw).trim();
  if (LEGACY_MARKER_RE.test(text)) {
    const kinds = {};
    for (const kind of LEGACY_MARKER_KINDS) kinds[kind] = text;
    return { kinds };
  }
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && obj.kinds && typeof obj.kinds === 'object') {
      const kinds = {};
      for (const [kind, at] of Object.entries(obj.kinds)) {
        if (typeof at === 'string' && at) kinds[kind] = at;
      }
      return { kinds };
    }
  } catch {}
  return { kinds: {} };
}

function writeMarker(root, record, fs) {
  try {
    fs.mkdirSync(path.join(root, 'sessions'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(markerPathFor(root), `${JSON.stringify(record)}\n`);
  } catch {}
}

function pendingKinds(record) {
  return Object.keys(SEAT_KINDS).filter((kind) => !DEFERRED_KINDS.has(kind) && !record.kinds[kind]);
}

function isSymlink(fs, p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function exists(fs, p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

function migrateSeatLayout({ root, names = [], fs = require('fs'), log = null } = {}) {
  const record = readMarker(root, fs);
  const kinds = pendingKinds(record);
  if (!kinds.length) return { migrated: 0, skipped: true };

  const seats = [];
  for (const name of names) {
    try {
      fs.mkdirSync(seatDirFor(root, name), { recursive: true, mode: 0o700 });
      seats.push(name);
    } catch (e) {
      if (log) log.info('seat-layout', `seat '${name}' has no home dir (${e && e.message})`);
    }
  }

  let migrated = 0;
  for (const kind of kinds) {
    for (const name of seats) {
      try {
        const old = legacySeatPathFor(root, name, kind);
        const neu = seatPathFor(root, name, kind);
        if (kind === 'run') {
          if (exists(fs, old) && !isSymlink(fs, old)) fs.rmSync(old, { recursive: true, force: true });
          continue;
        }
        if (isSymlink(fs, old)) continue;
        if (!exists(fs, old)) continue;
        fs.renameSync(old, neu);
        fs.symlinkSync(neu, old);
        migrated++;
      } catch (e) {
        if (log) log.info('seat-layout', `seat '${name}' kind '${kind}' not migrated (${e && e.message})`);
      }
    }
    record.kinds[kind] = new Date().toISOString();
  }

  writeMarker(root, record, fs);
  if (log) log.info('seat-layout', `seat layout: linked ${migrated} dir(s) for ${names.length} known session(s)`);
  return { migrated, skipped: false };
}

function ensureSeatLink({ root, name, kind, fs = require('fs') } = {}) {
  if (!seatLayoutActive(root, fs) || DEFERRED_KINDS.has(kind)) return false;
  const neu = seatPathFor(root, name, kind);
  const old = legacySeatPathFor(root, name, kind);
  try {
    if (exists(fs, old) && !isSymlink(fs, old)) return false;
    fs.mkdirSync(seatDirFor(root, name), { recursive: true, mode: 0o700 });
    fs.mkdirSync(neu, { recursive: true, mode: 0o700 });
    if (exists(fs, old)) return true;
    fs.mkdirSync(path.dirname(old), { recursive: true, mode: 0o700 });
    fs.symlinkSync(neu, old);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  migrateSeatLayout, ensureSeatLink, seatLayoutActive, readMarker,
  MARKER, DEFERRED_KINDS, LEGACY_MARKER_KINDS,
};
