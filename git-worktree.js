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

// `code` is the process exit status, and it is not redundant with `ok`: git's
// query commands answer NO by exiting nonzero, so a plain boolean cannot
// separate "git ran and said no" (1) from "git could not answer" (128, ENOENT).
// `isMerged` turns on exactly that distinction. Null when the process never ran
// (spawn failure carries a string errno, not a status).
function git(cwd, args, { maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      resolve({ ok: !err, code, stdout: stdout || '', stderr: stderr || (err && err.message) || '' });
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

  // A worktree whose directory was deleted by hand keeps its admin entry, and git
  // refuses to check the branch out again while that entry stands ("already used
  // by worktree at <gone path>"). Prune first so a removal outside Clodex does not
  // permanently block the branch. Only entries git can no longer resolve to a
  // working tree are dropped, so a live worktree is never touched, and a `locked`
  // one is exempt whatever its state.
  await git(repo, ['worktree', 'prune']);

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
  // The fork point as a SHA, resolved now. A caller counting the branch's own
  // commits later cannot recover it: the ref it forked from (routinely 'HEAD')
  // has moved by then, and counting against a moved base credits the ticket
  // with the base's commits or with none of its own. Best-effort — a null just
  // sends that caller to its merge-base fallback.
  //
  // Only for a branch this call CREATED. An existing branch is checked out at a
  // tip that already carries its own commits, so pinning that as the base would
  // report every later count as zero — exactly the false "wasted worktree".
  let baseSha = null;
  if (!exists) {
    const sha = await git(repo, ['rev-parse', `${baseRef}^{commit}`]);
    baseSha = sha.ok ? (sha.stdout.trim() || null) : null;
  }
  return { ok: true, path: dest, branch: br, base: exists ? null : baseRef, baseSha, repo };
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

// Is `branch` already contained in `base`? The one FACT that makes a ticket
// branch's worktree safe to delete: once it holds, every commit on the branch is
// reachable from the base, so the tree and the branch ref protect nothing.
//
// Three outcomes, never two. `--is-ancestor` reports its answer through the exit
// STATUS — 0 yes, 1 no — and reserves anything else for "I could not tell"
// (unknown ref, no repo, git missing). Collapsing that onto `ok` would read a
// broken repo as a merged branch and delete an unmerged tree, so the unknown
// case is returned as `{ ok: false }` and every caller must treat it as NOT
// merged. Never infer merged from a failed check.
//
// Both refs are verified first so a typo or a deleted branch lands in the
// unknown arm with a legible error rather than as a bare exit 128.
//
// `base` defaults to the MAIN checkout's current HEAD branch — deliberately the
// branch the operator is actually merging into, not `defaultBranch()`, whose
// origin/HEAD preference would answer about a ref this repo may never merge to.
async function isMerged(cwd, branch, base = null) {
  const repo = await repoToplevel(cwd);
  if (!repo) return { ok: false, error: 'not a git repository' };
  if (!branch) return { ok: false, error: 'no branch given' };
  let against = base && String(base).trim() ? String(base).trim() : null;
  if (!against) {
    const cur = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const name = cur.ok && cur.stdout.trim();
    if (!name || name === 'HEAD') return { ok: false, error: 'no base ref (main checkout is detached)' };
    against = name;
  }
  for (const ref of [branch, against]) {
    const v = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (!v.ok) return { ok: false, base: against, error: `ref does not resolve: ${ref}` };
  }
  const r = await git(repo, ['merge-base', '--is-ancestor', branch, against]);
  if (r.code === 0) return { ok: true, merged: true, base: against };
  if (r.code === 1) return { ok: true, merged: false, base: against };
  return { ok: false, base: against, error: (r.stderr || `merge-base exited ${r.code}`).trim() };
}

// Delete a branch ref. `-d`, never `-D`: git's own merged-check is a second,
// independent gate behind the caller's, and the two disagreeing means the
// caller's premise was wrong — exactly when refusing beats forcing. A refusal
// comes back as `{ ok:false, error }` and the branch survives.
async function deleteBranch(cwd, branch) {
  const repo = await repoToplevel(cwd);
  if (!repo) return { ok: false, error: 'not a git repository' };
  if (!branch) return { ok: false, error: 'no branch given' };
  const r = await git(repo, ['branch', '-d', branch]);
  if (!r.ok) return { ok: false, error: (r.stderr || 'git branch -d failed').trim() };
  return { ok: true };
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

// Does this worktree hold work that removing it would destroy? `--porcelain`
// covers modified, staged and UNTRACKED files; untracked matters most here,
// because a seat that wrote a report or a scratch design and never `git add`ed
// it is the exact case an operator would call "my work", and `git worktree
// remove --force` deletes it with everything else.
//
// UNKNOWN, not clean, when git can't answer: `{ ok: false }` must never be read
// as "nothing to lose" — the caller's fail-safe direction is to keep the tree.
// Committed work is deliberately NOT counted: it survives on the branch.
//
// The deliberate boundary: `--porcelain` honors .gitignore, so a seat whose only
// output went to an ignored path (node_modules, a build dir, a scratch file the
// repo excludes) reads CLEAN and its tree is force-removed. That is the intended
// trade — a repo declares ignored paths disposable, and counting them would make
// every seat in a repo with a build dir permanently undiscardable — but it means
// this answers "is there work git would track", not "is this directory empty".
async function isDirty(worktreePath) {
  const wt = worktreePath && path.resolve(String(worktreePath));
  if (!wt) return { ok: false, error: 'No worktree path given' };
  const r = await git(wt, ['status', '--porcelain']);
  if (!r.ok) return { ok: false, error: (r.stderr || 'git status failed').trim() };
  return { ok: true, dirty: r.stdout.trim().length > 0 };
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
// detached, locked, prunable }]. The first block is always the main working tree.
function parseWorktreeList(out) {
  const blocks = String(out).split(/\n\n+/).filter(Boolean);
  return blocks.map((block) => {
    const rec = { path: null, branch: null, head: null, bare: false, detached: false, locked: false, prunable: false };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) rec.path = line.slice('worktree '.length);
      else if (line.startsWith('branch ')) rec.branch = line.slice('branch '.length);
      else if (line.startsWith('HEAD ')) rec.head = line.slice('HEAD '.length);
      else if (line === 'bare') rec.bare = true;
      else if (line === 'detached') rec.detached = true;
      else if (line.startsWith('locked')) rec.locked = true;
      // A worktree whose DIRECTORY is gone stays registered until someone prunes,
      // and is otherwise indistinguishable from a live one in this output. A
      // caller deciding whether a recorded tree can still be used has no other
      // signal — an existence check on the path is a race and misses a dir that
      // exists but no longer holds the worktree.
      else if (line.startsWith('prunable')) rec.prunable = true;
    }
    return rec;
  });
}

// List the worktrees of the repo containing `cwd`, for the management pane.
// Returns { ok, repo, worktrees:[{ path, branch, head, isMain, detached,
// locked, prunable }] } — isMain flags the primary checkout (first entry),
// prunable that the directory is gone. branch is the short name (refs/heads/x →
// x). Never throws.
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
    prunable: e.prunable,
  }));
  return { ok: true, repo, worktrees };
}

// Commits a ticket branch added on top of its base — waste counter (a) of
// DESIGN.md §7.3 reads this to find worktrees minted for tickets that closed
// having produced nothing.
//
// `base..branch` counts commits reachable from the branch and NOT from the
// base, so base-side movement while the ticket was open cannot inflate it; an
// explicit merge-base step would compute the same number for one more git call.
//
// count 0 with ok:true is the ANSWER, not a failure — the zero-commit case is
// exactly what the counter grades, so a caller must not read falsy as unknown.
// Unknown is `ok:false` / a null count.
//
// The base is never the raw `HEAD` ref, which is what makes this readable at
// all. `HEAD` is whatever branch the main checkout happens to sit on when the
// ticket closes, and it flips the answer BOTH ways: a branch already merged
// into HEAD counts 0 (the counter accuses the tickets that shipped), and a HEAD
// parked on an unrelated branch counts every commit on the ticket's side of the
// fork as work (the leak detector reports clean). So: the mint-time SHA when the
// record carries one, else the merge base against the repo's default branch,
// else unknown. `base` in the result names which was used.
//
// The merge-base path is only as stable as `defaultBranch()`, whose last resort
// IS the current branch of the main checkout — so a repo with no origin/HEAD and
// no main/master degrades to exactly the moving base described above. The
// recorded `base` is what makes that case auditable rather than silent.
async function commitsOnBranch(cwd, branch, base = null) {
  const repo = await repoToplevel(cwd);
  if (!repo || !branch) return { ok: false, count: null, error: 'no repo or branch' };
  let against = base && String(base).trim() ? String(base).trim() : null;
  if (against && !(await git(repo, ['rev-parse', '--verify', '--quiet', `${against}^{commit}`])).ok) {
    against = null;   // a mint-time SHA can be gone (rebased, gc'd) — fall through
  }
  if (!against) {
    const def = await defaultBranch(repo);
    if (!def) return { ok: false, count: null, error: 'no base and no default branch' };
    const mb = await git(repo, ['merge-base', def, branch]);
    if (!mb.ok || !mb.stdout.trim()) {
      return { ok: false, count: null, error: (mb.stderr || 'no merge base').trim() };
    }
    against = mb.stdout.trim();
  }
  const r = await git(repo, ['rev-list', '--count', `${against}..${branch}`]);
  if (!r.ok) return { ok: false, count: null, error: (r.stderr || 'rev-list failed').trim() };
  const n = parseInt(r.stdout.trim(), 10);
  if (!Number.isFinite(n)) return { ok: false, count: null, error: 'unparsable count' };
  return { ok: true, count: n, base: against };
}

// The diff a cold reviewer actually reads, as text.
//
// `--text` is not style and must not be dropped: a single NUL byte anywhere in
// a changed file makes git print "Binary files a/x and b/x differ" instead of
// the hunks, and a reviewer handed that reviews nothing while truthfully
// reporting that it read the diff. Forcing text yields a readable (if noisy)
// diff in that case, which a reviewer can see is noisy.
//
// `--no-ext-diff` is the SAME failure through a different door, and is likewise
// not optional. An external driver — `GIT_EXTERNAL_DIFF`, or a `.gitattributes`
// `diff=<name>` on one path — replaces git's output with the driver's, so the
// diff arrives with no hunks and, for a per-path driver, no `diff --git` header
// for exactly the file the driver covers. A cold reviewer handed that reviews
// nothing while truthfully reporting it read the diff; a caller parsing the
// headers silently reads the covered file as absent. Neither is detectable
// downstream, which is why it is refused HERE rather than guarded at each
// caller. Measured (git 2.52.0): a per-path driver yields 1 header where 2 are
// due, and a global one yields 0.
//
// The flag is ancient and carries no version risk. `--default-prefix` is
// deliberately NOT added beside it: it needs git >= 2.41 and ERRORS on older
// git, turning every caller's result into `ok:false` — a hard failure traded
// for a parsing residual whose error direction is already safe.
//
// A LARGER maxBuffer than git()'s default, because the failure is silent in the
// same way: execFile kills the child on overflow and the diff comes back
// truncated at a hunk boundary that looks like a legitimate end of diff.
// `ok:false` on overflow is the point — a partial diff must never be written as
// if it were whole.
//
// Both refs are verified before the diff so a gone base SHA (rebased, gc'd)
// lands as a legible error rather than git's bare exit 128.
async function diffText(cwd, base, head, { maxBuffer = 32 * 1024 * 1024 } = {}) {
  const repo = await repoToplevel(cwd);
  if (!repo) return { ok: false, text: null, error: 'not a git repository' };
  if (!base || !head) return { ok: false, text: null, error: 'no base or head given' };
  for (const ref of [base, head]) {
    const v = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (!v.ok) return { ok: false, text: null, error: `ref does not resolve: ${ref}` };
  }
  const r = await git(repo, ['diff', '--text', '--no-ext-diff', `${base}..${head}`], { maxBuffer });
  if (!r.ok) return { ok: false, text: null, error: (r.stderr || 'git diff failed').trim() };
  return { ok: true, text: r.stdout };
}

// Which branch the checkout at `cwd` is actually ON, and its HEAD sha.
//
// NOT `defaultBranch()`, which answers what the repo's mainline is CALLED — a
// caller about to write to this checkout needs to know where the write would
// land, and those two disagree exactly when it matters (a checkout parked on a
// feature branch, or detached mid-rebase). A detached HEAD is `ok:false`, never
// a branch named "HEAD".
async function currentBranch(cwd) {
  const repo = await repoToplevel(cwd);
  if (!repo) return { ok: false, branch: null, head: null, error: 'not a git repository' };
  const r = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = r.ok ? r.stdout.trim() : '';
  if (!name || name === 'HEAD') {
    return { ok: false, branch: null, head: null, error: (r.stderr || 'the checkout is detached').trim() };
  }
  const h = await git(repo, ['rev-parse', 'HEAD']);
  return { ok: true, branch: name, head: h.ok ? h.stdout.trim() : null, repo };
}

// Merge `branch` into whatever the checkout at `cwd` has checked out, always
// with a merge commit, message read from `messageFile`.
//
// `--no-edit` as well as `-F`: without it a git configured with an editor
// blocks forever inside a spawned process nobody can type into.
//
// A FAILED merge leaves the index and the worktree mid-conflict, and this
// checkout is the one every other seat's branch is cut from — a wedged shared
// tree costs more than the merge was worth. So a failure aborts back to the
// pre-merge state and reports whether that abort itself succeeded; the conflict
// text is already captured in `error`, so nothing diagnostic is lost by
// restoring the tree.
//
// `aborted` and `wedged` are NOT complements, and the caller must report off
// `wedged`. `git merge --abort` also fails when there was never a merge to
// abort — an unresolvable ref, an unreadable message file — so `aborted:false`
// alone would announce "the checkout is left mid-merge and needs a human"
// about a tree git never touched, a false alarm in the one message whose whole
// job is to be trusted. `wedged` is evidence: MERGE_HEAD exists only while a
// merge is actually in progress.
//
// `sha` is the NEW HEAD and `moved` says whether HEAD actually changed. Both
// are needed because `--no-ff` on an already-merged branch prints "Already up
// to date", exits 0, and creates NO commit — reading `ok` alone would report a
// merge that never happened.
async function mergeNoFf(cwd, branch, messageFile) {
  const repo = await repoToplevel(cwd);
  if (!repo) return { ok: false, sha: null, moved: false, error: 'not a git repository' };
  if (!branch) return { ok: false, sha: null, moved: false, error: 'no branch given' };
  if (!messageFile) return { ok: false, sha: null, moved: false, error: 'no message file given' };
  const before = await git(repo, ['rev-parse', 'HEAD']);
  const headBefore = before.ok ? before.stdout.trim() : null;
  const r = await git(repo, ['merge', '--no-ff', '--no-edit', '-F', String(messageFile), branch]);
  if (!r.ok) {
    const output = `${r.stdout || ''}${r.stderr || ''}`.trim() || `git merge exited ${r.code}`;
    const ab = await git(repo, ['merge', '--abort']);
    // Asked of git, after the abort: a merge that never STARTED leaves no
    // MERGE_HEAD, and neither does one the abort successfully undid. Only a
    // genuinely half-applied merge does.
    const mh = await git(repo, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    const wedged = mh.ok && !!mh.stdout.trim();
    return {
      ok: false, sha: null, moved: false, aborted: ab.ok, wedged, headBefore,
      error: wedged
        ? `${output}\n(and \`git merge --abort\` also failed: ${(ab.stderr || ab.stdout || '').trim() || `exit ${ab.code}`} — the checkout is left mid-merge)`
        : output,
    };
  }
  const after = await git(repo, ['rev-parse', 'HEAD']);
  const sha = after.ok ? after.stdout.trim() : null;
  return {
    ok: true, sha, headBefore, moved: !!(sha && headBefore && sha !== headBefore),
    output: `${r.stdout || ''}${r.stderr || ''}`.trim(),
  };
}

// Undo a MERGE commit. `-m 1` is not optional and not a default: git refuses to
// revert a merge without a mainline, so omitting it turns the undo into an
// error at exactly the moment the tree is broken and the undo is the only way
// back. 1 is the first parent — the branch that was merged INTO.
async function revertCommit(cwd, sha) {
  const repo = await repoToplevel(cwd);
  if (!repo) return { ok: false, error: 'not a git repository' };
  if (!sha) return { ok: false, error: 'no commit given' };
  const r = await git(repo, ['revert', '--no-edit', '-m', '1', sha]);
  if (!r.ok) {
    const output = `${r.stdout || ''}${r.stderr || ''}`.trim() || `git revert exited ${r.code}`;
    // Same argument as mergeNoFf's abort: a half-applied revert leaves the
    // shared checkout conflicted, which is worse than the state it was undoing.
    const ab = await git(repo, ['revert', '--abort']);
    return { ok: false, aborted: ab.ok, error: output };
  }
  const after = await git(repo, ['rev-parse', 'HEAD']);
  return { ok: true, sha: after.ok ? after.stdout.trim() : null };
}

module.exports = {
  repoToplevel, createWorktree, removeWorktree, isDirty, defaultWorktreePath,
  defaultBranch, repoInfo, listWorktrees, commitsOnBranch, isMerged, deleteBranch,
  diffText, currentBranch, mergeNoFf, revertCommit,
};
