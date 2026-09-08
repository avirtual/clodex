// A ticket seat's cwd IS its worktree (t752), so every resume-from-record path
// has to survive a tree that is no longer there — and there are supported routes
// that produce exactly that: team-retire with discard removes the tree, an
// operator can `rm -rf` one by hand, and team-retire/archive on a dirty or
// uninspectable tree leaves a record whose pointer outlives the checkout.
// sessions.json is deliberately never swept for those (t488), so the record is
// what has to answer, not a cleanup pass.
//
// Two halves, and both are needed:
//
//   1. A SOURCE-shape pin that every resume site routes its cwd through
//      `resumeCwdOf(entry)` rather than reading `entry.cwd` itself. A site that
//      reads the field directly boots into ENOENT the moment its tree goes, and
//      the pressure to answer that with a sweep keyed on "the path is missing" is
//      the pre-v0.5.3 "upgrade kills my agents" bug. Source-shape because the
//      property is "this argument is that expression": a fixture calling a
//      stubbed create() would assert only that the stub got what the test fed it.
//      The expected argument text is a LITERAL per row, so a wrong-source
//      substitution (a neighbouring field, a joined path) cannot satisfy it.
//
//   2. A RUNTIME pin of what that one function decides, over the three states a
//      record can be in — tree present, tree gone with a `main` to fall back to,
//      and a pre-t752 record with no `main` at all.

'use strict';

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('../engine');
const { mkTmpRoot } = require('./lib/tmp-roots');

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
// handler/function body, so the assertions below are scoped to the resume path
// and not to whatever else the module happens to contain.
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

// Every site that respawns a session from its persisted record. Those that run
// against a LIVE record (rename, restartSession, applySessionArgs, the reload
// intent) are here for the same reason as those that run without a live session
// (retrySpawn, restore-on-launch — the latter respawns COLD entries and skips
// `archivedAt` ones outright, so "archived" is the wrong word for either): the
// mutation this file guards against is a one-line edit at any of them, and a table
// covering some would let it land while reading as a checked list.
//
// GROUND TRUTH for this table is `test/create-mint-census.test.js`'s EXPECTED —
// its `mint: false` rows ARE the respawn-from-record set, and it fails on a count
// mismatch when a `.create(` site is added. Cross-check against it rather than
// re-deriving by hand; extending either table means extending this one too. This
// file once shipped a row short because the count was taken from prose instead: a
// per-site proof over an incomplete table proves the rows present and can never
// see the row missing.
//
// Each row's expected cwd argument is written out as a literal rather than derived,
// so the table can express a site that legitimately differs — applySessionArgs
// reads `beforeKill`, not `entry`, and a derived expectation would paper over
// exactly that. `call` likewise: the manager is `manager` in four of them and
// `this` inside SessionManager. Two sites bind the resolved cwd to a local first,
// because they use it TWICE (the row they report to the sidebar, the reattach
// payload) and resumeCwdOf is not idempotent — it clears the pointer it fell back
// from. Those rows carry `bind`, the assignment text, so `cwdArg: 'cwd'` cannot be
// satisfied by a local holding anything else.
//
// DELIBERATELY ABSENT: session-manager.js's `move(name, newCwd)`. The mint census
// tells you a `mint: false` site is also a row here, and that rule holds for the
// six below — but move is a mint:false site that CHANGES the cwd on purpose, so
// it fails both assertions by construction rather than by defect. Its third
// argument is `newCwd`, not a resolved resume cwd (the whole feature), and it
// reads `entry.worktree` to refuse a ticket seat, which the second test forbids.
// Adding it here to "complete" the table would pin the opposite of what move means.
//
// The worktree read is a REFUSAL guard, not provenance a spawn consults: move
// never passes it to create(). A seat whose tree was removed by hand is refused a
// move it could safely take. Conservative, and the recovery is the same
// delete-and-recreate the operator has today.
//
// PRESENT, and NOT routed through the helper: `rename(name, newName)`. It refuses
// any record carrying a `worktree.path` outright, so a rename never reaches a
// ticket seat and `entry.cwd` is the only cwd it can mean — routing it through
// resumeCwdOf would be dead code whose fallback nothing could ever exercise. That
// makes its `cwdArg` literal the interesting one in the table: it is the row that
// says the helper is for resumes of seats that still HOLD a tree. The second test
// is waived for it by `worktreeRefusal`, a per-row opt-out rather than a relaxed
// check, so a rename that grew a real provenance read would have to come here.
const RESUME_SITES = [
  {
    file: 'ipc-handlers.js',
    anchor: "handle('session:retrySpawn', async (e, name) => {",
    call: 'manager.create',
    cwdArg: 'manager.resumeCwdOf(entry)',
    label: 'session:retrySpawn — the archived-row click (unarchive → retry) AND the failed-tab retry button',
  },
  {
    file: 'session-restore.js',
    anchor: 'async function restoreSessionsForWorkspace',
    call: 'manager.create',
    cwdArg: 'cwd',
    bind: 'const cwd = manager.resumeCwdOf(entry);',
    label: 'restoreSessionsForWorkspace — restore-on-launch',
  },
  {
    file: 'engine.js',
    anchor: 'async function restartSession',
    call: 'manager.create',
    cwdArg: 'manager.resumeCwdOf(entry)',
    label: 'restartSession — the restart menu item and the peer restart endpoint',
  },
  {
    file: 'engine.js',
    anchor: 'async function applySessionArgs',
    call: 'manager.create',
    cwdArg: 'manager.resumeCwdOf(beforeKill)',
    label: 'applySessionArgs — the args-edit restart (session:setArgs, the peer args POST); a SEPARATE create() from restartSession\'s, reading a beforeKill snapshot',
  },
  {
    file: 'session-manager.js',
    anchor: 'async rename(name, newName) {',
    call: 'this.create',
    cwdArg: 'entry.cwd',
    worktreeRefusal: true,
    label: 'rename(name, newName) — Rename…, which respawns the seat under a new name in the SAME folder, and refuses a seat that has a tree at all',
  },
  {
    file: 'session-manager.js',
    anchor: "if (sub === 'reload') {",
    call: 'this.create',
    cwdArg: 'cwd',
    bind: 'const cwd = this.resumeCwdOf(entry);',
    label: '[agent:context reload] — the cold respawn a seat asks for itself',
  },
];

test('every resume path resolves its cwd through resumeCwdOf', () => {
  for (const site of RESUME_SITES) {
    const src = fs.readFileSync(path.join(ROOT, site.file), 'utf8');
    const body = bodyAfter(src, site.anchor);
    // A row that passes a LOCAL must show where the local came from, or `cwd`
    // names whatever happens to be in scope and the literal below proves nothing.
    if (site.bind) {
      assert.ok(body.includes(site.bind),
        `${site.file}: ${site.label} passes a local, but "${site.bind}" is not in its body — `
        + 'the local must be bound from the helper, or the argument literal below is satisfied by any name');
    }
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
      + 'A ticket seat lives in its worktree, and that tree does not outlive a discard or an\n'
      + 'operator rm -rf. Reading entry.cwd directly boots such a seat into ENOENT instead of\n'
      + 'the shared checkout its record names — see docs/sessions.md on why the stale pointers\n'
      + 'those routes leave behind are deliberately not swept.');
  }
});

// ONE reader. resumeCwdOf is where the fallback and the pointer-drop live, and a
// site that also reads `entry.worktree` for itself is a second, unpinned copy of
// that decision — free to disagree with the helper about which checkout a seat
// resumes into, and about whether the pointer survives.
test('no resume path reads worktree provenance itself', () => {
  const waived = RESUME_SITES.filter((s) => s.worktreeRefusal).map((s) => s.file);
  // ENTER: the waiver is a per-row opt-out and must stay one. If it ever covers
  // every row this test asserts nothing, and it would still pass.
  assert.ok(waived.length < RESUME_SITES.length,
    `every row is waived — this test would be vacuous (waived: ${waived.join(', ')})`);
  for (const site of RESUME_SITES) {
    if (site.worktreeRefusal) continue;
    const src = fs.readFileSync(path.join(ROOT, site.file), 'utf8');
    // Comments may discuss worktrees; only executable references matter here.
    const body = bodyAfter(src, site.anchor)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert.ok(!/worktree/i.test(body),
      `${site.file}: ${site.label} references a worktree. Provenance is read in exactly one\n`
      + 'place — SessionManager.resumeCwdOf — which decides the fallback AND drops the pointer\n'
      + 'it fell back from. A second reader here can disagree with it on both.');
  }
});

// ---------------------------------------------------------- the helper itself

// The source pin above says every site ASKS resumeCwdOf. These three say what it
// ANSWERS, over the states a record can be in. Driven through a real engine's
// persistence store, so the pointer drop is observed on the stored record rather
// than on a fixture's copy of it.
//
// createEngine starts background timers with no host to stop them; force-exit in
// `after` once results flush, as engine-args-env.test.js does.
function mkEngine() {
  const tmp = mkTmpRoot('clx-resumecwd-');
  // registryDir, or the engine seeds the operator's live ~/.clodex (t359).
  return createEngine({
    userDataPath: tmp,
    seams: { registryDir: path.join(tmp, 'clodex-home') },
    log: { info() {}, warn() {}, error() {} },
  });
}

test('a tree that is still there is where the seat resumes', () => {
  const eng = mkEngine();
  const root = mkTmpRoot('clx-resumecwd-repo-');
  const tree = path.join(root, 'repo-t42');
  const main = path.join(root, 'repo');
  fs.mkdirSync(tree);
  fs.mkdirSync(main);
  const entry = { name: 'hand-42', type: 'claude', cwd: tree, workspaceId: 'default', worktree: { path: tree, branch: 't42', main } };
  eng.stores.persistence.upsert(entry);

  assert.strictEqual(eng.manager.resumeCwdOf(entry), tree,
    'the tree exists, so it is the cwd — the fallback must not fire on a healthy record');
  // The pointer is what session:kill removes the tree by and what
  // _ticketTreeHolder reads occupancy off. Dropping it on a live tree strands a
  // checkout no record names.
  assert.deepStrictEqual(eng.stores.persistence.get('hand-42').worktree, { path: tree, branch: 't42', main },
    'and the record is untouched');
});

test('a tree that is GONE falls back to worktree.main, and the pointer goes with it', () => {
  const eng = mkEngine();
  const root = mkTmpRoot('clx-resumecwd-gone-');
  const tree = path.join(root, 'repo-t43');   // deliberately never created
  const main = path.join(root, 'repo');
  fs.mkdirSync(main);
  const entry = { name: 'hand-43', type: 'claude', cwd: tree, workspaceId: 'default', worktree: { path: tree, branch: 't43', main } };
  eng.stores.persistence.upsert(entry);
  // ENTER: the tree must really be absent and the main really present, or this
  // test asserts the first row's behaviour under a second row's name.
  assert.strictEqual(fs.existsSync(tree), false, 'ENTER: the tree is gone');
  assert.strictEqual(fs.existsSync(main), true, 'ENTER: the shared checkout is there');

  assert.strictEqual(eng.manager.resumeCwdOf(entry), main,
    'the seat resumes in the shared checkout it was cut from, not into ENOENT');
  assert.strictEqual(eng.stores.persistence.get('hand-43').worktree, undefined,
    'and the pointer to the vanished tree is dropped — left behind, _ticketTreeHolder reads this '
    + 'seat as holding a tree nobody can work in, and Delete Session… tries to remove it');
  // The RECORD survives. Dropping the row on a missing path is the pre-v0.5.3
  // "upgrade kills my agents" bug; only the pointer goes.
  assert.strictEqual(eng.stores.persistence.get('hand-43').name, 'hand-43',
    'the record itself is kept');
});

test('a pre-t752 record — tree gone, no main — is left exactly as it was', () => {
  const eng = mkEngine();
  const root = mkTmpRoot('clx-resumecwd-nomain-');
  const tree = path.join(root, 'repo-t44');   // deliberately never created
  const entry = { name: 'hand-44', type: 'claude', cwd: tree, workspaceId: 'default', worktree: { path: tree, branch: 't44' } };
  eng.stores.persistence.upsert(entry);
  assert.strictEqual(fs.existsSync(tree), false, 'ENTER: the tree is gone, so the fallback was reachable');

  assert.strictEqual(eng.manager.resumeCwdOf(entry), tree,
    'with no main to fall back to there is no better answer than the cwd on the record — the spawn '
    + 'fails and the failed-tab UI offers retry/forget');
  assert.deepStrictEqual(eng.stores.persistence.get('hand-44').worktree, { path: tree, branch: 't44' },
    'and NOTHING is dropped: a missing cwd is not evidence the tree was removed — an unmounted volume '
    + 'takes the tree and the checkout together — so guessing here lands in the ABSENT state '
    + 'ALWAYS_PRESERVE calls the dangerous one');
});

after(() => { setImmediate(() => process.exit(0)); });
