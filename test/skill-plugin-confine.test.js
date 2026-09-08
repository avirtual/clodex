'use strict';
// skill-plugin-confine.test.js — t114, the highest-consequence join in the app.
//
// The skill-delivery adapters do `fs.rmSync(dir, {recursive:true})` on a dir
// built by joining the SESSION NAME onto ~/.clodex/skill-plugins. A name of
// `..` resolves that to ~/.clodex; `../..` resolves it to $HOME. The rmSync
// sits ABOVE the no-skills bail, so it fires on every agent spawn regardless
// of whether any skill is injected.
//
// WHY THE TRAVERSAL CASES ARE SOURCE-LEVEL AND NOT BEHAVIOURAL.
//
// A behavioural test of the traversal cases would be safe ONLY while the guard
// works: the first time someone reverted the product to check the test fails,
// the rmSync would land on whatever `..` resolves to. That is not a test worth
// having at any strength, and no seam changes it — skill-delivery.js exports a
// factory, and calling it with `name: '..'` is exactly the delete this forbids.
//
// So: confine() itself is proven behaviourally against a temp root in
// test/path-confine.test.js, and the subjects below pin the two properties that
// can only be established here — that each destructive call site is guarded,
// and that the guard precedes the delete.
//
// The manifest subject at the bottom of this file IS behavioural, and safely so:
// it drives writeBundlePlugins on a WELL-FORMED name and id, so no arm of it
// depends on the guard holding. It reaches the real function through the deps
// object, over a registryDir seam (t359) that keeps every path under a temp root.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');

// Wrap, don't replace: the engine gets the real manager back, and we keep the
// deps object it was built with — the only route to a module-private scaffolder.
const sessionManagerModule = require('../session-manager');
const capturedDeps = [];
const realSessionManagerFactory = sessionManagerModule.createSessionManager;
sessionManagerModule.createSessionManager = (deps) => {
  capturedDeps.push(deps);
  return realSessionManagerFactory(deps);
};
const { createEngine } = require('../engine');

const srcCache = new Map();
function srcOf(file) {
  if (!srcCache.has(file)) srcCache.set(file, fs.readFileSync(path.join(__dirname, '..', file), 'utf-8'));
  return srcCache.get(file);
}
const SRC = srcOf('engine.js');

// The body of a top-level `function name(` up to its closing brace at column 0.
function bodyOf(fn, file = 'engine.js') {
  const src = srcOf(file);
  const start = src.indexOf(`function ${fn}(`);
  assert.ok(start !== -1, `${fn} not found in ${file}`);
  const rest = src.slice(start);
  const end = rest.indexOf('\n}\n');
  assert.ok(end !== -1, `${fn} body not delimited`);
  return rest.slice(0, end);
}

// Every scaffolder is the same hazard over a different root, so the pins are
// one table: <file, function, the root it must confine against>. A new plugin
// scaffolder that forgets its row here is the case this shape exists to make
// hard to reach — the row is the only place the root is named. Two files
// because the skill half moved to a provider-keyed module (t747) while the
// agent and bundle halves stayed: a row's file is as load-bearing as its root.
const CONFINED = [
  ['skill-delivery.js', 'deliverClaude', 'SKILL_PLUGINS_DIR'],
  ['skill-delivery.js', 'deliverCodex', 'SKILL_PLUGINS_DIR'],
  ['skill-delivery.js', 'cleanupSeatDir', 'SKILL_PLUGINS_DIR'],
  ['engine.js', 'writeAgentPlugin', 'AGENT_PLUGINS_DIR'],
  ['engine.js', 'cleanupAgentPlugin', 'AGENT_PLUGINS_DIR'],
  ['engine.js', 'writeBundlePlugins', 'SKILL_PLUGINS_DIR'],
];

test('every recursive delete of a plugin-scaffold dir is confined first', () => {
  for (const [file, fn, root] of CONFINED) {
    const body = bodyOf(fn, file);
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

test('t672: a bundle dir is confined TWICE, and has no cleanup of its own', () => {
  const body = bodyOf('writeBundlePlugins');

  // The seat name and the plugin id are two separate caller-supplied segments,
  // and the rmSync below joins BOTH. Confining only the seat leaves the id free
  // to walk back out of bundles/ and delete a sibling seat's scaffold.
  assert.ok(body.includes(`confine(${'SKILL_PLUGINS_DIR'}, name)`),
    'the seat name is confined against the skills root');
  const idGuard = body.indexOf(`confine(path.join(seatDir, ${'BUNDLES_SUBDIR'})`);
  assert.ok(idGuard !== -1, 'the plugin id is confined against the seat\'s bundles/ dir');
  assert.ok(idGuard < body.indexOf('fs.rmSync'), 'and before the recursive delete');

  // The fixture in plugin-bundle-spawn.test.js re-creates this function and
  // cannot carry the mode, so the modes are pinned here or nowhere: a bundle
  // holds the same skill and agent bodies the two flat scaffolders write 0600,
  // and exactly one write — a skill's scripts/ companion, which Claude Code
  // executes — is 0700. A write that took the default would be 0666 & umask.
  const writes = body.match(/writeFileSync\(/g) || [];
  const modes = body.match(/mode: (?:0o600|parts\[0\] === 'scripts' \? 0o700 : 0o600)/g) || [];
  assert.strictEqual(modes.length, writes.length,
    `every write in writeBundlePlugins names its mode (${writes.length} writes, ${modes.length} moded)`);
  assert.strictEqual((body.match(/0o700/g) || []).length, 1,
    'and 0700 appears once — only the scripts/ arm may hand a seat an executable');

  // Deliberately NO cleanupBundlePlugins: bundles/ lives INSIDE
  // skill-plugins/<seat>, which skill-delivery's cleanup already rm -rf's on
  // exit. A second deleter would be a second unconfined join for no coverage.
  assert.ok(!SRC.includes('function cleanupBundlePlugins'),
    'bundles die with the seat dir; a separate teardown would be a redundant delete');
  const bundlesDecl = SRC.match(/^const BUNDLES_SUBDIR = .*$/m);
  assert.ok(bundlesDecl, 'the bundles subdir name is declared at module scope');
  assert.doesNotMatch(bundlesDecl[0], /path\.join|REGISTRY_DIR/,
    'and it is a bare segment under the seat dir, not a root of its own — that nesting is what makes the seat-dir cleanup reap it');
});

test('the write/cleanup call sites fail DIFFERENTLY, and deliberately so', () => {
  // The write path throws: a spawn under a name that cannot be confined must
  // abort rather than continue with a half-built plugin dir.
  for (const [file, fn] of [['skill-delivery.js', 'deliverClaude'], ['skill-delivery.js', 'deliverCodex'], ['engine.js', 'writeAgentPlugin']]) {
    assert.match(bodyOf(fn, file), /throw new Error\(`invalid session name/,
      `${fn} aborts the spawn on a refused name`);
  }
  // The cleanup path returns: it runs on exit, where throwing would break
  // teardown for an unrelated session.
  for (const [file, fn] of [['skill-delivery.js', 'cleanupSeatDir'], ['engine.js', 'cleanupAgentPlugin']]) {
    assert.match(bodyOf(fn, file), /if \(dir === null\) return;/,
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

// t687 — the scaffold's IDENTITY, which the source-level subjects above cannot
// see. Behavioural because every row here uses a well-formed seat name and
// plugin id: nothing in it depends on the confinement holding.
test('t687: a bundle plugin.json carries the plugin\'s own version and announce', () => {
  const tmp = mkTmpRoot('clx-t687-manifest-');
  const registryDir = path.join(tmp, 'clodex-home');
  const before = capturedDeps.length;
  createEngine({
    userDataPath: tmp,
    seams: { registryDir },
    log: { info() {}, warn() {}, error() {} },
  });
  assert.strictEqual(capturedDeps.length, before + 1,
    'ENTER: the wrapped factory ran — zero calls means writeBundlePlugins below is undefined, not merely untested');
  const writeBundlePlugins = capturedDeps[capturedDeps.length - 1].writeBundlePlugins;
  assert.strictEqual(typeof writeBundlePlugins, 'function', 'ENTER: the real scaffolder, not a stub');

  const SKILL_MD = '---\ndescription: Research a ticker.\n---\nGo look it up.\n';
  const AGENT_MD = '---\ndescription: Assesses.\nmodel: haiku\n---\nYou assess.\n';
  const rows = [
    { id: 'stocks', name: 'Stocks', version: '1.4.0', announce: 'Live stock quotes',
      skills: [{ name: 'foo', content: SKILL_MD }] },
    { id: 'quotes', name: 'Quotes', version: '2.1.0', announce: 'Streams quotes',
      agents: [{ name: 'bar', content: AGENT_MD }] },
    { id: 'bare', name: 'Bare Pack', skills: [{ name: 'foo', content: SKILL_MD }] },
  ];
  const written = writeBundlePlugins('seat', rows);
  assert.deepStrictEqual(written.map((w) => w.id), ['stocks', 'quotes', 'bare'],
    'ENTER: all three were scaffolded — a row that bailed writes no plugin.json to read');
  assert.ok(written.every((w) => w.dir.startsWith(registryDir)), 'ENTER: every scaffold landed under the temp registryDir — the seam confines the paths this subject then reads');

  const manifestOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf-8'));

  // The WHOLE object per row, and each expectation is a literal: `name` must
  // stay the plugin id (<plugin>:<agent> dispatch reads it), and asserting only
  // version+description would pass a scaffold that had lost it.
  assert.deepStrictEqual(manifestOf(written[0].dir), {
    name: 'stocks', version: '1.4.0', description: 'Live stock quotes', author: { name: 'clodex' },
  }, 'a skills bundle stamps the plugin manifest\'s own version and announce');

  // The agents-only row goes through buildAgentPlugin instead, which carries a
  // SEPARATE copy of the default pair — one builder taking the opts is not both.
  assert.deepStrictEqual(manifestOf(written[1].dir), {
    name: 'quotes', version: '2.1.0', description: 'Streams quotes', author: { name: 'clodex' },
  }, 'and so does an agents-only bundle');

  assert.deepStrictEqual(manifestOf(written[2].dir), {
    name: 'bare', version: '0.0.0', description: 'Clodex plugin Bare Pack', author: { name: 'clodex' },
  }, 'a manifest with neither field falls back to the placeholder version and a named description');
});

// t732, behavioural against the REAL scaffolder for the same reason the subject
// above is: well-formed name and id, so no arm depends on the confinement.
// plugin-bundle-spawn.test.js asserts the same files through a re-creation of
// this function, which cannot prove engine.js writes them.
test('t732: writeBundlePlugins writes a skill\'s companion files under its dir', () => {
  const tmp = mkTmpRoot('clx-t732-companions-');
  const registryDir = path.join(tmp, 'clodex-home');
  const before = capturedDeps.length;
  createEngine({
    userDataPath: tmp,
    seams: { registryDir },
    log: { info() {}, warn() {}, error() {} },
  });
  assert.strictEqual(capturedDeps.length, before + 1,
    'ENTER: the wrapped factory ran — zero calls means writeBundlePlugins below is undefined, not merely untested');
  const writeBundlePlugins = capturedDeps[capturedDeps.length - 1].writeBundlePlugins;
  assert.strictEqual(typeof writeBundlePlugins, 'function', 'ENTER: the real scaffolder, not a stub');

  const RUN_SH = Buffer.from('#!/bin/sh\necho hi\n');
  const REF_MD = Buffer.from('# reference\n');
  const row = {
    id: 'stocks',
    name: 'Stocks',
    skills: [{
      name: 'foo',
      content: '---\ndescription: Research a ticker.\n---\nGo look it up.\n',
      files: { 'scripts/run.sh': RUN_SH, 'references/x.md': REF_MD },
    }],
  };
  assert.deepStrictEqual(Object.keys(row.skills[0].files).sort(), ['references/x.md', 'scripts/run.sh'],
    'ENTER: the input record carries both companions');

  const written = writeBundlePlugins('seat', [row]);
  assert.strictEqual(written.length, 1, 'ENTER: the row scaffolded');
  const sdir = path.join(written[0].dir, 'skills', 'foo');

  const script = path.join(sdir, 'scripts', 'run.sh');
  assert.deepStrictEqual(fs.readFileSync(script), RUN_SH);
  assert.strictEqual(fs.statSync(script).mode & 0o777, 0o700,
    'Claude Code EXECUTES what a skill puts under scripts/');
  const ref = path.join(sdir, 'references', 'x.md');
  assert.deepStrictEqual(fs.readFileSync(ref), REF_MD);
  assert.strictEqual(fs.statSync(ref).mode & 0o777, 0o600, 'a reference is read, never run');

  assert.deepStrictEqual(written[0].skills, [{ name: 'foo', content: row.skills[0].content, files: row.skills[0].files }],
    'and the returned record still carries the map — session-manager reads skills off it');
});

// createEngine's background timers keep the loop alive; exit once results flush.
test.after(() => { setImmediate(() => process.exit(0)); });
