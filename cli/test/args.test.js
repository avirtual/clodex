'use strict';
// args.test.js — the leaf argv parser: flags, booleans, multi, greedy rest,
// `--` verbatim tail, and the usage errors.
const { test } = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/args');

const OPTS = { booleans: ['json', 'force', 'fresh'], multi: ['arg'], greedy: ['tunnel'], aliases: { h: 'help', 'remote-port': 'remotePort' } };

test('positionals collect in order', () => {
  const r = parse(['sessions', 'a', 'b'], OPTS);
  assert.deepStrictEqual(r._, ['sessions', 'a', 'b']);
});

test('--flag value and --flag=value both bind', () => {
  assert.strictEqual(parse(['x', '--url', 'http://h'], OPTS).url, 'http://h');
  assert.strictEqual(parse(['x', '--url=http://h'], OPTS).url, 'http://h');
});

test('booleans take no value; =true/false coerce', () => {
  assert.strictEqual(parse(['x', '--json'], OPTS).json, true);
  assert.strictEqual(parse(['x', '--json=false'], OPTS).json, false);
});

test('multi flags accumulate', () => {
  assert.deepStrictEqual(parse(['x', '--arg', 'a', '--arg', 'b'], OPTS).arg, ['a', 'b']);
});

test('greedy flag consumes the rest as an argv array', () => {
  const r = parse(['ctx', 'add', 'k', '--token', 't', '--tunnel', 'kubectl', 'port-forward', '{port}:7900'], OPTS);
  assert.strictEqual(r.token, 't');
  assert.deepStrictEqual(r.tunnel, ['kubectl', 'port-forward', '{port}:7900']);
});

test('-- passes the tail verbatim (incl. leading dashes)', () => {
  const r = parse(['send', 'x', '--', '--not-a-flag', 'hello'], OPTS);
  assert.deepStrictEqual(r._, ['send', 'x', '--not-a-flag', 'hello']);
});

test('alias maps short + hyphenated names', () => {
  assert.strictEqual(parse(['x', '-h'], { ...OPTS, booleans: ['help'] }).help, true);
  assert.strictEqual(parse(['x', '--remote-port', '7', ], OPTS).remotePort, '7');
});

test('missing value throws usage error', () => {
  assert.throws(() => parse(['x', '--url'], OPTS), /needs a value/);
});

test('greedy with no args throws', () => {
  assert.throws(() => parse(['x', '--tunnel'], OPTS), /at least one argument/);
});
