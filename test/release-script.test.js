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

// Quiet mode (t608). A release run through clodex-monitor injected every printed
// line as a separate message — each one an API round trip — so the script gained
// a mode that keeps milestones on stdout and routes the verbose middle to a log.
// These pin the SHAPE of that routing, since the script itself runs only at ship
// time: the prologue is extracted and exercised, so a helper that stops honouring
// the flag reds here rather than during a release.
const PROLOGUE = (() => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const m = src.match(/^# --- args -+\n([\s\S]*?\nif \[ -n "\$LOG" \]; then say [^\n]*\n)/m);
  assert.ok(m, 'the arg/logging prologue was not found in release.sh — quiet mode was restructured '
    + 'and these tests are no longer pinning the code that actually runs');
  return m[1];
})();

// Runs the real prologue, then whatever probe lines the caller adds, and reports
// what reached stdout versus what reached the log.
function withPrologue(argv, probe, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-release-log-'));
  const log = path.join(dir, 'verbose.log');
  try {
    const stdout = execFileSync('bash', ['-c', `set -euo pipefail\n${PROLOGUE}\n${probe}`, '--', ...argv],
      { encoding: 'utf-8', env: { ...process.env, CI: '', RELEASE_LOG: log, ...env } });
    return { stdout, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : null };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const PROBE = [
  'say "RELEASE-URL"',
  'note "PREVIOUS-TAG"',
  'step "BUILDING"',
  'run echo "BUILD-OUTPUT"',
  'echo "parsed: bump=$BUMP notes=$NOTES_FILE quiet=$QUIET"',
].join('\n');

test('release --quiet: milestones on stdout, verbose middle in the log', () => {
  const { stdout, log } = withPrologue(['--quiet', 'minor'], PROBE);
  assert.match(stdout, /RELEASE-URL/,
    'the release URL is a milestone — quieting it leaves the operator with nothing to open');
  for (const hidden of ['PREVIOUS-TAG', 'BUILDING', 'BUILD-OUTPUT']) {
    assert.ok(!stdout.includes(hidden), `${hidden} must not reach stdout in quiet mode`);
    assert.ok(log.includes(hidden), `${hidden} must reach the log — quiet must not mean discarded`);
  }
});

test('release --quiet: the flag does not displace the positional bump and notes args', () => {
  for (const argv of [['--quiet', 'minor', 'n.md'], ['minor', '--quiet', 'n.md'], ['minor', 'n.md', '-q']]) {
    const { stdout } = withPrologue(argv, PROBE);
    assert.match(stdout, /parsed: bump=minor notes=n\.md quiet=1/,
      `${argv.join(' ')}: the flag was consumed as a positional, so the release would bump the wrong thing`);
  }
});

test('release: default (no flag) behaviour is unchanged — everything on stdout, no log', () => {
  const { stdout, log } = withPrologue(['patch'], PROBE);
  for (const shown of ['RELEASE-URL', 'PREVIOUS-TAG', 'BUILDING', 'BUILD-OUTPUT']) {
    assert.ok(stdout.includes(shown), `${shown} must still print when the flag is absent`);
  }
  assert.match(stdout, /parsed: bump=patch notes= quiet=0/);
  assert.strictEqual(log, null, 'no log file is created for a verbose run');
});

test('release: a non-empty CI forces quiet without the flag', () => {
  const { stdout, log } = withPrologue(['patch'], PROBE, { CI: '1' });
  assert.match(stdout, /parsed: .*quiet=1/);
  assert.ok(!stdout.includes('BUILD-OUTPUT'), 'CI runs must not stream child output');
  assert.ok(log.includes('BUILD-OUTPUT'));
});

// The log names the failure that produced it, so quiet mode must not swallow the
// one message the operator needs, nor make them guess where the detail went.
test('release --quiet: die() prints the message AND the log path, and exits nonzero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-release-die-'));
  const log = path.join(dir, 'verbose.log');
  try {
    let status = 0, stderr = '';
    try {
      execFileSync('bash', ['-c', `set -euo pipefail\n${PROLOGUE}\ndie "build failed"`, '--', '--quiet', 'minor'],
        { encoding: 'utf-8', env: { ...process.env, CI: '', RELEASE_LOG: log }, stdio: 'pipe' });
    } catch (e) { status = e.status; stderr = String(e.stderr); }
    assert.notStrictEqual(status, 0, 'die must exit nonzero or a failed release reads as a success');
    assert.match(stderr, /build failed/, 'the failure message must survive quiet mode');
    assert.ok(stderr.includes(log), 'die must name the log path — it is the only record of what failed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Chosen over the suggested dist/release-<version>.log for two reasons, both
// load-bearing: `rm -rf dist` at the build step would delete everything logged
// before it, and the version is not known until the bump, which is after both
// smoke tests. A log that vanishes on a build failure is empty exactly when it
// is the only evidence.
test('release --quiet: the log lives outside dist/, which the build step rm -rf s', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const m = src.match(/^\s*LOG="\$\{RELEASE_LOG:-(.*)\}"$/m);
  assert.ok(m, 'the log path assignment was not found — quiet mode no longer takes a RELEASE_LOG override');
  assert.ok(!m[1].includes('dist'), 'the log must not sit under dist/ — the build step deletes it');
  assert.match(src, /rm -rf dist/, 'the rm this test exists to avoid is still in the script');
  assert.ok(!/trap '[^']*\$LOG/.test(src),
    'the log must not be on the EXIT trap — deleting it on the failure path destroys the evidence');
});
