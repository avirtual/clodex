'use strict';
// plugins/workbench/engine.js — the workbench pilot's ENGINE half
// (docs/plugin-plan.md §4, steps W1-W6).
//
// Fifteen data rows, one per fs:/scm:/worktree: IPC handler the workbench used
// to reach through window.api. Every filesystem-touching one's FIRST line is
// `host.sessions.fsScope(name)` (MUST-FIX 5) — the locality refusal, including
// the exact `'remote'` error string the renderer half renders as the remote
// notice, is a HOST guarantee, not this plugin's code to get right. A buggy or
// careless plugin therefore cannot widen locality.
//
// W2 registers these against `host.lib.gitScm` / `host.lib.fsExplorer`, which
// are TEMPORARY host entries: git-scm.js and fs-explorer.js are still at the
// core root, where the no-backdoor lint forbids requiring them from here. W5
// moves both files INTO this directory and switches these two references to a
// local `require('./git-scm')` / `require('./fs-explorer')`, at which point
// those host.lib entries are deleted. `host.lib.gitWorktree` is PERMANENT —
// git-worktree.js stays core (the New-Session dialog and the delete flow use it).
//
// Electron-free by contract (test/electron-boundary.test.js walks this file) and
// backdoor-free (test/plugin-boundary.test.js: only node builtins and requires
// that stay inside this directory — core is reachable ONLY through `host`).

module.exports.activate = (host) => {
  const { gitScm, fsExplorer, gitWorktree } = host.lib;

  // The MUST-FIX 5 wrapper. Every row built with this resolves the session's cwd
  // through the host and refuses peers before the handler body ever runs; the
  // envelope shape ({ ok:false, error }) reproduces ipc-handlers' verbatim, so
  // the renderer's existing "remote" branches keep matching.
  const scoped = (fn) => async (name, ...rest) => {
    const r = host.sessions.fsScope(name);
    if (r.error) return { ok: false, error: r.error };
    return fn(r.cwd, ...rest);
  };

  // ── File explorer + editor (fs-explorer.js). Confined to the session cwd. ──
  host.ipc.handle('fs.list', scoped((cwd, rel) => fsExplorer.listDir(cwd, rel || '')));
  host.ipc.handle('fs.read', scoped((cwd, rel) => fsExplorer.readFile(cwd, rel)));
  host.ipc.handle('fs.write', scoped((cwd, rel, content) => fsExplorer.writeFile(cwd, rel, content)));

  // ── Source control (git-scm.js). ──
  host.ipc.handle('scm.status', scoped((cwd) => gitScm.status(cwd)));
  host.ipc.handle('scm.diff', scoped((cwd, filePath, opts) => gitScm.fileDiff(cwd, filePath, opts || {})));
  host.ipc.handle('scm.stage', scoped((cwd, paths) => gitScm.stage(cwd, paths)));
  host.ipc.handle('scm.unstage', scoped((cwd, paths) => gitScm.unstage(cwd, paths)));
  host.ipc.handle('scm.discard', scoped((cwd, filePath, opts) => gitScm.discard(cwd, filePath, opts || {})));
  host.ipc.handle('scm.commit', scoped((cwd, message, opts) => gitScm.commit(cwd, message, opts || {})));
  host.ipc.handle('scm.branches', scoped((cwd) => gitScm.branches(cwd)));
  host.ipc.handle('scm.checkout', scoped((cwd, branch, opts) => gitScm.checkout(cwd, branch, opts || {})));
  host.ipc.handle('scm.remote', scoped((cwd, op) => {
    // The op allowlist stays where it was — in the row, not in the renderer.
    if (!['push', 'pull', 'fetch'].includes(op)) return { ok: false, error: 'Bad op' };
    return gitScm.remoteOp(cwd, op);
  }));

  // ── Worktrees (host.lib.gitWorktree — core's leaf, permanently). ──
  host.ipc.handle('wt.list', scoped((cwd) => gitWorktree.listWorktrees(cwd)));
  // NOT scoped: this takes a worktree PATH, not a session name, exactly as
  // core's `worktree:remove` does [ipc-handlers.js:370] — which likewise has no
  // sessionCwd guard, because the path comes from a wt.list result the user just
  // clicked. Reproduced rather than "improved" so the move is behavior-neutral.
  host.ipc.handle('wt.remove', (worktreePath) => gitWorktree.removeWorktree(worktreePath));
  // The workbench's own "Create Worktree" button. Core's `worktree:create` row
  // stays for the New-Session dialog that owns it; this is the plugin's own path
  // to the same leaf, so no new renderer-side surface has to be invented for one
  // button. Takes a repo path (from a wt.list result), like core's row does.
  host.ipc.handle('wt.create', (repo, branch, opts) => gitWorktree.createWorktree(repo, branch, opts || null));
};

module.exports.deactivate = () => {
  // The host tears down every dispatch entry, hook and registry row it handed
  // out on this plugin's behalf regardless of what happens here (§3.1: teardown
  // never trusts the plugin). Nothing of our own to release.
};
