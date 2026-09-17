'use strict';
// Run: node --test test/landing-page.test.js
//
// t928 — docs/ is what GitHub Pages serves at https://clodex.sh (docs/CNAME).
// The page is deliberately STATIC: no JavaScript, and every byte it loads comes
// from a file under docs/. Those two properties are invisible to every other
// test in this repo and are exactly what a well-meaning later edit breaks — a
// hosted font, an analytics snippet, a relative link to a .md file Pages will
// not render. This file is the only thing standing between that edit and a
// broken front door.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const INDEX = path.join(DOCS, 'index.html');
const SHEET = path.join(DOCS, 'site.css');

const STATIC_RULE =
  'docs/index.html is deliberately static and no-JS: it must work with scripts '
  + 'disabled and make zero external requests. Do not add a CDN font, an '
  + 'analytics snippet, or any hosted asset — everything the page loads must '
  + 'resolve to a file under docs/.';

const readIndex = () => fs.readFileSync(INDEX, 'utf8');

function collectRefs() {
  const refs = [];
  const files = [['docs/index.html', readIndex()]];
  if (fs.existsSync(SHEET)) files.push(['docs/site.css', fs.readFileSync(SHEET, 'utf8')]);
  for (const [where, text] of files) {
    for (const m of text.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
      refs.push({ where, value: m[1].trim() });
    }
    for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      refs.push({ where, value: m[1].trim() });
    }
  }
  return refs;
}

const isAnchored = (v) => v.startsWith('https://github.com/') || v.startsWith('https://clodex.sh/');

test('docs/index.html exists and the reference scan is not vacuous', () => {
  assert.ok(fs.existsSync(INDEX), 'docs/index.html is missing — Pages serves docs/ at clodex.sh');
  const refs = collectRefs();
  assert.ok(
    refs.length >= 15,
    `found only ${refs.length} src=/href=/url() references in docs/ — the scan below `
    + 'asserts nothing unless it actually sees the page\'s links, so a low count means '
    + 'the regex stopped matching, not that the page got simpler',
  );
});

test('every reference is a github.com/clodex.sh anchor or a real file under docs/', () => {
  const bad = [];
  for (const { where, value } of collectRefs()) {
    if (isAnchored(value)) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
      bad.push(`${where}: ${value} — off-site reference`);
      continue;
    }
    const local = value.split('#')[0].split('?')[0];
    if (!local) continue;
    if (/\.md$/i.test(local)) {
      bad.push(`${where}: ${value} — Pages does not render .md; link https://github.com/avirtual/clodex/blob/master/docs/<file>.md instead`);
      continue;
    }
    const resolved = path.join(DOCS, local);
    if (!fs.existsSync(resolved)) bad.push(`${where}: ${value} — no such file under docs/`);
  }
  assert.deepStrictEqual(bad, [], `${STATIC_RULE}\n${bad.join('\n')}`);
});

test('no script tag, and no external stylesheet, font or image', () => {
  const html = readIndex();
  assert.ok(!/<script\b/i.test(html), `docs/index.html contains a <script> tag. ${STATIC_RULE}`);
  assert.ok(!/@import\b/i.test(html), `docs/index.html contains an @import. ${STATIC_RULE}`);
  if (fs.existsSync(SHEET)) {
    const css = fs.readFileSync(SHEET, 'utf8');
    assert.ok(!/@import\b/i.test(css), `docs/site.css contains an @import. ${STATIC_RULE}`);
  }
  const hosted = [...html.matchAll(/<(?:link|img|script|iframe)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1].trim())
    .filter((v) => /^(?:https?:)?\/\//i.test(v));
  assert.deepStrictEqual(hosted, [], `${STATIC_RULE}\nhosted subresources: ${hosted.join(', ')}`);
});

test('every <video> is preload="none" with a poster under docs/, so the page makes no request until play is clicked', () => {
  const html = readIndex();
  const videos = [...html.matchAll(/<video\b[^>]*>/gi)].map((m) => m[0]);
  assert.ok(videos.length >= 1, 'ENTER: the page carries at least one <video> — the checks below are vacuous without it');
  for (const tag of videos) {
    assert.ok(/\bpreload\s*=\s*["']none["']/i.test(tag), `${STATIC_RULE}\n<video> without preload="none" fetches its source on page load: ${tag}`);
    const poster = /\bposter\s*=\s*["']([^"']+)["']/i.exec(tag);
    assert.ok(poster, `<video> without a poster shows a black box until play: ${tag}`);
    assert.ok(fs.existsSync(path.join(DOCS, poster[1])), `poster ${poster[1]} is not a file under docs/`);
  }
});

test('docs/CNAME is exactly clodex.sh', () => {
  assert.strictEqual(fs.readFileSync(path.join(DOCS, 'CNAME'), 'utf8').trim(), 'clodex.sh');
});

test('the download link and the how-it-works walkthrough are both present', () => {
  const html = readIndex();
  assert.ok(
    html.includes('href="https://github.com/avirtual/clodex/releases/latest"'),
    'the Download for Mac button must point at releases/latest',
  );
  assert.ok(fs.existsSync(path.join(DOCS, 'how-it-works.html')), 'docs/how-it-works.html is missing');
  assert.ok(
    html.includes('href="how-it-works.html"'),
    'docs/index.html must link the how-it-works walkthrough',
  );
});
