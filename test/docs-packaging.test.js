'use strict';
// docs-packaging.test.js — t38: the DMG must ship `docs/`.
//
// Same allowlist trap as `cli-packaging.test.js`, arrived at from the opposite
// direction. `build.files` lists directories explicitly (`"*.js"` matches ROOT
// files only), and `docs/` was absent — so every shipped DMG through v4.3.1
// contained ZERO files from `docs/`, including `docs/plugin-api.md`, the frozen
// `hostApi "1"` contract a third-party plugin author writes against. Unlike the
// `cli/` case this threw nothing and broke nothing: an absent doc has no
// MODULE_NOT_FOUND to announce it, which is why it survived four phases of
// plugin work.
//
// This test is NOT the real check — reading `build.files` tells you the config,
// not the artifact. The artifact check is, on a real build:
//
//   npx asar list dist/mac-arm64/Clodex.app/Contents/Resources/app.asar | grep '^/docs/'
//
// (trailing slash: a bare `^/docs` would also match a root file starting
// "docs"). A test must not depend on a built DMG, so the config pin is the gate
// and the asar list is the reasoning.
//
// What this test does NOT claim: shipping the files inside `app.asar` does not
// make them reachable by a user. The asar is one archive, not a browsable
// directory, and nothing in the UI links to a doc. This pins artifact
// completeness — the precondition for any in-app docs affordance — and the
// README links are what a downloaded-DMG user actually follows today.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

test('electron-builder SHIPS docs/ — the plugin contract must be in the artifact', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('docs/**/*'),
    'package.json build.files must list docs/**/* or the shipped DMG contains no documentation at all');
});

test('the docs the plugin surfacing points at exist at the paths it names', () => {
  // The links added by t38 are relative paths into this repo. A doc renamed or
  // moved without updating them leaves the launchpad pointing at a 404, which
  // is the same failure as not linking it at all — and harder to notice,
  // because the link looks like it works.
  for (const rel of ['docs/plugin-api.md', 'docs/plugin-sources.md']) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} must exist — the plugin docs link to it by this path`);
  }
});
