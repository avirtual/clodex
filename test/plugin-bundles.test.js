'use strict';
// plugin-bundles.test.js — t672 phase A: a Clodex plugin may carry its own
// skills/ and agents/, and a seat sees them only when it has that plugin.
//
// Two halves are pinned here: DISCOVERY (the loader reads both folders, the
// neither-half refusal relaxes for a pure skill pack, a malformed name is
// skipped without costing the plugin) and the CATALOG row the renderer will
// group on in phase B. The spawn half — argv, the gate, the files on disk —
// lives in test/plugin-bundle-spawn.test.js, which drives the real create().

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createPluginLoader, validateManifest } = require('../plugin-loader');
const { createPluginHostEngine } = require('../plugin-host-engine');
const { HOST_API_VERSION } = require('../plugin-api');
const { mkTmpRoot } = require('./lib/tmp-roots');

// A real temp plugins/ tree, same reason plugin-loader.test.js uses one: the
// thing under test IS filesystem interpretation, and `files` keys carry a path
// so a bundle's nested layout is expressible.
function mkTree(plugins) {
  const root = mkTmpRoot('clodex-bundles-');
  for (const [name, spec] of Object.entries(plugins)) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    if (spec.manifest !== undefined) {
      fs.writeFileSync(path.join(dir, 'manifest.json'),
        typeof spec.manifest === 'string' ? spec.manifest : JSON.stringify(spec.manifest));
    }
    for (const [file, body] of Object.entries(spec.files || {})) {
      const full = path.join(dir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }
  }
  return root;
}

function mkLoader(pluginsDir, uiState = {}) {
  let state = { ...uiState };
  const logged = [];
  const loader = createPluginLoader({
    fs, path,
    pluginsDir,
    getUiSettings: () => ({ get: () => state, set: (p) => { state = { ...state, ...p }; } }),
    log: { info: (scope, msg) => logged.push(`${scope}: ${msg}`) },
    requireModule: (p) => require(p),
  });
  return { loader, logged };
}

const SKILL_MD = '---\ndescription: Research a ticker.\n---\nGo look it up.\n';
const AGENT_MD = '---\ndescription: Assesses.\nmodel: haiku\n---\nYou assess.\n';

// A pure skill pack: no engine, no renderer, only content. This is the shape
// the relaxed refusal exists for.
const PACK = {
  manifest: { id: 'stocks', name: 'Stocks', version: '1.0.0', hostApi: HOST_API_VERSION, entry: {} },
  files: { 'skills/foo/SKILL.md': SKILL_MD, 'agents/bar.md': AGENT_MD },
};

// ── Discovery ───────────────────────────────────────────────────────────────

test('t672: a plugin dir with skills/ and agents/ and NO entry half loads, with both folders on the record', () => {
  const { loader } = mkLoader(mkTree({ stocks: PACK }));
  const recs = loader.discover();

  // ENTER: the refusal is the thing being relaxed, so a discover() that
  // returned nothing would satisfy every "no problem reported" check below.
  assert.deepStrictEqual(recs.map((r) => r.id), ['stocks'], 'ENTER: the pack was discovered');

  const rec = recs[0];
  assert.deepStrictEqual(rec.skills, [{ name: 'foo', content: SKILL_MD }],
    'the skill is read at DISCOVERY, content and all — a spawn never opens the plugin dir');
  assert.deepStrictEqual(rec.agents, [{ name: 'bar', content: AGENT_MD }]);
  assert.strictEqual(rec.enginePath, null, 'and it really has no engine half');
  assert.strictEqual(rec.rendererPath, null);
  assert.deepStrictEqual(loader.status().problems, [], 'nothing was reported as a problem');
});

test('t672: a dir with neither half AND no bundle is still refused, by name', () => {
  // The other side of the relax: an empty skills/ folder must not buy a pass.
  const { loader } = mkLoader(mkTree({
    hollow: {
      manifest: { id: 'hollow', name: 'Hollow', version: '1.0.0', hostApi: HOST_API_VERSION, entry: {} },
      files: { 'skills/.keep': '', 'agents/.keep': '' },
    },
  }));
  assert.deepStrictEqual(loader.discover().map((r) => r.id), [], 'not loaded');
  const problems = loader.status().problems;
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0].why, /names neither an engine nor a renderer half/);
  assert.match(problems[0].why, /no skills\/ or agents\/ entry/,
    'the message names the new way out, or an author cannot act on it');
});

test('t672: validateManifest refuses an entry-less manifest until told a bundle exists', () => {
  const m = { id: 'x', name: 'X', version: '1.0.0', hostApi: HOST_API_VERSION, entry: {} };
  assert.match(validateManifest(m, 'x'), /neither an engine nor a renderer half/,
    'the default is unchanged — a caller that does not look at the disk still refuses');
  assert.strictEqual(validateManifest(m, 'x', true), null);
});

test('t672: a malformed skill or agent name is skipped and logged; the plugin still loads', () => {
  const { loader, logged } = mkLoader(mkTree({
    stocks: {
      ...PACK,
      files: {
        ...PACK.files,
        'skills/has space/SKILL.md': SKILL_MD,
        'agents/has space.md': AGENT_MD,
        'agents/notes.txt': 'not a skill or an agent',
      },
    },
  }));
  const recs = loader.discover();
  assert.deepStrictEqual(recs.map((r) => r.id), ['stocks'], 'ENTER: the plugin survived its bad rows');
  assert.deepStrictEqual(recs[0].skills.map((s) => s.name), ['foo'], 'only the legal skill name');
  assert.deepStrictEqual(recs[0].agents.map((a) => a.name), ['bar'],
    'only the legal agent name, and a non-.md file is not an agent');
  assert.ok(logged.some((l) => l.includes('skills/has space')), 'the skipped skill is named in the log');
  assert.ok(logged.some((l) => l.includes('agents/has space.md')), 'and the skipped agent');
});

test('t672: a skill dir with no readable SKILL.md contributes nothing', () => {
  const { loader } = mkLoader(mkTree({
    stocks: {
      manifest: PACK.manifest,
      files: { 'skills/foo/SKILL.md': SKILL_MD, 'skills/empty/README.md': 'no SKILL.md here' },
    },
  }));
  const recs = loader.discover();
  assert.deepStrictEqual(recs.map((r) => r.id), ['stocks'], 'ENTER: discovered');
  assert.deepStrictEqual(recs[0].skills.map((s) => s.name), ['foo']);
});

test('t672: a plugin with an engine half and no bundle reports empty arrays, not undefined', () => {
  // The absent case has to be an array or every `.length` downstream throws
  // inside the spawn's try/catch and silently drops all bundles.
  const dir = mkTree({
    alpha: {
      manifest: {
        id: 'alpha', name: 'Alpha', version: '1.0.0', hostApi: HOST_API_VERSION,
        entry: { engine: 'engine.js' },
      },
      files: { 'engine.js': 'module.exports = { activate() {} };' },
    },
  });
  const rec = mkLoader(dir).loader.discover()[0];
  assert.ok(rec, 'ENTER: discovered');
  assert.deepStrictEqual(rec.skills, []);
  assert.deepStrictEqual(rec.agents, []);
});

test('t672: a re-scan re-reads the bundle from disk', () => {
  // Discovery-time reads are the design (a spawn must not stat the plugin dir),
  // so the loader owes a fresh read whenever it re-scans — otherwise an edited
  // skill ships its old body until the app restarts.
  const root = mkTree({ stocks: PACK });
  const { loader } = mkLoader(root);
  assert.strictEqual(loader.discover()[0].skills[0].content, SKILL_MD, 'ENTER: the first read');
  fs.writeFileSync(path.join(root, 'stocks', 'skills', 'foo', 'SKILL.md'), '---\ndescription: d\n---\nEDITED\n');
  assert.match(loader.discover()[0].skills[0].content, /EDITED/);
});

// ── Catalog ─────────────────────────────────────────────────────────────────

function mkEngine() {
  return createPluginHostEngine({
    manager: { sessions: new Map(), list: () => [] },
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    userDataPath: '/tmp',
    fs, path,
  });
}

test('t672: catalog() carries skill and agent NAMES; bundles() carries the bodies', () => {
  const engine = mkEngine();
  engine.register('stocks', { activate() {} }, { hostApi: HOST_API_VERSION, name: 'Stocks' }, {
    shipped: true,
    skills: [{ name: 'foo', content: SKILL_MD }],
    agents: [{ name: 'bar', content: AGENT_MD }],
  });
  engine.register('plain', { activate() {} }, { hostApi: HOST_API_VERSION });

  const rows = new Map(engine.catalog().map((r) => [r.id, r]));
  assert.deepStrictEqual([...rows.keys()].sort(), ['plain', 'stocks'], 'ENTER: both registered');
  assert.deepStrictEqual(rows.get('stocks').skills, ['foo'], 'names only — the renderer draws headers');
  assert.deepStrictEqual(rows.get('stocks').agents, ['bar']);
  assert.ok(!JSON.stringify(rows.get('stocks')).includes('Go look it up'),
    'and no skill BODY rides the catalog row to every renderer');
  assert.deepStrictEqual(rows.get('plain').skills, [], 'a bundle-less plugin reports empty, not undefined');
  assert.deepStrictEqual(rows.get('plain').agents, []);

  assert.deepStrictEqual(engine.bundles(), [
    { id: 'stocks', shipped: true, skills: [{ name: 'foo', content: SKILL_MD }], agents: [{ name: 'bar', content: AGENT_MD }] },
  ], 'bundles() is the spawn read: contents, and only the plugins that have any');
});

test('t672: an entry-less plugin registers and appears in the catalog', () => {
  // A pure skill pack has no module. If register() choked on that, the loader
  // would discover it and then drop it, and the gate would never run.
  const { loader } = mkLoader(mkTree({ stocks: PACK }));
  const engine = mkEngine();
  const results = loader.loadAll(engine);
  assert.deepStrictEqual(results, [{ id: 'stocks', ok: true }], 'ENTER: it loaded, module and all');
  const row = engine.catalog().find((r) => r.id === 'stocks');
  assert.ok(row, 'the pack is in the catalog, so announce and the per-seat gate reach it');
  assert.deepStrictEqual([row.skills, row.agents], [['foo'], ['bar']]);
});
