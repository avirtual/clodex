'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { treeRssBytes, parsePs, sample } = require('../proc-memory');

const ROWS = [
  { pid: 100, ppid: 1, rssKb: 1000 },
  { pid: 101, ppid: 100, rssKb: 200 },
  { pid: 102, ppid: 101, rssKb: 30 },
  { pid: 200, ppid: 1, rssKb: 4000 },
  { pid: 201, ppid: 200, rssKb: 500 },
  { pid: 300, ppid: 1, rssKb: 7 },
];

test('treeRssBytes sums a three-level tree in bytes', () => {
  assert.deepStrictEqual([...treeRssBytes(ROWS, [100])], [[100, 1259520]]);
});

test('treeRssBytes keeps two roots apart', () => {
  assert.deepStrictEqual([...treeRssBytes(ROWS, [100, 200])], [[100, 1259520], [200, 4608000]]);
});

test('a root absent from ps counts 0', () => {
  assert.deepStrictEqual([...treeRssBytes(ROWS, [999])], [[999, 0]]);
});

test('a ppid cycle terminates and counts each pid once', () => {
  const rows = [{ pid: 10, ppid: 11, rssKb: 1 }, { pid: 11, ppid: 10, rssKb: 2 }];
  assert.deepStrictEqual([...treeRssBytes(rows, [10])], [[10, 3072]]);
});

test('parsePs reads ps -axo pid=,ppid=,rss= and skips junk', () => {
  assert.deepStrictEqual(parsePs('  100     1  1000\n101 100 200\n\ngarbage\n'), [
    { pid: 100, ppid: 1, rssKb: 1000 }, { pid: 101, ppid: 100, rssKb: 200 },
  ]);
});

test('sample runs ps once for all roots, with a 2 s timeout', () => {
  const calls = [];
  const exec = (cmd, args, opts) => { calls.push([cmd, args, opts.timeout]); return '100 1 1000\n101 100 200\n200 1 4\n'; };
  const out = sample([100, 200], { platform: 'darwin', exec });
  assert.deepStrictEqual([...out], [[100, 1228800], [200, 4096]]);
  assert.deepStrictEqual(calls, [['ps', ['-axo', 'pid=,ppid=,rss='], 2000]]);
});

test('sample returns an empty Map on failure, on win32 and with no pids', () => {
  const boom = () => { throw new Error('timeout'); };
  assert.deepStrictEqual(sample([100], { platform: 'darwin', exec: boom }), new Map());
  let called = 0;
  const exec = () => { called++; return '100 1 1000\n'; };
  assert.deepStrictEqual(sample([100], { platform: 'win32', exec }), new Map());
  assert.deepStrictEqual(sample([], { platform: 'darwin', exec }), new Map());
  assert.strictEqual(called, 0);
});
