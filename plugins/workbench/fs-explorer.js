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
// Returns { ok, dir (rel), entries:[{ name, rel, type:'dir'|'file', size, mtime }] },
// dirs first then files, alphabetical. `rel` is relative to root ('' = root).
// `size`/`mtime` are null for directories (never stat'd) and for a file whose
// stat failed. Null is "unknown", never 0: 0 is a size an empty file really has,
// so a consumer that defaults one to the other asserts something nobody measured.
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
    let mtime = null;
    if (!isDir) {
      try {
        const st = fs.statSync(path.join(abs, d.name));
        size = st.size;
        mtime = st.mtimeMs;
      } catch {}
    }
    entries.push({ name: d.name, rel: childRel, type: isDir ? 'dir' : 'file', size, mtime });
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

// ── File locator (find-as-you-type) ─────────────────────────────────────────
// Bounds, chosen rather than discovered on a huge repo. A locator that walks an
// enormous tree synchronously per keystroke is worse than no locator, so:
//
//   MAX_VISIT  — hard ceiling on directory entries examined; the walk STOPS
//                there and says so (`truncated: true`) instead of running long.
//   MAX_DEPTH  — depth ceiling, so a pathological tree can't recurse forever.
//   cap        — result cap (default 50), passed by the caller.
//
// NOISE is reused verbatim, so `.git` and `node_modules` are skipped exactly as
// the tree view skips them. Breadth-first on purpose: shallow files are what you
// usually want, and truncation then loses the deepest matches rather than the
// most likely ones. Matching is subsequence ("fuzzy") on the relative path,
// scored so that earlier, tighter, basename-anchored matches sort first.
const MAX_VISIT = 20000;
const MAX_DEPTH = 12;

// Skipped by the LOCATOR ONLY, never by the tree view: build output you did not
// write and would not navigate to by name. Kept separate from NOISE on purpose —
// NOISE is the tree's contract and widening it would silently hide these from
// the explorer too, which is a different (and unasked-for) change. Not read from
// .gitignore: honouring it properly means glob semantics and nested files, and a
// wrong partial implementation hides files the user expects to find.
const LOCATOR_SKIP = new Set(['dist', 'build', 'out', 'coverage', '.next', '.cache', 'web-dist', 'vendor']);

// Subsequence match. Returns a score (lower = better) or -1 for no match.
// Score rewards contiguity and a match that starts in the basename.
function fuzzyScore(hay, needle) {
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  let hi = 0, gaps = 0, first = -1, last = -1;
  for (let ni = 0; ni < n.length; ni++) {
    const found = h.indexOf(n[ni], hi);
    if (found === -1) return -1;
    if (first === -1) first = found;
    if (last !== -1 && found > last + 1) gaps++;
    last = found; hi = found + 1;
  }
  const slash = h.lastIndexOf('/');
  const inBase = first > slash ? 0 : 200; // basename matches win
  return inBase + gaps * 10 + (last - first) + first * 0.1;
}

// Walk `root` breadth-first and return files whose relative path fuzzy-matches
// `query`. Returns { ok, matches:[{ name, rel }], truncated, visited }.
// An empty query returns no matches (the caller shows nothing, not everything).
function findFiles(root, query, { cap = 50 } = {}) {
  const abs = safeResolve(root, '');
  if (!abs) return { ok: false, error: 'Path outside session directory' };
  const q = String(query == null ? '' : query).trim();
  if (!q) return { ok: true, matches: [], truncated: false, visited: 0 };

  const scored = [];
  let visited = 0;
  let truncated = false;
  const queue = [{ dir: abs, rel: '', depth: 0 }];

  while (queue.length) {
    const { dir, rel, depth } = queue.shift();
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; } // unreadable dir: skip, don't fail the whole search
    for (const d of dirents) {
      if (NOISE.has(d.name)) continue;
      if (++visited > MAX_VISIT) { truncated = true; break; }
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (LOCATOR_SKIP.has(d.name)) continue;
        if (depth + 1 <= MAX_DEPTH) queue.push({ dir: path.join(dir, d.name), rel: childRel, depth: depth + 1 });
        continue;
      }
      const score = fuzzyScore(childRel, q);
      if (score >= 0) scored.push({ name: d.name, rel: childRel, score });
    }
    if (truncated) break;
  }

  scored.sort((a, b) => (a.score - b.score) || a.rel.length - b.rel.length || a.rel.localeCompare(b.rel));
  const matches = scored.slice(0, cap).map(({ name, rel }) => ({ name, rel }));
  return { ok: true, matches, truncated: truncated || scored.length > cap, visited };
}

module.exports = { listDir, readFile, writeFile, findFiles, safeResolve, MAX_EDIT_BYTES, MAX_VISIT, MAX_DEPTH, LOCATOR_SKIP };
