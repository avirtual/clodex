'use strict';

const test = require('node:test');
const assert = require('node:assert');

const bp = require('../plugins/browser-pane/renderer');

const REFUSED = { ok: false, error: 'plugin method not available on this surface' };
const tick = () => new Promise((r) => setImmediate(r));

function fakeDom() {
  const make = (tag) => ({
    tag, className: '', children: [], listeners: {}, disabled: false, _text: '', style: {}, parentNode: null,
    set textContent(v) { this._text = String(v); this.children.length = 0; },
    get textContent() { return this._text; },
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
    const forget = () => walk(root).find((n) => n.className === 'bp-forget');
    await forget().click();
    assert.deepStrictEqual(seen, [bp.forgetText('utility')]);
    assert.match(seen[0], /utility/);
    assert.match(seen[0], /Downloaded files are kept/);
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
    await walk(root).find((n) => n.className === 'bp-reveal').click();
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
    assert.ok(walk(root).some((n) => n.className === 'bp-handback'), 'a held service offers Hand back');
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
    assert.deepStrictEqual(names, ['utility · held (operator)', 'irs · driving · clodex-hand']);
    const options = walk(body).filter((n) => n.tag === 'option').map((n) => n.textContent);
    assert.deepStrictEqual(options, ['clodex-hand', 'cx', 'clodex-hand', 'cx']);
    await walk(body).find((n) => n.className === 'bp-show').click();
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
    await find('bp-open-go').click();
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
    await find('bp-open-go').click();
    assert.deepStrictEqual(f.invokes.find((i) => i.method === 'operator.open').args, [{ service: 'gas', url: 'https://gas.example.com/' }]);
    assert.strictEqual(find('bp-window').textContent, 'window open · held (operator)');
    assert.strictEqual(find('bp-hand-text').placeholder, 'what should it do?');
    await tick();
    find('bp-hand-seat').value = 'cx';
    find('bp-hand-text').value = 'pay it';
    await find('bp-hand-go').click();
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
