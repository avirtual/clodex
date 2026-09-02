'use strict';

// popover-detached-anchor.test.js — a bar popover must not open OFF-SCREEN when
// the button it anchors to has been detached (t639).
//
// THE TRAP THIS SUITE EXISTS TO AVOID. When the bug fires the popover is NOT
// `hidden`: the class comes off, the state says open, and only the geometry is
// wrong (`bottom: innerHeight + 6` puts it fully above the viewport top; the
// operator's symptom is "three clicks to open" — off-screen open, toggle close,
// real open). So every assertion below is on COMPUTED GEOMETRY. A
// visibility-by-class assertion passes against the broken code and pins nothing.
//
// `renderSessionActions` rebuilds `#proxy-actions` by innerHTML on every proxy
// and ctx event, which detaches the clicked button; a detached node's rect is
// all zeros. Two doors reach that zero rect: an anchor captured when a menu
// opened and used when the operator PICKS from it seconds later, and an anchor
// that goes stale across a popover's own `await`.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  isDetachedRect, barPlacement, liveAnchor,
} = require('../renderer/lib/popover-place');

const REPO = path.join(__dirname, '..');
const VIEWPORT = { width: 1400, height: 900 };

// The bar sits at the bottom of the window, so a real anchor's rect is a short
// box near `height`. Its placement is the baseline every off-screen check is
// measured against.
const LIVE_RECT = { left: 300, top: 860, width: 90, height: 24 };
const ZERO_RECT = { left: 0, top: 0, width: 0, height: 0 };
const POPOVER = { width: 420, height: 300 };

// A placement is on-screen when the popover's whole box is inside the viewport.
// `bottom` is the CSS distance from the viewport's bottom edge, so the top edge
// is at `height - bottom - popoverHeight`.
function onScreen(p, size, viewport) {
  const top = viewport.height - p.bottom - size.height;
  return top >= 0 && p.bottom >= 0
    && p.left >= 0 && p.left + size.width <= viewport.width;
}

test('a detached anchor places the popover on-screen, not above the viewport top', () => {
  const broken = Math.max(8, VIEWPORT.height - ZERO_RECT.top + 6);
  assert.strictEqual(broken, 906,
    'ENTER: the unfixed formula on a zero rect really does exceed the viewport height');

  const p = barPlacement(ZERO_RECT, POPOVER, VIEWPORT);
  assert.strictEqual(p.detached, true, 'the all-zero rect is recognised as a gone anchor');
  assert.ok(onScreen(p, POPOVER, VIEWPORT),
    `detached anchor placed off-screen: ${JSON.stringify(p)}`);
  assert.ok(p.bottom < broken,
    'the fallback must not reproduce the innerHeight+6 placement it replaces');
});

test('a live bar anchor still opens just above its button', () => {
  const p = barPlacement(LIVE_RECT, POPOVER, VIEWPORT);
  assert.strictEqual(p.detached, false);
  assert.deepStrictEqual(p, { left: 300, bottom: 46, detached: false },
    'a live anchor keeps the pre-existing above-the-button placement');
  assert.ok(onScreen(p, POPOVER, VIEWPORT));
});

test('a high anchor is clamped so the popover top stays on-screen', () => {
  // The clamp `openSkillsPopover` already had and its three siblings lacked: a
  // peer sidebar ROW anchor sits high enough that the unclamped bottom pushes
  // the popover past the viewport TOP — the same defect as the zero rect, with a
  // partly-visible symptom instead of an invisible one.
  const high = { left: 40, top: 100, width: 90, height: 24 };
  const unclamped = Math.max(8, VIEWPORT.height - high.top + 6);
  const p = barPlacement(high, POPOVER, VIEWPORT);
  assert.ok(unclamped > VIEWPORT.height - POPOVER.height,
    'ENTER: this anchor is high enough that the unclamped placement runs off the top');
  assert.ok(onScreen(p, POPOVER, VIEWPORT), `high anchor placed off-screen: ${JSON.stringify(p)}`);
});

test('a popover wider than the viewport is pinned to the margin, not pushed negative', () => {
  const wide = { width: VIEWPORT.width + 200, height: POPOVER.height };
  const p = barPlacement(LIVE_RECT, wide, VIEWPORT);
  assert.ok(p.left >= 0, `left went negative: ${p.left}`);
});

test('an all-zero rect is the detached signal; a real degenerate box is not', () => {
  assert.strictEqual(isDetachedRect(ZERO_RECT), true);
  assert.strictEqual(isDetachedRect(null), true, 'a missing rect is treated as gone');
  // A zero-SIZED element that is still laid out somewhere has a non-zero top,
  // so it keeps its own geometry rather than being thrown to the fallback.
  assert.strictEqual(isDetachedRect({ left: 0, top: 860, width: 0, height: 0 }), false);
});

// --- door A: the anchor resolved at PICK time --------------------------------

test('liveAnchor re-queries the bar when the captured button has been detached', () => {
  const live = { isConnected: true, id: 'live' };
  const stale = { isConnected: false, id: 'stale' };
  const prevDoc = global.document;
  global.document = { querySelector: (sel) => (sel === '#sel' ? live : null) };
  try {
    assert.strictEqual(liveAnchor(stale, '#sel'), live,
      'a detached capture is replaced by the node the selector finds');
    assert.strictEqual(liveAnchor(live, '#sel'), live,
      'a still-attached capture is used as-is — no needless re-query');
    // Nothing in the bar to re-query (the whole bar hidden for this session):
    // the stale node is still better than null, because barPlacement's zero-rect
    // fallback then does the work.
    global.document = { querySelector: () => null };
    assert.strictEqual(liveAnchor(stale, '#sel'), stale);
  } finally {
    global.document = prevDoc;
  }
});

test('the session menu hands onPick a live anchor, not the button it captured', () => {
  const { dom, restore } = installDom();
  try {
    const { initSessionMenus } = require('../renderer/popovers/session-menus');
    const menus = initSessionMenus({
      getActiveSession: () => 'seat-1',
      proxyState: new Map(),
      sessionList: dom.el(),
      createTerminal() {}, addSessionToSidebar() {}, switchSession() {},
    });

    const pressed = dom.barButton('session-menu', LIVE_RECT);
    const picks = [];
    menus.openSessionMenu(pressed, 'claude', (act, anchor) => picks.push([act, anchor]));

    // renderSessionActions between the open and the pick: the pressed button is
    // detached and a fresh one takes its place in the bar.
    pressed.isConnected = false;
    pressed.rect = ZERO_RECT;
    const replacement = dom.barButton('session-menu', LIVE_RECT);

    const menu = dom.lastAppended();
    assert.ok(menu, 'ENTER: the menu element reached document.body');
    const item = menu.children.find((c) => c.dataset.act === 'tools');
    assert.ok(item, 'ENTER: the Tools entry is in the menu that was built');
    menu.fire('click', item);

    assert.deepStrictEqual(picks.map((p) => p[0]), ['tools']);
    assert.strictEqual(picks[0][1], replacement,
      'onPick got the live bar button, not the detached one captured at open');

    const p = barPlacement(picks[0][1].getBoundingClientRect(), POPOVER, VIEWPORT);
    assert.ok(onScreen(p, POPOVER, VIEWPORT),
      'the popover the pick opens would land on-screen');
  } finally {
    restore();
  }
});

// --- the family: which files own a bar placement -----------------------------

// Anchoring above a bar button is `bottom: innerHeight - rect.top + 6`. Written
// inline it is the shape that acquires a zero-rect bug; the reconciled version
// lives in popover-place.js. This scans for the inline form and pins the
// survivors, so a fifth copy has to be justified here rather than appearing
// silently.
const RAW_PLACEMENT = /innerHeight - (?:r|rect)\.top/;

// path -> why an inline placement is still correct there.
const ALLOWED_RAW = {
  'renderer/popovers/cost-popover.js':
    'reads the rect synchronously before its await; the anchor cannot detach first',
  'renderer/popovers/bust-popover.js':
    'same synchronous-before-await shape as cost',
  'renderer/popovers/files-popover.js':
    'captures the rect before the latch-clear repaint — the original fix for this bug',
  'renderer/popovers/voice-popover.js':
    'captures the rect before renderRows repaints the bar',
  'renderer/peers-ui.js':
    'anchored to sidebar peer rows, which no proxy-bar rebuild touches',
};

function scannedFiles() {
  const dirs = ['renderer', 'renderer/lib', 'renderer/popovers'];
  const out = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(REPO, d))) {
      if (f.endsWith('.js')) out.push(`${d}/${f}`);
    }
  }
  return out.sort();
}

test('every inline above-the-bar placement is one that cannot see a detached anchor', () => {
  const files = scannedFiles();
  // The reducer below is a filter over this scan, and a scan that collapses makes
  // the deepStrictEqual pass over an empty set — which is exactly the shape of a
  // popover family nobody is checking. Floor + ENTER first.
  assert.ok(files.length >= 30, `the renderer scan collapsed to ${files.length} files`);
  for (const must of [
    'renderer/popovers/checklist-popovers.js',
    'renderer/popovers/context-popover.js',
    'renderer/popovers/session-menus.js',
    'renderer/popovers/cost-popover.js',
    'renderer/lib/popover-place.js',
    'renderer/peers-ui.js',
  ]) {
    assert.ok(files.includes(must), `ENTER: ${must} survived the directory scan`);
  }

  const raw = files.filter((f) => RAW_PLACEMENT.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
  assert.ok(raw.length >= 5,
    `the placement scan found ${raw.length} files — the pattern stopped matching, so the exemptions below assert nothing`);
  assert.deepStrictEqual(raw, Object.keys(ALLOWED_RAW).sort(),
    'a new inline above-the-bar placement: route it through placeAboveAnchor, or add it to ALLOWED_RAW with the reason it is safe');
});

// --- source shape: no rect read on a pre-await anchor ------------------------

// An opener that reads `anchor.getBoundingClientRect()` — or hands the anchor to
// a helper that does — AFTER awaiting is door B: the bar can rebuild during the
// fetch. Only a source-shape check can state this; no fixture can prove the
// absence.
const ANCHOR_PARAM = /^(anchor|anchorBtn|anchorEl|btn)$/;

function functionsIn(src) {
  const out = [];
  const re = /(async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0;
    let i = re.lastIndex - 1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    out.push({
      isAsync: !!m[1],
      name: m[2],
      params: m[3].split(',').map((s) => s.trim().split(/[=\s]/)[0]).filter(Boolean),
      body: src.slice(re.lastIndex, i),
    });
  }
  return out;
}

function staleRectReads(src, file) {
  const fns = functionsIn(src);
  // Helpers that rect their anchor argument: passing a stale anchor to one is the
  // same defect a step removed, which is precisely how context-popover held it.
  const placers = fns
    .filter((f) => f.params.some((p) => ANCHOR_PARAM.test(p)
      && new RegExp(`\\b${p}\\.getBoundingClientRect\\s*\\(`).test(f.body)))
    .map((f) => f.name);

  const found = [];
  for (const f of fns) {
    if (!f.isAsync) continue;
    const anchors = f.params.filter((p) => ANCHOR_PARAM.test(p));
    if (!anchors.length) continue;
    const at = f.body.search(/\bawait\b/);
    if (at < 0) continue;
    const after = f.body.slice(at);
    for (const p of anchors) {
      if (new RegExp(`\\b${p}\\.getBoundingClientRect\\s*\\(`).test(after)) {
        found.push(`${file}: ${f.name} reads ${p}.getBoundingClientRect() after an await`);
      }
      for (const placer of placers) {
        if (new RegExp(`\\b${placer}\\s*\\(\\s*${p}\\b`).test(after)) {
          found.push(`${file}: ${f.name} passes ${p} to ${placer}() after an await`);
        }
      }
      // placeAboveAnchor rects whatever it is given, so a post-await call is the
      // same door unless it also carries the selector that re-queries the live
      // node. This one is imported, so the local-placer scan above cannot see it.
      const shared = new RegExp(`placeAboveAnchor\\s*\\(([^)]*)\\)`, 'g');
      let call;
      while ((call = shared.exec(after))) {
        const args = call[1].split(',').map((a) => a.trim());
        if (args[1] === p && args.length < 3) {
          found.push(`${file}: ${f.name} places on ${p} after an await with no live re-query`);
        }
      }
    }
  }
  return found;
}

test('the scanner finds the shape it is looking for', () => {
  // The reducer is a regex walk over source, and a walk that matches nothing
  // reports an empty list — which is what a PASS looks like. Prove it fires by
  // running it against both doors as they were written before the fix.
  const doorA = `
    async function openThing(name, anchorBtn) {
      const res = await load(name);
      const r = anchorBtn.getBoundingClientRect();
      place(r, res);
    }`;
  const doorB = `
    function placeIt(anchor) { const r = anchor.getBoundingClientRect(); use(r); }
    async function openThing(name, anchor) {
      placeIt(anchor);
      const res = await load(name);
      placeIt(anchor);
    }`;
  const doorC = `
    async function openThing(name, anchorBtn) {
      const res = await load(name);
      placeAboveAnchor(pop, anchorBtn);
    }`;
  assert.strictEqual(staleRectReads(doorA, 'A').length, 1, 'door A (post-await rect read) is detected');
  assert.strictEqual(staleRectReads(doorB, 'B').length, 1, 'door B (post-await placer call) is detected');
  assert.strictEqual(staleRectReads(doorC, 'C').length, 1,
    'a post-await shared placement with no re-query selector is detected');
  const doorCFixed = doorC.replace('anchorBtn);', 'anchorBtn, BAR_ANCHOR);');
  assert.deepStrictEqual(staleRectReads(doorCFixed, 'C'), [],
    'the same call carrying the re-query selector is not flagged');
  // The immune shape — rect read BEFORE the await — must not be flagged, or the
  // gate above would just be "no popover may await".
  const immune = `
    async function openThing(name, anchor) {
      const r = anchor.getBoundingClientRect();
      place(r);
      const res = await load(name);
      render(res);
    }`;
  assert.deepStrictEqual(staleRectReads(immune, 'I'), []);
});

test('no popover opener rects an anchor it received before an await', () => {
  const files = scannedFiles();
  assert.ok(files.length >= 30, `the renderer scan collapsed to ${files.length} files`);
  const found = files.flatMap((f) => staleRectReads(fs.readFileSync(path.join(REPO, f), 'utf8'), f));
  assert.deepStrictEqual(found, [],
    'resolve the anchor after the await (liveAnchor) instead of trusting the captured one');
});

// --- the smallest DOM the menu island runs against ---------------------------

function installDom() {
  const appended = [];
  const bar = new Map();

  const mkEl = (rect = LIVE_RECT) => {
    const listeners = new Map();
    const el = {
      dataset: {},
      style: {},
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      children: [],
      isConnected: true,
      rect,
      offsetWidth: POPOVER.width,
      offsetHeight: POPOVER.height,
      getBoundingClientRect() { return this.rect; },
      set innerHTML(html) {
        this.children = [...html.matchAll(/data-act="([^"]+)"/g)]
          .map((m) => ({ dataset: { act: m[1] }, closest: (sel) => (sel === '.session-item' ? el.children.find((c) => c.dataset.act === m[1]) : null) }));
      },
      get innerHTML() { return ''; },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      remove() { this.isConnected = false; },
      querySelector: () => null,
      contains: () => false,
      appendChild(child) { this.children.push(child); },
      fire(type, target) {
        const ev = { type, target: { closest: (sel) => (sel === '.session-item' ? target : null) } };
        for (const fn of listeners.get(type) || []) fn(ev);
      },
    };
    return el;
  };

  const prev = { document: global.document, window: global.window };
  global.document = {
    createElement: () => mkEl(),
    addEventListener() {},
    body: { appendChild: (el) => appended.push(el) },
    querySelector: (sel) => {
      const m = sel.match(/data-act="([^"]+)"/);
      return (m && bar.get(m[1])) || null;
    },
  };
  global.window = { innerWidth: VIEWPORT.width, innerHeight: VIEWPORT.height, api: {} };

  return {
    dom: {
      el: mkEl,
      barButton(act, rect) {
        const el = mkEl(rect);
        el.dataset.act = act;
        bar.set(act, el);
        return el;
      },
      lastAppended: () => appended[appended.length - 1],
    },
    restore() {
      global.document = prev.document;
      global.window = prev.window;
    },
  };
}
