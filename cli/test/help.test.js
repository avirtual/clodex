'use strict';
// help.test.js — contextual help (T43). Four guarantees the spec pins:
//   1. registry completeness — every DISPATCHED top-level verb has an entry, so
//      a future verb can't ship helpless (pinned against main.js's TOP_VERBS).
//   2. the grouped index renders every group + every verb.
//   3. `<verb> --help` (and `help <verb>`) short-circuits BEFORE any wire/ctx —
//      no context resolution, no WireClient, no transport spawn.
//   4. an unknown verb gets a usage exit + a nearest-match hint.
const { test } = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const path = require('node:path');
const { run, TOP_VERBS, SPECIAL_VERBS } = require('../src/main');
const { help, renderIndex, VERB_REGISTRY, GROUPS } = require('../src/help');

// Capture a run(argv, io). No contextsFile, empty env, and a spawnFn that BLOWS
// UP if called: a help path that reached the wire would either resolve a ctx
// (there is none → USAGE) or spawn a tunnel (→ this throws). Reaching neither is
// the short-circuit proof.
async function cli(argv) {
  let stdout = '', stderr = '';
  const code = await run(argv, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: {},
    contextsFile: '/nonexistent/contexts.json',
    spawnFn: () => { throw new Error('spawnFn called — help did NOT short-circuit'); },
  });
  return { code, stdout, stderr };
}

// ── 1. registry completeness ─────────────────────────────────────────────────
test('every dispatched top-level verb has a registry entry', () => {
  const named = new Set(VERB_REGISTRY.map((e) => e.name));
  const missing = TOP_VERBS.filter((v) => !named.has(v));
  assert.deepStrictEqual(missing, [], `verbs dispatched in main.js but absent from the help registry: ${missing.join(', ')}`);
});

test('the registry has no entry for a verb main.js does not dispatch', () => {
  const dispatched = new Set(TOP_VERBS);
  const orphan = VERB_REGISTRY.map((e) => e.name).filter((n) => !dispatched.has(n));
  assert.deepStrictEqual(orphan, [], `help entries with no dispatch: ${orphan.join(', ')}`);
});

// SPECIAL_VERBS is a hand-maintained list beside the if-branches — the one
// place completeness could drift in lockstep (a new `if (verb === 'x')`
// without a SPECIAL_VERBS entry ships helpless and every list-based test
// stays green; port-forward and web were added exactly this way). Extract
// the branch literals from main.js source and pin the two sets equal.
test('SPECIAL_VERBS matches the special-cased dispatch branches in main.js source', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf-8');
  const wire = new Set(TOP_VERBS.filter((v) => !SPECIAL_VERBS.includes(v)));
  const found = new Set();
  for (const m of src.matchAll(/if \(verb === '([a-z-]+)'\)/g)) {
    if (!wire.has(m[1])) found.add(m[1]);
  }
  assert.deepStrictEqual([...found].sort(), [...SPECIAL_VERBS].sort(),
    `special-cased dispatch branches vs SPECIAL_VERBS: source has [${[...found].sort().join(', ')}], list has [${[...SPECIAL_VERBS].sort().join(', ')}]`);
});

test('every entry has the required shape (name/group/summary/usage)', () => {
  for (const e of VERB_REGISTRY) {
    assert.ok(e.name, 'entry needs a name');
    assert.ok(e.summary && e.summary.length, `${e.name}: needs a summary`);
    assert.ok(e.usage && [].concat(e.usage).length, `${e.name}: needs a usage`);
    assert.ok(e.group, `${e.name}: needs a group`);
  }
});

// ── 2. the index ─────────────────────────────────────────────────────────────
test('the index renders every group title and every verb', async () => {
  const { code, stdout } = await cli(['--help']);
  assert.strictEqual(code, 0);
  const idx = renderIndex();
  // every group's title appears (GROUPS is [id, TITLE])
  for (const [, title] of GROUPS) {
    assert.match(idx, new RegExp(title.split(' ')[0]), `index missing group ${title}`);
  }
  // every verb name appears as its own index line
  for (const e of VERB_REGISTRY) {
    assert.match(idx, new RegExp(`\\n  ${e.name.replace(/[-]/g, '\\-')}\\s`), `index missing verb ${e.name}`);
  }
  // and the same reaches stdout through main.run
  assert.match(stdout, /clodexctl help <verb>/);
});

test('bare clodexctl prints the index (exit 0)', async () => {
  const { code, stdout } = await cli([]);
  assert.strictEqual(code, 0);
  assert.match(stdout, /USAGE/);
  assert.match(stdout, /DAILY/);
});

// ── 3. per-verb short-circuit ────────────────────────────────────────────────
test('`<verb> --help` short-circuits before any wire, for EVERY verb', async () => {
  for (const v of TOP_VERBS) {
    const { code, stdout, stderr } = await cli([v, '--help']);
    assert.strictEqual(code, 0, `${v} --help exit (stderr: ${stderr})`);
    assert.match(stdout, new RegExp(`^${v.replace(/[-]/g, '\\-')} —`), `${v} --help should render the verb view`);
    assert.match(stdout, /USAGE/, `${v} --help needs a USAGE section`);
  }
});

test('`help <verb>` renders the same per-verb view', async () => {
  const { code, stdout } = await cli(['help', 'exec']);
  assert.strictEqual(code, 0);
  assert.match(stdout, /^exec —/);
  assert.match(stdout, /--pty/);
  assert.match(stdout, /NOTES/);
});

test('`<verb> --help` with a bogus ctx still short-circuits (no resolve)', async () => {
  // --ctx names a context that cannot exist; a non-short-circuiting path would
  // try to resolve it and fail USAGE. Help must win first.
  const { code, stdout } = await cli(['run', '--help', '--ctx', 'does-not-exist']);
  assert.strictEqual(code, 0);
  assert.match(stdout, /^run —/);
});

// ── 4. unknown verb ──────────────────────────────────────────────────────────
test('help for an unknown verb → usage exit + nearest-match hint', async () => {
  const { code, stdout } = await cli(['help', 'logz']);
  assert.strictEqual(code, 2);
  assert.match(stdout, /no help for "logz"/);
  assert.match(stdout, /did you mean `logs`/);
});

test('help for a wildly-wrong token → usage exit, no wild hint', async () => {
  const { code, stdout } = await cli(['help', 'zzzzzzzz']);
  assert.strictEqual(code, 2);
  assert.match(stdout, /no help for "zzzzzzzz"/);
  assert.doesNotMatch(stdout, /did you mean/);
});

// help() unit — the pure surface the renderers hang off.
test('help([]) is the index; help([verb]) is the entry; help([bad]) is usage', () => {
  assert.strictEqual(help([]).code, 0);
  assert.match(help([]).text, /USAGE/);
  assert.strictEqual(help(['ctx']).code, 0);
  assert.match(help(['ctx']).text, /^ctx —/);
  assert.strictEqual(help(['nope']).code, 2);
});
