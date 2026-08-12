'use strict';
// activity-tab-badge-order.test.js — the ONE non-DOM claim left in
// renderer/activity-tab.js after the badge machine moved to lib/: `noticeSubs`
// runs ABOVE the `if (!chipsEl) return` unmount guard in `renderChips`.
//
// That ordering is the whole feature. The drawer host mounts only the FIRST
// registered tenant and Activity registers second, so on a fresh window its pane
// does not exist until the operator selects the tab. Badge accounting below the
// guard means the badge only ever counts once you have already looked — the
// feature exactly inverted, and green under every unit test of the leaf itself.
// So it is pinned here, against the real module under a DOM stub, which is also
// how t206 D2 was found.
//
// The stub is deliberately thin: it answers only what activity-tab actually
// calls, so a tab that starts reaching for a new DOM affordance fails loudly
// here rather than being silently absorbed.
const { test } = require('node:test');
const assert = require('node:assert');

// Selectors the pane's `innerHTML` template would have produced. The stub cannot
// parse HTML, so these are the ones it materializes on demand; anything else the
// tab queries returns null and surfaces as a TypeError rather than a pass.
const LAZY = new Set([
  '.activity-chips', '.activity-body', '.activity-asof',
  '.activity-chip-parent', '.activity-chip-label',
]);

function el(tag = 'div') {
  const e = {
    tagName: tag, children: [], parentNode: null,
    textContent: '', title: '', type: '', className: '',
    dataset: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {},
    get innerHTML() { return e._html || ''; },
    set innerHTML(v) { e._html = v; e.children = []; },
    get firstChild() { return e.children[0] || null; },
    get nextSibling() {
      if (!e.parentNode) return null;
      return e.parentNode.children[e.parentNode.children.indexOf(e) + 1] || null;
    },
    appendChild(c) {
      if (c.parentNode) c.remove();
      c.parentNode = e; e.children.push(c); return c;
    },
    insertBefore(c, ref) {
      if (c.parentNode) c.remove();
      c.parentNode = e;
      const i = ref ? e.children.indexOf(ref) : -1;
      if (i < 0) e.children.push(c); else e.children.splice(i, 0, c);
      return c;
    },
    remove() {
      if (!e.parentNode) return;
      const i = e.parentNode.children.indexOf(e);
      if (i >= 0) e.parentNode.children.splice(i, 1);
      e.parentNode = null;
    },
    querySelector(sel) {
      const hit = e.children.find((c) => `.${c.className}` === sel);
      if (hit) return hit;
      if (!LAZY.has(sel)) return null;
      const made = el('div');
      made.className = sel.slice(1);
      return e.appendChild(made);
    },
    querySelectorAll(sel) {
      return e.children.filter((c) => `.${c.className}` === sel);
    },
  };
  return e;
}

// Installs the globals activity-tab reaches for at construction time, and
// returns a teardown. `document.addEventListener('selectionchange', …)` runs
// inside createActivityTab, so document must exist before the require's factory
// is called.
function withDom(fn) {
  const had = { d: global.document, w: global.window };
  global.document = { createElement: el, addEventListener() {} };
  global.window = { api: { getSubagentFeed: async () => ({ ok: true, data: {} }) } };
  try { return fn(); } finally { global.document = had.d; global.window = had.w; }
}

const { createActivityTab } = require('../renderer/activity-tab');

// A payload as the 5s `session-proxy` poll delivers it.
const proxyState = (...subs) => new Map([['alpha', {
  at: Date.now(),
  payload: { linked: true, subagents: subs.map(([key, requests]) => ({ key, requests, lastActiveS: 1 })) },
}]]);

// A host that registers WITHOUT mounting — Activity's real position, second in
// the drawer, pane not built until the operator selects the tab.
function unmountedHost(levels) {
  return {
    register: () => (level) => levels.push(level),
    domSelection: () => '',
    open() {},
  };
}

test('a sub that ran while the pane was never mounted still badges', () => {
  withDom(() => {
    const levels = [];
    const tab = createActivityTab({
      host: unmountedHost(levels), proxyState: proxyState(['sub1', 3]), proxyPollMs: 5000,
    });
    // No mount ever happened — this is the fresh-window state. If badge
    // accounting sat below the `if (!chipsEl) return` guard, this is exactly
    // where it would be skipped and `levels` would stay empty.
    tab.refreshChips();
    assert.deepStrictEqual(levels, ['activity'],
      'noticeSubs must run ABOVE the unmount guard: an unmounted pane still badges');
  });
});

test('badging while unmounted is still at most once per sub per away-period', () => {
  withDom(() => {
    const levels = [];
    const tab = createActivityTab({
      host: unmountedHost(levels), proxyState: proxyState(['sub1', 3], ['sub2', 3]), proxyPollMs: 5000,
    });
    tab.refreshChips();
    tab.refreshChips();
    tab.refreshChips();
    // Two subs, one badge each — not six, and not two-per-poll. A guard that
    // merely counted `live.size` every poll would pass the test above and fail
    // this one.
    assert.deepStrictEqual(levels, ['activity', 'activity']);
  });
});

// The latent bug hand found while ruling out causes in t206 and did not fix.
// Not reachable today (the log tenant has no `available`), which is precisely
// why it needs a test: if log ever gains an `available()` that returns false,
// Activity becomes the first registered tenant and the host mounts it from
// INSIDE `register` — before `register` has returned the notify function. Every
// live sub would be marked notified against the `() => {}` stub, with no badge,
// permanently, for the life of the window.
test('a mount from inside register does not swallow the badges it produces', () => {
  withDom(() => {
    const levels = [];
    // The host mounts the first registered tenant synchronously, from within
    // `register` — so `notify` does not exist yet when `mount` runs `renderChips`.
    const host = {
      register(tenant) {
        tenant.mount(el('div'));
        return (level) => levels.push(level);
      },
      domSelection: () => '',
      open() {},
    };
    createActivityTab({ host, proxyState: proxyState(['sub1', 3], ['sub2', 7]), proxyPollMs: 5000 });
    // Both badges must survive the pre-mount window via the queue and drain
    // once the real notify is in hand. Empty here is the permanent silent
    // failure this queue exists to prevent.
    assert.deepStrictEqual(levels, ['activity', 'activity'],
      'badges raised before register returned must be queued and drained, not dropped');
  });
});

// The other half of the same guarantee: the queue drains ONCE. A drain that
// re-notified on every later poll would turn the pre-mount window into a
// permanent duplicate source.
test('the pre-mount queue drains once, not on every later poll', () => {
  withDom(() => {
    const levels = [];
    const host = {
      register(tenant) { tenant.mount(el('div')); return (l) => levels.push(l); },
      domSelection: () => '',
      open() {},
    };
    const tab = createActivityTab({
      host, proxyState: proxyState(['sub1', 3]), proxyPollMs: 5000,
    });
    assert.deepStrictEqual(levels, ['activity']);
    tab.refreshChips();
    tab.refreshChips();
    assert.deepStrictEqual(levels, ['activity'], 'the same sub must not re-badge in one away-period');
  });
});

// A payload too old to be evidence contributes no chips, so it must contribute
// no badges either — otherwise a dead proxy badges forever.
test('a stale payload badges nothing', () => {
  withDom(() => {
    const levels = [];
    // Built from the same helper as every other fixture, mutating ONLY the
    // variable under test. A hand-rolled payload here would drift when the
    // helper's shape changes, and this assertion is an ABSENCE — it would go
    // vacuously true for the wrong reason and never say so.
    const stale = proxyState(['sub1', 3]);
    stale.get('alpha').at = Date.now() - 60000; // far past proxyPollMs * 4
    const tab = createActivityTab({ host: unmountedHost(levels), proxyState: stale, proxyPollMs: 5000 });
    tab.refreshChips();
    assert.deepStrictEqual(levels, []);
  });
});

// dropParent runs while unmounted too (a session can close with the drawer shut),
// and it must not throw on the DOM it does not have.
test('dropParent clears badge state while the pane is unmounted', () => {
  withDom(() => {
    const levels = [];
    const tab = createActivityTab({
      host: unmountedHost(levels), proxyState: proxyState(['sub1', 3]), proxyPollMs: 5000,
    });
    tab.refreshChips();
    tab.dropParent('alpha');
    // Forgotten, so the same sub is fresh again rather than notified-for-life.
    tab.refreshChips();
    assert.deepStrictEqual(levels, ['activity', 'activity']);
  });
});
