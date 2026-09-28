// Run: node --test
// Covers renderer/lib/format.js — the pure value->string formatters. `esc` is
// excluded (it needs the global `document`, absent under node --test); every
// other formatter is pure and exercised here.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const F = require('../renderer/lib/format');

test('fmtTokens: k/M compaction', () => {
  assert.strictEqual(F.fmtTokens(500), '500');
  assert.strictEqual(F.fmtTokens(201234), '201k');
  assert.strictEqual(F.fmtTokens(1000000), '1M');
  assert.strictEqual(F.fmtTokens(1500000), '1.5M');
});

test('fmtCountdown: mm:ss, floored at 0', () => {
  assert.strictEqual(F.fmtCountdown(0), '0:00');
  assert.strictEqual(F.fmtCountdown(9), '0:09');
  assert.strictEqual(F.fmtCountdown(75), '1:15');
  assert.strictEqual(F.fmtCountdown(-5), '0:00');
});

test('fmtUsd: tiered precision', () => {
  assert.strictEqual(F.fmtUsd(NaN), '$0');
  assert.strictEqual(F.fmtUsd(0.05), '$0.0500');
  assert.strictEqual(F.fmtUsd(0.5), '$0.500');
  assert.strictEqual(F.fmtUsd(3.14159), '$3.14');
  assert.strictEqual(F.fmtUsd(250), '$250');
});

test('fmtDur: s/m/h', () => {
  assert.strictEqual(F.fmtDur(0), '');
  assert.strictEqual(F.fmtDur(45), '45s');
  assert.strictEqual(F.fmtDur(150), '3m');
  assert.strictEqual(F.fmtDur(7200), '2.0h');
});

test('fmtBytes: unit ladder', () => {
  assert.strictEqual(F.fmtBytes(0), '0 B');
  assert.strictEqual(F.fmtBytes(512), '512 B');
  assert.strictEqual(F.fmtBytes(2048), '2.0 KB');
  assert.strictEqual(F.fmtBytes(1024 * 150), '150 KB'); // >=100 rounds
  assert.strictEqual(F.fmtBytes(1024 * 1024 * 3), '3.0 MB');
});

test('fmtBustTokens: k compaction with 0 special-case', () => {
  assert.strictEqual(F.fmtBustTokens(0), '0');
  assert.strictEqual(F.fmtBustTokens(500), '500');
  assert.strictEqual(F.fmtBustTokens(1500), '1.5k');
  assert.strictEqual(F.fmtBustTokens(25000), '25k');
});

test('fmtAgo: relative buckets', () => {
  const now = Date.now();
  assert.strictEqual(F.fmtAgo(now), 'now');
  assert.strictEqual(F.fmtAgo(now - 5 * 60 * 1000), '5m ago');
  assert.strictEqual(F.fmtAgo(now - 3 * 3600 * 1000), '3h ago');
  assert.strictEqual(F.fmtAgo(now - 2 * 86400 * 1000), '2d ago');
});

test('shortTs: ISO -> "Mon D HH:MM", passthrough on junk', () => {
  assert.strictEqual(F.shortTs('2026-07-04T13:05:22Z'), 'Jul 4 13:05');
  assert.strictEqual(F.shortTs('not-a-date'), 'not-a-date');
  assert.strictEqual(F.shortTs(''), '');
});

test('baseName: last segment for the sidebar second line, ~ for home', () => {
  const home = os.homedir();
  assert.strictEqual(F.baseName(''), '');
  assert.strictEqual(F.baseName(home), '~');
  assert.strictEqual(F.baseName('~'), '~');
  assert.strictEqual(F.baseName(path.join(home, 'projects', 'clodex')), 'clodex');
  assert.strictEqual(F.baseName('/var/log/app'), 'app');
  assert.strictEqual(F.baseName('/'), '/');
});

test('fmtMinutes: whole minutes, never "0m"', () => {
  assert.strictEqual(F.fmtMinutes(3590), '60m');
  assert.strictEqual(F.fmtMinutes(3540), '59m');
  assert.strictEqual(F.fmtMinutes(299), '5m');
  assert.strictEqual(F.fmtMinutes(61), '2m');
  assert.strictEqual(F.fmtMinutes(30), '1m');
  assert.strictEqual(F.fmtMinutes(1), '1m');
});

test('shortPath is gone: it had no caller and a latent ~-prefix bug', () => {
  assert.strictEqual('shortPath' in F, false);
});

test('fmtTokens / fmtBustTokens: values that round up to the next unit render in that unit', () => {
  assert.strictEqual(F.fmtTokens(999600), '1M');
  assert.strictEqual(F.fmtTokens(1999999), '2M');
  assert.strictEqual(F.fmtTokens(999400), '999k');
  assert.strictEqual(F.fmtBustTokens(9960), '10k');
  assert.strictEqual(F.fmtBustTokens(9940), '9.9k');
});

test('fmtAgo / fmtDur / fmtBytes: a value that rounds up to the next unit is shown in that unit', (t) => {
  t.mock.method(Date, 'now', () => 1e12);
  assert.strictEqual(F.fmtAgo(1e12 - 3570e3), '1h ago');
  assert.strictEqual(F.fmtAgo(1e12 - 3540e3), '59m ago');
  assert.strictEqual(F.fmtAgo(1e12 - 86100e3), '1d ago');
  assert.strictEqual(F.fmtAgo(1e12 - 84000e3), '23h ago');
  assert.strictEqual(F.fmtDur(3599), '1.0h');
  assert.strictEqual(F.fmtDur(59.6), '1m');
  assert.strictEqual(F.fmtBytes(1048575), '1.0 MB');
  assert.strictEqual(F.fmtBytes(1023.6), '1.0 KB');
});
