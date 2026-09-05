'use strict';
// Run: node --test test/env-defaults-seed.test.js
//
// t676 — Clodex's shipped env vars (resources/env-defaults.json) are seeded into
// the GLOBAL env scope at initStores, ONCE PER KEY EVER.
//
// The whole design lives in that "once ever". A plain seed-if-absent would look
// identical on a fresh profile and undo the operator on every launch after: they
// delete a key, quit, and the next launch writes it straight back. The `seeded`
// list on env-scopes.json is the memory that makes a deletion stick, so the
// cases below assert the WHOLE file object after each launch — a partial check
// on `global` alone passes over a `seeded` list that was never written or was
// dropped by the store's own normalizing _load, and either one silently restores
// the every-launch behaviour on the NEXT launch rather than this one.
//
// These drive the real initStores against temp dirs and a fixture defaults file
// (never resources/env-defaults.json, except the one case that names it).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initStores } = require('../stores');
const { loadEnvDefaults, planEnvSeed } = require('../env-defaults');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SHIPPED = path.join(__dirname, '..', 'resources', 'env-defaults.json');

function withDirs(fn) {
  const userData = mkTmpRoot('envdef-ud-');
  const registryDir = mkTmpRoot('envdef-reg-');
  const scopesFile = path.join(userData, 'env-scopes.json');
  try {
    return fn({ userData, registryDir, scopesFile });
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
}

// One "launch": a fresh initStores over the SAME userData, which is what a
// relaunch is. resourcesDir/skillsResourcesDir are pointed at nothing so the
// library seeder does no work here.
function launch({ userData, registryDir }, envDefaultsFile) {
  return initStores(userData, {
    log: { info() {}, warn() {}, error() {} },
    registryDir,
    resourcesDir: path.join(registryDir, '__no_seed__'),
    skillsResourcesDir: path.join(registryDir, '__no_seed_skills__'),
    envDefaultsFile,
  });
}

function writeDefaults(dir, obj) {
  const p = path.join(dir, 'env-defaults.json');
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

const readScopes = (scopesFile) => JSON.parse(fs.readFileSync(scopesFile, 'utf-8'));

const FIXTURE = {
  ALPHA: { value: 'a', note: 'the alpha note' },
  BETA: { value: 'b', note: 'the beta note' },
};

const entry = (value) => ({ value, secret: false });

// --- the shipped file itself -------------------------------------------------

test('the shipped defaults file carries exactly the five keys Clodex promises, with a note each', () => {
  // The DEFAULT source, deliberately: this is the one case that pins the real
  // resources/env-defaults.json rather than a fixture. Every other case below
  // would stay green if the file were emptied.
  const defaults = loadEnvDefaults(SHIPPED);
  assert.deepStrictEqual(Object.keys(defaults).sort(), [
    'CLAUDE_CODE_BASH_OUTPUT_AUDIENCE_NOTE',
    'CLAUDE_CODE_COZY_TEAPOT',
    'CLAUDE_CODE_TOTAL_TOKENS_REMINDER',
    'CLAUDE_CODE_TURN_UPDATES',
    'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
  ]);
  assert.strictEqual(defaults.CLAUDE_STREAM_IDLE_TIMEOUT_MS.value, '1800000',
    'the CLI clamps to [1, 1800000]; nothing higher is expressible');
  assert.strictEqual(defaults.CLAUDE_CODE_TOTAL_TOKENS_REMINDER.value, 'off');
  assert.strictEqual(defaults.CLAUDE_CODE_BASH_OUTPUT_AUDIENCE_NOTE.value, 'off');
  assert.strictEqual(defaults.CLAUDE_CODE_TURN_UPDATES.value, 'false');
  assert.strictEqual(defaults.CLAUDE_CODE_COZY_TEAPOT.value, 'relaxed');
  for (const [key, rec] of Object.entries(defaults)) {
    // The note is the GUI's whole explanation of the key — an empty one ships a
    // var the operator is asked to trust with no account of what it does.
    assert.ok(rec.note && rec.note.length > 20, `${key} must ship a real one-line note`);
  }
});

test('a shipped key with a value the scope store would reject never reaches the seed', () => {
  // loadEnvDefaults runs envKeyError, so a hand-edit that put a newline or the
  // deny key into the file drops that entry instead of throwing at launch.
  const src = mkTmpRoot('envdef-src-');
  try {
    const file = writeDefaults(src, {
      OK: { value: 'fine', note: 'n' },
      CLODEX_REMOTE_TOKEN: { value: 'leak', note: 'n' },
      '2BAD': { value: 'x', note: 'n' },
      NEWLINE: { value: 'a\nb', note: 'n' },
      NOVALUE: { note: 'n' },
    });
    assert.deepStrictEqual(Object.keys(loadEnvDefaults(file)), ['OK']);
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});

test('an absent or malformed defaults file reads as {} rather than throwing', () => {
  assert.deepStrictEqual(loadEnvDefaults('/no/such/env-defaults.json'), {});
  const src = mkTmpRoot('envdef-src-');
  try {
    const p = path.join(src, 'x.json');
    fs.writeFileSync(p, 'not json at all');
    assert.deepStrictEqual(loadEnvDefaults(p), {});
    fs.writeFileSync(p, '["an","array"]');
    assert.deepStrictEqual(loadEnvDefaults(p), {});
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});

// --- seeding across launches -------------------------------------------------

test('first launch: every shipped key lands in global and on the seeded list', () => {
  withDirs((dirs) => {
    const src = mkTmpRoot('envdef-src-');
    try {
      launch(dirs, writeDefaults(src, FIXTURE));
      assert.deepStrictEqual(readScopes(dirs.scopesFile), {
        global: { ALPHA: entry('a'), BETA: entry('b') },
        workspaces: {},
        seeded: ['ALPHA', 'BETA'],
      });
    } finally { fs.rmSync(src, { recursive: true, force: true }); }
  });
});

test('a DELETED default stays deleted across a relaunch — the whole point of the seeded list', () => {
  withDirs((dirs) => {
    const src = mkTmpRoot('envdef-src-');
    try {
      const file = writeDefaults(src, FIXTURE);
      const stores = launch(dirs, file);
      // ENTER: the first launch actually seeded, or the delete below removes
      // nothing and the relaunch assertion holds for the wrong reason.
      assert.deepStrictEqual(Object.keys(stores.envScopes.getScope('global')).sort(), ['ALPHA', 'BETA']);

      stores.envScopes.remove('global', 'ALPHA');
      assert.deepStrictEqual(readScopes(dirs.scopesFile).seeded, ['ALPHA', 'BETA'],
        'remove() must not drop the seeded list — the store normalizes the whole file on every save');

      launch(dirs, file);
      assert.deepStrictEqual(readScopes(dirs.scopesFile), {
        global: { BETA: entry('b') },
        workspaces: {},
        seeded: ['ALPHA', 'BETA'],
      });
    } finally { fs.rmSync(src, { recursive: true, force: true }); }
  });
});

test('an EDITED default keeps the operator value across a relaunch', () => {
  withDirs((dirs) => {
    const src = mkTmpRoot('envdef-src-');
    try {
      const file = writeDefaults(src, FIXTURE);
      const stores = launch(dirs, file);
      stores.envScopes.set('global', 'ALPHA', 'mine', false);

      launch(dirs, file);
      assert.deepStrictEqual(readScopes(dirs.scopesFile), {
        global: { ALPHA: entry('mine'), BETA: entry('b') },
        workspaces: {},
        seeded: ['ALPHA', 'BETA'],
      });
    } finally { fs.rmSync(src, { recursive: true, force: true }); }
  });
});

test('a key ADDED to the shipped file in a later release is seeded on that release\'s first launch', () => {
  withDirs((dirs) => {
    const src = mkTmpRoot('envdef-src-');
    try {
      const stores = launch(dirs, writeDefaults(src, FIXTURE));
      stores.envScopes.remove('global', 'ALPHA'); // deleted under the old release

      launch(dirs, writeDefaults(src, { ...FIXTURE, GAMMA: { value: 'g', note: 'new in this release' } }));
      assert.deepStrictEqual(readScopes(dirs.scopesFile), {
        global: { BETA: entry('b'), GAMMA: entry('g') },
        workspaces: {},
        seeded: ['ALPHA', 'BETA', 'GAMMA'],
      }, 'only the new key is seeded; the deleted one is still on the list and stays gone');
    } finally { fs.rmSync(src, { recursive: true, force: true }); }
  });
});

test('a shipped key the operator had ALREADY set by hand is never overwritten, and is banked as seeded', () => {
  withDirs((dirs) => {
    const src = mkTmpRoot('envdef-src-');
    try {
      // The operator set ALPHA themselves on a release that did not ship it.
      const stores = launch(dirs, path.join(src, '__none__.json'));
      stores.envScopes.set('global', 'ALPHA', 'theirs', false);

      launch(dirs, writeDefaults(src, FIXTURE));
      assert.deepStrictEqual(readScopes(dirs.scopesFile), {
        global: { ALPHA: entry('theirs'), BETA: entry('b') },
        workspaces: {},
        seeded: ['ALPHA', 'BETA'],
      }, 'ALPHA is banked without being written, so deleting it later does not resurrect it');
    } finally { fs.rmSync(src, { recursive: true, force: true }); }
  });
});

test('a second launch with nothing changed rewrites nothing', () => {
  withDirs((dirs) => {
    const src = mkTmpRoot('envdef-src-');
    try {
      const file = writeDefaults(src, FIXTURE);
      launch(dirs, file);
      const before = fs.statSync(dirs.scopesFile).mtimeMs;
      const bytes = fs.readFileSync(dirs.scopesFile, 'utf-8');
      launch(dirs, file);
      assert.strictEqual(fs.readFileSync(dirs.scopesFile, 'utf-8'), bytes);
      assert.strictEqual(fs.statSync(dirs.scopesFile).mtimeMs, before,
        'a no-op launch must not touch the file at all — the store chmods 0600 on every save');
    } finally { fs.rmSync(src, { recursive: true, force: true }); }
  });
});

test('workspace scopes are untouched by seeding', () => {
  withDirs((dirs) => {
    const src = mkTmpRoot('envdef-src-');
    try {
      const stores = launch(dirs, path.join(src, '__none__.json'));
      stores.envScopes.set('ws-1', 'ALPHA', 'ws-value', false);

      launch(dirs, writeDefaults(src, FIXTURE));
      assert.deepStrictEqual(readScopes(dirs.scopesFile), {
        global: { ALPHA: entry('a'), BETA: entry('b') },
        workspaces: { 'ws-1': { ALPHA: entry('ws-value') } },
        seeded: ['ALPHA', 'BETA'],
      }, 'a workspace key of the same name is a different entry and neither blocks nor receives the seed');
    } finally { fs.rmSync(src, { recursive: true, force: true }); }
  });
});

// --- the NODE_TEST_CONTEXT safety net ----------------------------------------

test('initStores refuses to seed env defaults into the real home under node --test', () => {
  // Mirrors seedLibraryDefaults' net (test/engine-registry-dir-seam.test.js).
  // Under a FAKE home, so a regression that drops the guard writes the fake tree
  // and fails here rather than writing the operator's own env-scopes.json.
  const prevHome = process.env.HOME;
  const fakeHome = mkTmpRoot('envdef-home-');
  const userData = mkTmpRoot('envdef-realud-');
  const src = mkTmpRoot('envdef-src-');
  process.env.HOME = fakeHome;
  const warnings = [];
  try {
    assert.ok(process.env.NODE_TEST_CONTEXT,
      'this test is meaningless unless node --test marks the process');
    assert.strictEqual(os.homedir(), fakeHome,
      'ENTER: the fixture must actually move homedir, or this is about the real home');

    initStores(userData, {
      log: { info() {}, warn: (...a) => warnings.push(a.join(' ')), error() {} },
      registryDir: path.join(fakeHome, '.clodex'), // the mistake the net catches
      resourcesDir: path.join(src, '__no_seed__'),
      skillsResourcesDir: path.join(src, '__no_seed_skills__'),
      envDefaultsFile: writeDefaults(src, FIXTURE),
    });

    assert.ok(warnings.some((w) => /refusing to seed env defaults/.test(w)),
      `the guard must announce itself; got ${JSON.stringify(warnings)}`);
    assert.strictEqual(fs.existsSync(path.join(userData, 'env-scopes.json')), false,
      'the guard must leave env-scopes.json uncreated');
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test('envDefaults.restore() carries the same NODE_TEST_CONTEXT guard as construction', () => {
  // t681: restore() used to clear `seeded` and _save BEFORE this guard ran
  // (it only reached seedEnvDefaults()'s copy), so a refused restore still
  // stripped the shipped keys off the list and left env-scopes.json rewritten
  // under the real home. Pre-seeding the file (rather than letting
  // construction write it) isolates restore()'s own guard: construction's
  // seedEnvDefaults() is refused too, so the file below is untouched by it.
  const prevHome = process.env.HOME;
  const fakeHome = mkTmpRoot('envdef-home2-');
  const userData = mkTmpRoot('envdef-realud2-');
  const src = mkTmpRoot('envdef-src2-');
  process.env.HOME = fakeHome;
  try {
    assert.ok(process.env.NODE_TEST_CONTEXT,
      'this test is meaningless unless node --test marks the process');
    const scopesFile = path.join(userData, 'env-scopes.json');
    fs.mkdirSync(userData, { recursive: true });
    const before = { global: { ALPHA: entry('a') }, workspaces: {}, seeded: ['ALPHA', 'BETA'] };
    fs.writeFileSync(scopesFile, JSON.stringify(before, null, 2));

    const stores = initStores(userData, {
      log: { info() {}, warn() {}, error() {} },
      registryDir: path.join(fakeHome, '.clodex'),
      resourcesDir: path.join(src, '__no_seed__'),
      skillsResourcesDir: path.join(src, '__no_seed_skills__'),
      envDefaultsFile: writeDefaults(src, FIXTURE),
    });
    stores.envDefaults.restore();

    assert.deepStrictEqual(JSON.parse(fs.readFileSync(scopesFile, 'utf-8')), before,
      '`seeded` and the rest of the file are untouched by a refused restore');
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

// --- Restore shipped defaults ------------------------------------------------

test('restore: deleted keys come back, an edited one is left alone', () => {
  withDirs((dirs) => {
    const src = mkTmpRoot('envdef-src-');
    try {
      const three = { ...FIXTURE, GAMMA: { value: 'g', note: 'the gamma note' } };
      const stores = launch(dirs, writeDefaults(src, three));
      stores.envScopes.remove('global', 'ALPHA');
      stores.envScopes.remove('global', 'BETA');
      stores.envScopes.set('global', 'GAMMA', 'edited-by-hand', false);

      stores.envDefaults.restore();

      assert.deepStrictEqual(readScopes(dirs.scopesFile), {
        global: { GAMMA: entry('edited-by-hand'), ALPHA: entry('a'), BETA: entry('b') },
        workspaces: {},
        seeded: ['ALPHA', 'BETA', 'GAMMA'],
      }, 'both deletions restored, the edit untouched, and the list back to complete');
    } finally { fs.rmSync(src, { recursive: true, force: true }); }
  });
});

test('restore: a NON-shipped global key the operator added is never disturbed', () => {
  withDirs((dirs) => {
    const src = mkTmpRoot('envdef-src-');
    try {
      const stores = launch(dirs, writeDefaults(src, FIXTURE));
      stores.envScopes.set('global', 'MY_OWN', 'keep-me', false);
      stores.envScopes.remove('global', 'ALPHA');

      stores.envDefaults.restore();

      assert.deepStrictEqual(readScopes(dirs.scopesFile), {
        global: { BETA: entry('b'), MY_OWN: entry('keep-me'), ALPHA: entry('a') },
        workspaces: {},
        seeded: ['ALPHA', 'BETA'],
      });
    } finally { fs.rmSync(src, { recursive: true, force: true }); }
  });
});

test('restore then relaunch: a key deleted AFTER the restore stays deleted again', () => {
  // The restore must not leave the seeder permanently re-armed — it clears the
  // shipped keys off the list, and the seed it triggers must put them back.
  withDirs((dirs) => {
    const src = mkTmpRoot('envdef-src-');
    try {
      const file = writeDefaults(src, FIXTURE);
      const stores = launch(dirs, file);
      stores.envDefaults.restore();
      stores.envScopes.remove('global', 'BETA');

      launch(dirs, file);
      assert.deepStrictEqual(readScopes(dirs.scopesFile), {
        global: { ALPHA: entry('a') },
        workspaces: {},
        seeded: ['ALPHA', 'BETA'],
      });
    } finally { fs.rmSync(src, { recursive: true, force: true }); }
  });
});

test('envDefaults.list() exposes the notes the GUI shows', () => {
  withDirs((dirs) => {
    const src = mkTmpRoot('envdef-src-');
    try {
      const stores = launch(dirs, writeDefaults(src, FIXTURE));
      assert.deepStrictEqual(stores.envDefaults.list(), {
        ALPHA: { value: 'a', note: 'the alpha note' },
        BETA: { value: 'b', note: 'the beta note' },
      });
    } finally { fs.rmSync(src, { recursive: true, force: true }); }
  });
});

// --- planEnvSeed, directly ---------------------------------------------------

test('planEnvSeed: a key on the seeded list is never written again, present or absent', () => {
  assert.deepStrictEqual(
    planEnvSeed({ defaults: FIXTURE, global: {}, seeded: ['ALPHA'] }),
    { writes: [{ key: 'BETA', value: 'b' }], seeded: ['ALPHA', 'BETA'] });
  assert.deepStrictEqual(
    planEnvSeed({ defaults: FIXTURE, global: { ALPHA: {}, BETA: {} }, seeded: ['ALPHA', 'BETA'] }),
    { writes: [], seeded: ['ALPHA', 'BETA'] });
});

test('planEnvSeed: a junk seeded list degrades to "nothing seeded yet", never throws', () => {
  for (const junk of [null, undefined, 'ALPHA', 42, [1, 2, null]]) {
    const plan = planEnvSeed({ defaults: FIXTURE, global: {}, seeded: junk });
    assert.deepStrictEqual(plan.writes.map((w) => w.key), ['ALPHA', 'BETA'],
      `a ${JSON.stringify(junk)} list must re-seed rather than crash the launch`);
    assert.deepStrictEqual(plan.seeded, ['ALPHA', 'BETA']);
  }
});
