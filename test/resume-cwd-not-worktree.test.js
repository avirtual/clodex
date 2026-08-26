// The resume paths must spawn in the record's `cwd`, never in its `worktree.path`.
//
// This pins the premise a DELIBERATE non-decision rests on (t488). sessions.json
// accumulates `worktree` pointers to trees that no longer exist — three supported
// routes produce them (team-retire/archive on a dirty tree, the same on a tree it
// could not inspect, the merge gate's not-merged arm followed by a later accept),
// and the investigation's conclusion was to sweep NOTHING. That conclusion is only
// safe because a stale pointer is never resumed INTO: clicking an archived row
// unarchives and re-spawns in the shared checkout, which exists, so the resume
// succeeds and no user-visible failure follows from the staleness.
//
// Change any of the five sites to boot a seat in the tree it is "supposed" to
// work in — a plausible-looking improvement, since a seat's work IS in its tree —
// and the harm the sweep was rejected for becomes real: every archived ticket seat
// resumes into ENOENT. The pressure to then add a sweep keyed on "the path is
// missing" is exactly the pre-v0.5.3 "upgrade kills my agents" bug, which is why
// this is worth a test rather than a comment. Seats are told their tree in the
// spec's `WORK IN:` line (team-tickets.js) and cd there themselves; the cwd stays
// the shared repo by design, which is also why `_ticketTreeHolder` reads occupancy
// off the record rather than off any session's cwd.
//
// A SOURCE-shape pin, not a runtime one: the property is "this argument is that
// expression", and a fixture calling a stubbed create() would assert only that the
// stub received whatever the test fed it. The expected argument text is a LITERAL
// below, so a wrong-source substitution (a neighbouring field, a joined path)
// cannot satisfy it by accident.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Top-level argument texts of the call whose '(' is at src[open]. Comment- and
// string-aware so a comma inside either cannot split an argument — both call sites
// interleave trailing comments between arguments (`false, // mint — ...`).
function callArgs(src, open) {
  const args = [];
  let depth = 0;
  let cur = '';
  let i = open;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (depth === 1 && (c === '/' && (d === '/' || d === '*'))) {
      if (d === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
      const end = src.indexOf('*/', i + 2); i = end === -1 ? src.length : end + 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; let j = i + 1;
      while (j < src.length && src[j] !== quote) { if (src[j] === '\\') j += 1; j += 1; }
      cur += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '(' || c === '[' || c === '{') { depth += 1; if (depth > 1) cur += c; i += 1; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) { args.push(cur.trim()); return args; }
      cur += c; i += 1; continue;
    }
    if (c === ',' && depth === 1) { args.push(cur.trim()); cur = ''; i += 1; continue; }
    cur += c; i += 1;
  }
  return args;
}

// Slice from `anchor` to the end of the balanced brace block it opens — the
// handler/function body, so the worktree assertion below is scoped to the resume
// path and not to whatever else the module happens to contain.
//
// An anchor that ENDS in '{' names its own body brace and is used verbatim; every
// other anchor gets the paren walk below. A call-site anchor MUST take the first
// form: the paren walk starts inside `handle(`'s own paren, so the callback's '{'
// sits at depth 1 and is skipped, and the walk runs on to the next depth-0 brace —
// which at ipc-handlers.js is `if (enableDrawerServices) {`, swallowing every
// handler in between. That over-scope was green only by accident (no other
// manager.create, no `worktree` in the range); one future handler saying
// "worktree" would fail this file naming the resume path.
function bodyAfter(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `anchor not found in source: ${anchor}`);
  let open = -1;
  if (anchor.endsWith('{')) {
    open = start + anchor.length - 1;
  } else {
    // The body brace is the first '{' outside the parameter list, NOT the first '{'
    // after the anchor: restoreSessionsForWorkspace destructures its deps object, so
    // naively taking the first brace grabs the parameter pattern and the slice ends
    // before create() is ever reached. That produced a zero-argument parse the ENTER
    // check below caught — the failure this walker exists in this shape to avoid.
    let paren = 0;
    for (let i = start; i < src.length; i += 1) {
      const c = src[i];
      if (c === '(') paren += 1;
      else if (c === ')') paren -= 1;
      else if (c === '{' && paren === 0) { open = i; break; }
    }
  }
  assert.notStrictEqual(open, -1, `no block opens after anchor: ${anchor}`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  assert.fail(`unbalanced block after anchor: ${anchor}`);
  return '';
}

// All five sites that respawn a session from its persisted record. The three that
// run against a LIVE record (restartSession, applySessionArgs, the reload intent)
// are here for the same reason as the two archived-record ones: the mutation this
// file guards against — "boot the seat in the tree it is supposed to work in" — is
// a one-line edit at any of the five, and a table covering some of them would let
// it land while reading as a checked list.
//
// GROUND TRUTH for this table is `test/create-mint-census.test.js`'s EXPECTED —
// its `mint: false` rows ARE the respawn-from-record set, and it fails on a count
// mismatch when a `.create(` site is added. Cross-check against it rather than
// re-deriving by hand; extending either table means extending this one too. This
// file shipped covering four of the five because the count was taken from prose
// instead: a per-site proof over an incomplete table proves the rows present and
// can never see the row missing.
//
// Each row's expected cwd argument is written out as a literal rather than derived,
// so the table can express a site that legitimately differs — applySessionArgs
// reads `beforeKill`, not `entry`, and a derived expectation would paper over
// exactly that. `call` likewise: the manager is `manager` in four of them and
// `this` inside SessionManager.
const RESUME_SITES = [
  {
    file: 'ipc-handlers.js',
    anchor: "handle('session:retrySpawn', async (e, name) => {",
    call: 'manager.create',
    cwdArg: 'entry.cwd',
    label: 'session:retrySpawn — the archived-row click (unarchive → retry) AND the failed-tab retry button',
  },
  {
    file: 'session-restore.js',
    anchor: 'async function restoreSessionsForWorkspace',
    call: 'manager.create',
    cwdArg: 'entry.cwd',
    label: 'restoreSessionsForWorkspace — restore-on-launch',
  },
  {
    file: 'engine.js',
    anchor: 'async function restartSession',
    call: 'manager.create',
    cwdArg: 'entry.cwd',
    label: 'restartSession — the restart menu item and the peer restart endpoint',
  },
  {
    file: 'engine.js',
    anchor: 'async function applySessionArgs',
    call: 'manager.create',
    cwdArg: 'beforeKill.cwd',
    label: 'applySessionArgs — the args-edit restart (session:setArgs, the peer args POST); a SEPARATE create() from restartSession\'s, reading a beforeKill snapshot',
  },
  {
    file: 'session-manager.js',
    anchor: "if (sub === 'reload') {",
    call: 'this.create',
    cwdArg: 'entry.cwd',
    label: '[agent:context reload] — the cold respawn a seat asks for itself',
  },
];

test('resume paths spawn in the record cwd, not its worktree path', () => {
  for (const site of RESUME_SITES) {
    const src = fs.readFileSync(path.join(ROOT, site.file), 'utf8');
    const body = bodyAfter(src, site.anchor);
    // Assert on the CALL's index, not on the paren's: `indexOf('(', -1)` searches
    // from 0 and returns the anchor's own paren, so a `-1` check on the paren can
    // never fire and a missing call would surface downstream as a parse failure.
    // Match the paren as part of the needle so `this.create` cannot be satisfied
    // by a longer name (`this.createBox`) that merely starts the same way.
    const c = body.indexOf(`${site.call}(`);
    assert.notStrictEqual(c, -1, `${site.file}: no ${site.call}( call in ${site.label}`);
    const open = c + site.call.length;
    const args = callArgs(body, open);
    // ENTER: the walker must actually have produced a full argument list. A scan
    // that fell off the end returns a short array, and every assertion below it
    // would then read `undefined` — vacuously unequal, or vacuously absent.
    assert.ok(args.length >= 3,
      `${site.file}: parsed only ${args.length} args from ${site.label} — the scan failed, the site did not`);
    assert.strictEqual(args[2], site.cwdArg,
      `${site.file}: create()'s cwd argument is "${args[2]}", expected "${site.cwdArg}" (${site.label}).\n`
      + 'A resume must spawn in the shared checkout the record names. Booting it in the seat\'s\n'
      + 'worktree makes every archived ticket seat resume into ENOENT once its tree is removed —\n'
      + 'see docs/sessions.md §5 on why those stale pointers are deliberately not swept.');
  }
});

test('resume paths do not read worktree provenance at all', () => {
  for (const site of RESUME_SITES) {
    const src = fs.readFileSync(path.join(ROOT, site.file), 'utf8');
    // Comments may discuss worktrees; only executable references matter here.
    const body = bodyAfter(src, site.anchor)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert.ok(!/worktree/i.test(body),
      `${site.file}: ${site.label} references a worktree. The resume path must not read\n`
      + '`worktree` provenance — a record can name a tree that no longer exists (an expected\n'
      + 'state, see docs/sessions.md §5), and a resume that consults it inherits that staleness.');
  }
});
