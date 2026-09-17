'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { mkTmpRoot } = require('./lib/tmp-roots');
const { parseDoc } = require('../doc-parse.js');
const { loadHelpCorpus } = require('../help-corpus.js');

const ROOT = path.join(__dirname, '..');

const NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;

const EXCLUDE = new Set([
  'docs/skills/grok.md',
]);

const REPO_LINKS = new Set([
  'peering/clodex.service',
  'peering/README.md',
  'docker/web/',
  'docs/recipes/',
  'docs/notes/headless-restart.md',
  'plugins/README.md',
  'plugins/tools/README.md',
]);

const LINK = /\[([^\]\n]*)\]\(([^)\s]+)\)/g;
const ANCHOR_ID = /<a[ \t]+name=["']([^"']+)["']/g;
const ANY_TAG = /<\/?([a-zA-Z][a-zA-Z0-9]*)(?:[ \t][^>]*?)?\/?>/g;
const ANCHOR_LINE = /^<a[ \t]+name=["'][^"']+["'][ \t]*>[ \t]*(?:<\/a>)?$/;
const STRUCTURAL_TAGS = new Set(['details', 'summary']);
const FENCE = /^\s*(`{3,}|~{3,})/;
const SETEXT = /^ {0,3}(?:={2,}|-{2,})\s*$/;
const BLOCK_MARKER = /^ {0,3}(?:[-*+]|\d+[.)])[ \t]/;

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/help.json'), 'utf8'));

const PAGES = [];
for (const section of manifest.sections) {
  for (const page of section.pages) PAGES.push({ ...page, section: section.title });
}
const BY_PATH = new Map(PAGES.map((p) => [p.path, p]));
const BY_NAME = new Map(PAGES.map((p) => [p.name, p]));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const blank = (s) => s.replace(/[^\n]/g, ' ');

function maskedLines(rel) {
  const lines = read(rel).split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]);
    if (fence) {
      const closing = open && open[1][0] === fence;
      lines[i] = blank(lines[i]);
      if (closing) fence = null;
      continue;
    }
    if (open) {
      fence = open[1][0];
      lines[i] = blank(lines[i]);
    }
  }
  return lines
    .join('\n')
    .split('\n\n')
    .map((chunk) => chunk.replace(/`+[^`]*`+/gs, blank))
    .join('\n\n')
    .split('\n');
}

const anchorCache = new Map();
function anchorsOf(rel) {
  if (anchorCache.has(rel)) return anchorCache.get(rel);
  const src = read(rel);
  const set = new Set(parseDoc(src).headings.map((h) => h.slug));
  ANCHOR_ID.lastIndex = 0;
  for (const m of src.matchAll(ANCHOR_ID)) set.add(m[1]);
  anchorCache.set(rel, set);
  return set;
}

function collectLinks() {
  const out = [];
  for (const page of PAGES) {
    maskedLines(page.path).forEach((line, i) => {
      LINK.lastIndex = 0;
      let m = LINK.exec(line);
      while (m) {
        out.push({ page: page.path, line: i + 1, text: m[1], href: m[2] });
        m = LINK.exec(line);
      }
    });
  }
  return out;
}

function markdownUnder(dir, out) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (rel === 'docs/notes') continue;
      markdownUnder(rel, out);
    } else if (entry.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

function writeFixture(pages, sections) {
  const root = mkTmpRoot('help-corpus-');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  for (const [rel, text] of Object.entries(pages)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  fs.writeFileSync(path.join(root, 'docs/help.json'), JSON.stringify({ version: 1, sections }));
  return root;
}

const FIXTURE_SECTIONS = [
  { title: 'First', pages: [{ name: 'one', path: 'docs/one.md' }] },
  { title: 'Second', pages: [{ name: 'two', path: 'docs/two.md' }] },
];

const FIXTURE_ONE = '# One\n\n## Alpha\n\nalpha body of the first page.\n\n## Beta\n\nbeta body.\n';
const FIXTURE_TWO = '# Two\n\n## Gamma\n\nalpha shows up on the second page too.\n';

test('manifest: every page path exists, names are unique and legal, each page has one H1', () => {
  assert.strictEqual(manifest.version, 1);
  assert.deepStrictEqual(manifest.sections.map((s) => s.title), ['Using Clodex', 'Recipes', 'Reference']);
  assert.strictEqual(PAGES.length, 17, `manifest lists ${PAGES.length} pages`);
  assert.ok(BY_NAME.has('how-to'), 'ENTER: how-to did not survive the manifest read');
  assert.strictEqual(BY_NAME.size, PAGES.length, 'manifest page names are not unique');

  for (const page of PAGES) {
    assert.ok(NAME_RE.test(page.name), `${page.name} does not match remote.js NAME_RE`);
    assert.notStrictEqual(page.name, 'search', 'search is reserved and cannot be a page name');
    assert.ok(page.path.startsWith(`${page.path.split('/')[0]}/`), `${page.path} is not repo-root relative`);
    assert.ok(!page.path.includes('\\'), `${page.path} does not use forward slashes`);
    assert.ok(fs.existsSync(path.join(ROOT, page.path)), `${page.path} does not exist`);
    assert.strictEqual(page.title, undefined, `${page.name} carries a title; titles come from the H1`);
    const h1 = parseDoc(read(page.path)).headings.filter((h) => h.level === 1);
    assert.strictEqual(h1.length, 1, `${page.path} has ${h1.length} H1 headings, expected exactly 1`);
  }
});

test('every docs markdown file is listed or excluded, and docs/notes is never listed', () => {
  const found = markdownUnder('docs', []).sort();
  assert.ok(found.length >= 10, `docs scan returned ${found.length} markdown files`);
  assert.ok(found.includes('docs/how-to.md'), 'ENTER: docs/how-to.md did not survive the docs scan');

  for (const rel of found) {
    assert.ok(
      BY_PATH.has(rel) || EXCLUDE.has(rel),
      `${rel} is neither listed in docs/help.json nor in the test's EXCLUDE list`,
    );
  }
  for (const rel of EXCLUDE) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `EXCLUDE names ${rel}, which is not on disk`);
    assert.ok(!BY_PATH.has(rel), `${rel} is both excluded and listed`);
  }

  const notes = fs.readdirSync(path.join(ROOT, 'docs/notes')).filter((f) => f.endsWith('.md'));
  assert.ok(notes.length >= 20, `docs/notes holds ${notes.length} notes`);
  for (const page of PAGES) {
    assert.ok(!page.path.startsWith('docs/notes/'), `${page.path} is an engineering note, not a reader page`);
  }
  assert.ok(!BY_PATH.has('README.md'), 'README.md is the product page, not a help page');
  assert.ok(!BY_PATH.has('plugins/README.md'), 'plugins/README.md is not a help page');
});

test('every relative link in a listed page resolves', () => {
  const links = collectLinks();
  assert.ok(links.length >= 50, `link scan collected ${links.length} links, floor is 50`);

  let relative = 0;
  for (const link of links) {
    if (/^(?:https?:|mailto:)/.test(link.href) || link.href.startsWith('#')) continue;
    relative += 1;
    const at = `${link.page}:${link.line} [${link.text}](${link.href})`;
    const [target, frag] = link.href.split('#');
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(link.page), target));
    if (BY_PATH.has(resolved)) {
      if (frag) {
        assert.ok(anchorsOf(resolved).has(frag), `${at}: #${frag} is not a heading slug or anchor id in ${resolved}`);
      }
      continue;
    }
    assert.ok(REPO_LINKS.has(resolved), `${at}: ${resolved} is not a listed page and not in REPO_LINKS`);
    assert.ok(fs.existsSync(path.join(ROOT, resolved)), `${at}: REPO_LINKS entry ${resolved} is not on disk`);
  }
  assert.ok(relative >= 30, `only ${relative} relative links found, floor is 30`);

  for (const rel of REPO_LINKS) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `REPO_LINKS names ${rel}, which is not on disk`);
  }
});

test('every same-document anchor link resolves in its own page', () => {
  const links = collectLinks().filter((l) => l.href.startsWith('#'));
  assert.ok(links.length >= 20, `same-document anchor scan collected ${links.length} links, floor is 20`);
  for (const link of links) {
    const frag = link.href.slice(1);
    assert.ok(
      anchorsOf(link.page).has(frag),
      `${link.page}:${link.line} [${link.text}](${link.href}): #${frag} is not a heading slug or anchor id in this page`,
    );
  }
});

test('every listed page stays inside the rendered markdown subset', () => {
  let scanned = 0;
  for (const page of PAGES) {
    const lines = maskedLines(page.path);
    scanned += 1;
    lines.forEach((line, i) => {
      const at = `${page.path}:${i + 1}`;
      const t = line.trim();
      if (!t) return;
      assert.ok(!/^ {0,3}\[[^\]]+\]:[ \t]*\S/.test(line), `${at}: reference-style link definition`);
      assert.ok(!t.includes('!['), `${at}: image`);
      assert.ok(!t.includes('[^'), `${at}: footnote`);
      assert.ok(!/^ {0,3}[-*+][ \t]+\[[ xX]\]/.test(line), `${at}: task list item`);
      if (t[0] !== '<') return;
      if (ANCHOR_LINE.test(t)) return;
      ANY_TAG.lastIndex = 0;
      const names = [...t.matchAll(ANY_TAG)].map((m) => m[1].toLowerCase());
      assert.ok(
        names.length > 0 && names.every((n) => STRUCTURAL_TAGS.has(n)),
        `${at}: raw HTML outside the two shapes doc-parse accepts: ${t}`,
      );
    });
    for (let i = 1; i < lines.length; i++) {
      if (!SETEXT.test(lines[i])) continue;
      const prev = lines[i - 1];
      if (!prev.trim()) continue;
      if (BLOCK_MARKER.test(prev) || /^ {0,3}#/.test(prev) || /^ {0,3}[|>]/.test(prev)) continue;
      assert.fail(`${page.path}:${i + 1}: setext heading under "${prev.trim()}"`);
    }
  }
  assert.ok(scanned >= 15, `construct lint scanned ${scanned} files, floor is 15`);
});

test('loadHelpCorpus reads, slices, searches and indexes a fixture corpus', () => {
  const root = writeFixture({ 'docs/one.md': FIXTURE_ONE, 'docs/two.md': FIXTURE_TWO }, FIXTURE_SECTIONS);
  try {
    const corpus = loadHelpCorpus(root);

    assert.deepStrictEqual(corpus.list(), [
      { name: 'one', title: 'One', section: 'First' },
      { name: 'two', title: 'Two', section: 'Second' },
    ]);

    assert.strictEqual(corpus.get('nope'), null);
    assert.strictEqual(corpus.get('../../etc/passwd'), null);
    const one = corpus.get('one');
    assert.deepStrictEqual(
      { name: one.name, title: one.title, section: one.section },
      { name: 'one', title: 'One', section: 'First' },
    );
    assert.strictEqual(one.content, FIXTURE_ONE);

    const alpha = corpus.section('one', 'alpha');
    assert.deepStrictEqual(alpha, {
      name: 'one',
      title: 'One',
      section: 'First',
      slug: 'alpha',
      content: '## Alpha\n\nalpha body of the first page.',
    });
    assert.strictEqual(corpus.section('one', 'nope'), null);
    assert.strictEqual(corpus.section('nope', 'alpha'), null);

    assert.deepStrictEqual(corpus.search(''), []);
    assert.deepStrictEqual(corpus.search('   '), []);
    assert.deepStrictEqual(corpus.search(null), []);
    const hits = corpus.search('alpha');
    assert.deepStrictEqual(
      hits.map((h) => `${h.name}#${h.slug}`).sort(),
      ['one#alpha', 'one#one', 'two#gamma', 'two#two'],
    );
    assert.deepStrictEqual(Object.keys(hits[0]).sort(), ['heading', 'name', 'slug', 'snippet', 'title']);
    assert.strictEqual(hits[0].name, 'one');
    assert.strictEqual(hits[0].heading, 'Alpha');
    assert.ok(hits[0].snippet.includes('alpha body of the first page'), `snippet: ${hits[0].snippet}`);
    assert.strictEqual(corpus.search('alpha', 1).length, 1);
    assert.strictEqual(corpus.search('alpha', 0).length, 1);
    assert.strictEqual(corpus.search('alpha', 1000).length, 4);
    assert.deepStrictEqual(corpus.search('alpha zzz'), []);

    assert.deepStrictEqual(corpus.index(), {
      sections: [
        {
          title: 'First',
          pages: [{
            name: 'one',
            title: 'One',
            headings: [
              { level: 1, text: 'One', slug: 'one' },
              { level: 2, text: 'Alpha', slug: 'alpha' },
              { level: 2, text: 'Beta', slug: 'beta' },
            ],
          }],
        },
        {
          title: 'Second',
          pages: [{
            name: 'two',
            title: 'Two',
            headings: [
              { level: 1, text: 'Two', slug: 'two' },
              { level: 2, text: 'Gamma', slug: 'gamma' },
            ],
          }],
        },
      ],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest path that does not exist throws with the path in the message', () => {
  const root = writeFixture({ 'docs/one.md': FIXTURE_ONE }, [
    { title: 'First', pages: [{ name: 'one', path: 'docs/one.md' }, { name: 'gone', path: 'docs/gone.md' }] },
  ]);
  try {
    const corpus = loadHelpCorpus(root);
    assert.throws(() => corpus.list(), /^Error: help corpus page not found: docs\/gone\.md$/);
    assert.throws(() => corpus.get('gone'), /^Error: help corpus page not found: docs\/gone\.md$/);
    assert.strictEqual(corpus.get('one').title, 'One');
    assert.deepStrictEqual(corpus.search(''), [], 'an empty query must not read a page');
    assert.throws(() => corpus.search('body'), /^Error: help corpus page not found: docs\/gone\.md$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing manifest throws naming docs/help.json', () => {
  const root = mkTmpRoot('help-corpus-');
  try {
    assert.throws(
      () => loadHelpCorpus(root).list(),
      /^Error: help corpus manifest not found: docs\/help\.json$/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('two roots do not share a cache', () => {
  const a = writeFixture({ 'docs/one.md': FIXTURE_ONE, 'docs/two.md': FIXTURE_TWO }, FIXTURE_SECTIONS);
  const b = writeFixture(
    { 'docs/one.md': '# Other One\n\n## Delta\n\nbody.\n', 'docs/two.md': FIXTURE_TWO },
    FIXTURE_SECTIONS,
  );
  try {
    const first = loadHelpCorpus(a);
    const second = loadHelpCorpus(b);
    assert.strictEqual(first.get('one').title, 'One');
    assert.strictEqual(second.get('one').title, 'Other One');
    assert.strictEqual(first.get('one').title, 'One');
    assert.deepStrictEqual(second.section('one', 'delta').content, '## Delta\n\nbody.');
    assert.strictEqual(first.section('one', 'delta'), null);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('the real corpus loads and exposes nothing outside the manifest', () => {
  const corpus = loadHelpCorpus(ROOT);
  const listed = corpus.list();
  assert.strictEqual(listed.length, 17);
  assert.deepStrictEqual(listed.map((p) => p.name), PAGES.map((p) => p.name));
  assert.ok(listed.some((p) => p.name === 'how-to'), 'ENTER: how-to did not survive the corpus load');
  for (const page of listed) assert.ok(page.title, `${page.name} has no title`);
  assert.strictEqual(corpus.get('README'), null);
  assert.strictEqual(corpus.get('grok'), null);
  assert.strictEqual(corpus.get('search'), null);
  assert.strictEqual(corpus.get('help'), null);
  assert.strictEqual(corpus.get('docs/how-to.md'), null);
});
