'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'tmp-sweep.sh');

const MINT = ['mkdtemp', 'Sync'].join('');

const SEEDS = ['mkTmpRoot'];
const NOT_SEEDS = ['mkTmpDirIn'];

function trackedJs() {
  const out = cp.execSync("git ls-files '*.js' '*.cjs' '*.mjs'", { cwd: REPO, maxBuffer: 1 << 28 }).toString();
  return out.split('\n').filter((f) => f && !f.includes('node_modules'));
}

const HOLE = /\u0000(\d+)\u0000/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function maskSource(src) {
  const values = [];
  const mark = (v) => `\u0000${values.push(v) - 1}\u0000`;
  let out = '';
  let tail = '';
  const push = (s) => { out += s; if (s) tail = (tail + s).slice(-12); };
  const regexAllowed = () => {
    const before = tail.replace(/\s+$/, '');
    return before === '' || /[(,=:[!&|?{};+\-*%~^<>]$/.test(before)
      || /(?:^|[^\w$])(?:return|typeof|case|in|of|new|delete|void|do|else|yield|await)$/.test(before);
  };
  let i = 0;
  let mode = 'code';
  let depth = 0;
  const stack = [];
  while (i < src.length) {
    if (mode === 'tpl') {
      let j = i;
      let val = '';
      while (j < src.length && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) {
        if (src[j] === '\\') { val += src[j + 1] ?? ''; j += 2; } else { val += src[j]; j += 1; }
      }
      push(mark(val));
      i = j;
      if (src[i] === '`') { push('`'); i += 1; mode = 'code'; depth = stack.pop().depth; } else if (src[i] === '$') { push('${'); i += 2; mode = 'code'; stack.push({ kind: 'interp', depth }); depth = 0; } else break;
      continue;
    }
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const j = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i);
      push(' '.repeat(j - i));
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const j = end < 0 ? src.length : end + 2;
      push(src.slice(i, j).replace(/[^\n]/g, ' '));
      i = j;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { closed = true; break; }
        j += 1;
      }
      if (closed) {
        j += 1;
        while (j < src.length && /[a-z]/.test(src[j])) j += 1;
        push(' '.repeat(j - i));
        i = j;
        continue;
      }
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let val = '';
      while (j < src.length && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') { val += src[j + 1] ?? ''; j += 2; } else { val += src[j]; j += 1; }
      }
      push(c + mark(val) + c);
      i = src[j] === c ? j + 1 : j;
      continue;
    }
    if (c === '`') { push('`'); i += 1; stack.push({ kind: 'tpl', depth }); depth = 0; mode = 'tpl'; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      if (depth === 0 && stack.length && stack[stack.length - 1].kind === 'interp') {
        push('}');
        i += 1;
        depth = stack.pop().depth;
        mode = 'tpl';
        continue;
      }
      depth -= 1;
    }
    push(c);
    i += 1;
  }
  return { masked: out, values };
}

const literal = (captured, values) => {
  const head = captured.split('${')[0];
  const m = new RegExp(HOLE.source).exec(head);
  return {
    prefix: m ? values[Number(m[1])] : '',
    interpolated: captured.includes('${'),
  };
};

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

const callSiteRe = (names) => new RegExp(
  `(?<![.\\w$])(?:${names.map(escapeRe).join('|')})\\(\\s*(['"\`])([^'"\`]*)\\1`, 'g');
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

function mintersIn(src, maxPasses = Infinity, premasked = false) {
  const code = premasked ? src : maskSource(src).masked;
  const fns = [...code.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*\{/g)]
    .map((m) => ({ name: m[1], param: m[2], body: bodyAt(code, m.index + m[0].length - 1) }));
  const minters = new Set(SEEDS);
  for (let pass = 0; pass < Math.min(maxPasses, fns.length + 1); pass++) {
    let grew = false;
    for (const fn of fns) {
      if (minters.has(fn.name)) continue;
      const re = new RegExp(forwards(escapeRe(fn.param)).source
        .replace('__MINTERS__', () => [...minters].map(escapeRe).join('|')));
      if (re.test(fn.body)) { minters.add(fn.name); grew = true; }
    }
    if (!grew) break;
  }
  return minters;
}

let cachedScan = null;

function scanPrefixes() {
  if (cachedScan) return cachedScan;
  const rawShape = new RegExp(`${MINT}\\s*\\([\\s\\S]{0,200}?tmpdir\\(\\)\\s*\\)?\\s*,\\s*(['"\`])([^'"\`]*)\\1`, 'g');
  const helperShape = callSiteRe(SEEDS);
  const raw = new Map();
  const helper = new Map();
  const viaWrapper = new Map();
  const viaConst = new Map();
  const interpolated = [];
  for (const rel of trackedJs()) {
    const { masked: src, values } = maskSource(fs.readFileSync(path.join(REPO, rel), 'utf8'));
    const take = (map, m, group, where) => {
      const { prefix, interpolated: dynamic } = literal(m[group], values);
      if (dynamic) interpolated.push(`${rel}:${lineOf(src, m.index)} (${prefix}\${…})`);
      else if (prefix && !map.has(prefix)) map.set(prefix, where);
    };
    for (const m of src.matchAll(rawShape)) take(raw, m, 2, rel);
    for (const m of src.matchAll(helperShape)) take(helper, m, 2, rel);
    const minters = mintersIn(src, Infinity, true);
    for (const name of minters) {
      if (SEEDS.includes(name)) continue;
      for (const c of src.matchAll(callSiteRe([name]))) {
        take(viaWrapper, c, 2, `${rel} via ${name}()`);
      }
    }
    const alt = [...minters].map(escapeRe).join('|');
    for (const c of src.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*(['"`])([^'"`]*)\2/g)) {
      const { prefix, interpolated: dynamic } = literal(c[3], values);
      if (dynamic || !prefix) continue;
      const used = new RegExp(forwards(escapeRe(c[1])).source.replace('__MINTERS__', () => alt));
      if (used.test(src) && !viaConst.has(prefix)) viaConst.set(prefix, `${rel} via const ${c[1]}`);
    }
  }
  const union = new Map([...raw, ...helper, ...viaWrapper, ...viaConst]);
  cachedScan = { raw, helper, viaWrapper, viaConst, union, interpolated };
  return cachedScan;
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
    `ENTER: no ${SEEDS.join('()/')}() prefixes found at all — test/lib/tmp-roots.js is the suite's `
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

test('a mint name reached through a property or a longer identifier is not a call site', () => {
  const collect = (src) => [...src.matchAll(callSiteRe(['mkTmpRoot']))].map((m) => m[2]);
  assert.deepStrictEqual(collect("mkTmpRoot('real-')"), ['real-'],
    'ENTER: a genuine bare call must be collected, or the exclusions below prove nothing');
  for (const [what, src] of [
    ['a property access', "vendor.mkTmpRoot('not-ours-')"],
    ['a longer identifier ending in the name', "xmkTmpRoot('not-ours-')"],
    ['an underscore-prefixed name', "_mkTmpRoot('not-ours-')"],
    ['a dollar-prefixed name', "$mkTmpRoot('not-ours-')"],
  ]) {
    assert.deepStrictEqual(collect(src), [],
      `${what} is a DIFFERENT function that happens to end in our mint's name. \b matches after a `
      + 'dot, so it would collect this literal into PREFIXES and make it a deletion pattern against '
      + "somebody else's directories. Only the shape ratchet stands between that and the sweep.");
  }
});

test('no mint site builds its prefix by interpolation — the sweep cannot match those roots', () => {
  const { interpolated } = scanPrefixes();
  assert.deepStrictEqual(interpolated, [],
    'These sites mint with a template-interpolated prefix, and tmp-sweep.sh can never remove the roots '
    + 'they leave behind: it anchors mkdtemp\'s six random characters DIRECTLY after the prefix, so a root '
    + `named clodex-menu-<tag>-A1b2c3 does not match clodex-menu-. Worse, the scan truncates at the `
    + 'interpolation, so the truncated stem lands in PREFIXES and the coverage test above certifies these '
    + 'roots as swept while they accumulate forever. Mint with a LITERAL prefix and put the varying part '
    + `in a file or a subdirectory under the root instead:\n  ${interpolated.join('\n  ')}`);
});

test('the scan seeds itself from every $TMPDIR-minting export of test/lib/tmp-roots.js', () => {
  const helper = require('./lib/tmp-roots.js');
  const exported = Object.keys(helper);
  assert.ok(exported.length > 0, 'ENTER: the helper must export something, or this test compares two empty lists');
  for (const name of SEEDS) {
    assert.ok(exported.includes(name),
      `the scan seeds itself with ${name}(), which test/lib/tmp-roots.js no longer exports. A seed that `
      + 'does not exist collects nothing, and the prefixes it used to reach silently leave PREFIXES.');
  }
  const unclassified = exported.filter((n) => !SEEDS.includes(n) && !NOT_SEEDS.includes(n));
  assert.deepStrictEqual(unclassified, [],
    `test/lib/tmp-roots.js exports ${unclassified.join(', ')}, which this scan neither seeds nor `
    + 'deliberately excludes. If it mints a direct child of $TMPDIR, add it to SEEDS or tmp-sweep.sh '
    + 'will never remove its abandoned roots; if it mints inside an already-tracked root (as mkTmpDirIn '
    + 'does, which is why that one is excluded), add it to NOT_SEEDS and say so.');
  const code = maskSource(fs.readFileSync(path.join(REPO, 'test', 'lib', 'tmp-roots.js'), 'utf8')).masked;
  const decl = code.indexOf('function mkTmpDirIn');
  assert.ok(decl >= 0, 'ENTER: mkTmpDirIn must be declared as a function for its body to be readable');
  const body = bodyAt(code, code.indexOf('{', decl));
  assert.match(body, /const resolved = path\.resolve\(parent\);/,
    'ENTER: the path mkTmpDirIn mints under must be derived from its `parent` argument');
  assert.match(body, new RegExp(`${MINT}\\(path\\.join\\(resolved,`),
    'ENTER: mkTmpDirIn must still mint under that resolved parent rather than under os.tmpdir(). If it '
    + 'ever mints a direct child of $TMPDIR it belongs in SEEDS, and excluding it would leak every root it makes.');
});

test('a mint call written inside a string or a comment is not collected as a mint site', () => {
  const quoted = 'const msg = "call mkTmpRoot(\'quoted-\') instead";\n';
  const templated = 'const msg = `call mkTmpRoot(\'templated-\') instead`;\n';
  const lineComment = '// call mkTmpRoot(\'linecomment-\') instead\n';
  const blockComment = '/* call mkTmpRoot(\'blockcomment-\') instead */\n';
  const real = 'mkTmpRoot(\'real-\');\n';
  const collect = (src) => {
    const { masked, values } = maskSource(src);
    return [...masked.matchAll(new RegExp(`\\b(?:${SEEDS.join('|')})\\(\\s*(['"\`])([^'"\`]*)\\1`, 'g'))]
      .map((m) => literal(m[2], values).prefix).filter(Boolean);
  };
  assert.deepStrictEqual(collect(real), ['real-'],
    'ENTER: a genuine mkTmpRoot call must still be collected, or masking has simply blinded the scan');
  for (const [what, src] of [['a double-quoted string', quoted], ['a template literal', templated],
    ['a line comment', lineComment], ['a block comment', blockComment]]) {
    assert.deepStrictEqual(collect(src), [],
      `prose in ${what} telling a reader to call mkTmpRoot('…') is not a mint site. test/tmp-roots-pin.test.js `
      + 'says exactly that in an assertion message, and without masking the scan collected `prefix` from it — '
      + 'which would have shipped `prefix` into PREFIXES and made `prefixA1b2c3` a deletion target anywhere in $TMPDIR.');
  }
  assert.deepStrictEqual(collect(quoted + real + lineComment), ['real-'],
    'and a real call sitting between two masked ones is still collected');
});

test('the live prose case in test/tmp-roots-pin.test.js is masked, not merely absent', () => {
  const src = fs.readFileSync(path.join(REPO, 'test', 'tmp-roots-pin.test.js'), 'utf8');
  assert.match(src, /mkTmpRoot\('prefix'\)/,
    'ENTER: test/tmp-roots-pin.test.js must still contain the prose `mkTmpRoot(\'prefix\')` in its assertion '
    + 'message, or this regression case no longer exists in the tree and this test proves nothing');
  const { masked, values } = maskSource(src);
  const collected = [...masked.matchAll(new RegExp(`\\b(?:${SEEDS.join('|')})\\(\\s*(['"\`])([^'"\`]*)\\1`, 'g'))]
    .map((m) => literal(m[2], values).prefix).filter(Boolean);
  assert.ok(collected.includes('tmp-roots-pin-'),
    'the real mkTmpRoot(\'tmp-roots-pin-\') call in that file must still be collected');
  assert.ok(!collected.includes('prefix'),
    '`prefix` is the word the assertion message uses as a placeholder, not a prefix the suite mints. '
    + 'It reached PREFIXES once and turned the merged branch red on master.');
});

test('every prefix, scanned or listed, is shaped like a prefix', () => {
  const { union } = scanPrefixes();
  const listed = scriptPrefixes();
  const SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]*-$/;
  const why = 'A collected literal that is not prefix-shaped means the scan attributed a mint to the wrong '
    + 'function or read a string as code, and PREFIXES is interpolated straight into the deletion pattern: '
    + 'a bare word like `prefix` makes every `prefixA1b2c3` in $TMPDIR a deletion target, whoever owns it.';
  const misshapen = [...union].filter(([p]) => !SHAPE.test(p) || p.length < 3)
    .map(([p, where]) => `${JSON.stringify(p)} (${where})`);
  assert.deepStrictEqual(misshapen, [], `scanned but not prefix-shaped:\n  ${misshapen.join('\n  ')}\n${why}`);
  const badListed = listed.filter((p) => !SHAPE.test(p) || p.length < 3);
  assert.deepStrictEqual(badListed, [], `listed in tmp-sweep.sh but not prefix-shaped:\n  ${badListed.join('\n  ')}\n${why}`);
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
  const collapsible = listed.filter((p) => listed.some((q) => q !== p && q.startsWith(p)));
  assert.ok(collapsible.length > 0,
    'ENTER: the list must contain at least one entry that is a string-prefix of another, or there is '
    + 'nothing a collapse could have thrown away and this test proves nothing');
  const stem = collapsible[0];
  const longer = listed.find((q) => q !== stem && q.startsWith(stem));
  const probe = `${longer}a1b2c3`;
  const alternation = new RegExp(`^(?:${listed.map(escapeRe).join('|')})[A-Za-z0-9]{6}(?:-.*)?$`);
  assert.ok(!new RegExp(`^(?:${escapeRe(stem)})[A-Za-z0-9]{6}(?:-.*)?$`).test(probe),
    `ENTER: the six-character anchor is what makes a family root non-transitive; if ${stem} ever matched `
    + `${probe} on its own, the collapse this test forbids would become safe and this test is stale`);
  assert.ok(alternation.test(probe),
    `a root minted as ${longer}<six> must match: listing ${stem} alone does NOT cover it, because the `
    + 'six-character anchor sits directly after the prefix. Collapsing the list by string-prefix dropped '
    + 'about four in five matching roots when measured.');
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
