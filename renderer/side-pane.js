'use strict';

const { createFileTab } = require('./file-tab');
const {
  emptyTabSet, fileTabId, saveArgs, shouldKeepBuffer, reduceTabs, stripState,
} = require('./lib/side-pane-tabs');

function createSidePane({ dock, popoverApi, showToast, getActiveSession, getFiles, focusTerminal, doc = document, win = window }) {
  const pane = doc.getElementById('side-pane');
  const strip = doc.getElementById('side-pane-tabs');
  const seatEl = doc.getElementById('side-pane-seat');
  const closeBtn = doc.getElementById('side-pane-close');
  const host = doc.getElementById('side-pane-body');
  const isWeb = !!win.__CLODEX_WEB__;

  const sets = new Map();
  const views = new Map();
  const seenTs = new Map();
  let shownSeat = null;
  const listeners = [];

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
    return !!shownSeat && setOf(shownSeat).open && dock.onScreen();
  }

  function isVisible(seat, id) {
    return seat === shownSeat && paneVisible() && setOf(seat).active === id;
  }

  function renderChrome() {
    dock.setShown('files', !!shownSeat && setOf(shownSeat).open);
    for (const fn of listeners) fn();
    if (!shownSeat) { strip.replaceChildren(); strip.dataset.count = '0'; return; }
    const set = setOf(shownSeat);
    const view = stripState(set);
    strip.dataset.count = String(view.count);
    seatEl.textContent = shownSeat;
    seatEl.hidden = shownSeat === getActiveSession();
    const nodes = set.tabs.map((t, i) => {
      const tabEl = doc.createElement('div');
      tabEl.className = `side-tab${t.id === set.active ? ' active' : ''}`;
      tabEl.dataset.id = t.id;
      tabEl.title = t.path;
      const title = doc.createElement('span');
      title.className = 'side-tab-title';
      title.textContent = view.tabs[i].title;
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
    open(seat, { kind: 'file', path: res.path }, { line, view: 'file' });
  }

  function open(seat, target, { line = null, pushedBy = null, view = null } = {}) {
    const id = fileTabId(seat, target.path);
    const existed = !!tabOf(seat, id);
    shownSeat = seat;
    const { effect } = dispatch(seat, { type: 'open', id, kind: 'file', path: target.path, line, pushedBy });
    if (!existed) makeView(seat, id, target.path);
    const tab = tabOf(seat, id);
    if (existed && view && tab && !(tab.view === 'edit' && tab.dirty)) {
      const v = views.get(viewKey(seat, id));
      if (view !== 'edit' || (v && v.canEdit())) dispatch(seat, { type: 'view', id, view });
    }
    showTab(seat, id, effect, { forceView: view });
  }

  function showTab(seat, id, effect, extra) {
    dock.reveal();
    runEffect(seat, id, effect, extra);
  }

  const hasTabs = (seat) => setOf(seat).tabs.length > 0;
  const isOpen = (seat) => !!seat && seat === shownSeat && setOf(seat).open;

  function toggle(seat) {
    if (!seat) return;
    if (isOpen(seat)) {
      dispatch(seat, { type: 'closePane' });
      renderChrome();
      return;
    }
    if (!hasTabs(seat)) return;
    shownSeat = seat;
    const { set, effect } = dispatch(seat, { type: 'openPane' });
    showTab(seat, set.active, effect);
  }

  function onChange(fn) {
    listeners.push(fn);
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
  closeBtn.addEventListener('click', () => {
    if (!shownSeat) return;
    dispatch(shownSeat, { type: 'closePane' });
    renderChrome();
  });

  dock.addPane('files', pane, 0);
  renderChrome();

  return { open, showSeat, forgetSeat, noteFiles, noteToolRecord, toggle, hasTabs, isOpen, onChange };
}

function bindFilesToggle({ button, sidePane, getActiveSession }) {
  const badge = button.querySelector('.footer-badge');
  function refresh() {
    const seat = getActiveSession();
    const has = !!seat && sidePane.hasTabs(seat);
    const on = has && sidePane.isOpen(seat);
    button.hidden = !has;
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.classList.toggle('footer-on', on);
    badge.textContent = on ? '✓' : '';
    badge.classList.toggle('zero', !on);
  }
  button.addEventListener('click', () => sidePane.toggle(getActiveSession()));
  sidePane.onChange(refresh);
  refresh();
  return { refresh };
}

module.exports = { createSidePane, bindFilesToggle };
