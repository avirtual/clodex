'use strict';
// plugins/workbench/engine.js — the workbench pilot's ENGINE half.
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
const path = require('path');
const gitScm = require('./git-scm');
const fsExplorer = require('./fs-explorer');

module.exports.activate = (host) => {
  const { gitWorktree } = host.lib;

  // ── The ACTIVE ROOT, per session ────────────────────────────────────────
  // sessionName → { path, kind: 'worktree' | 'folder' }. IN MEMORY ONLY, never
  // persisted: a fresh launch starts at the true session cwd, and one plugin's
  // UI state does not earn storage surface. That rationale is STRONGER for a
  // folder root than for a worktree — a persisted arbitrary root is an
  // unannounced root surviving a restart. Keyed by session so switching away and
  // back restores your root, and switching to a DIFFERENT session can never show
  // you another session's.
  //
  // ONE map with ONE entry per session, not a map per kind: that makes "a
  // worktree root and a folder root are mutually exclusive" structural, so
  // nothing downstream needs a precedence rule between two live selections.
  //
  // Two rows write it — `wt.apply` and `fs.setRoot` — and each validates its OWN
  // kind at the point of writing (a worktree of the repository at the ACTIVE
  // ROOT; an existing absolute directory). There is no reachable row that writes
  // an entry unvalidated, which is the property the wt.apply block below
  // explains at length. Adding a third writer means adding a third validation,
  // not reusing one of these.
  //
  // "The repository at the active root", not "this session's own repository":
  // once a folder root points into another repo, that repo's worktrees are what
  // `wt.apply` accepts. That is deliberate — see the note on the row.
  const roots = new Map();

  // Re-validate at USE time, not only at selection time: a root can vanish under
  // a stale selection (`git worktree remove` elsewhere, our own Remove button, or
  // a browsed folder deleted in Finder). A dead selection DROPS to the session
  // cwd rather than erroring — the operation still does the obvious right thing.
  // `wt.selected` reports the drop so the renderer can say so.
  function effectiveRoot(name, cwd) {
    const sel = roots.get(name);
    if (!sel) return cwd;
    try { if (fs.statSync(sel.path).isDirectory()) return sel.path; } catch {}
    roots.delete(name);
    return cwd;
  }

  // The MUST-FIX 5 wrapper. Every row built with this resolves the session's cwd
  // through the host and refuses peers before the handler body ever runs; the
  // envelope shape ({ ok:false, error }) reproduces ipc-handlers' verbatim, so
  // the renderer's existing "remote" branches keep matching.
  //
  // The root substitution lives HERE, deliberately, so all twelve fs./scm. rows
  // follow the selected root as one consequence of one change. Files and Source
  // can therefore never read different roots — including when the root is a
  // folder in some other repo, where Source correctly shows THAT repo rather
  // than disagreeing with the tree beside it. Note this makes the selection
  // load-bearing: scm.commit/discard/checkout and push act on the selected root.
  // That is the point of selecting it, and it is why the renderer keeps a
  // persistent indicator whenever the root is not the cwd.
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
  // The row that writes a worktree root is the row that validates it. An earlier
  // version split this in two — a `wt.select` that validated and a `wt.apply`
  // that wrote — which put the confinement guarantee in the RENDERER's call
  // sequence rather than in the engine: `wt.apply(name, '/any/real/dir')` set
  // the root, `effectiveRoot`'s statSync passed because the directory existed,
  // and every scoped row (fs.write and scm.commit included) then acted outside
  // the session's repo. The split is gone.
  //
  // `fs.setRoot` below now offers an arbitrary directory DELIBERATELY, which is
  // why this row's validation must stay exactly as strict as it is: the two
  // writers are not interchangeable, and widening this one to "any real
  // directory" would restore the defect rather than duplicate the feature.
  //
  // Deliberately NOT `scoped`: this needs the session NAME to key the map, and
  // `scoped` hands the handler a cwd and drops the name. So it calls `fsScope`
  // itself — which also keeps the peer refusal identical to every other row.
  host.ipc.handle('wt.apply', async (name, worktreePath) => {
    const r = host.sessions.fsScope(name);
    if (r.error) return { ok: false, error: r.error };
    if (!worktreePath) { roots.delete(name); return { ok: true, root: null }; }
    // Resolve the repo from the EFFECTIVE root: worktree listing answers the
    // same set from any tree of the repo, so switching worktree-to-worktree
    // works without first returning to the session cwd.
    const list = await gitWorktree.listWorktrees(effectiveRoot(name, r.cwd));
    if (!list.ok) return { ok: false, error: list.error || 'Not a git repository' };
    const match = list.worktrees.find((w) => w.path === worktreePath);
    // The confinement rule, enforced where the write happens: only a path that
    // `git worktree list` returns for the repository at the ACTIVE ROOT is
    // selectable — which is the session's own repo until a folder root moves it,
    // and that repo's afterwards.
    //
    // Resolving from `r.cwd` instead would be tighter but WRONG for the UI:
    // `wt.list` is `scoped`, so the Worktrees tab already lists the browsed
    // repo's rows, and clicking one would then be refused. A tab that offers a
    // choice and rejects it is a worse defect than the wider set, and the set is
    // bounded by a folder root the operator explicitly picked.
    if (!match) return { ok: false, error: 'Not a worktree of the active root\'s repository' };
    // Overwrites a folder root if one is set: one entry per session is what makes
    // the two kinds mutually exclusive.
    roots.set(name, { path: match.path, kind: 'worktree' });
    return { ok: true, root: match.path, isMain: match.isMain };
  });

  // ── FOLDER root: browsing outside the session cwd, on purpose ────────────
  // This re-introduces the capability the block above calls a defect. Three
  // properties made it one; each is answered here, and none may be relaxed:
  //
  //   * it was reachable from a renderer BUG — this row is driven only from an
  //     operator gesture, a native pick or Up, never from a path derived from
  //     untrusted input;
  //   * it was INVISIBLE — the root indicator must label a folder root
  //     distinctly from a worktree, which is what `wt.selected`'s `kind` is for;
  //   * the validating writer was BYPASSABLE — this row is the only folder
  //     writer and it validates inline, so there is no second, unvalidated path
  //     to the map.
  //
  // No `..`-anywhere-under-home rule or similar: an operator who picked a
  // directory in a native dialog picked it, and a half-rule would block
  // legitimate use while stopping nothing — a Tier-A plugin is unsandboxed
  // in-process Node holding require('fs') (see this file's header).
  //
  // Setting a folder root moves scm.* with it, not just the file tree; that is
  // the one-root property the `scoped` comment above states, and it is why this
  // is not named per-panel.
  //
  // Deliberately NOT `scoped`, for `wt.apply`'s reason: it needs the session
  // NAME, so it calls `fsScope` itself and the peer refusal stays identical.
  host.ipc.handle('fs.setRoot', (name, absPath) => {
    const r = host.sessions.fsScope(name);
    if (r.error) return { ok: false, error: r.error };
    // Mirrors `wt.apply`'s clear branch, and clears EITHER kind — one entry, so
    // the renderer's single reset gesture cannot leave a root of the other kind
    // standing.
    if (!absPath) { roots.delete(name); return { ok: true, root: null }; }
    if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) return { ok: false, error: 'Not an absolute path' };
    let st;
    try { st = fs.statSync(absPath); } catch { return { ok: false, error: 'No such directory' }; }
    if (!st.isDirectory()) return { ok: false, error: 'Not a directory' };
    roots.set(name, { path: absPath, kind: 'folder' });
    return { ok: true, root: absPath, kind: 'folder' };
  });

  // What is the active root, what KIND is it, and did a stale selection just
  // drop? The renderer asks on every open/refresh so the indicator can never lie.
  host.ipc.handle('wt.selected', (name) => {
    const r = host.sessions.fsScope(name);
    if (r.error) return { ok: false, error: r.error };
    const had = roots.get(name) || null;
    const root = effectiveRoot(name, r.cwd);
    const live = roots.get(name) || null;
    // `kind` is derived from the SAME condition as `selected`, not read straight
    // off the map: the renderer hides the indicator when `selected` is null, and
    // a kind surviving that would be a label with nothing to label.
    const selected = root === r.cwd ? null : root;
    return {
      ok: true, root, cwd: r.cwd, selected,
      kind: selected && live ? live.kind : null,
      dropped: !!had && !roots.has(name),
    };
  });
};

module.exports.deactivate = () => {
  // The host tears down every dispatch entry, hook and registry row it handed
  // out on this plugin's behalf regardless of what happens here (§3.1: teardown
  // never trusts the plugin). Nothing of our own to release.
};
