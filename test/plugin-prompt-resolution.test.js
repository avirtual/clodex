'use strict';
// plugin-prompt-resolution.test.js — t679: a `<plugin-id>:<stem>` prompt
// reference resolves through the plugin BEFORE the library, and a seat that
// does not hold the plugin is refused rather than silently degraded.
//
// The refusal is the half worth the test file. A library prompt that is missing
// falls back to the CLI default, which is a reasonable degradation; a plugin
// prompt the seat cannot reach means the template naming it was applied to the
// wrong seat, and booting anyway produces a seat quietly missing the whole
// system prompt it was configured with. So each arm below asserts the refusal is
// a THROW naming the plugin, not a null.
//
// The engine's four seams are one-line delegates over this leaf (engine.js:
// resolveSystemPromptFile / readAppendBodies / readSystemPromptBody /
// listAllTemplates), so what runs here is what a spawn runs. That the delegates
// exist at all is pinned at source level at the bottom of this file — a leaf
// nothing calls would pass everything above it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  splitPluginPromptRef, bundleForPromptRef,
  resolvePluginSystemPromptFile, resolvePluginPromptBody, pluginTemplateRows,
} = require('../plugin-prompt-refs');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SYS = 'You are a reviewer.\n';
const APP_A = 'Rule A.\n';
const APP_B = 'Rule B.\n';

// A bundle in the shape plugin-host-engine's bundles() serves, over a real
// directory: resolvePluginSystemPromptFile returns a PATH and accessSync's it,
// so a fictional dir would make the system arm answer null for the wrong reason.
function mkBundle({ id = 'rev', shipped = false, prompts = null, templates = [] } = {}) {
  const root = mkTmpRoot(`clodex-t679-res-${id}-`);
  const rows = prompts || [
    { name: 'strict', kind: 'system', body: SYS },
    { name: 'a', kind: 'append', body: APP_A },
  ];
  for (const p of rows) {
    const dir = path.join(root, 'prompts', p.kind);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${p.name}.md`), p.body);
  }
  return {
    id, name: `${id} plugin`, shipped, editable: true, dir: root,
    skills: [], agents: [], prompts: rows, templates,
  };
}

const DEPS = (bundles) => ({ fs, path, bundles });

// ── The split ───────────────────────────────────────────────────────────────

test('t679: splitPluginPromptRef separates a namespaced ref from every bare stem', () => {
  assert.deepStrictEqual(splitPluginPromptRef('rev:strict'), { pluginId: 'rev', stem: 'strict' });
  // The FIRST colon splits, so a stem that somehow contains one still belongs to
  // the plugin named before it rather than being refused outright.
  assert.deepStrictEqual(splitPluginPromptRef('rev:a:b'), { pluginId: 'rev', stem: 'a:b' });

  for (const bare of ['strict', 'my-prompt', 'a.b_c', ':leading', '', null, undefined]) {
    assert.strictEqual(splitPluginPromptRef(bare), null,
      `${JSON.stringify(bare)} is not a plugin ref — a leading colon leaves an empty id, which names no plugin`);
  }
});

// ── The system arm ──────────────────────────────────────────────────────────

test('t679: resolveSystemPromptFile on p:x returns the file inside the plugin', () => {
  const b = mkBundle();
  const p = resolvePluginSystemPromptFile(DEPS([b]), { pluginId: 'rev', stem: 'strict' }, ['rev']);

  assert.strictEqual(p, path.join(b.dir, 'prompts', 'system', 'strict.md'),
    'the path is inside the PLUGIN folder, not the user library');
  assert.strictEqual(fs.readFileSync(p, 'utf8'), SYS,
    'ENTER: and the file it names really holds the plugin\'s prompt');
});

test('t679: a stem the plugin does not carry is null, and a missing FILE is null too', () => {
  const b = mkBundle();
  assert.strictEqual(
    resolvePluginSystemPromptFile(DEPS([b]), { pluginId: 'rev', stem: 'nosuch' }, ['rev']), null,
    'not in the record — the plugin does not ship it');

  // Present in the record but gone from disk: the record is a snapshot taken at
  // the last scan, so this is the ordinary "edited between scans" case and it
  // degrades rather than throwing.
  fs.unlinkSync(path.join(b.dir, 'prompts', 'system', 'strict.md'));
  assert.strictEqual(
    resolvePluginSystemPromptFile(DEPS([b]), { pluginId: 'rev', stem: 'strict' }, ['rev']), null);
});

// ── The append arm ──────────────────────────────────────────────────────────

test('t679: readAppendBodies-style resolution returns plugin bodies, and the engine keeps ORDER', () => {
  const b = mkBundle({ prompts: [
    { name: 'a', kind: 'append', body: APP_A },
    { name: 'b', kind: 'append', body: APP_B },
    { name: 'strict', kind: 'system', body: SYS },
  ] });

  assert.strictEqual(resolvePluginPromptBody({ bundles: [b] }, { pluginId: 'rev', stem: 'a' }, 'append', ['rev']), APP_A);
  assert.strictEqual(resolvePluginPromptBody({ bundles: [b] }, { pluginId: 'rev', stem: 'b' }, 'append', ['rev']), APP_B);

  // KIND is part of the identity, so a system prompt of the same stem is not an
  // append body and vice versa — the two rails must not cross.
  const both = mkBundle({ id: 'dual', prompts: [
    { name: 'same', kind: 'system', body: 'SYSTEM COPY\n' },
    { name: 'same', kind: 'append', body: 'APPEND COPY\n' },
  ] });
  assert.strictEqual(resolvePluginPromptBody({ bundles: [both] }, { pluginId: 'dual', stem: 'same' }, 'append', ['dual']), 'APPEND COPY\n');
  assert.strictEqual(resolvePluginPromptBody({ bundles: [both] }, { pluginId: 'dual', stem: 'same' }, 'system', ['dual']), 'SYSTEM COPY\n');
});

// ── The refusal ─────────────────────────────────────────────────────────────

test('t679: a ref for a plugin the seat does not hold THROWS, naming the plugin', () => {
  const b = mkBundle();
  const ref = { pluginId: 'rev', stem: 'strict' };

  // ENTER: the same call succeeds for a holder, so the throws below are about
  // reach and not about a broken fixture.
  assert.ok(resolvePluginSystemPromptFile(DEPS([b]), ref, ['rev']),
    'ENTER: a seat that HOLDS the plugin resolves it');

  for (const seat of [[], ['other']]) {
    assert.throws(() => resolvePluginSystemPromptFile(DEPS([b]), ref, seat),
      /needs the "rev" plugin, which this session does not hold/,
      `plugins=${JSON.stringify(seat)} is refused rather than degraded to the CLI default`);
    assert.throws(() => resolvePluginPromptBody({ bundles: [b] }, ref, 'system', seat),
      /does not hold/, 'the codex arm refuses identically');
  }
});

test('t679: a ref for a plugin that is not loaded at all THROWS by that name', () => {
  // Distinct from the reach refusal, and the distinction is the whole value of
  // the message: "not loaded" sends the operator to Manage Plugins, "does not
  // hold" sends them to the session's plugin ticks.
  assert.throws(
    () => resolvePluginSystemPromptFile(DEPS([]), { pluginId: 'gone', stem: 'x' }, ['gone']),
    /comes from the "gone" plugin, which is not loaded/);
});

test('t679: a SHIPPED plugin resolves for a seat with no plugin list at all', () => {
  // seatHasPlugin's absent case is opposite-polarity for a shipped plugin, and
  // getting it backwards would refuse every pre-upgrade seat that names a
  // built-in plugin's prompt — a spawn failure on upgrade, not a missing prompt.
  const shipped = mkBundle({ id: 'core-p', shipped: true });
  assert.ok(resolvePluginSystemPromptFile(DEPS([shipped]), { pluginId: 'core-p', stem: 'strict' }, null),
    'an absent list takes the shipped default');

  const own = mkBundle({ id: 'mine', shipped: false });
  assert.throws(
    () => resolvePluginSystemPromptFile(DEPS([own]), { pluginId: 'mine', stem: 'strict' }, null),
    /does not hold/,
    'CONTROL: an unshipped plugin is still withheld from an absent list, or the assertion above is vacuous');
});

// ── Templates ───────────────────────────────────────────────────────────────

test('t679: pluginTemplateRows namespaces the id and carries the merged plugins through', () => {
  const b = mkBundle({ templates: [
    // As the loader wrote it: refs already namespaced, own id already merged.
    { name: 'audit', body: { type: 'claude', systemPromptFile: 'rev:strict', plugins: ['rev'] } },
  ] });

  assert.deepStrictEqual(pluginTemplateRows([b]), [{
    type: 'claude',
    systemPromptFile: 'rev:strict',
    plugins: ['rev'],
    name: 'rev:audit',
    id: 'rev:audit',
    plugin: 'rev',
    pluginName: 'rev plugin',
  }], 'the whole row, so a field the pickers need cannot go missing unnoticed');

  assert.deepStrictEqual(pluginTemplateRows([]), [], 'no plugins is an empty list, not undefined');
});

// ── The delegates exist ─────────────────────────────────────────────────────
// Source-shape, and not redundant with everything above: this leaf is pure, so
// every assertion in this file passes against an engine.js that never calls it.
// The property is that the four production seams route THROUGH it.

test('t679: engine.js resolves prompts and templates through this leaf', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  assert.match(src, /require\('\.\/plugin-prompt-refs'\)/, 'ENTER: engine.js requires the leaf');

  for (const [fn, call] of [
    ['resolveSystemPromptFile', 'resolvePluginSystemPromptFile'],
    ['readAppendBodies', 'resolvePluginPromptBody'],
    ['readSystemPromptBody', 'resolvePluginPromptBody'],
    ['listAllTemplates', 'pluginTemplateRows'],
  ]) {
    const at = src.indexOf(`function ${fn}(`);
    assert.ok(at > 0, `ENTER: ${fn} is in engine.js`);
    const body = src.slice(at, src.indexOf('\n}', at));
    assert.ok(body.includes(call),
      `${fn} must resolve through ${call}, or a namespaced ref reaches the library store instead`);
  }
});

test('t679: session-manager threads the SEAT\'S plugins into every prompt resolution', () => {
  // The refusal above is keyed on `seatPlugins`, so a call site that omitted the
  // argument would pass `undefined` — which seatHasPlugin reads as the absent
  // list and resolves to the SHIPPED default. Every plugin prompt on an
  // unshipped plugin would then be refused for every seat, and every one on a
  // shipped plugin granted to every seat. Neither is visible from this leaf.
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');

  assert.match(src, /resolveSystemPromptFile\(systemPromptFile, Array\.isArray\(plugins\) \? plugins : null\)/,
    'the claude arm passes create()\'s own plugins argument');
  assert.match(src, /readAppendBodies\(appendPromptFiles, seatPlugins\)/,
    'and so does the codex arm');
  assert.match(src, /readAppendBodies\(recipe\.appendPromptFiles, recipe\.plugins\)/,
    'and the prompt REBAKE reads it off the captured recipe — a refresh that omitted it '
    + 'would rewrite a live seat\'s prompt file without the plugin bodies it booted with');
});
