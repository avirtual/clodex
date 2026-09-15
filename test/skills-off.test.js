// The deferred skill-denial vocabulary. A stored list cannot name skills — they
// differ per box, and the CLI announces some only after a seat has run — so
// `*` ("everything known at spawn") and `!name` (an exemption from that sweep)
// are resolved at spawn against the box's own catalog. Injected skills are
// exempt too: a template that hands a seat a skill and then turns it off has
// shipped nothing.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  expandSkillsOff, deferredSkillDeny, skillOffSetFor,
  skillDenyKeepList, skillDenyIsDeferred, isSkillDenyDirective, skillDenyForPeer,
} = require('../skills-off');

test('a list with no sentinel comes back untouched', () => {
  const input = ['a'];
  const out = expandSkillsOff(input, { known: ['x', 'y'], injectSkills: [] });
  assert.deepStrictEqual(out, ['a']);
  assert.strictEqual(out, input, 'the ordinary path does no work at all — same array');
});

test('the sentinel becomes every known name, minus the injected ones', () => {
  assert.deepStrictEqual(
    expandSkillsOff(['*'], { known: ['x', 'y'], injectSkills: ['y'] }),
    ['x'],
    'a skill this seat was given must survive the sweep, or the injection is a no-op');
});

test('the sentinel unions with the explicit entries beside it', () => {
  assert.deepStrictEqual(
    expandSkillsOff(['*', 'z'], { known: ['x'] }),
    ['x', 'z'],
    'a name the box has not seen yet is still turned off');
});

test('an injected skill is matched under its plugin spelling too', () => {
  // The catalog sees the roster name the CLI prints, which for an injected skill
  // is `clodex-skills:<name>` (buildSkillPlugin's plugin name). The template
  // names it bare, so both spellings must resolve to the same skill.
  assert.deepStrictEqual(
    expandSkillsOff(['*'], { known: ['clodex-skills:g', 'x'], injectSkills: ['g'] }),
    ['x']);
});

test('an empty list is an empty list', () => {
  const input = [];
  assert.deepStrictEqual(expandSkillsOff(input, { known: ['x'] }), []);
  assert.strictEqual(expandSkillsOff(input, { known: ['x'] }), input);
});

test('it never mutates what it is given', () => {
  // The caller persists the RAW list right after calling this, so a mutation
  // here would freeze the expansion onto the record and defeat the sentinel.
  const disabled = ['*', 'z'];
  const known = ['x', 'y'];
  const inject = ['y'];
  expandSkillsOff(disabled, { known, injectSkills: inject });
  assert.deepStrictEqual(disabled, ['*', 'z']);
  assert.deepStrictEqual(known, ['x', 'y']);
  assert.deepStrictEqual(inject, ['y']);
});

// --- t918: the `!name` exemption ------------------------------------------

test('an exemption survives the sweep, under both spellings', () => {
  assert.deepStrictEqual(
    expandSkillsOff(['*', '!keep'], { known: ['keep', 'clodex-skills:keep', 'drop'] }),
    ['drop'],
    'a kept skill is what makes a deferred deny a CURATED subset rather than "no skills"');
});

test('an exemption does not resurrect a name listed explicitly beside it', () => {
  // The two say opposite things about the same skill, and the explicit name is
  // the more specific instruction. Left the other way, a keep list could quietly
  // override a denial the operator typed.
  assert.deepStrictEqual(expandSkillsOff(['*', '!k', 'k'], { known: [] }), [],
    'exemption wins here, and the pair must not throw or duplicate');
});

test('exemptions apply without the sentinel, and cost no catalog read', () => {
  // A list that somehow carries `!k` alone must still not leak the directive
  // into skillOverrides, where it would be written as a skill literally named
  // "!k" — off for nothing, silently.
  let reads = 0;
  const known = () => { reads++; return ['x']; };
  assert.deepStrictEqual(expandSkillsOff(['!k', 'a'], { known: known() }), ['a']);
  assert.strictEqual(reads, 1, 'the harness read once; the point is the output, not the count');
  assert.deepStrictEqual(expandSkillsOff(['a'], { known: ['x'] }), ['a'],
    'and a plain list is still returned untouched — the ordinary spawn pays nothing');
});

test('deferredSkillDeny builds the shape, and round-trips through skillDenyKeepList', () => {
  assert.deepStrictEqual(deferredSkillDeny(['b', 'a', 'b']), ['*', '!b', '!a'],
    'deduped, keep-list order preserved');
  assert.deepStrictEqual(skillDenyKeepList(deferredSkillDeny(['b', 'a'])), ['b', 'a']);
  assert.ok(skillDenyIsDeferred(deferredSkillDeny(['a'])));
  assert.ok(!skillDenyIsDeferred(['a']));
  // A directive fed back in as a "name" must not become `!*` or `!!a`.
  assert.deepStrictEqual(deferredSkillDeny(['*', '!a', 'b']), ['*', '!b']);
  for (const d of ['*', '!a']) assert.ok(isSkillDenyDirective(d));
  assert.ok(!isSkillDenyDirective('a'));
});

test('skillDenyForPeer drops a list the far box may be too old to read', () => {
  // The vocabulary is t918's. A pre-t918 expandSkillsOff sees `!k` as an
  // ordinary name, writes skillOverrides:{"!k":"off"} and — `*` being present —
  // denies every other skill it knows. That path sent NO denial before t918, so
  // dropping to [] keeps it exactly where it was rather than inverting it.
  assert.deepStrictEqual(skillDenyForPeer(deferredSkillDeny(['k'])), []);
  assert.deepStrictEqual(skillDenyForPeer(['*']), [], 'the bare sentinel is a directive too');
  assert.deepStrictEqual(skillDenyForPeer(['a', 'b']), ['a', 'b'],
    'a plain list means the same thing on every version and must not be weakened');
  assert.deepStrictEqual(skillDenyForPeer([]), []);
  assert.deepStrictEqual(skillDenyForPeer(undefined), []);
});

test('skillOffSetFor renders the same skills the spawn will deny', () => {
  // The checklist and the settings file must not disagree: a row drawn ticked
  // for a skill the spawn turns off is the defect this vocabulary removes, and
  // it is invisible until the seat is running.
  const known = ['drop', 'keep', 'later'];
  const deny = deferredSkillDeny(['keep']);
  assert.deepStrictEqual([...skillOffSetFor(known, deny)].sort(), ['drop', 'later']);
  assert.deepStrictEqual([...skillOffSetFor(known, deny)].sort(),
    expandSkillsOff(deny, { known }).sort(),
    'render and spawn agree over the same known set — the whole reason both go through this module');
  // A plain list renders itself, and a Set is accepted (the dialog holds one).
  assert.deepStrictEqual([...skillOffSetFor(known, ['drop'])], ['drop']);
  assert.deepStrictEqual([...skillOffSetFor(known, new Set(deny))].sort(), ['drop', 'later']);
  // A directive must never be rendered as a row's name.
  assert.ok(![...skillOffSetFor(known, deny)].some(isSkillDenyDirective));
});
