'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { scanPaths } = require('../renderer/lib/path-scan');

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
