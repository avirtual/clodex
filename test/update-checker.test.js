// Run: node --test
// Covers update-checker's pure semver compare (isNewer). refreshReleases /
// fetchLatestUpdate hit the GitHub API through the module-internal fetchJson, so
// they are network-bound and left to integration — only the offline-testable
// comparison logic is unit-tested here.
const { test } = require('node:test');
const assert = require('node:assert');
const { isNewer } = require('../update-checker');

test('isNewer: strict greater across major / minor / patch', () => {
  assert.strictEqual(isNewer('1.2.3', '1.2.2'), true);
  assert.strictEqual(isNewer('1.3.0', '1.2.9'), true);
  assert.strictEqual(isNewer('2.0.0', '1.9.9'), true);
  assert.strictEqual(isNewer('1.2.3', '1.2.3'), false); // equal is not newer
  assert.strictEqual(isNewer('1.2.2', '1.2.3'), false);
  assert.strictEqual(isNewer('1.2.9', '1.3.0'), false);
});

test('isNewer: tolerates a leading v and a pre-release suffix', () => {
  assert.strictEqual(isNewer('v1.2.4', '1.2.3'), true);
  assert.strictEqual(isNewer('v0.14.0', 'v0.13.9'), true);
  // split on [.-]: only the first three numeric fields count.
  assert.strictEqual(isNewer('1.2.3-beta', '1.2.3'), false);
});

test('isNewer: missing components default to 0', () => {
  assert.strictEqual(isNewer('1', '0.9.9'), true);
  assert.strictEqual(isNewer('1.0', '1'), false);
  assert.strictEqual(isNewer('1.0.1', '1'), true);
});
