'use strict';
// plugin-host.test.js — the RENDERER half of the plugin host (plugin-plan §2.1-2.6,
// §3.1 Reviewer MUST-FIX A2). The island is browser code, so we stub the minimum
// DOM it touches and drive the registries by hand — the same approach
// api-shim.test.js takes for the browser transport.
//
// What this file is really pinning, beyond "the registries work":
//
//   1. NAMESPACING. Every id that reaches the DOM is "<pluginId>:<id>". This is
//      what makes a colon in a data-act mean "a plugin's" by construction, which
//      is in turn what lets core's dispatch chain add ONE branch instead of
//      consulting a registry on every click.
//   2. ESCAPING. Plugins hand over data, never markup. A label containing a tag
//      must arrive as text — if this test ever goes green with raw markup, the
//      Tier-B boundary (§2) has silently become un-crossable.
//   3. INERTNESS. With no plugin registered every seam returns the empty answer,
//      which is the whole Phase-1 exit criterion (byte-equivalent behavior).
//   4. TEARDOWN IS REAL (constraint 6). Window close is free teardown;
//      disable-without-close is not, and it is the path that leaves callbacks
//      firing against a removed container in every open window. So the last
//      block asserts _liveResources() is zero on every axis after dispose().

const test = require('node:test');
const assert = require('node:assert');

// ── Minimal DOM ─────────────────────────────────────────────────────────────
// Enough for the island: element creation, class/attr/dataset, append/remove,
// and a querySelector that understands the handful of selectors used. Crucially
// `innerHTML` on a node whose textContent was set returns ESCAPED text, because
// renderer/lib/format.js's esc() is implemented as exactly that round-trip.
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.className = '';
    this._text = '';
    this._html = null;
    this.children = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.type = '';
    const self = this;
    this.classList = {
      add(...c) { self._classes().add(...c); },
      remove(...c) { const s = self._classSet(); c.forEach((x) => s.delete(x)); self.className = [...s].join(' '); },
      contains(c) { return self._classSet().has(c); },
      toggle(c, on) { if (on) self.classList.add(c); else self.classList.remove(c); },
    };
  }
  _classSet() { return new Set(this.className.split(/\s+/).filter(Boolean)); }
  _classes() {
    const self = this;
    return { add(...c) { const s = self._classSet(); c.forEach((x) => s.add(x)); self.className = [...s].join(' '); } };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this._html = null; this.children = []; }
  // esc() does `d.textContent = str; return d.innerHTML` — so this getter IS the
  // escaping under test. Explicit innerHTML assignment wins when it happened.
  get innerHTML() { return this._html !== null ? this._html : escapeText(this._text); }
  set innerHTML(v) { this._html = String(v); this._text = ''; this.children = []; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); if (k.startsWith('data-')) this.dataset[dataKey(k)] = String(v); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, new Set()); this.listeners.get(t).add(fn); }
  removeEventListener(t, fn) { if (this.listeners.has(t)) this.listeners.get(t).delete(fn); }
  fire(t, ev = {}) { for (const fn of this.listeners.get(t) || []) fn(ev); }
  listenerCount(t) { return (this.listeners.get(t) || new Set()).size; }
  descendants() {
    const out = [];
    for (const c of this.children) { out.push(c); out.push(...c.descendants()); }
    return out;
  }
  matches(sel) { return matchSel(this, sel); }
  querySelector(sel) { return this.descendants().find((n) => matchSel(n, sel)) || null; }
  querySelectorAll(sel) { return this.descendants().filter((n) => matchSel(n, sel)); }
}

function dataKey(attr) {
  return attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// Selector support: '.cls', 'tag', '[attr="v"]', '[attr^="v"]', '[attr]', and
// concatenations of those (e.g. '.px-seg.px-plugin[data-act]').
function matchSel(node, sel) {
  const parts = String(sel).match(/\[[^\]]+\]|\.[^.[\s]+|^[a-zA-Z][\w-]*/g) || [];
  for (const p of parts) {
    if (p.startsWith('.')) { if (!node._classSet().has(p.slice(1))) return false; }
    else if (p.startsWith('[')) {
      const m = p.match(/^\[([^\]=^]+)(\^?=)?"?([^"\]]*)"?\]$/);
      if (!m) return false;
      const [, k, op, v] = m;
      const have = node.getAttribute(k);
      if (have === null) return false;
      if (op === '=' && have !== v) return false;
      if (op === '^=' && !have.startsWith(v)) return false;
    } else if (node.tagName !== p.toUpperCase()) return false;
  }
  return true;
}

function installDom() {
  const body = new FakeNode('body');
  const head = new FakeNode('head');
  const root = new FakeNode('html');
  root.appendChild(head);
  root.appendChild(body);
  const doc = {
    body, head,
    createElement: (t) => new FakeNode(t),
    getElementById: (id) => root.descendants().find((n) => n.getAttribute('id') === id) || null,
    querySelector: (s) => root.querySelector(s),
    querySelectorAll: (s) => root.querySelectorAll(s),
    listeners: new Map(),
    addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, new Set()); this.listeners.get(t).add(fn); },
    removeEventListener(t, fn) { if (this.listeners.has(t)) this.listeners.get(t).delete(fn); },
    fire(t, ev = {}) { for (const fn of this.listeners.get(t) || []) fn(ev); },
  };
  global.document = doc;
  global.CSS = { escape: (s) => String(s) };
  return { doc, body, head, root };
}

function el(tag, id, cls) {
  const n = new FakeNode(tag);
  if (id) n.setAttribute('id', id);
  if (cls) n.className = cls;
  return n;
}

// The island is required AFTER the DOM stub exists — lib/format.js reads
// `document` at call time, not load time, but the island installs a
// document-level keydown listener at init, so order matters for that.
function load() {
  delete require.cache[require.resolve('../renderer/plugin-host')];
  delete require.cache[require.resolve('../renderer/lib/format')];
  return require('../renderer/plugin-host').initPluginHost;
}

// A host wired to a controllable core. Returns the island plus the knobs.
function makeHost(overrides = {}) {
  const dom = installDom();
  const state = { active: 'seat-a', type: 'claude', isAgent: true, peerQ: false, peerC: false, relayouts: 0 };
  const initPluginHost = load();
  const host = initPluginHost({
    getActiveSession: () => state.active,
    sessionTypeOf: () => state.type,
    activeIsAgent: () => state.isAgent,
    activePeerQueryable: () => state.peerQ,
    activePeerConfigurable: () => state.peerC,
    scheduleSidebarRelayout: () => { state.relayouts++; },
    getWorkspaceId: () => 'ws-1',
    ...overrides,
  });
  return { host, state, dom };
}

// Activate a plugin module through the real lifecycle, so every test exercises
// the same path the Phase-2 loader will.
function activate(host, id, activateFn, opts = {}) {
  const calls = [];
  const mod = { activate: (rhost) => activateFn(rhost, calls) };
  if (opts.deactivate) mod.deactivate = opts.deactivate;
  const rhost = host.activate(id, mod, { invoke: opts.invoke, css: opts.css });
  return { rhost, calls };
}

// ── Inertness: the Phase-1 exit criterion ───────────────────────────────────

test('with no plugin registered every seam returns the empty answer', () => {
  const { host } = makeHost();
  assert.equal(host.statusBarHtml(), '', 'nothing appended to #proxy-actions');
  assert.equal(host.hasVisibleContribution(), false, 'the bar hide branch is unaffected');
  assert.deepEqual(host.menuEntriesFor('claude'), [], 'the ⚙ menu is core-only');
  assert.equal(host.handleBarClick('anything', null), false, 'core dispatch falls through');
  assert.equal(host.handleMenuPick('anything', 's', null), false);
  assert.deepEqual(host.settingsSectionOwners(), [], 'openPrefs issues ZERO plugin invokes');
  assert.deepEqual(host.collectSettingsSections(), [], 'Save issues zero');
  assert.deepEqual(host._counts(), {
    actions: 0, segments: 0, footer: 0, badges: 0, menus: 0, sections: 0, overlays: 0,
  });
});

test('applyRowBadges touches no DOM when no rowBadge is registered', () => {
  const { host } = makeHost();
  const row = el('div', null, 'session-item');
  row.dataset.name = 'seat-a';
  // No .session-badges child at all — if the island looked for one it would
  // throw or create one. The row must come back untouched.
  host.applyRowBadges(row);
  assert.deepEqual(row.children, []);
});

// ── §2.1 Status bar ─────────────────────────────────────────────────────────

test('status-bar ids are namespaced and labels/tips are escaped', () => {
  const { host } = makeHost();
  activate(host, 'demo', (rhost) => {
    rhost.ui.statusBar.addAction({
      id: 'go',
      when: () => true,
      button: () => ({ label: '<b>go</b>', tip: 'a "quoted" tip' }),
      onClick: () => {},
    });
  });
  const html = host.statusBarHtml();
  assert.match(html, /data-act="demo:go"/, 'id namespaced by the host, not the plugin');
  assert.match(html, /&lt;b&gt;go&lt;\/b&gt;/, 'label arrives as TEXT — a plugin cannot inject markup');
  assert.ok(!html.includes('<b>go</b>'), 'raw markup would break the Tier-B boundary');
  assert.match(html, /data-tip="a &quot;quoted&quot; tip"/, 'tip escaped incl. quotes');
});

test('when() gates an action, and its ctx reflects core predicates', () => {
  const { host, state } = makeHost();
  let seen = null;
  activate(host, 'demo', (rhost) => {
    rhost.ui.statusBar.addAction({
      id: 'go',
      when: (ctx) => { seen = ctx; return ctx.type === 'claude'; },
      button: () => ({ label: 'go' }),
      onClick: () => {},
    });
  });
  assert.match(host.statusBarHtml(), /demo:go/);
  assert.deepEqual(
    { session: seen.session, type: seen.type, isAgent: seen.isAgent, workspaceId: seen.workspaceId },
    { session: 'seat-a', type: 'claude', isAgent: true, workspaceId: 'ws-1' },
  );
  state.type = 'bash';
  assert.equal(host.statusBarHtml(), '', 'when() false ⇒ nothing rendered');
});

test('a segment returning null renders nothing; a throwing one is isolated', () => {
  const { host } = makeHost();
  activate(host, 'quiet', (rhost) => {
    rhost.ui.statusBar.addSegment({ id: 'nope', render: () => null });
  });
  activate(host, 'broken', (rhost) => {
    rhost.ui.statusBar.addSegment({ id: 'boom', render: () => { throw new Error('x'); } });
  });
  activate(host, 'good', (rhost) => {
    rhost.ui.statusBar.addSegment({ id: 'ok', render: () => ({ text: 'fine' }) });
  });
  const html = host.statusBarHtml();
  // One broken plugin must not blank the bar for every other contribution.
  assert.match(html, /fine/, 'a throwing neighbour does not suppress a healthy segment');
  assert.ok(!html.includes('quiet:nope'));
  assert.ok(!html.includes('broken:boom'));
});

test('hasVisibleContribution keeps the bar alive for a type core would hide', () => {
  // This is the §2.1 one-line core edit's whole reason to exist: core's hide
  // branch fires when no agent/peer condition holds.
  const { host, state } = makeHost();
  state.isAgent = false; state.type = 'bash';
  assert.equal(host.hasVisibleContribution(), false, 'false before any plugin');
  activate(host, 'demo', (rhost) => {
    rhost.ui.statusBar.addSegment({ id: 'seg', render: (ctx) => (ctx.type === 'bash' ? { text: 'x' } : null) });
  });
  assert.equal(host.hasVisibleContribution(), true);
  state.type = 'claude';
  assert.equal(host.hasVisibleContribution(), false, 'recomputed per call, never cached');
});

test('handleBarClick routes BOTH actions and segments to their owner', () => {
  // Two edits, not one: a plugin segment is a <span class="px-seg">, which
  // closest('.px-action') can never see. Core has three such segment lines
  // already (ctx/cost/bust); this pins that plugin segments get theirs.
  const { host } = makeHost();
  const hits = [];
  activate(host, 'demo', (rhost) => {
    rhost.ui.statusBar.addAction({
      id: 'act', when: () => true, button: () => ({ label: 'a' }),
      onClick: (anchor, ctx) => hits.push(['action', anchor, ctx.session]),
    });
    rhost.ui.statusBar.addSegment({
      id: 'seg', render: () => ({ text: 's', onClick: (anchor) => hits.push(['segment', anchor]) }),
    });
  });
  assert.equal(host.handleBarClick('demo:act', 'ANCHOR-A'), true);
  assert.equal(host.handleBarClick('demo:seg', 'ANCHOR-S'), true);
  assert.equal(host.handleBarClick('demo:missing', null), false, 'unknown act falls through to core');
  assert.deepEqual(hits, [['action', 'ANCHOR-A', 'seat-a'], ['segment', 'ANCHOR-S']]);
});

test('a clickable segment gets a data-act; a plain one does not', () => {
  const { host } = makeHost();
  activate(host, 'demo', (rhost) => {
    rhost.ui.statusBar.addSegment({ id: 'plain', render: () => ({ text: 'p' }) });
    rhost.ui.statusBar.addSegment({ id: 'live', render: () => ({ text: 'l', onClick: () => {} }) });
  });
  const html = host.statusBarHtml();
  assert.ok(!html.includes('data-act="demo:plain"'), 'no handler ⇒ not clickable');
  assert.match(html, /data-act="demo:live"/);
  assert.match(html, /px-seg px-plugin px-ctx-btn/, 'clickable segments get the core button class');
});

// ── §2.2 Sidebar ────────────────────────────────────────────────────────────

test('rowBadge paints, updates and removes a chip in .session-badges', () => {
  const { host } = makeHost();
  const badgeState = new Map([['seat-a', { text: '3', tip: 'three' }]]);
  activate(host, 'demo', (rhost) => {
    rhost.ui.sidebar.rowBadge({ id: 'count', resolve: (name) => badgeState.get(name) || null });
  });
  const row = el('div', null, 'session-item');
  row.dataset.name = 'seat-a';
  const badges = el('span', null, 'session-badges');
  row.appendChild(badges);

  host.applyRowBadges(row);
  const chip = badges.querySelector('[data-plugin-badge="demo:count"]');
  assert.ok(chip, 'chip created in the existing badge container, like applyPrBadge');
  assert.equal(chip.textContent, '3');
  assert.equal(chip.getAttribute('data-tip'), 'three', 'data-tip, not title — the tooltip is body-delegated');

  badgeState.set('seat-a', { text: '9' });
  host.applyRowBadges(row);
  assert.equal(badges.querySelectorAll('[data-plugin-badge="demo:count"]').length, 1, 'updated in place, not duplicated');
  assert.equal(badges.querySelector('[data-plugin-badge="demo:count"]').textContent, '9');
  assert.equal(badges.querySelector('[data-plugin-badge="demo:count"]').getAttribute('data-tip'), null,
    'a dropped tip is removed, not left stale');

  badgeState.delete('seat-a');
  host.applyRowBadges(row);
  assert.equal(badges.querySelector('[data-plugin-badge="demo:count"]'), null, 'null ⇒ chip removed');
});

test('footerButton paints on registration and un-paints on dispose', () => {
  const { host, dom } = makeHost();
  const footer = el('div', 'sidebar-footer');
  dom.body.appendChild(footer);
  let clicked = 0, count = 2, off = null;
  activate(host, 'demo', (rhost) => {
    off = rhost.ui.sidebar.footerButton({
      id: 'open', glyph: '◻', label: 'Demo', tip: 'open demo',
      onClick: () => { clicked++; }, badge: () => (count ? String(count) : null),
    });
  });
  const btn = footer.querySelector('[data-plugin-footer="demo:open"]');
  assert.ok(btn, 'registration paints — no refresh call required of the plugin');
  assert.equal(btn.querySelector('.footer-glyph').textContent, '◻');
  assert.equal(btn.querySelector('.footer-label').textContent, 'Demo');
  assert.equal(btn.querySelector('.footer-badge').textContent, '2');
  btn.fire('click');
  assert.equal(clicked, 1);

  count = 0;
  host.renderFooterButtons();
  assert.equal(btn.querySelector('.footer-badge').textContent, '');
  assert.ok(btn.querySelector('.footer-badge').classList.contains('zero'));

  off();
  assert.equal(footer.querySelector('[data-plugin-footer="demo:open"]'), null, 'the disposer un-paints');
});

test('requestRelayout wraps the core debounced relayout', () => {
  const { host, state } = makeHost();
  activate(host, 'demo', (rhost) => { rhost.ui.sidebar.requestRelayout(); });
  assert.equal(state.relayouts, 1, 'the plugin never reaches refreshSidebarView directly');
});

// ── §2.4 Session menu ───────────────────────────────────────────────────────

test('menu providers append namespaced entries and receive their own pick', () => {
  const { host } = makeHost();
  const picks = [];
  activate(host, 'demo', (rhost) => {
    rhost.ui.sessionMenu.addProvider({
      id: 'menu',
      entriesFor: (type) => (type === 'claude' ? [{ act: 'thing', label: 'Do Thing…' }] : []),
      onPick: (act, session, anchor) => picks.push([act, session, anchor]),
    });
  });
  assert.deepEqual(host.menuEntriesFor('claude'), [{ act: 'demo:thing', label: 'Do Thing…' }],
    'the table stays a table — providers return entry LISTS, not predicates');
  assert.deepEqual(host.menuEntriesFor('codex'), [], 'entriesFor is type-conditioned by the plugin');

  assert.equal(host.handleMenuPick('demo:thing', 'seat-a', 'ANCHOR'), true);
  assert.deepEqual(picks, [['thing', 'seat-a', 'ANCHOR']], 'the provider sees its BARE act');
  assert.equal(host.handleMenuPick('tools', 'seat-a', null), false, 'a core act is not a plugin act');
  assert.equal(host.handleMenuPick('gone:thing', 'seat-a', null), false, 'unknown owner falls through');
});

test('malformed menu entries are dropped, not rendered', () => {
  const { host } = makeHost();
  activate(host, 'demo', (rhost) => {
    rhost.ui.sessionMenu.addProvider({
      id: 'menu',
      entriesFor: () => [{ act: 'ok', label: 'Fine' }, { label: 'no act' }, { act: 'no-label' }, null],
      onPick: () => {},
    });
  });
  assert.deepEqual(host.menuEntriesFor('claude'), [{ act: 'demo:ok', label: 'Fine' }]);
});

// ── §2.5 Settings ───────────────────────────────────────────────────────────

test('settings sections mount before .dialog-actions and round-trip values', () => {
  const { host, dom } = makeHost();
  const dialog = el('div', 'prefs-dialog');
  const actions = el('div', null, 'dialog-actions');
  dialog.appendChild(actions);
  dom.body.appendChild(dialog);

  let rendered = null;
  activate(host, 'demo', (rhost) => {
    rhost.ui.settings.section({
      id: 'prefs', title: 'Demo',
      render: (container, values) => { rendered = values; container.appendChild(el('input')); },
      collect: (container) => ({ n: container.children.length }),
    });
  });
  assert.deepEqual(host.settingsSectionOwners(), ['demo'], 'openPrefs pulls values for exactly these');

  host.renderSettingsSections({ demo: { saved: 1 } });
  const section = dialog.querySelector('[data-plugin-section="demo:prefs"]');
  assert.ok(section, 'a <section data-plugin-section> exists');
  assert.equal(dialog.children.indexOf(section) < dialog.children.indexOf(actions), true,
    'mounted BEFORE .dialog-actions, so Save/Cancel stay last');
  assert.deepEqual(rendered, { saved: 1 }, 'the plugin gets its own persisted values, pull-on-open');
  assert.deepEqual(host.collectSettingsSections(), [{ pluginId: 'demo', patch: { n: 1 } }]);

  // Re-open: the body is rebuilt, not appended to.
  host.renderSettingsSections({ demo: {} });
  assert.deepEqual(host.collectSettingsSections(), [{ pluginId: 'demo', patch: { n: 1 } }],
    're-render clears the section body first');
});

test('a disabled plugin\'s settings section does not exist', () => {
  const { host, dom } = makeHost();
  const dialog = el('div', 'prefs-dialog');
  dialog.appendChild(el('div', null, 'dialog-actions'));
  dom.body.appendChild(dialog);
  activate(host, 'demo', (rhost) => {
    rhost.ui.settings.section({ id: 'p', title: 'D', render: () => {}, collect: () => ({}) });
  });
  host.renderSettingsSections({});
  assert.ok(dialog.querySelector('[data-plugin-section="demo:p"]'));
  host.dispose('demo');
  assert.equal(dialog.querySelector('[data-plugin-section="demo:p"]'), null);
  assert.deepEqual(host.settingsSectionOwners(), [], 'and Save stops invoking for it');
});

// ── §2.6 Surfaces ───────────────────────────────────────────────────────────

test('overlay mounts lazily once, and only one is open at a time', () => {
  const { host, dom } = makeHost();
  const log = [];
  let a = null, b = null;
  activate(host, 'demo', (rhost) => {
    a = rhost.ui.surfaces.overlay({
      id: 'a',
      mount: () => log.push('mount-a'),
      onOpen: (opts) => log.push(`open-a:${opts && opts.k}`),
      onClose: () => log.push('close-a'),
    });
    b = rhost.ui.surfaces.overlay({ id: 'b', mount: () => log.push('mount-b'), onClose: () => log.push('close-b') });
  });
  assert.deepEqual(log, [], 'mount is lazy — nothing built until first open');
  assert.equal(dom.body.querySelector('[data-plugin="demo"]'), null);

  a.open({ k: 1 });
  const elA = dom.body.querySelector('[data-plugin="demo"]');
  assert.ok(elA, 'the HOST creates the container, not the plugin');
  assert.ok(!elA.classList.contains('hidden'));
  a.open({ k: 2 });
  assert.deepEqual(log, ['mount-a', 'open-a:1', 'close-a', 'open-a:2'], 'mount runs ONCE');

  b.open();
  assert.deepEqual(log.slice(-3), ['open-a:2', 'close-a', 'mount-b'], 'opening b closes a — centralized, not per-plugin');
  assert.ok(elA.classList.contains('hidden'));
});

test('Escape is handled by the host, so no plugin installs its own key listener', () => {
  const { host, dom } = makeHost();
  let closed = 0;
  let ov = null;
  activate(host, 'demo', (rhost) => {
    ov = rhost.ui.surfaces.overlay({ id: 'a', mount: () => {}, onClose: () => { closed++; } });
  });
  ov.open();
  let stopped = false;
  dom.doc.fire('keydown', { key: 'Escape', stopPropagation: () => { stopped = true; } });
  assert.equal(closed, 1);
  assert.equal(stopped, true, 'the keypress is consumed so core dialogs do not also close');
  dom.doc.fire('keydown', { key: 'Escape', stopPropagation: () => {} });
  assert.equal(closed, 1, 'nothing open ⇒ Escape passes through untouched');
});

// ── Constraint 6: teardown is real ──────────────────────────────────────────

test('the plugin\'s own dispose() runs FIRST, while its DOM still exists', () => {
  const { host, dom } = makeHost();
  const order = [];
  let ov = null;
  activate(host, 'demo', (rhost) => {
    ov = rhost.ui.surfaces.overlay({ id: 'a', mount: () => {}, onClose: () => order.push('close') });
    rhost.onDispose(() => order.push('onDispose'));
    return () => {
      order.push('own');
      // The container must still be reachable here — that is the point of
      // running the plugin's teardown before the host's.
      order.push(dom.body.querySelector('[data-plugin="demo"]') ? 'container-present' : 'container-gone');
    };
  });
  ov.open();
  host.dispose('demo');
  assert.deepEqual(order, ['own', 'container-present', 'close', 'onDispose']);
});

test('an activate() that throws leaves nothing behind', () => {
  const { host } = makeHost();
  assert.throws(() => activate(host, 'demo', (rhost) => {
    rhost.ui.statusBar.addSegment({ id: 's', render: () => ({ text: 'x' }) });
    throw new Error('half-built');
  }), /half-built/);
  assert.deepEqual(host._counts().segments, 0, 'a half-activated plugin is torn down, not left registered');
  assert.equal(host.statusBarHtml(), '');
});

test('dispose() clears every host-wrapped resource — _liveResources is zero', () => {
  // THE constraint-6 gate. Window close is free teardown; disable-without-close
  // is not, and an interval left running fires against a removed container in
  // every open window. The host holds the handles so the plugin need not.
  const { host, dom } = makeHost();
  const target = el('div');
  let ticks = 0, clicks = 0, ownRan = 0;
  activate(host, 'demo', (rhost) => {
    rhost.setInterval(() => { ticks++; }, 1000);
    rhost.setTimeout(() => { ticks++; }, 1000);
    rhost.addEventListener(target, 'click', () => { clicks++; });
    rhost.onDispose(() => { ownRan++; });
  }, { css: '.demo { color: red }' });

  const live = host._liveResources('demo');
  assert.equal(live.intervals, 1);
  assert.equal(live.timers, 1);
  assert.equal(live.listeners, 1);
  assert.equal(live.style, true, 'a <style data-plugin-style> was injected');
  assert.ok(dom.head.querySelector('[data-plugin-style="demo"]'));
  target.fire('click');
  assert.equal(clicks, 1, 'the wrapped listener is a REAL listener, not a stub');

  assert.equal(host.dispose('demo'), true);
  assert.deepEqual(host._liveResources('demo'), {
    timers: 0, intervals: 0, listeners: 0, disposers: 0, style: false,
  }, 'zero live timers/listeners after disable (plan W9 gate #1)');
  assert.equal(ownRan, 1);
  assert.equal(target.listenerCount('click'), 0, 'unregistered from the real target');
  assert.equal(dom.head.querySelector('[data-plugin-style="demo"]'), null, 'the style element is one node to remove');
  target.fire('click');
  assert.equal(clicks, 1, 'a disabled plugin does not keep receiving events');
});

test('the host removes containers wholesale — teardown never trusts the plugin', () => {
  const { host, dom } = makeHost();
  const footer = el('div', 'sidebar-footer');
  dom.body.appendChild(footer);
  let ov = null;
  activate(host, 'demo', (rhost) => {
    ov = rhost.ui.surfaces.overlay({
      id: 'a',
      // A plugin that builds interior DOM and cleans up NOTHING.
      mount: (root) => { root.appendChild(el('div', null, 'plugin-guts')); },
    });
    rhost.ui.sidebar.footerButton({ id: 'f', glyph: '◻', label: 'F', onClick: () => {} });
    rhost.ui.statusBar.addSegment({ id: 's', render: () => ({ text: 'x' }) });
  });
  ov.open();
  assert.ok(dom.body.querySelector('[data-plugin="demo"]'));

  host.dispose('demo');
  assert.equal(dom.body.querySelector('[data-plugin="demo"]'), null, 'the container goes wholesale, guts and all');
  assert.equal(footer.querySelector('[data-plugin-footer="demo:f"]'), null);
  assert.equal(host.statusBarHtml(), '', 'and every registry row with it');
  assert.deepEqual(host._counts(), {
    actions: 0, segments: 0, footer: 0, badges: 0, menus: 0, sections: 0, overlays: 0,
  });
});

test('dispose is idempotent and a plugin-held disposer does not double-fire', () => {
  const { host } = makeHost();
  let n = 0, off = null;
  activate(host, 'demo', (rhost) => { off = rhost.onDispose(() => { n++; }); });
  off();
  assert.equal(n, 1);
  host.dispose('demo');
  assert.equal(n, 1, 'an eagerly-disposed handle is not fired again at teardown');
  assert.equal(host.dispose('demo'), false, 'second dispose is a no-op');
});

test('disposeAll tears down every plugin', () => {
  const { host } = makeHost();
  activate(host, 'one', (rhost) => { rhost.ui.statusBar.addSegment({ id: 's', render: () => ({ text: '1' }) }); });
  activate(host, 'two', (rhost) => { rhost.ui.statusBar.addSegment({ id: 's', render: () => ({ text: '2' }) }); });
  assert.equal(host._counts().segments, 2, 'same bare id, different owners — namespacing keeps them apart');
  host.disposeAll();
  assert.equal(host._counts().segments, 0);
});

test('deactivate() on the module is honored when activate returns nothing', () => {
  const { host } = makeHost();
  let ran = 0;
  host.activate('demo', { activate: () => {}, deactivate: () => { ran++; } }, {});
  host.dispose('demo');
  assert.equal(ran, 1, 'the export is the second half of the A2 contract');
});

// ── rhost surface ───────────────────────────────────────────────────────────

test('rhost exposes invoke + workspaceId and NOT window.api', () => {
  const { host } = makeHost();
  const seen = [];
  const { rhost } = activate(host, 'demo', () => {}, {
    invoke: (id, method, args) => { seen.push([id, method, args]); return Promise.resolve({ ok: true }); },
  });
  rhost.invoke('do.thing', 1, 2);
  assert.deepEqual(seen, [['demo', 'do.thing', [1, 2]]], 'the pluginId is the HOST\'s to supply');
  assert.equal(rhost.workspaceId, 'ws-1', 'law 1 of §3.3: rhost carries its window\'s workspace');
  assert.equal(rhost.id, 'demo');
  // The no-backdoor rule made structural: there is simply no transport here.
  for (const k of ['api', 'window', 'require', 'document']) {
    assert.equal(rhost[k], undefined, `rhost must not expose ${k}`);
  }
});

// ── The W2 additions: the core capabilities a plugin reaches through rhost ──
// Each of these exists because the capability has NON-workbench consumers in
// core, so the row stays core and the plugin gets a wrapped view of it rather
// than a window.api call (which the no-backdoor lint forbids outright).

test('rhost.sessions offers ONLY the workspace-scoped accessor', async () => {
  // The single most load-bearing correction in the pilot (plan §4 W5's
  // blockquote). `session:list` is already sender-scoped, but the FILTER here is
  // what makes the scope the caller's stated one. A `listAll()` on this surface
  // would silently turn a per-window dropdown into a cross-workspace file
  // read/write surface, and fsScope would NOT catch it — it refuses peers, not
  // foreign workspaces.
  const all = [
    { name: 'mine', cwd: '/a', workspaceId: 'ws-1' },
    { name: 'theirs', cwd: '/b', workspaceId: 'ws-2' },
    { name: 'also-mine', cwd: '/c', workspaceId: 'ws-1' },
  ];
  const { host } = makeHost({ listSessions: async () => all });
  const { rhost } = activate(host, 'demo', () => {});

  assert.deepEqual((await rhost.sessions.listWorkspace('ws-1')).map((s) => s.name),
    ['mine', 'also-mine']);
  assert.deepEqual((await rhost.sessions.listWorkspace(rhost.workspaceId)).map((s) => s.name),
    ['mine', 'also-mine'], 'the intended call shape reaches only this window\'s workspace');
  assert.equal(rhost.sessions.listAll, undefined,
    'no global accessor — MUST-FIX 1 holds on the renderer side too');
  assert.equal(rhost.sessions.list, undefined, 'and no unqualified one');
});

test('rhost.sessions.listWorkspace degrades to [] rather than throwing', async () => {
  const { host } = makeHost({ listSessions: async () => { throw new Error('ipc down'); } });
  const { rhost } = activate(host, 'demo', () => {});
  assert.deepEqual(await rhost.sessions.listWorkspace('ws-1'), []);

  const { host: h2 } = makeHost({ listSessions: async () => null });
  const { rhost: r2 } = activate(h2, 'demo', () => {});
  assert.deepEqual(await r2.sessions.listWorkspace('ws-1'), [], 'a non-array answer is not a crash');
});

test('rhost.sessions.active mirrors the core predicate the status bar uses', () => {
  const { host, state } = makeHost();
  const { rhost } = activate(host, 'demo', () => {});
  assert.equal(rhost.sessions.active(), 'seat-a');
  state.active = 'seat-b';
  assert.equal(rhost.sessions.active(), 'seat-b', 'read live, never captured');
});

test('rhost.ui.openPath and ui.showToast wrap core, and lib carries the shared leaf', () => {
  const opened = [], toasted = [];
  const { host } = makeHost({
    openPath: (p) => opened.push(p),
    showToast: (m, o) => toasted.push([m, o]),
  });
  const { rhost } = activate(host, 'demo', () => {});
  rhost.ui.openPath('/tmp/wt');
  rhost.ui.showToast('boom', { kind: 'error' });
  assert.deepEqual(opened, ['/tmp/wt']);
  assert.deepEqual(toasted, [['boom', { kind: 'error' }]]);
  assert.equal(typeof rhost.lib.renderDiffHtml, 'function',
    'render-html stays core (renderer.js + three popovers use it) and is exposed as a named leaf');
  assert.ok(Object.isFrozen(rhost.lib));
});

test('workspaceId is read through a getter, not captured at init', () => {
  // currentWorkspaceId is filled asynchronously by renderer.js, so a captured
  // value would be null for the window's whole life.
  let ws = null;
  const { host } = makeHost({ getWorkspaceId: () => ws });
  const { rhost } = activate(host, 'demo', () => {});
  assert.equal(rhost.workspaceId, null);
  ws = 'ws-late';
  assert.equal(rhost.workspaceId, 'ws-late');
});

test('registration refuses a missing id or a non-function callback', () => {
  const { host } = makeHost();
  activate(host, 'demo', (rhost) => {
    assert.throws(() => rhost.ui.statusBar.addSegment({ render: () => null }), /requires a string id/);
    assert.throws(() => rhost.ui.statusBar.addSegment({ id: 's' }), /render\(\) must be a function/);
    assert.throws(() => rhost.ui.sidebar.rowBadge({ id: 'b', resolve: 'nope' }), /resolve\(\) must be a function/);
  });
  assert.deepEqual(host._counts().segments, 0);
});

test('activating the same plugin twice is refused', () => {
  const { host } = makeHost();
  activate(host, 'demo', () => {});
  assert.throws(() => activate(host, 'demo', () => {}), /already activated/);
});


// ── W9 GATE 1: two windows ──────────────────────────────────────────────────
// The multi-window law (§3.3 law 1) says N windows ⇒ N renderer activations.
// Everything above drives ONE host, which is one window. These drive TWO, which
// is the shape gate 1 actually asks about: per-window overlay state, and a
// disable that leaves nothing live in EITHER window.
//
// What this CANNOT prove, and does not claim to: that Electron delivers the
// `plugin-state` broadcast to both BrowserWindows. That is a running-app check
// (see the journal's gate-1 manual script). What it does prove is that when the
// hint arrives, each window's teardown is complete.

// Two hosts over two independent DOMs. `installDom` assigns global.document, so
// the DOM must be swapped in around every call into a given host — which is
// itself faithful: each window has its own document.
function makeTwoWindows() {
  const wins = [];
  for (const id of ['win-a', 'win-b']) {
    const initPluginHost = load();          // fresh module instance per window
    const dom = installDom();
    const footer = el('div', 'sidebar-footer');
    dom.body.appendChild(footer);
    const host = initPluginHost({
      getActiveSession: () => 'seat-a',
      sessionTypeOf: () => 'claude',
      activeIsAgent: () => true,
      activePeerQueryable: () => false,
      activePeerConfigurable: () => false,
      scheduleSidebarRelayout: () => {},
      getWorkspaceId: () => id,
    });
    wins.push({ id, host, dom, footer, doc: global.document });
  }
  // `in(win, fn)` restores that window's document for the duration of the call.
  const inWin = (w, fn) => { global.document = w.doc; return fn(); };
  return { wins, inWin };
}

test('W9 gate 1: overlay state is INDEPENDENT per window', () => {
  const { wins, inWin } = makeTwoWindows();
  const [a, b] = wins;
  const surfaces = {};
  for (const w of wins) {
    inWin(w, () => {
      w.host.activate('demo', {
        activate: (rhost) => {
          surfaces[w.id] = rhost.ui.surfaces.overlay({
            id: 'panel',
            mount: (root) => { root.appendChild(el('div', null, 'guts')); },
          });
        },
      }, { css: '.demo { color: red }' });
    });
  }

  // Open in A only. B must be untouched — per-window state lives in the
  // activation closure, which is the whole reason activation is per window.
  inWin(a, () => surfaces['win-a'].open());
  assert.ok(a.dom.body.querySelector('[data-plugin="demo"]'), 'A has an overlay container');
  assert.equal(b.dom.body.querySelector('[data-plugin="demo"]'), null,
    'B never mounted one — open() in one window does not open the other');

  inWin(b, () => surfaces['win-b'].open());
  assert.ok(b.dom.body.querySelector('[data-plugin="demo"]'), 'B opens its own, independently');

  // Closing A's leaves B's open.
  inWin(a, () => surfaces['win-a'].close());
  assert.ok(a.dom.body.querySelector('[data-plugin="demo"]').classList.contains('hidden'));
  assert.ok(!b.dom.body.querySelector('[data-plugin="demo"]').classList.contains('hidden'));
});

test('W9 gate 1: disable removes button, overlay, styles and rows from BOTH windows', () => {
  const { wins, inWin } = makeTwoWindows();
  const targets = {};
  for (const w of wins) {
    inWin(w, () => {
      const target = el('div');
      targets[w.id] = target;
      w.host.activate('demo', {
        activate: (rhost) => {
          const ov = rhost.ui.surfaces.overlay({ id: 'panel', mount: (root) => { root.appendChild(el('div')); } });
          rhost.ui.sidebar.footerButton({ id: 'open', glyph: '◫', label: 'Demo', onClick: () => {} });
          rhost.ui.statusBar.addSegment({ id: 'seg', render: () => ({ text: 'x' }) });
          rhost.ui.sessionMenu.addProvider({ id: 'm', entriesFor: () => [{ act: 'go', label: 'Go' }], onPick: () => {} });
          rhost.ui.settings.section({ id: 'sec', title: 'Demo', render: () => {}, collect: () => ({}) });
          rhost.addEventListener(target, 'click', () => {});
          ov.open();
        },
      }, { css: '.demo { color: red }' });
    });
  }

  // Both windows fully populated before the disable.
  for (const w of wins) {
    inWin(w, () => {
      assert.ok(w.footer.querySelector('[data-plugin-footer="demo:open"]'), `${w.id} has the footer button`);
      assert.ok(w.dom.body.querySelector('[data-plugin="demo"]'), `${w.id} has the overlay`);
      assert.ok(w.dom.head.querySelector('[data-plugin-style="demo"]'), `${w.id} has the stylesheet`);
      assert.notEqual(w.host.statusBarHtml(), '');
    });
  }

  // The disable hint lands in each window; each disposes its OWN half.
  for (const w of wins) inWin(w, () => assert.equal(w.host.dispose('demo'), true));

  for (const w of wins) {
    inWin(w, () => {
      assert.equal(w.footer.querySelector('[data-plugin-footer="demo:open"]'), null, `${w.id}: button gone`);
      assert.equal(w.dom.body.querySelector('[data-plugin="demo"]'), null, `${w.id}: overlay gone`);
      assert.equal(w.dom.head.querySelector('[data-plugin-style="demo"]'), null, `${w.id}: styles gone`);
      assert.equal(w.host.statusBarHtml(), '', `${w.id}: status rows gone`);
      assert.deepEqual(w.host.menuEntriesFor('claude'), [], `${w.id}: menu rows gone`);
      assert.deepEqual(w.host.settingsSectionOwners(), [], `${w.id}: settings section gone`);
      // ZERO live timers/listeners — the gate's actual wording.
      assert.deepEqual(w.host._liveResources('demo'), {
        timers: 0, intervals: 0, listeners: 0, disposers: 0, style: false,
      }, `${w.id}: zero live resources`);
      assert.deepEqual(w.host._counts(), {
        actions: 0, segments: 0, footer: 0, badges: 0, menus: 0, sections: 0, overlays: 0,
      }, `${w.id}: every registry empty`);
      assert.equal(targets[w.id].listenerCount('click'), 0, `${w.id}: listener unregistered from the real target`);
    });
  }
});
