'use strict';
// plugin-template-spawn.test.js — t679: starting a plugin's template spawns a
// seat that HOLDS the plugin, and the app's write-back channel reaches the
// loader's refusals rather than a store that would fork the file.
//
// The grant is the load-bearing half. A plugin template names its own plugin's
// prompts, and a namespaced ref is REFUSED at create() for a seat that does not
// hold the plugin — so if the template's `plugins` did not carry the plugin, the
// only thing picking it could produce is a spawn failure. The loader merges the
// id at read time; this asserts the merge survives every hop between the file on
// disk and the create() call.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createPluginLoader } = require('../plugin-loader');
const { createPluginHostEngine } = require('../plugin-host-engine');
const { pluginTemplateRows } = require('../plugin-prompt-refs');
const { HOST_API_VERSION } = require('../plugin-api');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SYS = 'You review.\n';
const APP = 'And you cite.\n';

function mkPluginRoot(prefix, { templateBody } = {}) {
  const root = mkTmpRoot(prefix);
  const dir = path.join(root, 'rev');
  fs.mkdirSync(path.join(dir, 'prompts', 'system'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'prompts', 'append'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'rev', name: 'Reviewer', version: '1.0.0', hostApi: HOST_API_VERSION, entry: {},
  }));
  fs.writeFileSync(path.join(dir, 'prompts', 'system', 'strict.md'), SYS);
  fs.writeFileSync(path.join(dir, 'prompts', 'append', 'rules.md'), APP);
  fs.writeFileSync(path.join(dir, 'templates', 'audit.json'), JSON.stringify(templateBody || {
    // As an AUTHOR writes it: bare stems, and no `plugins` at all.
    type: 'claude', systemPromptFile: 'strict', appendPromptFiles: ['rules'],
  }));
  return { root, dir };
}

function mkLoaded(prefix, opts) {
  const { root, dir } = mkPluginRoot(prefix, opts);
  let state = {};
  const loader = createPluginLoader({
    fs, path,
    roots: [{ id: 'user', dir: root, label: 'Yours' }],
    getUiSettings: () => ({ get: () => state, set: (p) => { state = { ...state, ...p }; } }),
    log: { info: () => {} },
    requireModule: (p) => require(p),
  });
  const engine = createPluginHostEngine({
    manager: { sessions: new Map(), list: () => [] },
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    userDataPath: '/tmp',
    fs, path,
    getLoader: () => loader,
  });
  loader.loadAll(engine);
  return { loader, engine, root, dir };
}

test('t679: an authored template with NO plugins list arrives at the picker holding the plugin', () => {
  const { engine } = mkLoaded('clodex-t679-spawn-a-');

  // The whole hop chain, one row: file -> readBundle -> register -> bundles() ->
  // pluginTemplateRows. Asserted as a WHOLE object, because a partial match
  // reads around exactly the field a dropped merge would remove.
  const rows = pluginTemplateRows(engine.bundles());
  assert.deepStrictEqual(rows, [{
    type: 'claude',
    systemPromptFile: 'rev:strict',
    appendPromptFiles: ['rev:rules'],
    plugins: ['rev'],
    name: 'rev:audit',
    id: 'rev:audit',
    plugin: 'rev',
    pluginName: 'Reviewer',
  }], 'the author wrote neither the namespace nor the plugins list; both are the read\'s doing');
});

test('t679: the template\'s plugins reach create() as the ARGUMENT the refusal is keyed on', () => {
  // The renderer applies a picked template's `plugins` through the same plugin
  // checklist every other spawn uses, so what is asserted here is that the value
  // it applies makes the seat a HOLDER — because a namespaced prompt ref on a
  // non-holder is refused at create(), which would make picking the template
  // fail rather than work.
  const { engine } = mkLoaded('clodex-t679-spawn-b-');
  const tpl = pluginTemplateRows(engine.bundles())[0];
  assert.ok(tpl, 'ENTER: the plugin template is on offer');

  const { resolvePluginSystemPromptFile, splitPluginPromptRef } = require('../plugin-prompt-refs');
  const ref = splitPluginPromptRef(tpl.systemPromptFile);
  assert.ok(ref, 'ENTER: the template\'s system ref really is namespaced');

  const deps = { fs, path, bundles: engine.bundles() };
  assert.ok(resolvePluginSystemPromptFile(deps, ref, tpl.plugins),
    'spawning WITH the template\'s own plugins resolves the prompt it names');

  // CONTROL, and the reason the merge is load-bearing: drop the plugin the read
  // added and the identical spawn is refused outright.
  assert.throws(() => resolvePluginSystemPromptFile(deps, ref, []),
    /does not hold/,
    'without the merged plugin, picking this template could only ever produce a failed spawn');
});

test('t679: a template that already lists plugins keeps them AND gains its own', () => {
  const { engine } = mkLoaded('clodex-t679-spawn-c-', {
    templateBody: { type: 'claude', plugins: ['other'], systemPromptFile: 'strict' },
  });
  const tpl = pluginTemplateRows(engine.bundles())[0];
  assert.deepStrictEqual(tpl.plugins, ['other', 'rev'],
    'a template asking for another plugin must not lose it to the merge');
});

// ── The write-back channel ─────────────────────────────────────────────────

test('t679: plugins:writeBundleFile routes to the LOADER, whose refusals are the gate', () => {
  // The handler is three lines, but which object it reaches is the whole
  // security property: routed to a store instead, every refusal in
  // writeBundleFile — the root check and the containment check — would be
  // bypassed, and the write would fork the file into the user's library.
  const src = fs.readFileSync(path.join(__dirname, '..', 'ipc-handlers.js'), 'utf8');
  const at = src.indexOf("handle('plugins:writeBundleFile'");
  assert.ok(at > 0, 'ENTER: the channel is registered in ipc-handlers');
  const body = src.slice(at, src.indexOf('});', at));

  assert.match(body, /getPluginLoader && getPluginLoader\(\)/,
    'the loader is the only object that knows which root a plugin came from');
  assert.match(body, /loader\.writeBundleFile\(/, 'and its refusals are what the handler returns');
  assert.doesNotMatch(body, /promptLibrary|templates\.|agentLibrary|skillLibrary/,
    'nothing here may fall back to a library store, which would fork the plugin\'s file');
});

test('t679: writeBundleFile round-trips through the loader and the rescan the drawer runs', () => {
  // End to end, because the drawer's save is only useful if a re-scan then makes
  // the new bytes what a seat would get — the two halves are what the editor is.
  const { loader, engine, dir } = mkLoaded('clodex-t679-spawn-d-');
  const bodyOf = () => {
    const b = engine.bundles().find((x) => x.id === 'rev');
    const p = b && (b.prompts || []).find((x) => x.kind === 'system' && x.name === 'strict');
    return p && p.body;
  };
  assert.strictEqual(bodyOf(), SYS, 'ENTER: the seat-visible read is populated at load');

  const r = loader.writeBundleFile('rev', 'prompts/system', 'strict', 'EDITED BY THE DRAWER\n');
  assert.strictEqual(r.ok, true, `the write succeeded: ${r.error || ''}`);
  assert.strictEqual(r.file, path.join(dir, 'prompts', 'system', 'strict.md'),
    'and it names the file inside the plugin folder, not a library path');

  loader.rescan(engine);
  assert.strictEqual(bodyOf(), 'EDITED BY THE DRAWER\n',
    'after the re-scan the edited bytes are what a seat would get');
});

test('t679: the drawers read a bundle body through file:peek against the catalog dir', () => {
  // The catalog row carries no BODY (pinned in plugin-prompt-bundles.test.js),
  // so an editor opened on a bundle row must fetch the file — and it must build
  // that path from the SAME table the write uses, or it opens one file and saves
  // another under the same name.
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'library-drawers.js'), 'utf8');

  const tableAt = src.indexOf('const bundleRelPath =');
  assert.ok(tableAt > 0, 'ENTER: the drawers keep one path table');
  const table = src.slice(tableAt, src.indexOf('});', tableAt));
  for (const kind of ['skills', 'agents', 'prompts/system', 'prompts/append', 'templates']) {
    assert.ok(table.includes(kind), `the table covers ${kind}`);
  }

  const readAt = src.indexOf('const readBundle =');
  assert.ok(readAt > 0, 'ENTER: and one reader');
  const read = src.slice(readAt, src.indexOf('\n  };', readAt));
  assert.match(read, /window\.api\.filePeek\(`\$\{sec\.dir\}\/\$\{bundleRelPath\(kind, stem\)\}`\)/,
    'the read composes the catalog dir with the SHARED path table');
});
