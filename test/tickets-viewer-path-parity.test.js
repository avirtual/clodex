'use strict';

// The tickets-viewer plugin CANNOT require core's clodex-paths — §12 of
// plugins/plugin-api.md refuses a require that leaves the plugin's directory,
// and test/plugin-boundary.test.js enforces it. So §4's sanctioned pattern
// applies: the utility is copied in. This test is the enforcement that pattern
// otherwise lacks — the boundary lint says nothing about whether a copy still
// AGREES with its original, and the copy drifts the first time core's hashing
// changes.
//
// This file lives in test/, which is not under the boundary lint, so it may
// require both halves and compare them directly.
//
// Why projectDirFor gets a parity test and the neighbouring `confine` copy does
// not: the failure modes are not alike. A diverged `confine` REJECTS a path —
// loud, and someone sees it. A diverged projectDirFor computes a different hash,
// reads a directory that does not exist, and the viewer renders an EMPTY board.
// That is a false green, and refusing false greens is the whole design of that
// plugin. The test is warranted by the failure mode, not by the copying.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../clodex-paths');
const viewer = require('../plugins/tickets-viewer/engine')._internals;

test('viewer projectDirFor agrees with core clodex-paths byte for byte', () => {
  const home = path.join(os.tmpdir(), 'parity-home');
  const roots = [
    '/Users/someone/projects/wb-wrap-ui',
    '/Users/someone/projects/wb-wrap-ui/',        // trailing slash normalises away
    '/tmp/a b/proj with spaces',
    '/tmp/proj',
    'relative/path/proj',                          // resolved against cwd, both sides
    '/tmp/../tmp/proj',                            // resolve() collapses this
  ];

  // ENTER: the loop below is the reduction. A roots list that somehow arrived
  // empty would make every assertion inside it vacuous, so pin that the case the
  // copy exists to serve is actually in the set.
  assert.ok(roots.includes('/tmp/proj'), 'the roots list must reach the plain case');

  for (const r of roots) {
    assert.strictEqual(viewer.projectDirFor(home, r), core.projectDirFor(home, r),
      `diverged on ${r}`);
  }
});

test('viewer projectDirFor agrees on a root reached through a symlink', () => {
  // THE case a "cleaner" realpath in either copy would break, and the only one
  // where resolve() and realpath() give different answers. The board is written
  // under the hash of the RESOLVED path, never the real one, so a copy that
  // started calling realpath would hash the link target, look in a directory
  // nobody wrote, and render an empty board. A parity test over non-symlinked
  // paths alone would stay green through exactly that change.
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'parity-'));
  const real = path.join(tmp, 'real-project');
  const link = path.join(tmp, 'link-to-project');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);

  const home = path.join(tmp, 'home');
  const viaLink = viewer.projectDirFor(home, link);

  assert.strictEqual(viaLink, core.projectDirFor(home, link), 'copy diverged on a symlinked root');
  // And the property that makes the agreement meaningful rather than two copies
  // being equally wrong: the link is NOT silently followed by either side.
  assert.notStrictEqual(viaLink, core.projectDirFor(home, real),
    'a symlinked root must hash as itself, not as its target — otherwise realpath crept in');

  fs.rmSync(tmp, { recursive: true, force: true });
});
