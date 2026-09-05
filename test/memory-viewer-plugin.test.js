'use strict';
// memory-viewer-plugin.test.js — the plugin's ENGINE half, driven through the
// REAL plugin host engine against a real temp memory store.
//
// What this pins beyond "delete works":
//
//   1. The delete goes through host.library.remove, NOT fs.unlinkSync. The
//      plugin can see the file; unlinking it directly would skip the boot-digest
//      rewrite core owns, leaving live agents serving a memory that is gone.
//      Asserted by refusing the seam and checking the file SURVIVES — a test
//      that only checked "file is gone" passes for both implementations.
//   2. The agent name is vetted through agentDir() before the seam sees it, so
//      a traversal ref never reaches core.
//   3. The unit id is NOT vetted plugin-side: core's MEMORY_ID_RE owns that
//      grammar and a second copy would drift.
//   4. Reads are confined by REALPATH, not by the lexical dirname. The agent
//      writes its own memory folder, so an entry there can be a symlink aimed
//      anywhere on disk; following one renders a file of the agent's choosing in
//      the operator's viewer.
//   5. The agent FOLDER must resolve to itself, and units are judged through the
//      open fd. Confinement to the root alone admits a sibling alias, and a
//      path-based guard admits a hardlink, whose realpath is already in-dir.
//   6. The open itself is non-blocking, so a FIFO planted in the folder is
//      refused instead of hanging the synchronous read forever.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createPluginHostEngine } = require('../plugin-host-engine');
const { HOST_API_VERSION } = require('../plugin-api');
const viewerEngine = require('../plugins/memory-viewer/engine');

// The plugin derives MEMORY_ROOT from os.homedir() at require time (it is
// deliberately not injectable — see its header). Point HOME at a temp dir and
// re-require so the module binds to it.
function bootStore() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-mv-home-'));
  const root = path.join(home, '.clodex', 'library', 'memory');
  fs.mkdirSync(root, { recursive: true });
  return { home, root };
}

// `metaId` defaults to the basename, which is the well-formed case. Pass it
// explicitly (or null) to build the two hand-authored shapes core tolerates and
// this plugin has to survive.
function writeUnit(root, agent, base, { pinned = false, body = 'a body', metaId = base } = {}) {
  const dir = path.join(root, agent);
  fs.mkdirSync(dir, { recursive: true });
  const meta = [];
  if (metaId !== null) meta.push(`id: ${metaId}`);
  meta.push('learned_at: 2026-07-30T10:00:00.000Z', `source: ${agent}`);
  if (pinned) meta.push('pinned: true');
  fs.writeFileSync(path.join(dir, `${base}.md`), `---\n${meta.join('\n')}\n---\n\n${body}\n`);
  return path.join(dir, `${base}.md`);
}

// `libraryKinds` is the seam under test, so each boot declares what core does
// with the ref it receives.
function boot({ removeImpl } = {}) {
  const { home, root } = bootStore();
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  delete require.cache[require.resolve('../plugins/memory-viewer/engine')];
  const engine = require('../plugins/memory-viewer/engine');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-mv-data-'));
  const removals = [];
  const host = createPluginHostEngine({
    manager: {
      sessions: new Map(),
      list: () => [],
      listForWorkspace: () => [],
      _broadcast() {}, _sendToSession() {}, windowForWorkspace: () => null,
    },
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    log: { info: () => {}, error: () => {} },
    userDataPath: dir,
    fs, path,
    gitWorktree: {},
    libraryKinds: {
      memory: (ref) => {
        removals.push(ref);
        if (removeImpl) return removeImpl(ref);
        // The real handler's observable effect: the file goes away.
        try { fs.unlinkSync(path.join(root, ref.agent, `${ref.id}.md`)); }
        catch (e) { return { ok: false, error: e.message }; }
        return { ok: true };
      },
    },
  });
  host.register('memory-viewer', engine, { hostApi: HOST_API_VERSION });
  const cleanup = () => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    delete require.cache[require.resolve('../plugins/memory-viewer/engine')];
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { host, root, removals, cleanup };
}

test('memory-viewer: forget forwards to the library seam and the unit goes away', async () => {
  const { host, root, removals, cleanup } = boot();
  try {
    const file = writeUnit(root, 'clodex', 'mem-1-aaaaaa');
    assert.ok(fs.existsSync(file));

    const before = await host.dispatch('memory-viewer', 'units', ['clodex'], 'desktop');
    assert.equal(before.units.length, 1);

    const res = await host.dispatch('memory-viewer', 'forget', [{ agent: 'clodex', id: 'mem-1-aaaaaa' }], 'desktop');
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(removals, [{ agent: 'clodex', id: 'mem-1-aaaaaa' }],
      'the ref core receives carries exactly agent + id');
    assert.equal(fs.existsSync(file), false);

    const after = await host.dispatch('memory-viewer', 'units', ['clodex'], 'desktop');
    assert.equal(after.units.length, 0, 'the list reflects the delete on next read');
  } finally { cleanup(); }
});

test('memory-viewer: the delete is the SEAM, not an unlink the plugin does itself', async () => {
  // The plugin holds a readable path to the file. If it unlinked directly, the
  // digest rewrite core owns would be skipped and live agents would serve a
  // memory that no longer exists — so a refused seam must leave the file THERE.
  const { host, root, cleanup } = boot({
    removeImpl: () => ({ ok: false, error: 'core refused' }),
  });
  try {
    const file = writeUnit(root, 'clodex', 'mem-1-aaaaaa');
    const res = await host.dispatch('memory-viewer', 'forget', [{ agent: 'clodex', id: 'mem-1-aaaaaa' }], 'desktop');
    assert.deepEqual(res, { ok: false, error: 'core refused' });
    assert.ok(fs.existsSync(file),
      'a refused seam must leave the unit on disk — the plugin must not unlink it');
  } finally { cleanup(); }
});

test('memory-viewer: forget vets the AGENT through agentDir before the seam sees it', async () => {
  const { host, removals, cleanup } = boot();
  try {
    for (const agent of ['..', '.', '../../etc', 'has/slash', '', null, undefined, 42, {}]) {
      const res = await host.dispatch('memory-viewer', 'forget', [{ agent, id: 'mem-1-aaaaaa' }], 'desktop');
      assert.equal(res.ok, false, `${String(agent)} must be refused`);
      assert.match(res.error, /valid agent name/);
    }
    // A missing payload is the same refusal, not a crash.
    for (const payload of [null, undefined, 'nope']) {
      const res = await host.dispatch('memory-viewer', 'forget', [payload], 'desktop');
      assert.equal(res.ok, false);
    }
    assert.deepEqual(removals, [], 'no traversal ref ever reached core');
  } finally { cleanup(); }
});

test('memory-viewer: the unit id is core\'s grammar to enforce, not the plugin\'s', async () => {
  // Deliberately NOT validated plugin-side: MEMORY_ID_RE lives in core's store
  // and a second copy here would drift. The plugin forwards and core refuses.
  const { host, removals, cleanup } = boot({
    removeImpl: () => ({ ok: false, error: 'invalid unit id: ../evil' }),
  });
  try {
    const res = await host.dispatch('memory-viewer', 'forget', [{ agent: 'clodex', id: '../evil' }], 'desktop');
    assert.deepEqual(res, { ok: false, error: 'invalid unit id: ../evil' });
    assert.deepEqual(removals, [{ agent: 'clodex', id: '../evil' }],
      'the id reaches core unmodified — core owns that refusal');
  } finally { cleanup(); }
});

// ── the delete target is the FILENAME, not the `id:` frontmatter ────────────
// Core resolves a unit as `<dir>/<id>.md` (memory-store.js `_file`, used by
// `forget`) and its own list() falls back to the basename. A plugin that
// deletes by `meta.id` aims at a different file than the one whose body its
// confirmation showed — permanently, and with no way for the dialog to warn.

test('memory-viewer: a unit whose id line disagrees with its filename deletes the FILE', async () => {
  const { host, root, removals, cleanup } = boot();
  try {
    // The confirmed unit, whose `id:` line names a DIFFERENT unit's basename.
    const victim = writeUnit(root, 'clodex', 'mem-1-aaaaaa', { metaId: 'mem-2-bbbbbb', body: 'the one on screen' });
    const bystander = writeUnit(root, 'clodex', 'mem-2-bbbbbb', { body: 'must survive' });

    const list = await host.dispatch('memory-viewer', 'units', ['clodex'], 'desktop');
    const shown = list.units.find((u) => u.body === 'the one on screen');
    assert.equal(shown.key, 'mem-1-aaaaaa', 'key is the basename');
    assert.equal(shown.id, 'mem-2-bbbbbb', 'the id line is preserved for display');
    assert.equal(shown.idMismatch, true, 'the disagreement is surfaced, not silently resolved');

    await host.dispatch('memory-viewer', 'forget', [{ agent: 'clodex', id: shown.key }], 'desktop');
    assert.deepEqual(removals, [{ agent: 'clodex', id: 'mem-1-aaaaaa' }]);
    assert.equal(fs.existsSync(victim), false, 'the confirmed unit is the one deleted');
    assert.ok(fs.existsSync(bystander), 'the unrelated unit named by the id line survives');
  } finally { cleanup(); }
});

test('memory-viewer: a unit with NO id line is still deletable', async () => {
  // `meta.id || ''` yielded an empty id here, so core answered
  // `invalid unit id:` with nothing after the colon and the file was
  // undeletable from this surface — while [agent:memory forget] could remove it.
  const { host, root, removals, cleanup } = boot();
  try {
    const file = writeUnit(root, 'clodex', 'mem-3-cccccc', { metaId: null, body: 'no id line' });
    const list = await host.dispatch('memory-viewer', 'units', ['clodex'], 'desktop');
    const u = list.units[0];
    assert.equal(u.key, 'mem-3-cccccc');
    assert.equal(u.id, 'mem-3-cccccc', 'display falls back to the basename, like core list()');
    assert.equal(u.idMismatch, false, 'an absent id line is not a disagreement');

    const res = await host.dispatch('memory-viewer', 'forget', [{ agent: 'clodex', id: u.key }], 'desktop');
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(removals, [{ agent: 'clodex', id: 'mem-3-cccccc' }]);
    assert.equal(fs.existsSync(file), false);
  } finally { cleanup(); }
});

// ── reads are confined by REALPATH, not by the lexical dirname ──────────────
// `~/.clodex/library/memory/<agent>/` is a directory the agent itself writes, so
// a `.md` entry there is not evidence of a file inside it. Confining by
// path.dirname and then reading `path.join(dir, entry)` follows a planted
// symlink to anything readable and renders it to the operator. Each of these
// carries a CONTROL unit beside the plant: a guard that refuses everything is
// indistinguishable from a working one when only the refusal is asserted.

test('memory-viewer: a symlink out of the agent dir is neither listed nor read', async () => {
  const { host, root, cleanup } = boot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-mv-secret-'));
  try {
    // Well-formed as a unit, so nothing but the containment check can exclude
    // it: a parse failure would produce the same empty list for the wrong reason.
    const secret = path.join(outside, 'secret.md');
    fs.writeFileSync(secret, '---\nid: secret\nlearned_at: 2026-07-30T10:00:00.000Z\n---\n\nSECRET BODY\n');

    const control = writeUnit(root, 'clodex', 'mem-1-aaaaaa', { body: 'the control body' });
    fs.symlinkSync(secret, path.join(root, 'clodex', 'planted.md'));

    const res = await host.dispatch('memory-viewer', 'units', ['clodex'], 'desktop');

    // ENTER: the control unit is present, so the assertions below run against a
    // list the guard did NOT empty.
    assert.deepEqual(res.units.map((u) => u.key), ['mem-1-aaaaaa'],
      'the planted link is absent and the real unit beside it survives');
    assert.equal(res.units[0].body, 'the control body');
    assert.equal(JSON.stringify(res).includes('SECRET BODY'), false,
      'the out-of-root body never reaches the renderer, under any key');
    assert.ok(fs.existsSync(control) && fs.existsSync(secret),
      'the refusal is a read refusal — it deletes nothing');
  } finally { fs.rmSync(outside, { recursive: true, force: true }); cleanup(); }
});

test('memory-viewer: a symlink to a SIBLING agent dir prefix is refused too', async () => {
  // `startsWith(base)` without path.sep admits `<root>/clodex-evil/x.md` while
  // reading agent `clodex`. The separator is what makes the prefix a boundary.
  const { host, root, cleanup } = boot();
  try {
    writeUnit(root, 'clodex-evil', 'mem-9-zzzzzz', { body: 'NEIGHBOUR BODY' });
    const control = writeUnit(root, 'clodex', 'mem-1-aaaaaa', { body: 'the control body' });

    fs.symlinkSync(path.join(root, 'clodex-evil', 'mem-9-zzzzzz.md'), path.join(root, 'clodex', 'planted.md'));

    const res = await host.dispatch('memory-viewer', 'units', ['clodex'], 'desktop');
    // ENTER: the control survives, so an empty-list guard cannot pass this.
    assert.deepEqual(res.units.map((u) => u.key), ['mem-1-aaaaaa']);
    assert.equal(JSON.stringify(res).includes('NEIGHBOUR BODY'), false);
    assert.ok(fs.existsSync(control));
  } finally { cleanup(); }
});

test('memory-viewer: an agent dir that is itself a symlink out is not listed and reads empty', async () => {
  // `agent` arrives over IPC and need not have come from the agents listing, so
  // the folder is confined on the read path as well as excluded from the list.
  const { host, root, cleanup } = boot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-mv-secret-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.md'),
      '---\nid: secret\nlearned_at: 2026-07-30T10:00:00.000Z\n---\n\nSECRET BODY\n');
    fs.symlinkSync(outside, path.join(root, 'elsewhere'));
    writeUnit(root, 'clodex', 'mem-1-aaaaaa', { body: 'the control body' });

    const agents = await host.dispatch('memory-viewer', 'agents', [], 'desktop');
    // ENTER: the real agent is listed, so this is not a blanket empty listing.
    assert.deepEqual(agents.agents.map((a) => a.agent), ['clodex'],
      'a symlinked folder is not an agent row; the real one still is');

    const res = await host.dispatch('memory-viewer', 'units', ['elsewhere'], 'desktop');
    assert.deepEqual(res.units, [], 'and naming it directly over IPC reads nothing');
    assert.equal(JSON.stringify(res).includes('SECRET BODY'), false);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); cleanup(); }
});

test('memory-viewer: an agent dir aliased to a SIBLING agent dir renders nothing', async () => {
  // Confining the folder to the ROOT is not enough: `<root>/alias -> <root>/real`
  // never leaves the root, so every per-entry check passes and agent `alias`
  // renders `real`'s memories under its own name. The folder must resolve to
  // itself, which a legitimate one does and an alias cannot.
  const { host, root, cleanup } = boot();
  try {
    writeUnit(root, 'real', 'mem-7-rrrrrr', { body: 'the sibling body' });
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'));

    const aliased = await host.dispatch('memory-viewer', 'units', ['alias'], 'desktop');
    assert.deepEqual(aliased.units, [], 'the aliased name reads nothing');
    assert.equal(JSON.stringify(aliased).includes('the sibling body'), false,
      "the sibling's body never reaches the renderer under the alias");

    // CONTROL: the real folder still reads, so this is a refusal of the alias
    // and not of the store — an engine that returned [] always would pass above.
    const direct = await host.dispatch('memory-viewer', 'units', ['real'], 'desktop');
    assert.deepEqual(direct.units.map((u) => u.body), ['the sibling body'],
      'the real folder is unaffected');
  } finally { cleanup(); }
});

test('memory-viewer: a HARDLINK planted in the agent dir is neither listed nor read', async () => {
  // A hardlink's realpath IS the in-dir path, so every path-based guard admits
  // it and readFileSync serves the outside file's bytes. Only the open-time
  // link count can tell it from a real unit.
  const { host, root, cleanup } = boot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-mv-secret-'));
  try {
    // Well-formed as a unit, so only the containment check can exclude it.
    const secret = path.join(outside, 'secret.md');
    fs.writeFileSync(secret, '---\nid: secret\nlearned_at: 2026-07-30T10:00:00.000Z\n---\n\nHARDLINKED BODY\n');

    const control = writeUnit(root, 'clodex', 'mem-1-aaaaaa', { body: 'the control body' });
    fs.linkSync(secret, path.join(root, 'clodex', 'planted.md'));

    const res = await host.dispatch('memory-viewer', 'units', ['clodex'], 'desktop');

    // ENTER: the control unit survives, so the absence below is the hardlink
    // being refused and not the whole folder going dark.
    assert.deepEqual(res.units.map((u) => u.key), ['mem-1-aaaaaa'],
      'the hardlink is absent and the real unit beside it survives');
    assert.equal(res.units[0].body, 'the control body');
    assert.equal(JSON.stringify(res).includes('HARDLINKED BODY'), false,
      'the outside file\'s text never reaches the renderer, under any key');
    assert.ok(fs.existsSync(control) && fs.existsSync(secret),
      'the refusal is a read refusal — it deletes nothing');
  } finally { fs.rmSync(outside, { recursive: true, force: true }); cleanup(); }
});

const VIEWER_ENGINE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'plugins', 'memory-viewer', 'engine.js'), 'utf-8');

// BOTH tokens, because either one alone still hangs. O_NONBLOCK is what lets
// the OPEN return on a writerless pipe; isFile() is what stops the READ that
// follows, which blocks on the same pipe even through a non-blocking fd.
const VIEWER_OPEN_SHAPE = [/O_NONBLOCK/, /isFile\(\)/];

// Declared BEFORE the FIFO subject because it is what keeps that subject's
// failure readable: a blocking read never returns, so it stops the event loop
// the test timeout itself lives on and the runner hangs with zero output
// instead of reddening. This subject turns that regression into one red line,
// and the subject below skips when it fails so the run still finishes.
test('memory-viewer: the unit open stays non-blocking — without it a planted FIFO hangs the suite', () => {
  for (const re of VIEWER_OPEN_SHAPE) {
    assert.match(VIEWER_ENGINE_SRC, re,
      `${re} is gone: a planted FIFO then hangs the overlay, and hangs this suite with no output`);
  }
});

test('memory-viewer: a FIFO planted in the agent dir is refused without blocking the read',
  { skip: process.platform === 'win32'
    ? 'mkfifo and O_NOFOLLOW are POSIX-only'
    : (VIEWER_OPEN_SHAPE.every((re) => re.test(VIEWER_ENGINE_SRC))
      ? false
      : 'the non-blocking open shape is gone from the engine — see the source-shape pin above') },
  async () => {
    // A blocking open on a writerless FIFO never returns, and readUnits runs
    // inside a synchronous IPC handler: the whole overlay hangs, so the
    // assertion that matters is that this test finishes at all.
    const { host, root, cleanup } = boot();
    try {
      writeUnit(root, 'clodex', 'mem-1-aaaaaa', { body: 'the control body' });
      const planted = path.join(root, 'clodex', 'planted.md');
      execFileSync('mkfifo', [planted]);

      const res = await host.dispatch('memory-viewer', 'units', ['clodex'], 'desktop');

      // ENTER: the control unit survives, so the absence below is the FIFO
      // being refused and not the whole folder going dark.
      assert.deepEqual(res.units.map((u) => u.key), ['mem-1-aaaaaa'],
        'the pipe is absent and the real unit beside it survives');
      assert.equal(res.units[0].body, 'the control body');
      assert.ok(fs.existsSync(planted),
        'the refusal is a read refusal — it deletes nothing');
    } finally { cleanup(); }
  });

test('memory-viewer: the store still reads when the ROOT itself is behind a symlink', async () => {
  // The guard compares against the RESOLVED root, so it must resolve the root
  // too — comparing a resolved entry against an unresolved root refuses every
  // legitimate unit, and on macOS /var → /private/var makes that the real case.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-mv-link-'));
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-mv-real-'));
  const prevHome = process.env.HOME;
  try {
    fs.mkdirSync(path.join(home, '.clodex', 'library'), { recursive: true });
    fs.symlinkSync(real, path.join(home, '.clodex', 'library', 'memory'));
    writeUnit(path.join(home, '.clodex', 'library', 'memory'), 'clodex', 'mem-1-aaaaaa', { body: 'through the link' });

    process.env.HOME = home;
    delete require.cache[require.resolve('../plugins/memory-viewer/engine')];
    const engine = require('../plugins/memory-viewer/engine');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-mv-data-'));
    const host = createPluginHostEngine({
      manager: {
        sessions: new Map(),
        list: () => [], listForWorkspace: () => [],
        _broadcast() {}, _sendToSession() {}, windowForWorkspace: () => null,
      },
      getUiSettings: () => ({ get: () => ({}), set: () => {} }),
      log: { info: () => {}, error: () => {} },
      userDataPath: dir,
      fs, path,
      gitWorktree: {},
      libraryKinds: { memory: () => ({ ok: true }) },
    });
    host.register('memory-viewer', engine, { hostApi: HOST_API_VERSION });

    const res = await host.dispatch('memory-viewer', 'units', ['clodex'], 'desktop');
    assert.deepEqual(res.units.map((u) => u.body), ['through the link'],
      'a symlinked root resolves on both sides of the comparison, so units still list');
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    delete require.cache[require.resolve('../plugins/memory-viewer/engine')];
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test('memory-viewer: the engine registers exactly four rows, its two mutations among them', async () => {
  const { host, cleanup } = boot();
  try {
    // Asserted exactly: each row is a channel the renderer can call, and the two
    // mutations (forget, setPin) are the plugin's whole write surface.
    assert.deepEqual(host._dispatchKeys().sort(), [
      'memory-viewer:agents', 'memory-viewer:forget', 'memory-viewer:setPin', 'memory-viewer:units',
    ]);
  } finally { cleanup(); }
});
