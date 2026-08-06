'use strict';
// workbench-plugin.test.js — the workbench pilot's ENGINE half (plugins/workbench/
// engine.js), driven through the REAL plugin host engine (plugin-plan.md [internal design doc, not in this repo] §4
// W2/W5). No electron, no PTY: a fake manager, fake scm/fs/worktree leaves.
//
// What this pins, beyond "the rows exist":
//
//   1. MUST-FIX 5 — the locality refusal is HOST-SIDE. Every fs/scm/wt row that
//      takes a session name must go through host.sessions.fsScope FIRST, so a
//      peer session is refused with the exact `'remote'` string the renderer
//      renders as the remote notice, and a careless plugin cannot widen
//      locality. Asserted per row, not once: a single unguarded row is the whole
//      bug, and a spot-check would not find it.
//   2. The row set is COMPLETE and namespaced. Fourteen rows replace fourteen
//      window.api rows one-for-one; `wt.create` is the fifteenth (the workbench's
//      own Create Worktree button, which the plan left without a path).
//   3. `wt.remove` is deliberately NOT scoped — it takes a worktree PATH, exactly
//      as core's `worktree:remove` does (which likewise has no sessionCwd guard).
//      Pinned so a future "consistency" fix has to argue with a test.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPluginHostEngine } = require('../plugin-host-engine');
const { HOST_API_VERSION } = require('../plugin-api');
const gitScm = require('../plugins/workbench/git-scm');
const fsExplorer = require('../plugins/workbench/fs-explorer');
const workbenchEngine = require('../plugins/workbench/engine');

// Every leaf method the plugin can call, recording (method, args) instead of
// touching a real repo. Returning a tagged envelope lets each row's plumbing be
// checked end to end.
//
// W5 split how the three leaves are reached, and the fakes follow suit rather
// than papering over it. `gitWorktree` is core's, lent through `host.lib`, so it
// is still INJECTED as a host dep. `gitScm` / `fsExplorer` are the plugin's own
// files now, required plugin-locally — nothing injects them, so they are stubbed
// by patching the real modules' exports for the test's duration. That is the
// honest shape: a test that could still inject them would be testing a seam the
// production code no longer has.
function makeRecorder(calls) {
  return (leaf, method) => (...args) => {
    calls.push({ leaf, method, args });
    return { ok: true, from: `${leaf}.${method}`, args };
  };
}

// Patch the plugin-local leaves in place; returns the undo. Module identity is
// what makes this work: `require` in the engine half resolves to these same
// objects, so replacing their methods replaces what the rows call.
function stubLocalLeaves(calls) {
  const rec = makeRecorder(calls);
  const saved = [];
  const patch = (mod, leaf, methods) => {
    for (const m of methods) {
      saved.push([mod, m, mod[m]]);
      mod[m] = rec(leaf, m);
    }
  };
  patch(gitScm, 'scm', ['status', 'fileDiff', 'stage', 'unstage', 'discard',
    'commit', 'branches', 'checkout', 'remoteOp']);
  patch(fsExplorer, 'fs', ['listDir', 'readFile', 'writeFile', 'findFiles']);
  return () => { for (const [mod, m, fn] of saved) mod[m] = fn; };
}

const local = { name: 'seat', type: 'claude', cwd: '/repo/seat', workspaceId: 'ws-1' };
const peered = { name: 'far', type: 'claude', peer: 'box', cwd: '/remote', workspaceId: 'ws-1' };
const nocwd = { name: 'bare', type: 'bash', cwd: null, workspaceId: 'ws-1' };

// `worktrees` (optional): paths that `git worktree list` should report for the
// session's repo. Selection validates against exactly this, so a test that wants
// a selection to SUCCEED declares the tree here — which is the honest shape,
// since in production the set comes from git and not from the caller.
function boot({ worktrees = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-workbench-test-'));
  const calls = [];
  const rec = makeRecorder(calls);
  const restore = stubLocalLeaves(calls);
  const listWorktrees = worktrees
    ? (cwd) => { calls.push({ leaf: 'wt', method: 'listWorktrees', args: [cwd] });
        return { ok: true, repo: worktrees[0], worktrees: worktrees.map((p, i) => ({ path: p, isMain: i === 0, branch: 'b' })) }; }
    : rec('wt', 'listWorktrees');
  const map = new Map([[local.name, local], [peered.name, peered], [nocwd.name, nocwd]]);
  const engine = createPluginHostEngine({
    manager: {
      sessions: map,
      list: () => [...map.values()],
      listForWorkspace(wsId) { return this.list().filter((s) => s.workspaceId === wsId); },
      _broadcast() {}, _sendToSession() {}, windowForWorkspace: () => null,
    },
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    log: { info: () => {} },
    userDataPath: dir,
    fs, path,
    // Core's leaf, lent through host.lib — still a real injected seam after W5.
    gitWorktree: {
      listWorktrees,
      removeWorktree: rec('wt', 'removeWorktree'),
      createWorktree: rec('wt', 'createWorktree'),
    },
  });
  // Derived: this file tests the workbench's fourteen handlers, not versioning.
  // A literal would fail every one of them on a bump, which says nothing.
  engine.register('workbench', workbenchEngine, { hostApi: HOST_API_VERSION });
  const cleanup = () => { restore(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { engine, calls, cleanup };
}

// The fourteen rows that replace core's fourteen window.api rows, plus wt.create,
// plus the locator row (fs.find) and worktree selection (wt.apply/selected).
const NAME_SCOPED_ROWS = [
  ['fs.list', ['seat', 'sub']],
  ['fs.read', ['seat', 'a.txt']],
  ['fs.write', ['seat', 'a.txt', 'body']],
  ['fs.find', ['seat', 'a', {}]],
  ['scm.status', ['seat']],
  ['scm.diff', ['seat', 'a.txt', {}]],
  ['scm.stage', ['seat', ['a.txt']]],
  ['scm.unstage', ['seat', ['a.txt']]],
  ['scm.discard', ['seat', 'a.txt', {}]],
  ['scm.commit', ['seat', 'msg', {}]],
  ['scm.branches', ['seat']],
  ['scm.checkout', ['seat', 'main', {}]],
  ['scm.remote', ['seat', 'fetch']],
  ['wt.list', ['seat']],
];

test('the plugin registers exactly the migrated row set, namespaced by plugin id', () => {
  const { engine, cleanup } = boot();
  assert.deepEqual(engine._dispatchKeys().sort(), [
    'workbench:fs.find', 'workbench:fs.list', 'workbench:fs.read', 'workbench:fs.write',
    'workbench:scm.branches', 'workbench:scm.checkout', 'workbench:scm.commit',
    'workbench:scm.diff', 'workbench:scm.discard', 'workbench:scm.remote',
    'workbench:scm.stage', 'workbench:scm.status', 'workbench:scm.unstage',
    'workbench:wt.apply', 'workbench:wt.create', 'workbench:wt.list',
    'workbench:wt.remove', 'workbench:wt.selected',
  ]);
  cleanup();
});

test('every session-scoped row resolves the cwd through the host and delegates', async () => {
  const { engine, calls, cleanup } = boot();
  for (const [method, args] of NAME_SCOPED_ROWS) {
    calls.length = 0;
    const res = await engine.dispatch('workbench', method, args, 'desktop');
    assert.equal(res.ok, true, `${method} should succeed for a local session`);
    assert.equal(calls.length, 1, `${method} should delegate exactly once`);
    assert.equal(calls[0].args[0], '/repo/seat',
      `${method} must pass the HOST-resolved cwd, never the session name`);
  }
  cleanup();
});

test('MUST-FIX 5: EVERY session-scoped row refuses a peer session with "remote"', async () => {
  const { engine, calls, cleanup } = boot();
  for (const [method, args] of NAME_SCOPED_ROWS) {
    calls.length = 0;
    const res = await engine.dispatch('workbench', method, ['far', ...args.slice(1)], 'desktop');
    assert.deepEqual(res, { ok: false, error: 'remote' },
      `${method} must refuse a peer session with the exact string the renderer renders`);
    assert.deepEqual(calls, [], `${method} must not touch the filesystem for a peer session`);
  }
  cleanup();
});

test('the other two fsScope refusals reach the caller unchanged', async () => {
  const { engine, calls, cleanup } = boot();
  assert.deepEqual(await engine.dispatch('workbench', 'fs.list', ['nobody', ''], 'desktop'),
    { ok: false, error: 'Session not found' });
  assert.deepEqual(await engine.dispatch('workbench', 'scm.status', ['bare'], 'desktop'),
    { ok: false, error: 'Session has no working directory' });
  assert.deepEqual(calls, [], 'a refused scope never reaches a leaf');
  cleanup();
});

test('scm.remote keeps the op allowlist on the ENGINE side', async () => {
  const { engine, calls, cleanup } = boot();
  for (const op of ['push', 'pull', 'fetch']) {
    assert.equal((await engine.dispatch('workbench', 'scm.remote', ['seat', op], 'desktop')).ok, true);
  }
  calls.length = 0;
  assert.deepEqual(await engine.dispatch('workbench', 'scm.remote', ['seat', 'reset --hard'], 'desktop'),
    { ok: false, error: 'Bad op' });
  assert.deepEqual(calls, [], 'a refused op never reaches git');
  cleanup();
});

test('wt.remove takes a PATH and is deliberately unscoped, like core\'s row', async () => {
  const { engine, calls, cleanup } = boot();
  const res = await engine.dispatch('workbench', 'wt.remove', ['/tmp/some-worktree'], 'desktop');
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [{ leaf: 'wt', method: 'removeWorktree', args: ['/tmp/some-worktree'] }],
    'the path is passed straight through — core\'s worktree:remove has no sessionCwd guard either');
  cleanup();
});

test('wt.create reaches core\'s permanent gitWorktree leaf, opts defaulted to null', async () => {
  const { engine, calls, cleanup } = boot();
  await engine.dispatch('workbench', 'wt.create', ['/repo', 'feature', { base: 'main' }], 'desktop');
  await engine.dispatch('workbench', 'wt.create', ['/repo', 'feature'], 'desktop');
  assert.deepEqual(calls.map((c) => c.args), [
    ['/repo', 'feature', { base: 'main' }],
    ['/repo', 'feature', null],
  ]);
  cleanup();
});

test('deactivating the plugin removes every row from the dispatch map', () => {
  const { engine, cleanup } = boot();
  engine.deactivate('workbench');
  assert.deepEqual(engine._dispatchKeys(), [],
    'host-driven teardown, not the plugin\'s own deactivate()');
  cleanup();
});

// ── The RENDERER half's ENTRY POINT (§2.2 / W4) ─────────────────────────────
// W4 deleted core's `#btn-workbench`, the View ▸ Workbench item and the
// `onRequestOpenWorkbench` contract row. The plugin must therefore bring its own
// way in, or the feature is unreachable — a silent, test-free failure mode,
// since nothing else in the suite opens the workbench. `activate` touches no DOM
// (the markup is built lazily in `mount`, at first open), so a stub rhost is
// enough to pin the registration and the click path.
const workbenchRenderer = require('../plugins/workbench/renderer');

function activateRendererHalf() {
  const rec = { overlays: [], footerButtons: [], opened: 0 };
  const rhost = {
    ui: {
      sidebar: {
        footerButton(spec) { rec.footerButtons.push(spec); return () => {}; },
      },
      surfaces: {
        overlay(spec) {
          rec.overlays.push(spec);
          return { open: () => { rec.opened += 1; }, close: () => {} };
        },
      },
    },
    addEventListener() { throw new Error('the W2 open-workbench bridge should be gone'); },
  };
  workbenchRenderer.activate(rhost);
  return rec;
}

test('W4: the renderer half registers its OWN sidebar footer button', () => {
  const rec = activateRendererHalf();
  assert.equal(rec.footerButtons.length, 1, 'exactly one entry point');
  const [btn] = rec.footerButtons;
  assert.equal(typeof btn.onClick, 'function');
  assert.ok(btn.label, 'the button needs a label — the host renders glyph + label');
  assert.ok(btn.glyph, 'and a glyph, matching #inbox-open\'s structure');
});

test('W4: clicking the footer button opens the overlay surface', () => {
  const rec = activateRendererHalf();
  assert.equal(rec.overlays.length, 1, 'one overlay surface');
  assert.equal(rec.opened, 0, 'activation alone must not open anything');
  rec.footerButtons[0].onClick();
  assert.equal(rec.opened, 1, 'the button opens the surface it registered');
});

test('W4: the temporary core→plugin DOM bridge is gone', () => {
  // W2 kept `#btn-workbench` alive by having core dispatch a
  // `clodex:open-workbench` CustomEvent that this half listened for. W4 retires
  // it: the stub rhost above throws on ANY addEventListener, so activate()
  // completing at all is the assertion. Pinned so the bridge cannot creep back
  // as a "convenience" — it was a coupling core is now free of.
  assert.doesNotThrow(activateRendererHalf);
});

// ── W9 GATE 2: the peer/remote refusal keeps TODAY'S UX ─────────────────────
//
// The engine half of this gate is already covered above (every session-scoped
// row refuses a peer with the exact `'remote'` string). What that does NOT show
// is the half the user actually experiences: that the renderer still TURNS that
// string into the same sentence it did before the migration. A refusal that
// reaches the UI as a blank panel or a raw error envelope would pass every
// engine test and still be a regression.
//
// Pinned against MASTER's byte-identical strings, so this is parity evidence,
// not a restatement of what the plugin happens to say today.

const fsNode = require('node:fs');
const pathNode = require('node:path');
const rendererSrc = fsNode.readFileSync(
  pathNode.join(__dirname, '..', 'plugins', 'workbench', 'renderer.js'), 'utf8');

test('W9 gate 2: all three remote notices survive the migration verbatim', () => {
  // These are the exact strings renderer/popovers/workbench-popover.js carried
  // at master (2f3f8e1, lines 212/272/414) before it was deleted at W2.
  for (const notice of [
    'This is a remote session — the file explorer only works on local sessions.',
    'This is a remote session — source control only works on local sessions.',
    'This is a remote session — worktree management only works on local sessions.',
  ]) {
    assert.ok(rendererSrc.includes(notice), `the pre-migration notice is gone: ${notice}`);
  }
});

test('W9 gate 2: each notice is gated on the HOST\'s error string, not a local guess', () => {
  // The renderer must branch on `error === 'remote'` — the value fsScope
  // produces engine-side. A renderer that re-derived "is this a peer?" from its
  // own session list would be a second locality rule, free to drift from the
  // host guarantee that MUST-FIX 5 exists to make singular.
  const branches = [...rendererSrc.matchAll(/error === 'remote'/g)];
  assert.strictEqual(branches.length, 3, 'one branch per panel — files, scm, worktrees');
});

test('W9 gate 2: the dropdown itself never offers a peer session', () => {
  // Defence in depth, and the reason the refusal is rarely seen in practice:
  // peer sessions never enter the manager's record, so the workspace-scoped
  // list cannot contain one. The comment documenting that must stay true — if
  // the dropdown ever switched to a source that includes peers, fsScope would
  // still refuse, but the UX would regress to "click it and get an error".
  // Comments stripped first: the file's own header explains at length WHY it
  // does not call listAll(), and prose naming the forbidden thing must not read
  // as the forbidden thing — the same false-positive class plugin-boundary and
  // electron-boundary already document.
  const code = rendererSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /listWorkspace\(/, 'the dropdown uses the workspace-scoped accessor');
  assert.ok(!/listAll\(/.test(code), 'and never the global one');
});

// ── Worktree selection: the active root every fs./scm. row follows ──────────
// The selection is load-bearing (scm.commit/push act on it), so these pin the
// three properties that make it safe: it moves ALL rows together, it only
// accepts the session's own worktrees, and it drops rather than errors when the
// selected tree disappears.

test('wt.apply refuses a REAL directory that is not a worktree of this repo', async () => {
  // The case that matters, and the one a non-existent path would dodge: the
  // directory genuinely exists, so effectiveRoot's statSync would happily keep
  // it. The refusal has to come from validation, not from the path being fake.
  const { engine, calls, cleanup } = boot();
  const outsider = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-outsider-'));
  try {
    assert.ok(fs.statSync(outsider).isDirectory(), 'fixture really exists');
    const res = await engine.dispatch('workbench', 'wt.apply', ['seat', outsider], 'desktop');
    assert.strictEqual(res.ok, false, 'an arbitrary real directory is not selectable');

    // And nothing was written: the rows still read the session cwd.
    calls.length = 0;
    const list = await engine.dispatch('workbench', 'fs.list', ['seat', ''], 'desktop');
    assert.strictEqual(list.ok, true);
    assert.strictEqual(calls[0].args[0], '/repo/seat',
      'a refused apply must leave the root at the session cwd');
  } finally {
    fs.rmSync(outsider, { recursive: true, force: true });
    cleanup();
  }
});

test('wt.apply with null clears back to the session cwd', async () => {
  const { engine, cleanup } = boot();
  const res = await engine.dispatch('workbench', 'wt.apply', ['seat', null], 'desktop');
  assert.deepStrictEqual(res, { ok: true, root: null });
  cleanup();
});

test('no reachable row writes the selection without validating it', async () => {
  // The guarantee is the ENGINE's, not the renderer's call sequence: there must
  // be exactly one row that can write wtRoots, and it validates.
  const { engine, cleanup } = boot();
  const writers = engine._dispatchKeys().filter((k) => k.startsWith('workbench:wt.'));
  assert.deepStrictEqual(writers.sort(),
    ['workbench:wt.apply', 'workbench:wt.create', 'workbench:wt.list',
     'workbench:wt.remove', 'workbench:wt.selected'],
    'wt.select is gone — a row whose only purpose was to be called first');
  cleanup();
});

test('wt.selected reports the session cwd and never leaks across sessions', async () => {
  const { engine, cleanup } = boot();
  const mine = await engine.dispatch('workbench', 'wt.selected', ['seat'], 'desktop');
  assert.strictEqual(mine.ok, true);
  assert.strictEqual(mine.cwd, '/repo/seat', 'the session cwd is reported alongside');
  assert.strictEqual(mine.selected, null, 'nothing selected by default');

  const other = await engine.dispatch('workbench', 'wt.selected', ['bare'], 'desktop');
  assert.strictEqual(other.ok, false, 'a session with no cwd still refuses, unchanged');
  cleanup();
});

test('a selected root that no longer exists DROPS to the session cwd, it does not error', async () => {
  // Select a real worktree, then delete it underneath the selection — which is
  // what `git worktree remove` (or our own Remove button) does in practice.
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-gone-'));
  const { engine, calls, cleanup } = boot({ worktrees: ['/repo/seat', gone] });
  const applied = await engine.dispatch('workbench', 'wt.apply', ['seat', gone], 'desktop');
  assert.strictEqual(applied.ok, true, 'a genuine worktree is selectable');
  fs.rmSync(gone, { recursive: true, force: true });

  const sel = await engine.dispatch('workbench', 'wt.selected', ['seat'], 'desktop');
  assert.strictEqual(sel.ok, true, 'reporting the root never fails');
  assert.strictEqual(sel.root, '/repo/seat', 'it falls back to the session cwd');
  assert.strictEqual(sel.selected, null, 'and reports no active selection');
  assert.strictEqual(sel.dropped, true, 'while telling the renderer the drop happened');

  // And the fs rows go back to the cwd rather than refusing.
  calls.length = 0;
  const res = await engine.dispatch('workbench', 'fs.list', ['seat', ''], 'desktop');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(calls[0].args[0], '/repo/seat', 'the row ran against the session cwd');
  cleanup();
});

test('the selection moves EVERY scoped row together — Files and Source cannot diverge', async () => {
  // A real directory AND a declared worktree of the session's repo: both are
  // required now, since apply validates and effectiveRoot re-checks at use time.
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-wt-'));
  const { engine, calls, cleanup } = boot({ worktrees: ['/repo/seat', real] });
  const applied = await engine.dispatch('workbench', 'wt.apply', ['seat', real], 'desktop');
  assert.strictEqual(applied.ok, true, 'selection succeeded');
  try {
    for (const [method, args] of NAME_SCOPED_ROWS) {
      calls.length = 0;
      await engine.dispatch('workbench', method, args, 'desktop');
      assert.strictEqual(calls[0].args[0], real,
        `${method} must follow the selected worktree, not the session cwd`);
    }
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
    cleanup();
  }
});

test('the peer refusal is untouched by selection — fsScope still runs first', async () => {
  const { engine, cleanup } = boot();
  await engine.dispatch('workbench', 'wt.apply', ['far', '/anything'], 'desktop');
  const res = await engine.dispatch('workbench', 'fs.list', ['far', ''], 'desktop');
  assert.deepStrictEqual(res, { ok: false, error: 'remote' },
    'a selection cannot smuggle a peer session past MUST-FIX 5');
  cleanup();
});
