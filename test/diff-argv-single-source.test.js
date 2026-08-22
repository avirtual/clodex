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

// The flags as QUOTED in CHECK 4's messages. Reads every quoted RANGE DIFF in
// the file rather than the two known sites: a third message added later is
// exactly the drift this file exists to catch, and pinning by line number would
// miss it while looking rigorous.
//
// THE ANCHOR IS THE RANGE (`${a}..${b}`), not the literal prefix `git diff`, and
// the difference is not pedantry — the first version anchored on the prefix and
// was wrong in both directions at once:
//
//   - it BLOCKED AN IMPROVEMENT. Rewriting the messages in the pasteable
//     `git -C ${team.root} diff …` form the UNKNOWN arm already uses made this
//     extractor return [], tripping the ENTER. A guard that reds on a strictly
//     better message is a guard that gets edited into silence.
//   - it DRAGGED IN A STRANGER. A `git diff --stat ${sha}^1 ${sha}` quoted
//     elsewhere was collected and then required to equal the leaf's flags.
//
// `-C ${…}` is therefore optional, and the `..` range is what identifies the
// command `diffText` actually runs. `${sha}^1 ${sha}` is two arguments, not a
// range, so the UNKNOWN arm's --stat command is correctly not this one.
//
// THE RANGE ALONE IS NOT ENOUGH, measured: a `git diff --stat ${a}..${b}` quoted
// anywhere in the file is also a range diff, and comparing ITS flags to the
// leaf's argv reds this file over a command that has nothing to do with
// `diffText`. So the scan is also SCOPED TO A CALL SITE — quoted commands are
// read only from the neighbourhood of a `gitWorktree.diffText(` call, which is
// where a message describing that call can be.
//
// That mirrors `leafDiffFlags`, which is scoped to the `diffText` FUNCTION for
// the same reason, and it keeps the property the unscoped version was for: a
// THIRD message added beside these two is still caught, because it is in scope.
// Only a range diff describing some OTHER command, somewhere else, is excluded.
const CALL_WINDOW = 2000;
function quotedDiffFlags(src) {
  // Keyed by ABSOLUTE offset, because windows overlap: a second `diffText(` call
  // landing within CALL_WINDOW of CHECK 4 would collect the same message twice,
  // and the `>= 2` ENTER below would then be counting one message rather than
  // two. Harmless today — the duplicates all equal `leaf` — but the ENTER's
  // arithmetic should mean what its message says.
  const seen = new Map();
  for (const call of src.matchAll(/gitWorktree\.diffText\(/g)) {
    const near = src.slice(call.index, call.index + CALL_WINDOW);
    for (const m of near.matchAll(/`git (?:-C \$\{[^}]*\}\s+)?diff ((?:--[\w-]+\s+)*)\$\{[^}]*\}\.\.\$\{[^}]*\}/g)) {
      seen.set(call.index + m.index, m[1].trim().split(/\s+/).filter(Boolean));
    }
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, flags]) => flags);
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
    // TRAILING EMPTY ELEMENT, so `join` ends the fixture with `\n}\n` — the
    // terminator `leafDiffFlags` scans for. Without it `indexOf` returns -1 and
    // `slice(at, -1)` produces the passing result by a DIFFERENT path than the
    // real file takes, which is a fixture green for the wrong reason.
    "",
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

test('FIXTURES: the message extractor reads every quoted RANGE diff near the call', () => {
  const fake = [
    "const diff = await gitWorktree.diffText(team.root, baseSha, branch);",
    "fail('a', `git diff --text --no-ext-diff ${x}..${y} failed`);",
    "fail('b', `git diff --text ${x}..${y} is empty`);",
    "log(`git status ${x}`);",
    "log('git diff --text --no-ext-diff (not a template, no interpolation)');",
  ].join('\n');
  assert.deepStrictEqual(quotedDiffFlags(fake), [['--text', '--no-ext-diff'], ['--text']],
    'each quoted command yields its own flag list, in file order');
  assert.deepStrictEqual(quotedDiffFlags('nothing here'), [], 'no matches yields an empty list');
});

test('FIXTURES: the `-C ${…}` form is FOUND, so the pin cannot block a better message', () => {
  // Measured against the r8 extractor: this returned [] and tripped the ENTER,
  // so rewriting CHECK 4 into the pasteable-from-anywhere form the UNKNOWN arm
  // already uses would have RED the guard. A guard that punishes an improvement
  // is one someone eventually deletes.
  const CALL = "const diff = await gitWorktree.diffText(team.root, baseSha, branch);\n";
  const withC = CALL + "fail('a', `git -C ${team.root} diff --text --no-ext-diff ${baseSha}..${branch} failed`);";
  assert.deepStrictEqual(quotedDiffFlags(withC), [['--text', '--no-ext-diff']],
    'the -C form is found and its flags compared, not skipped');
  // Both spellings must yield the SAME answer, or the pin would silently depend
  // on which form the message happens to use.
  const withoutC = CALL + "fail('a', `git diff --text --no-ext-diff ${baseSha}..${branch} failed`);";
  assert.deepStrictEqual(quotedDiffFlags(withC), quotedDiffFlags(withoutC),
    'the -C prefix changes nothing about which flags are read');
});

test('FIXTURES: a quoted git diff that is NOT the leaf\'s range diff is not dragged in', () => {
  // The other direction of the same defect. `${sha}^1 ${sha}` is two arguments,
  // not a `..` range — the UNKNOWN arm's --stat command is a DIFFERENT command
  // to a different question, and comparing its flags to the leaf's argv reds the
  // file over an unrelated line.
  const strangers = [
    "const diff = await gitWorktree.diffText(team.root, baseSha, branch);",
    "run `git -C ${team.root} diff --stat ${sha}^1 ${sha}` before deciding",
    "run `git diff --stat ${sha}^1 ${sha}` before deciding",
    "`git -C ${team.root} merge --no-ff ${branch}`",
    "`git -C ${team.root} revert -m 1 ${merged.sha}`",
  ].join('\n');
  assert.deepStrictEqual(quotedDiffFlags(strangers), [],
    'only the range diff diffText runs is collected');
  // ENTER: the stranger really is a quoted git command, so this is an exclusion
  // the extractor makes rather than a string it could never have matched.
  assert.match(strangers, /`git [^`]*diff --stat/, 'ENTER: a quoted `git … diff --stat` is present to be excluded');

  // The measured case the RANGE anchor alone did NOT exclude: a --stat command
  // that IS a range. Only the call-site scoping keeps it out, and without that
  // scoping this file reds over a line describing a different command.
  const statRange = "run `git -C ${team.root} diff --stat ${sha}..${other}` before deciding";
  const CALL = "const d = await gitWorktree.diffText(a, b, c);\n";

  // ADJACENT: collected. This is the positive control — without it, the empty
  // result below is indistinguishable from an extractor that finds nothing.
  assert.deepStrictEqual(quotedDiffFlags(CALL + statRange), [['--stat']],
    'the same string IS collected when it sits at a call site');

  // DISTANT: not collected, and the fixture really spans the window — a real
  // call site, then CALL_WINDOW worth of filler, then the command. The previous
  // version passed `statRange` alone, which contains no `diffText(` at all, so
  // the outer loop never iterated and `[]` came free: measured, raising
  // CALL_WINDOW to 50000 left every subject in this file green.
  //
  // The filler is DERIVED from CALL_WINDOW rather than a hardcoded length, so
  // the fixture cannot drift from the constant it pins.
  const far = CALL + 'x'.repeat(CALL_WINDOW) + statRange;
  assert.match(far, /gitWorktree\.diffText\(/,
    'ENTER: the distant fixture really does contain a call site, so the outer '
    + 'loop iterates and the exclusion below is the DISTANCE, not an empty scan');
  assert.deepStrictEqual(quotedDiffFlags(far), [],
    'a --stat RANGE diff beyond CALL_WINDOW of any diffText call is not this command');
});

// The comparison, as its own function so the RED fixtures below exercise the
// same code the real assertion uses. That sentence was FALSE when first written
// — the real assertion re-implemented the comparison and merely happened to
// agree, which is this file's own subject one level in. It is true now because
// the real assertion calls this, not because someone maintains the claim.
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

  // THE comparison — the same function the RED fixtures above exercise, so a
  // change to it cannot pass the fixtures and skip the real files, or vice
  // versa. The loop below then re-states the failure in a diffable form; it is
  // the diagnostic, not the check.
  const ok = agrees(leaf, quoted);
  for (const q of quoted) {
    assert.deepStrictEqual(q, leaf,
      'a message quotes a `git diff` command that is not what diffText runs — '
      + 'a lead re-running it by hand would measure something else. Fix the '
      + 'copy in team-tickets.js CHECK 4, or the argv in git-worktree.js, so '
      + 'they agree.');
  }
  // Reached only when every element matched, so this fires on exactly the case
  // the loop cannot see: `quoted` empty. The ENTER above already covers it for
  // the real file — this keeps the two paths from drifting if that ENTER is ever
  // relaxed.
  assert.ok(ok, 'the flags agree, and at least one quoted command was compared');
});
