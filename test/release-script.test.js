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
const { mkTmpRoot } = require('./lib/tmp-roots');

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
  const dir = mkTmpRoot('clodex-changelog-');
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

test('changelog: the shipped expressions pull the real Unreleased subtitle as the heading carries it, and a body with no release heading', () => {
  const file = path.join(ROOT, 'CHANGELOG.md');
  const heading = fs.readFileSync(file, 'utf-8').match(/^## +\[?Unreleased\]?(.*)$/m);
  assert.ok(heading, 'ENTER: the Unreleased heading is present — the count test above covers how many');
  const written = heading[1].replace(/^[\s—:-]+/, '').trim();
  assert.strictEqual(extractSubtitle(file), written,
    'the sed must read the subtitle the heading actually carries; a release empties it, so "" is the shipped answer');
  const body = extractBody(file);
  assert.deepStrictEqual(body.match(/^## /gm), null, 'the body runs into a release heading');
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

// Quiet mode. A release run through clodex-monitor injected every printed
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
  const dir = mkTmpRoot('clodex-release-log-');
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

test('release --quiet: a notes path containing a space survives the arg filter', () => {
  const { stdout } = withPrologue(['--quiet', 'minor', 'my notes.md'], PROBE);
  assert.match(stdout, /parsed: bump=minor notes=my notes\.md quiet=1/,
    'the filtered array was re-expanded unquoted, so a spaced notes path split into two args');
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
  const dir = mkTmpRoot('clodex-release-die-');
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

// The milestones are the whole point of quiet mode: each of these is a line the
// operator acts on, so wrapping one in `run` or `note` would hide it behind a log
// path on the one run they are watching. Pinned as source shape because the script
// itself runs only at ship time.
test('release: the operator-facing milestones stay on stdout', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  for (const line of [
    'say "built: $DMG"',
    'say "pushed master and $TAG to origin"',
    'say "$(gh release view "$TAG" --json url -q .url)"',
  ]) {
    assert.ok(src.includes(`\n${line}\n`) || src.includes(`\n  ${line}\n`),
      `${line} is no longer emitted through say — a milestone the operator acts on would be buried in the log`);
  }
});

// The release URL reached stdout but never the log, so the log of a successful
// quiet release did not name what it released.
test('release: the release URL reaches the log too, not just stdout', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  assert.match(src, /say "\$\(gh release view "\$TAG" --json url -q \.url\)"/,
    'the URL must go through say — a bare gh invocation bypasses the log entirely');
});

// publish-image.sh owns the registry address and pushes :latest alongside the
// version. Restating the address here means reporting one the release may not
// have published to.
test('release: the image milestone does not restate the registry address', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const m = src.match(/^\s*say "image published: (.*)"$/m);
  assert.ok(m, 'the image publish success milestone is gone — silence is not a result');
  assert.ok(!m[1].includes('ghcr.io'),
    'the registry address is duplicated from publish-image.sh; state the fact, not a second copy');
  assert.match(m[1], /latest/, 'publish-image.sh pushes :latest too — a report naming only the version is incomplete');
});

test('release: the publish step retries a flaky asset upload, clobbering an existing release', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  assert.match(src, /ATTEMPTS=3/,
    'the retry budget is gone — one 500 from GitHub loses the release again');
  assert.match(src, /if run gh release view "\$TAG"/,
    'a retry must ask whether the release already exists; gh release create would fail on the second attempt');
  assert.match(src, /gh release upload "\$TAG" "\$DMG" --clobber/,
    'the existing-release arm must re-upload over a partial or missing asset, not leave it');
  assert.match(src, /die "gh release create failed/,
    'the last failure must still die with the re-run instructions');
});

test('release: the DMG pty probe runs after the build and before anything is committed or tagged', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const build = src.indexOf('run npm run dist:mac');
  const probe = src.indexOf('run bash scripts/dmg-pty-probe.sh "$DMG" || die ');
  const commit = src.indexOf('git commit');
  const tag = src.search(/^\s*git tag "\$TAG"/m);
  assert.ok(build > 0, 'the DMG build step is gone');
  assert.ok(probe > 0, 'the DMG pty probe step is gone — the shipped DMG is never launched before tagging');
  assert.ok(src.includes('step "DMG pty probe"'), 'the probe has no step header');
  assert.ok(probe > build, 'the probe must run on the DMG this release just built');
  assert.ok(commit > 0 && probe < commit, 'the probe must run before the release commit');
  assert.ok(tag > 0 && probe < tag, 'the probe must run before the tag');
});

test('release: the DMG child probe runs right after the pty probe, before anything is committed or tagged', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const pty = src.indexOf('run bash scripts/dmg-pty-probe.sh "$DMG" || die ');
  const child = src.indexOf('run bash scripts/dmg-child-probe.sh "$DMG" || die ');
  const commit = src.indexOf('git commit');
  const tag = src.search(/^\s*git tag "\$TAG"/m);
  assert.ok(child > 0, 'the DMG child probe step is gone — the packaged child dispatch is never proven before tagging');
  assert.ok(src.includes('step "DMG child probe"'), 'the child probe has no step header');
  assert.ok(pty > 0 && child > pty, 'the child probe runs after the pty probe');
  assert.ok(commit > 0 && child < commit, 'the child probe must run before the release commit');
  assert.ok(tag > 0 && child < tag, 'the child probe must run before the tag');
});

test('release: the cloud review launches after the image publish and before Done', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const publish = src.indexOf('run "$(dirname "$0")/publish-image.sh"');
  const review = src.indexOf('if run "$(dirname "$0")/cloud-review.sh" "$PREV_TAG" "$TAG"; then\n  if [ -n "$LOG" ]; then say "$(tail -n 1 "$LOG")"; fi\nelse\n  say "warn: ');
  const done = src.indexOf('step "Done"');
  assert.ok(publish > 0, 'the image publish step is gone');
  assert.ok(review > 0, 'the cloud review launch is gone, no longer non-fatal, or no longer says its last line under --quiet');
  assert.ok(src.includes('step "Launching cloud release review"'), 'the review has no step header');
  assert.ok(review > publish, 'the review launches after the image publish');
  assert.ok(done > 0 && review < done, 'the review launches before Done');
});

test('publish-image: refuses an untagged HEAD and moves :latest only for the newest v* tag', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'publish-image.sh'), 'utf-8');
  assert.match(src, /git describe --exact-match --tags HEAD 2>\/dev\/null[^\n]*\)" = "v\$VERSION" \]/);
  assert.match(src, /die "HEAD is not tagged v\$VERSION — check out the tag first"/);
  assert.match(src, /if \[ "\$\(git tag -l 'v\*' \| sort -V \| tail -1\)" = "v\$VERSION" \]; then\n\s+TAGS\+=\(-t "\$IMAGE:latest"\)/);
  assert.doesNotMatch(src, /^\s+-t "\$IMAGE:latest" \\$/m);
});

const ROLLBACK_FILES = ['package.json', 'package-lock.json', 'CHANGELOG.md', 'cli/deploy/helm/clodex/values.yaml',
  'cli/deploy/helm/clodex/Chart.yaml', 'cli/deploy/clodex-fargate.yaml'];

test('release: an EXIT trap armed after PREV_TAG rolls back all six bumped files unless the commit landed', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const trapLine = src.split('\n').find((l) => /^trap 'release_cleanup [^']*' EXIT$/.test(l));
  assert.ok(trapLine, 'the rollback trap line is gone');
  assert.deepStrictEqual(trapLine.replace(/^trap 'release_cleanup /, '').replace(/' EXIT$/, '').split(' '), ROLLBACK_FILES);
  const prevTag = src.indexOf('PREV_TAG="$(git describe');
  const trap = src.indexOf(trapLine);
  assert.ok(prevTag > 0 && trap > prevTag && trap < src.indexOf('npm version "$BUMP"'), 'the trap must be armed before the bump');
  assert.strictEqual(src.match(/^trap /gm).length, 1, 'a second trap would replace the rollback');
  assert.match(src, /\n  run git commit -am "\$TAG" \|\| die "commit failed"\nfi\nCOMMITTED=1\n/);
  assert.match(src, /if \[ "\$COMMITTED" = 1 \]; then return 0; fi/);
  assert.match(src, /release aborted: version bump and CHANGELOG stamp rolled back/);
});

test('release: a run that dies at the build step leaves the version, CHANGELOG and deploy pins as they were', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const start = src.indexOf('CUR_VERSION="$(node -p');
  const buildLine = 'run npm run dist:mac || die "build failed (try: npx electron-rebuild)"\nfi\n';
  const end = src.indexOf(buildLine);
  assert.ok(start > 0 && end > start, 'the bump-to-build block was not found by its anchors');
  const block = src.slice(start, end + buildLine.length);
  const dir = mkTmpRoot('clodex-release-rollback-');
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf-8' });
  const files = {
    'package.json': '{\n  "name": "x",\n  "version": "1.0.0"\n}\n',
    'package-lock.json': '{\n  "name": "x",\n  "version": "1.0.0"\n}\n',
    'CHANGELOG.md': '# Changelog\n\n## Unreleased\n\n- a change\n\n## 1.0.0 — 2026-01-01\n',
    'cli/deploy/helm/clodex/values.yaml': 'image:\n  tag: "1.0.0"\n',
    'cli/deploy/helm/clodex/Chart.yaml': 'appVersion: "1.0.0"\n',
    'cli/deploy/clodex-fargate.yaml': "Parameters:\n    Default: 'ghcr.io/avirtual/clodex:1.0.0'\n",
  };
  try {
    for (const [f, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), body);
    }
    g('init', '-q');
    g('add', '.');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    const npmStub = 'npm() {\n'
      + '  if [ "$1" = version ]; then\n'
      + '    for f in package.json package-lock.json; do sed -i \'\' \'s/"version": "1.0.0"/"version": "1.0.1"/\' "$f"; done\n'
      + '    echo v1.0.1; return 0\n'
      + '  fi\n'
      + '  return 1\n'
      + '}\n';
    let res;
    try {
      execFileSync('bash', ['-c', `set -euo pipefail\n${PROLOGUE}\n${npmStub}${block}\necho UNREACHED`, '--', 'patch'],
        { cwd: dir, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, CI: '' } });
      res = { status: 0 };
    } catch (e) { res = { status: e.status, stderr: String(e.stderr) }; }
    assert.strictEqual(res.status, 1, 'ENTER: the stubbed run must die at the build step');
    assert.match(res.stderr, /build failed/);
    assert.match(res.stderr, /release aborted: version bump and CHANGELOG stamp rolled back/);
    for (const [f, body] of Object.entries(files)) assert.strictEqual(fs.readFileSync(path.join(dir, f), 'utf8'), body, f);
    assert.strictEqual(g('status', '--porcelain'), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const REAL_GIT = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim();

const STUB_SCRIPT = '#!/usr/bin/env bash\necho "$(basename "$0") $*" >> "$FAKE_STATE/calls"\n';
const NPM_STUB = [
  '#!/usr/bin/env bash',
  'echo "npm $*" >> "$FAKE_STATE/calls"',
  'case "$1 $2" in',
  '  "version patch") node -e \'const fs=require("fs");let v;for(const f of ["package.json","package-lock.json"]){const j=JSON.parse(fs.readFileSync(f));const p=j.version.split(".");p[2]=+p[2]+1;v=j.version=p.join(".");fs.writeFileSync(f,JSON.stringify(j,null,2)+"\\n")}console.log("v"+v)\' ;;',
  '  "run build:web") exit 0 ;;',
  '  "run dist:mac") if [ -n "${FAKE_BUILD_FAIL:-}" ]; then exit 1; fi; v="$(node -p "require(\'./package.json\').version")"; mkdir -p dist; touch "dist/Clodex-$v-arm64.dmg" ;;',
  '  *) exit 1 ;;',
  'esac',
  '',
].join('\n');
const GH_STUB = [
  '#!/usr/bin/env bash',
  'echo "gh $*" >> "$FAKE_STATE/calls"',
  'case "$1 $2" in',
  '  "auth status") exit 0 ;;',
  '  "release view") if [ -f "$FAKE_STATE/released-$3" ]; then echo "https://example.invalid/$3"; exit 0; fi; exit 1 ;;',
  '  "release create")',
  '    prev=""; for a in "$@"; do if [ "$prev" = --notes-file ]; then cp "$a" "$FAKE_STATE/notes-seen"; fi; prev="$a"; done',
  '    if [ "${FAKE_GH_CREATE:-ok}" = fail ]; then exit 1; fi',
  '    touch "$FAKE_STATE/released-$3"; exit 0 ;;',
  '  "release upload") exit 0 ;;',
  'esac',
  'exit 1',
  '',
].join('\n');
const GIT_STUB = [
  '#!/usr/bin/env bash',
  'if [ "$1" = push ]; then',
  '  echo "git $*" >> "$FAKE_STATE/calls"',
  '  if [ -n "${FAKE_PUSH_FAIL:-}" ]; then exit 1; fi',
  'fi',
  `exec ${JSON.stringify(REAL_GIT)} "$@"`,
  '',
].join('\n');

function releaseFixture() {
  const base = mkTmpRoot('clodex-release-e2e-');
  const repo = path.join(base, 'repo');
  const origin = path.join(base, 'origin.git');
  const bin = path.join(base, 'bin');
  const home = path.join(base, 'home');
  const state = path.join(base, 'state');
  for (const d of [repo, bin, home, state]) fs.mkdirSync(d, { recursive: true });
  const pkg = '{\n  "name": "x",\n  "version": "1.0.0"\n}\n';
  const files = {
    'package.json': pkg,
    'package-lock.json': pkg,
    'CHANGELOG.md': '# Changelog\n\n## Unreleased — Theme\n\n- the pending change\n\n## 1.0.0 — 2026-01-01\n',
    'cli/deploy/helm/clodex/values.yaml': 'image:\n  tag: "1.0.0"\n',
    'cli/deploy/helm/clodex/Chart.yaml': 'appVersion: "1.0.0"\n',
    'cli/deploy/clodex-fargate.yaml': "Parameters:\n    Default: 'ghcr.io/avirtual/clodex:1.0.0'\n",
    '.gitignore': 'dist/\n',
    'scripts/electron-smoke.js': '',
    'scripts/renderer-smoke.js': '',
    'scripts/release.sh': fs.readFileSync(SCRIPT, 'utf-8'),
  };
  for (const s of ['dmg-pty-probe.sh', 'dmg-child-probe.sh', 'prune-releases.sh', 'publish-image.sh', 'cloud-review.sh']) {
    files[`scripts/${s}`] = STUB_SCRIPT;
  }
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), body, { mode: 0o755 });
  }
  for (const [name, body] of [['npm', NPM_STUB], ['gh', GH_STUB], ['git', GIT_STUB]]) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }
  const g = (...a) => execFileSync(REAL_GIT, a, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' });
  execFileSync(REAL_GIT, ['init', '-q', '--bare', origin]);
  g('init', '-q', '-b', 'master');
  g('config', 'user.name', 't');
  g('config', 'user.email', 't@t');
  g('add', '.');
  g('commit', '-qm', 'base');
  g('tag', 'v1.0.0');
  g('remote', 'add', 'origin', origin);
  g('push', '-q', '-u', 'origin', 'master', 'v1.0.0');
  fs.writeFileSync(path.join(state, 'released-v1.0.0'), '');
  const run = (env = {}) => {
    fs.rmSync(path.join(state, 'calls'), { force: true });
    let res;
    try {
      const stdout = execFileSync('bash', ['scripts/release.sh', 'patch'], {
        cwd: repo, encoding: 'utf-8', stdio: 'pipe',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_STATE: state,
          CI: '', RELEASE_RETRY_SLEEP: '0', ...env },
      });
      res = { status: 0, stdout, stderr: '' };
    } catch (e) { res = { status: e.status, stdout: String(e.stdout), stderr: String(e.stderr) }; }
    const callsFile = path.join(state, 'calls');
    res.calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf-8') : '';
    return res;
  };
  return {
    repo, home, state, run, g,
    kept: path.join(home, '.clodex', 'logs', 'release-notes-v1.0.1.md'),
    version: () => JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf-8')).version,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

test('release e2e: gh failing 3x keeps the notes, publishes the image, and names the three follow-ups', () => {
  const fx = releaseFixture();
  try {
    const res = fx.run({ FAKE_GH_CREATE: 'fail' });
    assert.notStrictEqual(res.status, 0, res.stdout + res.stderr);
    assert.strictEqual((res.calls.match(/^gh release create /gm) || []).length, 3, res.calls);
    assert.ok(fs.existsSync(fx.kept), 'the notes must survive the EXIT trap once the tag is pushed');
    assert.match(fs.readFileSync(fx.kept, 'utf-8'), /- the pending change/);
    assert.ok(res.stderr.includes(
      `gh release create v1.0.1 dist/Clodex-1.0.1-arm64.dmg --title "v1.0.1 — Theme" --notes-file ${fx.kept}`), res.stderr);
    assert.ok(res.stderr.includes('scripts/publish-image.sh 1.0.1'), res.stderr);
    assert.ok(res.stderr.includes('scripts/cloud-review.sh v1.0.0 v1.0.1'), res.stderr);
    assert.match(res.calls, /^publish-image\.sh 1\.0\.1$/m, 'the image depends only on the pushed tag');
    assert.doesNotMatch(res.calls, /^prune-releases\.sh/m);
  } finally { fx.cleanup(); }
});

test('release e2e: a failed push dies naming git push origin master <tag>', () => {
  const fx = releaseFixture();
  try {
    const res = fx.run({ FAKE_PUSH_FAIL: '1' });
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.match(res.calls, /^git push origin master$/m, 'ENTER: the push was attempted');
    assert.ok(res.stderr.includes('git push origin master v1.0.1'), res.stderr);
    assert.ok(res.stderr.includes('scripts/publish-image.sh 1.0.1'), res.stderr);
  } finally { fx.cleanup(); }
});

test('release e2e: a re-run after a failed push resumes from the local tag without bumping again', () => {
  const fx = releaseFixture();
  try {
    assert.strictEqual(fx.run({ FAKE_PUSH_FAIL: '1' }).status, 1, 'ENTER: the first run dies at the push');
    const res = fx.run();
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /resuming release v1\.0\.1 from the push step/);
    assert.strictEqual(fx.version(), '1.0.1');
    assert.doesNotMatch(res.calls, /^npm version/m);
    assert.doesNotMatch(res.calls, /^npm run dist:mac/m, 'the DMG of the failed run is reused');
    assert.match(res.calls, /^git push origin v1\.0\.1$/m);
    assert.match(res.calls, /^gh release create v1\.0\.1 /m);
    assert.strictEqual(fx.g('tag', '--points-at', 'HEAD').trim(), 'v1.0.1');
  } finally { fx.cleanup(); }
});

test('release e2e: a resume with no DMG left in dist/ rebuilds it', () => {
  const fx = releaseFixture();
  try {
    assert.strictEqual(fx.run({ FAKE_PUSH_FAIL: '1' }).status, 1, 'ENTER: the first run dies at the push');
    fs.rmSync(path.join(fx.repo, 'dist'), { recursive: true, force: true });
    const res = fx.run();
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /resuming release v1\.0\.1 from the push step/);
    assert.match(res.calls, /^npm run dist:mac/m, 'the missing DMG is rebuilt');
    assert.match(res.calls, /^gh release create v1\.0\.1 dist\/Clodex-1\.0\.1-arm64\.dmg /m);
  } finally { fx.cleanup(); }
});

test('release e2e: tag on origin with no gh release resumes the gh step with the kept notes', () => {
  const fx = releaseFixture();
  try {
    assert.notStrictEqual(fx.run({ FAKE_GH_CREATE: 'fail' }).status, 0, 'ENTER: the first run dies at gh');
    fs.appendFileSync(fx.kept, '\nKEPT-MARKER\n');
    const res = fx.run();
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /resuming release v1\.0\.1 from the gh release step/);
    assert.strictEqual(fx.version(), '1.0.1');
    assert.doesNotMatch(res.calls, /^npm version/m);
    assert.match(res.calls, /^gh release create v1\.0\.1 dist\/Clodex-1\.0\.1-arm64\.dmg --title v1\.0\.1 — Theme /m);
    assert.match(fs.readFileSync(path.join(fx.state, 'notes-seen'), 'utf-8'), /KEPT-MARKER/);
  } finally { fx.cleanup(); }
});

test('release e2e: a gh resume with no kept notes publishes the stamped CHANGELOG section', () => {
  const fx = releaseFixture();
  try {
    assert.notStrictEqual(fx.run({ FAKE_GH_CREATE: 'fail' }).status, 0, 'ENTER: the first run dies at gh');
    fs.rmSync(fx.kept);
    const res = fx.run();
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    const seen = fs.readFileSync(path.join(fx.state, 'notes-seen'), 'utf-8');
    assert.match(seen, /- the pending change/);
    assert.doesNotMatch(seen, /^## /m);
  } finally { fx.cleanup(); }
});

test('release e2e: a resume beside a stale older DMG hands gh the current version\'s DMG', () => {
  const fx = releaseFixture();
  try {
    assert.strictEqual(fx.run({ FAKE_PUSH_FAIL: '1' }).status, 1, 'ENTER: the first run dies at the push');
    fs.writeFileSync(path.join(fx.repo, 'dist', 'Clodex-1.0.0-arm64.dmg'), '');
    const res = fx.run();
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.calls, /^npm run dist:mac/m, 'ENTER: the 1.0.1 DMG was reused');
    assert.match(res.calls, /^gh release create v1\.0\.1 dist\/Clodex-1\.0\.1-arm64\.dmg /m, res.calls);
  } finally { fx.cleanup(); }
});

test('release e2e: a gh resume that dies before the commit step does not claim a rollback', () => {
  const fx = releaseFixture();
  try {
    assert.notStrictEqual(fx.run({ FAKE_GH_CREATE: 'fail' }).status, 0, 'ENTER: the first run dies at gh');
    fs.rmSync(path.join(fx.repo, 'dist'), { recursive: true, force: true });
    const res = fx.run({ FAKE_GH_CREATE: 'fail', FAKE_BUILD_FAIL: '1' });
    assert.notStrictEqual(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /resuming release v1\.0\.1 from the gh release step/, 'ENTER: the run resumed');
    assert.match(res.stdout + res.stderr, /build failed/, 'ENTER: and died at the build, before the commit step');
    assert.doesNotMatch(res.stderr, /rolled back/);
  } finally { fx.cleanup(); }
});

test('release e2e: a notes copy that cannot be kept dies naming the kept-notes path', () => {
  const fx = releaseFixture();
  const logs = path.join(fx.home, '.clodex', 'logs');
  try {
    fs.mkdirSync(logs, { recursive: true });
    fs.chmodSync(logs, 0o555);
    assert.throws(() => fs.writeFileSync(path.join(logs, 'probe'), ''), 'ENTER: the logs dir refuses a write');
    const res = fx.run();
    assert.notStrictEqual(res.status, 0, res.stdout + res.stderr);
    assert.ok((res.stdout + res.stderr).includes(`could not keep the notes at ${fx.kept}`), res.stdout + res.stderr);
    assert.doesNotMatch(res.calls, /^gh release create /m);
  } finally { fs.chmodSync(logs, 0o755); fx.cleanup(); }
});
