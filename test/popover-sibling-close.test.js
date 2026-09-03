'use strict';

// popover-sibling-close.test.js — the three bar-anchored popovers (ctx, cost,
// bust) are mutually exclusive: opening one closes the other two (t638).
//
// All three sit at z-index 50 anchored to the same status bar, and each closed
// only itself — so a press on Cost with Context open left two overlapping
// panels, and each Escape handler saw only its own element.
//
// The fix is a registry (renderer/lib/popover-group.js): each module registers
// its own private closer and gets back a `closeSiblings` that runs every OTHER
// member's. Self-exclusion is therefore structural — the key cannot reach its
// own closer — rather than a conditional an edit could invert.
//
// The subjects, and why each is here:
//   every ordered pair  — a fix that handles only the pair its author had in
//                         mind is the likely failure, so all six run.
//   open one, two shut  — the whole-set case the pairs do not cover.
//   re-open             — the anti-degenerate half AT THE ISLAND. Note what it
//                         cannot see: every opener calls closeSiblings() BEFORE
//                         revealing itself, so a registry that closed its own key
//                         too would be undone by the reveal a line later and this
//                         subject would stay green. Measured, not assumed — the
//                         self-closing mutant reds nothing above the leaf.
//   leaf self-exclusion — which is why the registry is pinned directly, where a
//                         self-close IS observable. Two independent guards hold
//                         the invariant (the key skip, and close-before-reveal);
//                         a test that pins neither is passing for a third reason.
//   dataset.name        — the sibling must be shut by its OWN closer, which also
//                         clears the in-flight-fetch bail guard. A raw
//                         classList.add in the caller would leave it set.
//   bar dispatch parity — the completeness half: every opener the bar's press
//                         handler dispatches to must be a group member.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createPopoverGroup } = require('../renderer/lib/popover-group');

const REPO = path.join(__dirname, '..');

const KINDS = [
  { key: 'ctx', ids: ['ctx-popover', 'ctx-popover-name', 'ctx-popover-body', 'ctx-popover-close'] },
  { key: 'cost', ids: ['cost-popover', 'cost-popover-name', 'cost-popover-body', 'cost-popover-close'] },
  { key: 'bust', ids: ['bust-popover', 'bust-popover-name', 'bust-popover-body', 'bust-popover-close'] },
];

// --- the smallest DOM the three inits run against ----------------------------
// Only what they touch on the way to their first `await`: an id lookup, a class
// set, a dataset, and the offset/style pair placeAboveAnchor writes.

function fakeEl(classes = []) {
  const set = new Set(classes);
  return {
    dataset: {},
    style: {},
    textContent: '',
    offsetWidth: 320,
    offsetHeight: 240,
    isConnected: true,
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
    },
    getBoundingClientRect: () => ({ left: 100, top: 400, width: 40, height: 16 }),
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    addEventListener() {},
    contains: () => false,
  };
}

function harness() {
  const prev = { document: global.document, window: global.window };

  const els = new Map();
  for (const { ids } of KINDS) {
    // Every popover element starts HIDDEN, as the markup ships it. A fixture that
    // started them visible would make "the sibling is hidden" true before a
    // single opener ran.
    for (const id of ids) els.set(id, fakeEl(id.endsWith('-popover') ? ['hidden'] : []));
  }

  global.document = {
    getElementById: (id) => {
      // THROWS rather than answering null: each init would go on to crash on a
      // property of null, and a fixture that quietly returned null would make the
      // failure look like the module's rather than the harness's.
      if (!els.has(id)) throw new Error(`fakeDocument: unhandled id ${id}`);
      return els.get(id);
    },
    querySelector: () => null,
    addEventListener() {},
    documentElement: {},
  };
  global.window = { innerWidth: 1200, innerHeight: 800, api: {} };

  const barPopovers = createPopoverGroup();
  const proxyState = new Map([['seat-1', { payload: {} }]]);
  // Never resolves: every opener's reveal + sibling-close happens BEFORE its
  // first await, so the fetch is exactly the part this test does not model.
  const pending = () => new Promise(() => {});
  const popoverApi = () => ({ ctx: pending, report: pending, bust: pending });

  const { initContextPopover } = require('../renderer/popovers/context-popover');
  const { initCostPopover } = require('../renderer/popovers/cost-popover');
  const { initBustPopover } = require('../renderer/popovers/bust-popover');

  const open = {
    ctx: initContextPopover({
      popoverApi, ctxCatLabel: () => '', openReportPanel() {}, openToolsPopover() {},
      openSkillsPopover() {}, proxyState, sessionTypeOf: () => 'claude', barPopovers,
    }).openContextPopover,
    cost: initCostPopover({ popoverApi, proxyState, barPopovers }).openCostPopover,
    bust: initBustPopover({ popoverApi, proxyState, barPopovers }).openBustPopover,
  };

  const anchor = fakeEl();
  return {
    // Fires the opener's synchronous prefix and drops the pending promise.
    open(key) { void open[key]('seat-1', anchor); },
    visible: (key) => !els.get(`${key}-popover`).classList.contains('hidden'),
    nameOf: (key) => els.get(`${key}-popover`).dataset.name,
    shown: () => KINDS.map((k) => k.key).filter((k) => !els.get(`${k}-popover`).classList.contains('hidden')),
    restore() { global.document = prev.document; global.window = prev.window; },
  };
}

const KEYS = KINDS.map((k) => k.key);

// --- the registry leaf, where self-exclusion is observable -------------------

test('closeSiblings runs every other member and never its own key', () => {
  const g = createPopoverGroup();
  const fired = [];
  const closeA = g.register('a', () => fired.push('a'));
  const closeB = g.register('b', () => fired.push('b'));
  g.register('c', () => fired.push('c'));

  closeA();
  assert.deepStrictEqual(fired.sort(), ['b', 'c'], "'a' closed itself, or missed a sibling");

  fired.length = 0;
  closeB();
  assert.deepStrictEqual(fired.sort(), ['a', 'c'], "'b' closed itself, or missed a sibling");
});

test('a lone member closes nothing', () => {
  // The registry must not assume a populated map: `closers` holds one entry while
  // the first island initialises, and the other two register after it.
  const g = createPopoverGroup();
  let fired = 0;
  g.register('only', () => { fired++; })();
  assert.strictEqual(fired, 0, 'the sole member closed itself');
});

test('a duplicate key is refused', () => {
  // Two islands registering the same key would silently overwrite the first
  // closer, leaving one popover nothing closes — the defect this fixes, back.
  const g = createPopoverGroup();
  g.register('ctx', () => {});
  assert.throws(() => g.register('ctx', () => {}), /duplicate key ctx/);
});

test('each opener closes its siblings BEFORE revealing itself', () => {
  // The second guard, and the reason the island-level re-open subject cannot see
  // a self-closing registry. If a closeSiblings() call ever moves below the
  // reveal, self-exclusion becomes the only thing standing between a user and a
  // popover that hides on the press that opened it.
  for (const { key } of KINDS) {
    const file = key === 'ctx' ? 'context' : key;
    const src = fs.readFileSync(path.join(REPO, 'renderer', 'popovers', `${file}-popover.js`), 'utf8');
    const call = src.indexOf('closeSiblings();');
    const reveal = src.indexOf(".classList.remove('hidden')");
    assert.ok(call > 0, `ENTER: ${file}-popover.js calls closeSiblings()`);
    assert.ok(reveal > 0, `ENTER: ${file}-popover.js reveals itself`);
    assert.ok(call < reveal, `${file}-popover.js closes its siblings after revealing itself`);
  }
});


test('each popover opens on its own', () => {
  // ENTER for everything below: the assertions downstream are all "the OTHER two
  // are hidden", which is true of a harness whose openers never reveal anything.
  for (const key of KEYS) {
    const h = harness();
    try {
      assert.deepStrictEqual(h.shown(), [], `${key}: all three start hidden`);
      h.open(key);
      assert.deepStrictEqual(h.shown(), [key], `${key} opened and is the only one showing`);
    } finally { h.restore(); }
  }
});

test('opening one closes the other, in every ordered pair', () => {
  let pairs = 0;
  for (const first of KEYS) {
    for (const second of KEYS) {
      if (first === second) continue;
      pairs++;
      const h = harness();
      try {
        h.open(first);
        assert.ok(h.visible(first), `ENTER: ${first} is open before ${second} is pressed`);
        h.open(second);
        assert.deepStrictEqual(h.shown(), [second],
          `opening ${second} left ${first} on screen underneath it`);
      } finally { h.restore(); }
    }
  }
  assert.strictEqual(pairs, 6, 'all six ordered pairs ran');
});

test('opening one closes BOTH others', () => {
  for (const key of KEYS) {
    const others = KEYS.filter((k) => k !== key);
    const h = harness();
    try {
      for (const o of others) h.open(o);
      // The two others cannot both be open at once — that is the fix. Opening
      // them in turn leaves the LAST one, so this states the reachable state
      // rather than a two-open one the fix makes impossible.
      assert.deepStrictEqual(h.shown(), [others[1]],
        `ENTER: ${others[1]} is open before ${key} is pressed`);
      h.open(key);
      assert.deepStrictEqual(h.shown(), [key], `${key} did not end up alone`);
    } finally { h.restore(); }
  }
});

test('opening the same popover twice leaves it open', () => {
  // The anti-degenerate half. A closeSiblings that also closed its own key would
  // pass every assertion above and hide the panel the user just pressed.
  for (const key of KEYS) {
    const h = harness();
    try {
      h.open(key);
      h.open(key);
      assert.deepStrictEqual(h.shown(), [key], `${key} closed itself on re-open`);
      assert.strictEqual(h.nameOf(key), 'seat-1', `${key} kept its in-flight target`);
    } finally { h.restore(); }
  }
});

test('a closed sibling is shut by its own closer, not a bare class add', () => {
  // `dataset.name` is the guard each opener re-checks after its await. Closing a
  // sibling by adding `hidden` from outside would leave the name set; the module's
  // own closer clears it, so a fetch resolving into the closed popover bails.
  for (const first of KEYS) {
    const second = KEYS.find((k) => k !== first);
    const h = harness();
    try {
      h.open(first);
      assert.strictEqual(h.nameOf(first), 'seat-1', `ENTER: ${first} recorded its target`);
      h.open(second);
      assert.strictEqual(h.nameOf(first), '',
        `${first} was hidden without clearing the bail guard its pending fetch reads`);
    } finally { h.restore(); }
  }
});

// --- completeness: the bar's dispatch set IS the group ------------------------
// Two input sets, both stated: the FILE read (renderer.js's press handler) and
// the PATTERN matched (`openXPopover(activeSession, …)`). A handler that stopped
// matching would yield an empty set, and "every member is in the group" is true
// of nothing — so the count is pinned before the membership is asserted.

test('every popover the bar press-opens is a group member', () => {
  const src = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
  const block = src.match(/const openPopoverOnPress = [\s\S]*?\n  \};/);
  assert.ok(block, 'ENTER: the press handler was found in renderer.js');

  const dispatched = [...block[0].matchAll(/open(\w+)Popover\(activeSession/g)].map((m) => m[1].toLowerCase());
  assert.deepStrictEqual(dispatched.sort(), ['bust', 'context', 'cost'],
    'the press handler dispatches a popover this test does not know about');

  // Each module names its own key in its register() call; the bar's `data-act`
  // and that key are the same three strings.
  const registered = KINDS.map(({ key }) => {
    const file = key === 'ctx' ? 'context' : key;
    const mod = fs.readFileSync(path.join(REPO, 'renderer', 'popovers', `${file}-popover.js`), 'utf8');
    assert.match(mod, new RegExp(`barPopovers\\.register\\('${key}'`),
      `${file}-popover.js does not join the group, so nothing closes it`);
    assert.match(mod, /^\s*closeSiblings\(\);$/m,
      `${file}-popover.js registers but never calls closeSiblings`);
    return key;
  });
  assert.strictEqual(registered.length, dispatched.length,
    'a bar popover exists that is not a group member');
});
