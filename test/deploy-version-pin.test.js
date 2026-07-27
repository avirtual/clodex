'use strict';
// deploy-version-pin.test.js — t53: the packaged deploy assets name an image
// version, and it must be THIS app's version.
//
// `cli/deploy/` ships one reviewable asset per deploy flavor, and each names
// the container image it will run. The release script publishes the image AT
// the new version (publish-image.sh) but never touched the assets that name it,
// so the three pins drifted from the app and from each other: a 4.5.0 app
// shipped a helm chart pinning 4.1.0 and an appVersion of 3.5.3. The
// consequences are live, not cosmetic — a fresh `clodexctl deploy helm <name>`
// deploys a three-version-old node, and a re-run REVERTS an operator's
// hand-upgraded cluster back to it.
//
// This is the same defect one layer up from the one release.sh already records
// at :142-144: publishing the image by hand let ghcr's `:latest` drift three
// versions behind, "undiagnosable from a deployed box". The fix has the same
// shape — fold it into the release script — and this file is what keeps it
// folded in. Note what that means: a release that stops syncing the assets
// bumps package.json alone, and these assertions fail on the very next run.
// They are not decoration on a script edit; they are the thing that notices.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The three pins, each with the anchored pattern that identifies it. These
// patterns are the SAME anchors the sync script edits by, deliberately: if an
// asset is restructured so its anchor no longer matches, both the sync and this
// test stop finding it, and the test says so rather than passing on a file it
// silently failed to check.
const PINS = [
  {
    file: 'cli/deploy/helm/clodex/values.yaml',
    what: 'image.tag — the chart deploys this image',
    re: /^  tag: "([^"]+)"$/m,
  },
  {
    file: 'cli/deploy/helm/clodex/Chart.yaml',
    what: 'appVersion — the app version this chart deploys',
    re: /^appVersion: "([^"]+)"$/m,
  },
  {
    file: 'cli/deploy/clodex-fargate.yaml',
    what: 'ImageUri default — the image the CF stack runs',
    re: /^    Default: 'ghcr\.io\/avirtual\/clodex:([^']+)'$/m,
  },
];

for (const pin of PINS) {
  test(`deploy asset pins the app version: ${pin.file}`, () => {
    const m = pin.re.exec(read(pin.file));
    assert.ok(m, `${pin.file}: no line matched the version anchor — the asset was restructured, so the release sync is no longer editing anything here and this test can no longer see it`);
    assert.strictEqual(m[1], APP_VERSION,
      `${pin.file} (${pin.what}) pins ${m[1]} but this app is ${APP_VERSION} — deploying from this checkout runs a ${m[1]} node, and re-running the deploy would revert an operator's hand-upgraded one back to it`);
  });
}

// The chart's OWN version is deliberately NOT in the list above. Helm has two
// fields and they answer different questions: `appVersion` is "which
// application does this deploy" (tracks the release), `version` is "which
// revision of this chart is it" (moves when the chart's structure changes, and
// is what helm resolves for upgrades/rollbacks). Tying the chart version to the
// app release would claim a structural change on every patch and make helm's
// own history meaningless. Pinned so the next person to add a sync line has to
// decide rather than sweep it in with a version-shaped sed.
test('the helm CHART version is hand-managed, not tied to the app release', () => {
  const m = /^version: (\S+)$/m.exec(read('cli/deploy/helm/clodex/Chart.yaml'));
  assert.ok(m, 'Chart.yaml has no chart version line');
  assert.notStrictEqual(m[1], APP_VERSION,
    'the chart version now tracks the app version — if that is intended, delete this test and say why; helm reads it as "the chart structure changed", which a patch release does not do');
});
