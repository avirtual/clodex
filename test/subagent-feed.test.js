'use strict';
// The subagent turn feed (renderer/lib/subagent-feed.js). The detail endpoint
// returns only the latest COMPLETED turn, repeated on every poll until the next
// one lands — so dedup is the module's whole job, and every test here is really
// about what happens on the second identical response.
const { test } = require('node:test');
const assert = require('node:assert');

const {
  createSubagentFeed, toolPreview, MAX_FEED_ENTRIES,
} = require('../renderer/lib/subagent-feed');

const turn = (over = {}) => ({
  found: true, role: 'Explore', model: 'claude-opus-5',
  turn_ts: 1000, last_tool: 'Read', last_tool_input: { file_path: '/a.js' },
  last_text: 'reading', truncated: false, ...over,
});

test('a turn is appended and reported as appended', () => {
  const f = createSubagentFeed();
  assert.deepStrictEqual(f.ingest(turn()), { appended: true });
  // Whole-entry equality: a field silently dropped by the mapping (toolInput,
  // truncated) reads as undefined and a shape-agnostic check sails past it.
  assert.deepStrictEqual(f.entries(), [{
    ts: 1000, tool: 'Read', toolInput: { file_path: '/a.js' },
    truncated: false, text: 'reading',
  }]);
});

test('the same turn_ts arriving again is not appended', () => {
  const f = createSubagentFeed();
  f.ingest(turn());
  assert.deepStrictEqual(f.ingest(turn()), { appended: false });
  assert.strictEqual(f.entries().length, 1);
});

test('a new turn_ts appends alongside the old one', () => {
  const f = createSubagentFeed();
  f.ingest(turn());
  assert.deepStrictEqual(f.ingest(turn({ turn_ts: 1001, last_text: 'next' })), { appended: true });
  assert.deepStrictEqual(f.entries().map((e) => e.text), ['reading', 'next']);
});

// Without turn_ts the signature is content-derived, which is the only thing
// standing between the operator and the same turn repeating every 1.5s.
test('with no turn_ts, identical content dedups by signature', () => {
  const f = createSubagentFeed();
  const t = turn({ turn_ts: undefined });
  assert.strictEqual(f.ingest(t).appended, true);
  assert.strictEqual(f.ingest(t).appended, false);
  assert.strictEqual(f.entries().length, 1);
  assert.strictEqual(f.entries()[0].ts, null, 'no turn_ts must record ts as null, not undefined');
});

test('with no turn_ts, different content appends', () => {
  const f = createSubagentFeed();
  f.ingest(turn({ turn_ts: undefined }));
  assert.strictEqual(f.ingest(turn({ turn_ts: undefined, last_text: 'different' })).appended, true);
  assert.strictEqual(f.entries().length, 2);
});

// The signature only reads the first 80 chars of text, so two long turns that
// share a prefix collide. Pinned as KNOWN, not as correct: it is the popover's
// shipped behaviour, and the fallback only runs when turn_ts is absent.
test('the content signature reads a bounded prefix, so a shared 80-char prefix collides', () => {
  const f = createSubagentFeed();
  const prefix = 'x'.repeat(80);
  f.ingest(turn({ turn_ts: undefined, last_text: `${prefix}A` }));
  assert.strictEqual(f.ingest(turn({ turn_ts: undefined, last_text: `${prefix}B` })).appended, false);
});

test('a turn with neither tool nor text is skipped', () => {
  const f = createSubagentFeed();
  assert.deepStrictEqual(f.ingest(turn({ last_tool: null, last_text: null })), { appended: false });
  assert.deepStrictEqual(f.entries(), []);
});

test('a text-only turn appends (tool is not required)', () => {
  const f = createSubagentFeed();
  assert.strictEqual(f.ingest(turn({ last_tool: null, last_tool_input: null })).appended, true);
  assert.strictEqual(f.entries()[0].tool, null);
});

test('meta is captured once and not overwritten by a later turn', () => {
  const f = createSubagentFeed();
  f.ingest(turn());
  f.ingest(turn({ turn_ts: 1001, role: 'Plan', model: 'claude-sonnet-5' }));
  assert.deepStrictEqual(f.meta(), { role: 'Explore', model: 'claude-opus-5' });
});

test('meta stays null until a turn carries role or model', () => {
  const f = createSubagentFeed();
  f.ingest(turn({ role: null, model: null }));
  assert.strictEqual(f.meta(), null);
  f.ingest(turn({ turn_ts: 1001, role: null, model: 'claude-haiku-4-5' }));
  assert.deepStrictEqual(f.meta(), { role: null, model: 'claude-haiku-4-5' });
});

test('the truncated flag passes through', () => {
  const f = createSubagentFeed();
  f.ingest(turn({ truncated: true }));
  assert.strictEqual(f.entries()[0].truncated, true);
});

// ended() is what stops the poll. It must be reachable ONLY via session_cold —
// a transient found:false that ended the feed would kill a sub that simply had
// not made its first request yet.
test('session_cold ends the feed and keeps the history', () => {
  const f = createSubagentFeed();
  f.ingest(turn());
  assert.strictEqual(f.ended(), false);
  assert.deepStrictEqual(f.ingest({ found: false, reason: 'session_cold' }), { appended: false });
  assert.strictEqual(f.ended(), true);
  assert.strictEqual(f.entries().length, 1, 'history must survive the end');
});

test('session_cold with no history still ends the feed', () => {
  const f = createSubagentFeed();
  f.ingest({ found: false, reason: 'session_cold' });
  assert.strictEqual(f.ended(), true);
  assert.deepStrictEqual(f.entries(), []);
  assert.strictEqual(f.reason(), 'session_cold');
});

test('a non-cold found:false records the reason without ending', () => {
  const f = createSubagentFeed();
  f.ingest({ found: false, reason: 'no_request_body' });
  assert.strictEqual(f.ended(), false);
  assert.strictEqual(f.reason(), 'no_request_body');
});

test('a found:false with no reason at all does not end the feed', () => {
  const f = createSubagentFeed();
  f.ingest({ found: false });
  assert.strictEqual(f.ended(), false);
  assert.strictEqual(f.reason(), null);
});

test('the reason clears once a real turn arrives', () => {
  const f = createSubagentFeed();
  f.ingest({ found: false, reason: 'no_request_body' });
  f.ingest(turn());
  assert.strictEqual(f.reason(), null);
});

test('a null or non-object response is inert', () => {
  const f = createSubagentFeed();
  assert.deepStrictEqual(f.ingest(null), { appended: false });
  assert.deepStrictEqual(f.ingest(undefined), { appended: false });
  assert.strictEqual(f.ended(), false);
  assert.deepStrictEqual(f.entries(), []);
});

test('history is capped, dropping the oldest', () => {
  const f = createSubagentFeed();
  for (let i = 0; i < MAX_FEED_ENTRIES + 10; i++) f.ingest(turn({ turn_ts: i, last_text: `t${i}` }));
  const e = f.entries();
  assert.strictEqual(e.length, MAX_FEED_ENTRIES);
  assert.strictEqual(e[e.length - 1].text, `t${MAX_FEED_ENTRIES + 9}`);
  assert.strictEqual(e[0].text, 't10', 'the oldest entries are the ones dropped');
});

// The cap evicts entries but must NOT evict their signatures: the endpoint keeps
// returning the latest turn, and if that turn had aged out of `seen` it would be
// re-appended on the next poll, growing the feed forever with one repeating row.
test('a dropped entry does not come back when its response repeats', () => {
  const f = createSubagentFeed();
  for (let i = 0; i < MAX_FEED_ENTRIES + 10; i++) f.ingest(turn({ turn_ts: i, last_text: `t${i}` }));
  assert.strictEqual(f.ingest(turn({ turn_ts: 0, last_text: 't0' })).appended, false);
  assert.strictEqual(f.entries().length, MAX_FEED_ENTRIES);
});

test('feeds are independent instances', () => {
  const a = createSubagentFeed();
  const b = createSubagentFeed();
  a.ingest(turn());
  assert.deepStrictEqual(b.entries(), []);
  assert.strictEqual(b.meta(), null);
});

// --- toolPreview -------------------------------------------------------------

test('toolPreview probes the primary keys in order', () => {
  assert.strictEqual(toolPreview({ command: 'ls', file_path: '/a' }), 'ls');
  assert.strictEqual(toolPreview({ file_path: '/a', pattern: 'x' }), '/a');
  assert.strictEqual(toolPreview({ description: 'd' }), 'd');
});

test('toolPreview skips an empty or non-string primary rather than returning it', () => {
  assert.strictEqual(toolPreview({ command: '', file_path: '/a' }), '/a');
  assert.strictEqual(toolPreview({ command: 42, file_path: '/a' }), '/a');
});

test('toolPreview falls back to compact JSON for unknown keys', () => {
  assert.strictEqual(toolPreview({ weird: 1 }), '{"weird":1}');
});

test('toolPreview returns empty for nothing usable', () => {
  assert.strictEqual(toolPreview(null), '');
  assert.strictEqual(toolPreview(undefined), '');
  assert.strictEqual(toolPreview('a string'), '');
});

// wirescope forwards the model's input verbatim, so a cyclic or unserializable
// object is not impossible; a throw here would break the whole feed render.
test('toolPreview survives an unserializable input', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.strictEqual(toolPreview(cyclic), '');
});
