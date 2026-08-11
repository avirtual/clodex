'use strict';
// name-suggest.test.js — the New Session dialog's default-name bump leaf (Task 19
// item 1). Pure: given a base suggestion + the reserved-name set, advance past a
// collision so the user's first Create doesn't bounce.

const test = require('node:test');
const assert = require('node:assert');
const { bumpDefaultName, teamNamePrefill, TEAM_NAME_MAX } = require('../renderer/lib/name-suggest');

test('free base is returned untouched', () => {
  assert.strictEqual(bumpDefaultName('session-1', new Set()), 'session-1');
  assert.strictEqual(bumpDefaultName('session-3', new Set(['session-1', 'session-2'])), 'session-3');
});

test('collision increments the trailing integer, staying in session-N form', () => {
  assert.strictEqual(bumpDefaultName('session-1', new Set(['session-1'])), 'session-2');
  assert.strictEqual(
    bumpDefaultName('session-1', new Set(['session-1', 'session-2', 'session-3'])),
    'session-4',
  );
});

test('bumps from the base number, not from 1', () => {
  assert.strictEqual(bumpDefaultName('session-5', new Set(['session-5', 'session-6'])), 'session-7');
});

test('accepts an array of taken names as well as a Set', () => {
  assert.strictEqual(bumpDefaultName('session-1', ['session-1', 'session-2']), 'session-3');
});

test('a base without a trailing number gets a -2, -3 suffix', () => {
  assert.strictEqual(bumpDefaultName('agent', new Set(['agent'])), 'agent-2');
  assert.strictEqual(bumpDefaultName('agent', new Set(['agent', 'agent-2'])), 'agent-3');
});

test('null / undefined reserved → base returned (nothing taken)', () => {
  assert.strictEqual(bumpDefaultName('session-1', null), 'session-1');
  assert.strictEqual(bumpDefaultName('session-1', undefined), 'session-1');
});

// teamNamePrefill — the Create Team… dialog's proposed name (t288). The dialog
// must never PREFILL a name its own writer refuses: the operator did not type it,
// so the refusal reads as a bug in the app rather than a correction of them.

test('teamNamePrefill strips the leading dot slugifyTeamName leaves behind', () => {
  // A root of `…/.dotfiles` slugs to `.dotfiles`, which createTeam refuses:
  // listTeams skips dot-directories, so the team would be invisible.
  assert.strictEqual(teamNamePrefill('.dotfiles', []), 'dotfiles');
  assert.strictEqual(teamNamePrefill('...deep', []), 'deep', 'several dots, not just one');
  assert.strictEqual(teamNamePrefill('mid.dot', []), 'mid.dot', 'an interior dot is legal, keep it');
  assert.strictEqual(teamNamePrefill('...', []), '', 'nothing left to propose');
});

test('teamNamePrefill clamps so the DEFAULT lead seat still fits', () => {
  // The seat is `<team>-lead`, capped at 64 by NAME_RE — so the team name caps
  // at 59. Pinned at the boundary in both directions.
  assert.strictEqual(TEAM_NAME_MAX, 59);
  assert.strictEqual(teamNamePrefill('a'.repeat(59), []).length, 59, 'exactly at the limit is untouched');
  assert.strictEqual(teamNamePrefill('a'.repeat(200), []).length, 59, 'and anything longer is cut to it');
});

test('teamNamePrefill clamps AFTER the dedupe suffix, not before', () => {
  // The suffix is appended to an already-clamped base, so a name that just fits
  // must not be pushed back over the limit by its own `-2`.
  const base = 'a'.repeat(59);
  const out = teamNamePrefill(base, [base]);
  assert.ok(out.length <= TEAM_NAME_MAX, `dedupe must not overflow the limit, got ${out.length}`);
  // ENTER: the dedupe really ran — without it this test would pass on a plain clamp.
  assert.notStrictEqual(teamNamePrefill('proj', ['proj']), 'proj', 'a taken name is still bumped');
  assert.strictEqual(teamNamePrefill('proj', ['proj']), 'proj-2');
});
