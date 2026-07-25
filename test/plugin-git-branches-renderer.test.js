'use strict';
// plugin-git-branches-renderer.test.js — the renderer half of the git-branches
// plugin, driven through a fake rhost.
//
// Written for t17, a defect Bogdan found by RUNNING the app: disable the plugin
// with two windows open (both cleared correctly), re-enable, and only one window
// showed badges again; the other filled in 30-60 seconds later, on its own,
// while he typed.
//
// The two-window ORDERING cannot be harnessed — no test holds two real
// BrowserWindows — so this file proves the single-window mechanism underneath it,
// which is what actually decides whether a re-enabled window paints:
//
//   1. A freshly-activated renderer half cannot bootstrap itself. Its poll set is
//      `seen`, and `seen` is written in exactly one place — `resolve()`, i.e. only
//      when CORE renders a row. Until that happens the poll runs forever asking
//      about nothing, so "wait for the next refresh interval" never arrives.
//   2. Therefore activation must ask for a relayout itself. Nothing in the host
//      does it: `dispose()` un-paints eagerly (plugin-host.js:649) but `activate()`
//      has no counterpart, and `rowBadge()` registration paints nothing, unlike its
//      sibling `footerButton()` which calls renderFooterButtons() on registration.
//
// Both are asserted below. Test 2 is the one that fails without the fix.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'git-branches', 'renderer.js');

// ── A fake rhost with a hand-cranked clock ──────────────────────────────────
// The plugin's only timer access is rhost.setTimeout/setInterval (§5), so
// holding those is enough to drive it deterministically with no real waiting.
function makeRhost(replies = {}) {
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  const invokes = [];
  const state = { relayouts: 0, badge: null, section: null, logs: [] };

  const rhost = {
    setTimeout(fn, ms) { const id = nextId++; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, ms) { const id = nextId++; intervals.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    invoke(method, ...args) {
      invokes.push({ method, args });
      const r = replies[method];
      return Promise.resolve(typeof r === 'function' ? r(...args) : r);
    },
    log: {
      info: (...a) => state.logs.push(['info', ...a]),
      error: (...a) => state.logs.push(['error', ...a]),
    },
    ui: {
      sidebar: {
        rowBadge(spec) { state.badge = spec; return () => {}; },
        requestRelayout() { state.relayouts += 1; },
      },
      settings: {
        section(spec) { state.section = spec; return () => {}; },
      },
    },
  };

  // Fire every timeout currently pending, once. Callbacks may schedule more;
  // those wait for the next call, which is what keeps this a clock and not a
  // runaway loop.
  const fireTimeouts = () => {
    const due = [...timeouts.entries()];
    for (const [id, t] of due) { timeouts.delete(id); t.fn(); }
    return due.length;
  };
  const fireIntervals = () => {
    for (const t of [...intervals.values()]) t.fn();
  };
  // Let the plugin's invoke() promise chains settle. Two turns: the settings.get
  // chain is .then().catch().then().
  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

  return { rhost, invokes, state, fireTimeouts, fireIntervals, settle, timeouts, intervals };
}

const SETTINGS_REPLY = { ok: true, values: { refreshSeconds: 10, maxLength: 18 } };
const manyReply = (results) => ({ ok: true, results, settings: SETTINGS_REPLY.values });

function load() {
  delete require.cache[require.resolve(PLUGIN)];
  return require(PLUGIN);
}

test('git-branches renderer: the poll cannot bootstrap itself — `seen` is written only by resolve()', async () => {
  const h = makeRhost({
    'settings.get': SETTINGS_REPLY,
    'branch.getMany': (names) => manyReply(
      Object.fromEntries((names || []).map((n) => [n, { state: 'ok', branch: 'master', at: Date.now() }]))),
  });
  load().activate(h.rhost);
  await h.settle();

  // Poll as many times as the app would in a minute. Nothing is fetched, because
  // activeNames() reads `seen` and `seen` is still empty: this is the state a
  // re-enabled window is in until core happens to lay the sidebar out.
  for (let i = 0; i < 6; i++) { h.fireIntervals(); await h.settle(); h.fireTimeouts(); await h.settle(); }
  assert.equal(h.invokes.filter((i) => i.method === 'branch.getMany').length, 0,
    'with an empty `seen`, polling forever fetches nothing — the interval is not a self-heal');

  // One resolve() — what a core relayout does — and the machine starts.
  assert.equal(h.state.badge.resolve('seat-a', {}), null, 'first sight returns null and queues a fetch');
  h.fireTimeouts();              // the 60ms first-sight flush
  await h.settle();
  const fetched = h.invokes.filter((i) => i.method === 'branch.getMany');
  assert.equal(fetched.length, 1, 'resolve() is what produces the first fetch');
  assert.deepEqual(fetched[0].args[0], ['seat-a']);
});

test('git-branches renderer: activation requests a relayout without waiting to be rendered', async () => {
  const h = makeRhost({
    'settings.get': SETTINGS_REPLY,
    'branch.getMany': (names) => manyReply(
      Object.fromEntries((names || []).map((n) => [n, { state: 'ok', branch: 'master', at: Date.now() }]))),
  });
  load().activate(h.rhost);
  await h.settle();
  h.fireTimeouts();              // the 120ms relayout debounce
  await h.settle();

  // THE defect from t17. Without this, a re-enabled window paints only when
  // something unrelated triggers a sidebar relayout — core's 30s
  // refreshSidebarMeta interval (renderer/renderer.js:1172) or PTY activity —
  // which is precisely the "30-60 seconds later, while I was typing" that was
  // observed. `requestRelayout` is lent by the frozen API for exactly this.
  assert.ok(h.state.relayouts >= 1,
    'activate() must ask core for a relayout: nothing else will, since the host paints on dispose but not on activate');
});

test('git-branches renderer: teardown stops the timers it owns', async () => {
  const h = makeRhost({ 'settings.get': SETTINGS_REPLY, 'branch.getMany': () => manyReply({}) });
  const dispose = load().activate(h.rhost);
  await h.settle();
  assert.equal(typeof dispose, 'function', 'activate() returns its own disposer');
  dispose();
  assert.equal(h.timeouts.size, 0, 'no timeout outlives teardown');
  assert.equal(h.intervals.size, 0, 'no interval outlives teardown');
});
