'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { scanPaths } = require('../renderer/lib/path-scan');
const { matchGutterRow, findGutterFile } = require('../renderer/lib/gutter-scan');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');

const ID = '0123456789abcdef';
const SPILL = `/reg/spill/hand-one/${ID}.md`;

const FREE = [
  'terminal', 'scanPaths', 'matchGutterRow', 'findGutterFile',
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

test('the spill stub\'s path becomes a link over exactly its own cells, and nothing else on the row links', () => {
  const row = `[agent:task add t42] S-E intent-spill: shout joins — 5.2 KB filed at ${SPILL}`;
  const { provider } = mkProvider(row, { ok: true, path: SPILL });
  const links = linksOf(provider);
  assert.ok(links && links.length === 1, 'expected exactly one link');
  assert.strictEqual(links[0].text, SPILL);
  assert.deepStrictEqual(links[0].range, {
    start: { x: row.indexOf(SPILL) + 1, y: 1 },
    end: { x: row.length, y: 1 },
  });
});

test('clicking the path resolves it as a displayed path and peeks what came back', async () => {
  const { provider, calls } = mkProvider(`[agent:dm wirescope] 858 B filed at ${SPILL}`, { ok: true, path: SPILL });
  await linksOf(provider)[0].activate();
  assert.deepStrictEqual(calls.resolve, [['hand-one', SPILL, null]],
    'the absolute path is what main is asked about — there is no pointer grammar left to resolve');
  assert.deepStrictEqual(calls.peek, [['hand-one', SPILL, 'file', null]]);
  assert.deepStrictEqual(calls.toast, []);
});

test('a path with no file behind it toasts the error instead of opening a peek', async () => {
  const { provider, calls } = mkProvider(`858 B of prose filed at ${SPILL}`, { ok: false, error: 'File not found' });
  await linksOf(provider)[0].activate();
  assert.deepStrictEqual(calls.peek, [], 'nothing to peek');
  assert.deepStrictEqual(calls.toast, ['File not found']);
});

test('a source path and the stub path on one row both link', () => {
  const { provider } = mkProvider(`see renderer.js:71 and 858 B filed at ${SPILL}`, { ok: true, path: '/x' });
  assert.deepStrictEqual(linksOf(provider).map((l) => l.text), ['renderer.js:71', SPILL]);
});

test('the old @spill: token no longer links: the dedicated provider is gone with the shape', () => {
  const { provider } = mkProvider(`[agent:dm bob] @spill:${ID}`, { ok: true, path: '/x' });
  assert.strictEqual(linksOf(provider), undefined);
  assert.ok(!rendererSrc.includes('scanSpillPointers'), 'and the renderer does not name the removed scan');
});

test('a row with no path still offers no links', () => {
  const { provider } = mkProvider('just ordinary output', { ok: true, path: '/x' });
  assert.strictEqual(linksOf(provider), undefined);
});
