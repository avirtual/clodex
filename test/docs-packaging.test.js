'use strict';
// docs-packaging.test.js — t38: the DMG must ship `docs/`.
//
// Same allowlist trap as `cli-packaging.test.js`, arrived at from the opposite
// direction. `build.files` lists directories explicitly (`"*.js"` matches ROOT
// files only), and `docs/` was absent — so every shipped DMG through v4.3.1
// contained ZERO files from `docs/`, including the frozen `hostApi "1"` plugin
// contract a third-party author writes against (it lived at `docs/plugin-api.md`
// then; it is `plugins/plugin-api.md` now, shipped under `plugins/**/*`, so BOTH
// patterns are pinned below). Unlike the
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

test('electron-builder SHIPS docs/ and plugins/ — the plugin contract must be in the artifact', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('docs/**/*'),
    'package.json build.files must list docs/**/* or the shipped DMG contains no documentation at all');
  assert.ok(pkg.build.files.includes('plugins/**/*'),
    'package.json build.files must list plugins/**/* — the frozen plugin contract lives there');
});

test('the docs the plugin surfacing points at exist at the paths it names', () => {
  // The links added by t38 are relative paths into this repo. A doc renamed or
  // moved without updating them leaves the launchpad pointing at a 404, which
  // is the same failure as not linking it at all — and harder to notice,
  // because the link looks like it works.
  for (const rel of ['plugins/plugin-api.md', 'plugins/plugin-sources.md']) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} must exist — the plugin docs link to it by this path`);
  }
});

test('every relative link and image in README.md resolves to a path in the repo', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const targets = new Set();
  for (const m of readme.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) targets.add(m[1]);
  for (const m of readme.matchAll(/<img\s[^>]*src="([^"]+)"/g)) targets.add(m[1]);
  const relative = [...targets].filter((t) => !t.startsWith('#') && !/^https?:\/\//.test(t));
  assert.ok(relative.length > 0,
    'the link regex matched nothing — a vacuous pass, not a green README');
  assert.ok(relative.includes('docs/how-to.md'),
    'docs/how-to.md must be among the collected relative links — the ENTER guard that proves the regex reads this README');
  for (const rel of relative) {
    assert.ok(fs.existsSync(path.join(ROOT, rel.replace(/^\.\//, ''))),
      `README.md links ${rel}, which does not exist in the repo`);
  }
});

test('docs/how-to.md carries the desktop shortcuts and the voice renderer caveat', () => {
  const howTo = fs.readFileSync(path.join(ROOT, 'docs/how-to.md'), 'utf8');
  assert.ok(howTo.includes('| `⌘T` | New session |'),
    'the shortcuts table moved out of README.md must land in docs/how-to.md');
  assert.ok(howTo.includes("**Requires the CLI's default renderer.**"),
    'the voice renderer caveat moved out of README.md must land in docs/how-to.md');
});

test('README.md is a product page, not a feature tour', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(!readme.includes('One agent needs a terminal'),
    'the old marketing opener must be gone from README.md');
  assert.ok(readme.split('\n').length < 120,
    `README.md must stay under 120 lines; it is ${readme.split('\n').length}`);
});
