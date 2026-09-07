'use strict';

// plugin-update-watch.js — "is there a newer version of this installed plugin?"
//
// THE WHOLE POINT IS THE TWO STAGES, and the reason is that the cheap one is
// wrong on its own. `libraryCatalog`'s `upToDate` compares the plugin's sidecar
// commit against the LIBRARY REPO's HEAD, so it goes false for every installed
// plugin the moment ANY plugin in that repo changes. Badging on it would put a
// permanent, false "Update available" on every row. `resolveUpdate(id)` fetches
// the plugin's own subpath and answers per plugin — so the catalog is only a
// CANDIDATE filter, and a badge exists only where resolveUpdate said `changed`.
//
// The fixture is a stub loader that RECORDS which ids resolveUpdate was asked
// about. That list is the assertion for the cap and for the filter alike: a
// checker that resolved everything would still produce a correct badge list on
// a small fixture, and only the call record can tell the two apart.

const { test } = require('node:test');
const assert = require('node:assert');

const { createPluginUpdateWatch } = require('../plugin-update-watch.js');

// rows: { id, installed, upToDate }[] ; verdicts: id -> resolveUpdate reply.
// An id absent from `verdicts` answers a refusal, which is the offline shape.
function mkLoader(rows, verdicts) {
  const asked = [];
  return {
    asked,
    loader: {
      libraryCatalog: async () => ({ ok: true, repo: 'avirtual/clodex-plugins', commit: 'lib9999', plugins: rows }),
      resolveUpdate: async (id) => {
        asked.push(id);
        const v = verdicts[id];
        if (!v) return { ok: false, error: `no answer for ${id}` };
        return v;
      },
    },
  };
}

function changed(previousCommit, commit, version) {
  return { ok: true, changed: true, previousCommit, commit, manifest: { version } };
}

function unchanged(commit) {
  return { ok: true, changed: false, previousCommit: commit, commit, manifest: { version: '1.0.0' } };
}

const silent = { info: () => {} };

// ── the candidate / confirmation split ──────────────────────────────────────

test('the library repo moving badges only the plugin whose own tree changed', async () => {
  // The failure this ticket exists to prevent, as a fixture: the library repo
  // moved, so BOTH installed plugins are candidates (upToDate:false). Only `y`
  // really changed. `x` must get no badge — a checker that trusted the cheap
  // flag would badge both, forever.
  const { loader, asked } = mkLoader(
    [
      { id: 'x', installed: 'fetched', upToDate: false },
      { id: 'y', installed: 'fetched', upToDate: false },
    ],
    { x: unchanged('aaaaaaa'), y: changed('bbbbbbb', 'ccccccc', '1.2.0') },
  );
  const w = createPluginUpdateWatch({ getLoader: () => loader, log: silent });
  await w.run();
  assert.deepStrictEqual(asked, ['x', 'y'],
    'ENTER: both candidates were confirmed against resolveUpdate, so the single-entry list below '
    + 'is a verdict about x and not a candidate filter that dropped it');
  assert.deepStrictEqual(w.list(), [
    { id: 'y', from: 'bbbbbbb', to: 'ccccccc', version: '1.2.0' },
  ]);
});

test('only fetched rows whose cheap flag is false become candidates', async () => {
  // The other half of the filter. A core plugin, the operator's own folder, a
  // registered symlink and an up-to-date fetch are all NOT candidates — none of
  // them may cost a network fetch, which is what the call record proves.
  const { loader, asked } = mkLoader(
    [
      { id: 'core-one', installed: 'core', upToDate: false },
      { id: 'mine', installed: 'user-authored', upToDate: false },
      { id: 'linked', installed: 'registered', upToDate: false },
      { id: 'absent', installed: 'none', upToDate: false },
      { id: 'current', installed: 'fetched', upToDate: true },
      { id: 'stale', installed: 'fetched', upToDate: false },
    ],
    { stale: changed('1111111', '2222222', '2.0.0') },
  );
  const w = createPluginUpdateWatch({ getLoader: () => loader, log: silent });
  await w.run();
  assert.deepStrictEqual(asked, ['stale'], 'exactly one row earned a fetch');
  assert.deepStrictEqual(w.list().map((e) => e.id), ['stale']);
});

// ── the fetch-storm cap ─────────────────────────────────────────────────────

test('a run confirms at most eight candidates, however many there are', async () => {
  const rows = [];
  const verdicts = {};
  for (let i = 0; i < 20; i++) {
    const id = `p${String(i).padStart(2, '0')}`;
    rows.push({ id, installed: 'fetched', upToDate: false });
    verdicts[id] = changed('0000000', `fff${i}`, `1.${i}.0`);
  }
  const { loader, asked } = mkLoader(rows, verdicts);
  const w = createPluginUpdateWatch({ getLoader: () => loader, log: silent });
  await w.run();
  assert.strictEqual(asked.length, 8,
    '20 candidates must not mean 20 tarball fetches in one tick');
  assert.strictEqual(w.list().length, 8, 'the rest wait for the next tick');
});

test('the next run reaches the candidates the cap held back', async () => {
  // A fixed first-eight window would starve the tail forever: plugin 9 would
  // never be confirmed and never badge, no matter how long Clodex ran.
  const rows = [];
  const verdicts = {};
  for (let i = 0; i < 20; i++) {
    const id = `p${String(i).padStart(2, '0')}`;
    rows.push({ id, installed: 'fetched', upToDate: false });
    verdicts[id] = unchanged('0000000');
  }
  const { loader, asked } = mkLoader(rows, verdicts);
  const w = createPluginUpdateWatch({ getLoader: () => loader, log: silent });
  await w.run();
  await w.run();
  assert.deepStrictEqual(asked.slice(0, 8), rows.slice(0, 8).map((r) => r.id),
    'ENTER: the first run took the first eight, so the second run below is measured against a real window');
  assert.deepStrictEqual(asked.slice(8), rows.slice(8, 16).map((r) => r.id),
    'the second run advances past the eight already answered');
});

// ── failure keeps the prior answer ──────────────────────────────────────────

test('a failing resolveUpdate leaves the previous list intact, it does not clear it', async () => {
  // Offline must not silently un-badge a real update. The reverse mistake —
  // treating a refusal as `changed` — is covered by the second half.
  const rows = [{ id: 'y', installed: 'fetched', upToDate: false }];
  let answer = changed('bbbbbbb', 'ccccccc', '1.2.0');
  const loader = {
    libraryCatalog: async () => ({ ok: true, repo: 'r', commit: 'lib9999', plugins: rows }),
    resolveUpdate: async () => answer,
  };
  const w = createPluginUpdateWatch({ getLoader: () => loader, log: silent });
  await w.run();
  const before = w.list();
  assert.deepStrictEqual(before, [{ id: 'y', from: 'bbbbbbb', to: 'ccccccc', version: '1.2.0' }],
    'ENTER: there is a real badge to lose, so the equality below is not two empty lists agreeing');
  answer = { ok: false, error: 'getaddrinfo ENOTFOUND github.com' };
  await w.run();
  assert.deepStrictEqual(w.list(), before, 'the badge survives an offline tick');
});

test('a failing catalog fetch leaves the previous list intact and costs no resolveUpdate', async () => {
  const rows = [{ id: 'y', installed: 'fetched', upToDate: false }];
  let cat = { ok: true, repo: 'r', commit: 'lib9999', plugins: rows };
  const asked = [];
  const loader = {
    libraryCatalog: async () => cat,
    resolveUpdate: async (id) => { asked.push(id); return changed('bbbbbbb', 'ccccccc', '1.2.0'); },
  };
  const w = createPluginUpdateWatch({ getLoader: () => loader, log: silent });
  await w.run();
  assert.strictEqual(w.list().length, 1, 'ENTER: a badge exists before the failure');
  cat = { ok: false, error: 'no https dependency injected' };
  await w.run();
  assert.deepStrictEqual(asked, ['y'], 'a dead catalog must not be walked as if it had rows');
  assert.deepStrictEqual(w.list(), [{ id: 'y', from: 'bbbbbbb', to: 'ccccccc', version: '1.2.0' }]);
});

test('a plugin that stops being a candidate loses its badge', async () => {
  // The counterpart to "failure keeps the list": once the operator updates, the
  // row goes upToDate:true and the badge must go with it, without waiting for a
  // fetch that would now say `changed:false`.
  let rows = [{ id: 'y', installed: 'fetched', upToDate: false }];
  const loader = {
    libraryCatalog: async () => ({ ok: true, repo: 'r', commit: 'lib9999', plugins: rows }),
    resolveUpdate: async () => changed('bbbbbbb', 'ccccccc', '1.2.0'),
  };
  const w = createPluginUpdateWatch({ getLoader: () => loader, log: silent });
  await w.run();
  assert.strictEqual(w.list().length, 1, 'ENTER: the badge was there to lose');
  rows = [{ id: 'y', installed: 'fetched', upToDate: true }];
  await w.run();
  assert.deepStrictEqual(w.list(), []);
});

// ── shape ───────────────────────────────────────────────────────────────────

test('a version-less manifest still reports the update, with a null version', async () => {
  // The renderer's badge falls back to a bare "Update available" on a null, so a
  // manifest with no version must survive the checker rather than crash it.
  const { loader } = mkLoader(
    [{ id: 'y', installed: 'fetched', upToDate: false }],
    { y: { ok: true, changed: true, previousCommit: 'bbbbbbb', commit: 'ccccccc', manifest: {} } },
  );
  const w = createPluginUpdateWatch({ getLoader: () => loader, log: silent });
  await w.run();
  assert.deepStrictEqual(w.list(), [{ id: 'y', from: 'bbbbbbb', to: 'ccccccc', version: null }]);
});

test('two runs never overlap: a second call while one is in flight is a no-op', async () => {
  // resolveUpdate downloads and extracts a tarball per plugin. Two interleaved
  // runs would double that, and both would write the cache.
  let release;
  const gate = new Promise((r) => { release = r; });
  const asked = [];
  const loader = {
    libraryCatalog: async () => {
      await gate;
      return { ok: true, repo: 'r', commit: 'lib9999', plugins: [{ id: 'y', installed: 'fetched', upToDate: false }] };
    },
    resolveUpdate: async (id) => { asked.push(id); return changed('bbbbbbb', 'ccccccc', '1.2.0'); },
  };
  const w = createPluginUpdateWatch({ getLoader: () => loader, log: silent });
  const first = w.run();
  const second = w.run();
  release();
  await Promise.all([first, second]);
  assert.deepStrictEqual(asked, ['y'], 'the second call returned the cache instead of starting a second sweep');
});

test('no loader at all (CLODEX_PLUGINS=0) is an empty list, not a throw', async () => {
  const w = createPluginUpdateWatch({ getLoader: () => null, log: silent });
  assert.deepStrictEqual(await w.run(), []);
  assert.deepStrictEqual(w.list(), []);
});

test('list() hands out a copy — a caller mutating it cannot empty the cache', async () => {
  const { loader } = mkLoader(
    [{ id: 'y', installed: 'fetched', upToDate: false }],
    { y: changed('bbbbbbb', 'ccccccc', '1.2.0') },
  );
  const w = createPluginUpdateWatch({ getLoader: () => loader, log: silent });
  await w.run();
  w.list().length = 0;
  assert.strictEqual(w.list().length, 1);
});

test('onChange fires when the confirmed set changes and stays quiet when it does not', async () => {
  // The menu label is rebuilt from this callback. Firing on every tick would
  // rebuild the whole application menu every six hours for nothing; never firing
  // would leave the count stale until some other event rebuilt it.
  const rows = [{ id: 'y', installed: 'fetched', upToDate: false }];
  const loader = {
    libraryCatalog: async () => ({ ok: true, repo: 'r', commit: 'lib9999', plugins: rows }),
    resolveUpdate: async () => changed('bbbbbbb', 'ccccccc', '1.2.0'),
  };
  let fired = 0;
  const w = createPluginUpdateWatch({ getLoader: () => loader, log: silent, onChange: () => { fired++; } });
  await w.run();
  assert.strictEqual(fired, 1, 'the first confirmation is a change from nothing');
  await w.run();
  assert.strictEqual(fired, 1, 'the same answer twice is not a change');
});
