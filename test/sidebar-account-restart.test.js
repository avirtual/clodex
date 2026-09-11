'use strict';
// Run: node --test test/sidebar-account-restart.test.js
//
// t812 r1 nit 1. A restart kills the PTY, `session-exit` REMOVES the sidebar row,
// and each restart path rebuilds it from a dataset snapshot taken beforehand. The
// account is not re-derived by any of those rebuilds — it rides `session:list`,
// which they do not read — so a path that fails to snapshot it drops the chip on
// every restart until the next meta refresh happens to repaint it.
//
// `accountOfRow` is the shared helper all five sites take it from, so it is the
// unit under test; the SOURCE assertion below is what keeps the five call sites
// honest, since renderer.js is DOM-bound and cannot be required.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');

function loadHelper(row) {
  const start = rendererSrc.indexOf('function accountOfRow(');
  assert.ok(start >= 0, 'ENTER: accountOfRow was not found in the shipped renderer');
  const body = rendererSrc.slice(start, rendererSrc.indexOf('\n}\n', start) + 2);
  const env = {
    sessionList: { querySelector: () => row },
    CSS: { escape: (s) => s },
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${body}; return accountOfRow;`)(...names.map((n) => env[n]));
}

test('accountOfRow reads the label a non-default row carries', () => {
  const read = loadHelper({ dataset: { account: 'sub-2' } });
  assert.strictEqual(read('seat-a'), 'sub-2');
});

test('accountOfRow answers null for a default row and for a row that is already gone', () => {
  // A default row carries no `dataset.account` at all (the builder only stamps
  // the exception), and a rebuild happening after session-exit finds no row —
  // both must come back as null, which addSessionToSidebar treats as "no chip".
  assert.strictEqual(loadHelper({ dataset: {} })('seat-a'), null);
  assert.strictEqual(loadHelper(null)('seat-a'), null);
});

test('every restart path snapshots the account and passes it to the rebuild', () => {
  // The five sites that destroy and rebuild a row. Each must take the account
  // from the shared helper (or, for the args-save path, recompute it from the env
  // it is about to write) and hand it to addSessionToSidebar as the 8th argument.
  const rebuilds = [...rendererSrc.matchAll(/addSessionToSidebar\(([^;]*?)\);/g)]
    .map((m) => m[0].replace(/\s+/g, ' '));
  // Only the rebuild sites take a snapshot; the fresh-spawn sites derive the
  // account from the create result or pass none, so they are excluded by name.
  const restarts = rebuilds.filter((c) => /snapAccount/.test(c));
  assert.strictEqual(restarts.length, 5,
    `expected the five restart rebuilds to carry snapAccount, found ${restarts.length}:\n${rebuilds.join('\n')}`);

  // ENTER: snapAccount is DEFINED at each of those sites, not merely referenced —
  // a free identifier would be a ReferenceError only on the restart itself.
  const defs = [...rendererSrc.matchAll(/const snapAccount = /g)];
  assert.strictEqual(defs.length, 5, 'one definition per rebuild site');

  // Four take it off the row; the args-save path must NOT, because that dialog
  // can CHANGE the account and the row still holds the pre-edit value.
  const fromRow = [...rendererSrc.matchAll(/const snapAccount = accountOfRow\(/g)];
  assert.strictEqual(fromRow.length, 4, 'four snapshot the row');
  assert.match(rendererSrc, /const snapAccount = env === undefined\s*\n\s*\? accountOfRow\(name\)\s*\n\s*: accountFromEnv\(/,
    'the args-save path recomputes from the env it is saving, falling back to the row for a peer save');
});
