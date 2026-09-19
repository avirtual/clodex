const path = require('path');
const { seatDirFor, seatPathFor, legacySeatPathFor, SEAT_KINDS } = require('./clodex-paths');

const MARKER = '.migrated';

function markerPathFor(root) {
  return path.join(root, 'sessions', MARKER);
}

function seatLayoutActive(root, fs = require('fs')) {
  try { return fs.existsSync(markerPathFor(root)); } catch { return false; }
}

function isSymlink(fs, p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function exists(fs, p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

function migrateSeatLayout({ root, names = [], fs = require('fs'), log = null } = {}) {
  if (seatLayoutActive(root, fs)) return { migrated: 0, skipped: true };

  let migrated = 0;
  for (const name of names) {
    try {
      fs.mkdirSync(seatDirFor(root, name), { recursive: true, mode: 0o700 });
    } catch (e) {
      if (log) log.info('seat-layout', `seat '${name}' has no home dir (${e && e.message})`);
      continue;
    }
    for (const kind of Object.keys(SEAT_KINDS)) {
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
  }

  try {
    fs.mkdirSync(path.join(root, 'sessions'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(markerPathFor(root), `${new Date().toISOString()}\n`);
  } catch {}
  if (log) log.info('seat-layout', `seat layout: linked ${migrated} dir(s) for ${names.length} known session(s)`);
  return { migrated, skipped: false };
}

function ensureSeatLink({ root, name, kind, fs = require('fs') } = {}) {
  if (!seatLayoutActive(root, fs)) return false;
  const neu = seatPathFor(root, name, kind);
  const old = legacySeatPathFor(root, name, kind);
  try {
    fs.mkdirSync(seatDirFor(root, name), { recursive: true, mode: 0o700 });
    fs.mkdirSync(neu, { recursive: true, mode: 0o700 });
    if (exists(fs, old)) return isSymlink(fs, old);
    fs.mkdirSync(path.dirname(old), { recursive: true, mode: 0o700 });
    fs.symlinkSync(neu, old);
    return true;
  } catch {
    return false;
  }
}

module.exports = { migrateSeatLayout, ensureSeatLink, seatLayoutActive, MARKER };
