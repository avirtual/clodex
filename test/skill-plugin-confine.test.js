'use strict';
// skill-plugin-confine.test.js — t114, the highest-consequence join in the app.
//
// writeSkillPlugin/cleanupSkillPlugin do `fs.rmSync(dir, {recursive:true})` on
// a dir built by joining the SESSION NAME onto ~/.clodex/skill-plugins. A name
// of `..` resolves that to ~/.clodex; `../..` resolves it to $HOME. The rmSync
// sits ABOVE the no-skills bail, so it fires on every claude spawn regardless
// of whether any skill is injected.
//
// WHY THIS FILE IS SOURCE-LEVEL AND NOT BEHAVIOURAL.
//
// Both functions are module-private in engine.js and reachable only through
// createSessionManager's deps object — there is no exported seam to call. More
// importantly SKILL_PLUGINS_DIR is module-scoped over the REAL ~/.clodex, with
// no injection point, so a behavioural test of the traversal cases would be
// safe ONLY while the guard works. The first time someone reverted the product
// to check the test fails, it would delete their actual home directory. That is
// not a test worth having at any strength.
//
// So: confine() itself is proven behaviourally against a temp root in
// test/path-confine.test.js, and THIS file pins the two properties that can
// only be established here — that each destructive call site is guarded, and
// that the guard precedes the delete.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf-8');

// The body of a top-level `function name(` up to its closing brace at column 0.
function bodyOf(fn) {
  const start = SRC.indexOf(`function ${fn}(`);
  assert.ok(start !== -1, `${fn} not found in engine.js`);
  const rest = SRC.slice(start);
  const end = rest.indexOf('\n}\n');
  assert.ok(end !== -1, `${fn} body not delimited`);
  return rest.slice(0, end);
}

// Both scaffolders are the same hazard over a different root, so the pins are
// one table: <function, the root it must confine against>. A new plugin
// scaffolder that forgets its row here is the case this shape exists to make
// hard to reach — the row is the only place the root is named.
const CONFINED = [
  ['writeSkillPlugin', 'SKILL_PLUGINS_DIR'],
  ['cleanupSkillPlugin', 'SKILL_PLUGINS_DIR'],
  ['writeAgentPlugin', 'AGENT_PLUGINS_DIR'],
  ['cleanupAgentPlugin', 'AGENT_PLUGINS_DIR'],
];

test('every recursive delete of a plugin-scaffold dir is confined first', () => {
  for (const [fn, root] of CONFINED) {
    const body = bodyOf(fn);
    const guard = body.indexOf(`confine(${root}`);
    const del = body.indexOf('fs.rmSync');

    assert.ok(del !== -1, `${fn} still contains the rmSync this guards — if it moved, move this test`);
    assert.ok(guard !== -1, `${fn} must confine the session name before joining it`);
    // A guard placed AFTER the delete would satisfy "is present" while the
    // wrong tree was already gone. Ordering is the whole property.
    assert.ok(guard < del, `${fn}: confinement must come BEFORE the recursive delete`);

    // And the raw join must be gone, not merely supplemented — leaving it
    // would mean the confined value is computed and then ignored.
    assert.ok(!body.includes(`path.join(${root}, name)`),
      `${fn} must not still build the dir with an unconfined path.join`);
  }
});

test('the two roots are siblings, so neither rebuild deletes the other', () => {
  // Each scaffolder rm -rf's <its root>/<session> on every spawn. Nesting the
  // agent root inside the skill root (or vice versa) would make one overlay's
  // rebuild silently delete the other's dir for the same session — the spawn
  // would then pass a --plugin-dir that no longer exists.
  const skill = SRC.match(/^const SKILL_PLUGINS_DIR = .*$/m);
  const agent = SRC.match(/^const AGENT_PLUGINS_DIR = .*$/m);
  assert.ok(skill && agent, 'both roots are declared at module scope');
  const leafOf = (line) => line[0].match(/'([^']+)'\)/)[1];
  const a = leafOf(skill);
  const b = leafOf(agent);
  assert.notStrictEqual(a, b, 'the two scaffold roots must be distinct dirs');
  assert.ok(!a.startsWith(`${b}/`) && !b.startsWith(`${a}/`),
    'neither scaffold root may nest inside the other');
});

test('the write/cleanup call sites fail DIFFERENTLY, and deliberately so', () => {
  // The write path throws: a spawn under a name that cannot be confined must
  // abort rather than continue with a half-built plugin dir.
  for (const fn of ['writeSkillPlugin', 'writeAgentPlugin']) {
    assert.match(bodyOf(fn), /throw new Error\(`invalid session name/,
      `${fn} aborts the spawn on a refused name`);
  }
  // The cleanup path returns: it runs on exit, where throwing would break
  // teardown for an unrelated session.
  for (const fn of ['cleanupSkillPlugin', 'cleanupAgentPlugin']) {
    assert.match(bodyOf(fn), /if \(dir === null\) return;/,
      `${fn} refuses silently on the teardown path`);
  }
});

test('the spill join documents why it does NOT need confine()', () => {
  // engine.js's other name-into-path join (MSG_DIR/<recipient>) carried a
  // comment asserting the charset made it "safe as a path". That inference was
  // false — `.` and `..` are in the charset. It is safe today for a different
  // reason (t115 made dot-only names unrepresentable), and the comment has to
  // say which, or the next reader inherits the same wrong model.
  const spill = bodyOf('spillToFile');
  assert.ok(spill.includes('path.join(MSG_DIR, recipient)'), 'the join is still here');
  // Asserting on the CLAIM, not on a substring: the corrected comment quotes
  // the old phrase in order to negate it ("...does not make them safe as a
  // path"), so a bare `doesNotMatch(/safe as a path/)` fails on the fix itself.
  assert.doesNotMatch(spill, /(?<!does not make them )safe as a path/,
    'the false inference must not survive as an assertion');
  assert.match(spill, /dot-only|t115/,
    'the comment must name what actually makes this join safe');
});
