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
    get textContent() { return e._text; },
    set textContent(v) { e._text = String(v); e.children = []; },
  };
  return e;
}

function harness(fn) {
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
  global.window = { api: { onRequestOpenIpcLog() {} } };
  global.localStorage = { getItem: () => null, setItem() {} };
  global.ResizeObserver = class { observe() {} };
  global.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };

  byId.set('drawer', el('div'));
  byId.get('drawer').classList.add('collapsed');

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

  const api = {
    host, flush, edges, types,
    byId,
    tenant,
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
