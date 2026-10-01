const { test } = require('node:test');
const assert = require('node:assert');

const { createDrawerHost } = require('../renderer/drawer-host');

function el(tag = 'div') {
  const classes = new Set();
  const e = {
    tagName: tag,
    children: [],
    dataset: {},
    parentNode: null,
    title: '',
    disabled: false,
    _text: '',
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); for (const c of String(v).split(/\s+/)) if (c) classes.add(c); },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
    },
    listeners: new Map(),
    addEventListener(type, fn) { e.listeners.set(type, fn); },
    setAttribute() {},
    removeAttribute() {},
    appendChild(c) { e.children.push(c); c.parentNode = e; return c; },
    insertBefore(c) { e.children.push(c); c.parentNode = e; return c; },
    remove() { e.parentNode = null; },
    contains: () => false,
    closest: () => null,
    props: new Map(),
    style: {
      setProperty: (k, v) => e.props.set(k, v),
      removeProperty: (k) => e.props.delete(k),
    },
    clientHeight: 0,
    rect: { top: 0, right: 0, bottom: 0, left: 0 },
    getBoundingClientRect: () => e.rect,
    setPointerCapture() {},
    releasePointerCapture() {},
    get textContent() { return e._text; },
    set textContent(v) { e._text = String(v); e.children = []; },
  };
  return e;
}

function harness(fn, { storage = {}, mainHeight = 1000 } = {}) {
  const had = {
    d: global.document, w: global.window, ls: global.localStorage,
    ro: global.ResizeObserver, raf: global.requestAnimationFrame,
  };
  const byId = new Map();
  const frames = [];
  global.document = {
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, el('div'));
      return byId.get(id);
    },
    createElement: el,
    addEventListener() {},
    activeElement: null,
  };
  const body = el('body');
  global.document.body = body;
  const store = new Map(Object.entries(storage));
  const winListeners = new Map();
  const raf = (cb) => { frames.push(cb); return frames.length; };
  global.window = {
    api: { onRequestOpenIpcLog() {} },
    addEventListener(type, cb) { winListeners.set(type, cb); },
    requestAnimationFrame: raf,
    cancelAnimationFrame() {},
    setTimeout: (cb) => { frames.push(cb); return frames.length; },
    clearTimeout() {},
  };
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  global.ResizeObserver = class { observe() {} };
  global.requestAnimationFrame = raf;

  byId.set('drawer', el('div'));
  byId.get('drawer').classList.add('collapsed');
  byId.set('main', el('div'));
  byId.get('main').clientHeight = mainHeight;

  const flush = () => { const q = frames.splice(0); for (const cb of q) cb(); };

  let seat = null;
  const types = new Map();
  const edges = [];
  const host = createDrawerHost({
    refitActiveTerminal() {},
    getActiveSession: () => seat,
    getSeatType: () => (seat ? types.get(seat) || null : null),
  });

  const tenant = (id, availableFor) => {
    host.register({
      id,
      label: id,
      availableFor,
      mount() {},
      onShow() { edges.push(`show:${id}`); },
      onHide() { edges.push(`hide:${id}`); },
    });
  };

  const handle = byId.get('drawer-resize');
  const api = {
    host, flush, edges, types,
    byId, store, body, winListeners, frames,
    tenant,
    drawerH: () => byId.get('main').props.get('--drawer-h'),
    tall: () => byId.get('drawer').classList.contains('tall'),
    drag(...ys) {
      byId.get('drawer').rect = { top: 0, right: 0, bottom: mainHeight, left: 0 };
      handle.listeners.get('pointerdown')({ button: 0, pointerId: 1, preventDefault() {} });
      for (const y of ys) {
        handle.listeners.get('pointermove')({ clientX: 0, clientY: y });
        flush();
      }
    },
    release() { handle.listeners.get('pointerup')({ pointerId: 1 }); flush(); },
    dblclick() { handle.listeners.get('dblclick')({}); },
    seatTo(name) { seat = name; host.onSessionChanged(); flush(); },
    firstSeat(name) { seat = name; host.syncSeatAvailability(); flush(); },
    collapsed: () => byId.get('drawer').classList.contains('collapsed'),
    activeTab() {
      const on = byId.get('drawer-tabs').children.filter((c) => c.classList.contains('active'));
      return on.length === 1 ? on[0].dataset.tab : on.map((c) => c.dataset.tab);
    },
    clickTab(id) {
      for (const child of byId.get('drawer-tabs').children) {
        if (child.dataset.tab === id) { child.listeners.get('click')({ stopPropagation() {} }); return; }
      }
      throw new Error(`no tab ${id}`);
    },
  };

  try {
    return fn(api);
  } finally {
    global.document = had.d; global.window = had.w;
    global.localStorage = had.ls;
    global.ResizeObserver = had.ro; global.requestAnimationFrame = had.raf;
  }
}

test('drawer state is restored per seat, with one onShow/onHide edge per transition', () => {
  harness((h) => {
    h.types.set('seat-a', 'claude');
    h.types.set('seat-b', 'claude');
    h.tenant('log');
    h.tenant('term');
    h.firstSeat('seat-a');

    h.clickTab('term');
    h.flush();
    assert.equal(h.collapsed(), false);
    assert.deepEqual(h.host.deckOf('seat-a'), { expanded: true, tab: 'term' });
    assert.deepEqual(h.edges, ['show:term']);

    h.edges.length = 0;
    h.seatTo('seat-b');
    assert.equal(h.collapsed(), true);
    assert.deepEqual(h.edges, ['hide:term']);

    h.edges.length = 0;
    h.seatTo('seat-a');
    assert.equal(h.collapsed(), false);
    assert.deepEqual(h.host.deckOf('seat-a'), { expanded: true, tab: 'term' });
    assert.deepEqual(h.edges, ['show:term']);
  });
});

test('a seat never visited boots collapsed even when the previous seat was expanded', () => {
  harness((h) => {
    h.types.set('seat-a', 'claude');
    h.types.set('seat-b', 'claude');
    h.tenant('log');
    h.tenant('term');
    h.firstSeat('seat-a');

    h.clickTab('term');
    h.flush();
    assert.equal(h.collapsed(), false);

    h.seatTo('seat-b');
    assert.equal(h.collapsed(), true);
    assert.deepEqual(h.host.deckOf('seat-b'), { expanded: false, tab: null });
  });
});

test('restoring a seat records nothing for the seat it passes through', () => {
  harness((h) => {
    h.types.set('seat-a', 'claude');
    h.types.set('seat-b', 'claude');
    h.tenant('log');
    h.tenant('term');
    h.firstSeat('seat-a');

    h.clickTab('term');
    h.flush();

    h.seatTo('seat-b');
    h.seatTo('seat-a');

    assert.deepEqual(h.host.deckOf('seat-b'), { expanded: false, tab: null });
    assert.deepEqual(h.host.deckOf('seat-a'), { expanded: true, tab: 'term' });
  });
});

test('a recorded tab the seat cannot serve leaves the fallback tab and still honours expanded', () => {
  harness((h) => {
    h.types.set('seat-a', 'claude');
    h.types.set('seat-b', 'claude');
    h.tenant('log');
    h.tenant('term', (type) => type === 'claude');
    h.firstSeat('seat-a');

    h.clickTab('term');
    h.flush();
    assert.deepEqual(h.host.deckOf('seat-a'), { expanded: true, tab: 'term' });

    h.seatTo('seat-b');
    h.types.set('seat-a', 'bash');
    h.edges.length = 0;
    h.seatTo('seat-a');

    assert.equal(h.collapsed(), false);
    assert.equal(h.activeTab(), 'log');
    assert.deepEqual(h.edges.filter((e) => e.endsWith(':term')), []);
    assert.deepEqual(h.host.deckOf('seat-a'), { expanded: true, tab: 'term' });
  });
});

test('forgetSession drops the seat entry', () => {
  harness((h) => {
    h.types.set('seat-a', 'claude');
    h.tenant('log');
    h.tenant('term');
    h.firstSeat('seat-a');

    h.clickTab('term');
    h.flush();
    assert.deepEqual(h.host.deckOf('seat-a'), { expanded: true, tab: 'term' });

    h.host.forgetSession('seat-a');
    assert.deepEqual(h.host.deckOf('seat-a'), { expanded: false, tab: null });
  });
});

function expanded(h) {
  h.types.set('seat-a', 'claude');
  h.tenant('log');
  h.firstSeat('seat-a');
  h.clickTab('log');
  h.flush();
  assert.equal(h.collapsed(), false);
}

test('drawer height: a drag applies --drawer-h live and writes clodex-drawer-h only on release', () => {
  harness((h) => {
    expanded(h);
    h.drag(800, 700);
    assert.equal(h.drawerH(), '300px');
    assert.equal(h.body.classList.contains('drawer-dragging'), true);
    assert.equal(h.store.has('clodex-drawer-h'), false);
    h.release();
    assert.equal(h.body.classList.contains('drawer-dragging'), false);
    assert.equal(h.store.get('clodex-drawer-h'), '300');
  });
});

test('drawer height: a drag clears tall', () => {
  harness((h) => {
    expanded(h);
    assert.equal(h.tall(), true);
    h.drag(600);
    assert.equal(h.tall(), false);
    h.release();
    assert.equal(h.tall(), false);
    assert.equal(h.store.get('clodex-drawer-tall'), '0');
    assert.equal(h.drawerH(), '400px');
  }, { storage: { 'clodex-drawer-tall': '1' } });
});

test('drawer height: a double-click removes the inline height and the key', () => {
  harness((h) => {
    expanded(h);
    h.drag(700);
    h.release();
    assert.equal(h.store.get('clodex-drawer-h'), '300');
    h.dblclick();
    assert.equal(h.drawerH(), undefined);
    assert.equal(h.store.has('clodex-drawer-h'), false);
  });
});

test('drawer height: a boot with the key set applies it synchronously, before any frame', () => {
  harness((h) => {
    assert.equal(h.frames.length, 0);
    assert.equal(h.drawerH(), '333px');
  }, { storage: { 'clodex-drawer-h': '333' } });
});

test('drawer height: a boot with no key or a junk key sets no inline height', () => {
  harness((h) => assert.equal(h.drawerH(), undefined));
  harness((h) => assert.equal(h.drawerH(), undefined), { storage: { 'clodex-drawer-h': 'tall' } });
  harness((h) => assert.equal(h.drawerH(), undefined), { storage: { 'clodex-drawer-h': '40' } });
});

test('drawer height: a drag fires neither onShow nor onHide on the shown tenant', () => {
  harness((h) => {
    expanded(h);
    assert.deepEqual(h.edges, ['show:log']);
    h.edges.length = 0;
    h.drag(900, 500, 300);
    h.release();
    h.dblclick();
    h.flush();
    assert.deepEqual(h.edges, []);
  });
});

test('drawer height: the clamp floor is 120px and the ceiling 70% of #main', () => {
  harness((h) => {
    expanded(h);
    h.drag(990);
    assert.equal(h.drawerH(), '120px');
    h.drag(10);
    assert.equal(h.drawerH(), '700px');
    h.release();
    assert.equal(h.store.get('clodex-drawer-h'), '700');
  });
});

test('drawer height: a window resize re-clamps the remembered height to the new #main', () => {
  harness((h) => {
    assert.equal(h.drawerH(), '600px');
    h.byId.get('main').clientHeight = 500;
    h.winListeners.get('resize')();
    assert.equal(h.drawerH(), '350px');
  }, { storage: { 'clodex-drawer-h': '600' } });
});

test('drawer height: a boot before #main has a height clamps on the next frame, never unclamped', () => {
  harness((h) => {
    assert.equal(h.drawerH(), undefined);
    h.byId.get('main').clientHeight = 500;
    h.flush();
    assert.equal(h.drawerH(), '350px');
  }, { storage: { 'clodex-drawer-h': '600' }, mainHeight: 0 });
});

test('#drawer caps its height at 70%, the same ceiling the drag clamps to and the tall preset uses', () => {
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'drawer-host.js'), 'utf8');
  const block = css.match(/\n#drawer \{[^}]*\}/);
  assert.ok(block, 'no #drawer block');
  assert.match(block[0], /max-height: 70%;/);
  assert.match(css, /--drawer-tall-h: 70%;/);
  assert.match(js, /const DRAWER_MAX_FRACTION = 0\.7;/);
});

test('#drawer-resize straddles the drawer top edge instead of covering the header', () => {
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const handle = css.match(/\n#drawer-resize \{[^}]*\}/);
  assert.ok(handle, 'no #drawer-resize block');
  assert.match(handle[0], /top: -3px;/);
  assert.match(handle[0], /height: 5px;/);
  const block = css.match(/\n#drawer \{[^}]*\}/);
  assert.match(block[0], /overflow: clip;/);
  assert.match(block[0], /overflow-clip-margin: 3px;/);
});

test('drawer badge: a hidden tab shows a textless activity dot, then attention, cleared when shown', () => {
  harness((h) => {
    h.types.set('seat-a', 'claude');
    h.tenant('log');
    const notify = h.host.register({ id: 'term', label: 'term', mount() {}, onShow() {}, onHide() {} });
    h.firstSeat('seat-a');
    h.clickTab('log');
    h.flush();
    const tab = h.byId.get('drawer-tabs').children.find((c) => c.dataset.tab === 'term');
    const badge = tab.children[1];
    const state = () => ({
      zero: badge.classList.contains('zero'),
      attention: badge.classList.contains('attention'),
      text: badge.textContent,
    });

    assert.deepEqual(state(), { zero: true, attention: false, text: '' });

    notify('activity');
    assert.deepEqual(state(), { zero: false, attention: false, text: '' });

    notify('activity');
    assert.deepEqual(state(), { zero: false, attention: false, text: '' });

    notify('attention');
    assert.deepEqual(state(), { zero: false, attention: true, text: '' });

    h.clickTab('term');
    h.flush();
    assert.deepEqual(state(), { zero: true, attention: false, text: '' });

    notify('attention');
    assert.deepEqual(state(), { zero: true, attention: false, text: '' });
  });
});
