'use strict';
// render-markdown.test.js — renderer/lib/render-markdown.js, the safe
// markdown-to-DOM leaf frozen into `rhost.lib` (t663).
//
// WHY THE FIXTURE SERIALIZES. The leaf's security property is a NEGATIVE — no
// markup ever reaches the DOM as markup — and a negative cannot be read off the
// node tree the leaf builds, because a tree built by `textContent` and a tree
// built by `innerHTML` have the same shape and the same text. So the stub below
// carries a real serializer: a text node escapes on the way out, an explicit
// innerHTML assignment stores its bytes raw. That asymmetry is the whole
// mechanism — it is what makes `assert(!html.includes('<script'))` a claim about
// the leaf rather than about the fixture, and it is what goes red when one of
// the leaf's textContent writes is swapped for an innerHTML. The same
// escaping-by-round-trip idiom is in plugin-host.test.js's FakeNode, for the
// same reason: no jsdom in this suite.
//
// The injection table's rows are literal input strings with literal expected
// text, never inputs run back through the leaf's own escaping rule — a table
// whose expectation is computed by the code under test asserts only that the
// code agrees with itself.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

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
  // An explicit innerHTML assignment keeps its bytes VERBATIM — that is what a
  // real one does, and pretending otherwise would hide exactly the mistake this
  // file exists to catch.
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

function installDom() {
  const prev = global.document;
  global.document = {
    createElement: (t) => new FakeEl(t),
    createTextNode: (t) => new FakeText(t),
    createDocumentFragment: () => new FakeFragment(),
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    body: new FakeEl('body'),
  };
  return () => { global.document = prev; };
}

function load() {
  delete require.cache[require.resolve('../renderer/lib/render-markdown')];
  return require('../renderer/lib/render-markdown').renderMarkdown;
}

// Renders `src` against the stub and returns the fragment plus its serialized
// html — every assertion below reads one or both.
function render(src) {
  const restore = installDom();
  try {
    const frag = load()(src);
    return { frag, html: frag.serialize(), text: frag.textContent };
  } finally {
    restore();
  }
}

// The shape of a subtree as `tag[attr=value]{text}` — comparable against a
// literal, which is what keeps each row below an expectation rather than a
// restatement of the algorithm.
function shape(node) {
  if (node.nodeType === 3) return node.data;
  const attrs = [...node.attrs].map(([k, v]) => `[${k}=${v}]`).join('');
  const kids = node.children.map(shape).join('');
  return `${node.tagName.toLowerCase()}${attrs}{${kids}}`;
}

function shapeOf(frag) {
  return frag.children.map(shape).join('');
}

// ── Block shapes ────────────────────────────────────────────────────────────

const BLOCKS = [
  ['atx heading', '# Title', 'h1{Title}'],
  ['deep heading', '###### six', 'h6{six}'],
  ['closed heading', '## Title ##', 'h2{Title}'],
  ['paragraph', 'plain words', 'p{plain words}'],
  ['hard-wrapped paragraph folds', 'one\ntwo', 'p{one two}'],
  ['two paragraphs', 'one\n\ntwo', 'p{one}p{two}'],
  ['bullet list', '- a\n- b', 'ul{li{a}li{b}}'],
  ['star bullets', '* a\n* b', 'ul{li{a}li{b}}'],
  ['ordered list', '1. a\n2. b', 'ol{li{a}li{b}}'],
  ['ordered list keeps its start', '3. a\n4. b', 'ol[start=3]{li{a}li{b}}'],
  ['list item folds its hard wrap', '- one\n  two\n- three', 'ul{li{one two}li{three}}'],
  ['blockquote', '> quoted', 'blockquote{p{quoted}}'],
  ['blockquote holds blocks', '> # in\n>\n> out', 'blockquote{h1{in}p{out}}'],
  ['fenced code', '```\nraw *text*\n```', 'pre{code{raw *text*}}'],
  ['fenced code keeps its language', '```js\nlet x;\n```', 'pre{code[data-lang=js]{let x;}}'],
  ['tilde fence', '~~~\nx\n~~~', 'pre{code{x}}'],
  ['unclosed fence runs to the end', '```\na\nb', 'pre{code{a\nb}}'],
  ['inline code', 'a `b` c', 'p{a code{b} c}'],
  ['bold', 'a **b** c', 'p{a strong{b} c}'],
  ['underscore bold', 'a __b__ c', 'p{a strong{b} c}'],
  ['italic', 'a *b* c', 'p{a em{b} c}'],
  ['underscore italic', 'a _b_ c', 'p{a em{b} c}'],
  ['escaped pipe is one cell, backslash dropped', '| a \\| b |\n| --- |', 'table{thead{tr{th{a | b}}}tbody{}}'],
  ['empty input renders nothing', '', ''],
  ['whitespace-only input renders nothing', '\n\n  \n', ''],
];

for (const [name, src, expected] of BLOCKS) {
  test(`block: ${name}`, () => {
    assert.strictEqual(shapeOf(render(src).frag), expected);
  });
}

test('pipe table renders a head and a body', () => {
  const { frag } = render('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
  assert.strictEqual(
    shapeOf(frag),
    'table{thead{tr{th{a}th{b}}}tbody{tr{td{1}td{2}}tr{td{3}td{4}}}}',
  );
});

// splitRow parks `\|` on a NUL while it splits, so a NUL arriving in the input
// would come back out as a `|` it never wrote. renderMarkdown strips NUL at the
// entry to keep that sentinel unforgeable; this pins the strip, not the split.
test('a NUL in the input is dropped, not restored as a pipe', () => {
  const src = `| a${String.fromCharCode(0)}b |\n| --- |`;
  assert.strictEqual(shapeOf(render(src).frag), 'table{thead{tr{th{ab}}}tbody{}}');
});

test('a pipe line with no delimiter rule stays a paragraph', () => {
  assert.strictEqual(shapeOf(render('a | b').frag), 'p{a | b}');
});

test('a safe link becomes an anchor carrying the href', () => {
  const { frag } = render('see [docs](https://example.com/x)');
  assert.strictEqual(
    shapeOf(frag),
    'p{see a[href=https://example.com/x][rel=noreferrer noopener][target=_blank]{docs}}',
  );
});

for (const [name, src, href] of [
  ['http', '[a](http://example.com)', 'http://example.com'],
  ['https', '[a](https://example.com)', 'https://example.com'],
]) {
  test(`allowlisted scheme: ${name}`, () => {
    const { frag } = render(src);
    const a = frag.descendants().find((n) => n.nodeType === 1 && n.tagName === 'A');
    assert.ok(a, `${name} should render an anchor`);
    assert.strictEqual(a.getAttribute('href'), href);
  });
}

// mailto is NOT allowlisted, and the reason is not "it is dangerous": external-link.js
// admits only http/https to shell.openExternal, so a mailto anchor in the Electron
// window is inert — a dead affordance rendered onto untrusted content. It renders as
// the literal text it was written as, exactly like a rejected javascript: link.
test('a mailto link renders as text, not an anchor', () => {
  const { frag, text } = render('[a](mailto:x@example.com)');
  assert.strictEqual(shapeOf(frag), 'p{[a](mailto:x@example.com)}');
  assert.ok(text.includes('[a](mailto:x@example.com)'), 'the source survives as text');
});

// ── Injection ───────────────────────────────────────────────────────────────
//
// Each row: an input that carries an attack, `carries` — the literal substring
// that makes it dangerous, checked into the input before anything else runs —
// the tag that must NOT appear in the output, and the literal text that must
// survive as text. A row asserting only the absence would pass over a renderer
// that dropped the input entirely, which is why every row also names what
// survives; `carries` is the mirror of that, and it is a per-row literal rather
// than one regex over the table because the thing that makes an entity row
// dangerous and the thing that makes a `javascript:` row dangerous are not the
// same shape, and one pattern loose enough to cover both covers nothing.

const INJECTION = [
  {
    name: 'script tag',
    src: '<script>alert(1)</script>',
    carries: '<script>',
    forbid: 'SCRIPT',
    survives: '<script>alert(1)</script>',
  },
  {
    name: 'img onerror',
    src: '<img src=x onerror="alert(1)">',
    carries: 'onerror=',
    forbid: 'IMG',
    survives: '<img src=x onerror="alert(1)">',
  },
  {
    name: 'markdown image syntax',
    src: '![alt](https://example.com/a.png)',
    carries: '![',
    forbid: 'IMG',
    survives: '![alt](https://example.com/a.png)',
  },
  {
    name: 'javascript: link',
    src: '[click](javascript:alert(1))',
    carries: 'javascript:',
    forbid: 'A',
    survives: '[click](javascript:alert(1))',
  },
  {
    name: 'data: link',
    src: '[x](data:text/html;base64,PHNjcmlwdD4=)',
    carries: 'data:',
    forbid: 'A',
    survives: '[x](data:text/html;base64,PHNjcmlwdD4=)',
  },
  {
    name: 'vbscript: link',
    src: '[x](vbscript:msgbox)',
    carries: 'vbscript:',
    forbid: 'A',
    survives: '[x](vbscript:msgbox)',
  },
  {
    name: 'raw entities stay literal',
    src: 'a &lt;b&gt; c',
    carries: '&lt;',
    forbid: 'B',
    survives: 'a &lt;b&gt; c',
  },
  {
    name: 'iframe in a list item',
    src: '- <iframe src="https://evil.example"></iframe>',
    carries: '<iframe',
    forbid: 'IFRAME',
    survives: '<iframe src="https://evil.example"></iframe>',
  },
  {
    name: 'script inside a table cell',
    src: '| a |\n| --- |\n| <script>x</script> |',
    carries: '<script>',
    forbid: 'SCRIPT',
    survives: '<script>x</script>',
  },
  {
    name: 'script inside a heading',
    src: '# <script>x</script>',
    carries: '<script>',
    forbid: 'SCRIPT',
    survives: '<script>x</script>',
  },
  {
    name: 'script inside emphasis',
    src: '**<script>x</script>**',
    carries: '<script>',
    forbid: 'SCRIPT',
    survives: '<script>x</script>',
  },
  {
    name: 'script as a link label',
    src: '[<script>x</script>](https://example.com)',
    carries: '<script>',
    forbid: 'SCRIPT',
    survives: '<script>x</script>',
  },
];

for (const row of INJECTION) {
  test(`injection: ${row.name}`, () => {
    // ENTER: the INPUT must actually carry the attack, or every assertion below
    // is true of a fixture that was never dangerous.
    assert.ok(
      row.src.includes(row.carries),
      `${row.name}: the input does not carry ${row.carries}`,
    );

    const { frag, html, text } = render(row.src);

    const els = frag.descendants().filter((n) => n.nodeType === 1);
    const tags = els.map((n) => n.tagName);
    assert.ok(
      !tags.includes(row.forbid),
      `${row.name}: a <${row.forbid.toLowerCase()}> element reached the DOM (${tags.join(',')})`,
    );

    assert.ok(
      text.includes(row.survives),
      `${row.name}: the input should survive as text, got ${JSON.stringify(text)}`,
    );

    // The serialized checks read the ESCAPED output, so an attack that survived
    // as text reads `&lt;script`; only markup the leaf itself emitted reads
    // `<script`. That is the asymmetry the fixture's serializer exists for.
    assert.ok(
      !/<script/i.test(html),
      `${row.name}: serialized output contains <script — ${html}`,
    );
    assert.ok(
      !/<img/i.test(html),
      `${row.name}: serialized output contains <img — ${html}`,
    );
    const handlers = els.flatMap((n) => [...n.attrs.keys()].filter((k) => /^on/i.test(k)));
    assert.deepStrictEqual(handlers, [],
      `${row.name}: an element carries an inline event handler`);
  });
}

test('no href on any anchor escapes the allowlist', () => {
  const { frag } = render([
    '[a](https://ok.example)',
    '[b](javascript:alert(1))',
    '[c](data:text/html,x)',
    '[d](mailto:x@example.com)',
    '[e](file:///etc/passwd)',
    '[f](  javascript:alert(1)  )',
    '[g](http://ok2.example)',
  ].join('\n\n'));

  const hrefs = frag.descendants()
    .filter((n) => n.nodeType === 1 && n.tagName === 'A')
    .map((n) => n.getAttribute('href'));

  // ENTER: the two safe rows must have produced anchors — an empty list would
  // satisfy the allowlist assertion vacuously.
  assert.deepStrictEqual(hrefs, ['https://ok.example', 'http://ok2.example']);
});

// A SOURCE-SHAPE pin, and it has to be: build/build-web.js targets safari16, and
// esbuild cannot LOWER a lookbehind — it emits `new RegExp("(?<!…)")` into
// web-dist, which throws SyntaxError at CALL time on Safari 16.0-16.3, out of a
// function whose whole premise is not throwing on untrusted input. Nothing at
// runtime here can see that: node has lookbehind, so every fixture passes, and
// web-dist-fresh.test.js compares bytes rather than parsing them. Raising the
// build target is not the fix — the floor is deliberate.
test('the leaf uses no regex lookbehind (esbuild cannot lower it below safari16)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'lib', 'render-markdown.js'), 'utf8',
  );
  // ENTER: the file must have been read at all — an empty string satisfies every
  // absence below.
  assert.ok(src.includes('function splitRow'), 'read the wrong file, or it moved');
  assert.ok(
    !src.includes('(?<'),
    'a lookbehind in this leaf ships as a runtime `new RegExp` and throws on'
    + ' Safari 16.0-16.3 (build target safari16). Split on a sentinel instead.',
  );
});

test('a deeply nested blockquote is capped rather than overflowing the stack', () => {
  // ENTER: 6000 levels is far past any stack this recursion has; the pre-cap code
  // raised RangeError here.
  const src = '>'.repeat(6000);
  assert.ok(src.length === 6000);
  let out = null;
  assert.doesNotThrow(() => { out = render(src); }, 'must not throw on hostile nesting');
  assert.ok(out.frag.children.length >= 1, 'it still renders something');
});

// CONTROL for the cap: a realistic depth must still nest, or the fix above could
// have been "stop nesting at all" and the test would not know.
test('a 3-deep blockquote still nests', () => {
  assert.strictEqual(
    shapeOf(render('> > > deep').frag),
    'blockquote{blockquote{blockquote{p{deep}}}}',
  );
});

test('a fence never becomes markup, however it is fed', () => {
  const { frag, html } = render('```html\n<script>alert(1)</script>\n<img src=x onerror=y>\n```');
  assert.strictEqual(
    shapeOf(frag),
    'pre{code[data-lang=html]{<script>alert(1)</script>\n<img src=x onerror=y>}}',
  );
  assert.ok(!/<script/i.test(html), `fenced script leaked: ${html}`);
});

// ── The frozen surface ──────────────────────────────────────────────────────

test('rhost.lib is frozen and lends exactly these two leaves', () => {
  const restore = installDom();
  try {
    delete require.cache[require.resolve('../renderer/plugin-host')];
    delete require.cache[require.resolve('../renderer/lib/format')];
    const { initPluginHost } = require('../renderer/plugin-host');
    const host = initPluginHost({
      getActiveSession: () => null,
      sessionTypeOf: () => 'claude',
      activeIsAgent: () => true,
      activePeerQueryable: () => false,
      activePeerConfigurable: () => false,
      scheduleSidebarRelayout: () => {},
      getWorkspaceId: () => 'ws-1',
    });
    let lib = null;
    host.activate('demo', { activate: (rhost) => { lib = rhost.lib; } }, {});

    assert.ok(lib, 'the plugin was activated and saw an rhost');
    assert.deepStrictEqual(Object.keys(lib).sort(), ['renderDiffHtml', 'renderMarkdown'],
      'widening rhost.lib is a published API change');
    assert.ok(Object.isFrozen(lib));
    assert.strictEqual(typeof lib.renderMarkdown, 'function');
    assert.strictEqual(lib.renderMarkdown('# hi').children[0].tagName, 'H1');
  } finally {
    delete require.cache[require.resolve('../renderer/plugin-host')];
    delete require.cache[require.resolve('../renderer/lib/format')];
    restore();
  }
});
