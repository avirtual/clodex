'use strict';
// The renderer-side subagent turn feed (renderer/lib/subagent-feed.js), now fed
// from Clodex's own wire ring behind a monotonic cursor. The old source repeated
// its latest turn on every poll, so dedup-by-signature was this module's whole
// job; the cursor replaces that, and these tests are about what the cursor must
// refuse (a replay, an out-of-order reply) and what it must still advance past.
const { test } = require('node:test');
const assert = require('node:assert');

const { createSubagentFeed, MAX_FEED_ENTRIES } = require('../renderer/lib/subagent-feed');

const entry = (seq, over = {}) => ({
  seq, ts: 1000 + seq, text: `t${seq}`, thinking: null,
  tools: [{ name: 'Read', arg: '/a.js' }],
  toolsOmitted: 0, truncated: false, thinkingTruncated: false, ...over,
});
const reply = (entries, over = {}) => ({
  known: true, role: 'Explore', model: 'claude-opus-5', missed: false,
  entries, seq: entries.length ? entries[entries.length - 1].seq : 0, ...over,
});

test('a turn is appended and reported as appended', () => {
  const f = createSubagentFeed();
  assert.deepStrictEqual(f.ingest(reply([entry(1)])), { appended: true });
  // Whole-entry equality: a field silently dropped by the mapping (tools,
  // truncated) reads as undefined and a shape-agnostic check sails past it.
  assert.deepStrictEqual(f.entries(), [{
    seq: 1, ts: 1001, text: 't1', thinking: null,
    tools: [{ name: 'Read', arg: '/a.js' }],
    toolsOmitted: 0, truncated: false, thinkingTruncated: false,
  }]);
});

// A peer on an older build is a second source for this reply, so the renderer
// cannot rely on the main-process ring having normalized the shape for it.
test('a bare tool-name string from an older peer normalizes to a record', () => {
  const f = createSubagentFeed();
  f.ingest(reply([entry(1, { tools: ['Read', { name: 'Bash', arg: 'ls -la' }, { name: '' }, null] })]));
  assert.deepStrictEqual(f.entries()[0].tools,
    [{ name: 'Read', arg: null }, { name: 'Bash', arg: 'ls -la' }]);
});

test('a tool arg that is missing, empty or non-string normalizes to exactly null', () => {
  const f = createSubagentFeed();
  f.ingest(reply([entry(1, { tools: [{ name: 'A' }, { name: 'B', arg: '' }, { name: 'C', arg: 7 }] })]));
  const got = f.entries()[0].tools;
  assert.strictEqual(got.length, 3, 'ENTER: no row was dropped by the normalization');
  for (const t of got) {
    assert.ok('arg' in t, `${t.name}: arg present, not absent`);
    assert.notStrictEqual(t.arg, undefined, `${t.name}: arg is not undefined`);
    assert.strictEqual(t.arg, null, `${t.name}: arg is exactly null`);
  }
});

test('the cursor advances to the last ingested seq', () => {
  const f = createSubagentFeed();
  assert.strictEqual(f.cursor(), 0);
  f.ingest(reply([entry(1), entry(2)]));
  assert.strictEqual(f.cursor(), 2);
  assert.deepStrictEqual(f.entries().map((e) => e.seq), [1, 2]);
});

// The whole point of the cursor: a server that ignores `since`, or a reply that
// overtakes an earlier one, must not put a turn on screen twice.
test('an entry at or below the cursor is refused', () => {
  const f = createSubagentFeed();
  f.ingest(reply([entry(1), entry(2)]));
  assert.deepStrictEqual(f.ingest(reply([entry(1), entry(2)])), { appended: false });
  assert.strictEqual(f.entries().length, 2, 'ENTER: the replayed rows must not duplicate');
});

test('a mixed reply appends only the rows past the cursor', () => {
  const f = createSubagentFeed();
  f.ingest(reply([entry(1), entry(2)]));
  assert.strictEqual(f.ingest(reply([entry(2), entry(3)])).appended, true);
  assert.deepStrictEqual(f.entries().map((e) => e.seq), [1, 2, 3]);
});

// seq is monotonic per SESSION, so a quiet feed's cursor must still advance past
// other subagents' turns — otherwise every poll re-asks a range that only grows.
test('an empty reply still advances the cursor to the store head', () => {
  const f = createSubagentFeed();
  f.ingest(reply([entry(1)]));
  assert.deepStrictEqual(f.ingest(reply([], { seq: 40 })), { appended: false });
  assert.strictEqual(f.cursor(), 40);
});

test('a head lower than the cursor never rewinds it', () => {
  const f = createSubagentFeed();
  f.ingest(reply([entry(7)]));
  f.ingest(reply([], { seq: 2 }));
  assert.strictEqual(f.cursor(), 7);
});

test('an entry with no numeric seq is skipped rather than appended', () => {
  const f = createSubagentFeed();
  assert.deepStrictEqual(f.ingest(reply([{ ts: 1, text: 'x' }], { seq: 0 })), { appended: false });
  assert.deepStrictEqual(f.entries(), []);
});

test('missed flips only on an explicit missed:true', () => {
  const f = createSubagentFeed();
  assert.strictEqual(f.missed(), false);
  f.ingest(reply([entry(1)]));
  assert.strictEqual(f.missed(), false, 'ENTER: an ordinary reply must not flip it');
  f.ingest(reply([entry(2)], { missed: true }));
  assert.strictEqual(f.missed(), true);
});

// Later polls ask from a cursor that no longer predates the eviction, so the
// server correctly answers missed:false — but rows ARE still absent from what
// is on screen, and retracting the admission would misdescribe it.
test('missed is sticky once set', () => {
  const f = createSubagentFeed();
  f.ingest(reply([entry(1)], { missed: true }));
  f.ingest(reply([entry(2)], { missed: false }));
  assert.strictEqual(f.missed(), true);
  assert.deepStrictEqual(f.entries().map((e) => e.seq), [1, 2], 'ENTER: ingest still worked');
});

test('a tools overflow count is carried through to the renderer', () => {
  const f = createSubagentFeed();
  f.ingest(reply([entry(1, { toolsOmitted: 4 })]));
  assert.strictEqual(f.entries()[0].toolsOmitted, 4);
});

test('a missing or negative toolsOmitted normalizes to 0', () => {
  const f = createSubagentFeed();
  f.ingest(reply([entry(1, { toolsOmitted: undefined }), entry(2, { toolsOmitted: -3 })]));
  assert.deepStrictEqual(f.entries().map((e) => e.toolsOmitted), [0, 0]);
});

test('meta is captured once and not overwritten by a later reply', () => {
  const f = createSubagentFeed();
  f.ingest(reply([entry(1)]));
  f.ingest(reply([entry(2)], { role: 'Plan', model: 'claude-sonnet-5' }));
  assert.deepStrictEqual(f.meta(), { role: 'Explore', model: 'claude-opus-5' });
});

test('meta stays null until a reply carries role or model', () => {
  const f = createSubagentFeed();
  f.ingest(reply([entry(1)], { role: null, model: null }));
  assert.strictEqual(f.meta(), null);
  f.ingest(reply([entry(2)], { role: null, model: 'claude-haiku-4-5' }));
  assert.deepStrictEqual(f.meta(), { role: null, model: 'claude-haiku-4-5' });
});

test('missing text and tools normalize rather than arriving undefined', () => {
  const f = createSubagentFeed();
  f.ingest(reply([{ seq: 1 }]));
  assert.deepStrictEqual(f.entries(), [{
    seq: 1, ts: null, text: null, thinking: null, tools: [],
    toolsOmitted: 0, truncated: false, thinkingTruncated: false,
  }]);
});

test('thinking passes through as its own field, never merged into text', () => {
  const f = createSubagentFeed();
  f.ingest(reply([entry(1, { text: 'the answer', thinking: 'the reasoning' })]));
  const e = f.entries()[0];
  assert.strictEqual(e.thinking, 'the reasoning');
  assert.strictEqual(e.text, 'the answer', 'ENTER: text is untouched by the thinking capture');
});

// An older peer, or a turn the model did no thinking on, is the same case to the
// renderer: nothing to draw. It must be `null` and not `undefined`, because the
// row is emitted on truthiness and an absent field would be a third state that
// looks identical here but serializes differently over the peer link.
test('a missing, empty or non-string thinking normalizes to exactly null', () => {
  const f = createSubagentFeed();
  f.ingest(reply([
    entry(1, { thinking: undefined }), entry(2, { thinking: '' }), entry(3, { thinking: 7 }),
  ]));
  const got = f.entries();
  assert.strictEqual(got.length, 3, 'ENTER: no row was dropped by the normalization');
  for (const e of got) {
    assert.ok('thinking' in e, `${e.seq}: thinking present, not absent`);
    assert.notStrictEqual(e.thinking, undefined, `${e.seq}: not undefined`);
    assert.strictEqual(e.thinking, null, `${e.seq}: exactly null`);
  }
});

test('thinkingTruncated is carried through and is independent of truncated', () => {
  const f = createSubagentFeed();
  f.ingest(reply([
    entry(1, { thinking: 'cut', thinkingTruncated: true }),
    entry(2, { truncated: true }),
  ]));
  const [a, b] = f.entries();
  assert.deepStrictEqual([a.thinkingTruncated, a.truncated], [true, false]);
  assert.deepStrictEqual([b.thinkingTruncated, b.truncated], [false, true]);
});

test('the truncated flag passes through', () => {
  const f = createSubagentFeed();
  f.ingest(reply([entry(1, { truncated: true })]));
  assert.strictEqual(f.entries()[0].truncated, true);
});

test('a null or non-object reply is inert', () => {
  const f = createSubagentFeed();
  assert.deepStrictEqual(f.ingest(null), { appended: false });
  assert.deepStrictEqual(f.ingest(undefined), { appended: false });
  assert.deepStrictEqual(f.entries(), []);
  assert.strictEqual(f.cursor(), 0);
});

test('history is capped, dropping the oldest', () => {
  const f = createSubagentFeed();
  for (let i = 1; i <= MAX_FEED_ENTRIES + 10; i++) f.ingest(reply([entry(i)]));
  const e = f.entries();
  assert.strictEqual(e.length, MAX_FEED_ENTRIES);
  assert.strictEqual(e[e.length - 1].text, `t${MAX_FEED_ENTRIES + 10}`);
  assert.strictEqual(e[0].text, 't11', 'the oldest entries are the ones dropped');
});

// The cap evicts entries but the cursor is unaffected, so an evicted turn can
// never be re-served and re-appended — the failure the old signature-set existed
// to prevent, now structural.
test('a dropped entry cannot come back when its row repeats', () => {
  const f = createSubagentFeed();
  for (let i = 1; i <= MAX_FEED_ENTRIES + 10; i++) f.ingest(reply([entry(i)]));
  assert.strictEqual(f.ingest(reply([entry(1)])).appended, false);
  assert.strictEqual(f.entries().length, MAX_FEED_ENTRIES);
});

test('feeds are independent instances', () => {
  const a = createSubagentFeed();
  const b = createSubagentFeed();
  a.ingest(reply([entry(1)]));
  assert.deepStrictEqual(b.entries(), []);
  assert.strictEqual(b.meta(), null);
  assert.strictEqual(b.cursor(), 0);
});

// The browser frontend runs its own copy of the tool row out of the committed
// bundle, so a renderer-only change leaves web users reading bare tool names —
// the exact state the snippet exists to end, and silent because the desktop app
// looks right. esbuild emits this expression byte-identically, which is the only
// reason one string gates both files. If a later edit breaks that byte-identity,
// pin the bundle's own shape rather than deleting the gate.
test('the tool-arg span is in the committed web bundle, not just the renderer', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');
  const SPAN = '<span class="subagent-tool-arg">';
  const rsrc = fs.readFileSync(path.join(ROOT, 'renderer', 'activity-tab.js'), 'utf8');
  assert.ok(rsrc.includes(SPAN), 'ENTER: the renderer still renders a tool-arg span at all');
  const wsrc = fs.readFileSync(path.join(ROOT, 'web-dist', 'index.html'), 'utf8');
  assert.ok(wsrc.includes(SPAN),
    'web-dist/index.html is stale — run `npm run build:web` and commit it, or the '
    + 'browser frontend keeps showing tool names with no arguments');
  assert.ok(wsrc.includes('.subagent-tool-arg {'),
    'the bundle carries the markup but not its CSS — the snippet would render unstyled');
});

// Same gate, same reason, for the thinking row. Its CSS is load-bearing rather
// than cosmetic: unstyled, the clamp is gone and a 2048-char reasoning block
// pushes every other row out of the pane.
test('the thinking row is in the committed web bundle, not just the renderer', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');
  const DIV = '<div class="subagent-detail-thinking">';
  const rsrc = fs.readFileSync(path.join(ROOT, 'renderer', 'activity-tab.js'), 'utf8');
  assert.ok(rsrc.includes(DIV), 'ENTER: the renderer still renders a thinking row at all');
  const wsrc = fs.readFileSync(path.join(ROOT, 'web-dist', 'index.html'), 'utf8');
  assert.ok(wsrc.includes(DIV),
    'web-dist/index.html is stale — run `npm run build:web` and commit it, or the '
    + 'browser frontend shows no reasoning at all');
  assert.ok(wsrc.includes('-webkit-line-clamp: 3'),
    'the bundle carries the thinking row but not its clamp — a long block would '
    + 'push the rest of the feed out of the pane');
});
