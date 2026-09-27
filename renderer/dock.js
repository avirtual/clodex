'use strict';

const { SIDE_PANE_REFIT_THROTTLE_MS, sidePaneFits, clampSidePaneWidth } = require('./lib/side-pane-tabs');

function createDock({ showToast, getSettings, setSettings, loadView, saveView, doc = document, win = window }) {
  const dock = doc.getElementById('dock');
  const handle = doc.getElementById('dock-handle');
  const isWeb = !!win.__CLODEX_WEB__;

  const panes = new Map();
  let shown = [];
  const front = () => shown[shown.length - 1] || null;
  let added = 0;
  let storedWidth = null;
  let intents = {};
  let viewLoaded = false;
  const viewWaiters = [];

  function onScreen() {
    return shown.length > 0 && (isWeb || sidePaneFits(win.innerWidth));
  }

  function applyWidth() {
    dock.style.width = `${clampSidePaneWidth(storedWidth, win.innerWidth)}px`;
  }

  function render() {
    const up = onScreen();
    const sheet = up && isWeb && !sidePaneFits(win.innerWidth);
    dock.classList.toggle('dock-closed', !up);
    dock.classList.toggle('dock-sheet', sheet);
    handle.classList.toggle('dock-closed', !up || sheet);
    const top = front();
    for (const [id, p] of panes) p.el.classList.toggle('dock-pane-hidden', sheet ? id !== top : !shown.includes(id));
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
    Promise.resolve()
      .then(() => saveView({ panes: { ...intents } }))
      .catch(() => {});
  }

  function onViewLoaded(fn) {
    if (viewLoaded) fn();
    else viewWaiters.push(fn);
  }

  let dragging = false;
  let pendingPx = null;
  let lastApply = 0;
  let timer = null;
  function flushDrag() {
    timer = null;
    if (pendingPx == null) return;
    storedWidth = pendingPx;
    lastApply = Date.now();
    applyWidth();
  }
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    doc.body.classList.add('dock-dragging');
  });
  win.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const right = dock.getBoundingClientRect().right;
    pendingPx = clampSidePaneWidth(right - e.clientX, win.innerWidth);
    const wait = SIDE_PANE_REFIT_THROTTLE_MS - (Date.now() - lastApply);
    if (wait <= 0) flushDrag();
    else if (!timer) timer = setTimeout(flushDrag, wait);
  });
  win.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    doc.body.classList.remove('dock-dragging');
    if (timer) { clearTimeout(timer); timer = null; }
    flushDrag();
    pendingPx = null;
    try { setSettings({ sidePaneWidth: storedWidth }); } catch {}
  });
  win.addEventListener('resize', () => { applyWidth(); render(); });

  Promise.resolve()
    .then(() => getSettings())
    .then((s) => {
      if (s && typeof s.sidePaneWidth === 'number') storedWidth = s.sidePaneWidth;
      applyWidth();
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
