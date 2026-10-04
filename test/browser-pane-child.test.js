'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { keepOrFold, settleDownload, wireHost, numberVerdict, inspectKind, retiredOf } = require('../plugins/browser-pane/child');
const K = require('../plugins/browser-pane/keys');
const R = require('../plugins/browser-pane/replies');
const scripts = require('../plugins/browser-pane/page-scripts');

const PDF = '%PDF-1.4 lista august';

function bills() {
  const dir = fs.realpathSync(mkTmpRoot('clodex-bp-child-'));
  const put = (name) => { const p = path.join(dir, name); fs.writeFileSync(p, PDF); return p; };
  return { dir, put };
}

const landed = (file) => ({ file, bytes: PDF.length, mime: 'application/pdf', magic: 'pdf', ms: 5, url: 'https://x/l.pdf' });

test('keepOrFold: an agent waiter without a name folds an identical sibling into the existing file', () => {
  const { put } = bills();
  const first = put('lista.pdf');
  const again = put('lista-1.pdf');
  const r = keepOrFold(landed(again), {}, () => false);
  assert.strictEqual(r.file, first);
  assert.strictEqual(r.same, true);
  assert.strictEqual(fs.existsSync(again), false);
});

test('keepOrFold: two identical downloads under distinct --as names both stay on disk and neither is same', () => {
  const { put } = bills();
  const posted = put('posted.pdf');
  const a = keepOrFold(landed(posted), { nameHint: 'posted.pdf' }, () => false);
  const popup = put('popup.pdf');
  const b = keepOrFold(landed(popup), { nameHint: 'popup.pdf' }, () => false);
  assert.deepStrictEqual([a.file, b.file], [posted, popup]);
  assert.strictEqual(a.same, undefined);
  assert.strictEqual(b.same, undefined);
  assert.ok(fs.existsSync(posted) && fs.existsSync(popup));
});

test('settleDownload: a click download that outruns its wait is abandoned and its duplicate file is kept where the reply said', async (t) => {
  const { put } = bills();
  put('lista.pdf');
  const planned = put('lista-1.pdf');
  const item = { getSavePath: () => planned, getMimeType: () => 'application/pdf', getURLChain: () => ['https://x/l.pdf'] };
  let finish;
  const w = { started: Promise.resolve(item), done: new Promise((res) => { finish = res; }) };
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const settling = settleDownload(w, Date.now());
  await new Promise((r) => setImmediate(r));
  mock.timers.tick(1);
  const d = await settling;
  assert.deepStrictEqual(d, { file: planned, mime: 'application/pdf', url: 'https://x/l.pdf', bytes: null });
  assert.strictEqual(w.abandoned, true);
  assert.ok(R.actReply('click', 'ebloc', { sub: 'click', n: 4 }, { n: 4, kind: 'clickable', label: 'PDF', navigated: false, download: d })
    .endsWith(`→ download ${planned} still downloading`));
  const out = keepOrFold(landed(planned), w, () => false);
  finish(out);
  assert.strictEqual(out.file, planned);
  assert.strictEqual(out.same, undefined);
  assert.ok(fs.existsSync(planned));
});

test('page scripts: FIND_TEXT hits say whether this find assigned the number, and ask for a stamp on an unread page', () => {
  const src = scripts.FIND_TEXT('PDF');
  assert.match(src, /return \{ n, fresh: fresh\.includes\(n\), text: /);
  assert.match(src, /if \(!window\.__cxEls \|\| !window\.__cxKeys\) return \{ unstamped: true \};/);
});

function page(state) {
  const ctx = { Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, document: { querySelectorAll: () => [] }, WeakRef, URL, URLSearchParams, location: { origin: 'https://x.test' } };
  ctx.window = ctx;
  vm.createContext(ctx);
  return vm.runInContext(`(() => {${scripts.numbering(state)}
  resetTable();
  return { storedKeysOf, place, verify, assigned, fresh, next: () => next };
})()`, ctx);
}

function button(label, row) {
  const attrs = {};
  return {
    tagName: 'BUTTON', isConnected: true, innerText: label, labels: null, value: '', row,
    matches: (sel) => sel.split(',').includes('button'),
    getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; },
    hasAttribute: () => false, querySelector: () => null, querySelectorAll: () => [],
    closest() { return this.row == null ? null : { innerText: this.row }; },
  };
}

function stampAll(state, els) {
  const p = page(state);
  const stored = p.storedKeysOf(els);
  const ns = els.map((el, i) => p.place(el, stored[i]));
  const known = { ...state.known, ...p.assigned };
  return { p, ns, stored, state: { known, next: p.next() } };
}

test('numbering: an element keeps its number when new elements appear before it on a later page', () => {
  const first = stampAll({ known: {}, next: 1 }, [button('Acasa'), button('Mobil')]);
  assert.deepStrictEqual(first.ns, [1, 2]);
  const second = stampAll(first.state, [button('Factura nouă'), button('Altceva'), button('Mobil'), button('Acasa')]);
  assert.deepStrictEqual(second.ns, [3, 4, 2, 1]);
  assert.deepStrictEqual([...second.p.fresh], [3, 4]);
});

test('numbering: two same-label buttons in different rows get ordinal+context keys; reordered rows get fresh numbers', () => {
  const a = button('Delete', 'Factura A 120 lei');
  const b = button('Delete', 'Factura B 80 lei');
  const first = stampAll({ known: {}, next: 1 }, [a, b]);
  assert.deepStrictEqual(first.stored.map((k) => K.parseStored(k).context), ['Factura A 120 lei', 'Factura B 80 lei']);
  const second = stampAll(first.state, [button('Delete', 'Factura B 80 lei'), button('Delete', 'Factura A 120 lei')]);
  assert.deepStrictEqual(second.ns, [3, 4]);
  const same = stampAll(first.state, [button('Delete', 'Factura A 120 lei'), button('Delete', 'Factura B 80 lei')]);
  assert.deepStrictEqual(same.ns, [1, 2]);
});

test('numbering: verify refuses a number whose element no longer yields its stored key', () => {
  const a = button('Delete', 'Factura A 120 lei');
  const b = button('Delete', 'Factura B 80 lei');
  const { p, ns, stored } = stampAll({ known: {}, next: 1 }, [a, b]);
  assert.strictEqual(p.verify(ns[0], stored[0]), 'ok');
  a.row = 'Factura B 80 lei';
  b.row = 'Factura A 120 lei';
  assert.strictEqual(p.verify(ns[0], stored[0]), 'ambiguous');
  assert.strictEqual(p.verify(ns[1], stored[0]), 'ambiguous');
  a.isConnected = false;
  assert.strictEqual(p.verify(ns[0], stored[0]), null);
});

function link(label, href) {
  const attrs = { href };
  return {
    tagName: 'A', isConnected: true, innerText: label, labels: null, value: '', href: `https://x.test${href}`,
    matches: (sel) => sel.split(',').includes('a[href]'),
    getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; },
    hasAttribute: (k) => k in attrs, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  };
}

test('numbering: CHECK verifies a link with a learned volatile param under the same learned list as the read', () => {
  const state = { known: {}, next: 1, volatile: ['sess'] };
  const { p, ns, stored } = stampAll(state, [link('Mobil', '/x?sess=1&a=1')]);
  assert.strictEqual(stored[0], 'link\u0000Mobil\u0000/x?a=1');
  assert.strictEqual(p.verify(ns[0], stored[0]), 'ok');
  assert.match(scripts.CHECK(1, stored[0], state), /const learned = \["sess"\];/);
});

test('numberVerdict: an unresolved number is ambiguous when its base key is on the page under another key, else gone', () => {
  const base = K.keyOf({ kind: 'button', label: 'Delete', href: '' });
  const stored = K.storedKey(base, 1, 'Factura A');
  assert.strictEqual(numberVerdict(null, stored, { 5: K.storedKey(base, 1, 'Factura B') }), 'ambiguous');
  assert.strictEqual(numberVerdict(null, stored, { 5: K.keyOf({ kind: 'link', label: 'Acasa', href: '/' }) }), 'gone');
  assert.strictEqual(numberVerdict(null, stored, null), 'gone');
  assert.strictEqual(numberVerdict('ok', stored, null), 'ok');
});

test('retiredOf: numbers whose key changed on this page; on the same document also numbers that vanished', () => {
  const base = K.keyOf({ kind: 'button', label: 'Delete', href: '' });
  const prev = { 1: K.storedKey(base, 1, 'A'), 2: 'link\u0000Acasa\u0000/', 3: 'link\u0000Gone\u0000/g' };
  const cur = { 4: K.storedKey(base, 1, 'B'), 2: 'link\u0000Acasa\u0000/' };
  assert.deepStrictEqual(retiredOf(prev, cur, false), [1]);
  assert.deepStrictEqual(retiredOf(prev, cur, true), [1, 3]);
});

test('inspectKind: a non-standard element with no click listener here or above and no pointer cursor is an element', () => {
  const r = { kind: 'clickable', cursor: 'auto', marked: false };
  assert.strictEqual(inspectKind(r, { types: ['mouseover'] }), 'element');
  assert.strictEqual(inspectKind(r, { types: ['click'] }), 'clickable');
  assert.strictEqual(inspectKind(r, { types: [], ancestorAt: 2 }), 'clickable');
  assert.strictEqual(inspectKind({ ...r, cursor: 'pointer' }, { types: [] }), 'clickable');
  assert.strictEqual(inspectKind({ ...r, marked: true }, { types: [] }), 'clickable');
  assert.strictEqual(inspectKind(r, null), 'clickable');
  assert.strictEqual(inspectKind({ kind: 'link' }, { types: [] }), 'link');
});

test('wireHost: an async stdout error makes later sends write nothing and shuts down once; stdin end shuts down', () => {
  const stdout = new EventEmitter();
  const writes = [];
  stdout.write = (s) => { writes.push(s); return true; };
  const stdin = new EventEmitter();
  const calls = [];
  const send = wireHost({ stdin, stdout, shutdown: () => calls.push('shutdown') });
  send({ event: 'ready' });
  assert.doesNotThrow(() => stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
  stdout.emit('error', new Error('again'));
  send({ event: 'window-closed', service: 'x' });
  assert.deepStrictEqual(writes, ['{"cxb":1,"event":"ready"}\n']);
  assert.deepStrictEqual(calls, ['shutdown']);
  stdin.emit('end');
  assert.deepStrictEqual(calls, ['shutdown', 'shutdown']);
});

test('page scripts: the numbers overlay creates one container with a fixed id and OVERLAY_OFF removes it', () => {
  const id = JSON.stringify(scripts.OVERLAY_ID);
  assert.strictEqual(scripts.OVERLAY.split(`layer.id = ${id};`).length, 2);
  assert.strictEqual((scripts.OVERLAY.match(/document\.createElement\('div'\)/g) || []).length, 1);
  assert.match(scripts.OVERLAY, new RegExp(`const old = document\\.getElementById\\(${id.replace(/[$]/g, '\\$')}\\);\\n {2}if \\(old\\) old\\.remove\\(\\);`));
  assert.match(scripts.OVERLAY_OFF, new RegExp(`document\\.getElementById\\(${id}\\);\\n {2}if \\(layer\\) layer\\.remove\\(\\);`));
  assert.match(scripts.OVERLAY, /z-index:2147483647/);
});

test('page scripts: VALUE clips at the source to 200 chars', () => {
  const run = (v) => new Function('window', `return ${scripts.VALUE(1)}`)({ __cxEls: { 1: { deref: () => ({ isConnected: true, value: v }) } } });
  assert.strictEqual(run('x'.repeat(500)).length, 200);
  assert.strictEqual(run('abc'), 'abc');
});

function visOf(view = {}) {
  const make = new Function('getComputedStyle', 'document', 'scrollX', 'scrollY', 'innerWidth', 'innerHeight', `${scripts.DEEP}\nreturn vis;`);
  const doc = { documentElement: { scrollWidth: view.docW || 1200, scrollHeight: view.docH || 3000 }, scrollingElement: view.se };
  return make((el) => ({ visibility: 'visible', display: 'block', opacity: '1', clip: 'auto', clipPath: 'none', overflow: 'visible', overflowX: 'visible', ...el.style }),
    doc, view.scrollX || 0, view.scrollY || 0, 1200, 800);
}

function box(left, top, width, height, style = {}, parentElement = null) {
  return { style, parentElement, getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }) };
}

function scroller(scrollTop) {
  return { ...box(0, 0, 1200, 800, { overflowY: 'auto' }), scrollTop, scrollLeft: 0, scrollHeight: 5000, clientHeight: 800, scrollWidth: 1200, clientWidth: 1200 };
}

test('page scripts: vis drops elements parked off the document, transparent, clipped away or 1×1 hidden', () => {
  const vis = visOf();
  assert.strictEqual(vis(box(10, 10, 80, 20)), true);
  assert.strictEqual(vis(box(10, -9999, 80, 20, { opacity: '0.75' })), false);
  assert.strictEqual(vis(box(-9999, 10, 80, 20)), false);
  assert.strictEqual(vis(box(10, 3100, 80, 20)), false);
  assert.strictEqual(vis(box(1300, 10, 80, 20)), false);
  assert.strictEqual(vis(box(10, 10, 80, 20, { opacity: '0' })), false);
  assert.strictEqual(vis(box(10, 10, 80, 20, { clip: 'rect(0px, 0px, 0px, 0px)' })), false);
  assert.strictEqual(vis(box(10, 10, 80, 20, { clip: 'rect(1px, 1px, 1px, 1px)' })), false);
  assert.strictEqual(vis(box(10, 10, 80, 20, { clipPath: 'inset(50%)' })), false);
  assert.strictEqual(vis(box(10, 10, 80, 20, { clipPath: 'inset(100%)' })), false);
  assert.strictEqual(vis(box(10, 10, 1, 1, { overflow: 'hidden' })), false);
  assert.strictEqual(vis(box(10, 10, 1, 1)), true);
  assert.strictEqual(vis(box(10, 10, 80, 20, { display: 'none' })), false);
  assert.strictEqual(visOf({ scrollY: 2000 })(box(10, -100, 80, 20)), true);
});

test('page scripts: vis measures an element inside a scrolling ancestor against that scroller, not the document', () => {
  const vis = visOf({ docH: 800 });
  assert.strictEqual(vis(box(10, -3000, 80, 20, {}, scroller(3200))), true);
  assert.strictEqual(vis(box(10, 3000, 80, 20, {}, box(0, 0, 1200, 3000, {}, scroller(0)))), true);
  assert.strictEqual(vis(box(10, 5100, 80, 20, {}, scroller(0))), false);
  assert.strictEqual(vis(box(10, -9999, 80, 20, {}, box(0, 0, 1200, 800))), false);
  assert.strictEqual(vis(box(10, 3000, 80, 20)), false);
});

test('page scripts: vis never takes the scrolling element for an inner scroller and measures the document by it', () => {
  const body = { ...box(0, -2000, 1200, 3000, { overflowY: 'auto' }), scrollTop: 2000, scrollLeft: 0, scrollHeight: 3000, clientHeight: 800, scrollWidth: 1200, clientWidth: 1200 };
  const vis = visOf({ se: body, scrollY: 2000, docH: 800 });
  assert.strictEqual(vis(box(10, 700, 80, 20, {}, body)), true);
  assert.strictEqual(vis(box(10, -9999, 80, 20, {}, body)), false);
});

test('page scripts: vis drops the children of a scrolling drawer parked off-screen and tests fixed elements against the viewport', () => {
  const vis = visOf();
  const drawer = { ...box(-280, 0, 280, 800, { overflowY: 'auto', position: 'fixed' }), scrollTop: 0, scrollLeft: 0, scrollHeight: 4000, clientHeight: 800, scrollWidth: 280, clientWidth: 280 };
  assert.strictEqual(vis(box(-270, 10, 200, 20, {}, drawer)), false);
  const panel = { ...scroller(0), getBoundingClientRect: () => ({ left: 0, top: 500, width: 1200, height: 300, right: 1200, bottom: 800 }) };
  assert.strictEqual(vis(box(10, 10, 200, 20, { position: 'fixed' }, panel)), true);
  assert.strictEqual(vis(box(10, 10, 200, 20, {}, panel)), false);
  assert.strictEqual(vis(box(10, -500, 200, 20, { position: 'fixed' }, scroller(0))), false);
});

test('page scripts: vis tests a non-fixed child of a position:fixed container against the viewport', () => {
  const vis = visOf();
  const fixed = box(0, 0, 300, 800, { position: 'fixed' });
  assert.strictEqual(vis(box(10, 900, 80, 20, {}, fixed)), false);
  assert.strictEqual(vis(box(10, 700, 80, 20, {}, fixed)), true);
});

test('page scripts: the busy scan, the element list, FIND_TEXT and INSPECT all use vis', () => {
  assert.match(scripts.READ_TEXT(false), /\.querySelectorAll\("[^"]*"\)\]\.filter\(vis\);/);
  assert.match(scripts.READ_INTERACTIVE(false), /if \(!vis\(el\)\) continue;/);
  assert.match(scripts.FIND_TEXT('x'), /\.filter\(vis\);/);
  assert.match(scripts.INSPECT(1), /visible: vis\(el\)/);
});

test('page scripts: PAGE_TEXT renders tables as cell | cell rows with the same code as READ_TEXT', () => {
  const rows = /const cellText = [\s\S]*?t\.replaceWith\(box\);\n {2}\}/;
  const a = rows.exec(scripts.PAGE_TEXT);
  assert.ok(a);
  assert.strictEqual(a[0], rows.exec(scripts.READ_TEXT(false))[0]);
});

test('page scripts: an icon clickable falls back to its img file name after alt, title, aria-label and svg title', () => {
  const src = scripts.READ_INTERACTIVE(false);
  assert.match(src, /\(t && t\.textContent\)\n\s*\|\| src\.split\(\/\[\?#\]\/\)\[0\]\.split\('\/'\)\.pop\(\)/);
  const iconLabel = new Function(`${src.slice(src.indexOf('  const iconLabel'), src.indexOf('  const sel ='))}\nreturn iconLabel;`)();
  const img = (s, alt) => ({ getAttribute: (k) => (k === 'src' ? s : k === 'alt' ? alt : null) });
  const el = (imgs) => ({ querySelectorAll: () => imgs, querySelector: () => null, getAttribute: () => null });
  assert.strictEqual(iconLabel(el([img('/img/lock.png?v=3')])), 'lock.png');
  assert.strictEqual(iconLabel(el([img('/img/lock.png', 'padlock')])), 'padlock');
  assert.strictEqual(iconLabel(el([img('data:image/gif;base64,R0l')])), '');
});
