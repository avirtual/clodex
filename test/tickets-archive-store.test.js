'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createTicketsStore } = require('../tickets-store');
const { projectDirFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

function mkStore() {
  const home = mkTmpRoot('clodex-arch-');
  const warnings = [];
  const store = createTicketsStore({ clodexHome: home, warn: (m) => warnings.push(m) });
  return { home, store, warnings, root: '/proj/archive' };
}

test('tickets-archive: paths sit beside tickets.json in the project dir', () => {
  const { home, store, root } = mkStore();
  const dir = projectDirFor(home, root);
  assert.strictEqual(store.archivePath(root), path.join(dir, 'tickets-archive.jsonl'));
  assert.strictEqual(store.metaPath(root), path.join(dir, 'tickets-archive.meta.json'));
});

test('tickets-archive: a missing archive is an empty Map', () => {
  const { store, root, warnings } = mkStore();
  const rows = store.readArchive(root);
  assert.ok(rows instanceof Map);
  assert.strictEqual(rows.size, 0);
  assert.deepStrictEqual(warnings, []);
});

test('tickets-archive: archive, restore, archive of one id — the last op wins', () => {
  const { store, root } = mkStore();
  store.appendArchive(root, [{ id: 't4', state: 'done', v: 1 }, { id: 't9', state: 'cancelled' }]);
  assert.deepStrictEqual([...store.readArchive(root).keys()], ['t4', 't9']);
  store.appendRestore(root, 't4');
  assert.deepStrictEqual([...store.readArchive(root).keys()], ['t9'], 'a restore un-archives t4');
  store.appendArchive(root, [{ id: 't4', state: 'done', v: 2 }]);
  const rows = store.readArchive(root);
  assert.deepStrictEqual([...rows.keys()].sort(), ['t4', 't9']);
  assert.deepStrictEqual(rows.get('t4'), { id: 't4', state: 'done', v: 2 });

  const lines = fs.readFileSync(store.archivePath(root), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines.map((l) => [l.op, l.row ? l.row.id : l.id]),
    [['archive', 't4'], ['archive', 't9'], ['restore', 't4'], ['archive', 't4']]);
  assert.ok(lines.every((l) => typeof l.at === 'string' && !Number.isNaN(Date.parse(l.at))));
});

test('tickets-archive: a torn LAST line is skipped silently and earlier rows survive', () => {
  const { store, root, warnings } = mkStore();
  store.appendArchive(root, [{ id: 't1' }, { id: 't2' }]);
  fs.appendFileSync(store.archivePath(root), '{"op":"archive","at":"2026-11-10T00:00:00.000Z","row":{"id":"t3"');
  const rows = store.readArchive(root);
  assert.deepStrictEqual([...rows.keys()], ['t1', 't2']);
  assert.deepStrictEqual(warnings, []);
});

test('tickets-archive: a torn MIDDLE line warns once and the rows after it survive', () => {
  const { store, root, warnings } = mkStore();
  store.appendArchive(root, [{ id: 't1' }]);
  fs.appendFileSync(store.archivePath(root), '{"op":"archive","row":{"id":"t2"\nnot json either\n');
  store.appendArchive(root, [{ id: 't5' }]);
  const rows = store.readArchive(root);
  assert.deepStrictEqual([...rows.keys()], ['t1', 't5']);
  assert.strictEqual(warnings.length, 1, 'one warn per read, not per bad line');
  assert.match(warnings[0], /skipped 2 unparseable line/);
});

test('tickets-archive: an append after a torn tail starts on a fresh line', () => {
  const { store, root, warnings } = mkStore();
  store.appendArchive(root, [{ id: 't1' }]);
  fs.appendFileSync(store.archivePath(root), '{"op":"archive","row":{"id":"t2"');
  store.appendArchive(root, [{ id: 't3' }]);
  assert.deepStrictEqual([...store.readArchive(root).keys()], ['t1', 't3']);
  assert.strictEqual(warnings.length, 1, 'the torn line is now a middle line');
});

test('tickets-archive: readArchive is cached on mtime+size and re-read when the file changes', () => {
  const { store, root } = mkStore();
  store.appendArchive(root, [{ id: 't1' }]);
  const first = store.readArchive(root);
  assert.strictEqual(store.readArchive(root).get('t1'), first.get('t1'), 'an unchanged file answers from the cache');
  first.delete('t1');
  assert.deepStrictEqual([...store.readArchive(root).keys()], ['t1'], 'a caller mutating its Map does not change the next read');
  fs.appendFileSync(store.archivePath(root), `${JSON.stringify({ op: 'archive', at: 'x', row: { id: 't2' } })}\n`);
  const second = store.readArchive(root);
  assert.notStrictEqual(second, first);
  assert.deepStrictEqual([...second.keys()], ['t1', 't2']);
});

test('tickets-archive: meta round-trips, and missing or invalid reads as maxId 0', () => {
  const { store, root } = mkStore();
  assert.deepStrictEqual(store.readMeta(root), { maxId: 0 });
  store.writeMeta(root, { maxId: 40 });
  assert.deepStrictEqual(store.readMeta(root), { maxId: 40 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(store.metaPath(root), 'utf-8')), { maxId: 40 });
  for (const bad of ['{nope', '{"maxId":"7"}', '{"maxId":-1}', '{"maxId":1.5}', '[]', 'null']) {
    fs.writeFileSync(store.metaPath(root), bad);
    assert.deepStrictEqual(store.readMeta(root), { maxId: 0 }, `invalid meta ${bad}`);
  }
  assert.throws(() => store.writeMeta(root, { maxId: 'x' }), /invalid maxId/);
});
