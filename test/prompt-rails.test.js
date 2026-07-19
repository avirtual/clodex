// Run: node --test
// prompt-rails: the append-rail filter behind the team join picker
// (docs/teams-design.md "Front door"). The picker attaches its pick to the
// append rail, so it may ONLY offer append-rail prompts: stock clodex-team-*
// deltas (always) plus library prompts whose front matter declares
// `rail: append`. Undeclared (replace-class) prompts are excluded so a
// replace-class prompt never silently blends onto an append rail.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { railOf, isAppendRail, appendRailPrompts } = require('../prompt-rails');

test('railOf parses a leading front-matter rail value, null when absent', () => {
  assert.strictEqual(railOf('---\nrail: append\n---\nbody'), 'append');
  assert.strictEqual(railOf('---\nrail: replace\n---\n'), 'replace');
  assert.strictEqual(railOf('---\ntitle: x\nrail:   Append  \n---\n'), 'append'); // trim + lowercase
  assert.strictEqual(railOf('no front matter here'), null);
  assert.strictEqual(railOf('---\ntitle: x\n---\n'), null); // front matter, no rail key
  assert.strictEqual(railOf(null), null);
});

test('isAppendRail: session-class stock clodex-team-* qualify; lead/reviewer never do', () => {
  assert.strictEqual(isAppendRail('clodex-team-hand', 'no front matter'), true, 'stock session delta qualifies by name');
  assert.strictEqual(isAppendRail('clodex-team-custom', ''), true);
  // The non-session-class stock prompts are excluded even though they match the
  // stock-name rule — the join picker is session-class only.
  assert.strictEqual(isAppendRail('clodex-team-lead', ''), false, 'lead prompt excluded (there is one lead)');
  assert.strictEqual(isAppendRail('clodex-team-reviewer', ''), false, 'reviewer prompt excluded (subagent-class)');
  assert.strictEqual(isAppendRail('my-delta', '---\nrail: append\n---\n'), true, 'declared append qualifies');
  assert.strictEqual(isAppendRail('house-rules', '---\nrail: replace\n---\n'), false, 'replace-class excluded');
  assert.strictEqual(isAppendRail('bare-prompt', 'just a prompt body'), false, 'undeclared excluded');
});

test('appendRailPrompts filters { name, body } rows to the picker offering', () => {
  const prompts = [
    { name: 'clodex-team-hand', body: 'stock delta' },       // session-class stock → in
    { name: 'clodex-team-lead', body: 'stock delta' },       // non-session stock → OUT
    { name: 'clodex-team-reviewer', body: 'stock delta' },   // non-session stock → OUT
    { name: 'reviewer-plus', body: '---\nrail: append\n---\nx' }, // declared → in
    { name: 'full-persona', body: '---\nrail: replace\n---\nx' }, // excluded
    { name: 'legacy', body: 'no front matter' },             // excluded
  ];
  assert.deepStrictEqual(
    appendRailPrompts(prompts),
    ['clodex-team-hand', 'reviewer-plus'],
  );
  assert.deepStrictEqual(appendRailPrompts([]), []);
  assert.deepStrictEqual(appendRailPrompts(null), []);
});
