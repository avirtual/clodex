'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { parseAgentFrontmatter } = require('../agents-util');
const { initStores } = require('../stores');
const { mkTmpRoot } = require('./lib/tmp-roots');

const AGENTS_SRC = path.join(__dirname, '..', 'resources', 'library', 'agents');
const KIT_DIR = path.join(__dirname, '..', 'resources', 'library', 'kits');
const LIB_HAND = path.join(__dirname, '..', 'resources', 'library', 'templates', 'clodex-team-hand.json');

const EXPECTED = {
  'clodex-redproof': { tools: 'Bash, Read, Grep', model: 'sonnet', description: /red-proof/i },
  'clodex-locate': { tools: 'Read, Grep, Glob', model: 'sonnet', description: /file:line/ },
};

test('the shipped agent defs parse with description, tools and model', () => {
  assert.deepStrictEqual(fs.readdirSync(AGENTS_SRC).sort(), Object.keys(EXPECTED).sort().map((n) => `${n}.md`),
    'ENTER: the shipped set is exactly the two files this loop asserts about');
  for (const [name, want] of Object.entries(EXPECTED)) {
    const raw = fs.readFileSync(path.join(AGENTS_SRC, `${name}.md`), 'utf-8');
    const { meta, body } = parseAgentFrontmatter(raw);
    assert.match(meta.description || '', want.description, `${name}: description must survive the parser`);
    assert.strictEqual(meta.tools, want.tools, `${name}: the tool list is the seat's whole roster`);
    assert.strictEqual(meta.model, want.model, `${name}: a delegate on the caller's model saves nothing`);
    assert.ok(body.length > 100, `${name}: the body is the agent's system prompt, not a stub`);
  }
});

test('the redproof def forbids the full suite and a dirty tree; locate stays read-only', () => {
  const redproof = fs.readFileSync(path.join(AGENTS_SRC, 'clodex-redproof.md'), 'utf-8');
  assert.match(redproof, /Never run the full suite/);
  assert.match(redproof, /git status --short/);
  assert.match(redproof, /git checkout -- /, 'the restore step is named, not left to the caller');
  const locate = fs.readFileSync(path.join(AGENTS_SRC, 'clodex-locate.md'), 'utf-8');
  assert.match(locate, /read-only/);
  assert.match(locate, /twenty lines/, 'the context cap is what keeps a lookup cheaper than the read');
});

test('every hand template grants both agents — shipped and every kit', () => {
  const want = ['clodex-redproof', 'clodex-locate'];
  const shipped = JSON.parse(fs.readFileSync(LIB_HAND, 'utf-8'));
  assert.deepStrictEqual(shipped.agents, want, 'the shipped hand template grants both');

  const kits = fs.readdirSync(KIT_DIR);
  assert.ok(kits.length >= 2, 'ENTER: more than one kit ships, or this loop asserts about one file');
  for (const kit of kits) {
    const dir = path.join(KIT_DIR, kit, 'templates');
    const handFile = fs.readdirSync(dir).find((f) => /^(hand|clodex-team-hand)\.json$/.test(f));
    assert.ok(handFile, `kit ${kit} ships no hand template`);
    const kitHand = JSON.parse(fs.readFileSync(path.join(dir, handFile), 'utf-8'));
    assert.deepStrictEqual(kitHand.agents, want,
      `kit ${kit}'s hand must grant the same two agents — its prompt tells the seat to spawn them by name`);
  }
});

test('they seed into a fresh registry\'s agents root and surface through agentLibrary', () => {
  const userData = mkTmpRoot('t992-ud-');
  const registryDir = mkTmpRoot('t992-reg-');
  try {
    const stores = initStores(userData, { registryDir });
    const dest = path.join(registryDir, 'agents');
    for (const name of Object.keys(EXPECTED)) {
      const file = path.join(dest, `${name}.md`);
      assert.ok(fs.existsSync(file), `${name}.md seeded on construction`);
      assert.deepStrictEqual(fs.readFileSync(file), fs.readFileSync(path.join(AGENTS_SRC, `${name}.md`)),
        `${name}.md is byte-for-byte the shipped copy`);
    }
    const listed = stores.agentLibrary.list();
    for (const [name, want] of Object.entries(EXPECTED)) {
      const rec = listed.find((a) => a.name === name);
      assert.ok(rec, `${name} surfaces through agentLibrary.list()`);
      assert.strictEqual(rec.tools, want.tools, `${name}: the tool list survives the store round-trip`);
      assert.strictEqual(rec.model, want.model);
    }
    assert.ok(fs.existsSync(path.join(dest, '.seed-state.json')),
      'ENTER: the manifest is there to be mis-listed');
    assert.ok(!listed.some((a) => a.name.startsWith('.')), 'no dotfile is listed as an agent');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});
