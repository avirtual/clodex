'use strict';
// library-prompt-cache.test.js — t790 r1: the New Session / Args prompt pickers
// read the LIBRARY only, never the team rows listPrompts now also returns.
//
// The failure this closes: `prompts:list` gained team-owned rows, and the three
// feeds into promptLibCache filtered by `kind` alone. A stem a team shadows then
// drew TWICE in the append checklist, and collectAppendChecklist returned it
// twice — composing the same append body into the seat twice. A team-only stem
// was offered to an ordinary session, where a bare stem resolves against the
// library and finds nothing.
//
// The duplicate is asserted through the real renderAppendChecklist +
// collectAppendChecklist round trip rather than off the cache object alone: the
// double-compose is what actually harms a seat, and a cache-shape assertion
// would pass against a renderer that de-duped in one picker and not the other.
//
// jsdom is not a dependency; the DOM here is the minimum the render function
// touches, the same shape test/plugin-prompt-checklist.test.js uses.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function el(tag) {
  const e = {
    tagName: tag, className: '', type: '', value: '', checked: false, disabled: false,
    innerHTML: '', children: [],
    appendChild(c) { c.parent = e; e.children.push(c); return c; },
    querySelectorAll(sel) {
      const flat = [];
      const walk = (n) => { for (const c of n.children) { flat.push(c); walk(c); } };
      walk(e);
      if (sel === '.check-group, .bundle-row') return [];
      return flat.filter((c) => c.tagName === 'input' && c.type === 'checkbox' && c.checked);
    },
    remove() { const i = e.parent ? e.parent.children.indexOf(e) : -1; if (i >= 0) e.parent.children.splice(i, 1); },
  };
  let text = '';
  Object.defineProperty(e, 'textContent', {
    get: () => text,
    set(v) { text = v == null ? '' : String(v); e.innerHTML = text; },
  });
  return e;
}

function withDom(fn) {
  const had = global.document;
  global.document = { createElement: el, addEventListener() {} };
  try { return fn(); } finally { global.document = had; }
}

const {
  libraryPromptCache, setPromptLibCache, getPromptLibCache,
  renderAppendChecklist, collectAppendChecklist, setPluginCatalogCache,
} = withDom(() => require('../renderer/lib/checklists'));

// One library `a`, the team's shadowing copy of `a`, and a team-only `b` — the
// exact three rows a merged listPrompts hands these feeds.
const ROWS = [
  { name: 'a', kind: 'append', body: 'library a\n' },
  { name: 'a', kind: 'append', body: 'team a\n', team: 'shop', id: 'team:shop:append:a' },
  { name: 'b', kind: 'append', body: 'team b\n', team: 'shop', id: 'team:shop:append:b' },
  { name: 's', kind: 'system', body: 'library s\n' },
  { name: 's', kind: 'system', body: 'team s\n', team: 'shop', id: 'team:shop:system:s' },
];

test('libraryPromptCache keeps exactly one `a` and drops the team-only `b`', () => {
  const cache = libraryPromptCache(ROWS);
  assert.deepStrictEqual(cache.append.map((p) => p.name), ['a'],
    'one append row: the shadowed stem must not appear twice');
  assert.strictEqual(cache.append[0].body, 'library a\n',
    'and the surviving row is the LIBRARY copy — a bare stem resolves there for a non-team session');
  assert.ok(!cache.append.some((p) => p.name === 'b'),
    'the team-only stem is not offered: an ordinary session would resolve it to nothing');
  assert.deepStrictEqual(cache.system.map((p) => p.name), ['s'], 'same fence on the system rail');
});

test('libraryPromptCache still splits by kind, and survives a missing list', () => {
  // ENTER: the kind split is the behaviour the filter was bolted onto — a helper
  // that dropped everything would satisfy the fence assertions above on its own.
  const cache = libraryPromptCache([
    { name: 'sys', kind: 'system', body: 'S' },
    { name: 'app', kind: 'append', body: 'A' },
  ]);
  assert.deepStrictEqual(cache.system.map((p) => p.name), ['sys']);
  assert.deepStrictEqual(cache.append.map((p) => p.name), ['app']);
  assert.deepStrictEqual(libraryPromptCache(null), { system: [], append: [] },
    'a failed listing is an empty cache, not a throw');
});

test('the append checklist draws one row per stem, so collect composes it ONCE', () => withDom(() => {
  setPluginCatalogCache([]);
  setPromptLibCache(libraryPromptCache(ROWS));
  const container = el('div');
  renderAppendChecklist(container, new Set(['a']));
  assert.deepStrictEqual(collectAppendChecklist(container), ['a'],
    'the ticked stem is returned ONCE — twice would compose the same append body into the seat twice');
  const labels = container.children.filter((c) => c.className === 'agent-check');
  assert.strictEqual(labels.length, 1,
    `one checkbox row, not one per copy on disk — got ${labels.length}`);
}));

test('the cache the pickers read is what the fence produced', () => withDom(() => {
  setPromptLibCache(libraryPromptCache(ROWS));
  assert.deepStrictEqual(getPromptLibCache().append.map((p) => p.name), ['a'],
    'fillSystemPromptSelect and renderAppendChecklist both read this object');
}));

// Source-shape: the helper being right proves nothing if a feed bypasses it.
// These are the three assignments that fill the cache — the New Session dialog's
// own load, the peer-catalog path, and the Args dialog — and each is one line.
test('all three promptLibCache feeds route through the fence', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const feeds = src.match(/setPromptLibCache\(/g) || [];
  assert.strictEqual(feeds.length, 3, `three feeds — got ${feeds.length}; a new one needs the fence too`);
  const fenced = src.match(/setPromptLibCache\(libraryPromptCache\(/g) || [];
  assert.strictEqual(fenced.length, 3,
    'every setPromptLibCache call wraps its rows in libraryPromptCache, or that feed offers team stems to an ordinary session');
});
