'use strict';

// first-run-setup.test.js — the marker that makes the Welcome dialog a ONE-TIME
// question, and the single IPC that answers it.
//
// Two halves, and the split matters. The store half runs against a real
// initStores over a tmp registryDir, because the thing being pinned is a file on
// disk: its path, its mode, and what an unreadable one reads back as. A stub
// store would assert this file's idea of a marker rather than the one the app
// writes.
//
// The IPC half is where the interesting failure lives. `setup:complete` carries
// TWO writes — the mode into ui-settings, the marker onto disk — and they are one
// handler precisely so a box cannot end up never asking again and never applying
// the answer. So each subject asserts BOTH sides, including the ones where one
// side must NOT move: 'skipped' writing the marker is uninteresting on its own,
// and only the surviving defaultSessionMode says the skip did not quietly reset
// the mode to its default.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { initStores } = require('../stores.js');
const { registerIpcHandlers } = require('../ipc-handlers');
const { mkTmpRoot } = require('./lib/tmp-roots');

function openStores() {
  const dir = mkTmpRoot('clodex-first-run-');
  const registryDir = path.join(dir, 'registry');
  // A resourcesDir that does not exist suppresses library seeding (the trick
  // test/stores.test.js and test/terminal-reports-pref.test.js both use).
  const stores = initStores(dir, {
    log: { info: () => {}, error: () => {} },
    registryDir,
    resourcesDir: path.join(dir, '__no_seed__'),
    skillsResourcesDir: path.join(dir, '__no_seed_skills__'),
    envDefaultsFile: path.join(dir, '__no_env_defaults__.json'),
  });
  return { stores, registryDir, setupFile: path.join(registryDir, 'setup.json') };
}

test('an absent marker reads as not done', () => {
  const { stores, setupFile } = openStores();
  assert.equal(fs.existsSync(setupFile), false, 'ENTER: nothing may have written the marker yet');
  assert.deepStrictEqual(stores.setupMarker.read(), { done: false });
});

test("write('standard') lands a 0600 marker that reads back done", () => {
  const { stores, setupFile } = openStores();
  stores.setupMarker.write({ choice: 'standard', version: '9.9.9' });

  const state = stores.setupMarker.read();
  assert.equal(state.done, true);
  assert.equal(state.choice, 'standard');
  assert.match(state.completedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.equal(new Date(state.completedAt).toISOString(), state.completedAt);

  const body = JSON.parse(fs.readFileSync(setupFile, 'utf8'));
  assert.equal(body.version, '9.9.9');
  assert.equal(fs.statSync(setupFile).mode & 0o777, 0o600);
});

test('a corrupt marker reads as not done rather than throwing', () => {
  const { stores, setupFile } = openStores();
  fs.mkdirSync(path.dirname(setupFile), { recursive: true });
  fs.writeFileSync(setupFile, '{ not json');
  assert.equal(fs.existsSync(setupFile), true, 'ENTER: the corrupt file must be on disk to be read');

  assert.deepStrictEqual(stores.setupMarker.read(), { done: false });
});

// The handler map, registered against the real stores so both writes land in the
// files they land in at runtime. Every dep this file does not name is stubbed to
// a no-op function by the Proxy — the idiom test/ipc-unscoped-listing.test.js
// uses — so registration reaches the two handlers under test without the whole
// engine.
function registerAndCapture() {
  const { stores, setupFile } = openStores();
  const handlers = new Map();
  const capture = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    uiSettings: stores.uiSettings,
    setupMarker: stores.setupMarker,
    getAppVersion: () => '1.2.3',
  };
  const stub = () => () => {};
  const deps = new Proxy(capture, {
    get(target, prop) { return prop in target ? target[prop] : stub(); },
    has(target, prop) { return prop in target; },
  });
  registerIpcHandlers(deps);
  assert.ok(handlers.get('setup:state'), 'ENTER: setup:state was never registered');
  assert.ok(handlers.get('setup:complete'), 'ENTER: setup:complete was never registered');
  return { handlers, stores, setupFile };
}

test("setup:complete('standard') writes the marker AND the default mode", () => {
  const { handlers, stores, setupFile } = registerAndCapture();
  assert.deepStrictEqual(handlers.get('setup:state')(), { done: false },
    'ENTER: setup must start undone, or done:true below proves nothing');

  const out = handlers.get('setup:complete')(null, { choice: 'standard' });
  assert.equal(out.done, true);
  assert.equal(out.choice, 'standard');
  assert.equal(stores.uiSettings.get().defaultSessionMode, 'standard');
  assert.equal(JSON.parse(fs.readFileSync(setupFile, 'utf8')).version, '1.2.3');
  assert.deepStrictEqual(handlers.get('setup:state')(), out);
});

test("setup:complete('skipped') writes the marker and leaves the mode alone", () => {
  const { handlers, stores, setupFile } = registerAndCapture();
  stores.uiSettings.set({ defaultSessionMode: 'standard' });
  assert.equal(stores.uiSettings.get().defaultSessionMode, 'standard',
    'ENTER: the mode must be non-default first, or its survival proves nothing');

  const out = handlers.get('setup:complete')(null, { choice: 'skipped' });
  assert.equal(out.done, true);
  assert.equal(out.choice, 'skipped');
  assert.equal(stores.uiSettings.get().defaultSessionMode, 'standard');
  assert.equal(fs.existsSync(setupFile), true);
});

test('an unknown choice throws and writes nothing', () => {
  const { handlers, stores, setupFile } = registerAndCapture();
  const before = stores.uiSettings.get().defaultSessionMode;

  assert.throws(() => handlers.get('setup:complete')(null, { choice: 'bogus' }), /bogus/);
  assert.equal(fs.existsSync(setupFile), false, 'a rejected choice must not mark setup done');
  assert.equal(stores.uiSettings.get().defaultSessionMode, before);
  assert.deepStrictEqual(handlers.get('setup:state')(), { done: false });
});

// Source-shape pins: the boot gate is an ordering between two IIFE-level reads
// that no fixture in this file can execute. Both directions matter — a gate that
// skips the focus check pops one dialog per restored workspace window, and a
// discovery IIFE that stops awaiting the gate stacks two modals on first launch.
const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

test('the setup gate checks focus before it asks whether setup is done', () => {
  const m = rendererSrc.match(/async function maybeFirstRunSetup\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'ENTER: maybeFirstRunSetup was not found in renderer.js');
  const body = m[0];
  const focusAt = body.indexOf('document.hasFocus()');
  const readAt = body.indexOf('getSetupState()');
  assert.ok(focusAt >= 0, 'the gate must consult document.hasFocus()');
  assert.ok(readAt >= 0, 'the gate must read the marker through getSetupState');
  assert.ok(focusAt < readAt, 'focus is checked BEFORE the marker read');
});

test('the discovery IIFE awaits the setup gate and returns when it fired', () => {
  const m = rendererSrc.match(/\(async function maybeDiscoverOnStartup\(\) \{[\s\S]*?\n\}\)\(\);/);
  assert.ok(m, 'ENTER: the discovery IIFE was not found in renderer.js');
  const body = m[0];
  assert.match(body, /if \(await maybeFirstRunSetup\(\)\) return;/,
    'discovery must be skipped for the launch that showed the Welcome dialog');
  assert.ok(body.indexOf('maybeFirstRunSetup') < body.indexOf('discoverSessions'),
    'the gate runs before discovery is asked for anything');
});
