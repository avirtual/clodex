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

const literal = (s) => s.split('${')[0];
const forwards = (param) => new RegExp(
  `\\b(?:__MINTERS__)\\(\\s*${param}\\s*[,)]`
  + `|${MINT}\\s*\\([\\s\\S]{0,200}?tmpdir\\(\\)\\s*\\)?\\s*,\\s*${param}\\s*[,)]`);

function bodyAt(src, openBrace) {
  let depth = 0;
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(openBrace, i + 1);
  }
  return src.slice(openBrace);
}

function mintersIn(src, maxPasses = Infinity) {
  const fns = [...src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*\{/g)]
    .map((m) => ({ name: m[1], param: m[2], body: bodyAt(src, m.index + m[0].length - 1) }));
  const minters = new Set(['mkTmpRoot', 'trackTmpRoot']);
  for (let pass = 0; pass < Math.min(maxPasses, fns.length + 1); pass++) {
    let grew = false;
    for (const fn of fns) {
      if (minters.has(fn.name)) continue;
      const re = new RegExp(forwards(fn.param).source.replace('__MINTERS__', [...minters].join('|')));
      if (re.test(fn.body)) { minters.add(fn.name); grew = true; }
    }
    if (!grew) break;
  }
  return minters;
}

function scanPrefixes() {
  const rawShape = new RegExp(`${MINT}\\s*\\([\\s\\S]{0,200}?tmpdir\\(\\)\\s*\\)?\\s*,\\s*(['"\`])([^'"\`]*)\\1`, 'g');
  const helperShape = /\b(?:mkTmpRoot|trackTmpRoot)\(\s*(['"`])([^'"`]*)\1/g;
  const raw = new Map();
  const helper = new Map();
  const viaWrapper = new Map();
  const viaConst = new Map();
  for (const rel of trackedJs()) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    for (const m of src.matchAll(rawShape)) {
      const p = literal(m[2]);
      if (p && !raw.has(p)) raw.set(p, rel);
    }
    for (const m of src.matchAll(helperShape)) {
      const p = literal(m[2]);
      if (p && !helper.has(p)) helper.set(p, rel);
    }
    const minters = mintersIn(src);
    for (const name of minters) {
      if (name === 'mkTmpRoot' || name === 'trackTmpRoot') continue;
      for (const c of src.matchAll(new RegExp(`\\b${name}\\(\\s*(['"\`])([^'"\`]*)\\1`, 'g'))) {
        const p = literal(c[2]);
        if (p && !viaWrapper.has(p)) viaWrapper.set(p, `${rel} via ${name}()`);
      }
    }
    const alt = [...minters].join('|');
    for (const c of src.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*(['"`])([^'"`]*)\2/g)) {
      const p = literal(c[3]);
      if (!p) continue;
      const used = new RegExp(forwards(c[1]).source.replace('__MINTERS__', alt));
      if (used.test(src) && !viaConst.has(p)) viaConst.set(p, `${rel} via const ${c[1]}`);
    }
  }
  const union = new Map([...raw, ...helper, ...viaWrapper, ...viaConst]);
  return { raw, helper, viaWrapper, viaConst, union };
}

function scriptPrefixes() {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const block = src.match(/\nPREFIXES='\n([\s\S]*?)\n'\n/);
  assert.ok(block, `ENTER: ${SCRIPT} must expose a PREFIXES='…' block — the sweep matches nothing without one`);
  return block[1].split('\n').map((s) => s.trim()).filter(Boolean);
}

test('ENTER: the scan finds mint sites in all three shapes, so the coverage assertions below are not vacuous', () => {
  const { helper, viaWrapper, viaConst, union } = scanPrefixes();
  assert.ok(union.size > 100,
    `ENTER: expected the suite to mint well over 100 distinct tmp prefixes, scanned ${union.size} — `
    + 'a near-empty scan means the patterns stopped matching and every assertion below passes for nothing');
  assert.ok(helper.size > 0,
    'ENTER: no mkTmpRoot()/trackTmpRoot() prefixes found at all — test/lib/tmp-roots.js is the suite\'s '
    + 'mint helper, so zero call sites means this scan is broken, not that the suite stopped minting');
  assert.ok(viaWrapper.size > 0,
    'ENTER: no prefixes found through a local wrapper — the suite\'s dominant fixture idiom is '
    + '`function mkHome(prefix) { mkTmpRoot(prefix) }` called with a literal, and review round 1 found '
    + '~60 prefixes uncollected because this shape was missing. Zero means it is missing again.');
  assert.ok(viaConst.size > 0,
    'ENTER: no prefixes found through a module const forwarded to a mint (scripts/renderer-smoke.js '
    + 'is the live case). This path is counted separately from the wrapper path on purpose: when the '
    + 'two shared one map, disabling the wrapper scan entirely still left the map non-empty and the '
    + 'guard passed.');
});

test('the wrapper scan collects prefixes that no other shape reaches', () => {
  const { raw, helper, viaWrapper } = scanPrefixes();
  const onlyViaWrapper = [...viaWrapper.keys()].filter((p) => !raw.has(p) && !helper.has(p));
  assert.ok(onlyViaWrapper.length >= 40,
    `the wrapper shape must be load-bearing, but only ${onlyViaWrapper.length} prefixes are reachable `
    + 'through it alone. Review round 1 shipped with this shape missing and ~60 live prefixes went '
    + `uncollected while the pin stayed green. Found: ${onlyViaWrapper.slice(0, 5).join(', ')}…`);
  for (const probe of ['clx-t700-leaf-', 'clodex-t679-spawn-a-', 't748-rows-']) {
    assert.ok(viaWrapper.has(probe),
      `${probe} is minted only through a wrapper — if the scan stops reaching it, tmp-sweep.sh goes stale silently`);
  }
});

test('a wrapper body stops at its own closing brace, so a neighbour\'s mint is not attributed to it', () => {
  const src = 'function innocent(prefix) { return prefix.trim(); }\n'
    + 'function minter(prefix) { return mkTmpRoot(prefix); }\n';
  const found = mintersIn(src);
  assert.ok(found.has('minter'), 'ENTER: the minting function must be recognised, or this proves nothing');
  assert.ok(!found.has('innocent'),
    'innocent() does not mint — attributing its neighbour\'s mkTmpRoot to it would collect every literal '
    + 'ever passed to it as a tmp prefix, and PREFIXES is interpolated into the deletion pattern');
});

test('resolving wrappers to a fixpoint reaches chains a single pass cannot', () => {
  const forward = 'function inner(prefix) { return mkTmpRoot(prefix); }\n'
    + 'function outer(prefix) { return inner(prefix); }\n';
  const reverse = 'function outer(prefix) { return inner(prefix); }\n'
    + 'function inner(prefix) { return mkTmpRoot(prefix); }\n';

  assert.ok(mintersIn(forward, 1).has('outer'),
    'ENTER: when the inner wrapper is defined first, one pass already resolves the chain — the set '
    + 'grows during the pass. If this fails, the scan is not resolving chains at all.');
  assert.ok(!mintersIn(reverse, 1).has('outer'),
    'ENTER: when the outer wrapper is defined FIRST, one pass cannot resolve it — that is the case '
    + 'the fixpoint exists for, and it must genuinely be unreachable in one pass');
  assert.ok(mintersIn(reverse).has('outer'),
    'outer -> inner -> mkTmpRoot must resolve regardless of definition order. Capping the loop at one '
    + 'pass silently drops every prefix minted through a wrapper declared above its callee.');
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
