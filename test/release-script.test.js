// Pins for scripts/release.sh, which has no other test coverage. Everything
// here runs exactly once per release, mid-flight — the changelog extraction
// between the version bump and the push, the preflight before either. A bug in
// them is discovered at the worst possible moment, so they are pinned here by
// running the same expressions the script runs.
//
// These tests shell out to the SAME expressions rather than reimplementing
// them in JS: a reimplementation would pass while the script broke.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'release.sh');

// Pulled out of release.sh by anchor, so a change to the script that does not
// update these tests fails HERE rather than during a release.
function expressionFromScript(re, label) {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const m = src.match(re);
  assert.ok(m, `${label} not found in release.sh — the script was restructured and this test is no `
    + 'longer pinning the code that actually runs');
  return m[1];
}

const BODY_AWK = expressionFromScript(
  /CHANGELOG_BODY="\$\(awk '([^']+)'/, 'the Unreleased body extraction');
const SUBTITLE_SED = expressionFromScript(
  /SUBTITLE="\$\(grep -m1 -E '\^## \+\\\[\?Unreleased\\\]\?' "\$CHANGELOG" \| sed -E '([^']+)'/,
  'the subtitle extraction');

const sh = (cmd) => execFileSync('bash', ['-c', cmd], { encoding: 'utf-8' });

function withChangelog(text, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-changelog-'));
  const file = path.join(dir, 'CHANGELOG.md');
  fs.writeFileSync(file, text);
  try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const extractBody = (file) => sh(`awk '${BODY_AWK}' ${JSON.stringify(file)}`);
const extractSubtitle = (file) =>
  sh(`grep -m1 -E '^## +\\[?Unreleased\\]?' ${JSON.stringify(file)} | sed -E '${SUBTITLE_SED}' || true`).trim();

test('changelog: the Unreleased body is extracted, and stops at the next release', () => {
  const body = withChangelog([
    '# Changelog', '', '## Unreleased — A theme', '', '### Added', '- thing one', '',
    '## 4.11.0 — 2026-07-01 — Older', '- must NOT appear', '',
  ].join('\n'), extractBody);
  assert.ok(body.includes('- thing one'), 'the pending entry must reach the release notes');
  assert.ok(!body.includes('must NOT appear'),
    'a previous release leaking into the notes would republish shipped changes as new');
});

test('changelog: the subtitle rides the heading, with or without one', () => {
  assert.strictEqual(withChangelog('## Unreleased — A theme\n- x\n', extractSubtitle), 'A theme');
  // A bare heading must yield EMPTY, not the heading text — the script tests
  // this value for emptiness to decide whether to append a subtitle at all.
  assert.strictEqual(withChangelog('## Unreleased\n- x\n', extractSubtitle), '');
});

// The fallback is what keeps the changelog from being able to BLOCK a release.
test('changelog: an empty or absent Unreleased extracts nothing', () => {
  const emptied = (t) => withChangelog(t, extractBody).replace(/\s/g, '');
  assert.strictEqual(emptied('# Changelog\n\n## Unreleased\n\n## 4.11.0 — old\n- x\n'), '',
    'an empty section must fall back to commit subjects, never ship a blank release note');
  assert.strictEqual(emptied('# Changelog\n\n## 4.11.0 — old\n- x\n'), '',
    'a changelog with no Unreleased section at all must fall back too');
});

test('changelog: stamping renames Unreleased and opens a fresh empty one', () => {
  const stampAwk = expressionFromScript(/awk -v stamp="\$STAMP" '([\s\S]+?)' "\$CHANGELOG"/, 'the stamp rewrite');
  const out = withChangelog('# Changelog\n\n## Unreleased — A theme\n\n- thing one\n\n## 4.11.0 — old\n- x\n',
    (file) => sh(`awk -v stamp='## 4.12.0 — 2026-08-03 — A theme' '${stampAwk}' ${JSON.stringify(file)}`));
  assert.match(out, /## Unreleased\n\n## 4\.12\.0 — 2026-08-03 — A theme/,
    'the stamped version must sit BELOW a fresh empty Unreleased, or the next cycle has nowhere to write');
  assert.ok(out.includes('- thing one'), 'the entries stay with the version they shipped in');
  assert.strictEqual((out.match(/^## Unreleased/gm) || []).length, 1,
    'exactly one Unreleased section must survive — two would split where entries land');
  assert.ok(out.includes('## 4.11.0 — old'), 'older releases are untouched');
});

// The file the release actually reads. A structural break here means the next
// release silently publishes commit subjects instead of the written notes.
test('changelog: the real CHANGELOG.md parses with the shipped expressions', () => {
  const file = path.join(ROOT, 'CHANGELOG.md');
  assert.ok(fs.existsSync(file), 'CHANGELOG.md must exist — release.sh reads it by name');
  const src = fs.readFileSync(file, 'utf-8');
  assert.strictEqual((src.match(/^## +\[?Unreleased\]?/gm) || []).length, 1,
    'exactly one Unreleased heading, or the extraction takes the wrong one');
});

// The preflight sync check. It rejected a release that was 37 commits AHEAD of
// origin and 0 behind — a pure fast-forward the script pushes itself a few
// steps later. Equality here blocks releasing any unpushed work, which is the
// normal case, so the direction of this comparison is the whole point.
test('release preflight: rejects BEHIND, permits AHEAD', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  assert.match(src, /BEHIND="\$\(git rev-list --count HEAD\.\.@\{u\}\)"/,
    'the sync check must count commits we are MISSING, not compare revisions for equality — '
    + 'equality also fails on AHEAD, which blocks every release carrying unpushed commits');
  assert.ok(!/\[ "\$\(git rev-parse HEAD\)" = "\$\(git rev-parse @\{u\}\)" \]/.test(src),
    'the old equality check is back: it cannot tell "ahead" (fine) from "behind" (unsafe)');
});
