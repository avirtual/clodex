'use strict';
// env-edit.test.js — the pure New-Session-dialog env parse leaf (T46). Pins the
// KEY=value-per-line grammar the dialog feeds into create()'s session-env param:
// valid keys land, junk is dropped (never thrown — a stray line can't block
// Create), and the deny key can't ride in through the textarea either.

const { test } = require('node:test');
const assert = require('node:assert');
const { parseEnvLines, formatEnvLines } = require('../renderer/lib/env-edit');

test('parses KEY=value lines into a flat map, first "=" splits so values may contain "="', () => {
  const { env, skipped } = parseEnvLines('AWS_PROFILE=acct\nDB_URL=postgres://h/db?a=1&b=2');
  assert.deepStrictEqual(env, { AWS_PROFILE: 'acct', DB_URL: 'postgres://h/db?a=1&b=2' });
  assert.deepStrictEqual(skipped, []);
});

test('blank lines and #-comments are ignored silently', () => {
  const { env, skipped } = parseEnvLines('\n  \n# a comment\n   # indented comment\nK=v\n');
  assert.deepStrictEqual(env, { K: 'v' });
  assert.deepStrictEqual(skipped, []);
});

test('a line with no "=" is dropped and reported, not thrown', () => {
  const { env, skipped } = parseEnvLines('JUST_A_WORD\nK=v');
  assert.deepStrictEqual(env, { K: 'v' });
  assert.strictEqual(skipped.length, 1);
  assert.match(skipped[0].reason, /no "="/);
});

test('invalid keys are dropped with a reason (leading digit, punctuation)', () => {
  const { env, skipped } = parseEnvLines('2BAD=x\nBAD-KEY=y\nOK=z');
  assert.deepStrictEqual(env, { OK: 'z' });
  assert.deepStrictEqual(skipped.map((s) => s.reason).sort(), ['invalid env key "2BAD"', 'invalid env key "BAD-KEY"'].sort());
});

test('the deny key cannot ride in through the textarea', () => {
  const { env, skipped } = parseEnvLines('CLODEX_REMOTE_TOKEN=leak\nOK=1');
  assert.deepStrictEqual(env, { OK: '1' });
  assert.strictEqual(skipped.length, 1);
  assert.match(skipped[0].reason, /reserved/);
});

test('keys are trimmed; value keeps intentional surrounding spaces', () => {
  const { env } = parseEnvLines('  KEY  = has spaces ');
  assert.deepStrictEqual(env, { KEY: ' has spaces ' });
});

test('CRLF paste: trailing CR is stripped from the value', () => {
  const { env } = parseEnvLines('A=1\r\nB=2\r');
  assert.deepStrictEqual(env, { A: '1', B: '2' });
});

test('empty value is allowed (KEY= sets it to empty string)', () => {
  const { env } = parseEnvLines('EMPTY=');
  assert.deepStrictEqual(env, { EMPTY: '' });
});

test('last duplicate key wins', () => {
  const { env } = parseEnvLines('K=first\nK=second');
  assert.deepStrictEqual(env, { K: 'second' });
});

test('empty / null input yields an empty map, no throw', () => {
  assert.deepStrictEqual(parseEnvLines('').env, {});
  assert.deepStrictEqual(parseEnvLines(null).env, {});
  assert.deepStrictEqual(parseEnvLines(undefined).env, {});
});

test('formatEnvLines round-trips a flat map back to KEY=value lines', () => {
  const text = formatEnvLines({ AWS_PROFILE: 'acct', REGION: 'us-east-1' });
  assert.strictEqual(text, 'AWS_PROFILE=acct\nREGION=us-east-1');
  assert.deepStrictEqual(parseEnvLines(text).env, { AWS_PROFILE: 'acct', REGION: 'us-east-1' });
  assert.strictEqual(formatEnvLines(null), '');
});
