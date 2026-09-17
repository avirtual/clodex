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

function makeApi() {
  const calls = { index: 0, page: [], external: [] };
  return {
    calls,
    api: {
      helpIndex: async () => { calls.index += 1; return { ok: true, ...corpus.index() }; },
      helpPage: async (name) => {
        calls.page.push(name);
        if (PAGES[name]) return { ok: true, name, title: `${name} title`, content: PAGES[name] };
        const doc = corpus.get(name);
        return doc ? { ok: true, name: doc.name, title: doc.title, content: doc.content } : { ok: false };
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
  const { api, calls } = makeApi();
  const panel = initHelpPanel({ api });
  global.document = prev;
  return { panel, byId, calls, doc };
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

  input.value = 'zzqqx';
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
