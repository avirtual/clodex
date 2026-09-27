'use strict';

const { SIDE_PANE_REFIT_THROTTLE_MS, sidePaneFits, clampSidePaneWidth } = require('./lib/side-pane-tabs');

function createDock({ showToast, getSettings, setSettings, doc = document, win = window }) {
  const dock = doc.getElementById('dock');
  const handle = doc.getElementById('dock-handle');
  const isWeb = !!win.__CLODEX_WEB__;

  const panes = new Map();
  let shown = [];
  let added = 0;
  let storedWidth = null;

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
    for (const [id, p] of panes) p.el.classList.toggle('dock-pane-hidden', !shown.includes(id));
  }

  function addPane(id, el, order = 0) {
    if (panes.has(id)) removePane(id);
    el.classList.add('dock-pane');
    el.dataset.pane = id;
    panes.set(id, { el, order, added: added++ });
    const sorted = [...panes.values()].sort((a, b) => (a.order - b.order) || (a.added - b.added));
    for (const p of sorted) dock.appendChild(p.el);
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
  const front = () => shown[shown.length - 1] || null;

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
  applyWidth();
  render();

  return { addPane, removePane, setShown, isShown, onScreen, front, reveal };
}

module.exports = { createDock };
