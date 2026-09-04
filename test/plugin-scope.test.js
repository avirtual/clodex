'use strict';
// plugin-scope.test.js — the SURFACING gate (t190, re-keyed by t654).
//
// `intentEnabledFor` already refuses a plugin verb for a session that was not
// granted it, and has since the registry existed. What it does NOT do is stop
// the verb APPEARING: the row is in every session's checklist, its grammar line
// is in every session's prompt, and its name is in every near-miss bounce. For a
// plugin that exists for one team's seats, "present and refused" is the wrong
// answer — the right one is absent.
//
// t654 moved the QUESTION the gate asks. It used to be "has this seat granted
// this plugin a capability?", which left every GLOBAL plugin visible everywhere;
// it is now "does this seat HAVE this plugin?" (`seatHasPlugin` against the
// seat's own `plugins` list), and every plugin is seat-gated. Grants are demoted
// to a child of that decision. An ABSENT list is the living all-enabled default,
// which is what keeps a pre-upgrade seat byte-identical.
//
// So the property under test here is an ABSENCE, which is exactly the shape
// CLAUDE.md's `## Tests` section warns about: `deepEqual(x, [])` and
// `.every(...)` are both TRUE of a fixture that never registered anything. Every
// absence assertion below is therefore paired with a CONTROL arm — the same
// registration, read with grants that DO reach — so a fixture that silently
// registered nothing fails the control instead of passing the absence.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PLUGIN_SCOPES, DEFAULT_PLUGIN_SCOPE, scopeOf,
  PLUGIN_CAPABILITIES, grantToken, isValidCapability, pluginGranted, seatHasPlugin,
  HOST_API_VERSION,
} = require('../plugin-api');
const registry = require('../intent-registry');
const { validateManifest } = require('../plugin-loader');
const { createPluginHostEngine } = require('../plugin-host-engine');

// The registry's plugin table is MODULE-LEVEL (that is what makes a plugin verb
// live on all three feeds by construction), so every registration is undone in a
// finally — a leaked row changes what every later test in the process parses.
function withReset(fn) {
  try { return fn(); } finally { registry._resetPluginRows(); }
}

// ── The vocabulary (plugin-api.js, the pure leaf) ───────────────────────────

test('scopeOf defaults to global, and ONLY the exact string "session" opts in', () => {
  assert.deepStrictEqual([...PLUGIN_SCOPES], ['global', 'session']);
  assert.strictEqual(DEFAULT_PLUGIN_SCOPE, 'global');
  assert.strictEqual(scopeOf({ scope: 'session' }), 'session');
  // Everything else resolves to global — INCLUDING near-misses. That is safe
  // only because the loader refuses them at the door (pinned below); if it ever
  // stopped, a typo'd scope would silently make a scoped plugin universal.
  for (const junk of [undefined, null, '', 'global', 'Session', 'SESSION', ' session', 0, 1, true, {}, []]) {
    assert.strictEqual(scopeOf({ scope: junk }), 'global', `scope ${JSON.stringify(junk)} is not an opt-in`);
  }
  assert.strictEqual(scopeOf({}), 'global', 'an absent field is global');
  assert.strictEqual(scopeOf(null), 'global', 'and a missing manifest does not throw');
});

test('the three capabilities are independent, each defaulting OFF', () => {
  assert.deepStrictEqual([...PLUGIN_CAPABILITIES], ['turns', 'thinking', 'toolInputs']);
  // Independence is the point of splitting them: the spec's reason for three
  // grants is that a turn archiver must not also receive every Bash command.
  assert.strictEqual(pluginGranted('p', 'toolInputs', ['p:turns']), false,
    'holding turns must not imply toolInputs — that is the whole reason they are separate');
  assert.strictEqual(pluginGranted('p', 'turns', ['p:toolInputs']), false, 'and not the other way either');
  for (const c of PLUGIN_CAPABILITIES) {
    assert.strictEqual(pluginGranted('p', c, [grantToken('p', c)]), true, `${c} is granted by its own token`);
    assert.strictEqual(pluginGranted('p', c, null), false, `${c} defaults off with no list`);
    assert.strictEqual(pluginGranted('p', c, []), false, `${c} defaults off with an empty list`);
  }
  assert.strictEqual(isValidCapability('turns'), true);
  assert.strictEqual(isValidCapability('everything'), false);
  assert.strictEqual(pluginGranted('p', 'everything', ['p:everything']), false,
    'an unknown capability is refused even when its token is literally present');
});

test('a grant token can never be confused with an intent verb', () => withReset(() => {
  // Both lists ride the same persistence entry, so the two vocabularies must be
  // disjoint BY CONSTRUCTION rather than by convention. `:` is what does it —
  // PLUGIN_VERB_RE admits no colon. Driven through the real registration rather
  // than asserted against the regex, because the regex is not the only thing
  // that would have to stay true for a collision to be impossible.
  for (const c of PLUGIN_CAPABILITIES) {
    const tok = grantToken('some-plugin', c);
    assert.ok(tok.includes(':'), 'a grant token contains a colon');
    assert.strictEqual(registry.PLUGIN_VERB_RE.test(tok), false, `${tok} does not match the verb grammar`);
    assert.throws(() => registry.registerIntent(mkRow(tok), 'some-plugin'), /invalid intent verb/,
      `${tok} must be unregisterable as a verb — otherwise a grant and a verb could collide in one list`);
  }
  // CONTROL: the same registration shape succeeds for a legal verb, so the
  // throws above are about the token, not a broken fixture.
  assert.doesNotThrow(() => registry.registerIntent(mkRow('legal'), 'some-plugin'));
}));

test('pluginGranted is STRICT — an absent list is a refusal, never a default grant', () => {
  // The same rule intentEnabledFor's comment states at intent-registry.js:283.
  // A scoped plugin that fell back to "granted" for a session created before it
  // existed would be a retroactive grant to every seat that ever existed.
  for (const absent of [undefined, null, 'p:turns', { 'p:turns': true }, 0]) {
    assert.strictEqual(pluginGranted('p', 'turns', absent), false,
      `a non-array grants value (${JSON.stringify(absent)}) is a refusal`);
    assert.strictEqual(seatHasPlugin('p', absent), true,
      'seatHasPlugin is the OPPOSITE polarity, deliberately: absent means the living '
      + 'all-enabled default, so a pre-upgrade seat keeps every shipped plugin');
  }
  assert.strictEqual(seatHasPlugin('p', ['q', 'r']), false,
    'a list that names other plugins does not reach this one');
  assert.strictEqual(seatHasPlugin('p', ['p']), true,
    'CONTROL: a list naming it does reach — so the refusal above is about the input, not a broken predicate');
});

// ── The manifest gate (plugin-loader.js) ────────────────────────────────────

const OK_MANIFEST = { id: 'demo', hostApi: HOST_API_VERSION, entry: { engine: 'engine.js' } };

test('the loader accepts both scopes and REFUSES anything else', () => {
  assert.strictEqual(validateManifest(OK_MANIFEST, 'demo'), null, 'CONTROL: the base manifest is valid');
  for (const s of PLUGIN_SCOPES) {
    assert.strictEqual(validateManifest({ ...OK_MANIFEST, scope: s }, 'demo'), null, `scope "${s}" loads`);
  }
  // Refusal, not a default. `scopeOf` resolves an unknown scope to `global`, so
  // a typo on a plugin meant to be invisible would load it for every session —
  // the exact failure the field exists to prevent, and silent.
  for (const junk of ['Session', 'sessions', 'per-session', 'none', '', 1, true, {}]) {
    const why = validateManifest({ ...OK_MANIFEST, scope: junk }, 'demo');
    assert.match(String(why), /invalid scope/, `scope ${JSON.stringify(junk)} must be refused by name`);
  }
  assert.strictEqual(validateManifest({ ...OK_MANIFEST, scope: null }, 'demo'), null,
    'an explicitly null scope is the absent case, not an error');
});

// ── The four shipped plugins (clodex: "the assertion I will look for first") ─

test('every SHIPPED plugin is global — the field changes nothing that exists today', () => {
  const dir = path.join(__dirname, '..', 'plugins');
  const ids = fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => fs.existsSync(path.join(dir, d.name, 'manifest.json')))
    .map((d) => d.name)
    .sort();
  // ENTER: the reduction above must have found the shipped set. A glob that
  // matched nothing would satisfy every assertion in the loop below vacuously.
  //
  // MEMBERSHIP, not the whole list. The invariant under test is "no shipped
  // plugin opts into session scope", which is a property of EACH manifest —
  // pinning the exact catalog makes every new plugin fail a test about the
  // existing ones, which is how a second shipped plugin once failed a test
  // about the first (test/plugin-kill-switch.test.js:98-101). The named four
  // are asserted present because they are what makes the loop non-vacuous.
  for (const known of ['git-branches', 'memory-viewer', 'tickets-viewer', 'workbench']) {
    assert.ok(ids.includes(known), `ENTER: ${known} was read off disk`);
  }
  for (const id of ids) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, id, 'manifest.json'), 'utf8'));
    assert.ok(!('scope' in m), `${id} declares no scope — no shipped plugin may opt in`);
    assert.strictEqual(scopeOf(m), 'global', `${id} therefore resolves to global`);
    assert.strictEqual(validateManifest(m, id), null, `${id} still validates`);
  }
});

// ── The registry's surfacing filter ─────────────────────────────────────────

function mkRow(verb, extra = {}) {
  return {
    verb,
    parse: (l) => (l === `[agent:${verb}]` ? { probe: verb } : null),
    promptLines: `  [agent:${verb}]   line for ${verb}.`,
    ...extra,
  };
}

test('an ABSENT plugins list surfaces every plugin — the living default that keeps pre-upgrade seats whole', () => withReset(() => {
  registry.registerIntent(mkRow('glob'), 'globby', { scope: 'global' });
  registry.registerIntent(mkRow('scoped'), 'scopey', { scope: 'session' });
  // A pre-upgrade seat has no `plugins` key at all, and SCOPE no longer enters
  // into it: t654 made every plugin seat-gated, so the scoped row rides the same
  // default as the global one.
  for (const plugins of [undefined, null, 'nonsense', 42]) {
    const rows = registry.catalogRows(plugins);
    assert.ok(rows.some((r) => r.type === 'glob'),
      `the global row is in the checklist for plugins ${JSON.stringify(plugins)}`);
    assert.ok(rows.some((r) => r.type === 'scoped'),
      `and so is the SESSION-scoped one — scope stopped deciding visibility`);
    assert.ok(registry.validIntentNames(plugins).includes('glob'));
    assert.deepStrictEqual(registry.pluginGrammarLines(['glob'], plugins), ['  [agent:glob]   line for glob.']);
  }
}));

test('a plugin the seat does NOT have is ABSENT from every feed, scope irrelevant', () => withReset(() => {
  registry.registerIntent(mkRow('scoped'), 'scopey', { scope: 'session' });
  registry.registerIntent(mkRow('glob'), 'globby', { scope: 'global' });

  // CONTROL FIRST, deliberately. The absence assertions below are all true of a
  // registry that never took the rows; this proves they are really there and
  // really reachable, so the absences that follow are about the GATE.
  const has = ['scopey', 'globby'];
  const shown = registry.catalogRows(has);
  assert.ok(shown.some((r) => r.type === 'scoped'),
    'CONTROL: a seat that has the plugin sees its row — the fixture reached the state it names');
  assert.ok(registry.validIntentNames(has).includes('scoped'),
    'CONTROL: and the verb is in the near-miss vocabulary');
  assert.deepStrictEqual(registry.pluginGrammarLines(['scoped'], has),
    ['  [agent:scoped]   line for scoped.'], 'CONTROL: and contributes its grammar line');

  // The property: absent, not present-and-denied. `[]` is the seat that has NO
  // plugins, which under the old grants keying was indistinguishable from the
  // absent list — it is a real, distinct value now.
  for (const plugins of [[], ['someone-else'], ['scopey-typo']]) {
    const rows = registry.catalogRows(plugins);
    assert.ok(rows.length > 0, `ENTER: the catalog is non-empty for ${JSON.stringify(plugins)} — core rows always survive`);
    assert.strictEqual(rows.some((r) => r.type === 'scoped'), false,
      `no checklist row for plugins ${JSON.stringify(plugins)}`);
    assert.strictEqual(rows.some((r) => r.type === 'glob'), false,
      'and a GLOBAL plugin is gated identically — that short circuit is gone');
    assert.strictEqual(registry.validIntentNames(plugins).includes('scoped'), false,
      'and the bounce must not advertise a verb the seat cannot see');
    assert.deepStrictEqual(registry.pluginGrammarLines(['scoped'], plugins), [],
      'and no grammar line, EVEN THOUGH the intent list names the verb — the seat filter is the outer one');
  }
}));

test('the seat gate hides; intentEnabledFor still does not enforce it — intentEnabledForSeat does', () => withReset(() => {
  registry.registerIntent(mkRow('scoped2'), 'scopey2', { scope: 'session' });
  // `intentEnabledFor` is the intents-only predicate and stays that way: it
  // answers off the allowlist alone, with no knowledge of the seat's plugins.
  assert.strictEqual(registry.intentEnabledFor('scoped2', null), false);
  assert.strictEqual(registry.intentEnabledFor('scoped2', ['dm']), false);
  assert.strictEqual(registry.intentEnabledFor('scoped2', ['scoped2']), true,
    'the intents-only gate answers the same way it always has');
  // `intentEnabledForSeat` is the one the fire path uses, and it is the hole
  // write-time pruning alone leaves: an allowlist naming the verb is not enough.
  assert.strictEqual(registry.intentEnabledForSeat('scoped2', { intents: ['scoped2'], plugins: ['scopey2'] }), true,
    'CONTROL: with the plugin held AND the verb checked, it fires');
  assert.strictEqual(registry.intentEnabledForSeat('scoped2', { intents: ['scoped2'], plugins: [] }), false,
    'a stale allowlist entry cannot fire a verb whose plugin the seat no longer has');
  assert.strictEqual(registry.intentEnabledForSeat('scoped2', { intents: ['scoped2'] }), true,
    'and the absent list is still the living default — a pre-upgrade seat is unaffected');
  // A scoped plugin's PARSING is unchanged: the row still parses on every feed.
  // Seat gating is a visibility property, not an isolation one.
  assert.deepStrictEqual(registry.parseWithRegistry('[agent:scoped2]'), { probe: 'scoped2', type: 'scoped2' });
}));

test('the row\'s scope comes from the HOST, never from the plugin\'s own spec', () => withReset(() => {
  // A plugin that could name its own scope could declare itself global. Under
  // t654 that no longer buys visibility either way — every plugin is seat-gated
  // — but the row must still carry the HOST's answer, because scope is what
  // decides whether the plugin offers grant rows at all.
  registry.registerIntent({ ...mkRow('liar'), scope: 'global' }, 'liar-src', { scope: 'session' });
  const row = registry.pluginRowFor('liar');
  assert.strictEqual(row.scope, 'session', 'the manifest wins over the spec field');
  assert.strictEqual(registry.catalogRows([]).some((r) => r.type === 'liar'), false,
    'a seat with no plugins does not see it');
  assert.ok(registry.catalogRows(['liar-src']).some((r) => r.type === 'liar'),
    'CONTROL: the row exists and surfaces once the seat has the plugin');
}));

test('two plugins are visible independently — a tick reaches only its own', () => withReset(() => {
  registry.registerIntent(mkRow('alpha'), 'a-src', { scope: 'session' });
  registry.registerIntent(mkRow('beta'), 'b-src', { scope: 'global' });
  const types = (p) => registry.catalogRows(p).filter((r) => r.source !== 'core').map((r) => r.type);
  assert.deepStrictEqual(types(['a-src']), ['alpha'], 'a tick surfaces its own plugin and no other');
  assert.deepStrictEqual(types(['b-src']), ['beta'], 'including for a GLOBAL plugin, now equally gated');
  assert.deepStrictEqual(types(['a-src', 'b-src']).sort(), ['alpha', 'beta'],
    'CONTROL: both surface when both are ticked, in registration order');
  assert.deepStrictEqual(types([]), []);
}));

// A literal count, not one computed by the rule under test: a table that
// re-derives the expectation the way catalogRows does asserts only that the code
// agrees with itself, and could not express an exception if one existed.
test('catalogRows with 3 plugins registered and 1 ticked returns core + exactly that one\'s rows', () => withReset(() => {
  const core = registry.catalogRows([]).length;
  assert.ok(core > 0, 'ENTER: the core rows are the baseline this counts against');
  registry.registerIntent(mkRow('p1a'), 'plug-one');
  registry.registerIntent(mkRow('p1b'), 'plug-one');
  registry.registerIntent(mkRow('p2a'), 'plug-two', { scope: 'session' });
  registry.registerIntent(mkRow('p3a'), 'plug-three');
  assert.strictEqual(registry.catalogRows(undefined).length, core + 4,
    'ENTER: all four plugin rows registered — the absent list surfaces every one');
  const ticked = registry.catalogRows(['plug-one']);
  assert.strictEqual(ticked.length, core + 2, 'core rows plus plug-one\'s two verbs, and nothing else');
  assert.deepStrictEqual(ticked.filter((r) => r.source !== 'core').map((r) => r.type), ['p1a', 'p1b']);
}));

test('pruneForPlugins drops verbs AND grants for an unticked plugin, and leaves a null allowlist null', () => withReset(() => {
  registry.registerIntent(mkRow('keptverb'), 'kept');
  registry.registerIntent(mkRow('goneverb'), 'gone', { scope: 'session' });
  const entry = {
    intents: ['dm', 'keptverb', 'goneverb'],
    pluginGrants: ['kept:turns', 'gone:turns', 'gone:thinking'],
  };
  const out = registry.pruneForPlugins(entry, ['kept']);
  assert.deepStrictEqual(out.intents, ['dm', 'keptverb'],
    'the unticked plugin\'s verb goes; core verbs and the ticked plugin\'s verb stay');
  assert.deepStrictEqual(out.pluginGrants, ['kept:turns'],
    'and every grant token whose plugin id is not in the list goes with it');
  assert.deepStrictEqual(entry.intents, ['dm', 'keptverb', 'goneverb'],
    'ENTER: the input is not mutated — the caller decides whether to write back');

  // A null allowlist needs no prune: a plugin row is enabled only by explicit
  // inclusion in an array, never by the all-enabled default, so there is nothing
  // to drop and collapsing null to a list would gate every core verb.
  const nulls = registry.pruneForPlugins({ intents: null, pluginGrants: null }, []);
  assert.strictEqual(nulls.intents, null);
  assert.strictEqual(nulls.pluginGrants, null);
}));

// ── Byte-identity: the no-scoped-plugin world is unchanged ──────────────────

test('with an ABSENT plugins list, every surfacing fn ignores the argument entirely', () => withReset(() => {
  // The t190 form of this asserted grants-INVARIANCE for a registry holding only
  // core + global rows, which was true because `scope !== 'session'` short
  // circuited before the grants were ever read. That short circuit is gone, so
  // the invariance is gone with it: an explicit list now decides a global
  // plugin's visibility too. What survives — and is the property that keeps a
  // pre-upgrade seat whole — is that every NON-ARRAY value is the same answer.
  registry.registerIntent(mkRow('g1'), 'g-src');
  const probes = [undefined, null, 'nonsense', 42, { plugins: ['g-src'] }];
  const base = {
    catalog: registry.catalogRows(),
    names: registry.validIntentNames(),
    grammarNone: registry.pluginGrammarLines(null),
    grammarG1: registry.pluginGrammarLines(['g1']),
  };
  // ENTER: the fixture actually registered — otherwise every deepStrictEqual
  // below compares two copies of the core-only answer and proves nothing.
  assert.ok(base.catalog.some((r) => r.type === 'g1'), 'ENTER: the plugin row is in the baseline');
  assert.deepStrictEqual(base.grammarG1, ['  [agent:g1]   line for g1.'], 'ENTER: and contributes a grammar line');
  for (const p of probes) {
    assert.deepStrictEqual(registry.catalogRows(p), base.catalog, `catalogRows treats ${JSON.stringify(p)} as absent`);
    assert.deepStrictEqual(registry.validIntentNames(p), base.names, `validIntentNames treats ${JSON.stringify(p)} as absent`);
    assert.deepStrictEqual(registry.pluginGrammarLines(null, p), base.grammarNone);
    assert.deepStrictEqual(registry.pluginGrammarLines(['g1'], p), base.grammarG1);
  }
  // And the contrast that makes the above a real claim rather than a tautology:
  // an ARRAY answers, and answers differently.
  assert.strictEqual(registry.catalogRows([]).some((r) => r.type === 'g1'), false,
    'an explicit empty list is NOT the absent list — that distinction is the whole field');
}));

test('allowlistFromChecked is seat-blind — an unsurfaced row cannot be checked', () => withReset(() => {
  registry.registerIntent(mkRow('hidden'), 'h-src', { scope: 'session' });
  // The checklist is the only producer of a checked set, and an unsurfaced row
  // draws no checkbox. So this function needs no plugins argument: by the time it
  // runs, the surfacing decision has already been made upstream. Pinned so nobody
  // "fixes" it by adding a second gate that could disagree with the first.
  const got = registry.allowlistFromChecked(['dm', 'hidden']);
  assert.ok(got.includes('hidden'),
    'a checked plugin verb still becomes a grant — refusing here would silently drop an operator decision');
  assert.strictEqual(registry.intentEnabledFor('hidden', got), true);
}));

// ── The host wiring: manifest scope reaches the registry ────────────────────

function mkEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-scope-'));
  let ui = {};
  const engine = createPluginHostEngine({
    manager: {
      sessions: new Map(),
      list: () => [], listForWorkspace: () => [],
      _broadcast: () => {}, _sendToSession: () => {}, windowForWorkspace: () => null,
      _injectText: () => {},
    },
    getUiSettings: () => ({ get: () => ui, set: (patch) => { ui = { ...ui, ...patch }; } }),
    log: { info: () => {}, error: () => {} },
    userDataPath: dir,
    fs, path,
    gitWorktree: {},
    telemetrySnapshot: () => null,
    getLoader: () => null,
  });
  return { engine, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('host.intents.register carries the MANIFEST\'s scope into the registry row', () => withReset(() => {
  const { engine, cleanup } = mkEngine();
  try {
    engine.register('scoped-plug', {
      activate(h) { h.intents.register(mkRow('fromscoped')); },
    }, { hostApi: HOST_API_VERSION, scope: 'session' });
    engine.register('global-plug', {
      activate(h) { h.intents.register(mkRow('fromglobal')); },
    }, { hostApi: HOST_API_VERSION });

    assert.strictEqual(registry.pluginRowFor('fromscoped').scope, 'session');
    assert.strictEqual(registry.pluginRowFor('fromglobal').scope, 'global',
      'a manifest with no scope produces a global row — the shipped four');

    // Scope reaching the row is what makes the plugin OFFER GRANTS; it no longer
    // decides visibility. So the absent list surfaces BOTH verbs, and the seat's
    // own list is what hides either of them.
    const absent = registry.catalogRows(null).map((r) => r.type);
    assert.ok(absent.includes('fromglobal'),
      'ENTER: the global verb registered — so the absences below are the gate, not an empty registry');
    assert.ok(absent.includes('fromscoped'),
      'ENTER: and so did the scoped one — the absent list is the all-enabled default for both');
    const only = registry.catalogRows(['global-plug']).map((r) => r.type);
    assert.ok(only.includes('fromglobal'), 'a ticked plugin\'s verb surfaces');
    assert.strictEqual(only.includes('fromscoped'), false,
      'and an unticked one\'s does not, whatever its scope says');
  } finally { cleanup(); }
}));

// ════════════════════════════════════════════════════════════════════════════
// P2 — the SESSION seam: persistence, IPC, and the seat's prompt
// ════════════════════════════════════════════════════════════════════════════

const { registerIpcHandlers } = require('../ipc-handlers');

// registerIpcHandlers is transport-agnostic, so it drives with capturing seams
// and an in-memory persistence fake carrying the two methods these handlers
// touch. Everything else is a stub the registration never calls.
function ipcFixture({ entries = {}, pluginStatus = null } = {}) {
  const handlers = new Map();
  const store = { ...entries };
  const persistence = {
    get: (name) => store[name] || null,
    // The REAL divergence rule from stores.js: a non-empty array persists,
    // anything else DELETES the key. Copied faithfully because the "absent means
    // no grants" property depends on it.
    setPluginGrants(name, grants) {
      if (!store[name]) return;
      if (Array.isArray(grants) && grants.length) store[name].pluginGrants = grants.map(String);
      else delete store[name].pluginGrants;
    },
    // Present because setPluginGrants RECONCILES the allowlist — a revoke must
    // drop the plugin's verbs at the same write point, or the two stored
    // decisions disagree and the UI hides the side that still bites.
    setIntents(name, intents) {
      if (!store[name]) return;
      store[name].intents = Array.isArray(intents) ? [...intents] : null;
    },
    // The REAL rule from stores.js, and NOT setPluginGrants' shape: any array
    // persists, including the empty one, because `[]` is the seat that has no
    // plugins while absent is the seat that has all of them.
    setPlugins(name, plugins) {
      if (!store[name]) return;
      if (Array.isArray(plugins)) store[name].plugins = plugins.map(String);
      else delete store[name].plugins;
    },
  };
  const stub = () => () => {};
  const deps = new Proxy({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    persistence,
    getPluginHost: () => (pluginStatus ? { status: () => pluginStatus } : null),
    log: { info() {}, error() {} },
  }, {
    get(t, p) { return p in t ? t[p] : stub(); },
  });
  registerIpcHandlers(deps);
  return {
    store,
    catalog: (name, override) => handlers.get('intents:catalog')(null, name, override),
    getGrants: (name, override) => handlers.get('session:pluginGrants')(null, name, override),
    setGrants: (name, g) => handlers.get('session:setPluginGrants')(null, name, g),
    setPlugins: (name, p) => handlers.get('session:setPlugins')(null, name, p),
  };
}

test('intents:catalog resolves the seat\'s plugins off the NAMED session', () => withReset(() => {
  registry.registerIntent(mkRow('ipcscoped'), 'ipc-plug', { scope: 'session' });
  const f = ipcFixture({
    entries: {
      has: { name: 'has', plugins: ['ipc-plug'] },
      hasnt: { name: 'hasnt', plugins: [] },
      bare: { name: 'bare' },
    },
  });
  const types = (name, override) => f.catalog(name, override).map((r) => r.type);
  // CONTROL first: the row is registered and reachable, so the absences below
  // are the gate rather than an empty registry.
  assert.ok(types('has').includes('ipcscoped'),
    'CONTROL: a seat that has the plugin sees the row over IPC');
  assert.ok(types('hasnt').length > 0, 'ENTER: a seat without it still gets the core catalog');
  assert.strictEqual(types('hasnt').includes('ipcscoped'), false, 'and not the plugin row');
  assert.ok(types('bare').includes('ipcscoped'),
    'a pre-upgrade seat with NO plugins key takes the living default and sees everything');
  assert.ok(types('nosuchsession').includes('ipcscoped'),
    'and an unknown name is the same absent-list answer, not "none"');
  // The t190 ruling — "an absent name means no grants, so scoped rows do not
  // surface" — was about GRANTS and does not carry: with no name and no override
  // the answer is the globally enabled set, which is exactly what an absent list
  // resolves to, since only a globally enabled plugin ever registers a row here.
  assert.ok(types(undefined).includes('ipcscoped'),
    'an omitted name falls back to the globally-enabled set, not to "none" and not to "all seats"');
  // The override is the LIVE ticked set from the plugin checklist, and it WINS
  // over the persisted list — that is what repaints the intent list as the
  // operator ticks, rather than at the next open.
  assert.strictEqual(types('has', []).includes('ipcscoped'), false,
    'an override of [] hides the row even for a seat whose persisted list has it');
  assert.ok(types('hasnt', ['ipc-plug']).includes('ipcscoped'),
    'and an override naming it shows the row for a seat whose persisted list does not');
  assert.ok(types(undefined, ['ipc-plug']).includes('ipcscoped'),
    'CONTROL: the New-session dialog passes an override with no name at all');
}));

test('session:setPlugins writes the parent, then prunes both children against it', () => withReset(() => {
  registry.registerIntent(mkRow('keptverb'), 'kept');
  registry.registerIntent(mkRow('goneverb'), 'gone', { scope: 'session' });
  const f = ipcFixture({
    entries: {
      seat: {
        name: 'seat',
        intents: ['dm', 'keptverb', 'goneverb'],
        pluginGrants: ['kept:turns', 'gone:thinking'],
      },
    },
  });
  assert.deepStrictEqual(f.setPlugins('nope', ['kept']), { ok: false, error: 'Session not found in persistence' });

  assert.deepStrictEqual(f.setPlugins('seat', ['kept']), { ok: true });
  assert.deepStrictEqual(f.store.seat.plugins, ['kept'], 'ENTER: the parent decision was persisted');
  assert.deepStrictEqual(f.store.seat.intents, ['dm', 'keptverb'],
    'the unticked plugin\'s verb is dropped from the allowlist at the parent write point');
  assert.deepStrictEqual(f.store.seat.pluginGrants, ['kept:turns'],
    'and so is its grant token — the grant is a CHILD of the tick, not an independent decision');

  // The empty array is a real value and must persist: absent means ALL, so
  // storing "no plugins" as absence would flip the strictest seat to the loosest.
  f.setPlugins('seat', []);
  assert.deepStrictEqual(f.store.seat.plugins, [], 'an empty list is stored as [], never as absence');
  assert.deepStrictEqual(f.store.seat.intents, ['dm'], 'and every plugin verb goes with it');
  assert.ok(!('pluginGrants' in f.store.seat) || f.store.seat.pluginGrants.length === 0,
    'as does every grant');
}));

test('session:setPluginGrants sanitizes at the door and stores divergence only', () => {
  const f = ipcFixture({ entries: { seat: { name: 'seat' } } });
  assert.deepStrictEqual(f.setGrants('nope', ['p:turns']), { ok: false, error: 'Session not found in persistence' });

  f.setGrants('seat', ['good-plugin:turns', 'good-plugin:everything', 'bad plugin:turns',
    'noseparator', ':turns', 'good-plugin:thinking', 'good-plugin:turns', 42, null]);
  // ENTER: the write reached the store at all — an assertion about WHICH tokens
  // survived proves nothing if none did.
  assert.ok(Array.isArray(f.store.seat.pluginGrants), 'ENTER: grants were persisted');
  assert.deepStrictEqual(f.store.seat.pluginGrants.sort(), ['good-plugin:thinking', 'good-plugin:turns'],
    'unknown capabilities, malformed ids, non-strings and duplicates are all dropped');

  // Divergence-only, and the polarity is the INVERSE of intents: absent means no
  // plugin reaches this seat, so an empty result must remove the key rather than
  // persist [].
  f.setGrants('seat', []);
  assert.ok(!('pluginGrants' in f.store.seat), 'an empty grant set is stored as ABSENCE');
  f.setGrants('seat', ['good-plugin:turns']);
  f.setGrants('seat', null);
  assert.ok(!('pluginGrants' in f.store.seat), 'and so is a null');
});

test('session:pluginGrants offers SCOPED plugins only, and reports what is granted', () => {
  const f = ipcFixture({
    entries: { seat: { name: 'seat', pluginGrants: ['scoped-a:turns'] } },
    pluginStatus: {
      plugins: [
        { id: 'scoped-a', name: 'Scoped A', scope: 'session', enabled: true, quarantined: false },
        { id: 'scoped-b', name: 'Scoped B', scope: 'session', enabled: true, quarantined: false },
        { id: 'globalish', name: 'Global One', scope: 'global', enabled: true, quarantined: false },
        { id: 'scoped-off', name: 'Disabled', scope: 'session', enabled: false, quarantined: false },
        { id: 'scoped-quar', name: 'Quarantined', scope: 'session', enabled: true, quarantined: true },
      ],
    },
  });
  const res = f.getGrants('seat');
  assert.strictEqual(res.ok, true);
  // This fixture's seat carries NO `plugins` key, so it takes the living
  // all-enabled default — which is what makes the scope filter the only one
  // acting in the assertions below.
  assert.ok(!('plugins' in f.store.seat), 'ENTER: the seat is on the absent-list default');
  // ENTER: the filter kept something. `deepStrictEqual(x, [])` would be true of
  // a status read that returned nothing at all.
  assert.ok(res.plugins.length > 0, 'ENTER: the scoped plugins survived the filter');
  assert.deepStrictEqual(res.plugins.map((p) => p.id), ['scoped-a', 'scoped-b'],
    'a GLOBAL plugin is not offered — it has no per-session decision, and offering it '
    + 'would invite withholding something that is not withheld');
  assert.deepStrictEqual(res.granted, ['scoped-a:turns']);
  assert.deepStrictEqual(res.capabilities, [...PLUGIN_CAPABILITIES]);
  assert.deepStrictEqual(f.getGrants('nope'), { ok: false, error: 'Session not found in persistence' });

  // t654: the seat's plugin list is the OUTER filter. A scoped plugin the seat
  // does not have offers it no decision, so its rows must not draw — and the
  // override is what makes an untick in the popover drop them in the same
  // repaint rather than at the next open.
  assert.deepStrictEqual(f.getGrants('seat', ['scoped-b']).plugins.map((p) => p.id), ['scoped-b'],
    'an override narrows the offer to the ticked plugins');
  assert.deepStrictEqual(f.getGrants('seat', []).plugins, [],
    'and a seat with no plugins is offered nothing');
  const narrowed = ipcFixture({
    entries: { seat: { name: 'seat', plugins: ['scoped-b'], pluginGrants: ['scoped-a:turns'] } },
    pluginStatus: {
      plugins: [
        { id: 'scoped-a', name: 'Scoped A', scope: 'session', enabled: true, quarantined: false },
        { id: 'scoped-b', name: 'Scoped B', scope: 'session', enabled: true, quarantined: false },
      ],
    },
  });
  assert.deepStrictEqual(narrowed.getGrants('seat').plugins.map((p) => p.id), ['scoped-b'],
    'the PERSISTED list filters too, not only the override');
  assert.deepStrictEqual(narrowed.getGrants('seat').granted, ['scoped-a:turns'],
    'while a token held for an unlisted plugin is still REPORTED — grantsForUnlistedPlugins '
    + 'carries it forward, so hiding it here would make the save silently revoke it');

  // With no plugin host (kill switch, or construction failed) the UI must draw
  // nothing rather than throw — the same fail-safe posture as intents:catalog.
  const bare = ipcFixture({ entries: { seat: { name: 'seat' } } });
  assert.deepStrictEqual(bare.getGrants('seat').plugins, []);
  assert.deepStrictEqual(bare.getGrants('seat').granted, []);
});

// The seat's PROMPT. `_realIpcFor` is the one assembly both the spawn and
// refreshPrompt run through (that is what keeps their bytes equal), so it is
// where a grants-blind grammar line would show up in a seat's context.
test('a plugin\'s grammar line reaches only a seat that HAS it', () => withReset(() => {
  const { createSessionManager } = require('../session-manager');
  const intentRegistry = require('../intent-registry');
  intentRegistry.registerIntent(mkRow('promptverb'), 'prompt-plug', { scope: 'session' });

  const SessionManager = createSessionManager({
    buildIpcPrompt: require('../ipc-prompt').buildIpcPrompt,
    mergeClaudeSystemPrompt: require('../argv-merge').mergeClaudeSystemPrompt,
    readAppendBodies: () => [],
    // The REAL one — stubbing it here would remove the only thing under test.
    pluginGrammarLines: intentRegistry.pluginGrammarLines,
    getPersistence: () => ({ list: () => [], get: () => null }),
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    fs, log: () => {},
  });
  const m = new SessionManager();
  const recipeFor = (plugins) => ({
    extraArgs: [], intents: ['promptverb'], execCommands: [], plugins,
    appendPromptFiles: [], inlineBody: null, hasSystemFile: false, ipcDisabled: false,
  });
  const LINE = '[agent:promptverb]';

  // CONTROL: held, the line IS baked in. Without this the absence below is
  // equally true of a prompt builder that dropped every plugin line.
  const held = m._realIpcFor(recipeFor(['prompt-plug']), null).realIpc;
  assert.ok(held.includes(LINE), 'CONTROL: a seat that has the plugin is told about the verb');
  // The absent list is the living default and must ALSO carry the line — that is
  // what keeps a pre-upgrade seat's prompt byte-identical.
  assert.ok(m._realIpcFor(recipeFor(null), null).realIpc.includes(LINE),
    'CONTROL: and so is a pre-upgrade seat whose recipe carries no list at all');

  for (const g of [[], ['other-plugin']]) {
    const out = m._realIpcFor(recipeFor(g), null).realIpc;
    assert.ok(out.length > 100, `ENTER: a real prompt was built for plugins ${JSON.stringify(g)}`);
    assert.strictEqual(out.includes(LINE), false,
      'a seat without the plugin is never told the verb exists — EVEN THOUGH its intents list names it');
  }

  // And byte-identity: such a seat's prompt equals the prompt it would get if the
  // plugin were not installed at all. That is the property the whole ticket is
  // for, and it is stronger than "the line is absent".
  const without = m._realIpcFor(recipeFor([]), null).realIpc;
  intentRegistry._resetPluginRows();
  const noPluginAtAll = m._realIpcFor(recipeFor([]), null).realIpc;
  assert.strictEqual(without, noPluginAtAll,
    'a plugin is byte-invisible to a seat that does not have it');
}));

// ════════════════════════════════════════════════════════════════════════════
// REWORK — the four ways a grant leaked or evaporated after the first pass.
//
// Every one of these is a LIFECYCLE defect rather than a gate defect: the gate
// answered correctly at each instant and the stored answer was wrong by then.
// So the shape here is a SEQUENCE — grant, then do the ordinary thing, then ask
// again — and the assertion is on the second answer. A single-instant assertion
// is exactly what passed while all four were live.
// ════════════════════════════════════════════════════════════════════════════

// ── MF1: a restart must not eat the grant ───────────────────────────────────
// kill() removes the persistence record and create() rebuilds it from spawn
// args, which never carry pluginGrants. The destroying restart is the one the
// Intents popover itself offers ("Restart now to refresh the seat's prompt"),
// so the shipped flow destroyed the grant it existed to bake in — silently, and
// the popover redrew unchecked.
test('REWORK MF1: a grant survives the restart the popover itself offers', () => {
  const { createSessionManager } = require('../session-manager');
  const store = [];
  const persistence = {
    get: (n) => store.find((e) => e.name === n) || null,
    upsert: (e) => {
      const i = store.findIndex((x) => x.name === e.name);
      if (i >= 0) store[i] = { ...store[i], ...e }; else store.push({ ...e });
    },
    remove: (n) => {
      const i = store.findIndex((x) => x.name === n);
      if (i >= 0) store.splice(i, 1);
    },
  };
  const SessionManager = createSessionManager({
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    notifyOS: () => {},
    fs,
  });
  const m = new SessionManager();

  persistence.upsert({ name: 'seat', type: 'claude', cwd: '/p', pluginGrants: ['scoped:turns'], intents: ['x'] });
  const before = persistence.get('seat');
  // ENTER: the grant is really on the record this restart is about to destroy.
  assert.deepStrictEqual(before.pluginGrants, ['scoped:turns'], 'ENTER: the seat starts granted');

  // The restart, in the order the real callers run it: capture, kill (record
  // gone), re-seed, then create()'s rebuild upsert over the stub.
  persistence.remove('seat');
  assert.strictEqual(persistence.get('seat'), null, 'ENTER: kill really did drop the record');
  // engine.restartSession's own field list — pluginGrants is NOT in it, and must
  // not need to be. That is the whole point of the ALWAYS_PRESERVE route: an
  // opt-in list is what every caller already got wrong once (sessionIds).
  m._preserveAcrossRestart('seat', before, ['rosterSentAt', 'ephemeral', 'createdAt']);

  // Seeded BEFORE create(), which is load-bearing beyond persistence: create's
  // `existingEntry` read is what bakes the grammar line into the seat's PROMPT.
  // A post-create re-assert would fix disk and leave a granted seat's prompt
  // missing its line until the NEXT restart.
  assert.deepStrictEqual(persistence.get('seat').pluginGrants, ['scoped:turns'],
    'the grant is on the record create() will read as existingEntry');

  persistence.upsert({ name: 'seat', type: 'claude', cwd: '/p', sessionId: 'new' });
  assert.deepStrictEqual(persistence.get('seat').pluginGrants, ['scoped:turns'],
    'and it survives create()\'s rebuild upsert');
});

// ── MF2: a revoke must reach the renderer ───────────────────────────────────
// A revoke is carried by ABSENCE now that `record` is a tier (t196): the claim
// makes the post-metaFor keys authoritative including by omission, so the
// renderer's tier clear is what drops the stale array. Before the tier, absence
// meant "unchanged" to a plain spread and the key had to be empty-filled on
// every refresh or a revoked plugin kept drawing for the life of the window.
//
// This is t189's `noWire` bug one layer up — an omitted `false` leaving a stale
// `true` — which is why it is pinned against the REAL handler and the REAL merge
// expression rather than through a fixture that answers reachability directly.
// The consequence is that the handler's payload alone can no longer be read as
// the answer: only the payload PLUS the merge says what the renderer holds.
function metaFixture(list, { skipMeta = false } = {}) {
  const handlers = new Map();
  const stub = () => () => {};
  // ONE instance across every row, frozen — exactly how the real metaFor shares
  // its marker (session-meta.js). A per-row array here would let a handler that
  // pushes onto `_tiers` pass, and pushing is both a throw in production and a
  // retroactive re-tier of the whole batch.
  const sharedTiers = Object.freeze(['activity', 'pr']);
  const deps = new Proxy({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    persistence: { listForWorkspace: () => list, get: () => null },
    workspaceOfSender: () => 'ws',
    // Marked exactly as the real metaFor marks a boot-tier response. An unmarked
    // `{}` here would route every assertion below through mergeMeta's
    // compatibility branch, where untiered keys are spread unconditionally — so
    // dropping the `tier &&` guard, which wipes every untiered key on a marked
    // payload, would be invisible to this test. That is the t190 regression.
    sessionMeta: {
      // skipMeta reproduces the row metaFor returned nothing for, which the
      // handler backfills with `{}` — it must still claim `record`, since it
      // really is authoritative about the keys it goes on to write.
      metaFor: async (sessions) => (skipMeta ? {} : Object.fromEntries(
        sessions.map((s) => [s.name, { _tiers: sharedTiers, lastActivityTs: 1 }]))),
    },
    manager: { teamNameFor: () => null },
    getPluginHost: () => null,
    log: { info() {}, error() {} },
  }, { get(t, p) { return p in t ? t[p] : stub(); } });
  registerIpcHandlers(deps);
  const call = (opts) => handlers.get('sidebar:meta')({}, opts);
  call.sharedTiers = sharedTiers;
  return call;
}

const { mergeMeta } = require('../meta-tiers');

test('REWORK MF2: a revoke reaches the renderer through the meta merge', async () => {
  // CONTROL: a granted seat really does carry its tokens over this channel, so
  // the empty array below is the revoke landing rather than the channel being
  // inert in both directions.
  const granted = await metaFixture([{ name: 'seat', cwd: '/p', pluginGrants: ['scoped:turns'] }])({});
  assert.strictEqual(granted.ok, true);
  assert.deepStrictEqual(granted.meta.seat.pluginGrants, ['scoped:turns'],
    'CONTROL: the grant crosses the channel');

  // The revoked state, as persistence stores it: setPluginGrants DELETES the key
  // on empty, so the entry genuinely has no pluginGrants at all.
  const revoked = await metaFixture([{ name: 'seat', cwd: '/p' }])({});
  assert.ok(revoked.meta.seat._tiers.includes('record'),
    'the revoked row must CLAIM the record tier — that claim is the only thing '
    + 'that makes the omission below mean "none" rather than "no news"');
  assert.ok(!('pluginGrants' in revoked.meta.seat),
    'and having claimed it, the handler omits the key rather than empty-filling');

  // The renderer's merge — the REAL function, not a copy. Asserting the
  // handler's payload alone would not prove the revoke survives the merge, and
  // the merge is where the previous version of this fix died. The whole object,
  // not the one key: a partial match reads around a `record` claim that stopped
  // clearing, since the stale array would then simply survive unmentioned.
  // (`prState` is absent from the result because this fixture's metaFor CLAIMS
  // the pr tier and answers nothing for it — the row-only case where an
  // unclaimed tier survives is pinned in the record-only test below.)
  const cached = mergeMeta({ pluginGrants: ['scoped:turns'], team: 't' }, revoked.meta.seat);
  assert.deepStrictEqual(cached, {
    lastActivityTs: 1, createdAt: null, archivedAt: null, team: null,
  }, 'the merge drops the stale array rather than preserving it');
  assert.strictEqual(cached.team, null, 'ENTER: the merge really ran over this object');

  // The renderer is DOM-bound and cannot be required here, so pin that the
  // shipped line really routes through the function called above (the pattern at
  // test/intent-checklist-seam.test.js and test/preserve-across-restart.test.js).
  // The earlier version of this pin copied the merge expression inline, and a
  // copy is exactly how the first version of this coverage rotted: the
  // plugin-host revoke test kept passing against its own fixture while the
  // shipped revoke was inert.
  const MERGE_LINE = /sidebarMeta\.set\(name, mergeMeta\(sidebarMeta\.get\(name\), m\)\)/;
  const rsrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(rsrc, MERGE_LINE,
    'the shipped merge is the mergeMeta this test exercises — a hand-rolled per-key '
    + 'merge here, or one that skipped absent keys, would restore the stale-array bug '
    + 'with this test still green');
});

// t196: the keys the handler bolts on AFTER metaFor returns were in no tier,
// so they fell through to plain-spread and pluginGrants had to be empty-filled.
// The claim is what retires that. It has to be added without touching metaFor's
// marker, which is one frozen instance shared by every row in the response.
test('t196: the handler claims `record` on top of metaFor\'s tiers, without touching the shared marker', async () => {
  const call = metaFixture([
    { name: 'a', cwd: '/p', createdAt: 1, pluginGrants: ['scoped:turns'] },
    { name: 'b', cwd: '/q', createdAt: 2 },
  ]);
  const res = await call({});
  assert.strictEqual(res.ok, true,
    'ENTER: the handler returned rather than falling into its catch — a throw from '
    + 'pushing onto the frozen array would otherwise surface as ok:false with the '
    + 'assertions below never reached');

  assert.deepStrictEqual(res.meta.a._tiers, ['activity', 'pr', 'record'],
    'the row claims record IN ADDITION to what metaFor asked');
  assert.deepStrictEqual(res.meta.b._tiers, ['activity', 'pr', 'record']);

  // The three ways this can go wrong, and only the first is loud in production.
  assert.deepStrictEqual(call.sharedTiers, ['activity', 'pr'],
    'metaFor\'s instance is unchanged — a push would re-tier every row in the batch');
  assert.notStrictEqual(res.meta.a._tiers, call.sharedTiers, 'the row got a NEW array');
  assert.notStrictEqual(res.meta.a._tiers, res.meta.b._tiers,
    'and not one new array shared between rows, which would re-tier the batch the '
    + 'moment anything downstream extended one row');

  // CONTROL for the omission in MF2: a seat that still holds grants sends them,
  // so absence there is the revoke landing rather than the key never being sent.
  assert.deepStrictEqual(res.meta.a.pluginGrants, ['scoped:turns']);
  assert.ok(!('pluginGrants' in res.meta.b), 'and an ungranted seat omits it');
});

test('t196: a row metaFor returned nothing for still claims `record`', async () => {
  // The `meta[s.name] = {}` backfill. It has no activity or pr answer, but it is
  // fully authoritative about the keys it goes on to write — so it must
  // claim record and claim ONLY record. Claiming nothing would leave those keys
  // plain-spread on exactly the rows that have no other content to correct them.
  const res = await metaFixture([{ name: 'seat', cwd: '/p', createdAt: 9 }], { skipMeta: true })({});
  assert.deepStrictEqual(res.meta.seat, {
    _tiers: ['record'], createdAt: 9, archivedAt: null, team: null,
  });

  const cached = mergeMeta({ pluginGrants: ['scoped:turns'], lastActivityTs: 100 }, res.meta.seat);
  assert.deepStrictEqual(cached, {
    lastActivityTs: 100, createdAt: 9, archivedAt: null, team: null,
  }, 'the revoke lands off a record-only row, and the activity it never asked survives');
});

// ── MF3: a revoke must not leave the verb live ──────────────────────────────
// The two lists are written by two different handlers, and the popover writes
// intents FIRST (verb still checked, since the block was drawn) then revokes.
// So the default outcome of an in-dialog revoke was: row gone from the
// checklist, line gone from the prompt, verb still FIREABLE — because
// intentEnabledFor consults only `intents` and is scope-blind by design.
test('REWORK MF3: revoking a grant drops the plugin\'s verbs from the allowlist', () => withReset(() => {
  registry.registerIntent(mkRow('scopedverb'), 'scoped', { scope: 'session' });
  registry.registerIntent(mkRow('globalverb'), 'globby', { scope: 'global' });

  const f = ipcFixture({
    entries: {
      seat: {
        name: 'seat',
        pluginGrants: ['scoped:turns'],
        intents: ['dm', 'scopedverb', 'globalverb'],
      },
    },
  });

  // CONTROL: a grant that still reaches leaves the verb alone. Without this, an
  // implementation that dropped every plugin verb on every write would pass the
  // assertion below and quietly break the granted case.
  f.setGrants('seat', ['scoped:thinking']);
  assert.ok(f.store.seat.intents.includes('scopedverb'),
    'CONTROL: swapping WHICH capability is granted keeps the verb — the plugin still reaches');

  f.setGrants('seat', []);
  assert.strictEqual(f.store.seat.intents.includes('scopedverb'), false,
    'a revoked scoped plugin\'s verb is dropped from the allowlist, not left hidden-but-fireable');
  assert.ok(f.store.seat.intents.includes('globalverb'),
    'ENTER: a GLOBAL plugin\'s verb is untouched — it has no per-session grant to lose');
  assert.ok(f.store.seat.intents.includes('dm'), 'ENTER: and core verbs are untouched');

  // The enforcement gate stays scope-blind — that separation is deliberate. What
  // changed is that the two stored decisions can no longer disagree.
  assert.strictEqual(registry.intentEnabledFor('scopedverb', f.store.seat.intents), false,
    'and the gate now refuses it off the allowlist alone');
}));

test('REWORK MF3: a null allowlist needs no reconcile and is left null', () => withReset(() => {
  registry.registerIntent(mkRow('scopedverb'), 'scoped', { scope: 'session' });
  const f = ipcFixture({ entries: { seat: { name: 'seat', pluginGrants: ['scoped:turns'], intents: null } } });
  f.setGrants('seat', []);
  // null is the living all-enabled default for CORE verbs, and a plugin row is
  // enabled only by explicit inclusion in an array — so there is nothing to drop
  // and collapsing null to a list here would silently gate every core verb.
  assert.strictEqual(f.store.seat.intents, null, 'the all-enabled default is not collapsed into a list');
  assert.strictEqual(registry.intentEnabledFor('scopedverb', null), false,
    'ENTER: and the plugin verb was never enabled by that default anyway');
}));

// ── MF4: an unrelated Apply must not revoke what it could not show ──────────
// session:pluginGrants offers only enabled, unquarantined plugins, but the save
// replaces the whole list. Quarantine is AUTOMATIC on repeated failure, so the
// revoke fired with no operator action at all: a granted plugin quarantines
// itself, the operator opens Intents for an unrelated edit, hits Apply.
test('REWORK MF4: grants for plugins the dialog could not list survive a save', () => {
  const { grantsForUnlistedPlugins } = require('../plugin-api');
  const granted = ['visible:turns', 'quarantined:turns', 'quarantined:thinking', 'disabled:toolInputs'];

  // CONTROL: a plugin the dialog DID draw a row for is not carried forward —
  // its rows are the operator's answer, and preserving them would make the
  // checkboxes inert. If this returned everything the test below would pass for
  // the wrong reason.
  assert.deepStrictEqual(grantsForUnlistedPlugins(granted, ['visible', 'quarantined', 'disabled']), [],
    'CONTROL: nothing is carried when every plugin was listed');

  const carried = grantsForUnlistedPlugins(granted, ['visible']);
  assert.ok(carried.length > 0, 'ENTER: something was actually carried');
  assert.deepStrictEqual(carried.sort(),
    ['disabled:toolInputs', 'quarantined:thinking', 'quarantined:turns'],
    'every grant for an unlisted plugin is carried, per capability');
  assert.strictEqual(carried.includes('visible:turns'), false,
    'and the listed plugin\'s grant is left to the checkboxes');

  // The union the popover SAVES, through the same function it calls. Asserting a
  // hand-written union here would leave the shipped half unpinned: deleting the
  // carry-forward from collectPluginGrants would restore the bug with this test
  // still green, which is the failure mode this whole section exists to close.
  const { mergeGrants } = require('../plugin-api');
  const saved = mergeGrants([], carried); // visible box UNCHECKED
  assert.strictEqual(saved.includes('visible:turns'), false,
    'unchecking a visible box still revokes it');
  assert.ok(saved.includes('quarantined:turns'), 'while the unlistable grant rides through');

  // CONTROL for the union itself: a checked box survives it, so a mergeGrants
  // that dropped its first argument would fail here rather than passing the
  // carry-forward assertions above.
  const kept = mergeGrants(['visible:turns'], carried);
  assert.ok(kept.includes('visible:turns'), 'CONTROL: a checked box is saved');
  assert.ok(kept.includes('quarantined:turns'), 'alongside the carried tokens');
  assert.strictEqual(new Set(kept).size, kept.length, 'and the union does not duplicate');
  assert.deepStrictEqual(mergeGrants(['a:turns'], ['a:turns']), ['a:turns'],
    'an overlapping token appears once, not twice');

  assert.deepStrictEqual(grantsForUnlistedPlugins(null, ['a']), [], 'a missing grant list carries nothing');
  assert.deepStrictEqual(grantsForUnlistedPlugins(['nocolon', 42, ':turns'], []), [],
    'and malformed tokens are not resurrected by the carry-forward');

  // Both halves of the fix live in the leaf, and both are pinned above — but the
  // CALL is what ships, and it lives in a DOM-bound file with no unit tests.
  // Measured, not assumed: with the union arithmetic in plugin-api.js and every
  // assertion above in place, replacing collectPluginGrants' body with the bare
  // checked list still leaves this file 25/25 green while the shipped bug is
  // back. The move made the arithmetic shareable; only this scan pins the call.
  const popsrc = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'popovers', 'checklist-popovers.js'), 'utf8');
  assert.match(popsrc, /return mergeGrants\(checked, unlistedGrants\);/,
    'collectPluginGrants must SAVE the union — a fix that computes the carry-forward '
    + 'and then drops it on the way out is no fix at all');
  assert.match(popsrc, /unlistedGrants = grantsForUnlistedPlugins\(/,
    'and the carry-forward must be recomputed at render, not left from a prior session');
});

// ── NIT: registering after deactivate must refuse, not silently globalize ────
test('REWORK NIT: intents.register after deactivate throws rather than defaulting to global', () => withReset(() => {
  const { engine, cleanup } = mkEngine();
  try {
    let host = null;
    engine.register('late', { activate(h) { host = h; } },
      { hostApi: HOST_API_VERSION, scope: 'session' });
    assert.ok(host, 'ENTER: the plugin registered and captured its host');

    // CONTROL: while registered, the scope really does come off the manifest.
    host.intents.register(mkRow('livereg'));
    assert.strictEqual(registry.pluginRowFor('livereg').scope, 'session',
      'CONTROL: a live registration is session-scoped');

    engine.deactivate('late');
    // A late timer firing here would find no record. scopeOf(undefined) resolves
    // to GLOBAL and the ledger disposer no longer fires, so the row would leak
    // permanently at the WIDER scope — the exact silent globalization the
    // loader's manifest refusal exists to prevent.
    assert.throws(() => host.intents.register(mkRow('latereg')), /not registered/,
      'a registration after deactivate is refused');
    assert.strictEqual(registry.pluginRowFor('latereg'), null,
      'and no globally-scoped row is left behind');
  } finally { cleanup(); }
}));

// ── NIT: a failed catalog read must fail CLOSED, not activate unscoped ───────
// `scopedPluginIds` is what tells the renderer a plugin is scoped at all, so a
// plugin activated while that set is stale draws on EVERY session regardless of
// grants — the opposite of what enabling a scoped plugin is supposed to do — and
// it stays that way until some later refresh happens to succeed.
test('REWORK NIT: a rejected plugin catalog skips activation rather than drawing unscoped', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  // Source-scanned because this lives in renderer.js's top-level IIFE-free body,
  // which requires a DOM and window.api to load at all. The property is a
  // two-part contract between a producer and its callers, so both halves are
  // pinned: a catch returning [] would satisfy neither.
  assert.match(src, /try \{ catalog = await window\.api\.pluginCatalog\(\); \} catch \{ return null; \}/,
    'a failed catalog read must report null — [] is indistinguishable from "no plugins installed", '
    + 'which is exactly the answer that makes a caller activate against a stale scope set');
  assert.match(src, /refreshScopedPluginIds\(\)\.then\(\(c\) => \{ if \(c\) activatePluginRenderer\(payload\.id\); \}\)/,
    'and the mid-run enable path must skip activation on it');
  // The boot path needs no guard of its own — it iterates the return value, so a
  // null activates nothing by construction. Pinned so a later `?? []` there
  // silently re-opens the hole.
  assert.match(src, /const catalog = await refreshScopedPluginIds\(\);\n  for \(const p of catalog \|\| \[\]\)/,
    'the boot path iterates the catalog directly, so null activates nothing');
});
