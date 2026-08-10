'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { scanPaths, scanLinks } = require('../renderer/lib/path-scan');

// Offsets are what both callers convert into a range (xterm cells, HTML
// fragments), so every assertion here checks the WHOLE hit, not just its text —
// an off-by-one in start/end underlines the wrong cells and is invisible in a
// text-only assertion.
const hits = (s) => scanPaths(s);

test('finds a bare filename with a line number', () => {
  assert.deepStrictEqual(hits('see wire-intents.js:71 for the rule'), [
    { start: 4, end: 22, text: 'wire-intents.js:71', path: 'wire-intents.js', line: 71 },
  ]);
});

test('finds a relative path with no line number', () => {
  assert.deepStrictEqual(hits('renderer/lib/format.js'), [
    { start: 0, end: 22, text: 'renderer/lib/format.js', path: 'renderer/lib/format.js', line: null },
  ]);
});

test('finds an absolute path and a ~ path', () => {
  assert.deepStrictEqual(hits('/repo/a.js and ~/.clodex/b.json').map((h) => h.path),
    ['/repo/a.js', '~/.clodex/b.json']);
});

test('finds ./ and ../ prefixed paths', () => {
  assert.deepStrictEqual(hits('./a.js ../b.js').map((h) => h.path), ['./a.js', '../b.js']);
});

test('finds several hits on one line, in order, with non-overlapping offsets', () => {
  const s = 'a.js:1 then b/c.md:22 then d.json';
  const r = hits(s);
  assert.deepStrictEqual(r.map((h) => h.text), ['a.js:1', 'b/c.md:22', 'd.json']);
  // ENTER: three hits survived — the offset checks below assert nothing if the
  // scan returned fewer.
  assert.strictEqual(r.length, 3);
  for (const h of r) assert.strictEqual(s.slice(h.start, h.end), h.text);
  assert.ok(r[0].end <= r[1].start && r[1].end <= r[2].start, 'offsets must not overlap');
});

// The reason the extension list is an allowlist rather than `\w+`.
test('does not claim ordinary prose', () => {
  for (const s of ['this is a sentence.', 'i.e. something', 'version 1.2.3 shipped', 'e.g. that']) {
    assert.deepStrictEqual(hits(s), [], `claimed something in: ${s}`);
  }
});

// A URL's path segments are shaped exactly like a relative path; claiming them
// opens a peek on a file that never existed locally.
test('does not claim a path inside a URL', () => {
  assert.deepStrictEqual(hits('see https://example.com/app.js for docs'), []);
});

test('still finds a real path on a line that also has a URL', () => {
  assert.deepStrictEqual(hits('https://example.com/x.js and local/y.js').map((h) => h.path), ['local/y.js']);
});

test('a trailing colon with no digits is not a line number', () => {
  assert.deepStrictEqual(hits('see a.js: this'), [
    { start: 4, end: 8, text: 'a.js', path: 'a.js', line: null },
  ]);
});

// `tf` sits before `tfvars` in the allowlist, so the alternation reaches it
// first and only the `\b` after the group stops `main.tfvars` from being
// claimed as `main.tf` plus stray text. Dropping that `\b` — or sorting the
// list — silently truncates every prefix pair.
test('an extension that prefixes another still matches the longer one whole', () => {
  assert.deepStrictEqual(hits('terraform.tfvars and network.tf').map((h) => h.path),
    ['terraform.tfvars', 'network.tf']);
  assert.deepStrictEqual(hits('terraform.tfstate').map((h) => h.path), ['terraform.tfstate']);
});

test('finds infra paths with a line number', () => {
  assert.deepStrictEqual(hits('modules/vpc/main.tf:42 blew up'), [
    { start: 0, end: 22, text: 'modules/vpc/main.tf:42', path: 'modules/vpc/main.tf', line: 42 },
  ]);
  assert.deepStrictEqual(hits('providers.hcl').map((h) => h.path), ['providers.hcl']);
});

test('an unknown extension is not claimed', () => {
  assert.deepStrictEqual(hits('archive.tar and thing.xyz'), []);
});

test('empty and non-string input returns no hits rather than throwing', () => {
  for (const v of ['', null, undefined, 42, {}]) assert.deepStrictEqual(scanPaths(v), []);
});

// The regexes are module-level with the `g` flag, so a leftover lastIndex from
// one call would make the next skip its first hit. Both are reset per call.
test('repeated scans of the same text are identical (lastIndex is reset)', () => {
  const s = 'a.js:1 and https://x.dev/b.js and c/d.md';
  assert.deepStrictEqual(scanPaths(s), scanPaths(s));
  assert.deepStrictEqual(scanPaths(s), scanPaths(s)); // third call, in case of parity
});

// --- scanLinks -------------------------------------------------------------
//
// The inbox drawer turns these spans into DOM nodes one-for-one, so a span that
// drops or duplicates text silently corrupts the note body an agent wrote. The
// reassembly assertion below is the invariant that makes the rest safe to trust.

test('spans reassemble to the input byte for byte on a mixed note', () => {
  const s = 'see renderer.js:71 and https://example.com/docs plus ~/.clodex/a.json ok';
  const spans = scanLinks(s);
  // ENTER: without at least one of each kind the reassembly below would hold
  // trivially for a single text span covering everything.
  assert.deepStrictEqual(
    [...new Set(spans.map((x) => x.kind))].sort(),
    ['path', 'text', 'url'],
  );
  assert.strictEqual(spans.map((x) => x.text).join(''), s);
});

test('a bare URL is one url span', () => {
  assert.deepStrictEqual(scanLinks('https://example.com'), [
    { kind: 'url', text: 'https://example.com' },
  ]);
});

// A URL's own path segments are shaped exactly like a relative path. Splitting
// here would both break the link and open a peek on a file that never existed.
test('a URL whose path looks like a file is ONE url span, not url plus path', () => {
  const spans = scanLinks('https://example.com/app.js');
  assert.deepStrictEqual(spans, [{ kind: 'url', text: 'https://example.com/app.js' }]);
});

// A denied scheme must degrade to inert text. A link that silently does nothing
// when clicked reads as the feature being broken; worse, file:/javascript: in a
// nodeIntegration renderer is a real hole, not a cosmetic one.
test('a denied scheme comes back as text, never as a link', () => {
  for (const s of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<b>x']) {
    const spans = scanLinks(s);
    assert.ok(spans.every((x) => x.kind === 'text'), `linkified: ${s}`);
    assert.strictEqual(spans.map((x) => x.text).join(''), s);
  }
});

// file:// DOES match URL_RE, so scanPaths excludes its interior — the allowed
// extension inside it must not leak out as a local path span.
test('a path inside a denied-scheme URL is not claimed as a local path', () => {
  const spans = scanLinks('file:///etc/app.js');
  assert.deepStrictEqual(spans, [{ kind: 'text', text: 'file:///etc/app.js' }]);
});

test('path spans carry path and line the way scanPaths yields them', () => {
  assert.deepStrictEqual(scanLinks('renderer.js:71'), [
    { kind: 'path', text: 'renderer.js:71', path: 'renderer.js', line: 71 },
  ]);
  assert.deepStrictEqual(scanLinks('~/.clodex/a.json'), [
    { kind: 'path', text: '~/.clodex/a.json', path: '~/.clodex/a.json', line: null },
  ]);
  assert.deepStrictEqual(scanLinks('renderer.js'), [
    { kind: 'path', text: 'renderer.js', path: 'renderer.js', line: null },
  ]);
});

// The body is built from DOM text nodes, so markup an agent wrote must survive
// as inert characters in ONE text span — not be split across spans (which would
// let a later change reassemble it) and not be absorbed into a link's href.
test('html markup adjacent to a URL stays intact in a text span', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const s = `${evil} https://example.com/ done`;
  const spans = scanLinks(s);
  assert.ok(
    spans.some((x) => x.kind === 'text' && x.text.includes(evil)),
    'markup was split or absorbed into a link',
  );
  const url = spans.find((x) => x.kind === 'url');
  // ENTER: no url span would make the containment check below vacuous.
  assert.ok(url, 'expected a url span');
  assert.ok(!url.text.includes('<'), 'markup leaked into the link text');
  assert.strictEqual(spans.map((x) => x.text).join(''), s);
});

test('spans are gapless, ordered and cover the whole string', () => {
  const s = 'a.js:1 then https://x.dev/b and c/d.md tail';
  const spans = scanLinks(s);
  let at = 0;
  for (const sp of spans) {
    assert.strictEqual(s.slice(at, at + sp.text.length), sp.text);
    at += sp.text.length;
  }
  assert.strictEqual(at, s.length);
});

test('scanLinks on empty and non-string input returns no spans rather than throwing', () => {
  for (const v of ['', null, undefined, 42, {}]) assert.deepStrictEqual(scanLinks(v), []);
});
