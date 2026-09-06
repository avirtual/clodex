'use strict';
// Run: node --test test/plugin-source-dialog.test.js
//
// t688 — Manage Plugins ▸ Install from GitHub…. The decision half lives in
// renderer/lib/plugin-source-dialog.js because renderer.js is DOM-bound with no
// harness; the wiring half is pinned by slicing renderer.js's source the way
// test/new-session-name-validity.test.js slices doCreate.
//
// The property that matters is an ORDER, not a value: the warning names the
// authority the code is about to be given, so it must be on screen before the
// install call exists at all. A leaf that composes the right sentence is worth
// nothing if the handler writes it after the fetch — and the two source-shape
// subjects at the bottom are the only place that ordering is checkable, since
// they cannot prove the code RUNS, only that the write is not sitting after the
// invoke.
//
// The second wiring property is that Install carries the RESOLVED spec, not
// whatever is in the field when it is pressed. Those differ exactly when the
// operator edits the field after resolving, which is the case installState
// disables — and if the handler read the live field, a race between the paint
// and the press would install a repo nobody was shown.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  INSTALL_REASONS, refLabel, sourceLabel, previewLines, warningText, installState,
} = require('../renderer/lib/plugin-source-dialog');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');

// What `plugins.resolveSource` returns (plugin-loader.js resolveSource), plus
// the `spec` the renderer stamps on when it stores the result.
const RESOLVED = {
  ok: true,
  spec: 'avirtual/clodex-plugins@v2:packs/notes',
  repo: 'avirtual/clodex-plugins',
  ref: 'v2',
  subpath: 'packs/notes',
  commit: 'abc1234',
  commitFull: 'abc1234def5678abc1234def5678abc1234def56',
  id: 'notes',
  manifest: { id: 'notes', name: 'Notes', version: '1.2.0', announce: 'Takes notes.' },
};

// The other half of the ref branch: a bare `owner/repo` resolves with ref null,
// and the warning must still name WHERE the code came from.
const RESOLVED_NO_REF = {
  ok: true,
  spec: 'avirtual/demo',
  repo: 'avirtual/demo',
  ref: null,
  subpath: null,
  commit: 'def5678',
  commitFull: null,
  id: 'demo',
  manifest: { id: 'demo', name: 'Demo', version: '0.1.0', announce: null },
};

// ── the Install gate ────────────────────────────────────────────────────────
//
// Each row carries its own literal `enabled` and `reason`. The reasons are NOT
// looked up from INSTALL_REASONS by the rule the code uses: a table that
// re-applied the code's own lookup would assert only that the code agrees with
// itself, and could not express that "never resolved" and "resolve failed" are
// different sentences — which is the distinction an operator needs to know
// whether to press Resolve or fix the spec.

const GATE_CASES = [
  {
    label: 'resolved ok and the field still holds that spec',
    resolved: RESOLVED,
    fieldValue: 'avirtual/clodex-plugins@v2:packs/notes',
    enabled: true,
    reason: '',
  },
  {
    label: 'resolved ok but the field was edited afterwards',
    resolved: RESOLVED,
    fieldValue: 'avirtual/clodex-plugins@v3:packs/notes',
    enabled: false,
    reason: 'The spec changed since the last resolve — resolve it again.',
  },
  {
    label: 'the resolve failed',
    resolved: { ok: false, error: 'no manifest.json', spec: 'avirtual/demo' },
    fieldValue: 'avirtual/demo',
    enabled: false,
    reason: 'That resolve did not succeed — fix the spec and resolve again.',
  },
  {
    label: 'nothing resolved yet',
    resolved: null,
    fieldValue: 'avirtual/demo',
    enabled: false,
    reason: 'Resolve the repo first — Clodex reads its manifest before anything is downloaded.',
  },
];

for (const c of GATE_CASES) {
  test(`installState: ${c.label} → ${c.enabled ? 'enabled' : 'disabled'}`, () => {
    assert.deepStrictEqual(
      installState({ resolved: c.resolved, fieldValue: c.fieldValue }),
      { enabled: c.enabled, reason: c.reason },
    );
  });
}

test('the four gate verdicts say three DIFFERENT things', () => {
  const said = GATE_CASES.filter((c) => !c.enabled).map((c) => c.reason);
  assert.strictEqual(new Set(said).size, 3,
    'unresolved, failed and stale must not collapse onto one sentence');
  assert.deepStrictEqual(
    Object.values(INSTALL_REASONS).sort(),
    [...new Set(said)].sort(),
    'every reason the leaf can return is a row above');
});

test('surrounding whitespace in the field is not an edit', () => {
  assert.deepStrictEqual(
    installState({ resolved: RESOLVED, fieldValue: '  avirtual/clodex-plugins@v2:packs/notes  ' }),
    { enabled: true, reason: '' });
});

test('an empty field after a resolve disables Install', () => {
  assert.strictEqual(installState({ resolved: RESOLVED, fieldValue: '' }).enabled, false);
  assert.strictEqual(installState({ resolved: RESOLVED }).enabled, false);
  assert.strictEqual(installState().enabled, false);
});

test('a resolve result with no stamped spec can never enable Install', () => {
  // The stamp is the renderer's job. If it is ever dropped, `resolved.spec` is
  // undefined and must not match a field the operator emptied — the direction
  // that would install something nobody resolved.
  const unstamped = { ...RESOLVED };
  delete unstamped.spec;
  assert.strictEqual(installState({ resolved: unstamped, fieldValue: '' }).enabled, false);
  assert.strictEqual(installState({ resolved: unstamped, fieldValue: RESOLVED.spec }).enabled, false);
});

// ── the warning ─────────────────────────────────────────────────────────────

test('warningText, for a resolve that named a ref', () => {
  assert.strictEqual(
    warningText(RESOLVED),
    "This code will run inside Clodex with the app's full authority, the same as Clodex itself. "
    + 'It comes from github.com/avirtual/clodex-plugins at v2 (commit abc1234). '
    + 'Clodex cannot check what it does — install it only if you trust its author.');
});

test('warningText, for a bare owner/repo (ref null)', () => {
  assert.strictEqual(
    warningText(RESOLVED_NO_REF),
    "This code will run inside Clodex with the app's full authority, the same as Clodex itself. "
    + 'It comes from github.com/avirtual/demo at the default branch (commit def5678). '
    + 'Clodex cannot check what it does — install it only if you trust its author.');
});

test('there is no warning to show before a successful resolve', () => {
  assert.strictEqual(warningText(null), '');
  assert.strictEqual(warningText({ ok: false, error: 'nope' }), '');
});

test('refLabel names the default branch rather than saying nothing', () => {
  assert.strictEqual(refLabel(RESOLVED), 'v2');
  assert.strictEqual(refLabel(RESOLVED_NO_REF), 'the default branch');
  assert.strictEqual(refLabel({ ref: '' }), 'the default branch');
});

// ── the preview ─────────────────────────────────────────────────────────────

test('previewLines names what would land: plugin, id, version, source, commit', () => {
  assert.deepStrictEqual(previewLines(RESOLVED), [
    'Notes — notes v1.2.0',
    'avirtual/clodex-plugins@v2:packs/notes at commit abc1234',
  ]);
});

test('previewLines for a bare repo omits the ref and subpath decorations', () => {
  assert.deepStrictEqual(previewLines(RESOLVED_NO_REF), [
    'Demo — demo v0.1.0',
    'avirtual/demo at commit def5678',
  ]);
});

test('previewLines shows nothing until a resolve succeeds', () => {
  assert.deepStrictEqual(previewLines(null), []);
  assert.deepStrictEqual(previewLines({ ok: false, error: 'nope' }), []);
});

test('sourceLabel is the repo@ref[:subpath] the sidecar records', () => {
  assert.strictEqual(sourceLabel(RESOLVED), 'avirtual/clodex-plugins@v2:packs/notes');
  assert.strictEqual(sourceLabel(RESOLVED_NO_REF), 'avirtual/demo');
  assert.strictEqual(sourceLabel({ repo: 'a/b', ref: 'main' }), 'a/b@main');
});

// ── the wiring renderer.js cannot be tested through ─────────────────────────

function sourceSectionSrc() {
  const start = rendererSrc.indexOf("const pluginsSourceSection = document.getElementById('plugins-source');");
  assert.ok(start >= 0, 'the Install from GitHub… section was not found in renderer.js');
  const end = rendererSrc.indexOf("document.getElementById('btn-plugins-reveal')", start);
  assert.ok(end > start, 'the end of the section was not found');
  const src = rendererSrc.slice(start, end);
  assert.match(src, /plugins\.installFromSource/, 'ENTER: the slice captured the install handler');
  return src;
}

test('the install invoke is guarded by installState and carries the RESOLVED spec', () => {
  const src = sourceSectionSrc();
  assert.ok(src.includes('if (!paintPluginsSourceInstall().enabled) return;'),
    'a disabled button is not a guard: Enter and a stale paint both reach the handler');
  assert.match(src, /plugins\.installFromSource', \[resolved\.spec\]/,
    'installing the LIVE field value would fetch a repo the warning never named');
  assert.strictEqual((src.match(/installFromSource', \[pluginsSourceSpec\.value/g) || []).length, 0);
  assert.match(src, /paintPluginsSourceInstall\(\)/, 'the button state comes from the leaf, not from a local flag');
  assert.match(src, /installState\(\{ resolved: pluginsSourceResolved, fieldValue: pluginsSourceSpec\.value \}\)/,
    'the leaf must be asked with the LIVE field, or an edit after a resolve stays enabled');
});

test('the field re-checks the gate on every keystroke', () => {
  const src = sourceSectionSrc();
  assert.match(src, /pluginsSourceSpec\.addEventListener\('input', \(\) => paintPluginsSourceInstall\(\)\)/,
    'without the input listener, editing after a resolve leaves Install enabled on a stale spec');
});

test('the section reaches exactly two _host methods: resolveSource and installFromSource', () => {
  const src = sourceSectionSrc();
  const calls = [...src.matchAll(/pluginInvoke\('_host', '([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(calls, ['plugins.resolveSource', 'plugins.installFromSource'],
    'plugins.installFromSource already rescans and announces host-side (plugin-host-engine.js); '
    + 'a third call here would be a second rescan, and any other method is outside this section');
});

test('the warning is on screen BEFORE the install invoke exists in the handler', () => {
  const src = sourceSectionSrc();
  const wroteWarning = src.indexOf('paintPluginsSourceNote(pluginsSourceWarning, warningText(pluginsSourceResolved)');
  const installInvoke = src.indexOf("plugins.installFromSource'");
  assert.ok(wroteWarning >= 0, 'the warning element must be written from warningText');
  assert.ok(installInvoke > wroteWarning,
    'the trust warning must be painted by the resolve handler, which precedes the install handler — '
    + 'a warning written after the fetch is a warning about code already on disk');
});

test('opening the dialog clears any resolve left from last time', () => {
  // Escape, Close and a backdrop press all reach closePluginsDialog, which only
  // hides the overlay — the section and `pluginsSourceResolved` outlive it. So
  // the open has to do the clearing, or reopening the dialog shows a preview and
  // a warning from a previous sitting with Install already enabled, and the
  // spec-vs-field check cannot catch it: the field still holds that same spec.
  const m = rendererSrc.match(/async function openPluginsDialog\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'openPluginsDialog not found');
  assert.match(m[0], /closePluginsSourceSection\(\)/,
    'a stale resolve must not survive a close: Install would act on a commit shown minutes ago');
});

test('Install is disabled in the markup and the button exists to be enabled', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="btn-plugins-source-install"[^>]*\bdisabled\b/,
    'the button must ship disabled: the first paint happens only when the section opens');
  assert.match(html, /id="plugins-source-spec"/);
  assert.match(html, /id="plugins-source-warning"/);
  assert.match(html, /id="btn-plugins-source"/);
});

test('Install from GitHub… is hidden on the web surface, like Register', () => {
  assert.match(rendererSrc, /if \(window\.__CLODEX_WEB__\) pluginsSourceBtn\.classList\.add\('hidden'\)/,
    'installFromSource is desktop-only host-side (HOST_DESKTOP_ONLY); the button must not be offered in a browser');
});
