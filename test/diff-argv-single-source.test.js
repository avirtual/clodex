'use strict';
// Run: node --test test/diff-argv-single-source.test.js
//
// t472 r8 — `diffText`'s git flags are quoted back to the lead in prose, and the
// copy went stale.
//
// `git-worktree.js`'s `diffText` runs `git diff` with mandatory flags: `--text`,
// so one NUL byte cannot collapse a reviewer's diff to "Binary files differ",
// and `--no-ext-diff`, so an external driver cannot replace git's output with
// its own. `team-tickets.js`'s CHECK 4 quotes that command back to the lead in
// two `fail(...)` messages, so a lead whose diff could not be written can re-run
// it by hand.
//
// That quote is a COPY, and it went stale exactly once already: r6 added
// `--no-ext-diff` to the leaf and the messages kept saying `git diff --text
// <base>..<branch>`. A lead re-running the quoted line under a driver config
// gets driver output back and concludes something false about the diff the
// reviewer actually read.
//
// Measured before this file existed: reverting both messages to the stale
// wording left the suite 212/0 GREEN. Nothing asserted that text. The guard was
// a pair of comments — and a comment is a statement, which is the thing this
// ticket spent seven rounds establishing you cannot rely on.
//
// MODELLED ON test/hold-recovery-single-source.test.js, deliberately and not by
// coincidence — same genre, three properties taken from it:
//
//   - it reads SOURCE, so it is red on a copy that does not agree yet;
//   - it derives BOTH sides from source rather than carrying its own flag list.
//     A test hardcoding `['--text', '--no-ext-diff']` would be a THIRD copy and
//     would make the problem worse: it would go green the day someone updated
//     the leaf and the test together while the messages rotted. There is no
//     literal flag list anywhere below, and adding one is the one edit this file
//     must never receive;
//   - the extractors run against SYNTHETIC FIXTURES FIRST, because an extractor
//     exercised only against the real files proves nothing about what it would
//     catch. A regex that matches nothing is green on a clean file forever, and
//     this file's whole value is being red on a file that is not clean yet.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ── the extractors ─────────────────────────────────────────────────────────
// Both take SOURCE TEXT, never a filename, so the fixtures below can exercise
// them on synthetic input. An extractor that could only read the real file
// could only be tested by trusting it.

// The leaf's argv: the `git(repo, ['diff', …])` call inside `diffText`. Scoped
// to that function rather than the file — `git-worktree.js` runs `git` in a
// dozen places, and matching the first `['diff'` anywhere would silently start
// measuring a different call the day one is added above it.
function leafDiffFlags(src) {
  const at = src.indexOf('async function diffText(');
  if (at < 0) return null;
  const body = src.slice(at, src.indexOf('\n}\n', at));
  // Anchored on `['diff'`, not on `git(repo, [`. `diffText` runs `rev-parse
  // --verify --quiet` BEFORE its diff, so the looser anchor reads that call's
  // flags instead — measured, not hypothesised: the fixture below caught it.
  const m = body.match(/git\(repo,\s*\[\s*'diff'\s*,([^\]]*)\]/);
  if (!m) return null;
  const flags = [];
  for (const raw of m[1].split(',')) {
    const tok = raw.trim();
    if (!tok.startsWith("'") && !tok.startsWith('"')) continue;   // skip `${base}..${head}` etc
    const lit = tok.slice(1, -1);
    if (lit.startsWith('--')) flags.push(lit);
  }
  return flags;
}

// The flags as QUOTED in CHECK 4's messages. Reads every `git diff …` string in
// the file rather than the two known sites: a third message added later is
// exactly the drift this file exists to catch, and pinning by line number would
// miss it while looking rigorous.
function quotedDiffFlags(src) {
  const out = [];
  for (const m of src.matchAll(/`git diff ((?:--[\w-]+\s+)*)\$\{/g)) {
    out.push(m[1].trim().split(/\s+/).filter(Boolean));
  }
  return out;
}

// ── the extractors, exercised against synthetic input FIRST ────────────────

test('FIXTURES: the leaf extractor reads the flags out of diffText, and only diffText', () => {
  const fake = [
    "async function other(cwd) {",
    "  const r = await git(repo, ['diff', '--decoy', `${a}..${b}`]);",
    "  return r;",
    "}",
    "async function diffText(cwd, base, head, { maxBuffer = 1 } = {}) {",
    "  const v = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);",
    "  const r = await git(repo, ['diff', '--text', '--no-ext-diff', `${base}..${head}`], { maxBuffer });",
    "  return { ok: true, text: r.stdout };",
    "}",
  ].join('\n');
  assert.deepStrictEqual(leafDiffFlags(fake), ['--text', '--no-ext-diff'],
    'the flags come out in order');
  // The decoy is the point: a `['diff', …]` in a NEIGHBOURING function must not
  // be what this measures. Without the scoping, `--decoy` wins by being first.
  assert.ok(!leafDiffFlags(fake).includes('--decoy'), 'a sibling git() call is not read');
  // `--verify`/`--quiet` sit inside diffText on a rev-parse call that runs BEFORE
  // the diff. They are flags and they are in range, so only the `['diff'` anchor
  // excludes them — and this is not hypothetical: the first version of this
  // extractor anchored on `git(repo, [` and returned exactly those two.
  assert.ok(!leafDiffFlags(fake).includes('--verify'), 'and neither is a non-diff call inside diffText');
  assert.strictEqual(leafDiffFlags('function nothing() {}'), null, 'a file without diffText yields null, not []');
});

test('FIXTURES: the message extractor reads every quoted git-diff command', () => {
  const fake = [
    "fail('a', `git diff --text --no-ext-diff ${x}..${y} failed`);",
    "fail('b', `git diff --text ${x}..${y} is empty`);",
    "log(`git status ${x}`);",
    "log('git diff --text --no-ext-diff (not a template, no interpolation)');",
  ].join('\n');
  assert.deepStrictEqual(quotedDiffFlags(fake), [['--text', '--no-ext-diff'], ['--text']],
    'each quoted command yields its own flag list, in file order');
  assert.deepStrictEqual(quotedDiffFlags('nothing here'), [], 'no matches yields an empty list');
});

// The comparison, as its own function so the RED fixtures below exercise the
// same code the real assertion uses.
const agrees = (leaf, quoted) => quoted.length > 0
  && quoted.every((q) => q.length === leaf.length && q.every((f, i) => f === leaf[i]));

test('FIXTURES: RED when the leaf gains a flag the messages lack', () => {
  assert.ok(!agrees(['--text', '--no-ext-diff'], [['--text']]),
    'a leaf that grew a flag must not agree with a message that did not');
});

test('FIXTURES: RED when the messages carry a flag the leaf lost', () => {
  assert.ok(!agrees(['--text'], [['--text', '--no-ext-diff']]),
    'the failure is symmetric — a stale message is caught in both directions');
});

test('FIXTURES: RED when one of several messages drifts alone', () => {
  assert.ok(!agrees(['--text', '--no-ext-diff'], [['--text', '--no-ext-diff'], ['--text']]),
    'every quoted site must agree, not merely the first');
});

test('FIXTURES: GREEN only when both sides carry the same flags in the same order', () => {
  assert.ok(agrees(['--text', '--no-ext-diff'], [['--text', '--no-ext-diff'], ['--text', '--no-ext-diff']]),
    'agreeing sides pass');
  assert.ok(!agrees(['--text', '--no-ext-diff'], [['--no-ext-diff', '--text']]),
    'ORDER is part of it: the message is a command the lead pastes, and a '
    + 'reordered one is a different command to read even where git accepts it');
  assert.ok(!agrees(['--text', '--no-ext-diff'], []),
    'and NO quoted command at all is a failure, not a vacuous pass — otherwise '
    + 'deleting both messages would satisfy this file');
});

// ── the real files ─────────────────────────────────────────────────────────

test('the flags CHECK 4 quotes to the lead are the flags diffText actually runs', () => {
  const leaf = leafDiffFlags(read('git-worktree.js'));
  const quoted = quotedDiffFlags(read('team-tickets.js'));

  // ENTER, both sides. Without these the assertion below is green over an
  // extractor that stopped finding anything — the exact false-green this file's
  // fixtures exist to prevent, one level up.
  assert.ok(leaf && leaf.length >= 1,
    'ENTER: the leaf\'s diff argv was found and carries flags');
  assert.ok(quoted.length >= 2,
    `ENTER: CHECK 4's quoted commands were found (got ${quoted.length}, expected at least the two fail() messages)`);

  for (const q of quoted) {
    assert.deepStrictEqual(q, leaf,
      'a message quotes a `git diff` command that is not what diffText runs — '
      + 'a lead re-running it by hand would measure something else. Fix the '
      + 'copy in team-tickets.js CHECK 4, or the argv in git-worktree.js, so '
      + 'they agree.');
  }
});
