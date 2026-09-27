'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const NOTE = path.join(REPO, 'docs', 'notes', 'web-host-parity.md');

const SITES = [
  { file: 'renderer/renderer.js', marker: /__CLODEX_WEB__/ },
  { file: 'renderer/side-pane.js', marker: /\bisWeb\b/ },
  { file: 'renderer/dock.js', marker: /\bisWeb\b/ },
];

function noteRows() {
  return fs.readFileSync(NOTE, 'utf8').split('\n')
    .map((l) => /^\|\s*(renderer\/[\w./-]+)\s*\|\s*`([\w$]+)`\s*\|/.exec(l))
    .filter(Boolean)
    .map((m) => ({ file: m[1], symbol: m[2] }));
}

function siteLines(src, marker) {
  const lines = src.split('\n');
  const out = [];
  lines.forEach((l, i) => { if (marker.test(l)) out.push(i); });
  return { lines, out };
}

test('ENTER: the parity note states the ruling', () => {
  const text = fs.readFileSync(NOTE, 'utf8');
  assert.match(text, /may differ only where the browser genuinely cannot do something/);
  assert.match(text, /A gate without such a reason is a defect/);
});

test('every web gate site in renderer.js, side-pane.js and dock.js has its row in the parity note, in order', () => {
  const rows = noteRows();
  for (const { file, marker } of SITES) {
    const src = fs.readFileSync(path.join(REPO, file), 'utf8');
    const { lines, out } = siteLines(src, marker);
    const mine = rows.filter((r) => r.file === file);
    assert.ok(out.length > 0, `ENTER: ${file} has gate sites to audit`);
    assert.strictEqual(mine.length, out.length,
      `${file} has ${out.length} web gate sites and the note has ${mine.length} rows for it`);
    out.forEach((at, i) => {
      const window = lines.slice(Math.max(0, at - 30), at + 4).join('\n');
      assert.match(window, new RegExp(`\\b${mine[i].symbol.replace(/\$/g, '\\$')}\\b`),
        `${file} site #${i + 1} (${lines[at].trim()}) is not near the note row's symbol ${mine[i].symbol}`);
    });
  }
});
