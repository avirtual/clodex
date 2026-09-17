'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { parseDoc } = require('../doc-parse.js');

const VOID = new Set(['BR', 'HR', 'IMG', 'INPUT']);

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;');
}

class FakeText {
  constructor(data) { this.nodeType = 3; this.data = String(data); this.parentNode = null; }
  get textContent() { return this.data; }
  serialize() { return escapeText(this.data); }
}

class FakeEl {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = new Map();
    this.parentNode = null;
    this._html = null;
  }
  get textContent() {
    if (this._html !== null) return '';
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this._html = null;
    this.children = [];
    if (String(v) !== '') this.appendChild(new FakeText(v));
  }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get innerHTML() {
    if (this._html !== null) return this._html;
    return this.children.map((c) => c.serialize()).join('');
  }
  setAttribute(k, v) { this.attrs.set(String(k), String(v)); }
  getAttribute(k) { return this.attrs.has(String(k)) ? this.attrs.get(String(k)) : null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  serialize() {
    const attrs = [...this.attrs].map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
    const open = `<${this.tagName.toLowerCase()}${attrs}>`;
    if (VOID.has(this.tagName)) return open;
    return `${open}${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }
  descendants() {
    const out = [];
    for (const c of this.children) {
      out.push(c);
      if (c.nodeType === 1) out.push(...c.descendants());
    }
    return out;
  }
}

class FakeFragment extends FakeEl {
  constructor() { super('#fragment'); this.nodeType = 11; }
  serialize() { return this.innerHTML; }
}

function fakeDocument() {
  return {
    createElement: (t) => new FakeEl(t),
    createTextNode: (t) => new FakeText(t),
    createDocumentFragment: () => new FakeFragment(),
  };
}

function load() {
  delete require.cache[require.resolve('../renderer/lib/render-doc')];
  return require('../renderer/lib/render-doc').renderDoc;
}

const httpOnly = (href) => (/^https?:\/\//i.test(href) ? { kind: 'external', url: href } : null);

function render(src, resolveHref = httpOnly) {
  const document = fakeDocument();
  const frag = load()(parseDoc(src), { resolveHref, document });
  return { frag, html: frag.serialize(), text: frag.textContent };
}

function tags(frag) {
  return frag.descendants().filter((n) => n.nodeType === 1).map((n) => n.tagName);
}

test('block shapes render to their own elements', () => {
  const { frag, html } = render([
    '# Title', '', 'A **bold** and `code`.', '', '- one', '- two', '',
    '```sh', 'echo hi', '```', '', '> quoted', '', '---', '',
    '| a | b |', '| --- | --- |', '| 1 | 2 |',
  ].join('\n'));
  assert.ok(tags(frag).length >= 15, `only ${tags(frag).length} elements`);
  assert.ok(html.includes('<h1 id="title">Title</h1>'), html);
  assert.ok(html.includes('<p>A <strong>bold</strong> and <code>code</code>.</p>'), html);
  assert.ok(html.includes('<ul><li><p>one</p></li><li><p>two</p></li></ul>'), html);
  assert.ok(html.includes('<pre><code data-lang="sh">echo hi</code></pre>'), html);
  assert.ok(html.includes('<blockquote><p>quoted</p></blockquote>'), html);
  assert.ok(html.includes('<hr>'), html);
  assert.ok(html.includes('<th>a</th>'), html);
  assert.ok(html.includes('<td>2</td>'), html);
});

test('headings carry their slug as an id and anchors become a span', () => {
  const { html } = render('## Run the desktop app\n\n<a name="callback-conventions"></a>\n');
  assert.ok(html.includes('<h2 id="run-the-desktop-app">Run the desktop app</h2>'), html);
  assert.ok(html.includes('<span id="callback-conventions"></span>'), html);
});

test('an ordered list keeps a non-1 start', () => {
  const { html } = render('7. seven\n8. eight\n');
  assert.ok(html.startsWith('<ol start="7">'), html);
  assert.ok(!render('1. one\n').html.includes('start='), 'a 1-start needs no attribute');
});

const INJECTIONS = [
  {
    name: 'a script tag in a paragraph',
    src: '<script>alert(1)</script>',
    text: '<script>alert(1)</script>',
    html: '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    tag: 'SCRIPT',
  },
  {
    name: 'an img with an onerror handler',
    src: 'before <img src=x onerror=y> after',
    text: 'before <img src=x onerror=y> after',
    html: '<p>before &lt;img src=x onerror=y&gt; after</p>',
    tag: 'IMG',
  },
  {
    name: 'a javascript: link',
    src: '[x](javascript:alert(1))',
    text: 'x',
    html: '<p>x</p>',
    tag: 'A',
  },
  {
    name: 'an entity-encoded script tag',
    src: '&lt;script&gt;alert(1)&lt;/script&gt;',
    text: '<script>alert(1)</script>',
    html: '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    tag: 'SCRIPT',
  },
  {
    name: 'markup inside a fenced block',
    src: '```\n<script>alert(1)</script>\n```',
    text: '<script>alert(1)</script>',
    html: '<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>',
    tag: 'SCRIPT',
  },
  {
    name: 'markup inside a table cell',
    src: '| a |\n| --- |\n| <img src=x onerror=y> |',
    text: 'a<img src=x onerror=y>',
    html: '<table><thead><tr><th>a</th></tr></thead><tbody><tr>'
      + '<td>&lt;img src=x onerror=y&gt;</td></tr></tbody></table>',
    tag: 'IMG',
  },
  {
    name: 'markup inside a heading',
    src: '## <script>alert(1)</script>',
    text: '<script>alert(1)</script>',
    html: '<h2 id="scriptalert1script">&lt;script&gt;alert(1)&lt;/script&gt;</h2>',
    tag: 'SCRIPT',
  },
];

for (const row of INJECTIONS) {
  test(`injection: ${row.name} serializes as escaped text`, () => {
    const { frag, html, text } = render(row.src);
    assert.ok(tags(frag).length >= 1, `nothing rendered for ${row.name}`);
    assert.strictEqual(text, row.text);
    assert.strictEqual(html, row.html);
    assert.ok(!tags(frag).includes(row.tag), `a ${row.tag} element was created: ${html}`);
  });
}

test('an external link carries target and rel, and its href', () => {
  const { frag, html } = render('see [docs](https://example.com/a?b=1&c=2)');
  const anchors = frag.descendants().filter((n) => n.tagName === 'A');
  assert.strictEqual(anchors.length, 1);
  assert.strictEqual(anchors[0].getAttribute('href'), 'https://example.com/a?b=1&c=2');
  assert.strictEqual(anchors[0].getAttribute('target'), '_blank');
  assert.strictEqual(anchors[0].getAttribute('rel'), 'noreferrer noopener');
  assert.strictEqual(anchors[0].textContent, 'docs');
  assert.ok(html.includes('rel="noreferrer noopener"'), html);
});

test('a page or anchor link becomes a data-attribute stub, never a real href', () => {
  const resolve = (href) => (href.startsWith('#')
    ? { kind: 'anchor', slug: href.slice(1) }
    : { kind: 'page', name: 'messaging', slug: 'parking' });
  const { frag, html } = render('[here](#callback-conventions) and [there](messaging.md#parking)', resolve);
  const anchors = frag.descendants().filter((n) => n.tagName === 'A');
  assert.strictEqual(anchors.length, 2);
  assert.strictEqual(anchors[0].getAttribute('href'), '#');
  assert.strictEqual(anchors[0].getAttribute('data-slug'), 'callback-conventions');
  assert.strictEqual(anchors[0].getAttribute('data-page'), null);
  assert.strictEqual(anchors[1].getAttribute('data-page'), 'messaging');
  assert.strictEqual(anchors[1].getAttribute('data-slug'), 'parking');
  assert.ok(!html.includes('messaging.md'), html);
});

test('a null resolveHref renders the link children as inline text with no anchor', () => {
  const { frag, html, text } = render('a [`x`](javascript:alert(1)) b', () => null);
  assert.strictEqual(frag.descendants().filter((n) => n.tagName === 'A').length, 0);
  assert.strictEqual(text, 'a x b');
  assert.ok(html.includes('<code>x</code>'), html);
  assert.ok(!html.includes('javascript:'), html);
});

test('a missing resolveHref renders every link as text', () => {
  const document = fakeDocument();
  const frag = load()(parseDoc('[x](https://example.com)'), { document });
  assert.strictEqual(frag.descendants().filter((n) => n.tagName === 'A').length, 0);
  assert.strictEqual(frag.textContent, 'x');
});

test('the whole plugin API page renders with no markup escaping into the DOM', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'plugin-api.md'), 'utf8');
  const { frag, html } = render(src);
  assert.ok(tags(frag).length > 500, `only ${tags(frag).length} elements`);
  assert.ok(html.includes('<h1 id="clodex-plugin-api--hostapi-1">'), html.slice(0, 200));
  const allowed = new Set([
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'UL', 'OL', 'LI', 'PRE', 'CODE',
    'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR', 'A',
    'STRONG', 'EM', 'SPAN',
  ]);
  const unexpected = [...new Set(tags(frag))].filter((t) => !allowed.has(t));
  assert.deepStrictEqual(unexpected, []);
});

test('the leaf never names innerHTML', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'lib', 'render-doc.js'), 'utf8',
  );
  assert.ok(src.includes('function renderDoc'), 'read the wrong file, or it moved');
  assert.ok(
    !src.includes('innerHTML'),
    'render-doc.js must build nodes, never assign a string of HTML',
  );
});
