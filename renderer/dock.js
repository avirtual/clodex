'use strict';

const { SIDE_PANE_REFIT_THROTTLE_MS, sidePaneFits, clampSidePaneWidth } = require('./lib/side-pane-tabs');
const { clampFraction, DOCK_SPLIT_MIN, DOCK_SPLIT_MAX } = require('./lib/split');
const { attachSplitter } = require('./splitter');

const DOCK_SPLIT_FALLBACK = 0.5;

function createDock({ showToast, getSettings, setSettings, loadView, saveView, doc = document, win = window, now = () => Date.now() }) {
  const dock = doc.getElementById('dock');
  const handle = doc.getElementById('dock-handle');
  const split = doc.getElementById('dock-split');
  const isWeb = !!win.__CLODEX_WEB__;

  const panes = new Map();
  let shown = [];
  const front = () => shown[shown.length - 1] || null;
  let added = 0;
  let storedWidth = null;
  let storedSplit = null;
  let intents = {};
  let viewLoaded = false;
  const viewWaiters = [];

  function onScreen() {
    return shown.length > 0 && (isWeb || sidePaneFits(win.innerWidth));
  }

  function applyWidth() {
    dock.style.width = `${clampSidePaneWidth(storedWidth, win.innerWidth)}px`;
  }

  const splitFraction = (f) => clampFraction(f, { min: DOCK_SPLIT_MIN, max: DOCK_SPLIT_MAX, fallback: DOCK_SPLIT_FALLBACK });
  let splitUp = false;

  function applySplit() {
    const f = splitFraction(storedSplit);
    const others = shown.filter((id) => id !== 'files');
    for (const [id, p] of panes) {
      if (!splitUp) p.el.style.flex = '';
      else if (id === 'files') p.el.style.flex = `${f} 1 0px`;
      else p.el.style.flex = others.includes(id) ? `${(1 - f) / others.length} 1 0px` : '';
    }
  }

  function render() {
    const up = onScreen();
    const sheet = up && isWeb && !sidePaneFits(win.innerWidth);
    dock.classList.toggle('dock-closed', !up);
    dock.classList.toggle('dock-sheet', sheet);
    handle.classList.toggle('dock-closed', !up || sheet);
    const top = front();
    for (const [id, p] of panes) p.el.classList.toggle('dock-pane-hidden', sheet ? id !== top : !shown.includes(id));
    splitUp = up && !sheet && shown.length >= 2 && shown.includes('files');
    if (split) split.classList.toggle('dock-closed', !splitUp);
    const sorted = [...panes.entries()].sort(([, a], [, b]) => (a.order - b.order) || (a.added - b.added));
    const filesAt = sorted.findIndex(([id]) => id === 'files');
    const first = splitUp ? sorted.slice(filesAt + 1).find(([id]) => shown.includes(id)) : null;
    for (const [id, p] of panes) p.el.classList.toggle('dock-pane-first', !!first && first[0] === id);
    applySplit();
  }

  function placeSplit() {
    const files = panes.get('files');
    if (!split || !files) return;
    const sorted = [...panes.values()].sort((a, b) => (a.order - b.order) || (a.added - b.added));
    const next = sorted[sorted.indexOf(files) + 1];
    dock.insertBefore(split, next ? next.el : null);
  }

  function addPane(id, el, order = 0) {
    if (panes.has(id)) removePane(id);
    el.classList.add('dock-pane');
    el.dataset.pane = id;
    const entry = { el, order, added: added++ };
    panes.set(id, entry);
    const sorted = [...panes.values()].sort((a, b) => (a.order - b.order) || (a.added - b.added));
    const i = sorted.indexOf(entry);
    dock.insertBefore(el, i + 1 < sorted.length ? sorted[i + 1].el : null);
    placeSplit();
    render();
  }

  function removePane(id) {
    const p = panes.get(id);
    if (!p) return;
    panes.delete(id);
    shown = shown.filter((s) => s !== id);
    p.el.remove();
    render();
  }

  function setShown(id, on) {
    if (!panes.has(id)) return;
    const was = shown.includes(id);
    if (on && !was) shown.push(id);
    if (!on && was) shown = shown.filter((s) => s !== id);
    render();
  }

  function reveal() {
    applyWidth();
    if (!isWeb && !sidePaneFits(win.innerWidth)) {
      showToast('Widen the window to see the side pane', { kind: 'warn', duration: 4000 });
    }
  }

  const isShown = (id) => shown.includes(id);

  function intent(id) {
    return intents[id] === true;
  }

  function setIntent(id, on) {
    intents = { ...intents, [id]: !!on };
    if (typeof saveView !== 'function') return;
    onViewLoaded(() => {
      Promise.resolve()
        .then(() => saveView({ panes: { ...intents } }))
        .catch(() => {});
    });
  }

  function onViewLoaded(fn) {
    if (viewLoaded) fn();
    else viewWaiters.push(fn);
  }

  attachSplitter(handle, {
    edge: 'left',
    rect: () => dock.getBoundingClientRect(),
    clamp: (px) => clampSidePaneWidth(px, win.innerWidth),
    apply: (px) => { storedWidth = px; applyWidth(); },
    commit: (px) => { try { setSettings({ sidePaneWidth: px }); } catch {} },
    reset: () => {
      storedWidth = null;
      applyWidth();
      try { setSettings({ sidePaneWidth: null }); } catch {}
    },
    throttleMs: SIDE_PANE_REFIT_THROTTLE_MS,
    dragClass: 'dock-dragging',
    doc, win, now,
  });
  if (split) {
    attachSplitter(split, {
      edge: 'bottom',
      rect: () => (panes.get('files') || { el: dock }).el.getBoundingClientRect(),
      clamp: (px) => splitFraction(px / dock.getBoundingClientRect().height),
      apply: (f) => { storedSplit = f; applySplit(); },
      commit: (f) => { try { setSettings({ dockSplit: f }); } catch {} },
      reset: () => {
        storedSplit = null;
        applySplit();
        try { setSettings({ dockSplit: null }); } catch {}
      },
      throttleMs: 0,
      dragClass: 'dock-split-dragging',
      doc, win, now,
    });
  }
  win.addEventListener('resize', () => { applyWidth(); render(); });

  Promise.resolve()
    .then(() => getSettings())
    .then((s) => {
      if (s && typeof s.sidePaneWidth === 'number') storedWidth = s.sidePaneWidth;
      if (s && typeof s.dockSplit === 'number') storedSplit = s.dockSplit;
      applyWidth();
      applySplit();
    })
    .catch(() => {});
  Promise.resolve()
    .then(() => (typeof loadView === 'function' ? loadView() : null))
    .then((v) => {
      const saved = v && v.panes && typeof v.panes === 'object' ? v.panes : {};
      const kept = {};
      for (const [k, on] of Object.entries(saved)) if (on === true) kept[k] = true;
      intents = { ...kept, ...intents };
    })
    .catch(() => {})
    .then(() => {
      viewLoaded = true;
      for (const fn of viewWaiters.splice(0)) {
        try { fn(); } catch {}
      }
    });
  applyWidth();
  render();

  return { addPane, removePane, setShown, isShown, onScreen, front, reveal, intent, setIntent, onViewLoaded };
}

module.exports = { createDock };
