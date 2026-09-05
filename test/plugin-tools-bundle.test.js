'use strict';
// plugin-tools-bundle.test.js — t678: the two author tools against a plugin that
// carries skills and agents.
//
// Both tools are run as REAL child processes over REAL directories, because
// both of the defects this file exists to catch live outside the module's
// exports: scaffold.js and verify.js are scripts with no exports at all, so a
// unit test would have nothing to call. What is asserted is what an author sees
// on stdout and what is on disk afterwards.
//
// The verify.js arm is the one that needed a fix rather than a feature: its
// staging loop copied every directory entry with copyFileSync, which throws
// EISDIR on skills/ and agents/ — so a content bundle crashed the verifier
// before discovery ran. The content-only case below is that crash's pin, and it
// is the shape the loader was changed to accept, so it must reach 'plugin is
// discoverable' rather than dying in the stage.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { mkTmpRoot } = require('./lib/tmp-roots');

const REPO = path.join(__dirname, '..');
const SCAFFOLD = path.join(REPO, 'plugins', 'tools', 'scaffold.js');
const VERIFY = path.join(REPO, 'plugins', 'tools', 'verify.js');

function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: REPO });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// The loader's own name rule, restated as literals rather than imported: this
// table is what an AUTHOR may type, and importing AGENT_NAME_RE to build it
// would assert only that the tool agrees with itself.
const SKILL_NAMES = [
  { name: 'review', legal: true },
  { name: 'code.review-2', legal: true },
  { name: 'bad name', legal: false },
  { name: '..', legal: false },
  { name: 'a/b', legal: false },
];

test('scaffold.js --skill writes a SKILL.md the loader will accept, at skills/<name>/', () => {
  const root = mkTmpRoot('clx-t678-scaffold-');
  const r = run(SCAFFOLD, ['demo-plugin', root, '--skill', 'review']);
  assert.strictEqual(r.code, 0, `scaffold exited ${r.code}: ${r.err}`);

  const skillPath = path.join(root, 'demo-plugin', 'skills', 'review', 'SKILL.md');
  assert.ok(fs.existsSync(skillPath), 'the skill lands at skills/<name>/SKILL.md — the only path readBundle reads');

  const md = fs.readFileSync(skillPath, 'utf8');
  // Frontmatter with a `description` is what makes a skill discoverable at all;
  // a stub without one writes a file the CLI never surfaces.
  assert.match(md, /^---\nname: review\ndescription: .+\n---\n/,
    'the stub carries name + description frontmatter');
  assert.match(md, /\/demo-plugin:review/,
    'and tells the author the namespaced form the skill is invoked as');

  // The other three files are unchanged by the flag: --skill ADDS a bundle, it
  // does not turn the plugin into a content-only one.
  for (const f of ['manifest.json', 'engine.js', 'renderer.js']) {
    assert.ok(fs.existsSync(path.join(root, 'demo-plugin', f)), `${f} still written`);
  }
  assert.match(r.out, /skills\/review\/SKILL\.md/, 'stdout names the file it wrote');
});

test('scaffold.js without --skill writes no skills directory', () => {
  const root = mkTmpRoot('clx-t678-noskill-');
  const r = run(SCAFFOLD, ['plain-plugin', root]);
  assert.strictEqual(r.code, 0, `scaffold exited ${r.code}: ${r.err}`);
  assert.strictEqual(fs.existsSync(path.join(root, 'plain-plugin', 'skills')), false,
    'the flag is opt-in — a scaffold without it is byte-for-byte the old one');
});

test('scaffold.js refuses a skill name the loader would skip', () => {
  // A refusal HERE is the point: a name that fails the rule would otherwise be
  // written to disk and then silently dropped by readBundle, which reads to the
  // author as "my skill does not work" with nothing to look at.
  for (const row of SKILL_NAMES) {
    const root = mkTmpRoot('clx-t678-name-');
    const r = run(SCAFFOLD, ['name-plugin', root, '--skill', row.name]);
    if (row.legal) {
      assert.strictEqual(r.code, 0, `"${row.name}" is legal but scaffold exited ${r.code}: ${r.err}`);
      assert.ok(fs.existsSync(path.join(root, 'name-plugin', 'skills', row.name, 'SKILL.md')),
        `"${row.name}" should have been written`);
    } else {
      assert.strictEqual(r.code, 2, `"${row.name}" is illegal and must be refused, not written`);
      assert.match(r.err, /not a usable skill name/, `"${row.name}" refusal says why`);
      assert.strictEqual(fs.existsSync(path.join(root, 'name-plugin')), false,
        `"${row.name}" must leave no directory behind`);
    }
  }
});

// A plugin folder whose manifest names NEITHER half, carrying one good skill,
// one good agent, and three entries readBundle skips for three different
// reasons. Written as files because that is the only input readBundle has.
function mkContentPlugin(id) {
  const root = mkTmpRoot('clx-t678-content-');
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'skills', 'good'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', 'nodoc'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', 'bad name'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'good', 'SKILL.md'), '---\nname: good\ndescription: d\n---\nbody\n');
  fs.writeFileSync(path.join(dir, 'skills', 'bad name', 'SKILL.md'), '---\nname: x\ndescription: d\n---\nbody\n');
  fs.writeFileSync(path.join(dir, 'agents', 'helper.md'), '---\ndescription: helps\n---\nyou help\n');
  fs.writeFileSync(path.join(dir, 'agents', 'notes.txt'), 'not a subagent');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id, name: id, hostApi: '1', version: '0.1.0', entry: {},
  }, null, 2));
  return dir;
}

test('verify.js passes a content-only plugin and reports the bundle the loader read', () => {
  const dir = mkContentPlugin('content-only');
  const r = run(VERIFY, [dir]);

  // ENTER: the run must have reached discovery. A stage-time EISDIR — the
  // regression this pins — exits 1 with the checklist stopping at
  // 'manifest.json parses', and every absence asserted below would then be
  // vacuously true of output that never mentioned a bundle at all.
  assert.match(r.out, /PASS {2}plugin is discoverable/,
    'the staged copy must include skills/ and agents/, or discovery never runs');

  assert.strictEqual(r.code, 0, `a content-only plugin conforms; verify exited ${r.code}\n${r.out}`);
  assert.match(r.out, /PASS {2}registered at least one surface/,
    'a bundle entry IS a surface — a content-only plugin registers no ipc method and no hook');
  assert.match(r.out, /bundle entries: 2/, 'and the count is the loader\'s: one skill, one agent');

  assert.match(r.out, /note {2}skills {2}— 1: content-only:good/,
    'accepted skills are reported under their namespaced name');
  assert.match(r.out, /note {2}agents {2}— 1: content-only:helper/,
    'and so are accepted agents');
});

test('verify.js reports each bundle entry the loader skipped, with its reason', () => {
  const dir = mkContentPlugin('skipper');
  const r = run(VERIFY, [dir]);
  assert.strictEqual(r.code, 0, `verify exited ${r.code}\n${r.out}`);

  // Three skips, three DIFFERENT reasons, each a literal the loader emits. A
  // regex matching any of them against all three would pass on a tool that
  // reported one skip and lost the other two.
  assert.match(r.out, /note {2}bundle entry skipped {2}— skills\/bad name — not a legal skill name/,
    'a name failing the rule is named, not silently dropped');
  assert.match(r.out, /note {2}bundle entry skipped {2}— skills\/nodoc — no readable SKILL\.md/,
    'a skill directory with no SKILL.md is named');

  // agents/notes.txt is skipped SILENTLY by readBundle — it never calls onSkip
  // for a non-.md entry — so it must not appear. Pinned because a tool that
  // invented a line here would be reporting something the app does not.
  assert.strictEqual(/notes\.txt/.test(r.out), false,
    'a non-.md file in agents/ is not a skip, it is not an entry');
});
