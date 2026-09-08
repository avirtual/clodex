'use strict';
// Unit tests for renderer/lib/ipc-export.js — the pure text half of the IPC
// log's Export button. The line shape is what operators grep and paste to
// agents during messaging forensics, so it's pinned.

const test = require('node:test');
const assert = require('node:assert');
const { MAX_EXPORT_LINES, shortSessionId, ipcRowParts, formatIpcLine, buildExportText, exportFilename } = require('../renderer/lib/ipc-export');

test('formatIpcLine: pinned shape — ISO ts, from -> to, body', () => {
  const d = new Date('2026-07-15T12:34:56.789Z');
  assert.strictEqual(
    formatIpcLine({ from: 'clodex', to: 'clodex-hand', body: 'ping' }, d),
    '2026-07-15T12:34:56.789Z clodex -> clodex-hand ping',
  );
});

test('formatIpcLine: embedded newlines flatten to literal \\n (one line per message)', () => {
  const d = new Date('2026-07-15T12:00:00.000Z');
  const line = formatIpcLine({ from: 'a', to: 'b', body: 'l1\nl2\r\nl3' }, d);
  assert.ok(!line.includes('\n'));
  assert.ok(line.endsWith('l1\\nl2\\nl3'));
});

test('formatIpcLine: missing fields degrade, never throw', () => {
  const d = new Date('2026-07-15T12:00:00.000Z');
  assert.strictEqual(formatIpcLine({}, d), '2026-07-15T12:00:00.000Z ? -> ? ');
  assert.strictEqual(formatIpcLine(null, d), '2026-07-15T12:00:00.000Z ? -> ? ');
});

// ipcRowParts is the SINGLE decision about what a row's badges say — the DOM row
// in renderer/ipc-log.js and the export line below both call it, so the exported
// copy of a keep-warm row cannot drift from the one on screen.
test('ipcRowParts: an ordinary message keeps from -> to and grows no session badge', () => {
  assert.deepStrictEqual(
    ipcRowParts({ type: 'dm', from: 'clodex', to: 'clodex-hand', body: 'x' }),
    { name: 'clodex', session: null, to: 'clodex-hand' },
  );
  // `to: ''` is real on this channel — session-manager's `attention` rows ship it
  // — and it must stay a two-badge row, because the one-sided branch is keyed on
  // `type`, not on an absent `to`.
  assert.deepStrictEqual(
    ipcRowParts({ type: 'attention', from: 'clodex', to: '', body: 'x' }),
    { name: 'clodex', session: null, to: '' },
  );
});

test('ipcRowParts: a keepwarm row is one-sided — seat name, short id, no target', () => {
  assert.deepStrictEqual(
    ipcRowParts({ type: 'keepwarm', from: 'clodex', session: '445c6720-1111-2222-3333-c7d299dd39c0' }),
    { name: 'clodex', session: '445c6720', to: null },
  );
});

// The unresolved case: one identifier, never two of the same. The short id moves
// INTO the name position rather than being shown beside itself, which is the
// three-times-repeated-uuid row this replaced.
test('ipcRowParts: an unresolved seat shows the short id once, in the name position', () => {
  assert.deepStrictEqual(
    ipcRowParts({ type: 'keepwarm', from: null, session: '445c6720-1111-2222-3333-c7d299dd39c0' }),
    { name: '445c6720', session: null, to: null },
  );
  // Neither name nor session: the row still renders rather than throwing.
  assert.deepStrictEqual(
    ipcRowParts({ type: 'keepwarm', from: null, session: null }),
    { name: '?', session: null, to: null },
  );
});

test('shortSessionId: 8 chars, shorter ids pass through, absent stays absent', () => {
  assert.strictEqual(shortSessionId('445c6720-1111-2222-3333-c7d299dd39c0'), '445c6720');
  assert.strictEqual(shortSessionId('sid-1'), 'sid-1');
  assert.strictEqual(shortSessionId(''), null);
  assert.strictEqual(shortSessionId(null), null);
});

test('formatIpcLine: a keepwarm row exports with no arrow and the id parenthesised', () => {
  const d = new Date('2026-07-15T12:34:56.789Z');
  assert.strictEqual(
    formatIpcLine({ type: 'keepwarm', from: 'clodex', session: '445c6720-1111-2222-3333-c7d299dd39c0',
      body: 'keep-warm ping #3 — warm, 142.2k cached' }, d),
    '2026-07-15T12:34:56.789Z clodex (445c6720) keep-warm ping #3 — warm, 142.2k cached',
  );
  assert.strictEqual(
    formatIpcLine({ type: 'keepwarm', from: null, session: '445c6720-1111-2222-3333-c7d299dd39c0',
      body: 'keep-warm ping #3' }, d),
    '2026-07-15T12:34:56.789Z 445c6720 keep-warm ping #3',
  );
});

test('buildExportText: joins with newline, one trailing newline, empty -> empty string', () => {
  assert.strictEqual(buildExportText(['a', 'b']), 'a\nb\n');
  assert.strictEqual(buildExportText([]), '');
  assert.strictEqual(buildExportText(null), '');
});

test('exportFilename: local-time stamp, .txt', () => {
  const d = new Date(2026, 6, 15, 9, 5, 3); // local components
  assert.strictEqual(exportFilename(d), 'clodex-ipc-log-20260715-090503.txt');
});

test('MAX_EXPORT_LINES is a sane positive cap', () => {
  assert.ok(Number.isInteger(MAX_EXPORT_LINES) && MAX_EXPORT_LINES >= 1000);
});
