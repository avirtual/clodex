'use strict';
// plugin-scope.test.js — the SURFACING gate (t190).
//
// `intentEnabledFor` already refuses a plugin verb for a session that was not
// granted it, and has since the registry existed. What it does NOT do is stop
// the verb APPEARING: the row is in every session's checklist, its grammar line
// is in every session's prompt, and its name is in every near-miss bounce. For a
// plugin that exists for one team's seats, "present and refused" is the wrong
// answer — the right one is absent.
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
  PLUGIN_CAPABILITIES, grantToken, isValidCapability, pluginGranted, pluginReaches,
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
    assert.strictEqual(pluginReaches('p', absent), false);
  }
  assert.strictEqual(pluginReaches('p', ['q:turns', 'q:thinking']), false,
    'another plugin\'s grants do not reach this one');
  assert.strictEqual(pluginReaches('p', ['p:thinking']), true,
    'CONTROL: one real grant does reach — so the refusals above are about the input, not a broken predicate');
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

test('a GLOBAL plugin row surfaces for every session, grants or not (today\'s behaviour)', () => withReset(() => {
  registry.registerIntent(mkRow('glob'), 'globby', { scope: 'global' });
  for (const grants of [undefined, null, [], ['other:turns'], ['globby:turns']]) {
    const rows = registry.catalogRows(grants);
    assert.ok(rows.some((r) => r.type === 'glob'),
      `a global row is in the checklist for grants ${JSON.stringify(grants)}`);
    assert.ok(registry.validIntentNames(grants).includes('glob'));
    // The grammar line still obeys the INTENT grant, which is unchanged.
    assert.deepStrictEqual(registry.pluginGrammarLines(['glob'], grants), ['  [agent:glob]   line for glob.']);
  }
  // An omitted scope is the same thing — this is what every shipped plugin hits.
  registry.registerIntent(mkRow('unsaid'), 'unsaid-src');
  assert.ok(registry.catalogRows(null).some((r) => r.type === 'unsaid'),
    'a row registered with NO scope option behaves exactly like an explicit global');
}));

test('a SESSION-scoped row is ABSENT from a non-granted session, and PRESENT for a granted one', () => withReset(() => {
  registry.registerIntent(mkRow('scoped'), 'scopey', { scope: 'session' });

  // CONTROL FIRST, deliberately. The absence assertions below are all true of a
  // registry that never took the row; this proves the row is really there and
  // really reachable, so the absences that follow are about the GATE.
  const granted = ['scopey:turns'];
  const shown = registry.catalogRows(granted);
  assert.ok(shown.some((r) => r.type === 'scoped'),
    'CONTROL: with a grant the row IS in the checklist — the fixture reached the state it names');
  assert.ok(registry.validIntentNames(granted).includes('scoped'),
    'CONTROL: and in the near-miss vocabulary');
  assert.deepStrictEqual(registry.pluginGrammarLines(['scoped'], granted),
    ['  [agent:scoped]   line for scoped.'], 'CONTROL: and contributes its grammar line');

  // The property: absent, not present-and-denied.
  for (const grants of [undefined, null, [], ['someone-else:turns'], ['scopey:nonsense']]) {
    const rows = registry.catalogRows(grants);
    assert.ok(rows.length > 0, `ENTER: the catalog is non-empty for ${JSON.stringify(grants)} — core rows always survive`);
    assert.strictEqual(rows.some((r) => r.type === 'scoped'), false,
      `no checklist row for grants ${JSON.stringify(grants)}`);
    assert.strictEqual(registry.validIntentNames(grants).includes('scoped'), false,
      'and the bounce must not advertise a verb the seat cannot see');
    assert.deepStrictEqual(registry.pluginGrammarLines(['scoped'], grants), [],
      'and no grammar line, EVEN THOUGH the intent list names the verb — the scope filter is the outer one');
  }
}));

test('scope hides; it does NOT enforce — intentEnabledFor is untouched', () => withReset(() => {
  registry.registerIntent(mkRow('scoped2'), 'scopey2', { scope: 'session' });
  // Enforcement was never the gap (SPEC: "So enforcement is not the gap.
  // Surfacing is."). A scoped verb is refused for an ungranted seat exactly as
  // before — by the INTENT list, with no reference to plugin grants — so hiding
  // is never the only thing between a seat and a verb.
  assert.strictEqual(registry.intentEnabledFor('scoped2', null), false);
  assert.strictEqual(registry.intentEnabledFor('scoped2', ['dm']), false);
  assert.strictEqual(registry.intentEnabledFor('scoped2', ['scoped2']), true,
    'the intent gate answers the same way it always has, with no knowledge of scope');
  // And a scoped plugin's PARSING is unchanged: the row still parses on every
  // feed. Scope is a visibility property, not an isolation one.
  assert.deepStrictEqual(registry.parseWithRegistry('[agent:scoped2]'), { probe: 'scoped2', type: 'scoped2' });
}));

test('the row\'s scope comes from the HOST, never from the plugin\'s own spec', () => withReset(() => {
  // A plugin that could name its own scope could declare itself global and undo
  // the operator's decision. `registerIntent` reads opts, never spec.
  registry.registerIntent({ ...mkRow('liar'), scope: 'global' }, 'liar-src', { scope: 'session' });
  const row = registry.pluginRowFor('liar');
  assert.strictEqual(row.scope, 'session', 'the manifest wins over the spec field');
  assert.strictEqual(registry.catalogRows(null).some((r) => r.type === 'liar'), false,
    'so the self-declared "global" buys the plugin nothing');
  assert.ok(registry.catalogRows(['liar-src:turns']).some((r) => r.type === 'liar'),
    'CONTROL: the row exists and surfaces once actually granted');
}));

test('two scoped plugins are visible independently — a grant reaches only its own', () => withReset(() => {
  registry.registerIntent(mkRow('alpha'), 'a-src', { scope: 'session' });
  registry.registerIntent(mkRow('beta'), 'b-src', { scope: 'session' });
  const types = (g) => registry.catalogRows(g).filter((r) => r.source !== 'core').map((r) => r.type);
  assert.deepStrictEqual(types(['a-src:turns']), ['alpha'], 'a grant surfaces its own plugin and no other');
  assert.deepStrictEqual(types(['b-src:thinking']), ['beta']);
  assert.deepStrictEqual(types(['a-src:turns', 'b-src:toolInputs']).sort(), ['alpha', 'beta'],
    'CONTROL: both surface when both are granted, in registration order');
  assert.deepStrictEqual(types([]), []);
}));

// ── Byte-identity: the no-scoped-plugin world is unchanged ──────────────────

test('with no SESSION-scoped plugin registered, every surfacing fn ignores grants entirely', () => withReset(() => {
  // clodex: "Absent scope must be byte-identically today's behaviour." The
  // strongest form of that: for a registry holding only core + global rows, the
  // new parameter cannot change any answer, for any value.
  registry.registerIntent(mkRow('g1'), 'g-src');
  const probes = [undefined, null, [], ['g-src:turns'], ['anything:thinking'], 'nonsense', 42];
  const base = {
    catalog: registry.catalogRows(),
    names: registry.validIntentNames(),
    grammarNone: registry.pluginGrammarLines(null),
    grammarG1: registry.pluginGrammarLines(['g1']),
  };
  // ENTER: the fixture actually registered — otherwise every deepStrictEqual
  // below compares two copies of the core-only answer and proves nothing.
  assert.ok(base.catalog.some((r) => r.type === 'g1'), 'ENTER: the global row is in the baseline');
  assert.deepStrictEqual(base.grammarG1, ['  [agent:g1]   line for g1.'], 'ENTER: and contributes a grammar line');
  for (const g of probes) {
    assert.deepStrictEqual(registry.catalogRows(g), base.catalog, `catalogRows is grants-invariant for ${JSON.stringify(g)}`);
    assert.deepStrictEqual(registry.validIntentNames(g), base.names, `validIntentNames is grants-invariant for ${JSON.stringify(g)}`);
    assert.deepStrictEqual(registry.pluginGrammarLines(null, g), base.grammarNone);
    assert.deepStrictEqual(registry.pluginGrammarLines(['g1'], g), base.grammarG1);
  }
}));

test('allowlistFromChecked is untouched by scope — an unsurfaced row cannot be checked', () => withReset(() => {
  registry.registerIntent(mkRow('hidden'), 'h-src', { scope: 'session' });
  // The checklist is the only producer of a checked set, and a hidden row draws
  // no checkbox. So this function needs no grants argument: by the time it runs,
  // the surfacing decision has already been made upstream. Pinned so nobody
  // "fixes" it by adding a second gate that could disagree with the first.
  const got = registry.allowlistFromChecked(['dm', 'hidden']);
  assert.ok(got.includes('hidden'),
    'a checked scoped verb still becomes a grant — refusing here would silently drop an operator decision');
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

    const ungated = registry.catalogRows(null).map((r) => r.type);
    assert.ok(ungated.includes('fromglobal'),
      'ENTER: the global verb registered and surfaces — so the absence below is the gate, not an empty registry');
    assert.strictEqual(ungated.includes('fromscoped'), false,
      'the scoped verb is absent for a session with no grants');
    assert.ok(registry.catalogRows(['scoped-plug:turns']).map((r) => r.type).includes('fromscoped'),
      'CONTROL: and present once granted');
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
    catalog: (name) => handlers.get('intents:catalog')(null, name),
    getGrants: (name) => handlers.get('session:pluginGrants')(null, name),
    setGrants: (name, g) => handlers.get('session:setPluginGrants')(null, name, g),
  };
}

test('intents:catalog resolves grants off the NAMED session', () => withReset(() => {
  registry.registerIntent(mkRow('ipcscoped'), 'ipc-plug', { scope: 'session' });
  const f = ipcFixture({
    entries: {
      granted: { name: 'granted', pluginGrants: ['ipc-plug:turns'] },
      bare: { name: 'bare' },
    },
  });
  const types = (name) => f.catalog(name).map((r) => r.type);
  // CONTROL first: the row is registered and reachable, so the absences below
  // are the gate rather than an empty registry.
  assert.ok(types('granted').includes('ipcscoped'),
    'CONTROL: a granted session sees the row over IPC');
  assert.ok(types('bare').length > 0, 'ENTER: an ungranted session still gets the core catalog');
  assert.strictEqual(types('bare').includes('ipcscoped'), false, 'an ungranted session does not');
  assert.strictEqual(types('nosuchsession').includes('ipcscoped'), false, 'nor does an unknown name');
  // No name = the New-session dialog, which is choosing for a seat that does not
  // exist yet. Absent is the right answer, not a shortcut for "show everything".
  assert.strictEqual(types(undefined).includes('ipcscoped'), false,
    'and an omitted name does not surface scoped rows');
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
  // ENTER: the filter kept something. `deepStrictEqual(x, [])` would be true of
  // a status read that returned nothing at all.
  assert.ok(res.plugins.length > 0, 'ENTER: the scoped plugins survived the filter');
  assert.deepStrictEqual(res.plugins.map((p) => p.id), ['scoped-a', 'scoped-b'],
    'a GLOBAL plugin is not offered — it has no per-session decision, and offering it '
    + 'would invite withholding something that is not withheld');
  assert.deepStrictEqual(res.granted, ['scoped-a:turns']);
  assert.deepStrictEqual(res.capabilities, [...PLUGIN_CAPABILITIES]);
  assert.deepStrictEqual(f.getGrants('nope'), { ok: false, error: 'Session not found in persistence' });

  // With no plugin host (kill switch, or construction failed) the UI must draw
  // nothing rather than throw — the same fail-safe posture as intents:catalog.
  const bare = ipcFixture({ entries: { seat: { name: 'seat' } } });
  assert.deepStrictEqual(bare.getGrants('seat').plugins, []);
  assert.deepStrictEqual(bare.getGrants('seat').granted, []);
});

// The seat's PROMPT. `_realIpcFor` is the one assembly both the spawn and
// refreshPrompt run through (that is what keeps their bytes equal), so it is
// where a grants-blind grammar line would show up in a seat's context.
test('a scoped plugin\'s grammar line reaches only a granted seat\'s prompt', () => withReset(() => {
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
  const recipeFor = (pluginGrants) => ({
    extraArgs: [], intents: ['promptverb'], execCommands: [], pluginGrants,
    appendPromptFiles: [], inlineBody: null, hasSystemFile: false, ipcDisabled: false,
  });
  const LINE = '[agent:promptverb]';

  // CONTROL: granted, the line IS baked in. Without this the absence below is
  // equally true of a prompt builder that dropped every plugin line.
  const granted = m._realIpcFor(recipeFor(['prompt-plug:thinking']), null).realIpc;
  assert.ok(granted.includes(LINE), 'CONTROL: a granted seat is told about the verb');

  for (const g of [null, [], ['other:turns']]) {
    const out = m._realIpcFor(recipeFor(g), null).realIpc;
    assert.ok(out.length > 100, `ENTER: a real prompt was built for grants ${JSON.stringify(g)}`);
    assert.strictEqual(out.includes(LINE), false,
      'an ungranted seat is never told the verb exists — EVEN THOUGH its intents list names it');
  }

  // And byte-identity: an ungranted seat's prompt equals the prompt it would get
  // if the scoped plugin were not installed at all. That is the property the
  // whole ticket is for, and it is stronger than "the line is absent".
  const ungranted = m._realIpcFor(recipeFor(null), null).realIpc;
  intentRegistry._resetPluginRows();
  const noPluginAtAll = m._realIpcFor(recipeFor(null), null).realIpc;
  assert.strictEqual(ungranted, noPluginAtAll,
    'a scoped plugin is byte-invisible to a seat that has not granted it');
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
// makes the four post-metaFor keys authoritative including by omission, so the
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
      // really is authoritative about the four keys it goes on to write.
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

// t196: the four keys the handler bolts on AFTER metaFor returns were in no tier,
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
  // fully authoritative about the four keys it goes on to write — so it must
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
