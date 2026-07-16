// fs-explorer.js — filesystem operations for the file-explorer + editor pane,
// scoped and CONFINED to a session's cwd (root). Every path is resolved and
// checked to stay within root, so the pane can never read/write outside the
// session's directory (defense against `..` traversal — CLAUDE.md boundary rule).
//
// Pure fs; no new dependency. Returns plain { ok, ... } | { ok:false, error }.

const fs = require('fs');
const path = require('path');

const MAX_EDIT_BYTES = 2 * 1024 * 1024; // refuse to open huge files in the editor

// Resolve `rel` against `root` and confirm the result stays inside root. Returns
// the absolute path or null when it would escape (or root is falsy).
function safeResolve(root, rel) {
  if (!root) return null;
  const abs = path.resolve(root, rel || '.');
  const rootResolved = path.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) return null;
  return abs;
}

// Directories that are noise in a tree view; hidden dotfiles are shown but
// these heavy ones are skipped unless the user drills in explicitly.
const NOISE = new Set(['.git', 'node_modules', '.DS_Store']);

// List one directory (non-recursive — the tree lazy-loads children on expand).
// Returns { ok, dir (rel), entries:[{ name, rel, type:'dir'|'file', size }] },
// dirs first then files, alphabetical. `rel` is relative to root ('' = root).
function listDir(root, rel = '') {
  const abs = safeResolve(root, rel);
  if (!abs) return { ok: false, error: 'Path outside session directory' };
  let dirents;
  try { dirents = fs.readdirSync(abs, { withFileTypes: true }); }
  catch (e) { return { ok: false, error: e.message }; }
  const entries = [];
  for (const d of dirents) {
    if (NOISE.has(d.name)) continue;
    const childRel = path.join(rel, d.name);
    const isDir = d.isDirectory();
    let size = null;
    if (!isDir) { try { size = fs.statSync(path.join(abs, d.name)).size; } catch {} }
    entries.push({ name: d.name, rel: childRel, type: isDir ? 'dir' : 'file', size });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { ok: true, dir: rel, entries };
}

// Read a file for the editor. Refuses binaries (NUL sniff) and oversized files.
// Returns { ok, content, rel, eol, size } | { ok:false, error, binary?, tooBig? }.
function readFile(root, rel) {
  const abs = safeResolve(root, rel);
  if (!abs) return { ok: false, error: 'Path outside session directory' };
  let st;
  try { st = fs.statSync(abs); } catch (e) { return { ok: false, error: e.message }; }
  if (st.isDirectory()) return { ok: false, error: 'Is a directory' };
  if (st.size > MAX_EDIT_BYTES) return { ok: false, error: `File too large to edit (${st.size} bytes)`, tooBig: true, size: st.size };
  let buf;
  try { buf = fs.readFileSync(abs); } catch (e) { return { ok: false, error: e.message }; }
  if (buf.subarray(0, 8192).includes(0)) return { ok: false, error: 'Binary file', binary: true, size: st.size };
  const content = buf.toString('utf8');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  return { ok: true, content, rel, eol, size: st.size };
}

// Write a file (overwrite). Confined to root; refuses to write over a directory.
// Creates parent dirs as needed so "new file in a fresh folder" works.
function writeFile(root, rel, content) {
  const abs = safeResolve(root, rel);
  if (!abs) return { ok: false, error: 'Path outside session directory' };
  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return { ok: false, error: 'Is a directory' };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : String(content));
    return { ok: true, size: Buffer.byteLength(content || '') };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { listDir, readFile, writeFile, safeResolve, MAX_EDIT_BYTES };
