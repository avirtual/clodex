'use strict';
// The comment ratchet: no tracked source file may gain comment lines relative to
// the merge-base with master, and a file absent at the base must ship with zero.
//
// ON MASTER THE MERGE-BASE IS HEAD, SO THIS TEST IS VACUOUS BY CONSTRUCTION —
// every file compares against itself. That is a fact about the mechanism, not a
// gap to fix: the gate is meant to bite on a branch, which is where a hand's
// edits live before they merge. "Fixing" it to compare against a fixed tag or a
// committed baseline is the design that was considered and rejected.
//
// test/ is deliberately out of scope: this repo's test doctrine requires prose
// (an ENTER: assertion states in words which row must survive a reduction), so a
// ratchet there would red the suite for adding a subject with its note.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { countCommentLines } = require('../comment-census.js');

const REPO = path.join(__dirname, '..');

// A directory whose .js is vendored, generated or not ours to hold to the rule.
const EXCLUDED = /^(test|node_modules|web-dist|dist|vendor)\//;
const EXCLUDED_ANYWHERE = /(^|\/)(node_modules|vendor)\//;

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
  return p.endsWith('.js') && !EXCLUDED.test(p) && !EXCLUDED_ANYWHERE.test(p);
}

function scopedFiles() {
  return git(['ls-files', '-z', '*.js'])
    .split('\0')
    .filter(Boolean)
    .filter(inScope)
    .sort();
}

// A shallow clone or a checkout with no master ref cannot compute a base, and a
// ratchet with no base silently passes over every file. Skipping loudly is the
// only honest outcome; returning null means "skip", never "nothing changed".
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
    // Loud skip: a green here would otherwise be indistinguishable from a green
    // that actually compared every file.
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
  // nested renderer leaf, a deep plugin file, a scripts/ tool.
  for (const must of ['engine.js', 'session-manager.js', 'comment-census.js', 'renderer/lib/format.js']) {
    assert.ok(files.includes(must), `${must} should be in the ratchet scope`);
  }
  assert.ok(!files.some((f) => f.startsWith('test/')), 'test/ must be out of scope');

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
const NOTES_LINE_CAP = 40;

// docs/notes/ holds no files today and that is the intended state, so the checks
// below must pass over an absent directory rather than error on it.
function noteFiles() {
  if (!fs.existsSync(NOTES_DIR)) return [];
  return fs.readdirSync(NOTES_DIR).filter((f) => f.endsWith('.md')).sort();
}

// docs/notes/renderer-lib-x.md describes renderer/lib/x.js: the path with
// separators flattened to hyphens. Hyphens are also legal in a filename, so the
// split is ambiguous and every reading is tried, shallowest first.
function sourceCandidates(noteBase) {
  const parts = noteBase.split('-');
  const out = [];
  for (let cut = 0; cut < parts.length; cut++) {
    const dir = parts.slice(0, cut).join('/');
    const file = parts.slice(cut).join('-');
    out.push(dir ? `${dir}/${file}.js` : `${file}.js`);
  }
  return out;
}

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
