'use strict';
// cli-packaging.test.js — t32 step 0: the DMG must ship `cli/`.
//
// The app imports `cli/src/transport.js` so a peer can dial cloud transports
// without a second implementation of the dialing. `build.files` is an
// ALLOWLIST — `"*.js"` matches ROOT files only, not subdirectories — so an
// unlisted `cli/` resolves fine from a checkout, passes this whole suite,
// passes `npm start`, and throws MODULE_NOT_FOUND in the shipped DMG. Green in
// dev, fatal in release, and invisible to every test that runs from a checkout.
// That is precisely why it is pinned here rather than trusted to the config
// being read by whoever next edits it.
//
// This test is NOT the real check — reading `build.files` tells you the config,
// not the artifact. The artifact check is, on a real build:
//
//   npx asar list dist/mac-arm64/Clodex.app/Contents/Resources/app.asar | grep '^/cli/'
//
// (trailing slash: a bare `^/cli` also matches the app's own root
// `cli-hooks.js`, which is a different file). A test must not depend on a built
// DMG, so the config pin is the gate and the asar list is the reasoning.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('electron-builder SHIPS cli/ — the app imports cli/src/transport.js', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('cli/**/*'),
    'package.json build.files must list cli/**/* or the packaged app throws MODULE_NOT_FOUND on the transport import');
});

test('the cli/ README states the SHIPPING position, not the stale one', () => {
  // cli/README.md:62 used to assert the opposite ("does not include cli/") as a
  // deliberate shipping position. Reversing the glob without reversing the
  // prose leaves a future reader with a documented rule that contradicts the
  // build — the same class of stale-assertion bug the position itself records.
  const readme = fs.readFileSync(path.join(__dirname, '..', 'cli', 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /packaged DMG does \*\*not\*\* include/,
    'the stale "DMG does not include cli/" assertion must not survive the packaging change');
  assert.match(readme, /DOES ship `cli\/`/,
    'the README must state the new position');
  assert.match(readme, /MODULE_NOT_FOUND/,
    'and the reason it changed, so a future reader finds reasoning rather than a bare reversal');
});
