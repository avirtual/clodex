// file-edit.js — the write-side policy for the file-peek Edit tab. Pure leaf
// (like path-confine / clodex-paths): no electron, no I/O of its own, fs access
// injected so the policy is unit-testable. NOT in the leak-scanner SCANNED
// lists, same reason those aren't.
//
// The peek is the only read surface in Clodex that takes a bare absolute path
// (`fetchFilePeek`), because reading bytes into a modal is not an authority.
// Writing is, so this half does NOT inherit that freedom: every write resolves
// against the session's cwd and must land inside it, which is the same boundary
// the workbench plugin's editor enforces — with realpath rather than a lexical
// prefix test, so a symlink inside the cwd pointing out is refused rather than
// followed.
//
// The two preconditions that exist to prevent DATA LOSS rather than escape:
//
//   truncation — the peek reads at most PEEK_MAX_BYTES. Saving a textarea that
//     holds a truncated view would write the head and delete everything past
//     the cap. Refused at the engine, not only by a disabled tab.
//   mtime      — the content the user edited came from a specific read. If the
//     file moved under them (the agent is still working in it, which is the
//     normal case here), a blind overwrite silently discards the agent's edit.

const PEEK_MAX_BYTES = 512 * 1024;

// Returns { ok, path } — the realpath to write — or { ok:false, error }.
// `readHead` returns a Buffer of the file's first bytes (NUL sniff); it is
// separate from `stat` because a caller that already refused on size should not
// pay a read.
function vetFileWrite({ filePath, cwd, content, expectMtime, resolve, realpath, stat, readHead }) {
  if (typeof content !== 'string') return { ok: false, error: 'Content must be a string' };
  if (!cwd) return { ok: false, error: 'Session has no working directory' };
  const trimmed = (filePath || '').trim();
  if (!trimmed) return { ok: false, error: 'Missing path' };

  let root;
  try { root = realpath(cwd); } catch { return { ok: false, error: 'Session directory is unavailable' }; }

  let real, st;
  // No creation: the Edit tab edits a file the peek just showed. A missing file
  // is a bug in the caller, not a new-file affordance.
  try { real = realpath(resolve(cwd, trimmed)); st = stat(real); }
  catch { return { ok: false, error: `No such file: ${trimmed}` }; }

  if (real !== root && !real.startsWith(root + '/')) {
    return { ok: false, error: 'Refusing to write outside the session directory' };
  }
  if (!st.isFile()) return { ok: false, error: 'Not a regular file' };
  if (st.size > PEEK_MAX_BYTES) {
    return { ok: false, error: `File is larger than the ${PEEK_MAX_BYTES / 1024}KB peek limit — edit it in a real editor` };
  }
  if (expectMtime != null && st.mtimeMs !== expectMtime) {
    return { ok: false, error: 'File changed on disk since it was opened — reopen it to see the current bytes' };
  }
  let head;
  try { head = readHead(real); } catch { return { ok: false, error: 'Unreadable' }; }
  if (head && head.includes(0)) return { ok: false, error: 'Binary file' };

  return { ok: true, path: real };
}

module.exports = { vetFileWrite, PEEK_MAX_BYTES };
