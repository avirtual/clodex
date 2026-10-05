'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const bp = require('../plugins/browser-pane/renderer');

const REFUSED = { ok: false, error: 'plugin method not available on this surface' };
const tick = () => new Promise((r) => setImmediate(r));

function fakeDom() {
  const make = (tag) => ({
    tag, className: '', children: [], listeners: {}, disabled: false, _text: '', style: {}, parentNode: null,
    set textContent(v) { this._text = String(v); this.children.length = 0; },
    get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; },
    set innerHTML(_v) { throw new Error('innerHTML used'); },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c; },
    contains(c) { return walk(this).includes(c); },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    click() { return Promise.all((this.listeners.click || []).map((fn) => fn())); },
  });
  const prev = global.document;
  const docListeners = {};
  global.document = {
    createElement: make,
    body: make('body'),
    addEventListener(ev, fn) { (docListeners[ev] ||= []).push(fn); },
    removeEventListener(ev, fn) { docListeners[ev] = (docListeners[ev] || []).filter((f) => f !== fn); },
  };
  const fire = (ev, e) => (docListeners[ev] || []).slice().forEach((fn) => fn(e));
  return { root: make('div'), body: global.document.body, fire, restore: () => { global.document = prev; } };
}

function walk(node, out = []) {
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
}

function makeRhost(answers) {
  const invokes = [];
  const opened = [];
  let segment = null;
  let section = null;
  let onChanged = null;
  let relayouts = 0;
  const rhost = {
    workspaceId: 'w1',
    invoke(method, ...args) {
      invokes.push({ method, args });
      const a = answers[method];
      return Promise.resolve(typeof a === 'function' ? a(...args) : a || { ok: true });
    },
    events: { on: (topic, fn) => { assert.strictEqual(topic, 'changed'); onChanged = fn; return () => {}; } },
    log: { info() {}, error() {} },
    ui: {
      openPath: (p) => opened.push(p),
      showToast: () => {},
      statusBar: { addSegment: (spec) => { segment = spec; }, requestRelayout: () => { relayouts += 1; } },
      settings: { section: (spec) => { section = spec; } },
    },
  };
  return {
    rhost, invokes, opened,
    segment: () => segment, section: () => section, changed: () => onChanged(), relayouts: () => relayouts,
  };
}

const status = (child, services = []) => ({ ok: true, child, services });
const svc = (name, state, seat = null) => ({ name, state, reason: state === 'held' ? 'login' : null, seat, login: 'unknown' });
const op = (name) => ({ name, state: 'held', reason: 'takeover', seat: null, login: 'unknown', operator: true });

test('segment text for each state: literal rows', async () => {
  const rows = [
    [status('off'), null],
    [status('running'), 'browser: idle'],
    [status('starting'), 'browser: starting'],
    [status('running', [svc('utility', 'idle')]), 'browser: idle'],
    [status('running', [svc('utility', 'driving', 'clodex-hand')]), 'browser: driving clodex-hand'],
    [status('running', [svc('utility', 'driving', 'another workspace')]), 'browser: driving another workspace'],
    [status('running', [svc('utility', 'gating', 'clodex-hand')]), 'browser: waiting for you'],
    [status('running', [svc('irs', 'driving', 'clodex-hand'), svc('utility', 'held')]), 'browser: needs you (utility) +1'],
    [status('running', [op('utility')]), 'browser: utility operator'],
    [status('running', [op('utility'), svc('irs', 'held')]), 'browser: needs you (irs) +1'],
    [status('running', [svc('irs', 'driving', 'clodex-hand'), op('utility'), svc('gas', 'idle')]), 'browser: utility operator +2'],
    [status('running', [svc('irs', 'idle'), svc('utility', 'driving', 'clodex-hand')]), 'browser: driving clodex-hand +1'],
    [status('running', [svc('irs', 'idle'), svc('utility', 'gating', 'clodex-hand')]), 'browser: waiting for you +1'],
    [status('running', [svc('irs', 'idle'), svc('utility', 'idle')]), 'browser: 2 windows'],
    [status('running', [svc('irs', 'idle'), svc('utility', 'idle'), svc('gas', 'idle')]), 'browser: 3 windows'],
    [REFUSED, 'browser: desktop only'],
  ];
  for (const [answer, want] of rows) {
    let current = answer;
    const f = makeRhost({ status: () => current });
    bp.activate(f.rhost);
    await tick();
    const out = f.segment().render({});
    assert.strictEqual(out ? out.text : null, want, JSON.stringify(answer));
    if (want && want.startsWith('browser: needs you')) assert.strictEqual(out.accentClass, 'bp-attention');
    current = status('off');
    f.changed();
    await tick();
    assert.strictEqual(f.segment().render({}), null, 'null when the child goes off');
    assert.ok(f.relayouts() >= 2);
  }
});

test('the segment pulls status for this window and clicking it shows a window', async () => {
  const f = makeRhost({ status: status('running', [svc('utility', 'idle')]) });
  bp.activate(f.rhost);
  await tick();
  f.segment().onClick();
  assert.deepStrictEqual(f.invokes, [{ method: 'status', args: ['w1'] }, { method: 'show', args: [] }]);
});

test('the surface refusal makes the settings body the one-line notice', async () => {
  const { root, restore } = fakeDom();
  try {
    const f = makeRhost({ status: REFUSED, 'services.list': REFUSED });
    bp.activate(f.rhost);
    await f.section().render(root);
    assert.strictEqual(root.children.length, 1);
    assert.strictEqual(root.children[0].textContent, 'Browser pane: desktop only — its windows open on the machine running Clodex.');
    assert.strictEqual(f.section().collect(root), null);
  } finally { restore(); }
});

test('Forget login confirms, naming the service and that downloads are kept, then invokes services.forget', async () => {
  const { root, restore } = fakeDom();
  const prevConfirm = global.confirm;
  const seen = [];
  let answer = false;
  global.confirm = (msg) => { seen.push(msg); return answer; };
  try {
    const list = { ok: true, services: [{ name: 'utility', login: 'logged-in', loginAt: 0, lastUrl: '', windowOpen: false, state: 'closed' }] };
    const f = makeRhost({ status: status('off'), 'services.list': list, 'services.forget': { ok: true, service: 'utility' } });
    bp.activate(f.rhost);
    await f.section().render(root);
    const forget = () => walk(root).find((n) => n.className === 'bp-forget bp-btn quiet');
    await forget().click();
    assert.deepStrictEqual(seen, [bp.forgetText('utility')]);
    assert.match(seen[0], /utility/);
    assert.strictEqual(seen[0], 'Forget the login for utility?\n\nIts cookies and site data are deleted, so the next visit starts signed out. The service, its last page and its downloads are kept.');
    assert.ok(!f.invokes.some((i) => i.method === 'services.forget'), 'a declined confirm forgets nothing');
    answer = true;
    await forget().click();
    await tick();
    assert.deepStrictEqual(f.invokes.filter((i) => i.method === 'services.forget'), [{ method: 'services.forget', args: ['utility'] }]);
  } finally {
    restore();
    if (prevConfirm === undefined) delete global.confirm; else global.confirm = prevConfirm;
  }
});

test('Reveal downloads opens the engine-reported folder', async () => {
  const { root, restore } = fakeDom();
  try {
    const f = makeRhost({ status: status('off'), 'services.list': { ok: true, services: [] }, 'downloads.dir': { ok: true, dir: '/data/downloads' } });
    bp.activate(f.rhost);
    await f.section().render(root);
    await walk(root).find((n) => n.className === 'bp-reveal bp-btn').click();
    assert.deepStrictEqual(f.opened, ['/data/downloads']);
  } finally { restore(); }
});

test('service data renders as text: an <img onerror> name is never parsed as HTML', async () => {
  const { root, restore } = fakeDom();
  try {
    const evil = '<img src=x onerror=alert(1)>';
    const list = { ok: true, services: [{ name: evil, login: 'logged-in', loginAt: 0, lastUrl: '', windowOpen: true, state: 'held' }] };
    const f = makeRhost({ status: status('off'), 'services.list': list });
    bp.activate(f.rhost);
    await f.section().render(root);
    const name = walk(root).find((n) => n.className === 'bp-name');
    assert.strictEqual(name.textContent, evil);
    assert.strictEqual(name.children.length, 0);
    assert.ok(walk(root).every((n) => n.tag !== 'img'));
    assert.ok(walk(root).some((n) => n.className === 'bp-handback bp-btn'), 'a held service offers Hand back');
  } finally { restore(); }
});

test('segment click rule: 0 windows none, 1 show, 2+ pick', () => {
  const rows = [
    [null, 'none'],
    [{ desktopOnly: true }, 'none'],
    [status('running'), 'none'],
    [status('running', [svc('utility', 'idle')]), 'show'],
    [status('running', [svc('utility', 'idle'), svc('irs', 'held')]), 'pick'],
    [status('running', [svc('utility', 'idle'), svc('irs', 'idle'), svc('gas', 'idle')]), 'pick'],
  ];
  for (const [st, want] of rows) assert.strictEqual(bp.clickActionFor(st), want, JSON.stringify(st));
  assert.strictEqual(bp.pickerLabel(op('utility')), 'utility · held (operator)');
  assert.strictEqual(bp.pickerLabel(svc('irs', 'driving', 'clodex-hand')), 'irs · driving · clodex-hand');
});

function withSeats(f, seats) {
  f.rhost.sessions = { listWorkspace: async (id) => { assert.strictEqual(id, 'w1'); return seats; } };
  f.timers = [];
  f.rhost.setTimeout = (fn, ms) => { f.timers.push([fn, ms]); };
  return f;
}

const SEATS = [{ name: 'clodex-hand', type: 'claude' }, { name: 'sh', type: 'bash' }, { name: 'cx', type: 'codex' }];

test('segment click with two windows opens a picker listing both, Escape closes it, and no show is invoked', async () => {
  const { body, fire, restore } = fakeDom();
  try {
    const f = withSeats(makeRhost({ status: status('running', [op('utility'), svc('irs', 'driving', 'clodex-hand')]) }), SEATS);
    bp.activate(f.rhost);
    await tick();
    f.segment().onClick({ getBoundingClientRect: () => ({ left: 10, top: 500 }) });
    await tick();
    assert.ok(!f.invokes.some((i) => i.method === 'show'));
    const names = walk(body).filter((n) => n.className === 'bp-pick-name').map((n) => n.textContent);
    assert.deepStrictEqual(names, ['utility', 'irs']);
    const states = walk(body).filter((n) => n.className === 'bp-pick-state').map((n) => n.textContent);
    assert.deepStrictEqual(states, ['held (operator)', 'driving · clodex-hand']);
    assert.strictEqual(body.children[0].children[0].textContent, 'Browser windows');
    const options = walk(body).filter((n) => n.tag === 'option').map((n) => n.textContent);
    assert.deepStrictEqual(options, []);
    await walk(body).find((n) => n.className === 'bp-show bp-btn').click();
    assert.deepStrictEqual(f.invokes.filter((i) => i.method === 'show'), [{ method: 'show', args: ['utility'] }]);
    fire('keydown', { key: 'Escape' });
    assert.strictEqual(body.children.length, 0);
    f.segment().onClick({});
    assert.strictEqual(body.children.length, 1);
    fire('mousedown', { target: {} });
    assert.strictEqual(body.children.length, 0);
    await tick();
  } finally { restore(); }
});

test('segment picker: rows are grid rows; Hand… unfolds one hand-over form at a time from one seat lookup, a second click or Escape folds it', async () => {
  const { body, fire, restore } = fakeDom();
  try {
    const f = withSeats(makeRhost({ status: status('running', [op('utility'), svc('irs', 'driving', 'clodex-hand')]) }), SEATS);
    let lookups = 0;
    const list = f.rhost.sessions.listWorkspace;
    f.rhost.sessions.listWorkspace = (id) => { lookups += 1; return list(id); };
    bp.activate(f.rhost);
    await tick();
    f.segment().onClick({ getBoundingClientRect: () => ({ left: 10, top: 500 }) });
    await tick();
    const rows = body.children[0].children.slice(1);
    assert.deepStrictEqual(body.children[0].children.map((r) => r.className), ['bp-picker-label', 'bp-row bp-pick-row', 'bp-row bp-pick-row']);
    assert.deepStrictEqual(rows[0].children.map((c) => c.className), ['bp-pick-name', 'bp-pick-state', 'bp-show bp-btn', 'bp-hand-open bp-btn']);
    assert.deepStrictEqual(walk(body).filter((n) => n.className === 'bp-hand-open bp-btn').map((n) => n.textContent), ['Hand…', 'Hand…']);
    const css = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'browser-pane', 'style.css'), 'utf8');
    assert.ok(css.includes('.bp-pick-row {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) auto auto auto;\n  align-items: center;\n  gap: 8px;\n  padding: 5px 8px;'));
    assert.ok(css.includes('.bp-picker .bp-btn:not(.primary) {\n  font-size: 11px;\n  padding: 2px 8px;\n  background: transparent;\n  border: 1px solid var(--border, #444);'));
    assert.ok(css.includes('  background: var(--surface-overlay, var(--sidebar-bg, #1e1e2a));\n'));
    assert.ok(css.includes('.bp-pick-row > .bp-hand {\n  grid-column: 1 / -1;'));
    const opens = () => walk(body).filter((n) => n.className === 'bp-hand-open bp-btn');
    const forms = () => walk(body).filter((n) => n.className === 'bp-hand');
    await opens()[0].click();
    await tick();
    assert.deepStrictEqual(forms().map((n) => n.parentNode), [rows[0]]);
    assert.strictEqual(rows[0].children[4].className, 'bp-hand');
    assert.deepStrictEqual(walk(body).filter((n) => n.tag === 'option').map((n) => n.textContent), ['clodex-hand', 'cx']);
    assert.strictEqual(walk(body).find((n) => n.className === 'bp-hand-go bp-btn primary').textContent, 'Hand over');
    await opens()[1].click();
    await tick();
    assert.deepStrictEqual(forms().map((n) => n.parentNode), [rows[1]]);
    await opens()[1].click();
    assert.deepStrictEqual(forms(), []);
    await opens()[0].click();
    await tick();
    fire('keydown', { key: 'Escape' });
    assert.deepStrictEqual(forms(), []);
    assert.strictEqual(body.children.length, 1);
    assert.strictEqual(lookups, 1);
    fire('keydown', { key: 'Escape' });
    assert.strictEqual(body.children.length, 0);
  } finally { restore(); }
});

test('segment picker: with innerWidth 600 the popover width and left keep it 8px inside the window, and its height is capped', async () => {
  const { body, restore } = fakeDom();
  const prevWin = global.window;
  global.window = { innerWidth: 600, innerHeight: 800 };
  try {
    const f = withSeats(makeRhost({ status: status('running', [op('utility'), svc('irs', 'driving', 'clodex-hand')]) }), SEATS);
    bp.activate(f.rhost);
    await tick();
    f.segment().onClick({ getBoundingClientRect: () => ({ left: 500, top: 770 }) });
    await tick();
    const style = body.children[0].style;
    assert.deepStrictEqual([style.width, style.maxWidth, style.left, style.bottom, style.maxHeight], [undefined, '560px', '32px', '34px', '758px']);
    assert.ok(parseInt(style.left, 10) + parseInt(style.maxWidth, 10) <= 592);
  } finally {
    if (prevWin === undefined) delete global.window; else global.window = prevWin;
    restore();
  }
});

test('segment picker: a row names its site and page title, its state cell carries the seat and hidden, and the header counts the hidden', async () => {
  const { body, restore } = fakeDom();
  try {
    const wiki = { ...svc('wiki', 'idle', 'apometre'), visible: false, host: 'en.wikipedia.org', title: 'Water metering' };
    const irs = { ...svc('irs', 'idle'), visible: true, host: 'irs.gov', title: 'An extremely long page title that runs on and on' };
    const f = withSeats(makeRhost({ status: status('running', [wiki, irs]) }), SEATS);
    bp.activate(f.rhost);
    await tick();
    f.segment().onClick({});
    await tick();
    assert.deepStrictEqual(walk(body).filter((n) => n.className === 'bp-pick-name').map((n) => n.textContent),
      ['wiki en.wikipedia.org — Water metering', 'irs irs.gov — An extremely long page title that runs …']);
    assert.deepStrictEqual(walk(body).filter((n) => n.className === 'bp-pick-state').map((n) => n.textContent), ['idle · apometre · hidden', 'idle']);
    assert.strictEqual(walk(body).find((n) => n.className === 'bp-picker-label').textContent, 'Browser windows · 2 open · 1 hidden');
    assert.strictEqual(walk(body).find((n) => n.className === 'bp-pick-name').children[0].tag, 'b');
    assert.strictEqual(bp.pickerName({ name: 'wiki', state: 'idle' }), 'wiki');
  } finally { restore(); }
});

test('segment picker: a mousedown on a re-rendered segment with the same data-act is the anchor and does not close it', async () => {
  const { body, fire, restore } = fakeDom();
  try {
    const f = withSeats(makeRhost({ status: status('running', [op('utility'), svc('irs', 'driving', 'clodex-hand')]) }), SEATS);
    bp.activate(f.rhost);
    await tick();
    f.segment().onClick({ getAttribute: (k) => (k === 'data-act' ? 'browser' : null), getBoundingClientRect: () => ({ left: 10, top: 500 }) });
    await tick();
    assert.strictEqual(body.children.length, 1);
    fire('mousedown', { target: { closest: (sel) => (sel === '[data-act="browser"]' ? {} : null) } });
    assert.strictEqual(body.children.length, 1);
    fire('mousedown', { target: { closest: () => null } });
    assert.strictEqual(body.children.length, 0);
    await tick();
  } finally { restore(); }
});

test('Settings: a first-time operator.open refills the denylist section too', async () => {
  const { root, restore } = fakeDom();
  try {
    const f = withSeats(makeRhost({ status: status('off'), 'services.list': { ok: true, services: [] }, 'operator.open': { ok: true, service: 'gas' } }), SEATS);
    bp.activate(f.rhost);
    await f.section().render(root);
    const gets = () => f.invokes.filter((i) => i.method === 'denylist.get').length;
    const before = gets();
    const find = (cls) => walk(root).find((n) => n.className === cls);
    find('bp-open-service').value = 'gas';
    find('bp-open-url').value = 'https://gas.example.com/';
    await find('bp-open-go bp-btn primary').click();
    await tick();
    assert.strictEqual(gets(), before + 1);
  } finally { restore(); }
});

test('Settings: the open row invokes operator.open, and an open window row hands over with seat and instruction', async () => {
  const { root, restore } = fakeDom();
  try {
    const list = { ok: true, services: [{ name: 'utility', login: 'logged-in', loginAt: 0, lastUrl: '', windowOpen: true, state: 'held', operator: true }] };
    const f = withSeats(makeRhost({
      status: status('off'), 'services.list': list, 'operator.open': { ok: true, service: 'gas' }, 'operator.handover': { ok: true, service: 'utility', seat: 'cx' },
    }), SEATS);
    bp.activate(f.rhost);
    await f.section().render(root);
    const find = (cls) => walk(root).find((n) => n.className === cls);
    find('bp-open-service').value = ' gas ';
    find('bp-open-url').value = 'https://gas.example.com/';
    await find('bp-open-go bp-btn primary').click();
    assert.deepStrictEqual(f.invokes.find((i) => i.method === 'operator.open').args, [{ service: 'gas', url: 'https://gas.example.com/' }]);
    assert.strictEqual(find('bp-window').textContent, 'open · held by operator');
    assert.strictEqual(find('bp-show bp-btn').textContent, 'Show');
    assert.strictEqual(find('bp-hand-text'), undefined);
    await find('bp-hand-open bp-btn').click();
    assert.strictEqual(find('bp-hand-text').placeholder, 'what should it do?');
    await tick();
    find('bp-hand-seat').value = 'cx';
    find('bp-hand-text').value = 'pay it';
    await find('bp-hand-go bp-btn primary').click();
    assert.deepStrictEqual(f.invokes.find((i) => i.method === 'operator.handover').args, [{ service: 'utility', seat: 'cx', instruction: 'pay it' }]);
    assert.strictEqual(find('bp-handed').textContent, 'handed to cx');
    assert.deepStrictEqual(f.timers.map((x) => x[1]), [5000]);
    const lists = f.invokes.filter((i) => i.method === 'services.list').length;
    await f.timers[0][0]();
    assert.strictEqual(f.invokes.filter((i) => i.method === 'services.list').length, lists + 1);
    await tick();
    await tick();
  } finally { restore(); }
});

test('Settings: a closed service with a last URL offers Open at it and no Show; without one it offers neither', async () => {
  const { root, restore } = fakeDom();
  const toasts = [];
  try {
    const list = { ok: true, services: [
      { name: 'wiki', login: 'logged-in', loginAt: 0, lastUrl: 'https://wiki.example.com/page', windowOpen: false, state: 'closed' },
      { name: 'gas', login: 'unknown', loginAt: 0, lastUrl: '', windowOpen: false, state: 'closed' },
    ] };
    const f = makeRhost({ status: status('off'), 'services.list': list, 'operator.open': { ok: false, error: 'boom' } });
    f.rhost.ui.showToast = (msg) => toasts.push(msg);
    bp.activate(f.rhost);
    await f.section().render(root);
    const rows = walk(root).filter((n) => n.className === 'bp-row');
    const classes = (r) => walk(r).map((n) => n.className);
    assert.strictEqual(rows.length, 2);
    assert.ok(!classes(rows[0]).includes('bp-show bp-btn'));
    assert.ok(!classes(rows[1]).includes('bp-show bp-btn'));
    assert.ok(!classes(rows[1]).includes('bp-reopen bp-btn'));
    const reopen = walk(rows[0]).find((n) => n.className === 'bp-reopen bp-btn');
    assert.strictEqual(reopen.textContent, 'Open');
    await reopen.click();
    await tick();
    assert.deepStrictEqual(f.invokes.filter((i) => i.method === 'operator.open').map((i) => i.args), [[{ service: 'wiki', url: 'https://wiki.example.com/page' }]]);
    assert.deepStrictEqual(toasts, ['Could not open wiki: boom']);
  } finally { restore(); }
});

test('Settings: a Show that fails toasts the service and the reason', async () => {
  const { root, restore } = fakeDom();
  const toasts = [];
  try {
    const list = { ok: true, services: [{ name: 'wiki', login: 'logged-in', loginAt: 0, lastUrl: 'https://wiki.example.com/', windowOpen: true, state: 'idle' }] };
    const f = withSeats(makeRhost({ status: status('off'), 'services.list': list, show: { ok: false, error: 'x' } }), SEATS);
    f.rhost.ui.showToast = (msg, opts) => toasts.push([msg, opts.kind]);
    bp.activate(f.rhost);
    await f.section().render(root);
    await walk(root).find((n) => n.className === 'bp-show bp-btn').click();
    await tick();
    assert.deepStrictEqual(toasts, [['Could not show wiki: x', 'error']]);
    await tick();
  } finally { restore(); }
});

test('status notice: a notice already up at the first pull is not toasted; a newer one is, once, as info', async () => {
  let notice = { seq: 1, text: 'old' };
  const toasts = [];
  const f = makeRhost({ status: () => ({ ...status('off'), notice }) });
  f.rhost.ui.showToast = (msg, opts) => toasts.push([msg, opts.kind]);
  bp.activate(f.rhost);
  await tick();
  assert.deepStrictEqual(toasts, []);
  notice = { seq: 2, text: 'Browser: 2 window(s) closed after 15 min idle — Open in the pane resumes them' };
  f.changed();
  await tick();
  f.changed();
  await tick();
  assert.deepStrictEqual(toasts, [['Browser: 2 window(s) closed after 15 min idle — Open in the pane resumes them', 'info']]);
});

test('settings: the attach row is built once; a refresh keeps a focused edit and updates an unfocused field', async () => {
  const { root, restore } = fakeDom();
  try {
    const f = makeRhost({ status: status('off'), 'services.list': { ok: true, services: [] }, 'attach.get': { ok: true, global: 1000, seats: {} }, 'operator.open': { ok: true }, 'denylist.get': { ok: false } });
    bp.activate(f.rhost);
    await f.section().render(root);
    const fields = () => walk(root).filter((n) => n.className === 'bp-attach-tokens');
    const [field] = fields();
    field.value = '3000';
    global.document.activeElement = field;
    await walk(root).find((n) => n.className === 'bp-open-go bp-btn primary').click();
    assert.deepStrictEqual(fields(), [field]);
    assert.strictEqual(field.value, '3000');
    global.document.activeElement = null;
    await walk(root).find((n) => n.className === 'bp-open-go bp-btn primary').click();
    assert.deepStrictEqual(fields(), [field]);
    assert.strictEqual(field.value, '1000');
  } finally { restore(); }
});

test('settings: the attach row shows the global read budget and saves an edit through attach.set', async () => {
  const { root, restore } = fakeDom();
  try {
    const f = makeRhost({ status: status('off'), 'services.list': { ok: true, services: [] }, 'attach.get': { ok: true, global: 1000, seats: {} }, 'attach.set': { ok: false, error: 'tokens must be an integer from 100 to 20000' } });
    bp.activate(f.rhost);
    await f.section().render(root);
    const field = walk(root).find((n) => n.className === 'bp-attach-tokens');
    assert.strictEqual(field.value, '1000');
    assert.strictEqual(walk(root).find((n) => n.className === 'bp-attach-label').textContent, 'Attach reads up to ≈');
    field.value = '2500';
    await walk(root).find((n) => n.className === 'bp-attach-save').click();
    assert.deepStrictEqual(f.invokes.filter((i) => i.method === 'attach.set').map((i) => i.args), [[{ tokens: 2500 }]]);
    assert.strictEqual(walk(root).find((n) => n.className === 'bp-attach-error').textContent, 'tokens must be an integer from 100 to 20000');
  } finally { restore(); }
});

test('stampShort: time only on the same day, else month day time', () => {
  const now = new Date(2026, 9, 6, 1, 20).getTime();
  assert.strictEqual(bp.stampShort(new Date(2026, 9, 6, 0, 5).getTime(), now), '00:05');
  assert.strictEqual(bp.stampShort(new Date(2026, 9, 5, 23, 27).getTime(), now), 'Oct 5 23:27');
  assert.strictEqual(bp.stampShort(0, now), '');
});

test('Settings: services are a grid table with a header; each row is one line of cells, Hand… unfolds a full-width form from one seat lookup', async () => {
  const { root, restore } = fakeDom();
  try {
    const loginAt = new Date(2020, 9, 5, 23, 27).getTime();
    const list = { ok: true, services: [
      { name: 'guardian', login: 'logged-in', loginAt, lastUrl: 'https://g.example/', windowOpen: true, state: 'idle', visible: false },
      { name: 'utility', login: 'unknown', loginAt: 0, lastUrl: 'https://u.example/', windowOpen: false, state: 'closed' },
      { name: 'gas', login: 'none', loginAt: 0, lastUrl: '', windowOpen: true, state: 'idle' },
    ] };
    const f = withSeats(makeRhost({ status: status('off'), 'services.list': list }), [
      { name: 'Plugins', type: 'claude' }, { name: 'term', type: 'bash' }, { name: 'cx', type: 'codex' }, { name: 'web', type: 'browser' },
    ]);
    let lookups = 0;
    const lw = f.rhost.sessions.listWorkspace;
    f.rhost.sessions.listWorkspace = (id) => { lookups += 1; return lw(id); };
    bp.activate(f.rhost);
    await f.section().render(root);
    assert.strictEqual(f.section().title, undefined);
    const table = walk(root).find((n) => n.className === 'bp-services');
    assert.deepStrictEqual(table.children.slice(0, 5).map((c) => [c.className, c.textContent]),
      [['bp-th', 'Service'], ['bp-th', 'Sign-in'], ['bp-th', 'Window'], ['bp-th', ''], ['bp-th', '']]);
    const rows = table.children.slice(5);
    const cells = (r) => r.children.map((c) => [c.className, c.textContent]);
    assert.deepStrictEqual(cells(rows[0]), [['bp-name', 'guardian'], ['bp-login', 'signed in · Oct 5 23:27'],
      ['bp-window', 'open · idle · hidden'], ['bp-actions', 'ShowHand…'], ['bp-forget bp-btn quiet', 'Forget login']]);
    assert.deepStrictEqual(cells(rows[1]), [['bp-name', 'utility'], ['bp-login', 'login unknown'],
      ['bp-window', 'closed'], ['bp-actions', 'Open'], ['bp-forget bp-btn quiet', 'Forget login']]);
    const css = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'browser-pane', 'style.css'), 'utf8');
    assert.ok(css.includes('.bp-services {\n  display: grid;\n  grid-template-columns: minmax(80px, auto) minmax(0, 1fr) auto auto auto;\n  column-gap: 12px;\n  row-gap: 4px;\n  align-items: center;'));
    assert.ok(css.includes('.bp-services > .bp-row {\n  display: contents;\n}'));
    assert.ok(css.includes('.bp-services > .bp-th,\n.bp-services > .bp-row > * {\n  min-width: 0;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}'));
    assert.ok(css.includes('.bp-services > .bp-row > .bp-hand {\n  grid-column: 1 / -1;'));
    assert.deepStrictEqual(walk(root).filter((n) => n.className === 'bp-section').map((n) => n.textContent), ['Windows', 'Reads', 'Denylist']);
    assert.strictEqual(walk(root).find((n) => n.className === 'bp-hand'), undefined);
    const opens = () => walk(root).filter((n) => n.className === 'bp-hand-open bp-btn');
    await opens()[0].click();
    await tick();
    assert.strictEqual(rows[0].children[5].className, 'bp-hand');
    assert.deepStrictEqual(walk(root).filter((n) => n.tag === 'option').map((n) => n.textContent), ['Plugins', 'cx']);
    await opens()[1].click();
    await tick();
    assert.deepStrictEqual(walk(root).filter((n) => n.className === 'bp-hand').map((n) => n.parentNode), [rows[2]]);
    assert.strictEqual(lookups, 1);
  } finally { restore(); }
});
