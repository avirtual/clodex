'use strict';

// proxy-bar-press-open.test.js — the ctx/cost/bust popovers open from the bar's
// `mousedown`, not its `click` (t636).
//
// `renderProxyBar` rebuilds every segment wholesale (`tele.innerHTML =
// segs.join(…)`) and two of its callers fire on a stream: a `session-proxy`
// event every PROXY_POLL_MS, and a `session-ctx` event per statusline update.
// A `click` fires on the nearest common ancestor of the mousedown and mouseup
// targets, so a rebuild landing between the two leaves that ancestor as the
// BAR — and `closest('[data-act="ctx"]')` searches ancestors, not descendants,
// so it finds nothing and no popover opens. The window is one rebuild wide,
// so this is a narrow race rather than a routinely reproducible one.
//
// The click DOES fire, on the bar; the handler runs and falls through. A test
// asserting that no click arrives would pin the wrong mechanism.
//
// `mousedown` cannot be swallowed that way: the anchor is still attached when
// the press lands. The three subjects that matter:
//   swallowed press  — the regression itself. Reds if the opens move back to
//                      `click` (the whole fix), since the click target is the bar.
//   ordinary press   — the anti-degenerate half: the fix must not open TWICE now
//                      that a press and its click both reach the bar. Reds if a
//                      popover opens unconditionally, or if the opens are bound
//                      to both event types.
//   .px-link         — deliberately still on `click`; opening a browser window
//                      on press is a behaviour change. Reds if it moves.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const rendererSrc = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');

// --- the smallest DOM that can express the bug -------------------------------
// Only what the handlers touch: `closest` over a parent chain, and listeners
// keyed by event type. Bubbling needs no modelling — both handlers are bound on
// the bar and read `e.target`, which is what a bubbled event delivers.

function matches(node, sel) {
  for (const part of sel.match(/\.[\w-]+|\[data-act(?:="[^"]*")?\]/g) || []) {
    if (part[0] === '.') {
      if (!node.classes.has(part.slice(1))) return false;
    } else {
      const m = part.match(/^\[data-act="([^"]*)"\]$/);
      if (m ? node.dataset.act !== m[1] : node.dataset.act === undefined) return false;
    }
  }
  return true;
}

function el(className = '', dataset = {}) {
  return {
    classes: new Set(className.split(/\s+/).filter(Boolean)),
    dataset: { ...dataset },
    parentNode: null,
    closest(sel) {
      for (let n = this; n; n = n.parentNode) if (matches(n, sel)) return n;
      return null;
    },
  };
}

function makeBar() {
  const listeners = new Map();
  const bar = el('proxy-bar');
  bar.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  // A segment as renderProxyBar emits it: a span parented to the bar.
  bar.segment = (act) => {
    const seg = el(`px-seg px-ctx-btn`, { act });
    seg.parentNode = bar;
    return seg;
  };
  bar.link = (url) => {
    const a = el('px-seg px-link', {});
    a.dataset.url = url;
    a.parentNode = bar;
    return a;
  };
  bar.fire = (type, target, extra = {}) => {
    const e = { type, target, button: 0, preventDefault() { e.defaultPrevented = true; }, ...extra };
    for (const fn of listeners.get(type) || []) fn(e);
    return e;
  };
  bar.boundTypes = () => [...listeners.keys()].sort();
  return bar;
}

// --- load the bar's handler block out of renderer.js -------------------------

function loadBarHandlers({ activeSession = 'seat-1' } = {}) {
  const block = rendererSrc.match(
    /const openPopoverOnPress = [\s\S]*?bar\.addEventListener\('click', runBarActionOnClick\);/);
  assert.ok(block, 'ENTER: the proxy-bar handler block was found in renderer.js');

  const bar = makeBar();
  const opens = [];
  const api = { openExternal: (url) => opens.push(['external', url]), openWirescope: (url) => opens.push(['wirescope', url]) };
  const stubs = {
    bar,
    activeSession,
    openContextPopover: (name, anchor) => opens.push(['ctx', name, anchor]),
    openCostPopover: (name, anchor) => opens.push(['cost', name, anchor]),
    openBustPopover: (name, anchor) => opens.push(['bust', name, anchor]),
    window: { api },
    document: { documentElement: {} },
    getComputedStyle: () => ({ getPropertyValue: () => '#000' }),
    pluginBar: { handleBarClick: () => false, menuEntriesFor: () => [] },
    openFilesPopover() {}, openVoicePopover() {}, openPeerArgs() {},
    openSessionMenu() {}, closeSessionMenu() {}, isSessionMenuOpen: () => false,
    openStripMenu() {}, closeStripMenu() {}, isStripMenuOpen: () => false,
    openWarmMenu() {}, closeWarmMenu() {}, isWarmMenuOpen: () => false,
    sessionTypeOf: () => 'claude',
    routeSessionAction() {},
  };
  const names = Object.keys(stubs);
  new Function(...names, block[0])(...names.map((n) => stubs[n]));
  return { bar, opens };
}

test('a press swallowed by a mid-click rebuild still opens the popover', () => {
  // The reported bug, staged exactly: press the segment, let renderProxyBar
  // replace it, then deliver the click the browser actually produces — one
  // whose target is the bar, because the pressed node is gone.
  for (const act of ['ctx', 'cost', 'bust']) {
    const { bar, opens } = loadBarHandlers();
    const seg = bar.segment(act);
    bar.fire('mousedown', seg);

    seg.parentNode = null;          // renderProxyBar's innerHTML assignment
    bar.segment(act);               // the replacement node nobody pressed
    bar.fire('click', bar);         // nearest common ancestor of down and up

    assert.deepStrictEqual(opens, [[act, 'seat-1', seg]],
      `${act}: the popover opens once, anchored to the node that was pressed`);
  }
});

test('an ordinary press opens the popover exactly once', () => {
  // Both a mousedown and a click now reach the bar for the same gesture. The
  // second must not open a second popover.
  for (const act of ['ctx', 'cost', 'bust']) {
    const { bar, opens } = loadBarHandlers();
    const seg = bar.segment(act);
    bar.fire('mousedown', seg);
    bar.fire('click', seg);
    assert.deepStrictEqual(opens, [[act, 'seat-1', seg]], `${act}: opened once, not twice`);
  }
});

test('a non-primary button does not open a popover', () => {
  // `click` never fired for a right-press; `mousedown` does, so the guard is
  // load-bearing rather than defensive.
  const { bar, opens } = loadBarHandlers();
  const seg = bar.segment('ctx');
  bar.fire('mousedown', seg, { button: 2 });
  assert.deepStrictEqual(opens, [], 'a right-press on the segment opens nothing');
});

test('with no active session a press opens nothing', () => {
  const { bar, opens } = loadBarHandlers({ activeSession: null });
  bar.fire('mousedown', bar.segment('ctx'));
  assert.deepStrictEqual(opens, [], 'no session, no popover');
});

test('the wirescope link stays on click, not press', () => {
  const { bar, opens } = loadBarHandlers();
  const link = bar.link('http://localhost:1/_session?session=s1');
  bar.fire('mousedown', link);
  assert.deepStrictEqual(opens, [], 'pressing the link opens no window');
  bar.fire('click', link);
  assert.deepStrictEqual(opens, [['wirescope', 'http://localhost:1/_session?session=s1']],
    'the window opens on the click, where it always did');
});

test('the bar binds both event types', () => {
  const { bar } = loadBarHandlers();
  assert.deepStrictEqual(bar.boundTypes(), ['click', 'mousedown'],
    'popovers press-open, the link and the menus stay on click');
});

test('each popover exempts its own segment from its outside-press close', () => {
  // The fix rests on this: the popovers close on a document-level `mousedown`,
  // so the same press that opens one would close it if the handler did not
  // exempt the segment. Checked at source in all three rather than assumed.
  for (const [file, act] of [['context-popover', 'ctx'], ['cost-popover', 'cost'], ['bust-popover', 'bust']]) {
    const src = fs.readFileSync(require.resolve(`../renderer/popovers/${file}.js`), 'utf8');
    const handler = src.match(/document\.addEventListener\('mousedown',[\s\S]*?\n  \}\);/);
    assert.ok(handler, `ENTER: ${file} closes on a document mousedown`);
    assert.match(handler[0], new RegExp(`closest\\('\\[data-act="${act}"\\]'\\)\\) return`),
      `${file} lets the press that opens it through instead of closing on it`);
  }
});
