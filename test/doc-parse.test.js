'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseDoc, parseInline, slugify, plainText, sectionSlice, buildSearchIndex, search,
} = require('../doc-parse.js');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

function blockKinds(blocks) {
  return blocks.map((b) => b.type);
}

function collectLinks(blocks, out) {
  for (const b of blocks) {
    if (b.type === 'heading') collectInlineLinks(b.text, out);
    else if (b.type === 'paragraph') collectInlineLinks(b.children, out);
    else if (b.type === 'blockquote') collectLinks(b.children, out);
    else if (b.type === 'list') for (const item of b.items) collectLinks(item.children, out);
    else if (b.type === 'table') {
      for (const cell of b.header) collectInlineLinks(cell, out);
      for (const row of b.rows) for (const cell of row) collectInlineLinks(cell, out);
    }
  }
  return out;
}

function collectInlineLinks(nodes, out) {
  for (const n of nodes || []) {
    if (n.type === 'link') out.push(n.href);
    if (n.children) collectInlineLinks(n.children, out);
  }
}

function atxOutsideFences(src) {
  let fence = null;
  let n = 0;
  for (const line of src.split('\n')) {
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
      continue;
    }
    if (open) { fence = open[1]; continue; }
    if (/^#{1,6} \S/.test(line)) n += 1;
  }
  return n;
}

function collectAnchors(blocks, out) {
  for (const b of blocks) {
    if (b.type === 'anchor') out.push(b.id);
    else if (b.type === 'blockquote') collectAnchors(b.children, out);
    else if (b.type === 'list') for (const item of b.items) collectAnchors(item.children, out);
  }
  return out;
}

test('a bullet item with 5-space ordered children keeps them as a nested ordered list', () => {
  const lines = read('docs/messaging.md').split('\n');
  const slice = lines.slice(253, 283);
  assert.strictEqual(slice.length, 30);
  assert.strictEqual(slice[0], '- One directory per agent under the pending root; one file per message.');
  assert.ok(slice[7].startsWith('- **Three park types,'), `moved: ${slice[7]}`);
  assert.ok(slice[9].startsWith('  1. **Cost/dialog hold-park**'), `moved: ${slice[9]}`);

  const { blocks } = parseDoc(slice.join('\n'));
  assert.deepStrictEqual(blockKinds(blocks), ['list']);
  const list = blocks[0];
  assert.strictEqual(list.ordered, false);
  assert.strictEqual(list.items.length, 3);
  assert.deepStrictEqual(list.items.map((i) => blockKinds(i.children)), [
    ['paragraph'], ['paragraph'], ['paragraph', 'list'],
  ]);

  const nested = list.items[2].children[1];
  assert.strictEqual(nested.ordered, true);
  assert.strictEqual(nested.start, 1);
  assert.strictEqual(nested.items.length, 3);
  assert.deepStrictEqual(nested.items.map((i) => blockKinds(i.children)), [
    ['paragraph'], ['paragraph'], ['paragraph'],
  ]);
});

test('an ordered list keeps a non-1 start', () => {
  const { blocks } = parseDoc('7. seven\n8. eight\n');
  assert.deepStrictEqual(blockKinds(blocks), ['list']);
  assert.strictEqual(blocks[0].ordered, true);
  assert.strictEqual(blocks[0].start, 7);
  assert.strictEqual(blocks[0].items.length, 2);
});

test('code spans win over strong, em and links (inline precedence)', () => {
  assert.deepStrictEqual(parseInline('**a `b`**'), [
    { type: 'strong', children: [{ type: 'text', text: 'a ' }, { type: 'code', text: 'b' }] },
  ]);
  assert.deepStrictEqual(parseInline('[`x`](y)'), [
    { type: 'link', href: 'y', children: [{ type: 'code', text: 'x' }] },
  ]);
  assert.deepStrictEqual(parseInline('*a `b*c` d*'), [
    {
      type: 'em',
      children: [
        { type: 'text', text: 'a ' },
        { type: 'code', text: 'b*c' },
        { type: 'text', text: ' d' },
      ],
    },
  ]);
  assert.deepStrictEqual(parseInline('[a `x]y` z](t)'), [
    {
      type: 'link',
      href: 't',
      children: [
        { type: 'text', text: 'a ' },
        { type: 'code', text: 'x]y' },
        { type: 'text', text: ' z' },
      ],
    },
  ]);
});

test('`_` inside a word never opens em (the catalogs.js entry in docs/architecture.md)', () => {
  const line = read('docs/architecture.md').split('\n').find((l) => l.includes('AGENT_NAME_RE, DEFAULT_WORKSPACE_ID'));
  assert.ok(line, 'fixture line moved: docs/architecture.md no longer names AGENT_NAME_RE, DEFAULT_WORKSPACE_ID');
  assert.strictEqual(line, '  AGENT_NAME_RE, DEFAULT_WORKSPACE_ID, …).');
  const nodes = parseInline('AGENT_NAME_RE, DEFAULT_WORKSPACE_ID');
  assert.deepStrictEqual(nodes, [{ type: 'text', text: 'AGENT_NAME_RE, DEFAULT_WORKSPACE_ID' }]);
  assert.strictEqual(nodes.filter((n) => n.type === 'em').length, 0);
  assert.deepStrictEqual(parseInline('foo_bar_'), [{ type: 'text', text: 'foo_bar_' }]);
  assert.deepStrictEqual(parseInline('_word_'), [
    { type: 'em', children: [{ type: 'text', text: 'word' }] },
  ]);
});

test('a backslash escapes the punctuation after it', () => {
  assert.deepStrictEqual(parseInline('\\*literal\\*'), [{ type: 'text', text: '*literal*' }]);
  assert.deepStrictEqual(parseInline('a \\| b'), [{ type: 'text', text: 'a | b' }]);
});

test('named entities decode in text runs and stay literal inside code spans', () => {
  const line = read('docs/teams.md').split('\n').find((l) => l.includes('**Team &lt;name&gt;**'));
  assert.ok(line, 'fixture line moved: docs/teams.md no longer carries **Team &lt;name&gt;**');

  assert.deepStrictEqual(parseInline('&lt;name&gt;'), [{ type: 'text', text: '<name>' }]);
  assert.deepStrictEqual(parseInline('`&lt;name&gt;`'), [{ type: 'code', text: '&lt;name&gt;' }]);
  assert.deepStrictEqual(parseInline('&amp; &quot; &apos; &#65;'), [
    { type: 'text', text: '& " \' A' },
  ]);
});

test('an escaped entity ampersand does not decode', () => {
  assert.deepStrictEqual(parseInline('\\&lt;name&gt;'), [{ type: 'text', text: '&lt;name>' }]);
});

test('the two HTML shapes, and nothing else, leave the text stream', () => {
  const ec2 = read('docs/recipes/aws-ec2.md').split('\n');
  assert.strictEqual(ec2[79], '<details><summary>The appliance variant (run the container yourself)</summary>');
  assert.strictEqual(ec2[103], '</details>');
  const api = read('plugins/plugin-api.md').split('\n');
  assert.strictEqual(api[953], '<a name="callback-conventions"></a>');

  assert.deepStrictEqual(parseDoc(ec2[79]).blocks, []);
  assert.deepStrictEqual(parseDoc('</details>').blocks, []);
  assert.deepStrictEqual(parseDoc(api[953]).blocks, [{ type: 'anchor', id: 'callback-conventions' }]);
  assert.deepStrictEqual(parseDoc('<b>hi</b>').blocks, [
    { type: 'paragraph', children: [{ type: 'text', text: '<b>hi</b>' }] },
  ]);
  assert.deepStrictEqual(parseDoc('<script>alert(1)</script>').blocks, [
    { type: 'paragraph', children: [{ type: 'text', text: '<script>alert(1)</script>' }] },
  ]);
});

test('slugs follow the GitHub rule and dedupe within one document', () => {
  assert.strictEqual(slugify('Run the desktop app'), 'run-the-desktop-app');
  assert.strictEqual(slugify('4.1 `inject` is typing, not messaging — four rules'),
    '41-inject-is-typing-not-messaging--four-rules');
  const { headings } = parseDoc('## Notes\n\ntext\n\n## Notes\n\nmore\n');
  assert.deepStrictEqual(headings.map((h) => h.slug), ['notes', 'notes-1']);
  assert.deepStrictEqual(headings.map((h) => h.line), [1, 5]);
});

test('every same-document anchor link in plugins/plugin-api.md resolves', () => {
  const parsed = parseDoc(read('plugins/plugin-api.md'));
  const slugs = new Set(parsed.headings.map((h) => h.slug));
  for (const id of collectAnchors(parsed.blocks, [])) slugs.add(id);

  const same = collectLinks(parsed.blocks, []).filter((h) => h.startsWith('#'));
  assert.ok(same.length >= 20, `found only ${same.length} same-doc links`);
  assert.deepStrictEqual(collectAnchors(parsed.blocks, []), ['callback-conventions', 'class-fields']);
  assert.deepStrictEqual(same.filter((h) => !slugs.has(h.slice(1))), []);
});

test('sectionSlice returns one heading section and stops at the next peer', () => {
  const src = read('docs/how-to.md');
  const slice = sectionSlice(src, 'run-the-desktop-app');
  assert.ok(slice.startsWith('## Run the desktop app\n'), `starts: ${slice.slice(0, 40)}`);
  assert.ok(slice.split('\n').length > 10, `only ${slice.split('\n').length} lines`);
  assert.ok(!slice.slice(1).includes('\n## '), 'ran past the next h2');
  assert.ok(!slice.includes('\n# '), 'ran past an h1');
  assert.ok(src.length > slice.length * 2, 'sliced the whole file');
  assert.strictEqual(sectionSlice(src, 'no-such-heading'), null);
});

test('sectionSlice keeps subsections of the named heading', () => {
  const src = '# Top\n\nintro\n\n## A\n\nbody\n\n### A1\n\ndeep\n\n## B\n\nafter\n';
  assert.strictEqual(sectionSlice(src, 'a'), '## A\n\nbody\n\n### A1\n\ndeep');
});

const PAGES = [
  { name: 'alpha', text: '# Widget guide\n\n## Setup\n\nInstall the parts.\n\n## Teardown\n\nRemove the parts.\n' },
  { name: 'beta', text: '# Beta\n\n## Widget notes\n\nheading match only.\n' },
  { name: 'gamma', text: '# Gamma\n\n## Body\n\nThe widget appears once in this body.\n' },
];

test('search ranks a title hit above a heading hit above a body hit', () => {
  const index = buildSearchIndex(PAGES);
  assert.deepStrictEqual(index.map((e) => `${e.name}/${e.slug}`), [
    'alpha/widget-guide', 'alpha/setup', 'alpha/teardown',
    'beta/beta', 'beta/widget-notes',
    'gamma/gamma', 'gamma/body',
  ]);

  const hits = search(index, 'widget');
  assert.deepStrictEqual(hits.map((h) => `${h.name}/${h.slug}`), [
    'alpha/widget-guide', 'alpha/setup', 'alpha/teardown', 'beta/widget-notes',
    'beta/beta', 'gamma/body', 'gamma/gamma',
  ]);
});

test('every search term must match inside one section', () => {
  const index = buildSearchIndex(PAGES);
  assert.deepStrictEqual(
    search(index, 'install remove').map((h) => `${h.name}/${h.slug}`),
    ['alpha/widget-guide'],
  );
  assert.deepStrictEqual(search(index, 'widget nonesuch'), []);
  assert.deepStrictEqual(search(index, '   '), []);
});

test('search carries a snippet and clamps limit to 1..100', () => {
  const index = buildSearchIndex(PAGES);
  const hit = search(index, 'install')[0];
  assert.strictEqual(hit.name, 'alpha');
  assert.ok(hit.snippet.toLowerCase().includes('install'), `snippet: ${hit.snippet}`);
  assert.ok(hit.snippet.length <= 120, `snippet is ${hit.snippet.length} chars`);

  const many = buildSearchIndex([{ name: 'big', text: Array.from({ length: 300 }, (_, i) => `## Section ${i}\n\nwidget\n`).join('\n') }]);
  assert.strictEqual(many.length, 300);
  assert.strictEqual(search(many, 'widget', { limit: 500 }).length, 100);
  assert.strictEqual(search(many, 'widget', { limit: 0 }).length, 1);
  assert.strictEqual(search(many, 'widget', { limit: -3 }).length, 1);
  assert.strictEqual(search(many, 'widget').length, 20);
});

test('search is case-insensitive', () => {
  const index = buildSearchIndex(PAGES);
  assert.deepStrictEqual(
    search(index, 'WIDGET GUIDE').map((h) => h.slug),
    search(index, 'widget guide').map((h) => h.slug),
  );
  assert.ok(search(index, 'WIDGET GUIDE').length > 0);
});

test('parseDoc reports the H1 as the title and every heading with its line', () => {
  const src = read('docs/how-to.md');
  const parsed = parseDoc(src);
  assert.strictEqual(parsed.headings[0].level, 1);
  assert.strictEqual(parsed.title, parsed.headings[0].text);
  assert.ok(parsed.headings.length >= 8, `only ${parsed.headings.length} headings`);
  for (const h of parsed.headings) {
    const line = src.split('\n')[h.line - 1];
    assert.ok(line.startsWith(`${'#'.repeat(h.level)} `), `line ${h.line} is not its heading`);
  }
});

test('a `#` line inside a fence is code, not a heading', () => {
  const parsed = parseDoc('# Real\n\n```sh\n# then:\nrun it\n```\n');
  assert.deepStrictEqual(parsed.headings.map((h) => h.text), ['Real']);
  assert.strictEqual(parsed.blocks[1].text, '# then:\nrun it');
});

test('fences, tables, blockquotes and rules parse to their own blocks', () => {
  const src = [
    '```sh', 'echo # not a heading', '```', '',
    '| a | b |', '| --- | --- |', '| 1 | `x` |', '',
    '> quoted', '> more', '',
    '---', '',
    'tail',
  ].join('\n');
  const { blocks } = parseDoc(src);
  assert.deepStrictEqual(blockKinds(blocks), ['code', 'table', 'blockquote', 'hr', 'paragraph']);
  assert.strictEqual(blocks[0].lang, 'sh');
  assert.strictEqual(blocks[0].text, 'echo # not a heading');
  assert.deepStrictEqual(blocks[1].header, [
    [{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }],
  ]);
  assert.deepStrictEqual(blocks[1].rows, [[
    [{ type: 'text', text: '1' }], [{ type: 'code', text: 'x' }],
  ]]);
  assert.deepStrictEqual(blockKinds(blocks[2].children), ['paragraph']);
});

test('an escaped pipe stays inside its table cell', () => {
  const { blocks } = parseDoc('| a | b |\n| --- | --- |\n| x \\| y | z |\n');
  assert.strictEqual(blocks[0].rows.length, 1);
  assert.deepStrictEqual(blocks[0].rows[0], [
    [{ type: 'text', text: 'x | y' }], [{ type: 'text', text: 'z' }],
  ]);
});

test('plainText flattens blocks to searchable prose without markup', () => {
  const { blocks } = parseDoc('# T\n\nA **bold** and `code`.\n\n- item one\n- item two\n');
  const text = plainText(blocks);
  assert.ok(text.includes('A bold and code.'), text);
  assert.ok(text.includes('item one'), text);
  assert.ok(!text.includes('**'), text);
});

test('the whole shipped corpus parses without throwing and keeps its headings', () => {
  const files = [
    'docs/how-to.md', 'docs/sessions.md', 'docs/messaging.md', 'docs/peering.md',
    'docs/teams.md', 'docs/telemetry.md', 'docs/architecture.md', 'docs/exec-tools.md',
    'docs/renderer-events.md', 'docs/recipes/aws-ec2.md', 'docs/recipes/aws-fargate.md',
    'docs/recipes/kubernetes.md', 'docs/recipes/two-instances.md', 'cli/README.md',
    'plugins/plugin-api.md', 'plugins/plugin-sources.md', 'plugins/what-plugins-can-do.md',
  ];
  assert.strictEqual(files.length, 17);
  let headings = 0;
  for (const rel of files) {
    const src = read(rel);
    const parsed = parseDoc(src);
    assert.ok(parsed.title, `${rel} produced no title`);
    assert.strictEqual(parsed.headings.length, atxOutsideFences(src), `${rel} lost headings`);
    assert.strictEqual(new Set(parsed.headings.map((h) => h.slug)).size, parsed.headings.length,
      `${rel} produced a duplicate slug`);
    headings += parsed.headings.length;
  }
  assert.ok(headings >= 200, `only ${headings} headings across the corpus`);
});
