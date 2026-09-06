'use strict';
// plugin-builder-shipped.test.js — t709: clodex-plugin-builder is the FIRST
// shipped plugin carrying a content bundle, so the built-in root's bundle path
// is exercised on a real shipped plugin here for the first time. Every fixture
// pinning the bundle mechanism (test/plugin-bundles.test.js) builds a temp tree;
// this subject drives the REAL plugins/ directory, which is the only place a
// packaging mistake — a skill folder left out of the copy, a manifest that
// stopped validating, a bundle that reads as empty because the loader was
// pointed at a root that has none — can show up.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createPluginLoader, validateManifest } = require('../plugin-loader');

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');
const ID = 'clodex-plugin-builder';

function realRootLoader() {
  let state = {};
  return createPluginLoader({
    fs,
    path,
    pluginsDir: PLUGINS_DIR,
    getUiSettings: () => ({ get: () => state, set: (p) => { state = { ...state, ...p }; } }),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    requireModule: (p) => require(p),
  });
}

test('t709: the real built-in root discovers clodex-plugin-builder as a content-only bundle', () => {
  const loader = realRootLoader();
  const recs = loader.discover();

  // ENTER: the whole subject reads one record out of a discovery sweep over the
  // real directory. A sweep that found nothing — a mistyped root, a loader that
  // refuses an entry-less manifest again — leaves every check below asserting
  // over `undefined` or an absence that is trivially true.
  const ids = recs.map((r) => r.id).sort();
  assert.ok(ids.includes('git-branches'), `ENTER: the real root was read (${ids.length} plugins)`);

  const rec = recs.find((r) => r.id === ID);
  assert.ok(rec, `${ID} is discovered from plugins/ — it ships with the app`);

  assert.deepStrictEqual(rec.skills.map((s) => s.name), ['create-plugin'],
    'exactly the create-plugin skill');
  assert.deepStrictEqual(rec.agents.map((a) => a.name), ['api-scout'],
    'exactly the api-scout subagent');
  assert.strictEqual(rec.enginePath, null, 'content only — no engine half');
  assert.strictEqual(rec.rendererPath, null, 'content only — no renderer half, so no build:web owed');

  assert.strictEqual(validateManifest(rec.manifest, ID, true), null,
    'the shipped manifest validates against the loader that will load it');
  assert.strictEqual(loader.isEnabled(rec), false,
    'off by default — the operator ticks it onto a seat');

  const skill = rec.skills[0].content;
  assert.match(skill, /\/clodex-plugin-builder:create-plugin/,
    'the skill BODY was read off disk, not recorded as an empty string');
  assert.match(rec.agents[0].content, /Clodex plugin API/,
    'and so was the scout body');

  assert.deepStrictEqual(
    loader.status().problems.filter((p) => p.id === ID), [],
    'and it costs the load no problem row',
  );
});

test('t709: the shipped plugin directory carries no JavaScript', () => {
  // The manifest is `"entry": {}`, so any .js under the directory is code that
  // nothing loads — and code the plugin-boundary lint would then have to police
  // for a plugin that is documentation.
  const found = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (ent.name.endsWith('.js')) found.push(path.relative(PLUGINS_DIR, abs));
    }
  };
  walk(path.join(PLUGINS_DIR, ID));
  assert.deepStrictEqual(found, []);
});

test('t714: the shipped copy is upstream 0.2.2, teaching the surfaces table', () => {
  // The shipped plugin is a verbatim copy of an upstream repo, so nothing in
  // this tree changes when upstream does; a sync that stalls is invisible.
  // Pinning the version against the teaching artifacts the shipped bytes carry
  // makes a half-applied sync (new bytes, old manifest, or the reverse) fail
  // here rather than shipping a builder that documents the wrong contract.
  const loader = realRootLoader();
  const rec = loader.discover().find((r) => r.id === ID);
  assert.ok(rec, `ENTER: ${ID} was discovered from the real built-in root`);

  assert.strictEqual(rec.manifest.version, '0.2.2',
    'the shipped manifest is at upstream tag clodex-plugin-builder-v0.2.2');

  const skill = rec.skills[0].content;
  assert.match(skill, /\/clodex-plugin-builder:create-plugin/,
    'ENTER: the skill body was read off disk, not recorded as an empty string');

  assert.ok(skill.includes('plugin method not available on this surface'),
    'the skill teaches the refusal a browser gets for a method left out of `surfaces`');

  assert.ok(skill.includes('is a registered link, not a directory from a source'),
    'the skill quotes the refusal a GitHub install gets when a registered symlink holds the id');
});
