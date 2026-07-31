const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMemoryStore, composeDigest, parseMemoryUnit, DIGEST_BUDGET } = require('../memory-store');

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
  // Sized so bodies are still served: at 30 pins the fallback lines alone
  // exceed the budget, no body fits, and the no-truncation check below would
  // pass over an empty block list.
  const units = [];
  for (let i = 0; i < 6; i++) {
    units.push(unit(`mem-${100 + i}-aaaaaa`, { pinned: true, body: 'x'.repeat(400) }));
  }
  const d = composeDigest(units, { budget: 2000, now: NOW });
  assert.ok(d.length < 2200); // header may nudge past, never a whole extra unit
  assert.match(d, /\(\d+ of 6 pinned shown in full;[^)]*— \[agent:memory list\]\)/);
  // no unit is truncated mid-body: every included block ends with its full body
  const blocks = d.match(/## mem-\d+-aaaaaa\nx+/g) || [];
  assert.ok(blocks.length > 0);
  for (const b of blocks) assert.strictEqual(b.split('\n')[1].length, 400);
});

test('composeDigest: pinned units are served newest-first', () => {
  const d = composeDigest([
    unit('mem-1-oldest', { pinned: true, daysAgo: 9, body: 'x'.repeat(300) }),
    unit('mem-2-middle', { pinned: true, daysAgo: 5, body: 'y'.repeat(300) }),
    unit('mem-3-newest', { pinned: true, daysAgo: 1, body: 'z'.repeat(300) }),
  // Two bodies must fit and the third must not, or "newest-first" has nothing
  // to order. Bodies get HALF the budget, so this is 1600 where it was 1000.
  ], { budget: 1600, now: NOW });
  assert.match(d, /## mem-3-newest\nz{300}/);
  assert.match(d, /## mem-2-middle\ny{300}/);
  assert.doesNotMatch(d, /## mem-1-oldest/); // oldest loses its body, not the newest
  // and the newest body precedes the older one
  assert.ok(d.indexOf('## mem-3-newest') < d.indexOf('## mem-2-middle'));
});

test('composeDigest: a pinned unit that does not fit is listed, never dropped', () => {
  const d = composeDigest([
    unit('mem-1-oldest', { pinned: true, daysAgo: 9, body: 'x'.repeat(300) }),
    unit('mem-2-middle', { pinned: true, daysAgo: 5, body: 'y'.repeat(300) }),
    unit('mem-3-newest', { pinned: true, daysAgo: 1, body: 'z'.repeat(300) }),
  ], { budget: 1000, now: NOW });
  assert.doesNotMatch(d, /## mem-1-oldest/);
  assert.ok(d.includes('mem-1-oldest')); // the id is still reachable
});

test('composeDigest: a demoted pin is marked, an ordinary index entry is not', () => {
  const d = composeDigest([
    unit('mem-1-oldest', { pinned: true, daysAgo: 9, body: 'x'.repeat(300) }),
    unit('mem-2-middle', { pinned: true, daysAgo: 5, body: 'y'.repeat(300) }),
    unit('mem-3-newest', { pinned: true, daysAgo: 1, body: 'z'.repeat(300) }),
    unit('mem-4-plainer', { daysAgo: 2, body: 'plain index item' }),
  ], { budget: 1100, now: NOW });
  assert.match(d, /\n- \[pinned\] mem-1-oldest /);
  assert.match(d, /\n- mem-4-plainer /);
});

test('composeDigest: demoted pins sort before unpinned index entries', () => {
  const d = composeDigest([
    unit('mem-1-oldest', { pinned: true, daysAgo: 9, body: 'x'.repeat(300) }),
    unit('mem-2-middle', { pinned: true, daysAgo: 5, body: 'y'.repeat(300) }),
    unit('mem-3-newest', { pinned: true, daysAgo: 1, body: 'z'.repeat(300) }),
    unit('mem-4-plainer', { daysAgo: 2, body: 'plain index item' }),
  ], { budget: 1100, now: NOW });
  assert.ok(d.indexOf('mem-1-oldest [') !== -1 || d.indexOf('[pinned] mem-1-oldest') !== -1);
  assert.ok(d.indexOf('[pinned] mem-1-oldest') < d.indexOf('- mem-4-plainer'));
});

test('composeDigest: the tail counts the three cases separately, omitting empty clauses', () => {
  // everything fits: no tail at all
  const small = composeDigest([
    unit('mem-1-aaaaaa', { pinned: true, body: 'short pin' }),
    unit('mem-2-bbbbbb', { body: 'short index' }),
  ], { now: NOW });
  assert.doesNotMatch(small, /\[agent:memory list\]/);

  // pins demoted, but every demoted line fits and nothing else overflows
  const demotedOnly = [];
  for (let i = 0; i < 6; i++) {
    demotedOnly.push(unit(`mem-${100 + i}-aaaaaa`, { pinned: true, body: 'x'.repeat(400) }));
  }
  const dd = composeDigest(demotedOnly, { budget: 2100, now: NOW });
  assert.match(dd, /\d+ of 6 pinned shown in full/);
  assert.match(dd, /\d+ pinned listed by title only/);
  assert.doesNotMatch(dd, /pinned omitted/);
  assert.doesNotMatch(dd, /\+\d+ more/);

  // unpinned overflow only: no pinned clause at all
  const indexOnly = [unit('mem-1-aaaaaa', { pinned: true, body: 'tiny pin' })];
  for (let i = 0; i < 40; i++) {
    indexOnly.push(unit(`mem-${200 + i}-bbbbbb`, { body: `index item ${i}` }));
  }
  const di = composeDigest(indexOnly, { budget: 700, now: NOW });
  assert.match(di, /\(\+\d+ more — \[agent:memory list\]\)/);
  assert.doesNotMatch(di, /pinned shown in full/);
  assert.doesNotMatch(di, /pinned listed by title/);
  assert.doesNotMatch(di, /pinned omitted/);
});

// The store this function actually runs against, not a toy one. Sized from the
// lead's live store (191 units, 108 pinned, ~1175-byte mean body).
function pinnedStore(n, { bytes = 1200 } = {}) {
  const units = [];
  for (let i = 0; i < n; i++) {
    units.push(unit(`mem-${100 + i}-aaaaaa`, {
      pinned: true,
      daysAgo: n - i,
      body: `settled position ${i}\n${'x'.repeat(bytes)}`,
    }));
  }
  return units;
}

test('composeDigest: 110 pins against the real budget still serve bodies', () => {
  // THE regression case. A 108-pin store served ZERO bodies for months because
  // the per-pin reserve exceeded the budget by itself, and no test noticed: an
  // empty digest satisfies every size bound, so the size half of this test is
  // the half that cannot fail. The body count is the assertion that bites.
  const d = composeDigest(pinnedStore(110), { budget: DIGEST_BUDGET, now: NOW });
  const bodies = (d.match(/\n## mem-\d+-aaaaaa\n/g) || []).length;
  assert.ok(bodies >= 3, `expected at least 3 bodies at scale, got ${bodies}`);
  assert.ok(d.length <= DIGEST_BUDGET, `digest is ${d.length} bytes, over the ${DIGEST_BUDGET} budget`);
  // The other half of the policy, and the only thing separating this fix from
  // simply deleting the reserve. A greedy body loop passes both assertions
  // above (measured: 6 bodies, 8 index lines) while starving the index — which
  // is the ORIGINAL bug, pins reachable from nowhere, arrived at from the other
  // side. Bodies are capped at half the budget so the rest can be listed: 3
  // bodies and 80 lines account for 83 of the 110 pins, against greedy's 14.
  const bodyBytes = (d.match(/\n## mem-\d+-aaaaaa\n[^\n]*\nx+/g) || [])
    .reduce((n, b) => n + b.length, 0);
  assert.ok(bodyBytes <= DIGEST_BUDGET / 2, `bodies took ${bodyBytes} of ${DIGEST_BUDGET}, starving the index`);
});

test('composeDigest: 97 pins against the real budget leaves every withheld pin counted', () => {
  // Was: every pinned id appears in full or as a line, guaranteed by reserving
  // a line per pin. That reserve is what starved the bodies. The property it
  // bought survives on the tail instead — nothing withheld goes unaccounted —
  // so the arithmetic below must close over all 97 with none unexplained.
  const d = composeDigest(pinnedStore(97, { bytes: 880 }), { budget: DIGEST_BUDGET, now: NOW });
  const shown = (d.match(/\n## mem-\d+-aaaaaa\n/g) || []).length;
  const listed = (d.match(/\n- \[pinned\] mem-\d+-aaaaaa /g) || []).length;
  const tail = d.match(/\((.+) — \[agent:memory list\]\)$/);
  assert.ok(tail, 'pins were withheld, so the tail must be there to account for them');

  // Read back from the tail's own words, not recomputed: the tail is the only
  // thing a reader of the digest has, so it is the tail that must be true.
  const say = re => { const m = tail[1].match(re); return m ? Number(m[1]) : 0; };
  assert.strictEqual(say(/(\d+) of 97 pinned shown in full/), shown);
  assert.strictEqual(say(/(\d+) pinned listed by title only/), listed);
  assert.strictEqual(shown + listed + say(/(\d+) pinned omitted/), 97, 'every pin is served, listed or counted');
  assert.ok(shown > 0, 'reachability must not cost every body — that was the bug');
});
