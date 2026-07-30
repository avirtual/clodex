'use strict';
// plugins/workbench/engine.js — the workbench pilot's ENGINE half
// (plugin-plan.md [internal design doc, not in this repo] §4, steps W1-W6).
//
// Fifteen data rows, one per fs:/scm:/worktree: IPC handler the workbench used
// to reach through window.api. Every filesystem-touching one's FIRST line is
// `host.sessions.fsScope(name)` (MUST-FIX 5) — the PEER refusal, including the
// exact `'remote'` error string the renderer half renders as the remote notice,
// is a HOST guarantee, not this plugin's code to get right.
//
// What fsScope is NOT: containment. It answers "what cwd, and is this local?"
// and stops there. It does not scope to a workspace (the plugin transport
// discards the Electron event, so a caller's window never reaches an engine
// half), and it does not confine reads to the cwd it returned — that is this
// plugin's own safeResolve, which is lexical and follows a symlink inside the
// cwd pointing out. An earlier version of this comment claimed a careless
// plugin "cannot widen locality"; it can. The engine half is unsandboxed
// in-process Node holding a cwd and require('fs'), and plugins/plugin-api.md says
// so outright: the host API is a contract, not a containment boundary.
//
// W5 moved git-scm.js and fs-explorer.js OUT of the core root and into this
// directory: they implement the workbench and nothing else, so they are the
// plugin's own code, required plugin-locally. The two temporary `host.lib`
// entries that carried them through W2-W4 are gone with them.
//
// `host.lib.gitWorktree` is PERMANENT and stays a host entry — git-worktree.js
// is genuinely SHARED (the New-Session dialog and the session-delete flow use
// it), so it stays core and reaches this plugin the sanctioned way (§3.2 lib).
// That is the line: a leaf only the plugin uses moves in; a leaf core also uses
// stays core and is lent.
//
// Electron-free by contract (test/electron-boundary.test.js walks this file) and
// backdoor-free (test/plugin-boundary.test.js: only node builtins and requires
// that stay inside this directory — core is reachable ONLY through `host`).

const fs = require('fs');
const gitScm = require('./git-scm');
const fsExplorer = require('./fs-explorer');

module.exports.activate = (host) => {
  const { gitWorktree } = host.lib;

  // ── Selected worktree, per session ──────────────────────────────────────
  // sessionName → absolute worktree path. IN MEMORY ONLY, never persisted: a
  // fresh launch starts at the true session cwd, and one plugin's UI state does
  // not earn storage surface. Keyed by session so switching away and back
  // restores your tree, and switching to a DIFFERENT session can never show you
  // another session's.
  //
  // Only paths that `git worktree list` reports for that session's own repo
  // ever land here — `wt.apply` is the single writer and it validates before it
  // writes, so the confinement rule is enforced where the write happens.
  const wtRoots = new Map();

  // Re-validate at USE time, not only at selection time: a worktree can vanish
  // under a stale selection (`git worktree remove` elsewhere, or our own Remove
  // button). A dead selection DROPS to the session cwd rather than erroring —
  // the operation still does the obvious right thing. `wt.selected` reports the
  // drop so the renderer can say so.
  function effectiveRoot(name, cwd) {
    const sel = wtRoots.get(name);
    if (!sel) return cwd;
    try { if (fs.statSync(sel).isDirectory()) return sel; } catch {}
    wtRoots.delete(name);
    return cwd;
  }

  // The MUST-FIX 5 wrapper. Every row built with this resolves the session's cwd
  // through the host and refuses peers before the handler body ever runs; the
  // envelope shape ({ ok:false, error }) reproduces ipc-handlers' verbatim, so
  // the renderer's existing "remote" branches keep matching.
  //
  // The worktree substitution lives HERE, deliberately, so all twelve fs./scm.
  // rows follow the selected tree as one consequence of one change. Files and
  // Source can therefore never read different roots. Note this makes the
  // selection load-bearing: scm.commit/discard/checkout and push act on the
  // selected worktree. That is the point of selecting it, and it is why the
  // renderer keeps a persistent indicator whenever the root is not the cwd.
  const scoped = (fn) => async (name, ...rest) => {
    const r = host.sessions.fsScope(name);
    if (r.error) return { ok: false, error: r.error };
    return fn(effectiveRoot(name, r.cwd), ...rest);
  };

  // ── File explorer + editor (./fs-explorer). Confined to the session cwd. ──
  host.ipc.handle('fs.list', scoped((cwd, rel) => fsExplorer.listDir(cwd, rel || '')));
  host.ipc.handle('fs.read', scoped((cwd, rel) => fsExplorer.readFile(cwd, rel)));
  host.ipc.handle('fs.write', scoped((cwd, rel, content) => fsExplorer.writeFile(cwd, rel, content)));
  // The file locator's one row. Bounded inside fs-explorer (see its header) —
  // an unbounded walk on every keystroke would be worse than no locator.
  host.ipc.handle('fs.find', scoped((cwd, query, opts) => fsExplorer.findFiles(cwd, query, opts || {})));

  // ── Source control (./git-scm). ──
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

  // ── Worktree SELECTION (the plugin's own state; no core equivalent) ──────
  // ONE row writes `wtRoots`, and it is the row that validates. An earlier
  // version split this in two — a `wt.select` that validated and a `wt.apply`
  // that wrote — which put the confinement guarantee in the RENDERER's call
  // sequence rather than in the engine: `wt.apply(name, '/any/real/dir')` set
  // the root, `effectiveRoot`'s statSync passed because the directory existed,
  // and every scoped row (fs.write and scm.commit included) then acted outside
  // the session's repo. The split is gone; there is no reachable path that
  // writes the map unvalidated.
  //
  // Deliberately NOT `scoped`: this needs the session NAME to key the map, and
  // `scoped` hands the handler a cwd and drops the name. So it calls `fsScope`
  // itself — which also keeps the peer refusal identical to every other row.
  host.ipc.handle('wt.apply', async (name, worktreePath) => {
    const r = host.sessions.fsScope(name);
    if (r.error) return { ok: false, error: r.error };
    if (!worktreePath) { wtRoots.delete(name); return { ok: true, root: null }; }
    // Resolve the repo from the EFFECTIVE root: worktree listing answers the
    // same set from any tree of the repo, so switching worktree-to-worktree
    // works without first returning to the session cwd.
    const list = await gitWorktree.listWorktrees(effectiveRoot(name, r.cwd));
    if (!list.ok) return { ok: false, error: list.error || 'Not a git repository' };
    const match = list.worktrees.find((w) => w.path === worktreePath);
    // The confinement rule, enforced where the write happens: only a path that
    // `git worktree list` returns for THIS session's own repo is selectable.
    if (!match) return { ok: false, error: 'Not a worktree of this session\'s repository' };
    wtRoots.set(name, match.path);
    return { ok: true, root: match.path, isMain: match.isMain };
  });
  // What is the active root, and did a stale selection just drop? The renderer
  // asks on every open/refresh so the indicator can never lie.
  host.ipc.handle('wt.selected', (name) => {
    const r = host.sessions.fsScope(name);
    if (r.error) return { ok: false, error: r.error };
    const had = wtRoots.get(name) || null;
    const root = effectiveRoot(name, r.cwd);
    return { ok: true, root, cwd: r.cwd, selected: root === r.cwd ? null : root, dropped: !!had && !wtRoots.has(name) };
  });
};

module.exports.deactivate = () => {
  // The host tears down every dispatch entry, hook and registry row it handed
  // out on this plugin's behalf regardless of what happens here (§3.1: teardown
  // never trusts the plugin). Nothing of our own to release.
};
