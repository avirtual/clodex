'use strict';

const { createFileTab } = require('./file-tab');
const {
  SIDE_PANE_REFIT_THROTTLE_MS, emptyTabSet, fileTabId, sidePaneFits, clampSidePaneWidth,
  saveArgs, shouldKeepBuffer, reduceTabs,
} = require('./lib/side-pane-tabs');

function createSidePane({ popoverApi, showToast, getActiveSession, getFiles, focusTerminal, doc = document, win = window }) {
  const pane = doc.getElementById('side-pane');
  const handle = doc.getElementById('side-pane-handle');
  const strip = doc.getElementById('side-pane-tabs');
  const seatEl = doc.getElementById('side-pane-seat');
  const pinBtn = doc.getElementById('side-pane-pin');
  const closeBtn = doc.getElementById('side-pane-close');
  const host = doc.getElementById('side-pane-body');
  const isWeb = !!win.__CLODEX_WEB__;

  const sets = new Map();
  const views = new Map();
  const seenTs = new Map();
  let shownSeat = null;
  let storedWidth = null;

  const setOf = (seat) => sets.get(seat) || emptyTabSet();
  const tabOf = (seat, id) => setOf(seat).tabs.find((t) => t.id === id) || null;
  const viewKey = (seat, id) => `${seat}\u0000${id}`;

  function dispatch(seat, action) {
    const before = setOf(seat);
    const { set, effect } = reduceTabs(before, action);
    sets.set(seat, set);
    const alive = new Set(set.tabs.map((t) => t.id));
    for (const t of before.tabs) {
      if (alive.has(t.id)) continue;
      const k = viewKey(seat, t.id);
      const v = views.get(k);
      if (v) v.el.remove();
      views.delete(k);
      seenTs.delete(k);
    }
    return { set, effect };
  }

  function paneVisible() {
    return !!shownSeat && setOf(shownSeat).open && (isWeb || sidePaneFits(win.innerWidth));
  }

  function isVisible(seat, id) {
    return seat === shownSeat && paneVisible() && setOf(seat).active === id;
  }

  function applyWidth() {
    pane.style.width = `${clampSidePaneWidth(storedWidth, win.innerWidth)}px`;
  }

  function renderChrome() {
    const shown = paneVisible();
    const sheet = shown && isWeb && !sidePaneFits(win.innerWidth);
    pane.classList.toggle('side-pane-closed', !shown);
    pane.classList.toggle('side-pane-sheet', sheet);
    handle.classList.toggle('side-pane-closed', !shown || sheet);
    if (!shownSeat) { strip.replaceChildren(); return; }
    const set = setOf(shownSeat);
    const active = set.tabs.find((t) => t.id === set.active) || null;
    seatEl.textContent = shownSeat;
    seatEl.hidden = shownSeat === getActiveSession();
    pinBtn.disabled = !active || !active.preview;
    const nodes = set.tabs.map((t) => {
      const tabEl = doc.createElement('div');
      tabEl.className = `side-tab${t.id === set.active ? ' active' : ''}${t.preview ? ' preview' : ''}`;
      tabEl.dataset.id = t.id;
      tabEl.title = t.path;
      const title = doc.createElement('span');
      title.className = 'side-tab-title';
      title.textContent = (t.path.split('/').pop() || t.path) + (t.deleted ? ' (deleted)' : '');
      tabEl.appendChild(title);
      if (t.stale) {
        const dot = doc.createElement('span');
        dot.className = 'side-tab-stale';
        dot.title = 'Changed by the agent since you looked';
        tabEl.appendChild(dot);
      }
      if (t.dirty) {
        const dot = doc.createElement('span');
        dot.className = 'file-peek-dirty';
        dot.textContent = '•';
        dot.title = 'Unsaved changes';
        tabEl.appendChild(dot);
      }
      const x = doc.createElement('button');
      x.type = 'button';
      x.className = 'side-tab-close';
      x.textContent = '×';
      x.title = 'Close tab';
      x.setAttribute('aria-label', 'Close tab');
      tabEl.appendChild(x);
      return tabEl;
    });
    strip.replaceChildren(...nodes);
    for (const [k, v] of views) {
      const [seat, id] = k.split('\u0000');
      v.el.classList.toggle('side-tab-inactive', !(seat === shownSeat && id === set.active));
    }
  }

  function renderTab(seat, id, opts) {
    const tab = tabOf(seat, id);
    const v = views.get(viewKey(seat, id));
    if (tab && v) v.render(tab, opts);
  }

  async function fetchTab(seat, id, { force = false, forceView = null } = {}) {
    const k = viewKey(seat, id);
    const v = views.get(k);
    const tab = tabOf(seat, id);
    if (!v || !tab) return;
    const gen = (v.gen || 0) + 1;
    v.gen = gen;
    const api = popoverApi(seat);
    const [diffRes, peekRes] = await Promise.all([
      api.diff(tab.path).catch((e) => ({ ok: false, error: String(e) })),
      api.peek(tab.path).catch((e) => ({ ok: false, error: String(e) })),
    ]);
    if (views.get(k) !== v || v.gen !== gen) return;
    const first = tab.mtime == null && !tab.deleted;
    const anchor = !first && isVisible(seat, id) ? v.anchorLine() : null;
    const { effect } = dispatch(seat, { type: 'loaded', id, peek: peekRes, force });
    if (effect === 'render') {
      v.setData(peekRes, diffRes, { keepBuffer: shouldKeepBuffer(tabOf(seat, id)) });
      if (first || !tabOf(seat, id).view) {
        dispatch(seat, { type: 'view', id, view: v.defaultView(forceView || tabOf(seat, id).view) });
      }
      renderTab(seat, id, { anchor: first ? null : anchor });
    } else if (effect === 'banner') {
      v.showBanner(seat, new Date());
      renderTab(seat, id);
    }
    renderChrome();
  }

  function runEffect(seat, id, effect, extra = {}) {
    if (effect === 'fetch' || effect === 'revalidate') fetchTab(seat, id, extra);
    else if (effect === 'reload') fetchTab(seat, id, { ...extra, force: true });
    else if (effect === 'banner') { const v = views.get(viewKey(seat, id)); if (v) v.showBanner(seat, new Date()); }
    renderTab(seat, id);
    renderChrome();
  }

  function recordSeen(seat, id, filePath) {
    const entry = (getFiles(seat) || []).find((f) => f.path === filePath);
    seenTs.set(viewKey(seat, id), entry ? entry.ts : null);
  }

  function makeView(seat, id, filePath) {
    const api = popoverApi(seat);
    const act = (action) => { const r = dispatch(seat, { ...action, id }); runEffect(seat, id, r.effect); };
    const v = createFileTab({
      doc,
      filePath,
      editable: !api.remote,
      showOpen: !(api.remote || isWeb),
      on: {
        view: (view) => act({ type: 'view', view }),
        dirty: (dirty) => { dispatch(seat, { type: 'dirty', id, dirty }); renderChrome(); },
        save: () => save(seat, id),
        open: () => win.api.fileOpen(filePath),
        escape: () => focusTerminal(),
        discard: () => act({ type: 'discard' }),
        keep: () => act({ type: 'keep' }),
        theirs: async () => {
          const fresh = await popoverApi(seat).diff(filePath).catch((e) => ({ ok: false, error: String(e) }));
          const cur = views.get(viewKey(seat, id));
          if (cur !== v) return;
          v.setDiff(fresh);
          act({ type: 'view', view: 'diff' });
        },
        follow: (p, line) => follow(seat, filePath, p, line),
      },
    });
    host.appendChild(v.el);
    views.set(viewKey(seat, id), v);
    recordSeen(seat, id, filePath);
    return v;
  }

  async function save(seat, id) {
    const tab = tabOf(seat, id);
    const v = views.get(viewKey(seat, id));
    if (!tab || !v || !v.canEdit()) return;
    const text = v.getText();
    v.gen = (v.gen || 0) + 1;
    v.setSaving(true);
    const res = await win.api.fileWrite(...saveArgs(seat, tab, text))
      .catch((e) => ({ ok: false, error: String(e) }));
    if (views.get(viewKey(seat, id)) !== v) return;
    if (!res || !res.ok) {
      v.setSaving(false);
      showToast(`Save failed: ${(res && res.error) || 'unknown'}`, { kind: 'error', duration: 10000 });
      return;
    }
    v.markSaved(text, res);
    dispatch(seat, { type: 'saved', id, mtime: res.mtime });
    renderTab(seat, id);
    renderChrome();
    const fresh = await popoverApi(seat).diff(tab.path).catch((e) => ({ ok: false, error: String(e) }));
    if (views.get(viewKey(seat, id)) !== v) return;
    v.setDiff(fresh);
    renderTab(seat, id);
  }

  async function follow(seat, fromPath, target, line) {
    const cut = fromPath.lastIndexOf('/');
    const baseDir = cut > 0 ? fromPath.slice(0, cut) : null;
    const res = await win.api.fileResolve(seat, target, baseDir)
      .catch((err) => ({ ok: false, error: String(err) }));
    if (!res || !res.ok) {
      showToast((res && res.error) || `Can't find "${target}"`, { kind: 'warn', duration: 4000 });
      return;
    }
    open(seat, { kind: 'file', path: res.path }, { preview: true, line, view: 'file' });
  }

  function open(seat, target, { preview = true, line = null, pushedBy = null, view = null } = {}) {
    const id = fileTabId(seat, target.path);
    const existed = !!tabOf(seat, id);
    shownSeat = seat;
    const { effect } = dispatch(seat, { type: 'open', id, kind: 'file', path: target.path, preview, line, pushedBy });
    if (!existed) makeView(seat, id, target.path);
    const tab = tabOf(seat, id);
    if (existed && view && tab && !(tab.view === 'edit' && tab.dirty)) {
      const v = views.get(viewKey(seat, id));
      if (view !== 'edit' || (v && v.canEdit())) dispatch(seat, { type: 'view', id, view });
    }
    applyWidth();
    if (!isWeb && !sidePaneFits(win.innerWidth)) {
      showToast('Widen the window to see the side pane', { kind: 'warn', duration: 4000 });
    }
    runEffect(seat, id, effect, { forceView: view });
  }

  function showSeat(seat) {
    shownSeat = seat || null;
    const set = seat ? setOf(seat) : null;
    renderChrome();
    if (set && set.open && set.active) fetchTab(seat, set.active);
  }

  function forgetSeat(seat) {
    const set = setOf(seat);
    if (set.tabs.some((t) => t.dirty)) {
      if (shownSeat === seat) shownSeat = null;
      renderChrome();
      return;
    }
    for (const t of set.tabs) {
      const k = viewKey(seat, t.id);
      const v = views.get(k);
      if (v) v.el.remove();
      views.delete(k);
      seenTs.delete(k);
    }
    sets.delete(seat);
    if (shownSeat === seat) shownSeat = null;
    renderChrome();
  }

  function noteFiles(seat, files) {
    for (const t of setOf(seat).tabs) {
      const k = viewKey(seat, t.id);
      const entry = (files || []).find((f) => f.path === t.path);
      if (!entry || entry.ts === seenTs.get(k)) continue;
      seenTs.set(k, entry.ts);
      const { effect } = dispatch(seat, { type: 'changed', id: t.id, visible: isVisible(seat, t.id) });
      if (effect) runEffect(seat, t.id, effect);
    }
    if (seat === shownSeat) renderChrome();
  }

  function noteToolRecord() {}

  strip.addEventListener('click', (e) => {
    const tabEl = e.target.closest('.side-tab');
    if (!tabEl || !shownSeat) return;
    const seat = shownSeat;
    const id = tabEl.dataset.id;
    if (e.target.closest('.side-tab-close')) {
      let r = dispatch(seat, { type: 'close', id });
      if (r.effect === 'confirm') {
        if (!win.confirm('Discard unsaved changes to this file?')) return;
        r = dispatch(seat, { type: 'close', id, force: true });
      }
      if (r.set.active) runEffect(seat, r.set.active, r.effect);
      else renderChrome();
      return;
    }
    const r = dispatch(seat, { type: 'focus', id });
    runEffect(seat, id, r.effect);
  });
  strip.addEventListener('dblclick', (e) => {
    const tabEl = e.target.closest('.side-tab');
    if (!tabEl || !shownSeat || e.target.closest('.side-tab-close')) return;
    dispatch(shownSeat, { type: 'pin', id: tabEl.dataset.id });
    renderChrome();
  });
  pinBtn.addEventListener('click', () => {
    if (!shownSeat) return;
    const set = setOf(shownSeat);
    if (set.active) dispatch(shownSeat, { type: 'pin', id: set.active });
    renderChrome();
  });
  closeBtn.addEventListener('click', () => {
    if (!shownSeat) return;
    dispatch(shownSeat, { type: 'closePane' });
    renderChrome();
  });

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
    doc.body.classList.add('side-pane-dragging');
  });
  win.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const right = pane.getBoundingClientRect().right;
    pendingPx = clampSidePaneWidth(right - e.clientX, win.innerWidth);
    const wait = SIDE_PANE_REFIT_THROTTLE_MS - (Date.now() - lastApply);
    if (wait <= 0) flushDrag();
    else if (!timer) timer = setTimeout(flushDrag, wait);
  });
  win.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    doc.body.classList.remove('side-pane-dragging');
    if (timer) { clearTimeout(timer); timer = null; }
    flushDrag();
    pendingPx = null;
    try { win.api.setSettings({ sidePaneWidth: storedWidth }); } catch {}
  });
  win.addEventListener('resize', () => { applyWidth(); renderChrome(); });

  Promise.resolve()
    .then(() => win.api.getSettings())
    .then((s) => {
      if (s && typeof s.sidePaneWidth === 'number') storedWidth = s.sidePaneWidth;
      applyWidth();
    })
    .catch(() => {});
  applyWidth();
  renderChrome();

  return { open, showSeat, forgetSeat, noteFiles, noteToolRecord };
}

module.exports = { createSidePane };
