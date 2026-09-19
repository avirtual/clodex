'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { scanPaths, scanSpillPointers } = require('../renderer/lib/path-scan');
const { matchGutterRow, findGutterFile } = require('../renderer/lib/gutter-scan');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');

const ID = '0123456789abcdef';

const FREE = [
  'terminal', 'scanPaths', 'scanSpillPointers', 'matchGutterRow', 'findGutterFile',
  'GUTTER_HEADER_SCAN', 'isWrapped', 'rowText', 'window', 'showToast', 'openFilePeek', 'name',
];

function mkProvider(rowStr, resolve) {
  const m = rendererSrc.match(/terminal\.registerLinkProvider\(\{[\s\S]*?\n {2}\}\);/);
  assert.ok(m, 'ENTER: the link provider was found in renderer.js');

  const line = { translateToString: () => rowStr, isWrapped: false };
  const terminal = { buffer: { active: { getLine: (row) => (row === 0 ? line : null) } } };
  const calls = { resolve: [], peek: [], toast: [] };
  const env = {
    terminal,
    scanPaths,
    scanSpillPointers,
    matchGutterRow,
    findGutterFile,
    GUTTER_HEADER_SCAN: 400,
    isWrapped: () => false,
    rowText: () => null,
    window: {
      api: {
        fileResolve: async (n, p, b) => { calls.resolve.push([n, p, b]); return resolve; },
      },
    },
    showToast: (msg) => calls.toast.push(msg),
    openFilePeek: (...a) => calls.peek.push(a),
    name: 'hand-one',
  };
  const provider = new Function(...FREE, m[0].replace('terminal.registerLinkProvider(', 'return ('))(
    ...FREE.map((k) => env[k]),
  );
  return { provider, calls };
}

function linksOf(provider) {
  let out;
  provider.provideLinks(1, (links) => { out = links; });
  return out;
}

test('a spill pointer in the row becomes a link over exactly its own cells', () => {
  const row = `body: @spill:${ID}`;
  const { provider } = mkProvider(row, { ok: true, path: '/tmp/x.md' });
  const links = linksOf(provider);
  assert.ok(links && links.length === 1, 'expected exactly one link');
  assert.strictEqual(links[0].text, `@spill:${ID}`);
  assert.deepStrictEqual(links[0].range, {
    start: { x: row.indexOf('@spill:') + 1, y: 1 },
    end: { x: row.length, y: 1 },
  });
});

test('clicking a pointer resolves the POINTER and peeks the path that came back', async () => {
  const { provider, calls } = mkProvider(`@spill:${ID}`, { ok: true, path: '/reg/spill/hand-one/x.md' });
  await linksOf(provider)[0].activate();

  assert.deepStrictEqual(calls.resolve, [['hand-one', `@spill:${ID}`, null]],
    'the pane\'s own session name is what confines the lookup main-side');
  assert.deepStrictEqual(calls.peek, [['hand-one', '/reg/spill/hand-one/x.md', 'file', null]],
    'the peek must open the resolved path, never a path spelled in the pointer');
  assert.deepStrictEqual(calls.toast, []);
});

test('a pointer with no file behind it toasts the error instead of opening a peek', async () => {
  const { provider, calls } = mkProvider(`@spill:${ID}`, { ok: false, error: 'spill file not found' });
  await linksOf(provider)[0].activate();
  assert.deepStrictEqual(calls.peek, [], 'nothing to peek');
  assert.deepStrictEqual(calls.toast, ['spill file not found']);
});

test('paths and pointers on one row both link, so adding the scan drops neither', () => {
  const { provider } = mkProvider(`see renderer.js:71 and @spill:${ID}`, { ok: true, path: '/x' });
  assert.deepStrictEqual(linksOf(provider).map((l) => l.text),
    ['renderer.js:71', `@spill:${ID}`]);
});

test('a pointer at the end of a TITLED head line links over the pointer alone', async () => {
  const row = `[agent:task add t42] S-E intent-spill: notify-user joins @spill:${ID}`;
  const { provider, calls } = mkProvider(row, { ok: true, path: '/reg/spill/hand-one/x.md' });
  const links = linksOf(provider);
  assert.strictEqual(links.length, 1, 'the title itself is not a link');
  assert.deepStrictEqual(links[0].range, {
    start: { x: row.indexOf('@spill:') + 1, y: 1 },
    end: { x: row.length, y: 1 },
  });

  await links[0].activate();
  assert.deepStrictEqual(calls.resolve, [['hand-one', `@spill:${ID}`, null]],
    'the title rides in the transcript only — main is asked about the pointer, as before the title existed');
  assert.deepStrictEqual(calls.peek, [['hand-one', '/reg/spill/hand-one/x.md', 'file', null]]);
});

test('a row with neither a path nor a pointer still offers no links', () => {
  const { provider } = mkProvider('just ordinary output', { ok: true, path: '/x' });
  assert.strictEqual(linksOf(provider), undefined);
});

test('a row whose ONLY hit is a pointer offers a link — the early bail must count it', () => {
  const { provider } = mkProvider(`@spill:${ID}`, { ok: true, path: '/x' });
  const links = linksOf(provider);
  assert.ok(links && links.length === 1);
});
