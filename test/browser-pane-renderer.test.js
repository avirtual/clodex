'use strict';

const test = require('node:test');
const assert = require('node:assert');

const bp = require('../plugins/browser-pane/renderer');

const REFUSED = { ok: false, error: 'plugin method not available on this surface' };
const tick = () => new Promise((r) => setImmediate(r));

function fakeDom() {
  const make = (tag) => ({
    tag, className: '', children: [], listeners: {}, disabled: false, _text: '',
    set textContent(v) { this._text = String(v); this.children.length = 0; },
    get textContent() { return this._text; },
    set innerHTML(_v) { throw new Error('innerHTML used'); },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    click() { return Promise.all((this.listeners.click || []).map((fn) => fn())); },
  });
  const prev = global.document;
  global.document = { createElement: make };
  return { root: make('div'), restore: () => { global.document = prev; } };
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

test('segment text for each state: literal rows', async () => {
  const rows = [
    [status('off'), null],
    [status('running'), 'browser: idle'],
    [status('starting'), 'browser: starting'],
    [status('running', [svc('utility', 'idle')]), 'browser: idle'],
    [status('running', [svc('utility', 'driving', 'clodex-hand')]), 'browser: driving clodex-hand'],
    [status('running', [svc('utility', 'driving', 'another workspace')]), 'browser: driving another workspace'],
    [status('running', [svc('utility', 'gating', 'clodex-hand')]), 'browser: waiting for you'],
    [status('running', [svc('irs', 'driving', 'clodex-hand'), svc('utility', 'held')]), 'browser: needs you (utility)'],
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
