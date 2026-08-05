'use strict';
// The wire-fed subagent turn ring (subagent-ring.js). Two things it must get
// right and neither is visible from a call site: the KEY must match wirescope's
// instance key byte for byte (or a live subagent shows an empty feed rather than
// failing), and both bounds must hold by construction, since nothing upstream is
// in a position to remember — a feed lives as long as its session.
const { test } = require('node:test');
const assert = require('node:assert');

const {
  FEED_CAP, SUB_CAP, TEXT_CAP, TOOLS_CAP,
  createSubagentStore, noteSubagentTurn, feedSince, feedKeys,
} = require('../subagent-ring');

const turn = (over = {}) => ({
  key: 'a@s1', role: 'general-purpose', model: 'claude-opus-5',
  text: 'hello', tools: [{ name: 'Read', arg: '/a.js' }], truncated: false, ts: 1000, ...over,
});

test('a turn lands as a fully-shaped entry', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn());
  // Whole-object equality: a field the mapping silently drops arrives as
  // undefined, and a per-field check reads straight past it.
  assert.deepStrictEqual(feedSince(s, 'a@s1', 0), {
    known: true, key: 'a@s1', role: 'general-purpose', model: 'claude-opus-5',
    displayName: null,
    entries: [{
      seq: 1, ts: 1000, text: 'hello', tools: [{ name: 'Read', arg: '/a.js' }],
      toolsOmitted: 0, truncated: false,
    }],
    seq: 1, missed: false,
  });
});

test('seq is monotonic across DIFFERENT subagents, not per feed', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn({ key: 'a' }));
  noteSubagentTurn(s, turn({ key: 'b' }));
  noteSubagentTurn(s, turn({ key: 'a' }));
  assert.deepStrictEqual(feedSince(s, 'a', 0).entries.map((e) => e.seq), [1, 3]);
  assert.deepStrictEqual(feedSince(s, 'b', 0).entries.map((e) => e.seq), [2]);
});

// --- identity ----------------------------------------------------------------

test('the key is the agent-id VERBATIM, @ and all', () => {
  const s = createSubagentStore();
  // Splitting on '@' (which wirescope does for the DISPLAY name only) would
  // collide every anonymous spawn of one session into a single row.
  noteSubagentTurn(s, turn({ key: 'deadbeef@session-1' }));
  noteSubagentTurn(s, turn({ key: 'cafe1234@session-1' }));
  assert.deepStrictEqual(feedKeys(s).sort(), ['cafe1234@session-1', 'deadbeef@session-1']);
});

test('a turn with no key at all is dropped, not filed under undefined', () => {
  const s = createSubagentStore();
  assert.strictEqual(noteSubagentTurn(s, turn({ key: null })), null);
  assert.strictEqual(noteSubagentTurn(s, turn({ key: '' })), null);
  assert.deepStrictEqual(feedKeys(s), []);
  assert.strictEqual(s.seq, 0, 'ENTER: a dropped turn must not burn a seq');
});

test('identity is sticky: a later turn without role/model keeps the known ones', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn());
  noteSubagentTurn(s, turn({ role: null, model: null }));
  const f = feedSince(s, 'a@s1', 0);
  assert.strictEqual(f.role, 'general-purpose');
  assert.strictEqual(f.model, 'claude-opus-5');
});

test('displayName is carried when present', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn({ displayName: 'reviewer' }));
  assert.strictEqual(feedSince(s, 'a@s1', 0).displayName, 'reviewer');
});

// --- what is worth showing ---------------------------------------------------

test('a turn with neither text nor tools is skipped', () => {
  const s = createSubagentStore();
  assert.strictEqual(noteSubagentTurn(s, turn({ text: '', tools: [] })), null);
  assert.deepStrictEqual(feedKeys(s), []);
});

test('a tools-only turn lands (a tool-loop hop has no text)', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn({ text: '' }));
  const e = feedSince(s, 'a@s1', 0).entries;
  assert.strictEqual(e.length, 1);
  assert.strictEqual(e[0].text, null, 'ENTER: empty text normalizes to null, not ""');
});

test('a text-only turn lands', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn({ tools: [] }));
  assert.deepStrictEqual(feedSince(s, 'a@s1', 0).entries[0].tools, []);
});

test('unusable tool entries are filtered out', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn({
    tools: [{ name: 'Read', arg: '/a' }, null, 42, {}, { name: '' }, { name: 'Bash', arg: 'ls' }],
  }));
  assert.deepStrictEqual(feedSince(s, 'a@s1', 0).entries[0].tools,
    [{ name: 'Read', arg: '/a' }, { name: 'Bash', arg: 'ls' }]);
});

// A ring outlives the change that added snippets: entries written by the older
// wire arrive as bare name strings, and dropping them would blank tool rows
// already on screen rather than fail.
test('a bare tool-name string normalizes to a snippet-less record', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn({ tools: ['Read', { name: 'Bash', arg: 'ls' }] }));
  assert.deepStrictEqual(feedSince(s, 'a@s1', 0).entries[0].tools,
    [{ name: 'Read', arg: null }, { name: 'Bash', arg: 'ls' }]);
});

// null and absent are the same claim here (no snippet), and both must be
// DISTINGUISHABLE from a snippet that exists — an `arg: undefined` leaking
// through would render as the string "undefined".
test('a missing, empty or non-string arg normalizes to exactly null', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn({
    tools: [{ name: 'A' }, { name: 'B', arg: '' }, { name: 'C', arg: 42 }, { name: 'D', arg: null }],
  }));
  const got = feedSince(s, 'a@s1', 0).entries[0].tools;
  assert.strictEqual(got.length, 4, 'ENTER: none of the four rows was dropped');
  for (const t of got) {
    assert.ok('arg' in t, `${t.name}: arg present, not absent`);
    assert.notStrictEqual(t.arg, undefined, `${t.name}: arg is not undefined`);
    assert.strictEqual(t.arg, null, `${t.name}: arg is exactly null`);
  }
});

test('a non-array tools field does not throw', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn({ tools: 'Read' }));
  assert.deepStrictEqual(feedSince(s, 'a@s1', 0).entries[0].tools, []);
});

// --- bounds ------------------------------------------------------------------

test('text is clamped at TEXT_CAP and the entry says so', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn({ text: 'x'.repeat(TEXT_CAP + 50) }));
  const e = feedSince(s, 'a@s1', 0).entries[0];
  assert.strictEqual(e.text.length, TEXT_CAP);
  assert.strictEqual(e.truncated, true);
});

test('text exactly at the cap is not marked truncated', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn({ text: 'x'.repeat(TEXT_CAP) }));
  assert.strictEqual(feedSince(s, 'a@s1', 0).entries[0].truncated, false);
});

test('an upstream truncation is preserved even when we clamp nothing', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn({ text: 'short', truncated: true }));
  assert.strictEqual(feedSince(s, 'a@s1', 0).entries[0].truncated, true);
});

// Without this bound a single turn's size is set by the model rather than by us:
// FEED_CAP/SUB_CAP/TEXT_CAP all leave the tool list unbounded.
test('tools are capped, and the overflow is counted SEPARATELY from text truncation', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn({ tools: Array.from({ length: TOOLS_CAP + 5 }, (_, i) => `T${i}`) }));
  const e = feedSince(s, 'a@s1', 0).entries[0];
  assert.strictEqual(e.tools.length, TOOLS_CAP);
  assert.strictEqual(e.toolsOmitted, 5);
  // The renderer prints "(truncated)" under the TEXT, so a dropped tool name
  // riding that flag would be a false statement about text that is complete.
  assert.strictEqual(e.truncated, false, 'ENTER: a tools overflow must not claim the text was cut');
});

test('a text clamp and a tools overflow are reported independently', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn({
    text: 'x'.repeat(TEXT_CAP + 1),
    tools: Array.from({ length: TOOLS_CAP + 2 }, (_, i) => `T${i}`),
  }));
  const e = feedSince(s, 'a@s1', 0).entries[0];
  assert.strictEqual(e.truncated, true);
  assert.strictEqual(e.toolsOmitted, 2);
});

test('a turn within both caps omits no tools', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn());
  assert.strictEqual(feedSince(s, 'a@s1', 0).entries[0].toolsOmitted, 0);
});

// NOTE: the flatten that makes TEXT_CAP bound RETAINED bytes (not just rendered
// ones) is deliberately NOT asserted here. Every observable property of the
// string — length, content, equality, even v8.serialize output — is identical
// for a SlicedString and a flat one; only heap retention differs, which needs
// --expose-gc and a multi-hundred-MB run. It is verified by the measurement
// script banked with the t209 rework spec, not by this suite.

test('entries are capped per subagent, dropping the oldest', () => {
  const s = createSubagentStore();
  for (let i = 0; i < FEED_CAP + 10; i++) noteSubagentTurn(s, turn({ text: `t${i}` }));
  const e = feedSince(s, 'a@s1', 0).entries;
  assert.strictEqual(e.length, FEED_CAP);
  assert.strictEqual(e[0].text, 't10', 'the oldest entries are the ones dropped');
  assert.strictEqual(e[e.length - 1].text, `t${FEED_CAP + 9}`);
});

test('subagents are capped, evicting the least recently active', () => {
  const s = createSubagentStore();
  for (let i = 0; i < SUB_CAP + 3; i++) noteSubagentTurn(s, turn({ key: `k${i}` }));
  assert.strictEqual(s.feeds.size, SUB_CAP);
  assert.strictEqual(feedSince(s, 'k0', 0).known, false, 'the oldest feed is gone');
  assert.strictEqual(feedSince(s, `k${SUB_CAP + 2}`, 0).known, true);
});

// The LRU is what makes the cap safe: a still-running subagent must not be
// evicted just because it was created early.
test('a turn refreshes a feed to the newest slot, sparing it from eviction', () => {
  const s = createSubagentStore();
  for (let i = 0; i < SUB_CAP; i++) noteSubagentTurn(s, turn({ key: `k${i}` }));
  noteSubagentTurn(s, turn({ key: 'k0' }));            // k0 becomes newest
  noteSubagentTurn(s, turn({ key: 'fresh' }));         // forces one eviction
  assert.strictEqual(feedSince(s, 'k0', 0).known, true, 'ENTER: the refreshed feed survived');
  assert.strictEqual(feedSince(s, 'k1', 0).known, false, 'k1 was the true LRU');
});

// Evicting before the insert would let the feed just written be the one dropped.
test('the feed written at cap is never the one evicted', () => {
  const s = createSubagentStore();
  for (let i = 0; i < SUB_CAP; i++) noteSubagentTurn(s, turn({ key: `k${i}` }));
  noteSubagentTurn(s, turn({ key: 'newest' }));
  assert.strictEqual(feedSince(s, 'newest', 0).known, true);
  assert.strictEqual(s.feeds.size, SUB_CAP);
});

// --- feedSince ---------------------------------------------------------------

test('a cursor returns only what is past it', () => {
  const s = createSubagentStore();
  for (let i = 0; i < 5; i++) noteSubagentTurn(s, turn({ text: `t${i}` }));
  assert.deepStrictEqual(feedSince(s, 'a@s1', 3).entries.map((e) => e.seq), [4, 5]);
});

test('a cursor at the head returns nothing but still reports the head', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn());
  const r = feedSince(s, 'a@s1', 1);
  assert.deepStrictEqual(r.entries, []);
  assert.strictEqual(r.seq, 1);
});

// A chip comes from wirescope's 5s payload and can exist before the subagent's
// first response has crossed our tee — that is a normal state, not an error.
test('an unknown key reports known:false with the live head, not an error', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn({ key: 'other' }));
  assert.deepStrictEqual(feedSince(s, 'nope', 0), {
    known: false, entries: [], seq: 1, missed: false,
  });
});

// A cursor predating a FEED_CAP eviction gets the survivors; without this the
// renderer paints them contiguously and silently omits that rows were deleted
// from the middle of its own view. Reachable: polling stops while the tab is
// hidden, which is exactly when a busy subagent burns the cap.
test('a cursor that spans an eviction is told rows were dropped', () => {
  const s = createSubagentStore();
  for (let i = 0; i < FEED_CAP + 5; i++) noteSubagentTurn(s, turn({ text: `t${i}` }));
  const r = feedSince(s, 'a@s1', 0);
  assert.strictEqual(r.missed, true);
  // Assert the survivors too: `missed` alone would still pass if the filter had
  // reduced this to an empty set.
  assert.strictEqual(r.entries.length, FEED_CAP);
  assert.strictEqual(r.entries[0].text, 't5');
});

test('a cursor past the eviction point is NOT told rows were dropped', () => {
  const s = createSubagentStore();
  for (let i = 0; i < FEED_CAP + 5; i++) noteSubagentTurn(s, turn({ text: `t${i}` }));
  // seq 5 is the last evicted turn, so a caller already past it lost nothing.
  const r = feedSince(s, 'a@s1', 5);
  assert.strictEqual(r.missed, false);
  assert.strictEqual(r.entries.length, FEED_CAP, 'ENTER: the survivors are still served');
  assert.strictEqual(r.entries[0].text, 't5');
});

// The boundary: `from < evictedThrough`. A cursor sitting exactly ON the last
// evicted seq has seen everything that was dropped.
test('a cursor exactly at the last evicted seq reports no loss', () => {
  const s = createSubagentStore();
  for (let i = 0; i < FEED_CAP + 1; i++) noteSubagentTurn(s, turn({ text: `t${i}` }));
  assert.strictEqual(feedSince(s, 'a@s1', 1).missed, false);
  assert.strictEqual(feedSince(s, 'a@s1', 0).missed, true, 'ENTER: one seq earlier DOES lose t0');
});

test('a feed that never hit the cap never reports a loss', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn());
  assert.strictEqual(feedSince(s, 'a@s1', 0).missed, false);
});

test('a non-numeric cursor is treated as 0 rather than dropping every row', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn());
  for (const bad of [undefined, null, NaN, 'x']) {
    assert.strictEqual(feedSince(s, 'a@s1', bad).entries.length, 1, `ENTER: cursor ${String(bad)}`);
  }
});

test('the reply head is the STORE head, not this feed\'s last seq', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn({ key: 'a' }));
  noteSubagentTurn(s, turn({ key: 'b' }));
  // A quiet feed must still advance a poller's cursor past other subs' turns.
  assert.strictEqual(feedSince(s, 'a', 0).seq, 2);
});

test('a missing store or turn is inert rather than throwing', () => {
  assert.strictEqual(noteSubagentTurn(null, turn()), null);
  assert.strictEqual(noteSubagentTurn(createSubagentStore(), null), null);
  assert.deepStrictEqual(feedSince(null, 'a', 0), {
    known: false, entries: [], seq: 0, missed: false,
  });
});

test('a non-numeric ts normalizes to null', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn({ ts: undefined }));
  assert.strictEqual(feedSince(s, 'a@s1', 0).entries[0].ts, null);
});

test('feedKeys lists most-recently-active first', () => {
  const s = createSubagentStore();
  noteSubagentTurn(s, turn({ key: 'a' }));
  noteSubagentTurn(s, turn({ key: 'b' }));
  noteSubagentTurn(s, turn({ key: 'a' }));
  assert.deepStrictEqual(feedKeys(s), ['a', 'b']);
});
