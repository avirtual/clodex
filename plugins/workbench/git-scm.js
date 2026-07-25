// git-scm.js — source-control operations for the SCM pane, scoped to a session's
// cwd. Everything runs via `git -C <cwd>` through execFile (never a shell),
// mirroring engine.js fetchFileDiff and git-worktree.js. No new dependency.
//
// The pane is a thin view over these; each function returns a plain
// { ok, ... } | { ok:false, error } object so the renderer can render or toast.

const { execFile } = require('child_process');

function git(cwd, args, { maxBuffer = 8 * 1024 * 1024, timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer, timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err && err.code, stdout: stdout || '', stderr: stderr || (err && err.message) || '' });
    });
  });
}

async function isRepo(cwd) {
  if (!cwd) return false;
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout.trim() === 'true';
}

// Parse `git status --porcelain=v1 -z --branch`. Returns the branch header +
// a flat file list with per-file staged/unstaged status codes. The -z form is
// NUL-delimited so paths with spaces/newlines are safe; renames come as two
// NUL fields (new\0old) after an R entry.
function parseStatus(z) {
  const parts = z.split('\0');
  let branch = null, upstream = null, ahead = 0, behind = 0;
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('##')) {
      // ## branch...upstream [ahead N, behind M]
      const body = line.slice(2).trim();
      const m = body.match(/^(.+?)(?:\.\.\.(.+?))?(?:\s+\[(.+)\])?$/);
      if (m) {
        branch = m[1] === 'HEAD (no branch)' ? null : m[1];
        upstream = m[2] || null;
        if (m[3]) {
          const a = m[3].match(/ahead (\d+)/); if (a) ahead = Number(a[1]);
          const b = m[3].match(/behind (\d+)/); if (b) behind = Number(b[1]);
        }
      }
      continue;
    }
    // XY<space>path  (XY = two status chars: staged, unstaged)
    const x = line[0], y = line[1];
    let filePath = line.slice(3);
    if (x === 'R' || x === 'C') {
      // Rename/copy: the NEXT NUL field is the old path.
      const oldPath = parts[i + 1] || '';
      i += 1;
      files.push({ path: filePath, oldPath, x, y, staged: x !== ' ' && x !== '?', untracked: false });
      continue;
    }
    const untracked = x === '?' && y === '?';
    files.push({ path: filePath, x, y, untracked, staged: !untracked && x !== ' ' });
  }
  return { branch, upstream, ahead, behind, files };
}

async function status(cwd) {
  if (!(await isRepo(cwd))) return { ok: false, error: 'Not a git repository', isRepo: false };
  const r = await git(cwd, ['status', '--porcelain=v1', '-z', '--branch']);
  if (!r.ok) return { ok: false, error: (r.stderr || 'git status failed').trim(), isRepo: true };
  return { ok: true, isRepo: true, ...parseStatus(r.stdout) };
}

// Diff for one file. staged=true → the index-vs-HEAD diff (what a commit would
// capture); else the working-tree-vs-index diff. Untracked files have no diff —
// the caller shows the file contents instead.
async function fileDiff(cwd, filePath, { staged = false } = {}) {
  const args = ['diff', '--no-color'];
  if (staged) args.push('--cached');
  args.push('--', filePath);
  const r = await git(cwd, args);
  if (!r.ok) return { ok: false, error: (r.stderr || 'git diff failed').trim() };
  return { ok: true, diff: r.stdout };
}

async function stage(cwd, paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) return { ok: false, error: 'No paths' };
  const r = await git(cwd, ['add', '--', ...list]);
  return r.ok ? { ok: true } : { ok: false, error: (r.stderr || 'git add failed').trim() };
}

async function unstage(cwd, paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) return { ok: false, error: 'No paths' };
  // `git restore --staged` is the modern reset-index; falls back to reset for
  // older gits. Either way this only touches the index, never the work tree.
  let r = await git(cwd, ['restore', '--staged', '--', ...list]);
  if (!r.ok) r = await git(cwd, ['reset', '-q', 'HEAD', '--', ...list]);
  return r.ok ? { ok: true } : { ok: false, error: (r.stderr || 'git unstage failed').trim() };
}

// Discard working-tree changes for a file (destructive). Untracked files are
// removed; tracked files are restored to the index/HEAD. The caller MUST confirm
// with the user first — this is not undoable.
async function discard(cwd, filePath, { untracked = false } = {}) {
  if (!filePath) return { ok: false, error: 'No path' };
  if (untracked) {
    const r = await git(cwd, ['clean', '-f', '--', filePath]);
    return r.ok ? { ok: true } : { ok: false, error: (r.stderr || 'git clean failed').trim() };
  }
  let r = await git(cwd, ['restore', '--', filePath]);
  if (!r.ok) r = await git(cwd, ['checkout', '--', filePath]);
  return r.ok ? { ok: true } : { ok: false, error: (r.stderr || 'git restore failed').trim() };
}

// Commit the staged index with `message`. amend replaces the last commit.
// Refuses an empty message and (unless amend) an empty index.
async function commit(cwd, message, { amend = false } = {}) {
  const msg = String(message || '').trim();
  if (!msg && !amend) return { ok: false, error: 'Commit message is required' };
  const args = ['commit', '-m', msg || '(amend)'];
  if (amend) args.push('--amend');
  const r = await git(cwd, args);
  if (!r.ok) {
    const out = `${r.stdout}\n${r.stderr}`.trim();
    return { ok: false, error: out || 'git commit failed' };
  }
  return { ok: true, output: r.stdout.trim() };
}

async function branches(cwd) {
  const cur = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const list = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const remotes = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
  return {
    ok: true,
    current: cur.ok ? cur.stdout.trim() : null,
    local: list.ok ? list.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [],
    remote: remotes.ok ? remotes.stdout.split('\n').map((s) => s.trim()).filter(Boolean).filter((r) => !r.endsWith('/HEAD')) : [],
  };
}

async function checkout(cwd, branch, { create = false } = {}) {
  const br = String(branch || '').trim();
  if (!br) return { ok: false, error: 'Branch name required' };
  const args = create ? ['checkout', '-b', br] : ['checkout', br];
  const r = await git(cwd, args);
  return r.ok ? { ok: true } : { ok: false, error: (r.stderr || 'git checkout failed').trim() };
}

// push / pull / fetch. These are network ops — longer timeout, and their combined
// stdout+stderr is returned as `output` so the pane can surface progress/errors.
async function remoteOp(cwd, op) {
  const args = op === 'push' ? ['push'] : op === 'pull' ? ['pull', '--ff-only'] : ['fetch', '--all'];
  const r = await git(cwd, args, { timeout: 120000 });
  const output = `${r.stdout}\n${r.stderr}`.trim();
  return r.ok ? { ok: true, output } : { ok: false, error: output || `git ${op} failed` };
}

module.exports = {
  isRepo, status, fileDiff, stage, unstage, discard, commit,
  branches, checkout, remoteOp, parseStatus,
};
