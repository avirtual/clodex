// Filesystem primitives shared across the main process: directory creation,
// crash-safe writes, and forgiving JSON reads. Pure Node (fs/path) — no
// Electron, no main.js module state — so every JSON store can route its
// durability through one audited choke point and be unit-tested against a
// temp dir.
// Seam: plain named functions taking explicit paths (no injected deps).
// Gotcha: atomicWriteFileSync fsyncs BOTH the temp file and the parent dir —
// the rename only becomes durable once the directory entry is flushed.

const path = require('path');
const fs = require('fs');

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

// Crash-safe file write: same-dir temp → fsync contents → atomic rename →
// fsync the parent dir. A power loss or interrupted write leaves the previous
// file fully intact (rename is atomic on one volume); the fsyncs make the
// bytes — and the rename itself — durable, not just the name swap. All JSON
// stores route through this so a torn write can never truncate a whole store.
function atomicWriteFileSync(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  // fsync the directory so the rename survives a crash, not just the contents.
  let dfd;
  try {
    dfd = fs.openSync(dir, 'r');
    fs.fsyncSync(dfd);
  } catch {} finally {
    if (dfd !== undefined) { try { fs.closeSync(dfd); } catch {} }
  }
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

module.exports = { ensureDir, atomicWriteFileSync, readJsonSafe };
