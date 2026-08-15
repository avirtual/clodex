// ${TEAM_ROOT} expansion for template cwd (t415, stage 2).
//
// The failure direction carries the weight here. The property being defended is
// the one session-manager's exec expandVars comment states: substituting a WRONG
// (or empty) root is worse than refusing, because the seat boots successfully in
// another project's tree and every result downstream looks like its own. A test
// that only exercises the happy path passes straight over that bug — so every
// shape of "no root" gets its own assertion below.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { expandTeamRoot, usesTeamRoot, TEAM_ROOT_TOKEN } = require('../team-root-expand');

test('a template cwd of ${TEAM_ROOT} becomes the resolving team root', () => {
  assert.deepStrictEqual(
    expandTeamRoot('${TEAM_ROOT}', '/Users/x/projects/other'),
    { ok: true, value: '/Users/x/projects/other', expanded: true },
  );
});

test('the token expands mid-path and at every occurrence', () => {
  assert.deepStrictEqual(
    expandTeamRoot('${TEAM_ROOT}/sub:${TEAM_ROOT}', '/r'),
    { ok: true, value: '/r/sub:/r', expanded: true },
  );
});

test('a cwd without the token passes through untouched, root or no root', () => {
  // The dominant case: our own clodex-hand-seat.json holds an absolute path and
  // must keep working verbatim. Expansion may only rewrite the token.
  assert.deepStrictEqual(
    expandTeamRoot('/Users/bogdan/projects/tmux/wb-wrap-ui', ''),
    { ok: true, value: '/Users/bogdan/projects/tmux/wb-wrap-ui', expanded: false },
  );
  assert.deepStrictEqual(
    expandTeamRoot('/abs/path', '/some/root'),
    { ok: true, value: '/abs/path', expanded: false },
  );
});

// --- the failure direction: every way a root can fail to resolve -------------

test('an EMPTY root refuses instead of expanding to nothing', () => {
  const r = expandTeamRoot('${TEAM_ROOT}/scripts', '');
  assert.strictEqual(r.ok, false, 'an unresolved root must NOT produce a cwd');
  assert.strictEqual(r.value, undefined, 'a refusal carries no value to use by accident');
  assert.match(r.reason, /\$\{TEAM_ROOT\} does not resolve/);
});

test('a WHITESPACE-ONLY root refuses — it would resolve relative to the process cwd', () => {
  const r = expandTeamRoot('${TEAM_ROOT}', '   ');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.value, undefined);
});

test('a missing/undefined/null/non-string root refuses rather than stringifying', () => {
  // resolveTeam(...)?.root is undefined off a team; a caller that forgets the
  // `|| ''` must not get "undefined" spliced into a path.
  for (const root of [undefined, null, 0, {}, []]) {
    const r = expandTeamRoot('${TEAM_ROOT}', root);
    assert.strictEqual(r.ok, false, `root ${JSON.stringify(root)} must refuse`);
    assert.ok(!String(r.value ?? '').includes('undefined'), 'no stringified root leaks into a path');
  }
});

test('the refusal names the operator action, not just the failure', () => {
  // The reason string is relayed verbatim on the spawn channel and in a toast;
  // "it broke" without "here is the fix" costs the lead a round-trip.
  const { reason } = expandTeamRoot('${TEAM_ROOT}', '');
  assert.match(reason, /explicit cwd:/);
});

test('usesTeamRoot detects the token and only the token', () => {
  assert.strictEqual(usesTeamRoot('${TEAM_ROOT}/x'), true);
  assert.strictEqual(usesTeamRoot('/plain/path'), false);
  assert.strictEqual(usesTeamRoot('$TEAM_ROOT'), false, 'the bare shell form is NOT the token');
  assert.strictEqual(usesTeamRoot('${CLODEX_BIN}'), false);
  assert.strictEqual(usesTeamRoot(undefined), false);
  assert.strictEqual(usesTeamRoot(null), false);
});

test('the token literal matches the one the shipped template and exec defs write', () => {
  // These files are compared as data by other pins; a token rename that missed
  // one of them would silently stop expanding.
  assert.strictEqual(TEAM_ROOT_TOKEN, '${TEAM_ROOT}');
});
