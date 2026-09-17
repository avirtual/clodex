'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const islandSrc = fs.readFileSync(path.join(ROOT, 'renderer/popovers/help-panel.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer/renderer.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');

const { loadHelpCorpus } = require('../help-corpus');
const corpus = loadHelpCorpus(ROOT);

function matches(el, sel) {
  const cls = /^\.([a-z0-9-]+)$/.exec(sel);
  if (cls) return String(el.className || '').split(/\s+/).includes(cls[1]);
  const attr = /^\[([a-z-]+)="([^"]*)"\]$/.exec(sel);
  if (attr) return el.attrs[attr[1]] === attr[2];
  const tag = /^([a-z][a-z0-9]*)$/.exec(sel);
  if (tag) return String(el.tagName).toLowerCase() === tag[1];
  throw new Error(`fake document: unsupported selector ${sel}`);
}

function walk(el, out) {
  for (const child of el.children) {
    if (child.tagName !== '#text') out.push(child);
    walk(child, out);
  }
  return out;
}

function el(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    children: [],
    attrs: {},
    handlers: {},
    parent: null,
    scrolled: 0,
    scrollTop: 0,
    value: '',
    disabled: false,
    focused: 0,
  };
  let text = null;
  node.appendChild = (child) => {
    if (child.tagName === '#fragment') {
      for (const c of child.children) { c.parent = node; node.children.push(c); }
      child.children = [];
      return child;
    }
    child.parent = node;
    node.children.push(child);
    text = null;
    return child;
  };
  node.setAttribute = (k, v) => { node.attrs[k] = String(v); };
  node.getAttribute = (k) => (k in node.attrs ? node.attrs[k] : null);
  node.addEventListener = (type, fn) => { (node.handlers[type] = node.handlers[type] || []).push(fn); };
  node.fire = (type, e) => Promise.all((node.handlers[type] || []).map((fn) => fn(e)));
  node.querySelector = (sel) => walk(node, []).find((c) => matches(c, sel)) || null;
  node.querySelectorAll = (sel) => walk(node, []).filter((c) => matches(c, sel));
  node.closest = (sel) => {
    let cur = node;
    while (cur) { if (matches(cur, sel)) return cur; cur = cur.parent; }
    return null;
  };
  node.focus = () => { node.focused += 1; };
  node.scrollIntoView = () => { node.scrolled += 1; };
  node.classList = {
    add: (c) => { if (!matches(node, `.${c}`)) node.className = `${node.className} ${c}`.trim(); },
    remove: (c) => { node.className = String(node.className).split(/\s+/).filter((x) => x && x !== c).join(' '); },
    contains: (c) => matches(node, `.${c}`),
  };
  Object.defineProperty(node, 'textContent', {
    get: () => (text != null ? text : node.children.map((c) => c.textContent).join('')),
    set(v) { text = v == null ? '' : String(v); node.children = []; },
  });
  return node;
}

const IDS = ['help-overlay', 'help-title', 'help-nav', 'help-body', 'help-search', 'help-back', 'help-fwd', 'help-close'];

function fakeDocument() {
  const byId = new Map();
  for (const id of IDS) { const node = el('div'); node.attrs.id = id; byId.set(id, node); }
  byId.get('help-overlay').className = 'hidden';
  const doc = {
    getElementById: (id) => byId.get(id) || null,
    createElement: el,
    createTextNode: (t) => { const n = el('#text'); n.textContent = t; return n; },
    createDocumentFragment: () => el('#fragment'),
    addEventListener: () => {},
  };
  return { doc, byId };
}

const PAGES = {
  'how-to': [
    '# How to use Clodex',
    '',
    'Jump to [anchors](#anchors) or read [messaging](messaging.md#anchors).',
    'A recipe: [EC2](recipes/aws-ec2.md). Outside: [example](https://example.com).',
    '',
    '## Anchors',
    '',
    'Anchor prose about peering and teams.',
    '',
    '## Second heading',
    '',
    'More prose about zzqqx tokens.',
  ].join('\n'),
  messaging: '# Messaging\n\n## Anchors\n\nMessaging prose.\n',
  architecture: '# Architecture\n\nThe [web box](../docker/web/) lives outside the corpus.\n',
  'recipe-aws-ec2': [
    '# EC2 recipe',
    '',
    'Back to [messaging](../messaging.md) and the [plugin API](../../plugins/plugin-api.md).',
  ].join('\n'),
  cli: '# clodexctl\n\nThe [readme](./README.md) is this page.\n',
};

function pageReply(name) {
  if (PAGES[name]) return { ok: true, name, title: `${name} title`, content: PAGES[name] };
  const doc = corpus.get(name);
  return doc ? { ok: true, name: doc.name, title: doc.title, content: doc.content } : { ok: false };
}

function makeApi() {
  const calls = { index: 0, page: [], external: [] };
  const gates = [];
  const fail = { index: 0, page: 0 };
  const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
  return {
    calls,
    fail,
    settle,
    release: async () => { const held = gates.splice(0, gates.length); for (const g of held) g(); await settle(); },
    hold: (on) => { calls.holding = on; },
    api: {
      helpIndex: async () => {
        calls.index += 1;
        if (calls.holding) await new Promise((r) => gates.push(r));
        if (fail.index > 0) { fail.index -= 1; return { ok: false }; }
        return { ok: true, ...corpus.index() };
      },
      helpPage: async (name) => {
        calls.page.push(name);
        if (calls.holding) await new Promise((r) => gates.push(r));
        if (fail.page > 0) { fail.page -= 1; return { ok: false }; }
        return pageReply(name);
      },
      openExternal: (url) => { calls.external.push(url); },
    },
  };
}

function mount() {
  const { doc, byId } = fakeDocument();
  const prev = global.document;
  global.document = doc;
  const { initHelpPanel } = require('../renderer/popovers/help-panel');
  const harness = makeApi();
  const { api, calls } = harness;
  const panel = initHelpPanel({ api });
  global.document = prev;
  return { panel, byId, calls, doc, harness };
}

async function withDocument(ctx, fn) {
  const prev = global.document;
  global.document = ctx.doc;
  try { return await fn(); } finally { global.document = prev; }
}

function links(bodyEl) {
  return bodyEl.querySelectorAll('a');
}

test('the island never names innerHTML and feeds the shipped leaves', () => {
  assert.ok(!islandSrc.includes('innerHTML'),
    'help-panel.js must never reach for innerHTML: the corpus is rendered in a contextIsolation:false page');
  assert.match(islandSrc, /require\('\.\.\/lib\/render-doc'\)/,
    'the panel must build its nodes with render-doc');
  assert.match(islandSrc, /require\('\.\.\/\.\.\/doc-parse'\)/,
    'the panel must parse the corpus with the doc-parse leaf');
});

test('link resolution: anchors stay in-page, corpus links become pages, the rest go to GitHub', async () => {
  const ctx = mount();
  await withDocument(ctx, () => ctx.panel.openHelpPanel('how-to', null));
  const body = ctx.byId.get('help-body');
  const a = links(body);
  assert.ok(a.length >= 4, `ENTER: the fixture page must render its links, got ${a.length}`);

  const byText = new Map(a.map((node) => [node.textContent, node.attrs]));
  assert.deepStrictEqual(byText.get('anchors'), { href: '#', 'data-slug': 'anchors' });
  assert.deepStrictEqual(byText.get('messaging'), { href: '#', 'data-page': 'messaging', 'data-slug': 'anchors' });
  assert.deepStrictEqual(byText.get('EC2'), { href: '#', 'data-page': 'recipe-aws-ec2' });
  assert.deepStrictEqual(byText.get('example'), {
    href: 'https://example.com', target: '_blank', rel: 'noreferrer noopener',
  });

  await withDocument(ctx, () => ctx.panel.openHelpPanel('architecture', null));
  const outside = links(ctx.byId.get('help-body'));
  assert.deepStrictEqual(outside.map((n) => n.attrs), [{
    href: 'https://github.com/avirtual/clodex/blob/master/docker/web/',
    target: '_blank',
    rel: 'noreferrer noopener',
  }], 'a repo path outside the corpus opens on GitHub');
});

test('a link is resolved against the PAGE\'s own directory, not against docs/', async () => {
  const ctx = mount();
  await withDocument(ctx, () => ctx.panel.openHelpPanel('recipe-aws-ec2', null));
  const fromRecipe = new Map(links(ctx.byId.get('help-body')).map((n) => [n.textContent, n.attrs]));
  assert.strictEqual(fromRecipe.size, 2, 'ENTER: the recipe fixture must render both of its links');
  assert.deepStrictEqual(fromRecipe.get('messaging'), { href: '#', 'data-page': 'messaging' },
    '../messaging.md from docs/recipes/ is docs/messaging.md — from docs/ it would be messaging.md, which is no page');
  assert.deepStrictEqual(fromRecipe.get('plugin API'), { href: '#', 'data-page': 'plugin-api' },
    '../../plugins/plugin-api.md must climb out of docs/recipes/, not out of docs/');

  await withDocument(ctx, () => ctx.panel.openHelpPanel('cli', null));
  const fromCli = links(ctx.byId.get('help-body'));
  assert.deepStrictEqual(fromCli.map((n) => n.attrs), [{ href: '#', 'data-page': 'cli' }],
    './README.md on the CLI page is cli/README.md — the one page whose directory is not docs/');
});

test('opening a page appends render-doc\'s nodes and marks its nav row current', async () => {
  const ctx = mount();
  await withDocument(ctx, () => ctx.panel.openHelpPanel('how-to', null));
  const body = ctx.byId.get('help-body');
  const h1 = body.querySelector('h1');
  assert.ok(h1, 'ENTER: the page\'s H1 element must be in the body');
  assert.strictEqual(h1.textContent, 'How to use Clodex',
    'the H1 text must reach the DOM as a text node');
  assert.strictEqual(ctx.byId.get('help-overlay').classList.contains('hidden'), false,
    'opening must show the overlay');
  assert.ok(ctx.byId.get('help-search').focused >= 1, 'opening must focus the search input');

  const nav = ctx.byId.get('help-nav');
  const current = nav.querySelectorAll('.current');
  assert.deepStrictEqual(current.map((n) => n.attrs['data-page']), ['how-to'],
    'exactly the open page\'s nav row is current');
  assert.deepStrictEqual(nav.querySelectorAll('.help-nav-h2').map((n) => n.textContent),
    ['Anchors', 'Second heading'],
    'the current page\'s H2s sit under its row');

  const missing = mount();
  await withDocument(missing, () => missing.panel.openHelpPanel('nope', null));
  assert.strictEqual(missing.byId.get('help-body').textContent, 'No such help page: nope');
});

test('an anchor click scrolls inside the body instead of navigating', async () => {
  const ctx = mount();
  await withDocument(ctx, () => ctx.panel.openHelpPanel('how-to', null));
  const body = ctx.byId.get('help-body');
  const before = ctx.calls.page.length;
  const anchor = links(body).find((n) => n.attrs['data-slug'] === 'anchors' && !n.attrs['data-page']);
  assert.ok(anchor, 'ENTER: the same-document link must be rendered as a data-slug anchor');
  let prevented = 0;
  await withDocument(ctx, () => body.fire('click', { target: anchor, preventDefault: () => { prevented += 1; } }));
  assert.strictEqual(prevented, 1, 'an in-panel link must not navigate the page');
  assert.strictEqual(ctx.calls.page.length, before, 'a same-document anchor must not refetch a page');
  assert.strictEqual(body.querySelector('[id="anchors"]').scrolled, 1,
    'the heading with that slug must be scrolled into view');
});

test('an external link in the corpus is handed to openExternal, never followed', async () => {
  const ctx = mount();
  await withDocument(ctx, () => ctx.panel.openHelpPanel('how-to', null));
  const body = ctx.byId.get('help-body');
  const ext = links(body).find((n) => n.attrs.href === 'https://example.com');
  await withDocument(ctx, () => body.fire('click', { target: ext, preventDefault: () => {} }));
  assert.deepStrictEqual(ctx.calls.external, ['https://example.com']);
});

test('back and forward walk the in-panel history', async () => {
  const ctx = mount();
  await withDocument(ctx, () => ctx.panel.openHelpPanel('how-to', null));
  await withDocument(ctx, () => ctx.panel.openHelpPanel('messaging', null));
  const title = ctx.byId.get('help-title');
  assert.strictEqual(title.textContent, 'Clodex Help — messaging title',
    'ENTER: the second open must be the one on screen');

  await withDocument(ctx, () => ctx.byId.get('help-back').fire('click', {}));
  assert.strictEqual(title.textContent, 'Clodex Help — how-to title', 'back must show the previous page');
  assert.strictEqual(ctx.byId.get('help-body').querySelector('h1').textContent, 'How to use Clodex');

  await withDocument(ctx, () => ctx.byId.get('help-fwd').fire('click', {}));
  assert.strictEqual(title.textContent, 'Clodex Help — messaging title', 'forward must return to the later page');
  assert.strictEqual(ctx.byId.get('help-body').querySelector('h1').textContent, 'Messaging');
});

test('search swaps the nav only at two characters, and Escape clears without closing', async () => {
  const ctx = mount();
  await withDocument(ctx, () => ctx.panel.openHelpPanel('how-to', null));
  const nav = ctx.byId.get('help-nav');
  const input = ctx.byId.get('help-search');
  assert.ok(nav.querySelectorAll('.help-nav-page').length >= 17,
    `ENTER: the resting nav must list the corpus, got ${nav.querySelectorAll('.help-nav-page').length}`);

  input.value = 'z';
  await withDocument(ctx, () => input.fire('input', {}));
  assert.deepStrictEqual(nav.querySelectorAll('.help-hit'), [], 'one character must leave the nav alone');
  assert.ok(nav.querySelectorAll('.help-nav-page').length >= 17, 'the page list must survive a one-char query');

  input.value = 'zz';
  await withDocument(ctx, () => input.fire('input', {}));
  const hits = nav.querySelectorAll('.help-hit');
  assert.deepStrictEqual(hits.map((h) => [h.attrs['data-page'], h.attrs['data-slug']]),
    [['how-to', 'how-to-use-clodex'], ['how-to', 'second-heading']],
    'the hit rows replace the page list and carry the page and the anchor, one row per matching section');
  assert.match(hits[1].textContent, /How to use Clodex › Second heading/,
    'a hit row shows "page title › heading" above its snippet');
  assert.match(hits[1].textContent, /zzqqx/, 'and the snippet around the term');
  assert.deepStrictEqual(nav.querySelectorAll('.help-nav-page'), [], 'the page list is gone while searching');

  let stopped = 0;
  await withDocument(ctx, () => input.fire('keydown', { key: 'Escape', stopPropagation: () => { stopped += 1; } }));
  assert.strictEqual(input.value, '', 'Escape in the input clears the query');
  assert.strictEqual(stopped, 1,
    'Escape must stop propagating, or renderer.js\'s global handler closes the panel on the first press');
  assert.strictEqual(ctx.byId.get('help-overlay').classList.contains('hidden'), false,
    'the overlay stays open');
  assert.ok(nav.querySelectorAll('.help-nav-page').length >= 17, 'clearing restores the page list');
});

test('Escape on an EMPTY search box is left to renderer.js, which is what closes the panel', async () => {
  const ctx = mount();
  await withDocument(ctx, () => ctx.panel.openHelpPanel('how-to', null));
  const input = ctx.byId.get('help-search');
  assert.ok(input.focused >= 1,
    'ENTER: opening focuses the search box, so this is the state every Escape starts in');

  let stopped = 0;
  assert.strictEqual(input.value, '', 'ENTER: the box must be empty for this subject');
  await withDocument(ctx, () => input.fire('keydown', { key: 'Escape', stopPropagation: () => { stopped += 1; } }));
  assert.strictEqual(stopped, 0,
    'the input swallowed an Escape with nothing to clear — renderer.js\'s document listener is bubble-phase, '
    + 'so stopping it there makes the ESCAPE_CLOSES row unreachable and Help cannot be closed with the keyboard at all');
});

test('a press on the backdrop closes the panel, a press inside it does not', async () => {
  const ctx = mount();
  await withDocument(ctx, () => ctx.panel.openHelpPanel('how-to', null));
  const overlay = ctx.byId.get('help-overlay');

  await withDocument(ctx, () => overlay.fire('mousedown', { target: ctx.byId.get('help-body') }));
  assert.strictEqual(overlay.classList.contains('hidden'), false,
    'a press on the panel body must not dismiss it — every click on a link or the search box would close Help');

  await withDocument(ctx, () => overlay.fire('mousedown', { target: overlay }));
  assert.strictEqual(overlay.classList.contains('hidden'), true, 'a press on the backdrop closes it');
});

test('typing while the search index builds issues ONE corpus read, not one per keystroke', async () => {
  const ctx = mount();
  await withDocument(ctx, () => ctx.panel.openHelpPanel('how-to', null));
  const input = ctx.byId.get('help-search');
  const before = ctx.calls.page.length;

  ctx.harness.hold(true);
  await withDocument(ctx, async () => {
    for (const q of ['zz', 'zzq', 'zzqq', 'zzqqx']) {
      input.value = q;
      input.fire('input', {});
      await ctx.harness.settle();
    }
  });
  ctx.harness.hold(false);
  await withDocument(ctx, () => ctx.harness.release());
  await withDocument(ctx, () => ctx.harness.release());

  const fetched = ctx.calls.page.slice(before);
  const dupes = fetched.filter((name, i) => fetched.indexOf(name) !== i);
  assert.deepStrictEqual(dupes, [],
    'a page was fetched twice while the index was building — the cache memoizes results, not the in-flight promise, '
    + 'so each keystroke starts its own walk of the corpus');
  assert.ok(ctx.calls.index <= 1, `the index was fetched ${ctx.calls.index} times, not once`);
  assert.deepStrictEqual(ctx.byId.get('help-nav').querySelectorAll('.help-hit').map((h) => h.attrs['data-page']),
    ['how-to', 'how-to'], 'and the hits still land for the query that is actually in the box');
});

test('two opens of the same uncached page in flight issue ONE fetch', async () => {
  const ctx = mount();
  await withDocument(ctx, () => ctx.panel.openHelpPanel('how-to', null));
  const before = ctx.calls.page.filter((n) => n === 'messaging').length;
  assert.strictEqual(before, 0, 'ENTER: messaging must be uncached for this subject');

  ctx.harness.hold(true);
  await withDocument(ctx, async () => {
    ctx.panel.openHelpPanel('messaging', null);
    await ctx.harness.settle();
    ctx.panel.openHelpPanel('messaging', null);
    await ctx.harness.settle();
  });
  ctx.harness.hold(false);
  await withDocument(ctx, () => ctx.harness.release());
  await withDocument(ctx, () => ctx.harness.release());

  assert.strictEqual(ctx.calls.page.filter((n) => n === 'messaging').length, 1,
    'the page cache stores the RESULT, so a second open while the first is in flight misses the cache '
    + 'and issues its own fetch — on the web frontend that is a second remote round trip per page');
  assert.strictEqual(ctx.byId.get('help-body').querySelector('h1').textContent, 'Messaging',
    'and the page still lands');
});

test('the search index is memoized by its in-flight promise, not by its result', () => {
  const body = islandSrc.match(/function ensureSearchIndex\(\)[\s\S]*?\n  \}/);
  assert.ok(body, 'ENTER: no ensureSearchIndex function found in the island');
  assert.doesNotMatch(body[0], /await/,
    'ensureSearchIndex awaits, so it memoizes a RESULT: every search started during the ~17-await build '
    + 'runs buildSearchIndex again — a synchronous parseDoc pass over the whole corpus on the main thread, '
    + 'while the user is typing');
  assert.match(body[0], /searchIndexPromise = buildIndex\(\)/,
    'the memo must hold the promise buildIndex returns');
  assert.match(islandSrc, /if \(missing \|\| !pages\.length\) searchIndexPromise = null;/,
    'a build that lost a page must drop the memo, or a partial index is pinned for the renderer\'s lifetime');
});

test('a failed fetch is retried, not cached as an empty corpus for the renderer\'s lifetime', async () => {
  const ctx = mount();
  ctx.harness.fail.index = 1;
  await withDocument(ctx, () => ctx.panel.openHelpPanel('how-to', null));
  assert.deepStrictEqual(ctx.byId.get('help-nav').querySelectorAll('.help-nav-page'), [],
    'ENTER: with the index call failed the nav must be empty, or this subject proves nothing');

  await withDocument(ctx, () => ctx.panel.openHelpPanel('how-to', null));
  assert.ok(ctx.byId.get('help-nav').querySelectorAll('.help-nav-page').length >= 17,
    'a transient index failure was memoized — the nav stays empty forever and every cross-link silently '
    + 'degrades to a GitHub URL, because pageNames never fills');

  const ctx2 = mount();
  ctx2.harness.fail.page = 1;
  await withDocument(ctx2, () => ctx2.panel.openHelpPanel('messaging', null));
  assert.strictEqual(ctx2.byId.get('help-body').textContent, 'No such help page: messaging',
    'ENTER: the failed page must render the miss');
  await withDocument(ctx2, () => ctx2.panel.openHelpPanel('messaging', null));
  assert.strictEqual(ctx2.byId.get('help-body').querySelector('h1').textContent, 'Messaging',
    'a transient page failure was memoized as a permanent miss');
});

test('reopening the page already on screen does not push a dead history entry', async () => {
  const ctx = mount();
  await withDocument(ctx, () => ctx.panel.openHelpPanel('how-to', null));
  await withDocument(ctx, () => ctx.panel.openHelpPanel('messaging', null));
  await withDocument(ctx, () => ctx.panel.openHelpPanel('messaging', null));
  await withDocument(ctx, () => ctx.byId.get('help-back').fire('click', {}));
  assert.strictEqual(ctx.byId.get('help-title').textContent, 'Clodex Help — how-to title',
    'one Back press after reopening the same page must reach the previous page, not repeat the current one');
});

test('PAGE_DIRS covers every manifest page that does not live in docs/', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/help.json'), 'utf8'));
  const map = islandSrc.match(/^const PAGE_DIRS = \{$([\s\S]*?)^\};$/m);
  assert.ok(map, 'ENTER: no PAGE_DIRS literal found in the island');
  const keys = [...map[1].matchAll(/^\s*'?([a-z0-9-]+)'?:/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 4, `ENTER: parsed only ${keys.length} PAGE_DIRS keys`);

  const pages = manifest.sections.flatMap((sec) => sec.pages);
  assert.ok(pages.length >= 17, `ENTER: the manifest scan collected ${pages.length} pages`);
  const uncovered = pages
    .filter((page) => page.path.slice(0, page.path.lastIndexOf('/')) !== 'docs')
    .filter((page) => !page.name.startsWith('recipe-') && !keys.includes(page.name))
    .map((page) => `${page.name} (${page.path})`);
  assert.deepStrictEqual(uncovered, [],
    'a manifest page outside docs/ that PAGE_DIRS does not name falls back to the docs/ base, '
    + 'so every relative link on it resolves against the wrong directory');
});

test('Enter in the search input opens the first hit at its anchor', async () => {
  const ctx = mount();
  await withDocument(ctx, () => ctx.panel.openHelpPanel('messaging', null));
  const input = ctx.byId.get('help-search');
  input.value = 'zzqqx';
  await withDocument(ctx, () => input.fire('input', {}));
  await withDocument(ctx, () => input.fire('keydown', { key: 'Enter' }));
  assert.strictEqual(ctx.byId.get('help-title').textContent, 'Clodex Help — how-to title',
    'Enter must open the page the first hit names');
  assert.strictEqual(ctx.byId.get('help-body').querySelector('[id="how-to-use-clodex"]').scrolled, 1,
    'and scroll it to the hit\'s heading');
});

test('closing keeps the caches: a second open refetches nothing', async () => {
  const ctx = mount();
  await withDocument(ctx, () => ctx.panel.openHelpPanel('how-to', null));
  ctx.panel.closeHelpPanel();
  assert.strictEqual(ctx.byId.get('help-overlay').classList.contains('hidden'), true);
  const after = { index: ctx.calls.index, pages: ctx.calls.page.length };
  await withDocument(ctx, () => ctx.panel.openHelpPanel('how-to', null));
  assert.deepStrictEqual({ index: ctx.calls.index, pages: ctx.calls.page.length }, after,
    'the index is fetched once per renderer lifetime and each page once');
});

test('renderer.js wires the panel into Escape, the opener and the subscription', () => {
  const table = rendererSrc.match(/^const ESCAPE_CLOSES = \[\n[\s\S]*?^\];$/m);
  assert.ok(table, 'ENTER: no ESCAPE_CLOSES table found in renderer.js');
  assert.match(table[0], /\['help-overlay', \(\) => closeHelpPanel\(\)\],/,
    'Escape must reach the panel\'s own closer');
  assert.match(rendererSrc, /const \{ openHelpPanel, closeHelpPanel \} = initHelpPanel\(\{ api: window\.api \}\);/,
    'the island takes window.api injected, never read as a global inside it');
  const stub = rendererSrc.match(/^function openHelp\(.*$/m);
  assert.ok(stub, 'ENTER: no openHelp definition found in renderer.js');
  assert.match(stub[0], /openHelpPanel\(name \|\| 'how-to', slug \|\| null\)/,
    'the S3 stub must now open the panel, defaulting to how-to');
  assert.match(rendererSrc, /window\.api\.onRequestOpenHelp\(\(name, slug\) => openHelp\(name, slug\)\);/,
    'the S3 menu subscription must survive');
});

test('index.html ships the overlay empty, after #report-overlay and before the script', () => {
  const report = htmlSrc.indexOf('<div id="report-overlay"');
  const help = htmlSrc.indexOf('<div id="help-overlay"');
  const script = htmlSrc.indexOf('<script src="renderer.js">');
  assert.ok(report > 0 && script > 0, 'ENTER: the markup anchors must still be in index.html');
  assert.ok(help > report, '#help-overlay must sit after #report-overlay');
  assert.ok(help < script, '#help-overlay must sit before the renderer.js script tag');
  assert.match(htmlSrc, /<nav id="help-nav"><\/nav>/, '#help-nav ships empty — every row is built at runtime');
  assert.match(htmlSrc, /<div id="help-body" class="help-doc"><\/div>/, '#help-body ships empty');
});
