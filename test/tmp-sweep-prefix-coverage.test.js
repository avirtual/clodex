'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'tmp-sweep.sh');

const MINT = ['mkdtemp', 'Sync'].join('');

function trackedJs() {
  const out = cp.execSync("git ls-files '*.js' '*.cjs' '*.mjs'", { cwd: REPO, maxBuffer: 1 << 28 }).toString();
  return out.split('\n').filter((f) => f && !f.includes('node_modules'));
}

function scanPrefixes() {
  const rawShape = new RegExp(`${MINT}\\s*\\([\\s\\S]{0,200}?tmpdir\\(\\)\\s*\\)?\\s*,\\s*(['"\`])([^'"\`]*)\\1`, 'g');
  const helperShape = /\b(?:mkTmpRoot|trackTmpRoot)\(\s*(['"`])([^'"`]*)\1/g;
  const raw = new Map();
  const helper = new Map();
  for (const rel of trackedJs()) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    for (const m of src.matchAll(rawShape)) {
      const p = m[2].split('${')[0];
      if (p && !raw.has(p)) raw.set(p, rel);
    }
    for (const m of src.matchAll(helperShape)) {
      const p = m[2].split('${')[0];
      if (p && !helper.has(p)) helper.set(p, rel);
    }
  }
  const union = new Map([...raw, ...helper]);
  return { raw, helper, union };
}

function scriptPrefixes() {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const block = src.match(/\nPREFIXES='\n([\s\S]*?)\n'\n/);
  assert.ok(block, `ENTER: ${SCRIPT} must expose a PREFIXES='…' block — the sweep matches nothing without one`);
  return block[1].split('\n').map((s) => s.trim()).filter(Boolean);
}

test('ENTER: the scan finds mint sites in both shapes, so the coverage assertions below are not vacuous', () => {
  const { raw, helper, union } = scanPrefixes();
  assert.ok(union.size > 100,
    `ENTER: expected the suite to mint well over 100 distinct tmp prefixes, scanned ${union.size} — `
    + 'a near-empty scan means the patterns stopped matching and every assertion below passes for nothing');
  assert.ok(helper.size > 0,
    'ENTER: no mkTmpRoot()/trackTmpRoot() prefixes found at all — test/lib/tmp-roots.js is the suite\'s '
    + 'mint helper, so zero call sites means this scan is broken, not that the suite stopped minting');
  assert.ok(raw.size + helper.size >= union.size,
    'ENTER: the union cannot exceed the sum of its two shapes');
});

test('every prefix the suite mints is covered by tmp-sweep.sh', () => {
  const { union } = scanPrefixes();
  const listed = scriptPrefixes();
  assert.ok(listed.length > 100,
    `ENTER: tmp-sweep.sh lists only ${listed.length} prefixes — too few to be the enumerated set`);
  const alternation = new RegExp(`^(?:${listed.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[A-Za-z0-9]{6}(?:-.*)?$`);
  const uncovered = [];
  for (const [prefix, where] of union) {
    if (!alternation.test(`${prefix}a1b2c3`)) uncovered.push(`${prefix} (${where})`);
  }
  assert.deepStrictEqual(uncovered, [],
    'these prefixes are minted by the suite but tmp-sweep.sh would leave their abandoned roots on disk '
    + `forever — add them to the PREFIXES block in ${path.relative(REPO, SCRIPT)}:\n  ${uncovered.join('\n  ')}`);
});

test('tmp-sweep.sh lists each prefix in full rather than collapsing it to a family root', () => {
  const listed = scriptPrefixes();
  assert.ok(listed.includes('clodex-'),
    'ENTER: the clodex- family root must be listed, or the collapse check below proves nothing');
  const alternation = new RegExp(`^(?:${listed.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[A-Za-z0-9]{6}(?:-.*)?$`);
  assert.ok(!/^(?:clodex-)[A-Za-z0-9]{6}(?:-.*)?$/.test('clodex-pend-a1b2c3'),
    'ENTER: the six-character anchor is what makes a family root non-transitive; if clodex- ever matches '
    + 'clodex-pend-<six> on its own, the collapse this test forbids would become safe and this test is stale');
  assert.ok(alternation.test('clodex-pend-a1b2c3'),
    'a root minted as clodex-pend-<six> must match: listing clodex- alone does NOT cover it, because the '
    + 'six-character anchor sits directly after the prefix. Collapsing the list by string-prefix dropped '
    + '241,305 of 300,478 matching roots when measured.');
});

test('tmp-sweep.sh refuses a TMPDIR that is not a per-user temp dir, and refuses an age of zero', () => {
  const run = (env, args = []) => cp.spawnSync('bash', [SCRIPT, ...args], {
    env: { ...process.env, ...env }, encoding: 'utf8',
  });
  const noTmp = { ...process.env };
  delete noTmp.TMPDIR;
  const unset = cp.spawnSync('bash', [SCRIPT], { env: noTmp, encoding: 'utf8' });
  assert.strictEqual(unset.status, 2, 'an unset TMPDIR must refuse, not guess');
  assert.match(unset.stderr, /TMPDIR is unset/);

  for (const bad of ['/tmp', process.env.HOME]) {
    const r = run({ TMPDIR: bad });
    assert.strictEqual(r.status, 2, `TMPDIR=${bad} must refuse: a sweep there would delete another owner's data`);
    assert.match(r.stderr, /per-user temp dir|not a directory/);
  }

  for (const bad of ['0', '-1', 'abc', '']) {
    const r = run({}, ['--older-than', bad]);
    assert.strictEqual(r.status, 2, `--older-than ${JSON.stringify(bad)} must refuse: age is the gate that spares a live run's fixtures`);
    assert.match(r.stderr, /older-than must be a whole number/);
  }
});
