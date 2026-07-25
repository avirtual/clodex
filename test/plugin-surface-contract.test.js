'use strict';
// plugin-surface-contract.test.js — the PUBLISHED plugin surface, pinned
// (docs/plugin-api.md; T6 / plan §6 Phase 3).
//
// Same job api-contract.test.js does for window.api, and for the same reason:
// `docs/plugin-api.md` is a one-way door. It tells an out-of-tree author, who
// cannot read this repo, exactly what `host` and `rhost` carry — so a member
// that quietly appears, disappears, or changes kind makes the published document
// wrong for every reader at once, and the only signal today would be someone's
// plugin breaking in the field.
//
// WHAT THIS FILE IS, AND IS NOT. It is a SHAPE pin: names, kinds, nesting,
// frozenness. Behavior belongs to plugin-host-engine.test.js and
// plugin-host.test.js, which are richer than a table could ever be and are not
// duplicated here. The tables below are the contract's index, not its meaning.
//
// The tables are LITERAL and kept beside — never derived from — the objects they
// describe. A generated table cannot fail; it would re-derive whatever the code
// happens to be and call it the contract. Adding a member here is meant to cost
// a deliberate edit, in company with a docs edit.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPluginHostEngine } = require('../plugin-host-engine');
const { HOST_API_VERSION } = require('../plugin-api');

const DOCS = path.join(__dirname, '..', 'docs', 'plugin-api.md');

// ── The engine `host` contract ──────────────────────────────────────────────
// One row per member a plugin's activate(host) may touch. `kind` is what the
// member IS, not what it returns: 'value' | 'fn' | 'ns' (a frozen namespace).
// A namespace row's `members` is the complete list of ITS keys.
const HOST_CONTRACT = [
  { name: 'id', kind: 'value' },
  { name: 'hostApiVersion', kind: 'value' },
  { name: 'log', kind: 'ns', members: ['info', 'error'] },
  { name: 'paths', kind: 'ns', members: ['dataDir'] },
  { name: 'storage', kind: 'ns', members: ['get', 'set'] },
  { name: 'settings', kind: 'ns', members: ['get', 'set'] },
  // NOTE the absence of an unqualified `list` — the two named accessors are the
  // whole point (docs §4; plugin-host-engine.js law 1). Pinned negatively below.
  { name: 'sessions', kind: 'ns', members: ['listAll', 'listWorkspace', 'get', 'fsScope', 'onCreate', 'onExit'] },
  { name: 'ipc', kind: 'ns', members: ['handle'] },
  { name: 'intents', kind: 'ns', members: ['register'] },
  { name: 'events', kind: 'ns', members: ['emit'] },
  { name: 'lib', kind: 'ns', members: ['gitWorktree'] },
  { name: 'telemetry', kind: 'ns', members: ['snapshot'] },
];

// The SessionHandle — five fields and two methods, deliberately tiny. Widening
// it is the easiest way to leak a raw session object into plugin land.
const SESSION_HANDLE_CONTRACT = {
  values: ['name', 'type', 'cwd', 'workspaceId'],
  fns: ['isAlive', 'inject'],
};

// ── The renderer `rhost` contract ───────────────────────────────────────────
const RHOST_CONTRACT = [
  { name: 'id', kind: 'value' },
  // A GETTER, not a captured value (docs §5): this window's workspace id is
  // filled asynchronously at startup, so a snapshot would be null forever.
  { name: 'workspaceId', kind: 'getter' },
  { name: 'invoke', kind: 'fn' },
  { name: 'sessions', kind: 'ns', members: ['active', 'listWorkspace'] },
  {
    name: 'ui',
    kind: 'ns',
    members: ['openPath', 'showToast', 'statusBar', 'sidebar', 'sessionMenu', 'settings', 'surfaces'],
  },
  { name: 'lib', kind: 'ns', members: ['renderDiffHtml'] },
  { name: 'onDispose', kind: 'fn' },
  { name: 'setInterval', kind: 'fn' },
  { name: 'clearInterval', kind: 'fn' },
  { name: 'setTimeout', kind: 'fn' },
  { name: 'clearTimeout', kind: 'fn' },
  { name: 'addEventListener', kind: 'fn' },
  { name: 'removeEventListener', kind: 'fn' },
  { name: 'log', kind: 'ns', members: ['info', 'error'] },
];

// The seven UI slots, as `rhost.ui.<area>.<method>` paths. This is the list
// docs/plugin-api.md §6 enumerates one section each; "seven" is a number the
// document states in prose, so it is pinned as a number too.
const UI_SLOTS = [
  ['statusBar', 'addAction'],
  ['statusBar', 'addSegment'],
  ['sidebar', 'footerButton'],
  ['sidebar', 'rowBadge'],
  ['sessionMenu', 'addProvider'],
  ['settings', 'section'],
  ['surfaces', 'overlay'],
];

// `sidebar.requestRelayout` is NOT a slot — it is the companion to rowBadge's
// sync `resolve` (docs §6.4), so it is pinned separately rather than inflating
// the count.
const UI_EXTRA = [['sidebar', 'requestRelayout']];

// ── The `_host` pseudo-plugin's methods ─────────────────────────────────────
// Host plumbing, reachable by CORE only: every one takes a plugin id as an
// ARGUMENT, which is exactly why a plugin cannot reach them (docs §13 — an
// openable _host would let plugin A write plugin B's settings).
const HOST_METHODS = [
  'settings.get', 'settings.set', 'renderer.info', 'plugins.status', 'renderer.report',
];

// ── Fixtures ────────────────────────────────────────────────────────────────
// The REAL engine host over a fake manager — the same fixture shape
// plugin-host-engine.test.js uses. Nothing here mocks the host itself; a mocked
// host would pin the mock.
function realEngineHost() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-surface-'));
  let ui = {};
  const engine = createPluginHostEngine({
    manager: {
      sessions: new Map([['seat', { name: 'seat', type: 'claude', cwd: '/repo', workspaceId: 'ws-1' }]]),
      list: () => [], listForWorkspace: () => [],
      _broadcast: () => {}, _sendToSession: () => {}, windowForWorkspace: () => null,
      _injectText: () => {},
    },
    getUiSettings: () => ({ get: () => ui, set: (patch) => { ui = { ...ui, ...patch }; } }),
    log: { info: () => {} },
    userDataPath: dir,
    fs, path,
    gitWorktree: {},
    telemetrySnapshot: () => null,
    getLoader: () => null,
  });
  const host = engine.register('demo', { activate() {} }, { hostApi: HOST_API_VERSION });
  return { engine, host, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// The REAL renderer host over the smallest DOM it touches at activation: the
// island installs a document-level keydown listener at init and paints footer
// buttons on registration, so `document` must exist before it is required.
function realRendererHost() {
  const nodes = [];
  const mkNode = (tag) => {
    const n = {
      tagName: String(tag).toUpperCase(), className: '', textContent: '', children: [],
      attrs: new Map(), style: {},
      setAttribute(k, v) { this.attrs.set(k, String(v)); },
      getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; },
      removeAttribute(k) { this.attrs.delete(k); },
      appendChild(c) { this.children.push(c); return c; },
      remove() {},
      addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    };
    nodes.push(n);
    return n;
  };
  global.document = {
    body: mkNode('body'), head: mkNode('head'),
    createElement: mkNode,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  global.CSS = { escape: (s) => String(s) };
  delete require.cache[require.resolve('../renderer/plugin-host')];
  delete require.cache[require.resolve('../renderer/lib/format')];
  const { initPluginHost } = require('../renderer/plugin-host');
  const island = initPluginHost({
    getActiveSession: () => 'seat',
    sessionTypeOf: () => 'claude',
    activeIsAgent: () => true,
    activePeerQueryable: () => false,
    activePeerConfigurable: () => false,
    scheduleSidebarRelayout: () => {},
    listSessions: async () => [],
    openPath: () => {},
    showToast: () => {},
    getWorkspaceId: () => 'ws-1',
  });
  // The rhost is only reachable THROUGH activation — which is correct: it is
  // built per plugin, and a test that reached for it another way would be
  // pinning a shape no plugin can actually receive.
  let rhost = null;
  island.activate('demo', { activate(r) { rhost = r; } }, { invoke: async () => ({ ok: true }) });
  return { island, rhost };
}

// Shared table walker.
function assertContract(obj, contract, label) {
  assert.deepStrictEqual(
    Object.keys(obj).sort(),
    contract.map((r) => r.name).sort(),
    `${label}: the member set must match the contract table EXACTLY — a new key is a published API change`,
  );
  for (const row of contract) {
    const v = obj[row.name];
    if (row.kind === 'fn') {
      assert.strictEqual(typeof v, 'function', `${label}.${row.name} must be a function`);
    } else if (row.kind === 'ns') {
      assert.strictEqual(typeof v, 'object', `${label}.${row.name} must be a namespace object`);
      assert.ok(v, `${label}.${row.name} must not be null`);
      assert.deepStrictEqual(Object.keys(v).sort(), [...row.members].sort(),
        `${label}.${row.name}: namespace members must match the contract table`);
    } else if (row.kind === 'getter') {
      const d = Object.getOwnPropertyDescriptor(obj, row.name);
      assert.strictEqual(typeof d.get, 'function',
        `${label}.${row.name} must be a GETTER — a captured value would be stale forever`);
    } else {
      assert.notStrictEqual(typeof v, 'function', `${label}.${row.name} must be a value, not a function`);
    }
  }
}

// ── The engine host ─────────────────────────────────────────────────────────

test('the engine host carries EXACTLY the published contract', () => {
  const { host, cleanup } = realEngineHost();
  try {
    assertContract(host, HOST_CONTRACT, 'host');
    assert.ok(Object.isFrozen(host), 'the host object is frozen — a plugin cannot patch its own surface');
    // The namespaces that are frozen in their own right. `log`, `storage` and
    // `settings` are NOT, and that is fine: the top-level freeze already stops a
    // plugin swapping them out, and nothing else holds a reference to patch.
    // Listed positively rather than as an exclusion so a new namespace has to
    // declare which it is.
    for (const ns of ['paths', 'sessions', 'ipc', 'intents', 'events', 'lib', 'telemetry']) {
      assert.ok(Object.isFrozen(host[ns]), `host.${ns} must be frozen too`);
    }
    assert.strictEqual(host.id, 'demo');
    assert.strictEqual(host.hostApiVersion, HOST_API_VERSION);
  } finally { cleanup(); }
});

test('the engine host offers no unqualified session list, and no reach-in', () => {
  const { host, cleanup } = realEngineHost();
  try {
    // The named-accessor law, pinned as an ABSENCE. `listAll` vs
    // `listWorkspace` only protects anything while the tempting default does
    // not exist beside them.
    assert.strictEqual(host.sessions.list, undefined,
      'an unqualified list() would make the cross-workspace read the easy one');
    // Every one of these is a named future decision (docs §13), not a default.
    for (const forbidden of ['manager', 'stores', 'persistence', 'pty', 'fs', 'spawn',
      'getRemoteServer', 'getPeerManager', 'ipcMain', 'app', 'window']) {
      assert.strictEqual(host[forbidden], undefined, `host must not expose ${forbidden}`);
    }
  } finally { cleanup(); }
});

test('the SessionHandle stays five fields and two methods', () => {
  const { host, cleanup } = realEngineHost();
  try {
    const h = host.sessions.get('seat');
    assert.ok(h, 'the fixture session resolves');
    assert.deepStrictEqual(Object.keys(h).sort(),
      [...SESSION_HANDLE_CONTRACT.values, ...SESSION_HANDLE_CONTRACT.fns].sort(),
      'widening the handle is how a raw session object leaks into plugin land');
    for (const f of SESSION_HANDLE_CONTRACT.fns) assert.strictEqual(typeof h[f], 'function');
    assert.ok(Object.isFrozen(h), 'the handle is frozen');
    assert.strictEqual(host.sessions.get('nope'), null, 'an unknown name is null, not a throw');
  } finally { cleanup(); }
});

// ── The renderer host ───────────────────────────────────────────────────────

test('the renderer rhost carries EXACTLY the published contract', () => {
  const { rhost } = realRendererHost();
  assert.ok(rhost, 'activation hands the plugin its rhost');
  assertContract(rhost, RHOST_CONTRACT, 'rhost');
  assert.ok(Object.isFrozen(rhost), 'the rhost object is frozen');
  assert.strictEqual(rhost.id, 'demo');
  assert.strictEqual(rhost.workspaceId, 'ws-1', 'the getter reads through to the live value');
});

test('rhost exposes the seven UI slots and nothing that reaches window.api', () => {
  const { rhost } = realRendererHost();
  for (const [area, method] of [...UI_SLOTS, ...UI_EXTRA]) {
    assert.strictEqual(typeof rhost.ui[area][method], 'function',
      `rhost.ui.${area}.${method} is published`);
  }
  assert.strictEqual(UI_SLOTS.length, 7, 'docs/plugin-api.md §6 says SEVEN slots in prose');
  // The no-backdoor rule as a SHAPE, complementing the static lint in
  // plugin-boundary.test.js: even a plugin that ignored the lint has nothing on
  // its own surface to reach core with.
  for (const forbidden of ['api', 'window', 'require', 'ipcRenderer', 'electron']) {
    assert.strictEqual(rhost[forbidden], undefined, `rhost must not expose ${forbidden}`);
  }
  assert.strictEqual(rhost.sessions.listAll, undefined,
    'the renderer side has no global session read at all (docs §5)');
  assert.strictEqual(rhost.events, undefined,
    'no renderer-side event subscription in "1" — a documented gap (docs §9), pinned so it '
    + 'cannot appear undocumented');
});

// ── The `_host` pseudo-plugin ───────────────────────────────────────────────

test('the _host pseudo-plugin serves exactly five methods, and no plugin can reach it', async () => {
  const { engine, cleanup } = realEngineHost();
  try {
    for (const m of HOST_METHODS) {
      const r = await engine.dispatch('_host', m, ['demo']);
      assert.notDeepStrictEqual(r, { ok: false, error: 'no such plugin method' },
        `_host ${m} must be served`);
    }
    assert.deepStrictEqual(await engine.dispatch('_host', 'settings.wipe', ['demo']),
      { ok: false, error: 'no such plugin method' }, 'and nothing beyond the five');
    // The id itself is unreachable by a plugin: PLUGIN_ID_RE forbids a leading
    // underscore, so `_host` can never BE a plugin, and rhost.invoke binds the
    // caller's own id — there is no argument through which to name it.
    assert.throws(() => engine.register('_host', { activate() {} }), /invalid plugin id/);
  } finally { cleanup(); }
});

// ── The document ────────────────────────────────────────────────────────────

test('docs/plugin-api.md exists, is frozen at this version, and names every published member', () => {
  // The contract is only real if it is PUBLISHED. This is the cheap half of that:
  // every member in the tables above must at least appear in the document, so a
  // member cannot be added to the surface and silently left undocumented.
  const doc = fs.readFileSync(DOCS, 'utf8');
  assert.match(doc, new RegExp(`hostApi\\s*"?${HOST_API_VERSION}"?`),
    'the document states the version it describes');
  assert.match(doc, /\*\*Status: frozen\.\*\*/, 'and states that it is frozen');

  // TOP-LEVEL members are checked QUALIFIED (`host.storage`, `rhost.invoke`) —
  // a bare `id` or `log` matches somewhere in forty thousand characters of prose
  // no matter what, which would pass for a member nobody wrote up. Nested
  // members are checked as whole words, which is weaker (`get` and `set` will
  // always be there) but still catches the case this test is really for: a NEW
  // member appearing on the surface with no mention anywhere in the document.
  // The strong guarantee is the section checklist in the next test, not this.
  const missing = [];
  const wantExact = (s) => { if (!doc.includes(s)) missing.push(s); };
  const wantWord = (w, label) => {
    if (!new RegExp(`\\b${w}\\b`).test(doc)) missing.push(label);
  };
  for (const row of HOST_CONTRACT) {
    wantExact(`host.${row.name}`);
    if (row.kind === 'ns') for (const m of row.members) wantWord(m, `host.${row.name}.${m}`);
  }
  for (const row of RHOST_CONTRACT) {
    wantExact(`rhost.${row.name}`);
    if (row.kind === 'ns') for (const m of row.members) wantWord(m, `rhost.${row.name}.${m}`);
  }
  for (const [area, method] of [...UI_SLOTS, ...UI_EXTRA]) wantExact(`rhost.ui.${area}.${method}`);
  for (const f of SESSION_HANDLE_CONTRACT.fns) wantWord(f, `SessionHandle.${f}`);
  assert.deepStrictEqual(missing, [], 'every published member must appear in docs/plugin-api.md');
});

test('docs/plugin-api.md covers the sections the freeze promised', () => {
  // T6's minimum contents, as a checklist. Prose can rot; a missing SECTION is
  // the failure mode that leaves an out-of-tree author guessing, and it is
  // mechanically checkable.
  const doc = fs.readFileSync(DOCS, 'utf8');
  for (const heading of [
    '## 2. The manifest',
    '## 4. The engine `host` object',
    '## 5. The renderer `rhost` object',
    '## 6. The seven UI slots',
    '## 10. Lifecycle: enable, disable, failure, quarantine',
    '## 11. The transport, and why it is five rows',
    '## 13. What is deliberately not exposed',
    '## 14. Known gaps and unspecified behaviour',
    '## 15. Versioning',
  ]) {
    assert.ok(doc.includes(heading), `docs/plugin-api.md must keep the section "${heading}"`);
  }
  // The two shape findings T6 resolved as DOCUMENT-ONLY. Both are load-bearing
  // for the freeze: ordering documented as unspecified is what makes a v1.1
  // priority field additive rather than breaking, and the menu-slot gap is what
  // stops an author waiting for a slot that does not exist.
  assert.match(doc, /[Uu]nspecified\. Do not depend on it/,
    'slot ordering must be documented as unspecified');
  assert.match(doc, /No menu slot/, 'the missing menu slot must be documented as a known gap');
  // The five-row freeze's scope (T6 adjudication): it caps the PLUGIN transport,
  // never core's own row count. Written down so it is not re-litigated.
  // `\s+` rather than a literal space: the sentence wraps in the source, and a
  // reflowed paragraph must not fail a test about what the document SAYS.
  assert.match(doc.replace(/\s+/g, ' '), /does \*\*not\*\* cap Clodex's own total row count/,
    'the document must say the five-row freeze does not cap core\'s own rows');
});
