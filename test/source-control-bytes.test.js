'use strict';

// Guards a bug class that three independent checks fell through at once: a JS
// source file containing a RAW control byte.
//
// The instance (t301): tickets-migrate.js used a literal `\x00` as a dedup key
// separator. The code was correct and its own tests passed, so the suite said
// nothing. But git classifies a file with a NUL as BINARY — `git diff` renders
// it as `Bin 0 -> 5964 bytes` with no content, and grep skips it silently. The
// module was therefore invisible to review: the lead reading the branch as a
// diff, and the cold reviewer after them, would both have been shown
// "Binary files differ" where a new module should be. Two older files
// (basket-retrieve.js, scripts/mine-operator-messages.js) had the same idiom and
// had already been shipping as un-diffable binaries unnoticed.
//
// That is the profile that earns a guard: silent to the author, silent to the
// suite, silent to the reviewer. ESCAPED forms are FINE and stay legal here —
// `'\\x00'` in a string, `\\u0000` in a regex — because they are ordinary
// printable source that git diffs and grep finds. Only a raw byte is refused.
//
// This file is not exempt from its own rule. The first draft of it carried a raw
// NUL on this very line, in the sentence explaining that escaped forms are safe,
// and stayed green because it was still UNTRACKED when it ran — `git ls-files`
// could not see it. It failed the moment it was committed. Keep the enumeration
// tracked-file-based anyway: that is what makes the scan total.
//
// Enumerated from `git ls-files`, so it covers every tracked JS file present and
// future with no per-file registration, and ignores node_modules and build
// output by construction.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// C0 minus the three whitespace bytes that legitimately appear in source, plus
// DEL. Tab/LF/CR are excluded because they ARE the file's formatting; every
// other byte in this range is a byte no editor puts there on purpose.
const FORBIDDEN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function trackedJsFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '*.js'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

test('every tracked .js file is free of raw control bytes', () => {
  const files = trackedJsFiles();
  // ENTER: the reduction upstream of the assertion is `git ls-files` itself. A
  // pathspec that matched nothing (wrong cwd, a git that does not answer) would
  // leave an empty list, and "no file has a control byte" is vacuously TRUE of
  // no files — the assertion below would pass over a check that ran on nothing.
  assert.ok(files.length > 100, `expected the repo's JS files, got ${files.length}`);
  assert.ok(files.includes('tickets-migrate.js'), 'the file that motivated this test must be in the scanned set');

  const offenders = [];
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    const text = buf.toString('latin1');   // byte-exact; no decoding of multibyte UTF-8
    const m = FORBIDDEN.exec(text);
    if (!m) continue;
    const line = text.slice(0, m.index).split('\n').length;
    const code = `0x${m[0].charCodeAt(0).toString(16).padStart(2, '0')}`;
    offenders.push(`${rel}:${line} contains ${code}`);
  }

  assert.deepStrictEqual(offenders, [],
    `raw control bytes make a file binary to git and grep, so its diff is invisible to review:\n  ${offenders.join('\n  ')}`);
});
