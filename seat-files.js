'use strict';

const path = require('node:path');

const SEAT_FILE_MAX = 5;
const SEAT_FILE_MAX_BYTES = 10 * 1024 * 1024;
const SEAT_FILE_STEM_MAX = 64;

const SEAT_FILE_FILE_PATTERN = `file-\\d+-\\d+-[A-Za-z0-9._-]{1,${SEAT_FILE_STEM_MAX}}`;
const SEAT_FILE_NAME_RE = new RegExp(`^file-\\d+-\\d+-([A-Za-z0-9._-]{1,${SEAT_FILE_STEM_MAX}})$`);

function safeFileStem(name) {
  const base = path.posix.basename(String(name == null ? '' : name).replace(/\\/g, '/'));
  const stem = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_').replace(/^\.+/, '').slice(0, SEAT_FILE_STEM_MAX);
  return stem || 'file';
}

function seatFileFileName(stamp, n, name) {
  return `file-${stamp}-${n}-${safeFileStem(name)}`;
}

function seatFileHead(fileName) {
  const m = SEAT_FILE_NAME_RE.exec(String(fileName == null ? '' : fileName));
  return m ? `File: ${m[1]}` : null;
}

function validateSeatFiles(files) {
  if (files === undefined || files === null) return { ok: true, files: [] };
  if (!Array.isArray(files)) return { ok: false, error: 'files must be an array' };
  if (files.length > SEAT_FILE_MAX) return { ok: false, error: `at most ${SEAT_FILE_MAX} files per message` };
  const out = [];
  for (const f of files) {
    if (!f || typeof f !== 'object') return { ok: false, error: 'file must be { name, data }' };
    if (typeof f.name !== 'string' || !f.name || f.name.length > 255) return { ok: false, error: 'file name must be a non-empty string of at most 255 characters' };
    if (typeof f.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) return { ok: false, error: `file data must be base64: ${f.name}` };
    const padding = f.data.endsWith('==') ? 2 : f.data.endsWith('=') ? 1 : 0;
    const size = Math.floor(f.data.length * 3 / 4) - padding;
    if (size <= 0) return { ok: false, error: `empty file: ${f.name}` };
    if (size > SEAT_FILE_MAX_BYTES) return { ok: false, error: `file larger than 10 MB: ${f.name}` };
    out.push({ name: f.name, data: f.data });
  }
  return { ok: true, files: out };
}

module.exports = {
  validateSeatFiles, seatFileFileName, seatFileHead, safeFileStem, SEAT_FILE_FILE_PATTERN,
  SEAT_FILE_MAX, SEAT_FILE_MAX_BYTES,
};
