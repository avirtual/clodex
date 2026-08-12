'use strict';

// project-root.js — the git-repository root for a cwd, for keying a PROJECT
// ticket board when no team owns that cwd (t303). Pure leaf (electron-free);
// `fs` is injectable for tests but defaults to the real module.
//
// Only the SOLO case reaches here. When a team resolves, its `team.root` stays
// the board key byte for byte — see session-manager's `_projectRootFor`, which
// is the single funnel both cases go through. Two derivations of a board key
// drift apart silently, because each looks correct read alone.
//
// A linked worktree resolves to its MAIN checkout, not to itself: the board dir
// is hashed over this string (clodex-paths.projectDirFor), so a worktree that
// answered with its own path would file tickets onto a board the lead never
// reads. That is not a corner case here — every ticket seat works in a worktree.
//
// No GIT_DIR / GIT_WORK_TREE handling, deliberately: nothing Clodex spawns sets
// them, and honouring them would let an env var repoint which board a verb
// writes to.

const nodePath = require('path');

// The `.git` file of a linked worktree points at `<main>/.git/worktrees/<id>`.
// The marker leads with the separator, so slicing to its start yields the main
// checkout with no trailing separator to strip.
const WORKTREE_MARKER = `${nodePath.sep}.git${nodePath.sep}worktrees${nodePath.sep}`;

// The repo root containing `cwd`, or null when it is not inside a git repo.
// Never throws: an unreadable ancestor is a miss, not a crash, because the
// caller's alternative is refusing a verb the operator typed.
function findRepoRoot(cwd, { fs = require('fs'), path = nodePath } = {}) {
  if (!cwd) return null;
  let dir = path.resolve(cwd);
  // Bounded like team-manifest's walk: a symlink cycle must not hang the caller.
  for (let i = 0; i < 64; i++) {
    let st = null;
    try { st = fs.lstatSync(path.join(dir, '.git')); } catch { st = null; }
    if (st) {
      if (st.isDirectory()) return dir;   // main checkout
      // A `.git` FILE is a linked worktree (or a submodule, which has no
      // `worktrees/` segment and so falls through to the walk below).
      let raw = null;
      try { raw = fs.readFileSync(path.join(dir, '.git'), 'utf-8'); } catch { raw = null; }
      const m = raw && /^\s*gitdir:\s*(.+?)\s*$/m.exec(raw);
      if (m) {
        const gitdir = path.resolve(dir, m[1]);
        const at = gitdir.indexOf(WORKTREE_MARKER);
        if (at >= 0) return gitdir.slice(0, at);
      }
    }
    const up = path.dirname(dir);
    if (up === dir) return null;          // filesystem root, no repo
    dir = up;
  }
  return null;
}

module.exports = { findRepoRoot };
