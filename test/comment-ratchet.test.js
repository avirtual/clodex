'use strict';
// The comment ratchet: no tracked source file may gain comment lines relative to
// the merge-base with master, and a file absent at the base must ship with zero.
//
// ON MASTER THE MERGE-BASE IS HEAD, SO THIS TEST IS VACUOUS BY CONSTRUCTION.
// That is a fact about the mechanism, not a gap to fix: the gate is meant to bite
// on a branch, which is where a hand's edits live before they merge. "Fixing" it
// to compare against a fixed tag or a committed baseline is the design that was
// considered and rejected.
//
// A test/ directory at ANY depth is deliberately out of scope (this repo has two
// tracked ones, root and cli/): the test doctrine requires prose — an ENTER:
// assertion states in words which row must survive a reduction — so a ratchet
// there would red the suite for adding a subject with its note.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { countCommentLines } = require('../comment-census.js');

const REPO = path.join(__dirname, '..');

const EXCLUDED_ANYWHERE = /(^|\/)(node_modules|vendor|test)\//;

// Root-anchored, unlike the above: these two are build artifacts of THIS repo, and
// a nested dist/ is a plausible source directory name elsewhere in the tree.
const EXCLUDED_ROOT = /^(web-dist|dist)\//;

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

function tryGit(args) {
  try {
    return { ok: true, out: git(args) };
  } catch (err) {
    return { ok: false, err };
  }
}

function inScope(p) {
  return p.endsWith('.js') && !EXCLUDED_ROOT.test(p) && !EXCLUDED_ANYWHERE.test(p);
}

function scopedFiles() {
  return git(['ls-files', '-z', '*.js'])
    .split('\0')
    .filter(Boolean)
    .filter(inScope)
    .sort();
}

// A shallow clone or a checkout with no master ref cannot compute a base, and a
// ratchet with no base would pass over every file. Returning null means "could
// not compare", never "nothing changed" — the caller fails on it rather than
// reporting a green it did not earn.
function mergeBase() {
  const hasMaster = tryGit(['rev-parse', '--verify', '--quiet', 'master']);
  if (!hasMaster.ok || !hasMaster.out.trim()) return { base: null, why: 'no master ref in this checkout' };

  const shallow = tryGit(['rev-parse', '--is-shallow-repository']);
  if (shallow.ok && shallow.out.trim() === 'true') return { base: null, why: 'shallow clone' };

  const mb = tryGit(['merge-base', 'master', 'HEAD']);
  if (!mb.ok || !mb.out.trim()) return { base: null, why: 'no merge-base between master and HEAD' };

  return { base: mb.out.trim(), why: null };
}

// Absent at the base is 0, which is what makes a new file's budget zero. A blob
// that exists but does not decode as text is the one case we cannot count, and
// it is reported rather than silently treated as 0 — a 0 there would let a file
// gain unlimited comments by being unreadable.
function baseSource(base, file) {
  const r = tryGit(['show', `${base}:${file}`]);
  if (!r.ok) {
    const msg = String(r.err && r.err.stderr ? r.err.stderr : r.err);
    if (/exists on disk, but not in|does not exist|unknown revision|invalid object|path .* does not exist/i.test(msg)) {
      return { kind: 'absent' };
    }
    return { kind: 'unreadable', msg };
  }
  if (r.out.includes('\0')) return { kind: 'unreadable', msg: 'binary blob' };
  return { kind: 'text', src: r.out };
}

test('no tracked source file gains comment lines against the merge-base', () => {
  const { base, why } = mergeBase();
  if (base === null) {
    // Fails rather than returns: a green here would be indistinguishable from a
    // green that actually compared every file.
    assert.fail(`comment ratchet cannot run: ${why}. Fetch master (unshallow if needed) and re-run.`);
  }

  const files = scopedFiles();

  // ENTER: the scanned set must be non-trivially large before any per-file
  // assertion runs over it. This assertion's failure mode is an absence — an
  // empty or collapsed file list makes "no file regressed" vacuously true, and
  // vacuums out every check below at once. The floor is a hardcoded literal,
  // deliberately not a count derived the way the scan derives it.
  assert.ok(
    files.length >= 200,
    `expected >= 200 scoped .js files, got ${files.length} — the scan collapsed`,
  );

  // ENTER: specific shapes the filter is most likely to eat — a root module, a
  // nested renderer leaf, a deep plugin file (whose basename collides with a root
  // module's, so a scan keyed by basename loses one of them), a scripts/ tool, and
  // a cli/ source file, which the test-at-any-depth exclusion sits closest to.
  for (const must of [
    'engine.js',
    'session-manager.js',
    'comment-census.js',
    'renderer/lib/format.js',
    'plugins/git-branches/engine.js',
    'scripts/boundary-check.js',
    'cli/src/client.js',
  ]) {
    assert.ok(files.includes(must), `${must} should be in the ratchet scope`);
  }
  assert.ok(!files.some((f) => f.startsWith('test/')), 'test/ must be out of scope');
  assert.ok(
    !files.some((f) => f.includes('/test/')),
    'a nested test tree must be out of scope too',
  );

  const regressions = [];
  const unreadable = [];

  for (const file of files) {
    const abs = path.join(REPO, file);
    // Tracked but deleted in the working tree: nothing to hold to the rule.
    if (!fs.existsSync(abs)) continue;

    const now = countCommentLines(fs.readFileSync(abs, 'utf8'));
    const at = baseSource(base, file);

    if (at.kind === 'unreadable') {
      unreadable.push(`${file}: ${at.msg}`);
      continue;
    }

    const before = at.kind === 'absent' ? 0 : countCommentLines(at.src);
    if (now > before) {
      regressions.push(
        `${file}: ${before} -> ${now} (+${now - before})`
        + (at.kind === 'absent' ? ' [new file: budget is 0]' : ''),
      );
    }
  }

  assert.deepStrictEqual(unreadable, [], `could not read these blobs at the base ${base}`);

  assert.deepStrictEqual(
    regressions,
    [],
    'comment lines added against the merge-base. Delete them, or move the fact'
    + ' into docs/notes/<module>.md if the code genuinely cannot show it:\n  '
    + regressions.join('\n  '),
  );
});

const NOTES_DIR = path.join(REPO, 'docs', 'notes');
const NOTES_LINE_CAP = 120;

function noteFiles() {
  if (!fs.existsSync(NOTES_DIR)) return [];
  return fs.readdirSync(NOTES_DIR).filter((f) => f.endsWith('.md')).sort();
}

function sourceCandidates(noteBase) {
  const parts = noteBase.split('-');
  const out = [];
  for (let drop = 0; drop < parts.length; drop++) {
    const head = parts.slice(0, parts.length - drop);
    for (let cut = 0; cut < head.length; cut++) {
      const dir = head.slice(0, cut).join('/');
      const file = head.slice(cut).join('-');
      out.push(dir ? `${dir}/${file}.js` : `${file}.js`);
    }
  }
  return out;
}

test('a note split off by TOPIC still resolves to its module, and only as a last resort', () => {
  assert.ok(sourceCandidates('renderer-lib-format').includes('renderer/lib/format.js'),
    'ENTER: the ordinary dir/file reading still works');

  const split = sourceCandidates('session-manager-scratch');
  assert.ok(split.includes('session-manager.js'),
    'session-manager.md hit the 120-line cap, so its scratch half moved to '
    + 'session-manager-scratch.md — still a note about session-manager.js, and a heading gate that '
    + 'could not find the module would report every heading in it as an orphan');
  assert.ok(split.indexOf('session-manager-scratch.js') < split.indexOf('session-manager.js'),
    'but the note\'s OWN name is tried first: a file really named session-manager-scratch.js must '
    + 'win, or a note would silently be graded against a module it does not describe');

  const whole = sourceCandidates('team-cost');
  assert.strictEqual(whole[0], 'team-cost.js');
  assert.ok(whole.indexOf('team-cost.js') < whole.indexOf('team.js'),
    'and a name that resolves whole never falls through to its own prefix');
});

test('each docs/notes file is within the line cap', () => {
  for (const f of noteFiles()) {
    const lines = fs.readFileSync(path.join(NOTES_DIR, f), 'utf8').split('\n');
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    assert.ok(
      lines.length <= NOTES_LINE_CAP,
      `docs/notes/${f} is ${lines.length} lines, cap is ${NOTES_LINE_CAP}`,
    );
  }
});

test('every ## heading in docs/notes names an identifier in its source file', () => {
  const orphans = [];

  for (const f of noteFiles()) {
    const noteBase = f.replace(/\.md$/, '');
    const candidate = sourceCandidates(noteBase)
      .map((rel) => ({ rel, abs: path.join(REPO, rel) }))
      .find((c) => fs.existsSync(c.abs));

    if (!candidate) {
      orphans.push(`docs/notes/${f}: no source file matches this note's name`);
      continue;
    }

    const src = fs.readFileSync(candidate.abs, 'utf8');
    const headings = fs.readFileSync(path.join(NOTES_DIR, f), 'utf8')
      .split('\n')
      .map((l) => /^##\s+(\S+)/.exec(l))
      .filter(Boolean)
      .map((m) => m[1]);

    for (const symbol of headings) {
      const bare = symbol.replace(/[^\w$]/g, '');
      if (!bare) continue;
      if (!new RegExp(`\\b${bare}\\b`).test(src)) {
        orphans.push(`docs/notes/${f}: '## ${symbol}' names nothing in ${candidate.rel}`);
      }
    }
  }

  assert.deepStrictEqual(orphans, []);
});
