'use strict';
// plugin-prompt-bundles.test.js — t679: a plugin may carry prompts/ and
// templates/ alongside skills/ and agents/, and whether the app may EDIT any of
// the four is decided by the root it came from.
//
// Three halves are pinned here. DISCOVERY: the loader reads both new
// directories, the neither-half refusal relaxes for a prompts-only pack, a
// malformed template is a logged skip. NAMESPACING: a bare prompt ref inside a
// plugin template is rewritten on read, and the plugin's own id is merged into
// the template's `plugins`. OWNERSHIP: `editable` is literally true for root
// `user` and literally false for `core`, and writeBundleFile refuses on both the
// root and the path.
//
// The resolution half — resolveSystemPromptFile / readAppendBodies against a
// namespaced stem — lives in test/plugin-prompt-resolution.test.js, which drives
// the real seams rather than the loader.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createPluginLoader, namespaceTemplateRefs } = require('../plugin-loader');
const { createPluginHostEngine } = require('../plugin-host-engine');
const { HOST_API_VERSION } = require('../plugin-api');
const { mkTmpRoot } = require('./lib/tmp-roots');

function mkTree(prefix, plugins) {
  const root = mkTmpRoot(prefix);
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

// Two roots, because the ownership rule IS a root comparison: a single-root
// loader cannot express the false direction, and a test that only ever saw
// `user` would pass against a hardcoded `editable: true`.
function mkLoader(roots, uiState = {}) {
  let state = { ...uiState };
  const logged = [];
  const loader = createPluginLoader({
    fs, path, roots,
    getUiSettings: () => ({ get: () => state, set: (p) => { state = { ...state, ...p }; } }),
    log: { info: (scope, msg) => logged.push(`${scope}: ${msg}`) },
    requireModule: (p) => require(p),
  });
  return { loader, logged };
}

function mkEngine() {
  return createPluginHostEngine({
    manager: { sessions: new Map(), list: () => [] },
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    userDataPath: '/tmp',
    fs, path,
  });
}

const SYS_MD = 'You are a reviewer. Read the diff, not the summary.\n';
const APP_MD = 'Also: never approve a comment you cannot check.\n';

const PACK = {
  manifest: { id: 'rev', name: 'Reviewer', version: '1.0.0', hostApi: HOST_API_VERSION, entry: {} },
  files: {
    'prompts/system/strict.md': SYS_MD,
    'prompts/append/rules.md': APP_MD,
    'templates/audit.json': JSON.stringify({
      type: 'claude', systemPromptFile: 'strict', appendPromptFiles: ['rules'],
    }),
  },
};

// ── Discovery ───────────────────────────────────────────────────────────────

test('t679: a plugin with ONLY prompts/ is valid, and both kinds land on the record', () => {
  const root = mkTree('clodex-t679-a-', {
    rev: {
      manifest: PACK.manifest,
      files: {
        'prompts/system/strict.md': SYS_MD,
        'prompts/append/rules.md': APP_MD,
      },
    },
  });
  const { loader } = mkLoader([{ id: 'user', dir: root, label: 'Yours' }]);
  const recs = loader.discover();

  // ENTER: the entry-less refusal is exactly what this relaxes, so a discover()
  // that returned nothing would satisfy every absence check below vacuously.
  assert.deepStrictEqual(recs.map((r) => r.id), ['rev'],
    'ENTER: a prompts-only pack was discovered — no engine, no renderer, no skills, no agents');

  assert.deepStrictEqual(recs[0].prompts, [
    { name: 'rules', kind: 'append', body: APP_MD },
    { name: 'strict', kind: 'system', body: SYS_MD },
  ], 'both kinds, bodies read at DISCOVERY, sorted by name like skills and agents');
  assert.deepStrictEqual(recs[0].templates, [], 'and no templates, as an array rather than undefined');
  assert.deepStrictEqual(loader.status().problems, [], 'nothing was reported as a problem');
});

test('t679: a templates-only pack is valid too, and the refusal message names all four', () => {
  const root = mkTree('clodex-t679-b-', {
    tpl: {
      manifest: { id: 'tpl', name: 'T', version: '1.0.0', hostApi: HOST_API_VERSION, entry: {} },
      files: { 'templates/one.json': '{"type":"claude"}' },
    },
    hollow: {
      manifest: { id: 'hollow', name: 'H', version: '1.0.0', hostApi: HOST_API_VERSION, entry: {} },
      files: { 'prompts/system/.keep': '', 'templates/.keep': '' },
    },
  });
  const { loader } = mkLoader([{ id: 'user', dir: root, label: 'Yours' }]);
  assert.deepStrictEqual(loader.discover().map((r) => r.id), ['tpl'],
    'ENTER: the templates-only pack loaded and the empty one did not');

  const problems = loader.status().problems;
  assert.strictEqual(problems.length, 1, 'exactly the hollow one was refused');
  assert.match(problems[0].why, /no skills\/, agents\/, prompts\/ or templates\/ entry/,
    'the message names every way out, or an author cannot act on it');
});

test('t679: a malformed template is a logged skip and costs only itself', () => {
  const root = mkTree('clodex-t679-c-', {
    rev: {
      manifest: PACK.manifest,
      files: {
        ...PACK.files,
        'templates/broken.json': '{ this is not json',
        'templates/notanobject.json': '["an array is not a template"]',
        'templates/has space.json': '{"type":"claude"}',
        'templates/notes.txt': 'not a template at all',
      },
    },
  });
  const { loader, logged } = mkLoader([{ id: 'user', dir: root, label: 'Yours' }]);
  const rec = loader.discover()[0];
  assert.ok(rec, 'ENTER: the plugin survived its bad rows');

  assert.deepStrictEqual(rec.templates.map((t) => t.name), ['audit'],
    'only the one that parsed to an object under a legal name');
  assert.ok(logged.some((l) => l.includes('templates/broken.json') && /not valid JSON/.test(l)),
    'the unparseable one is named in the log with the reason');
  assert.ok(logged.some((l) => l.includes('templates/notanobject.json') && /not a JSON object/.test(l)),
    'and so is the array, which parses but is not a template');
  assert.ok(logged.some((l) => l.includes('templates/has space.json')),
    'and the illegal name');
  assert.ok(!logged.some((l) => l.includes('notes.txt')),
    'a non-.json file was never a template entry, so it is not reported as a broken one');
});

// ── Namespacing ─────────────────────────────────────────────────────────────

test('t679: bare prompt refs inside a plugin template are namespaced on READ', () => {
  const root = mkTree('clodex-t679-d-', { rev: PACK });
  const { loader } = mkLoader([{ id: 'user', dir: root, label: 'Yours' }]);
  const rec = loader.discover()[0];

  const audit = (rec.templates || []).find((t) => t.name === 'audit');
  assert.ok(audit, 'ENTER: the template was read at all');

  assert.strictEqual(audit.body.systemPromptFile, 'rev:strict',
    'the bare stem the author wrote is rewritten, so the ref cannot dangle when the plugin moves roots');
  assert.deepStrictEqual(audit.body.appendPromptFiles, ['rev:rules']);
  assert.deepStrictEqual(audit.body.plugins, ['rev'],
    'and the plugin merged itself in, so starting the template GRANTS the plugin it needs');
});

test('t679: namespaceTemplateRefs leaves an already-qualified ref alone and merges into a held list', () => {
  // A plugin may deliberately name ANOTHER plugin's prompt, so the rewrite must
  // be conditional on the absent colon rather than unconditional. Asserted on
  // the whole object, because a partial match reads around a field the rewrite
  // dropped.
  assert.deepStrictEqual(
    namespaceTemplateRefs({
      type: 'claude',
      systemPromptFile: 'other:theirs',
      appendPromptFiles: ['mine', 'other:theirs'],
      plugins: ['other'],
    }, 'me'),
    {
      type: 'claude',
      systemPromptFile: 'other:theirs',
      appendPromptFiles: ['me:mine', 'other:theirs'],
      plugins: ['other', 'me'],
    });

  assert.deepStrictEqual(namespaceTemplateRefs({ type: 'claude' }, 'me'),
    { type: 'claude', plugins: ['me'] },
    'a template naming no prompts still gets its plugin, or picking it would not grant one');
});

// ── Ownership ───────────────────────────────────────────────────────────────

test('t679: editable is literally true for root user and literally false for core', () => {
  // The two roots carry the SAME plugin id under different ids-of-root, so the
  // only thing that can distinguish the two records is the rule under test.
  const userRoot = mkTree('clodex-t679-e-user-', { rev: PACK });
  const coreRoot = mkTree('clodex-t679-e-core-', { built: { ...PACK, manifest: { ...PACK.manifest, id: 'built' } } });
  const { loader } = mkLoader([
    { id: 'core', dir: coreRoot, label: 'Built in' },
    { id: 'user', dir: userRoot, label: 'Yours' },
  ]);
  const byId = new Map(loader.discover().map((r) => [r.id, r]));
  assert.deepStrictEqual([...byId.keys()].sort(), ['built', 'rev'],
    'ENTER: one plugin from each root was discovered');

  assert.strictEqual(byId.get('rev').editable, true, 'a plugin in the user root is the user\'s own');
  assert.strictEqual(byId.get('built').editable, false,
    'and a built-in copy is read-only in the app, whatever it carries');
});

test('t679: writeBundleFile writes for user, refuses core, refuses traversal', () => {
  const userRoot = mkTree('clodex-t679-f-user-', { rev: PACK });
  const coreRoot = mkTree('clodex-t679-f-core-', { built: { ...PACK, manifest: { ...PACK.manifest, id: 'built' } } });
  const { loader } = mkLoader([
    { id: 'core', dir: coreRoot, label: 'Built in' },
    { id: 'user', dir: userRoot, label: 'Yours' },
  ]);
  assert.strictEqual(loader.discover().length, 2, 'ENTER: both plugins are discoverable, so both arms are reachable');

  const ok = loader.writeBundleFile('rev', 'prompts/system', 'strict', 'REWRITTEN\n');
  assert.strictEqual(ok.ok, true, `the user-root write succeeded: ${ok.error || ''}`);
  assert.strictEqual(
    fs.readFileSync(path.join(userRoot, 'rev', 'prompts', 'system', 'strict.md'), 'utf8'),
    'REWRITTEN\n', 'and it landed in the plugin folder, on disk');

  const newFile = loader.writeBundleFile('rev', 'templates', 'fresh', '{"type":"claude"}');
  assert.strictEqual(newFile.ok, true, 'a file that did not exist yet is created, dirs and all');
  assert.ok(fs.existsSync(path.join(userRoot, 'rev', 'templates', 'fresh.json')));

  const core = loader.writeBundleFile('built', 'prompts/system', 'strict', 'HIJACKED\n');
  assert.strictEqual(core.ok, false, 'a built-in plugin is read-only');
  assert.match(core.error, /read-only/);
  assert.strictEqual(
    fs.readFileSync(path.join(coreRoot, 'built', 'prompts', 'system', 'strict.md'), 'utf8'),
    SYS_MD, 'and the refusal is a refusal — the file is untouched');

  for (const bad of ['../x', '../../etc/passwd', 'a/b', '.', '..']) {
    const r = loader.writeBundleFile('rev', 'prompts/system', bad, 'nope');
    assert.strictEqual(r.ok, false, `${JSON.stringify(bad)} is refused`);
    assert.match(r.error, /invalid name/);
  }
  assert.strictEqual(loader.writeBundleFile('rev', 'evil', 'x', 'nope').ok, false,
    'and an unknown kind cannot select a path shape of the caller\'s choosing');
  assert.strictEqual(loader.writeBundleFile('nosuch', 'templates', 'x', '{}').ok, false,
    'an unknown plugin is refused before anything is written');

  // The traversal refusals must not have escaped the plugin folder on the way to
  // being refused — the assertion above only reads the return value.
  assert.ok(!fs.existsSync(path.join(userRoot, 'x')), 'nothing was written beside the plugin');
  assert.ok(!fs.existsSync(path.join(userRoot, 'rev', 'prompts', 'x')));
});

// ── Rescan + the catalog ────────────────────────────────────────────────────

test('t679: a re-scan refreshes an edited prompt body all the way to bundles()', () => {
  // The same property t672 pinned for skills, for the two new kinds: the record
  // bundles() serves is written at register() time, so without the refresh an
  // edited prompt ships its old body until the app restarts.
  const root = mkTree('clodex-t679-g-', { rev: PACK });
  const { loader } = mkLoader([{ id: 'user', dir: root, label: 'Yours' }]);
  const engine = mkEngine();
  loader.loadAll(engine);

  const bodyOf = () => {
    const b = engine.bundles().find((x) => x.id === 'rev');
    const p = b && (b.prompts || []).find((x) => x.kind === 'system' && x.name === 'strict');
    return p && p.body;
  };
  assert.match(bodyOf(), /Read the diff/, 'ENTER: the seat-visible read is populated at load');

  fs.writeFileSync(path.join(root, 'rev', 'prompts', 'system', 'strict.md'), 'EDITED\n');
  assert.match(bodyOf(), /Read the diff/, 'still the old body — an edit alone does not reach a running plugin');

  loader.rescan(engine);
  assert.strictEqual(bodyOf(), 'EDITED\n', 'the re-scan is what refreshes it');
});

test('t679: the rescan refresh stays behind the version/moved gate', () => {
  // Extends the t672 gate to the two new kinds rather than duplicating it. The
  // version arm is the one a fixture can drive honestly: `loadedFrom` is per
  // loader, so a second loader over a second root never reaches the gate at all
  // — it sees the id as not-running and takes the load path instead.
  const root = mkTree('clodex-t679-h-', { rev: PACK });
  const engine = mkEngine();
  const { loader } = mkLoader([{ id: 'user', dir: root, label: 'Yours' }]);
  loader.loadAll(engine);

  const bodyOf = () => {
    const b = engine.bundles().find((x) => x.id === 'rev');
    const p = b && (b.prompts || []).find((x) => x.kind === 'system');
    return p && p.body;
  };
  assert.match(bodyOf(), /Read the diff/, 'ENTER: loaded, and the seat-visible read is populated');

  // Both change at once, which is the realistic shape of an upgrade-in-place —
  // and the whole point of the gate: the new content belongs to a version whose
  // engine half is NOT the one in the require cache.
  fs.writeFileSync(path.join(root, 'rev', 'prompts', 'system', 'strict.md'), 'FROM v2\n');
  fs.writeFileSync(path.join(root, 'rev', 'manifest.json'),
    JSON.stringify({ ...PACK.manifest, version: '2.0.0' }));

  const r = loader.rescan(engine);
  assert.deepStrictEqual(r.changed, ['rev'],
    'ENTER: the rescan classified it as changed, which is the arm of the gate under test');
  assert.match(bodyOf(), /Read the diff/,
    'and the content was NOT refreshed — restart-required, not a new version\'s prompts under the old version\'s code');
});

test('t679: catalog() carries names, kinds, editable and dir — never a prompt body', () => {
  const engine = mkEngine();
  engine.register('rev', { activate() {} }, { hostApi: HOST_API_VERSION, name: 'Reviewer' }, {
    shipped: false,
    editable: true,
    dir: '/plugins/rev',
    prompts: [{ name: 'strict', kind: 'system', body: SYS_MD }, { name: 'rules', kind: 'append', body: APP_MD }],
    templates: [{ name: 'audit', body: { type: 'claude', plugins: ['rev'] } }],
  });
  engine.register('plain', { activate() {} }, { hostApi: HOST_API_VERSION });

  const rows = new Map(engine.catalog().map((r) => [r.id, r]));
  assert.deepStrictEqual([...rows.keys()].sort(), ['plain', 'rev'], 'ENTER: both registered');

  assert.deepStrictEqual(rows.get('rev').prompts,
    [{ name: 'strict', kind: 'system' }, { name: 'rules', kind: 'append' }],
    'name AND kind — a system and an append prompt may share a stem and feed different UI');
  assert.deepStrictEqual(rows.get('rev').templates, ['audit'], 'template names only');
  assert.strictEqual(rows.get('rev').editable, true);
  assert.strictEqual(rows.get('rev').dir, '/plugins/rev');
  assert.ok(!JSON.stringify(rows.get('rev')).includes('Read the diff'),
    'and no prompt BODY rides the catalog row to every renderer');

  assert.deepStrictEqual(rows.get('plain').prompts, [], 'a bundle-less plugin reports empty, not undefined');
  assert.deepStrictEqual(rows.get('plain').templates, []);
  assert.strictEqual(rows.get('plain').editable, false,
    'and an unstated origin withholds, exactly as `shipped` does');
});
