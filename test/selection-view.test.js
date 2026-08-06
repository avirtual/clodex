// selection-view.js — what the drawer's selection inspector says.
//
// The property worth pinning is the DISAGREEMENT handling, because that is the
// whole reason the inspector reads the proxy instead of Clodex's own memo: on
// 2026-08-06 three arms logged `timeout`, the local memo rolled back to empty,
// and the peek was registered on the proxy the whole time and rode the next
// request. A view that trusts the memo repeats that lie with more authority.
//
// The two directions of mismatch are NOT symmetric — one is a fault worth
// flagging, the other is the ordinary one-shot pop — so both are pinned
// separately. Collapsing them into "out of sync" is the failure mode.

const test = require('node:test');
const assert = require('node:assert');

const { buildRows, liveCount, remainingS, PEEK_HINT_ID, MEMORY_HINT_ID } = require('../renderer/lib/selection-view');

const hint = (id, over = {}) => ({
  id, text: `body of ${id}`, ttlS: 120, ageS: 10, turnStartOnly: true, ...over,
});
// A full inspect() answer, so every fixture below starts from a shape the main
// process actually returns rather than a partial the view reads around.
const data = (over = {}) => ({
  enabled: true,
  local: { peek: null, pending: [] },
  proxy: { routed: true, hints: [], error: null },
  queued: [],
  ...over,
});

test('a peek the proxy holds is reported from the PROXY text, not the memo', () => {
  const d = data({
    local: { peek: { text: 'STALE LOCAL COPY', bytes: 16, truncated: false, expiresInMs: 9000 }, pending: [] },
    proxy: { routed: true, hints: [hint(PEEK_HINT_ID, { text: 'WHAT WILL ACTUALLY RIDE' })], error: null },
  });
  const { rows } = buildRows(d);
  const peek = rows.find((r) => r.kind === 'peek');
  // ENTER: the peek row exists at all, or every assertion below is about undefined.
  assert.ok(peek, 'ENTER: a peek row was built');
  assert.strictEqual(peek.text, 'WHAT WILL ACTUALLY RIDE');
  assert.ok(!peek.warn, 'both agree, so nothing is flagged');
});

test('proxy holds it and Clodex does not — the measured failure — is FLAGGED', () => {
  const d = data({
    local: { peek: null, pending: [] },     // rolled back by the timeout
    proxy: { routed: true, hints: [hint(PEEK_HINT_ID)], error: null },
  });
  const { rows } = buildRows(d);
  const peek = rows.find((r) => r.kind === 'peek');
  assert.ok(peek, 'ENTER: a peek row was built from the proxy alone');
  assert.strictEqual(peek.warn, true, 'the operator is told Clodex did not know');
  assert.match(peek.note, /timed out but landed/);
});

test('Clodex holds it and the proxy does not is NOT flagged — that is a pop', () => {
  const d = data({
    local: { peek: { text: 'popped', bytes: 6, truncated: false, expiresInMs: 60000 }, pending: [] },
    proxy: { routed: true, hints: [], error: null },
  });
  const { rows } = buildRows(d);
  const row = rows.find((r) => r.kind === 'peek-gone');
  assert.ok(row, 'ENTER: the memo-only row was built');
  assert.strictEqual(row.warn, false, 'the ordinary case must not cry wolf');
  // If this read as a fault the operator would learn to ignore the row above,
  // which is the only one that matters.
  assert.match(row.note, /rode a request|ran out/);
});

test('queued attachments come from the FILE, which the hook drains', () => {
  const d = data({ local: { peek: null, pending: ['a', 'b'] }, queued: ['a', 'b'] });
  const { rows } = buildRows(d);
  const attach = rows.filter((r) => r.kind === 'attach');
  assert.strictEqual(attach.length, 2);
  assert.deepStrictEqual(attach.map((r) => r.text), ['a', 'b']);
  assert.ok(!rows.some((r) => r.kind === 'note'), 'agreeing counts need no note');
});

test('a drained file with a stale pending list states both counts', () => {
  // The hook drained between the append and the read — ordinary, but it is also
  // exactly how a LOST attachment would look, so the numbers are shown.
  const d = data({ local: { peek: null, pending: ['a'] }, queued: [] });
  const { rows } = buildRows(d);
  const note = rows.find((r) => r.kind === 'note');
  assert.ok(note, 'ENTER: the mismatch note was built');
  assert.match(note.note, /queued 1.*holds 0/);
});

test('the memory hint is shown too — it shares the same tail block', () => {
  const d = data({ proxy: { routed: true, hints: [hint(MEMORY_HINT_ID)], error: null } });
  const { rows } = buildRows(d);
  const mem = rows.find((r) => r.kind === 'memory');
  assert.ok(mem, 'ENTER: the memory row was built');
  assert.strictEqual(mem.title, 'Memory hint', 'labelled, not shown as a raw id');
});

test('an unrecognised hint on the route is surfaced, not hidden', () => {
  // A probe or another tool riding the operator's requests is precisely what
  // someone opens this panel to discover.
  const d = data({ proxy: { routed: true, hints: [hint('probe-visibility')], error: null } });
  const { rows } = buildRows(d);
  const other = rows.find((r) => r.kind === 'other');
  assert.ok(other, 'ENTER: the unknown hint produced a row');
  assert.strictEqual(other.title, 'probe-visibility');
});

test('with the pref off, nothing is listed and the reason names the control', () => {
  const { rows, note } = buildRows(data({ enabled: false }));
  assert.deepStrictEqual(rows, []);
  assert.match(note, /Preferences/);
});

test('an unrouted session says Copy still works', () => {
  // Half the feature is proxy-independent, so "no wirescope" must not read as
  // "the feature is dead" — that is why the pref left the proxy-dependent gate.
  const { rows, note } = buildRows(data({ proxy: { routed: false, hints: null, error: null } }));
  assert.deepStrictEqual(rows, []);
  assert.match(note, /Copy still will/);
});

test('a proxy that cannot be reached says so rather than claiming nothing rides', () => {
  const { rows, note } = buildRows(data({ proxy: { routed: true, hints: null, error: 'timeout' } }));
  assert.deepStrictEqual(rows, []);
  assert.match(note, /Could not reach the proxy: timeout/);
});

test('remaining time comes from the proxy age, never a local clock', () => {
  assert.strictEqual(remainingS({ ttlS: 120, ageS: 30 }), 90);
  // A hint older than its TTL must floor at 0 — a negative reads as a bug.
  assert.strictEqual(remainingS({ ttlS: 120, ageS: 500 }), 0);
  assert.strictEqual(remainingS({ ttlS: null, ageS: 5 }), null);
});

test('the badge counts what would arrive now — proxy plus file, not the memo', () => {
  const d = data({
    local: { peek: { text: 'memo only', bytes: 9, truncated: false, expiresInMs: 1 }, pending: ['x', 'y'] },
    proxy: { routed: true, hints: [hint(PEEK_HINT_ID), hint(MEMORY_HINT_ID)], error: null },
    queued: ['x'],
  });
  // 2 registered + 1 queued. The memo's extra pending entry is excluded on
  // purpose: it was already drained, so counting it would overstate.
  assert.strictEqual(liveCount(d), 3);
  assert.strictEqual(liveCount(data({ enabled: false, queued: ['x'] })), 0);
  assert.strictEqual(liveCount(null), 0);
});
