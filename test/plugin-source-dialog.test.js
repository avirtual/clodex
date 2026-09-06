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
  INSTALL_REASONS, shortCommit, refLabel, sourceLabel, sourceLine,
  previewLines, updatePreviewLines, warningText, installState,
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
  commit: 'abc1234def5678abc1234def5678abc1234def56',
  commitFull: true,
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
  commitFull: false,
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
      installState({ resolved: c.resolved, fieldValue: c.fieldValue, mode: 'install' }),
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
    [...new Set([...said, ...UPDATE_CASES.filter((c) => !c.enabled).map((c) => c.reason)])].sort(),
    'every reason the leaf can return is a row in one of the two tables');
});

// The update mode's gate is a DIFFERENT question: there is no field to compare
// against, because the id and the ref come from the row's sidecar rather than
// from anything typed. What it asks instead is whether the source moved — an
// enabled Update that would re-fetch the commit already installed is a swap of a
// directory for a byte-identical copy, with the running plugin flagged
// restart-required for nothing.
//
// The `fieldValue` on every row is the value that WOULD enable the install gate,
// so a mode the leaf ignored would show up as an enabled Update on the unchanged
// row rather than as a silent pass.

const UPDATE_RESOLVED = {
  ok: true,
  id: 'notes',
  previousCommit: '1111111aaaaaaa1111111aaaaaaa1111111aaaaa',
  commit: '2222222bbbbbbb2222222bbbbbbb2222222bbbbb',
  changed: true,
  previousVersion: '1.2.0',
  repo: 'avirtual/clodex-plugins',
  ref: 'v2',
  subpath: 'packs/notes',
  manifest: { id: 'notes', name: 'Notes', version: '1.3.0', announce: 'Takes notes.' },
};

const UPDATE_CASES = [
  {
    label: 'the source moved to a new commit',
    resolved: UPDATE_RESOLVED,
    fieldValue: '',
    enabled: true,
    reason: '',
  },
  {
    label: 'the source still resolves to the installed commit',
    resolved: { ...UPDATE_RESOLVED, commit: UPDATE_RESOLVED.previousCommit, changed: false },
    fieldValue: '',
    enabled: false,
    reason: 'The source still resolves to the commit already installed — there is nothing to update to.',
  },
  {
    label: 'the update resolve failed',
    resolved: { ok: false, error: 'no manifest.json' },
    fieldValue: '',
    enabled: false,
    reason: 'That resolve did not succeed — fix the spec and resolve again.',
  },
  {
    label: 'nothing resolved yet',
    resolved: null,
    fieldValue: '',
    enabled: false,
    reason: 'Resolve the repo first — Clodex reads its manifest before anything is downloaded.',
  },
];

for (const c of UPDATE_CASES) {
  test(`installState in update mode: ${c.label} → ${c.enabled ? 'enabled' : 'disabled'}`, () => {
    assert.deepStrictEqual(
      installState({ resolved: c.resolved, fieldValue: c.fieldValue, mode: 'update' }),
      { enabled: c.enabled, reason: c.reason },
    );
  });
}

test('update mode ignores the field entirely, in both directions', () => {
  // The field is HIDDEN in update mode and holds whatever the last install
  // sitting left in it. If the leaf still compared it to `resolved.spec`, an
  // available update would be permanently disabled and Update would do nothing.
  assert.strictEqual(
    installState({ resolved: UPDATE_RESOLVED, fieldValue: 'someone/else', mode: 'update' }).enabled, true);
  const unchanged = { ...UPDATE_RESOLVED, changed: false };
  assert.strictEqual(
    installState({ resolved: unchanged, fieldValue: '', mode: 'update' }).enabled, false);
});

test('the install gate is unreachable from an update-shaped result, and vice versa', () => {
  // Neither result carries the other mode's discriminator: an update result has
  // no `spec`, an install result has no `changed`. A mode argument dropped on
  // the floor therefore fails CLOSED in both directions rather than enabling the
  // wrong button.
  assert.strictEqual(installState({ resolved: UPDATE_RESOLVED, fieldValue: '' }).enabled, false,
    'an update result must not enable the INSTALL gate');
  assert.strictEqual(installState({ resolved: RESOLVED, fieldValue: RESOLVED.spec, mode: 'update' }).enabled, false,
    'an install result has no `changed`, so it must not enable the UPDATE gate');
});

// ── the source line on a fetched row ────────────────────────────────────────

const SOURCE_LINE_CASES = [
  {
    label: 'a ref and a subpath',
    source: { repo: 'avirtual/clodex-plugins', ref: 'v2', subpath: 'packs/notes', commit: 'abc1234def5678abc1234def5678abc1234def56' },
    line: 'From github.com/avirtual/clodex-plugins@v2:packs/notes at abc1234',
  },
  {
    label: 'a ref, no subpath',
    source: { repo: 'avirtual/demo', ref: 'main', subpath: null, commit: 'fedcba9876543210fedcba9876543210fedcba98' },
    line: 'From github.com/avirtual/demo@main at fedcba9',
  },
  {
    label: 'a bare owner/repo names the default branch rather than nothing',
    source: { repo: 'avirtual/demo', ref: null, subpath: null, commit: 'def5678' },
    line: 'From github.com/avirtual/demo@the default branch at def5678',
  },
  {
    label: 'a subpath with no ref',
    source: { repo: 'a/b', ref: null, subpath: 'plugins/foo', commit: '0123456789abcdef0123456789abcdef01234567' },
    line: 'From github.com/a/b@the default branch:plugins/foo at 0123456',
  },
  {
    label: 'a row that is not from a source shows no line at all',
    source: null,
    line: '',
  },
  {
    label: 'a sidecar with no repo is not a source line either',
    source: { repo: null, ref: 'main', subpath: null, commit: 'abc1234' },
    line: '',
  },
];

for (const c of SOURCE_LINE_CASES) {
  test(`sourceLine: ${c.label}`, () => {
    assert.strictEqual(sourceLine(c.source), c.line);
  });
}

test('updatePreviewLines names both versions and both commits', () => {
  assert.deepStrictEqual(updatePreviewLines(UPDATE_RESOLVED), [
    'Notes — notes v1.2.0 → v1.3.0',
    '1111111 → 2222222',
  ]);
});

test('updatePreviewLines still names a side that has no version', () => {
  assert.deepStrictEqual(
    updatePreviewLines({ ...UPDATE_RESOLVED, previousVersion: null, manifest: { id: 'notes', name: 'Notes' } }),
    ['Notes — notes no version → no version', '1111111 → 2222222']);
});

test('updatePreviewLines shows nothing until a resolve succeeds', () => {
  assert.deepStrictEqual(updatePreviewLines(null), []);
  assert.deepStrictEqual(updatePreviewLines({ ok: false, error: 'nope' }), []);
});

// ── the 40-char abbreviation ────────────────────────────────────────────────
//
// `fetchAndValidate` prefers the commits API's FULL sha over the abbreviated one
// in the tarball's directory name, so on the desktop every string above is 40
// characters. Every display of it goes through shortCommit; the object keeps the
// full value, because applyUpdate compares what it re-fetches against the commit
// passed in and a truncated one narrows that check.

test('shortCommit abbreviates a full sha and leaves an already-short one alone', () => {
  assert.strictEqual(shortCommit('abc1234def5678abc1234def5678abc1234def56'), 'abc1234');
  assert.strictEqual(shortCommit('def5678'), 'def5678');
  assert.strictEqual(shortCommit(null), '');
  assert.strictEqual(shortCommit(undefined), '');
});

test('the 40-char fixture reaches the preview and the warning ABBREVIATED', () => {
  assert.strictEqual(RESOLVED.commit.length, 40, 'ENTER: the fixture is a full sha, as the desktop produces');
  assert.match(previewLines(RESOLVED)[1], /at commit abc1234$/);
  assert.match(warningText(RESOLVED), /\(commit abc1234\)/);
  assert.strictEqual(sourceLine({ repo: 'a/b', ref: null, subpath: null, commit: RESOLVED.commit }),
    'From github.com/a/b@the default branch at abc1234');
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
  assert.match(src, /installState\(\{\s*resolved: pluginsSourceResolved, fieldValue: pluginsSourceSpec\.value, mode: pluginsSourceMode,/,
    'the leaf must be asked with the LIVE field, or an edit after a resolve stays enabled');
});

test('the field re-checks the gate on every keystroke', () => {
  const src = sourceSectionSrc();
  assert.match(src, /pluginsSourceSpec\.addEventListener\('input', \(\) => paintPluginsSourceInstall\(\)\)/,
    'without the input listener, editing after a resolve leaves Install enabled on a stale spec');
});

test('the section reaches exactly four _host methods, in source order', () => {
  const src = sourceSectionSrc();
  const calls = [...src.matchAll(/pluginInvoke\('_host', '([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(calls, [
    'plugins.resolveSource', 'plugins.applyUpdate', 'plugins.installFromSource', 'plugins.resolveUpdate',
  ], 'installFromSource, applyUpdate and removeSourcePlugin already rescan and announce host-side '
    + '(plugin-host-engine.js); an extra plugins.rescan here would be a second rescan, and any other '
    + 'method is outside this section — removeSourcePlugin belongs to the ROW, not here');
});

// ── update mode ─────────────────────────────────────────────────────────────

test('the update branch applies the commit resolveUpdate returned, for the row that was pressed', () => {
  const src = sourceSectionSrc();
  assert.match(src, /plugins\.applyUpdate', \[pluginsSourceTarget, resolved\.commit\]/,
    'applyUpdate refuses a commit that is not the one it re-fetches, so passing anything but the '
    + 'resolved commit — a re-read of the row, or the abbreviated display value — turns every update '
    + 'into a refusal or, worse, applies a commit the warning never named');
  assert.strictEqual((src.match(/applyUpdate', \[pluginsSourceTarget, shortCommit/g) || []).length, 0,
    'the FULL sha goes to applyUpdate; only the display is abbreviated');
});

test('opening for update hides the field and Resolve, and relabels the button', () => {
  const src = sourceSectionSrc();
  for (const line of [
    "pluginsSourceMode = 'update';",
    'pluginsSourceTarget = p.id;',
    "pluginsSourceInstallBtn.textContent = 'Update';",
    "pluginsSourceLabel.classList.add('hidden');",
    "pluginsSourceSpec.classList.add('hidden');",
    "pluginsSourceResolveBtn.classList.add('hidden');",
  ]) {
    assert.ok(src.includes(line), `openPluginsSourceUpdate must do: ${line}`);
  }
});

test('closing the section puts every one of those back', () => {
  // The section is ONE element serving both modes. A reset that missed a piece
  // would leave the next Install from GitHub… sitting with no field to type in,
  // or an Update button that installs — and the operator would have no way back
  // short of restarting the app.
  const m = rendererSrc.match(/function closePluginsSourceSection\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'closePluginsSourceSection not found');
  for (const line of [
    "pluginsSourceMode = 'install';",
    'pluginsSourceTarget = null;',
    "pluginsSourceInstallBtn.textContent = 'Install';",
    "pluginsSourceLabel.classList.remove('hidden');",
    "pluginsSourceSpec.classList.remove('hidden');",
    "pluginsSourceResolveBtn.classList.remove('hidden');",
  ]) {
    assert.ok(m[0].includes(line), `closePluginsSourceSection must undo: ${line}`);
  }
});

test('Install from GitHub… opens through the full reset, not the partial one', () => {
  // resetPluginsSourceResolve clears the resolve but NOT the mode: opening the
  // install section with it after an update would show the Update button wired
  // to applyUpdate against the last row pressed.
  const m = rendererSrc.match(/pluginsSourceBtn\.addEventListener\('click', \(\) => \{[\s\S]*?\n\}\);/);
  assert.ok(m, 'the Install from GitHub… click handler was not found');
  assert.match(m[0], /closePluginsSourceSection\(\)/,
    'the install open must reset the MODE too, not only the stored resolve');
});

test('the update preview is stamped with the ROW\'s repo/ref before the warning is painted', () => {
  // resolveUpdate returns no repo and no ref — only the sidecar knows them. An
  // unstamped result reaches warningText as `github.com/undefined at the default
  // branch`, which is a trust sentence naming nowhere.
  const src = sourceSectionSrc();
  const stamp = src.indexOf('repo: p.source.repo, ref: p.source.ref, subpath: p.source.subpath');
  assert.ok(stamp >= 0, 'the resolveUpdate result must be stamped from the row\'s source');
  const paint = src.indexOf('warningText(pluginsSourceResolved), \'warn\');', stamp);
  assert.ok(paint > stamp,
    'the stamp must precede the paint, or the warning names a repo the object does not carry yet');
});

test('the warning element is only ever assigned from warningText', () => {
  // t688-r1: an install failure wrote its error over #plugins-source-warning,
  // wiping the trust sentence while Install stayed enabled — the operator was
  // then one click from installing code with no warning on screen. Errors go to
  // the register note; this element holds the trust text or nothing.
  const src = sourceSectionSrc();
  const writes = [...src.matchAll(/paintPluginsSourceNote\(pluginsSourceWarning, ([^;]*?), 'warn'\)/g)]
    .map((m) => m[1].trim());
  assert.ok(writes.length >= 2, 'ENTER: the slice really found the warning writes');
  assert.deepStrictEqual([...new Set(writes)].sort(), ["''", 'warningText(pluginsSourceResolved)'],
    'the only things this element may hold are the trust text and the empty clear');
});

// ── the row's Remove button ─────────────────────────────────────────────────

function pluginRowSrc() {
  const start = rendererSrc.indexOf('async function renderPluginsDialog() {');
  assert.ok(start >= 0, 'renderPluginsDialog was not found');
  const end = rendererSrc.indexOf('function makePluginSettingsPanel(', start);
  assert.ok(end > start, 'the end of renderPluginsDialog was not found');
  const src = rendererSrc.slice(start, end);
  assert.match(src, /plugins\.removeSourcePlugin/, 'ENTER: the slice captured the Remove handler');
  return src;
}

test('Remove asks before it deletes, never after', () => {
  const src = pluginRowSrc();
  const asked = src.indexOf('confirm(`Remove ${name}?');
  const removed = src.indexOf("plugins.removeSourcePlugin'");
  assert.ok(asked >= 0, 'the confirm must name the plugin being removed');
  assert.ok(removed > asked,
    'removeSourcePlugin deletes the directory outright — a confirm after the call confirms nothing');
  assert.match(src, /if \(!confirm\(`Remove \$\{name\}\?[^`]*`\)\) return;/,
    'a confirm whose answer is not read is a prompt, not a guard');
});

test('the row block reaches removeSourcePlugin and nothing else new', () => {
  const src = pluginRowSrc();
  const calls = [...src.matchAll(/pluginInvoke\('_host', '([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(calls, ['plugins.status', 'plugins.unregister', 'plugins.rescan', 'plugins.removeSourcePlugin'],
    'removeSourcePlugin rescans host-side; the unregister above it does not, which is why only that '
    + 'one is followed by an explicit plugins.rescan');
});

test('the source line and the two buttons are driven by the row\'s own `source`', () => {
  const src = pluginRowSrc();
  assert.match(src, /if \(p\.source\) \{[\s\S]{0,200}?sourceLine\(p\.source\)/,
    'the line comes from the leaf, not from a sentence assembled at the row');
  assert.match(src, /if \(p\.source && !window\.__CLODEX_WEB__\)/,
    'applyUpdate and removeSourcePlugin are HOST_DESKTOP_ONLY — the buttons must not be offered in a browser');
  assert.match(src, /if \(p\.linkedFrom && !window\.__CLODEX_WEB__\)/,
    'a symlinked row keeps Unregister; `source` is null for it, so the two blocks never both fire');
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
