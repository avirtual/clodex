// The `*` sentinel expander. A template cannot list skill names — they differ
// per box — so "no skills" ships as a sentinel and is resolved at spawn against
// the box's own catalog. Injected skills are the exception: a template that
// hands a seat a skill and then turns it off has shipped nothing.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { expandSkillsOff } = require('../skills-off');

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
