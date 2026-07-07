const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMemoryStore, composeDigest, parseMemoryUnit } = require('../memory-store');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-mem-'));
  return { store: createMemoryStore(dir), dir };
}

test('memoryStore: remember/list/recall roundtrip with pinned default false', () => {
  const { store } = tmpStore();
  const u = store.remember('alpha', { scope: 'proj', text: 'The build needs electron-rebuild.' });
  assert.match(u.id, /^mem-\d+-[a-z0-9]+$/);
  const units = store.list('alpha');
  assert.strictEqual(units.length, 1);
  assert.strictEqual(units[0].pinned, false);
  assert.strictEqual(units[0].scope, 'proj');
  assert.strictEqual(store.recall('alpha', 'electron-rebuild').id, u.id);
});

test('memoryStore: remember with pinned=true saves pinned in one write', () => {
  const { store, dir } = tmpStore();
  const u = store.remember('alpha', { scope: 'ops', text: 'Boot rules ride pinned.', pinned: true });
  assert.strictEqual(u.pinned, true);
  const [unit] = store.list('alpha');
  assert.strictEqual(unit.pinned, true);
  const raw = fs.readFileSync(path.join(dir, 'alpha', `${u.id}.md`), 'utf-8');
  assert.strictEqual(parseMemoryUnit(raw).meta.pinned, 'true');
});

test('memoryStore: pin survives the file roundtrip and preserves meta', () => {
  const { store, dir } = tmpStore();
  const u = store.remember('alpha', { scope: 'ops', text: 'Never flap wire-strip on a warm cache.' });
  store.setPinned('alpha', u.id, true);
  const [unit] = store.list('alpha');
  assert.strictEqual(unit.pinned, true);
  assert.strictEqual(unit.scope, 'ops');
  assert.strictEqual(unit.learned_at, u.learned_at);
  // unpin removes the key from the file entirely (pre-pin byte shape)
  store.setPinned('alpha', u.id, false);
  const raw = fs.readFileSync(path.join(dir, 'alpha', `${u.id}.md`), 'utf-8');
  assert.strictEqual(parseMemoryUnit(raw).meta.pinned, undefined);
});

test('memoryStore: forget deletes, and pin/forget reject non-id shapes (traversal guard)', () => {
  const { store } = tmpStore();
  const u = store.remember('alpha', { text: 'ephemeral' });
  store.forget('alpha', u.id);
  assert.strictEqual(store.list('alpha').length, 0);
  assert.throws(() => store.forget('alpha', '../alpha/x'), /invalid unit id/);
  assert.throws(() => store.setPinned('alpha', 'mem-1-UPPER', true), /invalid unit id/);
  assert.throws(() => store.forget('alpha', u.id), /no unit/); // already gone
});

// --- digest ---------------------------------------------------------------

const NOW = Date.parse('2026-07-08T12:00:00Z');
function unit(id, { pinned = false, scope = '', body = 'body of ' + id, daysAgo = 1 } = {}) {
  return {
    id, scope, pinned, body,
    learned_at: new Date(NOW - daysAgo * 86_400_000).toISOString(),
    source: 'test',
  };
}

test('composeDigest: empty store is null (no digest, conversation stays unmarked)', () => {
  assert.strictEqual(composeDigest([]), null);
  assert.strictEqual(composeDigest(null), null);
});

test('composeDigest: pinned in full, rest as index lines newest-first', () => {
  const d = composeDigest([
    unit('mem-1-aaaaaa', { pinned: true, body: 'Settled: no auto-sweep.\nSecond line rides too.' }),
    unit('mem-2-bbbbbb', { daysAgo: 3, scope: 'proj', body: 'Older index item' }),
    unit('mem-3-cccccc', { daysAgo: 1, body: 'Newer index item' }),
  ], { now: NOW });
  assert.match(d, /## mem-1-aaaaaa\nSettled: no auto-sweep\.\nSecond line rides too\./);
  // index shows first line + age, newer before older
  const newer = d.indexOf('mem-3-cccccc');
  const older = d.indexOf('mem-2-bbbbbb');
  assert.ok(newer !== -1 && older !== -1 && newer < older);
  assert.match(d, /mem-2-bbbbbb \[proj\] Older index item \(3d\)/);
  // index bodies are NOT included
  assert.doesNotMatch(d, /## mem-3-cccccc/);
});

test('composeDigest: budget drops whole units and counts the overflow', () => {
  const units = [];
  for (let i = 0; i < 30; i++) {
    units.push(unit(`mem-${100 + i}-aaaaaa`, { pinned: true, body: 'x'.repeat(400) }));
  }
  const d = composeDigest(units, { budget: 2000, now: NOW });
  assert.ok(d.length < 2200); // header may nudge past, never a whole extra unit
  assert.match(d, /\(\+\d+ more — \[agent:memory list\]\)/);
  // no unit is truncated mid-body: every included block ends with its full body
  const blocks = d.match(/## mem-\d+-aaaaaa\nx+/g) || [];
  for (const b of blocks) assert.strictEqual(b.split('\n')[1].length, 400);
});
