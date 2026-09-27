'use strict';

const { clampPx } = require('./split');

const SIDE_PANE_MAX_TABS = 12;
const SIDE_PANE_MIN_PX = 320;
const SIDE_PANE_DEFAULT_FRACTION = 0.4;
const SIDE_PANE_MAX_FRACTION = 0.6;
const SIDE_PANE_MIN_WINDOW_PX = 700;
const SIDE_PANE_REFIT_THROTTLE_MS = 150;
const MISSING_CODES = new Set(['not-found', 'gone']);

function emptyTabSet() {
  return { tabs: [], active: null, open: false, clock: 0 };
}

function fileTabId(seat, filePath) {
  return `file:${seat}:${filePath}`;
}

function sidePaneFits(windowPx) {
  return windowPx >= SIDE_PANE_MIN_WINDOW_PX;
}

function clampSidePaneWidth(px, windowPx) {
  return clampPx(px, { min: SIDE_PANE_MIN_PX, maxFraction: SIDE_PANE_MAX_FRACTION, defaultFraction: SIDE_PANE_DEFAULT_FRACTION, containerPx: windowPx });
}

function peekEditable(editable, peekRes) {
  return !!(editable && peekRes && peekRes.ok && !peekRes.binary && !peekRes.truncated);
}

function shouldKeepBuffer(tab) {
  return !!(tab && tab.dirty);
}

function saveArgs(seat, tab, text) {
  return [seat, tab.path, text, tab.mtime];
}

function isMissing(peekRes) {
  return !!(peekRes && !peekRes.ok && MISSING_CODES.has(peekRes.code));
}

function patchTab(set, id, patch) {
  return { ...set, tabs: set.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

function evictOverCap(set) {
  let tabs = set.tabs;
  while (tabs.length > SIDE_PANE_MAX_TABS) {
    let victim = null;
    for (const t of tabs) {
      if (t.dirty || t.id === set.active) continue;
      if (!victim || t.used < victim.used) victim = t;
    }
    if (!victim) break;
    tabs = tabs.filter((t) => t !== victim);
  }
  return { ...set, tabs };
}

function stripState(set) {
  return {
    count: set.tabs.length,
    activeId: set.active,
    tabs: set.tabs.map((t) => ({
      id: t.id, title: (t.path.split('/').pop() || t.path) + (t.deleted ? ' (deleted)' : ''), dirty: !!t.dirty,
    })),
  };
}

function openTab(set, a) {
  const clock = set.clock + 1;
  const existing = set.tabs.find((t) => t.id === a.id);
  if (existing) {
    const wasShowing = set.open && set.active === a.id;
    const next = patchTab({ ...set, open: true, active: a.id, clock }, a.id, {
      used: clock, line: a.line != null ? a.line : existing.line, stale: false,
    });
    return { set: next, effect: existing.stale ? 'reload' : (wasShowing ? 'show' : 'revalidate') };
  }
  const tab = {
    id: a.id, kind: a.kind || 'file', path: a.path, preview: false,
    view: a.view || null, line: a.line != null ? a.line : null, pushedBy: a.pushedBy || null,
    dirty: false, stale: false, banner: false, deleted: false, mtime: null, used: clock,
  };
  const tabs = set.tabs.concat(tab);
  return { set: evictOverCap({ ...set, tabs, open: true, active: tab.id, clock }), effect: 'fetch' };
}

function closeTab(set, a) {
  const at = set.tabs.findIndex((t) => t.id === a.id);
  if (at < 0) return { set, effect: null };
  if (set.tabs[at].dirty && !a.force) return { set, effect: 'confirm' };
  const tabs = set.tabs.filter((t) => t.id !== a.id);
  if (!tabs.length) return { set: { ...set, tabs, active: null, open: false }, effect: null };
  if (set.active !== a.id) return { set: { ...set, tabs }, effect: null };
  const next = tabs[Math.min(at, tabs.length - 1)];
  const clock = set.clock + 1;
  return {
    set: patchTab({ ...set, tabs, active: next.id, clock }, next.id, { used: clock, stale: false }),
    effect: next.stale ? 'reload' : 'revalidate',
  };
}

function agentChanged(set, a) {
  const tab = set.tabs.find((t) => t.id === a.id);
  if (!tab) return { set, effect: null };
  if (tab.dirty) return { set: patchTab(set, a.id, { banner: true }), effect: 'banner' };
  if (a.visible) return { set, effect: 'reload' };
  return { set: patchTab(set, a.id, { stale: true }), effect: null };
}

function loaded(set, a) {
  const tab = set.tabs.find((t) => t.id === a.id);
  if (!tab) return { set, effect: null };
  if (isMissing(a.peek)) {
    return { set: patchTab(set, a.id, { deleted: true, stale: false }), effect: tab.deleted ? null : 'render' };
  }
  const mtime = a.peek && a.peek.ok ? a.peek.mtime : null;
  if (tab.dirty) {
    if (mtime != null && mtime !== tab.mtime) return { set: patchTab(set, a.id, { banner: true, deleted: false }), effect: 'banner' };
    return { set: patchTab(set, a.id, { deleted: false }), effect: null };
  }
  if (!a.force && tab.mtime != null && mtime === tab.mtime && !tab.deleted && !tab.stale) return { set, effect: null };
  return { set: patchTab(set, a.id, { mtime, deleted: false, stale: false, banner: false }), effect: 'render' };
}

function reduceTabs(set, a) {
  switch (a.type) {
    case 'open': return openTab(set, a);
    case 'close': return closeTab(set, a);
    case 'focus': {
      const tab = set.tabs.find((t) => t.id === a.id);
      if (!tab) return { set, effect: null };
      const clock = set.clock + 1;
      return {
        set: patchTab({ ...set, active: a.id, open: true, clock }, a.id, { used: clock, stale: false }),
        effect: tab.stale ? 'reload' : 'revalidate',
      };
    }
    case 'view': return { set: patchTab(set, a.id, { view: a.view }), effect: null };
    case 'dirty': return { set: patchTab(set, a.id, { dirty: !!a.dirty }), effect: null };
    case 'closePane': return { set: { ...set, open: false }, effect: null };
    case 'openPane': return set.tabs.length ? { set: { ...set, open: true }, effect: 'revalidate' } : { set, effect: null };
    case 'changed': return agentChanged(set, a);
    case 'loaded': return loaded(set, a);
    case 'saved': return { set: patchTab(set, a.id, { mtime: a.mtime, dirty: false, banner: false, deleted: false }), effect: null };
    case 'discard': return { set: patchTab(set, a.id, { dirty: false, banner: false }), effect: 'reload' };
    case 'keep': return { set: patchTab(set, a.id, { banner: false }), effect: null };
    default: return { set, effect: null };
  }
}

module.exports = {
  SIDE_PANE_MAX_TABS,
  SIDE_PANE_MIN_PX,
  SIDE_PANE_MIN_WINDOW_PX,
  SIDE_PANE_REFIT_THROTTLE_MS,
  emptyTabSet,
  fileTabId,
  sidePaneFits,
  clampSidePaneWidth,
  peekEditable,
  saveArgs,
  shouldKeepBuffer,
  isMissing,
  reduceTabs,
  stripState,
};
