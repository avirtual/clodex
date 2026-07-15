'use strict';
// Unit tests for renderer/lib/ipc-export.js — the pure text half of the IPC
// log's Export button. The line shape is what operators grep and paste to
// agents during messaging forensics, so it's pinned.

const test = require('node:test');
const assert = require('node:assert');
const { MAX_EXPORT_LINES, formatIpcLine, buildExportText, exportFilename } = require('../renderer/lib/ipc-export');

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
