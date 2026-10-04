'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REMOTE = 'downloads to a folder need a local session (this one is remote)';
const NAME_MAX = 120;
const CTRL = new RegExp('[\\u0000-\\u001F\\u007F]+', 'g');
const MIME_EXT = {
  'application/pdf': '.pdf',
  'text/html': '.html',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/zip': '.zip',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

function refusal(cwd) {
  return `--to must name a folder inside your working directory (${cwd})`;
}

function scopeCwd(scope) {
  if (!scope || scope.error) {
    const why = (scope && scope.error) || 'Session not found';
    if (why === 'remote') throw new Error(REMOTE);
    throw new Error(`downloads to a folder need a session with a working directory (${why})`);
  }
  return scope.cwd;
}

function inside(root, p) {
  return p === root || p.startsWith(root + path.sep);
}

function nearestExisting(p) {
  let cur = p;
  for (;;) {
    if (fs.existsSync(cur)) return cur;
    const up = path.dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
}

function resolveTo(cwd, to) {
  const deny = () => new Error(refusal(cwd));
  if (typeof to !== 'string' || !to.trim() || to.includes('\0')) throw deny();
  let root;
  try { root = fs.realpathSync(cwd); } catch { throw deny(); }
  const cand = path.resolve(root, to);
  let anc;
  try { anc = fs.realpathSync(nearestExisting(cand)); } catch { throw deny(); }
  if (!inside(root, anc)) throw deny();
  try { fs.mkdirSync(cand, { recursive: true }); } catch { throw deny(); }
  let real;
  try { real = fs.realpathSync(cand); } catch { throw deny(); }
  if (!inside(root, real) || !fs.statSync(real).isDirectory()) throw deny();
  return real;
}

function landedInside(cwd, file) {
  try {
    return inside(fs.realpathSync(cwd), fs.realpathSync(file));
  } catch {
    return false;
  }
}

function extFor(mime) {
  return MIME_EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || '';
}

function sanitizeName(name, mime) {
  let s = String(name == null ? '' : name).replace(CTRL, '');
  s = s.split(/[\\/]/).pop();
  s = s.replace(/[<>:"|?*]/g, '_').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!s) s = 'download';
  if (!path.extname(s)) s += extFor(mime);
  if (s.length > NAME_MAX) {
    const ext = path.extname(s).slice(0, 16);
    s = s.slice(0, NAME_MAX - ext.length).trimEnd() + ext;
  }
  return s;
}

function uniquePath(dir, name, taken = () => false) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p) || taken(p); i++) p = path.join(dir, `${stem}-${i}${ext}`);
  return p;
}

module.exports = { resolveTo, scopeCwd, landedInside, sanitizeName, uniquePath, refusal, inside, REMOTE, NAME_MAX };
