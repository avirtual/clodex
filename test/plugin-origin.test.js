'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { pluginOrigin, ORIGIN_GLYPHS } = require('../renderer/lib/plugin-origin');
const { LIBRARY_REPO } = require('../plugin-source');

const ROWS = [
  {
    what: 'a built-in plugin',
    row: { id: 'core-demo', name: 'Core Demo', root: 'core', rootLabel: 'built in' },
    kind: 'core',
    glyph: '◆',
    label: 'Built in',
  },
  {
    what: 'a plugin installed from the clodex-plugins library',
    row: { id: 'lib-demo', name: 'Lib Demo', root: 'user', source: { repo: 'avirtual/clodex-plugins', ref: 'main', commit: 'abcdef1234' } },
    kind: 'library',
    glyph: '▣',
    label: 'From the clodex-plugins library',
  },
  {
    what: 'a plugin installed from any other GitHub repo',
    row: { id: 'remote-demo', name: 'Remote Demo', root: 'user', source: { repo: 'someone/their-plugin', ref: null, commit: null } },
    kind: 'remote',
    glyph: '↗',
    label: 'From github.com/someone/their-plugin',
  },
  {
    what: 'a local plugin registered from a checkout',
    row: { id: 'link-demo', name: 'Link Demo', root: 'user', linkedFrom: '/Users/someone/src/clodex-demo-plugin', source: null },
    kind: 'local',
    glyph: '▪',
    label: 'Local, registered from /Users/someone/src/clodex-demo-plugin',
  },
];

for (const c of ROWS) {
  test(`${c.what} reads as ${c.kind}`, () => {
    const got = pluginOrigin(c.row);
    assert.strictEqual(got.kind, c.kind);
    assert.strictEqual(got.glyph, c.glyph);
    assert.strictEqual(got.label, c.label);
  });
}

test('the four kinds are distinct in kind, glyph and label', () => {
  const got = ROWS.map((c) => pluginOrigin(c.row));
  assert.strictEqual(got.length, 4, 'ENTER: all four fixture rows were classified');
  for (const field of ['kind', 'glyph', 'label']) {
    const seen = got.map((o) => o[field]);
    assert.strictEqual(new Set(seen).size, 4,
      `two origins share a ${field} (${seen.join(' ')}) — the row would show the operator no difference`);
  }
});

test('the library repo the leaf keys on is the one plugin-source installs from', () => {
  assert.strictEqual(LIBRARY_REPO, 'avirtual/clodex-plugins',
    'ENTER: plugin-source really exports the repo constant this pin compares against');
  assert.strictEqual(pluginOrigin({ root: 'user', source: { repo: LIBRARY_REPO } }).kind, 'library',
    'the leaf mirrors the literal rather than requiring plugin-source (which drags https/tar '
    + 'into the web bundle); this is what makes the two copies drift-proof');
});

test('a plugin authored in place, with no link and no source, is local', () => {
  const got = pluginOrigin({ id: 'plain', root: 'user', linkedFrom: null, source: null });
  assert.strictEqual(got.kind, 'local');
  assert.strictEqual(got.label, 'Local');
});

test('core wins over a source sidecar on the same row', () => {
  assert.strictEqual(
    pluginOrigin({ root: 'core', source: { repo: 'someone/their-plugin' } }).kind, 'core',
    'a built-in shipped in the app is built in whatever a stray sidecar beside it says',
  );
});

test('a source object with no repo falls through to local rather than naming an empty repo', () => {
  const got = pluginOrigin({ root: 'user', source: { repo: '', ref: 'main' } });
  assert.strictEqual(got.kind, 'local');
  assert.ok(!/github\.com/.test(got.label), 'a repo-less source must not render "From github.com/"');
});

test('a missing row is classified rather than thrown over', () => {
  assert.strictEqual(pluginOrigin(null).kind, 'local');
  assert.strictEqual(pluginOrigin(undefined).glyph, ORIGIN_GLYPHS.local);
});

test('every glyph is one character and renders as text, not as emoji', () => {
  // `↗` (U+2197) HAS an emoji variant, so Extended_Pictographic is the wrong
  // property to key on here. What matters is the DEFAULT: Emoji_Presentation is
  // false and no variation selector forces the other one, so the glyph renders
  // in the row's monospace face at one column like the three shapes beside it.
  for (const [kind, glyph] of Object.entries(ORIGIN_GLYPHS)) {
    assert.strictEqual([...glyph].length, 1, `${kind} must be one character wide, or the names stop aligning`);
    assert.ok(!/\p{Emoji_Presentation}/u.test(glyph), `${kind} defaults to emoji presentation`);
    assert.ok(!/\uFE0F/.test(glyph), `${kind} carries VS16, which asks for the emoji rendering`);
  }
});
