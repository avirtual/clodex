'use strict';
// skill-delivery.test.js — t747, the provider seam. Claude gets a --plugin-dir
// scaffold; Codex 0.153.4 has no per-process skill root, so it gets the files
// under its own seat dir plus a catalog block naming each one's absolute path.
//
// Behavioural against the REAL factory over a temp root — every arm here uses a
// well-formed seat name, so none of them depends on the confinement holding.
// The traversal cases stay source-level in test/skill-plugin-confine.test.js
// for the reason that file gives: calling deliver with `name: '..'` and a
// broken guard IS the delete it forbids.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createSkillDelivery } = require('../skill-delivery');
const { confine } = require('../path-confine');
const { ensureDir } = require('../fs-util');
const { buildSkillPlugin, skillMd, parseSkillFrontmatter } = require('../skills-util');
const { mkTmpRoot } = require('./lib/tmp-roots');

const DEPLOY = { name: 'deploy', content: '---\ndescription: Ships the DMG.\n---\nRun the script.\n' };
const AUDIT = { name: 'audit', content: '---\ndescription: Reads the ledger.\n---\nCount it.\n' };
const BARE = { name: 'bare', content: 'no frontmatter at all\n' };
const BUNDLED = { name: 'stocks:foo', content: '---\ndescription: Research a ticker.\n---\nLook it up.\n' };

function mk() {
  const root = mkTmpRoot('clx-t747-');
  const SKILL_PLUGINS_DIR = path.join(root, 'skill-plugins');
  const delivery = createSkillDelivery({
    fs, path, confine, ensureDir, SKILL_PLUGINS_DIR,
    SKILL_PLUGIN_NAME: 'clodex-skills', buildSkillPlugin, skillMd, parseSkillFrontmatter,
  });
  return { delivery, SKILL_PLUGINS_DIR };
}

const catalogLines = (block) => block.split('\n').filter((l) => l.startsWith('- '));

test('t747: providers() names exactly the two CLIs that have an adapter', () => {
  assert.deepStrictEqual(mk().delivery.providers(), ['claude', 'codex']);
});

test('t747: a provider with no adapter delivers nothing and cleans up nothing', () => {
  const { delivery, SKILL_PLUGINS_DIR } = mk();
  assert.strictEqual(delivery.deliver('gemini', 'seat', [DEPLOY]), null,
    'an unknown provider must not fall through to a default adapter');
  delivery.cleanup('gemini', 'seat');
  assert.strictEqual(fs.existsSync(SKILL_PLUGINS_DIR), false,
    'and neither call touched the skills root at all');
});

test('t747: the codex adapter writes each SKILL.md and catalogs it by absolute path', () => {
  const { delivery, SKILL_PLUGINS_DIR } = mk();
  const out = delivery.deliver('codex', 'seat', [DEPLOY, BUNDLED, AUDIT, BARE]);
  assert.ok(out, 'ENTER: four records delivered — a null return vacuums out every assertion below');
  assert.deepStrictEqual(out.args, [],
    'codex takes no argv for this: the catalog rides the instructions file');

  const fileFor = (n) => path.join(SKILL_PLUGINS_DIR, 'seat', 'skills', n, 'SKILL.md');
  // Whole lines, each hardcoded: a per-line expectation the test COMPOSED from
  // the record would assert only that the adapter agrees with itself, and could
  // not express the two exceptions below (a missing description, a bundle name).
  assert.deepStrictEqual(catalogLines(out.instructions), [
    `- audit: Reads the ledger. — ${fileFor('audit')}`,
    `- bare: (no description) — ${fileFor('bare')}`,
    `- deploy: Ships the DMG. — ${fileFor('deploy')}`,
    `- stocks:foo: Research a ticker. — ${fileFor('stocks:foo')}`,
  ], 'sorted by name; a bundle skill keeps its qualified name');

  assert.match(out.instructions, /^# Clodex skills\n/, 'the block opens with the heading');
  assert.match(out.instructions, /read it with your file tools when a task matches its description, not up front/,
    'and tells the seat to read on demand rather than up front');

  assert.match(fs.readFileSync(fileFor('deploy'), 'utf-8'), /Run the script\./,
    'the catalogued path really holds the skill body');
  assert.match(fs.readFileSync(fileFor('bare'), 'utf-8'), /^---\nname: bare\n/,
    'a body with no frontmatter is still wrapped into a valid SKILL.md');
  assert.strictEqual(fs.statSync(fileFor('deploy')).mode & 0o777, 0o600,
    'a skill is read by the seat, never executed');
});

test('t747: the codex adapter rebuilds from scratch, so a deselected skill is gone', () => {
  const { delivery, SKILL_PLUGINS_DIR } = mk();
  assert.ok(delivery.deliver('codex', 'seat', [DEPLOY, AUDIT]), 'ENTER: the first spawn delivered both');
  const gone = path.join(SKILL_PLUGINS_DIR, 'seat', 'skills', 'audit');
  assert.strictEqual(fs.existsSync(gone), true, 'ENTER: audit was on disk before the second spawn');

  delivery.deliver('codex', 'seat', [DEPLOY]);
  assert.strictEqual(fs.existsSync(gone), false, 'the deselected skill did not linger');
  assert.strictEqual(fs.existsSync(path.join(SKILL_PLUGINS_DIR, 'seat', 'skills', 'deploy')), true,
    'and the surviving one is still there');
});

test('t747: no skills selected leaves NO block and NO dir for either provider', () => {
  const { delivery, SKILL_PLUGINS_DIR } = mk();
  assert.ok(delivery.deliver('codex', 'seat', [DEPLOY]), 'ENTER: the seat dir exists to be removed');
  assert.strictEqual(fs.existsSync(path.join(SKILL_PLUGINS_DIR, 'seat')), true, 'ENTER: on disk');

  assert.strictEqual(delivery.deliver('codex', 'seat', []), null,
    'an empty catalog is no catalog — the instructions file gains nothing');
  assert.strictEqual(fs.existsSync(path.join(SKILL_PLUGINS_DIR, 'seat')), false,
    'and the stale dir went with it');

  assert.strictEqual(delivery.deliver('claude', 'other', []), null,
    'the claude adapter bails the same way, so no empty --plugin-dir is pushed');
});

test('t747: the claude adapter still builds the plugin scaffold, unchanged', () => {
  const { delivery, SKILL_PLUGINS_DIR } = mk();
  const out = delivery.deliver('claude', 'seat', [DEPLOY]);
  assert.ok(out, 'ENTER: one record delivered');
  const dir = path.join(SKILL_PLUGINS_DIR, 'seat');
  assert.deepStrictEqual(out, { args: ['--plugin-dir', dir], instructions: null },
    'claude carries its skills on argv and adds nothing to any prompt');

  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf-8')),
    { name: 'clodex-skills', version: '0.0.0', description: 'clodex session-injected skills', author: { name: 'clodex' } },
    'the manifest the CLI loads is byte-for-byte what it was before the extraction');
  assert.match(fs.readFileSync(path.join(dir, 'skills', 'deploy', 'SKILL.md'), 'utf-8'),
    /^---\nname: deploy\ndescription: Ships the DMG\.\n---\nRun the script\.\n$/,
    'and so is the SKILL.md');
});

test('t747: cleanup removes the seat dir for either provider, and only that seat', () => {
  const { delivery, SKILL_PLUGINS_DIR } = mk();
  delivery.deliver('claude', 'one', [DEPLOY]);
  delivery.deliver('codex', 'two', [AUDIT]);
  assert.deepStrictEqual(fs.readdirSync(SKILL_PLUGINS_DIR).sort(), ['one', 'two'],
    'ENTER: both seats scaffolded — a cleanup over an empty root proves nothing');

  delivery.cleanup('codex', 'two');
  assert.deepStrictEqual(fs.readdirSync(SKILL_PLUGINS_DIR), ['one'],
    'the codex seat dir is reaped, the claude one untouched');
  delivery.cleanup('claude', 'one');
  assert.deepStrictEqual(fs.readdirSync(SKILL_PLUGINS_DIR), []);
});

test('t747: a name that cannot be confined throws on deliver and is silent on cleanup', () => {
  const { delivery, SKILL_PLUGINS_DIR } = mk();
  // Well-formed roots, refused NAME: confine returns null before any rmSync, so
  // this exercises the refusal without ever putting a real delete at risk.
  for (const provider of ['claude', 'codex']) {
    assert.throws(() => delivery.deliver(provider, '..', [DEPLOY]), /invalid session name/,
      `${provider} aborts the spawn rather than deleting the parent of the skills root`);
  }
  delivery.cleanup('codex', '..');
  delivery.cleanup('claude', '..');
  assert.strictEqual(fs.existsSync(path.dirname(SKILL_PLUGINS_DIR)), true,
    'teardown refused silently and the root\'s parent is still there');
});
