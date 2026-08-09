'use strict';
// scripts/hint-probe.js must IMPORT the ranker, never carry its own.
//
// The probe's whole value is answering "what would the app do with this draft".
// A copy makes it answer a different question the moment either side moves, and
// it had already moved: the probe filtered on MIN_SCORE=2, tuned when the store
// held 4 records, while production derives the floor from corpus size because
// at N=179 one maximally-rare term scores log(1+179)=5.19 unaided and clears
// any small constant. The probe was reporting hints the app would reject, and
// nothing failed — it is a script, so no test ran it and no scanner saw it.
//
// The suite already KNEW: test/hint-arm.test.js carries a comment saying the
// probe's constant does not transfer, while asserting only the app-side floor.
// Knowledge in a comment guards nothing, which is the point of this file.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROBE = path.join(__dirname, '..', 'scripts', 'hint-probe.js');
const SRC = fs.readFileSync(PROBE, 'utf8');

test('hint-probe imports the ranker from hint-retrieve', () => {
  const m = /require\(\s*['"]\.\.\/hint-retrieve['"]\s*\)/.exec(SRC);
  assert.ok(m, 'the probe must require ../hint-retrieve, or it is scoring by its own rules again');

  // ENTER: the require must actually bind `rank`. A require whose destructure
  // dropped rank would satisfy the regex above while leaving a local copy in
  // charge — the precise state this file exists to reject.
  const line = SRC.slice(SRC.lastIndexOf('\n', m.index) + 1, SRC.indexOf('\n', m.index));
  assert.match(line, /\brank\b/, `ENTER: the hint-retrieve require does not bind rank: ${line}`);
});

test('hint-probe defines no ranker of its own', () => {
  // Definitions only. The probe legitimately CALLS rank and compose, and an
  // over-broad match on the bare names would fail on the correct code.
  const copies = [
    [/^\s*function\s+rank\s*\(/m, 'rank'],
    [/^\s*function\s+score\s*\(/m, 'score'],
    [/^\s*function\s+terms\s*\(/m, 'terms'],
    [/^\s*function\s+haystack\s*\(/m, 'haystack'],
    [/^\s*function\s+compose\s*\(/m, 'compose'],
    [/^\s*const\s+STOP\s*=/m, 'STOP'],
    [/^\s*const\s+MIN_SCORE\s*=/m, 'MIN_SCORE'],
    [/^\s*const\s+FULL_BODY_CAP\s*=/m, 'FULL_BODY_CAP'],
  ];
  const found = copies.filter(([re]) => re.test(SRC)).map(([, name]) => name);
  assert.deepStrictEqual(
    found, [],
    `hint-probe re-defines ranker internals: ${found.join(', ')}. Import them from hint-retrieve — `
    + 'a second copy answers a different question than the app as soon as either moves.',
  );
});

test('no score floor is applied in the probe at all', () => {
  // The drift, stated as its own assertion. An earlier version of this test
  // matched `score >= <digit>` and so could not have caught the actual bug,
  // which compared against a NAMED constant (`r.score >= MIN_SCORE`) — a check
  // that cannot fail for the reason it was written for.
  //
  // The right assertion is stronger and simpler: the probe must not filter on
  // score at ALL. Production's rank already applies the derived floor, MIN_HITS
  // and coverage before returning, so any second cut here is either redundant
  // or a divergence — there is no correct version of this line.
  const floorCuts = SRC.match(/\bscore\s*(>=|>|<=|<)/g) || [];
  assert.deepStrictEqual(
    floorCuts, [],
    `the probe applies its own score cut (${floorCuts.join(', ')}); rank() already filtered — `
    + 'a second cut is how the N=4 constant survived next to a corpus-derived floor',
  );
});

test('CONTROL: the imported ranker really is the production one', () => {
  // Without this the tests above are satisfied by importing anything at all.
  // Pinning the identity means a future split of hint-retrieve cannot quietly
  // leave the probe importing a shim.
  const { rank, minScoreFor } = require('../hint-retrieve');
  assert.strictEqual(typeof rank, 'function');
  assert.strictEqual(typeof minScoreFor, 'function');

  // The floor MOVES with corpus size — the property the probe's constant lacked.
  const small = minScoreFor(4);
  const large = minScoreFor(179);
  assert.ok(large > small, `the floor must grow with the corpus, got ${small} -> ${large}`);
  assert.ok(Math.abs(large - Math.log(1 + 179)) < 0.01, 'the floor is log(1+N) by construction');
});
