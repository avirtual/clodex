'use strict';

// Every in-place restart path must carry the seat's session_id HISTORY.
//
// `sessionIds` is append-only and appended by exactly one writer — persistence
// setSessionId, and only when the id CHANGES. An in-place restart routes through
// kill(), which REMOVES the persistence record, and create() rebuilds it from
// spawn args writing only `sessionId`. So a restart that does not re-seed the
// array does not merely delay it: nothing ever regrows it, and the seat's
// lifetime cost (session-info trackedSessionIds → sumAgentCost, which sums the
// per-id ledger over the whole history) silently restarts from the current id.
// That is the "agent all-time total below current-session total" the panel
// showed on 2026-08-03.
//
// Two independent guards, because the failure is silent in both directions:
//  1. BEHAVIOUR — _preserveAcrossRestart carries ALWAYS_PRESERVE even when the
//     caller does not name it.
//  2. DISCOVERY — every call site in tracked source, found by scanning rather
//     than by a list written here, so a FOURTH caller added later is covered by
//     construction. The behaviour guard alone would let a new caller open-code
//     its own re-seed and skip the helper entirely.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Tracked .js sources only. Tracked, via git, for the reason the packaging
// guard established: a filesystem walk inherits every developer's local state
// (gitignored scratch, vendored copies, a stale checkout). Asking git asks the
// same oracle the repo uses. Unavailable git FAILS LOUDLY rather than silently
// narrowing the scan.
function trackedSources() {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '*.js'], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    assert.fail(`cannot enumerate tracked files via git (${e.message}) — this guard refuses to fall back to a filesystem walk`);
  }
  return out.split('\n').filter(Boolean).filter((f) => (
    // Tests name the method to assert about it; cli/ is a separate program.
    !f.startsWith('test/') && !f.startsWith('cli/') && !f.startsWith('web-dist/')
  ));
}

// Call sites, as { file, line, text }. The definition (`_preserveAcrossRestart(`
// preceded by nothing that makes it a call) is excluded by requiring a receiver
// — every call goes through `manager.` or `this.`.
const CALL_RE = /(?:manager|this)\._preserveAcrossRestart\s*\(/;

function callSites() {
  const found = [];
  for (const file of trackedSources()) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (!src.includes('_preserveAcrossRestart')) continue;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (CALL_RE.test(lines[i])) found.push({ file, line: i + 1, text: lines[i] });
    }
  }
  return found;
}

test('DISCOVERY: every _preserveAcrossRestart call site is a plain call into the helper', () => {
  const sites = callSites();
  // Three today: engine.restartSession, engine.applySessionArgs, the
  // [agent:context reload] intent. A drop to zero means the scanner stopped
  // matching (a rename, a destructured call) and every guard below went
  // vacuous — that is the failure this assertion exists to catch.
  assert.ok(sites.length >= 3,
    `expected at least 3 call sites, found ${sites.length} — the scanner has stopped seeing them, do not weaken this`);
  for (const s of sites) {
    // A call site that hand-rolls its own seed instead of passing a field array
    // would bypass ALWAYS_PRESERVE. Every site must pass the prior entry and a
    // literal array, i.e. read as `_preserveAcrossRestart(name, entry, [...])`
    // or `(name, entry, someFieldsVar)` — what it must NOT do is be the only
    // thing standing between the restart and a dropped history.
    assert.match(s.text, /_preserveAcrossRestart\([^,]+,\s*[^,]+,\s*[[A-Za-z]/,
      `${s.file}:${s.line}: call does not have the (name, priorEntry, fields) shape this guard can reason about`);
  }
});

test('DISCOVERY: every restart call site preserves the seat-identity fields', () => {
  // The shape guard above passes a call whose array is EMPTY or short — it
  // checks the (name, entry, [...]) form, not what is in the brackets. That is
  // how the reload site drifted: it passed ['createdAt'] while its two siblings
  // in engine.js passed four fields, so it was structurally identical and
  // semantically the odd one out, and nothing failed.
  //
  // `ephemeral` is the load-bearing one. It is what tells `task accept` whether
  // the ticket loop minted a seat; dropped across a restart, a ticket seat reads
  // as the operator's standing seat and accept skips its teardown, leaks the
  // worktree, and says "it is not a one-shot ticket seat" — false. `reviewFor`
  // and `reviewTicket` are the same fact for reviewer seats.
  const REQUIRED = ['ephemeral', 'reviewFor', 'reviewTicket', 'createdAt'];
  const sites = callSites();
  // ENTER: the fields are read off a literal array on the same line. A site that
  // passes a VARIABLE (engine.js builds one) is resolved to its declaration; if
  // neither shape matches, this guard would silently check nothing.
  let checked = 0;
  for (const s of sites) {
    const src = fs.readFileSync(path.join(ROOT, s.file), 'utf8');
    let arr = /_preserveAcrossRestart\([^,]+,\s*[^,]+,\s*\[([^\]]*)\]/.exec(s.text);
    if (!arr) {
      // `(name, entry, someVar)` — find `const someVar = [...]` in the file.
      const varName = /_preserveAcrossRestart\([^,]+,\s*[^,]+,\s*([A-Za-z_$][\w$]*)\s*\)/.exec(s.text);
      if (varName) arr = new RegExp(`${varName[1]}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src);
    }
    assert.ok(arr, `${s.file}:${s.line}: cannot read the field list — this guard must not pass by failing to look`);
    const fields = arr[1].split(',').map((f) => f.trim().replace(/^['"`]|['"`]$/g, '')).filter(Boolean);
    for (const req of REQUIRED) {
      assert.ok(fields.includes(req),
        `${s.file}:${s.line}: restart drops \`${req}\` — every restart path must carry it, or the seat comes back as a different KIND of seat than it was`);
    }
    checked += 1;
  }
  assert.ok(checked >= 3, `expected to check at least 3 call sites, checked ${checked}`);
});

test('DISCOVERY: no restart path re-seeds persistence by hand instead of using the helper', () => {
  // engine.js and session-manager.js are the only files with restart seams.
  // A `kill(` followed within 12 lines by a `create(` and NO
  // _preserveAcrossRestart between them is a restart that drops the record and
  // never re-seeds — the exact shape of the bug, added by a fourth caller who
  // copied the surrounding code but not the preserve line.
  for (const file of ['engine.js', 'session-manager.js']) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/await\s+(?:manager|this)\.kill\(/.test(lines[i])) continue;
      const window = lines.slice(i, i + 12);
      const createAt = window.findIndex((l) => /(?:manager|this)\.create\(/.test(l));
      if (createAt < 0) continue;
      const between = window.slice(0, createAt).join('\n');
      assert.ok(between.includes('_preserveAcrossRestart'),
        `${file}:${i + 1}: kill() → create() with no _preserveAcrossRestart between them — this restart drops sessionIds (and every other post-create field) with no way to regrow it`);
    }
  }
});

// t491. The success path is not the only writer of a pre-kill snapshot: every
// restart's CATCH arm re-upserts one wholesale, and that arm is the LIKELIER one
// in the scenario the guard exists for — the window is held open by a CLI slow to
// die, and a CLI slow enough to hold it past waitForSessionExit's 8s is the one
// whose restart then throws. An arm that restores `worktree` while another live
// seat holds the checkout puts a second record on one tree.
//
// A SOURCE-SHAPE guard, and deliberately so. Two of the three arms are reachable
// at runtime only behind fixtures heavy enough that the pin would live somewhere
// nobody looks (this was found by vacuity-proving each site: deleting the guard on
// the reload and applySessionArgs arms left the whole suite green). The invariant
// is a property of the SOURCE — "no snapshot-restoring upsert bypasses the single
// occupancy reader" — so it is asserted as one. Per CLAUDE.md: this comment claims
// coverage, and the claim and the test land in the same commit.
test('t491: every restart catch arm restores its snapshot through the tree guard', () => {
  // The three arms, by the variable each one restores. Named rather than
  // discovered, because the assertion is about a specific hazardous SHAPE and a
  // scanner broad enough to find it by itself would match every upsert in the repo.
  const ARMS = [
    { file: 'engine.js', restores: 'entry', what: 'restartSession' },
    { file: 'engine.js', restores: '{ ...beforeKill,', what: 'applySessionArgs' },
    { file: 'session-manager.js', restores: 'entry', what: '[agent:context reload]' },
  ];
  const seen = [];
  for (const file of ['engine.js', 'session-manager.js']) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      // An upsert restoring a pre-kill snapshot: the argument is `entry`,
      // `beforeKill`, or an object literal spreading one of them.
      const m = /(?:persistence|getPersistence\(\))\.upsert\(([^;]*)\)/.exec(lines[i]);
      if (!m) continue;
      const arg = m[1];
      if (!/\bentry\b|\bbeforeKill\b/.test(arg)) continue;
      seen.push({ file, line: i + 1, arg });
      assert.match(arg, /_stripClaimedTree\(/,
        `${file}:${i + 1}: this arm restores a pre-kill snapshot without routing it through _stripClaimedTree — `
        + 'if another live seat took the checkout while the restart was in flight, this write puts a SECOND '
        + 'record on one tree, and session:kill on either row force-removes it under the seat living in it');
    }
  }
  // ENTER: the scanner must still be finding all three. A regex that stopped
  // matching would make every assertion above vacuous — this guard's own failure
  // mode, and the one it cannot detect from inside the loop.
  assert.strictEqual(seen.length, ARMS.length,
    `expected ${ARMS.length} snapshot-restoring upserts (${ARMS.map((a) => a.what).join(', ')}), found ${seen.length} `
    + `(${seen.map((s) => `${s.file}:${s.line}`).join(', ')}) — the scanner has stopped seeing them, do not weaken this`);
  // And the spread-literal arm specifically: the helper must wrap the ASSEMBLED
  // object, not `beforeKill`, or the spread that actually reaches the store undoes
  // the strip. Asserting the shape because the two read almost identically.
  const spread = seen.find((s) => s.arg.includes('...beforeKill'));
  assert.ok(spread, 'ENTER: the applySessionArgs arm must still be a spread literal, or this check is about nothing');
  assert.match(spread.arg, /_stripClaimedTree\(\{\s*\.\.\.beforeKill/,
    `${spread.file}:${spread.line}: the guard must wrap the assembled object — wrapping \`beforeKill\` alone is undone `
    + 'by the spread that follows it, which is what actually reaches the store');
});

// --- BEHAVIOUR ---

function mkPersistence() {
  const store = [];
  return {
    store,
    list: () => store,
    get: (n) => store.find((e) => e.name === n) || null,
    upsert: (e) => {
      const i = store.findIndex((x) => x.name === e.name);
      if (i >= 0) store[i] = { ...store[i], ...e }; else store.push({ ...e });
    },
  };
}

// The helper in isolation, against the real module. Loading session-manager
// bare (no Electron) is what the rest of the suite already does. Deps are the
// minimum the CLASS BODY needs; _preserveAcrossRestart itself touches only
// getPersistence, so anything else it reached would throw rather than silently
// no-op — which is the behaviour I want from this harness.
function mkManager(persistence) {
  const { createSessionManager } = require('../session-manager');
  const SessionManager = createSessionManager({
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    notifyOS: () => {},
    fs: require('node:fs'),
  });
  return new SessionManager();
}

test('BEHAVIOUR: sessionIds is carried even when the caller does not ask for it', () => {
  const p = mkPersistence();
  const m = mkManager(p);
  // The reload intent's field list — createdAt only. This is verbatim the call
  // that was dropping the history.
  m._preserveAcrossRestart('cx', { name: 'cx', createdAt: 1, sessionIds: ['a', 'b'] }, ['createdAt']);
  assert.deepStrictEqual(p.get('cx').sessionIds, ['a', 'b'],
    'history carried without being named — an opt-in list is what all three callers got wrong');
  assert.strictEqual(p.get('cx').createdAt, 1, 'the requested field still carries');
});

test('BEHAVIOUR: an empty field list still carries the history', () => {
  const p = mkPersistence();
  const m = mkManager(p);
  // The old guard was `if (!fields.length) return`, which would have made this
  // a no-op. A caller with nothing of its own to preserve still must not drop
  // append-only history.
  m._preserveAcrossRestart('cx', { name: 'cx', sessionIds: ['a'] }, []);
  assert.deepStrictEqual(p.get('cx').sessionIds, ['a'], 'empty list is not a licence to drop history');
});

test('BEHAVIOUR: a seat with no history is still not seeded', () => {
  const p = mkPersistence();
  const m = mkManager(p);
  // ALWAYS_PRESERVE must not manufacture a record for a genuinely fresh seat —
  // that would hand create() an existingEntry and suppress the roster inject.
  m._preserveAcrossRestart('fresh', { name: 'fresh' }, ['rosterSentAt']);
  assert.strictEqual(p.get('fresh'), null, 'nothing present to preserve seeds nothing');
});

test('BEHAVIOUR: the seeded history survives create()\'s rebuild upsert', () => {
  const p = mkPersistence();
  const m = mkManager(p);
  m._preserveAcrossRestart('cx', { name: 'cx', sessionIds: ['a', 'b'] }, []);
  // create() rebuilds the record from spawn args — it writes sessionId, never
  // sessionIds — and its upsert spread-merges OVER the stub. That merge order
  // is the whole reason re-seeding before create() works.
  p.upsert({ name: 'cx', type: 'claude', cwd: '/proj', sessionId: 'c' });
  assert.deepStrictEqual(p.get('cx').sessionIds, ['a', 'b'], 'history survives the rebuild');
  assert.strictEqual(p.get('cx').sessionId, 'c', 'and the rebuild still writes the current id');
});

// --- t491: the tree-claim guard, driven directly ---
//
// `_stripClaimedTree` is the ONE reader of tree occupancy for every path that
// writes a pre-kill snapshot back: the preserve on the success path, and the
// three restart CATCH arms (engine.js restartSession / applySessionArgs, the
// [agent:context reload] intent), which re-upsert the snapshot wholesale.
//
// Driven here rather than only through the integration exhibit in
// test/preserve-tree-handoff.test.js, and that is the point of these four: the
// exhibit's fixture models create()'s rebuild upsert, which re-writes the record
// anyway — so an assertion downstream of it can be satisfied by the HARNESS
// rather than by the code, and the reduced-seed branch in particular was
// exercised by nothing. These call the helper with nothing between it and the
// assertion.
//
// `_ticketTreeHolder` is stubbed because it is the INPUT to the decision under
// test, not part of it; it is grafted onto the prototype from team-tickets.js and
// has its own coverage. What must not be stubbed is the decision itself.

test('t491: the worktree seed is DROPPED when a different live seat holds the tree', () => {
  const p = mkPersistence();
  const m = mkManager(p);
  m._ticketTreeHolder = (path) => (path === '/trees/t1' ? 'other-seat' : null);
  m._preserveAcrossRestart('cx', { name: 'cx', worktree: { path: '/trees/t1', branch: 'b' }, sessionIds: ['a'] }, []);
  const rec = p.get('cx');
  assert.ok(rec, 'ENTER: the record must still be seeded — the guard drops one FIELD, never the whole seed');
  assert.strictEqual('worktree' in rec, false,
    'the pointer must not be written back: another live seat holds that checkout, and a second record naming '
    + 'it lets Delete Session… on this row force-remove the tree the other seat is committing in');
  assert.deepStrictEqual(rec.sessionIds, ['a'],
    'and every OTHER preserved field still rides — dropping the tree must not cost the seat its history');
});

test('t491: the seed is KEPT when the holder is the seat itself', () => {
  const p = mkPersistence();
  const m = mkManager(p);
  // Reachable on the catch arms: create() can succeed and a LATER step throw,
  // which leaves the seat live with a rebuilt record already naming the tree —
  // so the holder resolved there is the seat's own name. `holder != null` would
  // strip a pointer nothing else holds.
  m._ticketTreeHolder = () => 'cx';
  m._preserveAcrossRestart('cx', { name: 'cx', worktree: { path: '/trees/t1', branch: 'b' } }, []);
  assert.deepStrictEqual(p.get('cx').worktree, { path: '/trees/t1', branch: 'b' },
    'a seat that still holds its own tree keeps the pointer — stripping it would orphan the checkout, which is '
    + 'the failure ALWAYS_PRESERVE put this field on the list to prevent');
});

test('t491: a throwing occupancy read KEEPS the pointer — stale beats absent', () => {
  const p = mkPersistence();
  const m = mkManager(p);
  m._ticketTreeHolder = () => { throw new Error('board unreadable'); };
  m._preserveAcrossRestart('cx', { name: 'cx', worktree: { path: '/trees/t1', branch: 'b' } }, []);
  assert.deepStrictEqual(p.get('cx').worktree, { path: '/trees/t1', branch: 'b' },
    'the failure direction is deliberate and is the same asymmetry that put `worktree` in ALWAYS_PRESERVE: a '
    + 'stale pointer fails removeWorktree and KEEPS the record, an absent one makes destroy() drop the record '
    + 'and report success over an orphaned tree');
});

test('t491: a seed reduced to nothing but the tree does not manufacture a record', () => {
  const p = mkPersistence();
  const m = mkManager(p);
  m._ticketTreeHolder = () => 'other-seat';
  // The branch the integration test cannot reach: with `worktree` stripped this
  // seed is a bare { name }, and seeding it would hand create() an existingEntry
  // and suppress the roster inject — the same failure the original `any` guard
  // exists to prevent, arrived at by a different route.
  m._preserveAcrossRestart('solo', { name: 'solo', worktree: { path: '/trees/t1', branch: 'b' } }, []);
  assert.strictEqual(p.get('solo'), null,
    'a seed with nothing left after the strip must write NOTHING — a bare { name } record reads as a resumed '
    + 'seat and costs it the roster its restart was supposed to deliver');
});
