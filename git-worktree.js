// git-worktree.js — opt-in per-session git worktrees. A session can spawn in a
// fresh `git worktree add`ed directory on its own branch, giving an agent an
// isolated working tree off the same repo without touching the operator's
// checkout. Creation happens at spawn (New Session dialog → session:create);
// removal is offered when the session is killed.
//
// All git runs via execFile (never a shell) with the repo as -C cwd, mirroring
// engine.js fetchFileDiff. No new dependency.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

function git(cwd, args, { maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || (err && err.message) || '' });
    });
  });
}

// Resolve the top-level working directory of the repo that `cwd` lives in, or
// null when `cwd` isn't inside a git work tree. `git worktree add` must be run
// from (or -C'd into) a repo, and the toplevel is the stable anchor for it.
async function repoToplevel(cwd) {
  if (!cwd) return null;
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!r.ok) return null;
  const top = r.stdout.trim();
  return top || null;
}

// A safe default sibling location for a new worktree: <repo>/../<repo>-<branch>.
// Branch slashes (feature/x) become dashes so the path stays a single segment.
function defaultWorktreePath(repoTop, branch) {
  const repoName = path.basename(repoTop);
  const safeBranch = String(branch).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'wt';
  return path.join(path.dirname(repoTop), `${repoName}-${safeBranch}`);
}

// Create a worktree for `branch` off the repo containing `cwd`. If `branch`
// already exists it's checked out; otherwise a new branch is created (-b) from
// Returns { ok, path, branch, base, repo } or { ok:false, error }.
// `opts.base` is the ref the NEW branch forks from (default: the repo's default
// branch, else current HEAD); ignored when `branch` already exists (git checks
// out the existing branch as-is). `opts.targetPath` is optional; when omitted a
// sibling default is chosen and, if it already exists, disambiguated with a
// numeric suffix. (Legacy positional targetPath still accepted for callers that
// passed a string.)
async function createWorktree(cwd, branch, opts = null) {
  const { base = null, targetPath = null } = typeof opts === 'string' ? { targetPath: opts } : (opts || {});
  const repo = await repoToplevel(cwd);
  if (!repo) return { ok: false, error: `Not inside a git repository: ${cwd || '(none)'}` };
  const br = String(branch || '').trim();
  if (!br) return { ok: false, error: 'Branch name is required for a worktree' };
  if (!/^[A-Za-z0-9._/-]{1,128}$/.test(br) || br.includes('..')) {
    return { ok: false, error: `Invalid branch name: ${br}` };
  }

  // Does the branch already exist locally? (verify quietly, no output.)
  const exists = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${br}`])).ok;

  // Base ref for a NEW branch. Validate it resolves so a typo fails loud here
  // rather than as an opaque `git worktree add` error. A local branch, a remote
  // tracking ref (origin/main), a tag, or a SHA are all fine.
  let baseRef = null;
  if (!exists) {
    const wantBase = base && String(base).trim();
    baseRef = wantBase || (await defaultBranch(repo)) || 'HEAD';
    if (baseRef !== 'HEAD' && !(await git(repo, ['rev-parse', '--verify', '--quiet', baseRef])).ok) {
      return { ok: false, error: `Base ref not found: ${baseRef}` };
    }
  }

  let dest = targetPath && String(targetPath).trim() ? path.resolve(String(targetPath).trim()) : defaultWorktreePath(repo, br);
  // Don't clobber an existing directory — pick the first free -2, -3, … suffix.
  if (fs.existsSync(dest)) {
    let n = 2;
    const base2 = dest;
    while (fs.existsSync(dest) && n < 100) { dest = `${base2}-${n}`; n += 1; }
    if (fs.existsSync(dest)) return { ok: false, error: `Worktree path already exists: ${base2}` };
  }

  // `git worktree add [-b <branch>] <path> [<commit-ish>]`. New branch → -b with
  // the base ref as the start point; existing branch → add at that branch (it
  // must not already be checked out elsewhere).
  const args = exists
    ? ['worktree', 'add', dest, br]
    : ['worktree', 'add', '-b', br, dest, baseRef];
  const r = await git(repo, args);
  if (!r.ok) return { ok: false, error: (r.stderr || 'git worktree add failed').trim() };
  return { ok: true, path: dest, branch: br, base: exists ? null : baseRef, repo };
}

// The repo's default branch. Prefers the remote HEAD (origin/HEAD → origin/main
// or origin/master), falling back to a local main/master, else the current
// branch. Returns a ref string or null. Best-effort, never throws.
async function defaultBranch(repo) {
  // origin/HEAD symbolic ref → "origin/main"
  const sym = await git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (sym.ok && sym.stdout.trim()) return sym.stdout.trim();
  for (const b of ['main', 'master']) {
    if ((await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])).ok) return b;
  }
  const cur = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = cur.ok && cur.stdout.trim();
  return name && name !== 'HEAD' ? name : null;
}

// Repo metadata for the New Session dialog: whether `cwd` is in a git work tree,
// its default branch, and the candidate base refs to offer in the autocomplete
// (local branches ∪ remote tracking branches, default first, deduped). Never
// throws — a non-repo returns { isRepo:false }.
async function repoInfo(cwd) {
  const repo = await repoToplevel(cwd);
  if (!repo) return { isRepo: false, repo: null, defaultBranch: null, branches: [] };
  const def = await defaultBranch(repo);
  const locals = (await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))
    .stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const remotes = (await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']))
    .stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((r) => !r.endsWith('/HEAD'));
  const ordered = [];
  const seen = new Set();
  for (const b of [def, ...locals, ...remotes]) {
    if (b && !seen.has(b)) { seen.add(b); ordered.push(b); }
  }
  return { isRepo: true, repo, defaultBranch: def, branches: ordered };
}

// Remove a worktree. --force covers a dirty tree / lingering handles (the PTY
// is already dead by the time this runs on kill). Best-effort: also prunes the
// admin entry. Returns { ok } or { ok:false, error }. Refuses to remove the
// main working tree (guard: the path must be a registered LINKED worktree).
async function removeWorktree(worktreePath) {
  const wt = worktreePath && path.resolve(String(worktreePath));
  if (!wt) return { ok: false, error: 'No worktree path given' };
  // Anchor git at the worktree itself so we can find its repo, then confirm it's
  // a linked worktree (not the primary checkout) before removing anything.
  const list = await git(wt, ['worktree', 'list', '--porcelain']);
  if (!list.ok) return { ok: false, error: 'Not a git worktree (or git unavailable)' };
  const entries = parseWorktreeList(list.stdout);
  // git prints canonical (realpath'd) paths, while `wt` may still contain a
  // symlinked prefix (e.g. macOS /tmp → /private/tmp). Compare via realpath so
  // the self-match — and thus the main-tree guard below — is reliable.
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const wtReal = real(wt);
  const self = entries.find((e) => e.path && real(e.path) === wtReal);
  if (!self) return { ok: false, error: 'Path is not a registered worktree' };
  if (self.bare || entries.indexOf(self) === 0) {
    return { ok: false, error: 'Refusing to remove the main working tree' };
  }
  const r = await git(wt, ['worktree', 'remove', '--force', wt]);
  if (!r.ok) {
    // A manually-deleted dir leaves a stale admin entry; prune clears it.
    await git(path.dirname(wt), ['worktree', 'prune']).catch(() => {});
    return { ok: false, error: (r.stderr || 'git worktree remove failed').trim() };
  }
  return { ok: true };
}

// Parse `git worktree list --porcelain` into [{ path, branch, bare, head,
// detached, locked }]. The first block is always the main working tree.
function parseWorktreeList(out) {
  const blocks = String(out).split(/\n\n+/).filter(Boolean);
  return blocks.map((block) => {
    const rec = { path: null, branch: null, head: null, bare: false, detached: false, locked: false };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) rec.path = line.slice('worktree '.length);
      else if (line.startsWith('branch ')) rec.branch = line.slice('branch '.length);
      else if (line.startsWith('HEAD ')) rec.head = line.slice('HEAD '.length);
      else if (line === 'bare') rec.bare = true;
      else if (line === 'detached') rec.detached = true;
      else if (line.startsWith('locked')) rec.locked = true;
    }
    return rec;
  });
}

// List the worktrees of the repo containing `cwd`, for the management pane.
// Returns { ok, repo, worktrees:[{ path, branch, head, isMain, detached,
// locked }] } — isMain flags the primary checkout (first entry). branch is the
// short name (refs/heads/x → x). Never throws.
async function listWorktrees(cwd) {
  const repo = await repoToplevel(cwd);
  if (!repo) return { ok: false, error: 'Not inside a git repository', repo: null, worktrees: [] };
  const r = await git(repo, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return { ok: false, error: (r.stderr || 'git worktree list failed').trim(), repo, worktrees: [] };
  const entries = parseWorktreeList(r.stdout);
  const worktrees = entries.map((e, i) => ({
    path: e.path,
    branch: e.branch ? e.branch.replace(/^refs\/heads\//, '') : null,
    head: e.head ? e.head.slice(0, 8) : null,
    isMain: i === 0,
    detached: e.detached,
    locked: e.locked,
  }));
  return { ok: true, repo, worktrees };
}

module.exports = {
  repoToplevel, createWorktree, removeWorktree, defaultWorktreePath,
  defaultBranch, repoInfo, listWorktrees,
};
