'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');

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

function mergeBase() {
  const hasMaster = tryGit(['rev-parse', '--verify', '--quiet', 'master']);
  if (!hasMaster.ok || !hasMaster.out.trim()) return { base: null, why: 'no master ref in this checkout' };

  const shallow = tryGit(['rev-parse', '--is-shallow-repository']);
  if (shallow.ok && shallow.out.trim() === 'true') return { base: null, why: 'shallow clone' };

  const mb = tryGit(['merge-base', 'master', 'HEAD']);
  if (!mb.ok || !mb.out.trim()) return { base: null, why: 'no merge-base between master and HEAD' };

  return { base: mb.out.trim(), why: null };
}

function unreleasedStripped(src) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /^## Unreleased\b/.test(l));
  if (start === -1) return src;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(0, start).concat(lines.slice(end)).join('\n');
}

function headLineNumber(src, strippedLine) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /^## Unreleased\b/.test(l));
  if (start === -1 || strippedLine <= start) return strippedLine;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return strippedLine + (end - start);
}

function firstDiff(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  const n = Math.max(al.length, bl.length);
  for (let i = 0; i < n; i++) {
    if (al[i] !== bl[i]) return { line: i + 1, base: al[i], head: bl[i] };
  }
  return null;
}

const BASE = [
  '# Changelog',
  '',
  '## Unreleased',
  '',
  '## 5.91.0 — 2026-01-01 — old',
  '',
  '- old bullet',
  '',
].join('\n');

const NO_UNRELEASED = [
  '# Changelog',
  '',
  '## 5.91.0 — 2026-01-01 — old',
  '',
  '- old bullet',
  '',
].join('\n');

const CASES = [
  {
    name: '(a) bullet added under Unreleased',
    before: BASE,
    after: BASE.replace('## Unreleased\n', '## Unreleased\n\n- new bullet\n'),
    equal: true,
    why: 'a bullet under ## Unreleased is the one edit a ticket may make',
  },
  {
    name: '(b) bullet added under an old release section',
    before: BASE,
    after: BASE.replace('- old bullet\n', '- old bullet\n- new bullet\n'),
    equal: false,
    diffHead: '- new bullet',
    why: 'a bullet appended to ## 5.91.0 ships in the wrong release notes',
  },
  {
    name: '(c) Unreleased subtitle edit',
    before: BASE,
    after: BASE.replace('## Unreleased\n', '## Unreleased — foo\n'),
    equal: true,
    why: 'the ## Unreleased header line is inside its own section, so a subtitle edit is allowed',
  },
  {
    name: '(d1) no Unreleased section, identical text',
    before: NO_UNRELEASED,
    after: NO_UNRELEASED,
    equal: true,
    why: 'with no ## Unreleased section the whole text is compared, and it is unchanged',
  },
  {
    name: '(d2) no Unreleased section, text changed',
    before: NO_UNRELEASED,
    after: NO_UNRELEASED.replace('- old bullet\n', '- old bullet\n- new bullet\n'),
    equal: false,
    diffHead: '- new bullet',
    why: 'with no ## Unreleased section any edit is outside it',
  },
  {
    name: '(e) release stamp',
    before: BASE.replace('## Unreleased\n', '## Unreleased\n\n- new bullet\n'),
    after: BASE.replace('## Unreleased\n', '## Unreleased\n\n## 5.131.0 — 2026-10-17 — foo\n\n- new bullet\n'),
    equal: false,
    diffHead: '## 5.131.0 — 2026-10-17 — foo',
    why: 'the release stamp rewrites outside ## Unreleased; it runs only on master, never on a ticket branch, where this ratchet is vacuous',
  },
];

for (const c of CASES) {
  test(`unreleasedStripped: ${c.name}`, () => {
    const a = unreleasedStripped(c.before);
    const b = unreleasedStripped(c.after);
    assert.strictEqual(a === b, c.equal, c.why);
    if (!c.equal) {
      const d = firstDiff(a, b);
      assert.ok(d, `ENTER: a differing line must survive the strip — ${c.why}`);
      assert.strictEqual(d.head, c.diffHead, c.why);
    }
  });
}

test('CHANGELOG.md changes only inside ## Unreleased against the merge-base with master', () => {
  const { base, why } = mergeBase();
  if (!base) assert.fail(`cannot compute a merge-base with master (${why}); a ratchet with no base must not pass`);

  const shown = tryGit(['show', `${base}:CHANGELOG.md`]);
  if (!shown.ok) assert.fail(`CHANGELOG.md is absent at merge-base ${base}; this repo always has one`);

  const baseSrc = unreleasedStripped(shown.out);
  const headRaw = fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8');
  const headSrc = unreleasedStripped(headRaw);
  if (baseSrc !== headSrc) {
    const d = firstDiff(baseSrc, headSrc);
    assert.fail(
      `CHANGELOG.md changed outside its '## Unreleased' section against merge-base ${base}; ` +
      'a ticket adds its line under \'## Unreleased\' only — the release moves it\n' +
      `first differing line: CHANGELOG.md:${headLineNumber(headRaw, d.line)}\n` +
      `  base: ${JSON.stringify(d.base)}\n` +
      `  head: ${JSON.stringify(d.head)}`,
    );
  }
});
