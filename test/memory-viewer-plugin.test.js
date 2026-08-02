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

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

    const before = await host.dispatch('memory-viewer', 'units', ['clodex']);
    assert.equal(before.units.length, 1);

    const res = await host.dispatch('memory-viewer', 'forget', [{ agent: 'clodex', id: 'mem-1-aaaaaa' }]);
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(removals, [{ agent: 'clodex', id: 'mem-1-aaaaaa' }],
      'the ref core receives carries exactly agent + id');
    assert.equal(fs.existsSync(file), false);

    const after = await host.dispatch('memory-viewer', 'units', ['clodex']);
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
    const res = await host.dispatch('memory-viewer', 'forget', [{ agent: 'clodex', id: 'mem-1-aaaaaa' }]);
    assert.deepEqual(res, { ok: false, error: 'core refused' });
    assert.ok(fs.existsSync(file),
      'a refused seam must leave the unit on disk — the plugin must not unlink it');
  } finally { cleanup(); }
});

test('memory-viewer: forget vets the AGENT through agentDir before the seam sees it', async () => {
  const { host, removals, cleanup } = boot();
  try {
    for (const agent of ['..', '.', '../../etc', 'has/slash', '', null, undefined, 42, {}]) {
      const res = await host.dispatch('memory-viewer', 'forget', [{ agent, id: 'mem-1-aaaaaa' }]);
      assert.equal(res.ok, false, `${String(agent)} must be refused`);
      assert.match(res.error, /valid agent name/);
    }
    // A missing payload is the same refusal, not a crash.
    for (const payload of [null, undefined, 'nope']) {
      const res = await host.dispatch('memory-viewer', 'forget', [payload]);
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
    const res = await host.dispatch('memory-viewer', 'forget', [{ agent: 'clodex', id: '../evil' }]);
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

    const list = await host.dispatch('memory-viewer', 'units', ['clodex']);
    const shown = list.units.find((u) => u.body === 'the one on screen');
    assert.equal(shown.key, 'mem-1-aaaaaa', 'key is the basename');
    assert.equal(shown.id, 'mem-2-bbbbbb', 'the id line is preserved for display');
    assert.equal(shown.idMismatch, true, 'the disagreement is surfaced, not silently resolved');

    await host.dispatch('memory-viewer', 'forget', [{ agent: 'clodex', id: shown.key }]);
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
    const list = await host.dispatch('memory-viewer', 'units', ['clodex']);
    const u = list.units[0];
    assert.equal(u.key, 'mem-3-cccccc');
    assert.equal(u.id, 'mem-3-cccccc', 'display falls back to the basename, like core list()');
    assert.equal(u.idMismatch, false, 'an absent id line is not a disagreement');

    const res = await host.dispatch('memory-viewer', 'forget', [{ agent: 'clodex', id: u.key }]);
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(removals, [{ agent: 'clodex', id: 'mem-3-cccccc' }]);
    assert.equal(fs.existsSync(file), false);
  } finally { cleanup(); }
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
