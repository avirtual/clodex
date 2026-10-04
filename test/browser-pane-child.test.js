'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const {
  keepOrFold, settleDownload, wireHost, numberVerdict, inspectKind, retiredOf, numState, mergeNumbers, numberRefusal, navOf, tickersOf, targetDiff, settleChange, LATE_CHANGE_MS, ORIGINS_MAX,
  changedOf, consequentialRefusal, signinHold, lateMsFor,
} = require('../plugins/browser-pane/child');
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

const svcOf = () => ({ origins: new Map(), num: null });
const stampOn = (svc, url, labels) => {
  const st = stampAll(numState(svc, url), labels.map((l) => button(l)));
  mergeNumbers(svc, { assigned: Object.fromEntries(st.stored.map((k, i) => [k, st.ns[i]])), next: st.state.next });
  return st;
};

test('numState: each origin keeps its own numbers; a detour to another site and back resolves the same element', () => {
  const svc = svcOf();
  const a = stampOn(svc, 'https://www.e-bloc.ro/index.php', ['Acasa', 'Contoare', 'Plati']);
  assert.deepStrictEqual(a.ns, [1, 2, 3]);
  const b = stampOn(svc, 'https://my.smartthings.com/devices', ['Devices', 'AC', 'Lights', 'Scenes', 'Menu']);
  assert.deepStrictEqual(b.ns, [1, 2, 3, 4, 5]);
  const back = numState(svc, 'https://www.e-bloc.ro/contoare');
  assert.strictEqual(back.known[a.stored[1]], 2);
  assert.strictEqual(svc.num.byN.get(2), a.stored[1]);
  assert.strictEqual(back.next, 4);
  assert.strictEqual(numberRefusal('ebloc', 2, svc.num.byN.get(2), 'ok'), null);
});

test('numberRefusal: a number only the other site has is no element; a stale number of this site names what it was', () => {
  const svc = svcOf();
  const a = stampOn(svc, 'https://www.e-bloc.ro/', ['Acasa', 'Contoare']);
  stampOn(svc, 'https://my.smartthings.com/', ['Devices', 'AC', 'Lights', 'Scenes', 'Menu']);
  numState(svc, 'https://www.e-bloc.ro/');
  const gone = numberRefusal('ebloc', 5, svc.num.byN.get(5), 'gone');
  assert.strictEqual(gone.code, 'NO_ELEMENT');
  assert.strictEqual(gone.message, R.TEXT.noElement('ebloc', 5));
  assert.doesNotMatch(gone.message, /\(was /);
  const amb = numberRefusal('ebloc', 2, svc.num.byN.get(2), 'ambiguous');
  assert.strictEqual(amb.code, 'AMBIGUOUS');
  assert.match(amb.message, /\(was "Contoare"\)/);
  assert.strictEqual(svc.num.byN.get(2), a.stored[1]);
});

test('numState: at most ORIGINS_MAX origins are kept, least recently used dropped first', () => {
  const svc = svcOf();
  for (let i = 0; i <= ORIGINS_MAX; i += 1) stampOn(svc, `https://s${i}.test/`, ['X']);
  assert.strictEqual(svc.origins.size, ORIGINS_MAX);
  assert.ok(!svc.origins.has('https://s0.test'));
  assert.ok(svc.origins.has(`https://s${ORIGINS_MAX}.test`));
});

test('numbering: with a listed set, a number first listed now is new even when an earlier stamp assigned it unlisted', () => {
  const p = page({ known: { 'button\u0000Contor 23\u0000': 23 }, next: 24, listed: [1, 2] });
  p.place(button('Acasa'), 'button\u0000Acasa\u0000');
  p.place(button('Contor 23'), 'button\u0000Contor 23\u0000');
  p.place(button('Ascuns'), 'button\u0000Ascuns\u0000', false);
  assert.deepStrictEqual([...p.fresh], [24, 23]);
  const q = page({ known: { 'button\u0000Contor 23\u0000': 23 }, next: 24, listed: [23] });
  q.place(button('Contor 23'), 'button\u0000Contor 23\u0000');
  assert.deepStrictEqual([...q.fresh], []);
});

test('navOf: a pushState click is an in-page navigation; a popup download that ends on the same url is the same page', () => {
  const at = 'https://x.com/search?q=a';
  assert.deepStrictEqual(navOf({ docBefore: 3, docAfter: 3, hrefBefore: at, hrefAfter: 'https://x.com/DanKornas/status/1' }), { navigated: true, inPage: true });
  assert.deepStrictEqual(navOf({ docBefore: 3, docAfter: 3, hrefBefore: at, hrefAfter: at }), { navigated: false });
  const page4 = 'https://www.e-bloc.ro/index.php?page=4&t=1791145507';
  assert.deepStrictEqual(navOf({ docBefore: 3, docAfter: 5, hrefBefore: page4, hrefAfter: page4, download: true }), { navigated: false });
  assert.deepStrictEqual(navOf({ docBefore: 3, docAfter: 5, hrefBefore: page4, hrefAfter: page4 }), { navigated: true });
  assert.deepStrictEqual(navOf({ docBefore: 3, docAfter: 4, hrefBefore: page4, hrefAfter: 'https://www.e-bloc.ro/x', download: true }), { navigated: true });
});

const fakeWatch = (snaps, targets = []) => {
  let t = 0;
  let i = 0;
  let k = 0;
  const sleeps = [];
  return {
    sleeps,
    opts: {
      snap: async () => snaps[Math.min(i++, snaps.length - 1)],
      target: targets.length ? async () => targets[Math.min(k++, targets.length - 1)] : null,
      sleepFn: async (ms) => { sleeps.push(ms); t += ms; },
      now: () => t,
    },
  };
};

test('settleChange: a ticking line seen between the two baselines is not a change; a tile text landing a second later is', async () => {
  const before = 'Living room\nUpdated 3s ago\nAC · On';
  const tickers = tickersOf('Living room\nUpdated 2s ago\nAC · On', before);
  const w = fakeWatch(['Living room\nUpdated 4s ago\nAC · On', 'Living room\nUpdated 5s ago\nAC · On', 'Living room\nUpdated 6s ago\nAC · Off']);
  const r = await settleChange({ before, tickers, ...w.opts });
  assert.deepStrictEqual(r, { changed: 'AC · Off', target: null });
  assert.deepStrictEqual(w.sleeps, [500, 500]);
});

test('settleChange: an H:MM:SS clock the baselines missed is still not a change, and the watch gives up after LATE_CHANGE_MS', async () => {
  const w = fakeWatch(['Hall\n7:56:12\nAC · On', 'Hall\n7:56:13\nAC · On']);
  const r = await settleChange({ before: 'Hall\n7:56:11\nAC · On', ...w.opts });
  assert.deepStrictEqual(r, { changed: '', target: null });
  assert.strictEqual(w.sleeps.reduce((a, b) => a + b, 0), LATE_CHANGE_MS);
});

test('settleChange: a target aria flip after the click is reported and ends the watch; class-only noise does not end it', async () => {
  const off = { el: { 'aria-label': 'AC Off', class: 'btn' }, tile: { 'aria-pressed': 'false' } };
  const focused = { el: { 'aria-label': 'AC Off', class: 'btn focus-visible' }, tile: { 'aria-pressed': 'false' } };
  const on = { el: { 'aria-label': 'AC On', class: 'btn on' }, tile: { 'aria-pressed': 'true' } };
  const w = fakeWatch(['same'], [focused, focused, on]);
  const r = await settleChange({ before: 'same', targetBefore: off, ...w.opts });
  assert.deepStrictEqual(r, { changed: '', target: 'aria-label "AC Off" → "AC On", class +on, tile aria-pressed "false" → "true"' });
  assert.deepStrictEqual(w.sleeps, [500, 500]);
  assert.strictEqual(targetDiff(off, focused), null);
  assert.deepStrictEqual(targetDiff(off, { el: { 'aria-label': 'AC Off', class: 'btn sel' }, tile: off.tile }), { text: 'class +sel', strong: false });
});

const CHILD_SRC = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'browser-pane', 'child.js'), 'utf8');

test('numbering: two Lista labels differing only past char 60 get different keys and numbers', () => {
  const head = 'Lista de plată pentru Bloc M4 Tabelul cu sumele de plată pe luna';
  const aug = button(`${head} [Document generat 03.08.2026]`);
  const jul = button(`${head} [Document generat 03.07.2026]`);
  const first = stampAll({ known: {}, next: 1 }, [aug]);
  const second = stampAll(first.state, [jul]);
  assert.notStrictEqual(second.stored[0], first.stored[0]);
  assert.deepStrictEqual(second.ns, [2]);
  const long = (tail) => button(`${'x'.repeat(K.LABEL_KEY_MAX)} ${tail}`);
  const both = stampAll({ known: {}, next: 1 }, [long('august'), long('iulie')]);
  assert.deepStrictEqual(both.ns, [1, 2]);
  assert.ok(both.stored.every((k) => K.parseStored(k).label.length < K.LABEL_KEY_MAX + 10));
});

test('changedOf: kept numbers whose line or row text differs since the last read', () => {
  assert.deepStrictEqual(changedOf({ 10: 'link Lista\u0000aug', 11: 'x\u0000', 12: 'y\u0000' }, { 10: 'link Lista\u0000iul', 11: 'x\u0000', 13: 'z\u0000' }), [10]);
  assert.deepStrictEqual(changedOf(null, { 1: 'a' }), []);
  const ri = scripts.READ_INTERACTIVE(false, {});
  assert.ok(ri.includes("sig = label + (el.hasAttribute('download') ? ' [download]' : '');"), 'a link signature leaves out its raw href (volatile t= is not a change)');
  assert.match(ri, /sigs\[n\] = \(it\.sig == null \? it\.line : it\.sig\) \+ '.' \+ rowOf\(it\.el\);/);
  assert.match(CHILD_SRC, /if \(svc\.num && svc\.num\.changed && svc\.num\.changed\.has\(Number\(n\)\)\) out\.textChanged = true;/);
});

test('consequentialRefusal: a tagged element is refused without --confirm, naming the category; with it the act proceeds', () => {
  const e = consequentialRefusal(27, { label: 'Card bancar', consequential: 'payment' }, false);
  assert.strictEqual(e.code, 'CONSEQUENTIAL');
  assert.strictEqual(e.message, '[27] "Card bancar" looks consequential (payment) — re-issue with --confirm if the operator asked for it');
  assert.strictEqual(consequentialRefusal(27, { label: 'Card bancar', consequential: 'payment' }, true), null);
  assert.strictEqual(consequentialRefusal(3, { label: 'Avizier', consequential: null }, false), null);
  const act = /const el = await resolve\(svc, n\);\n\s*const refused = consequentialRefusal\(n, el, !!args\.confirm\);\n\s*if \(refused\) throw refused;/;
  assert.match(CHILD_SRC, act, 'click, --text click and select all pass this check after resolve');
  assert.match(scripts.FIND(1), /consequential: cqOf\(el\),/);
});

test('signinHold: operator-nav stays quiet while a sign-in hold is up, not during a takeover or when idle', () => {
  assert.strictEqual(signinHold({ lock: { state: 'held', reason: 'login' } }), true);
  assert.strictEqual(signinHold({ lock: { state: 'held', reason: 'otp' } }), true);
  assert.strictEqual(signinHold({ lock: { state: 'held', reason: 'takeover' } }), false);
  assert.strictEqual(signinHold({ lock: { state: 'idle', reason: null } }), false);
  assert.match(CHILD_SRC, /const operatorNav = \(svc, inPage\) => \{\n\s*const info = pageInfo\(svc\);\n\s*if \(!info\.url \|\| info\.url === 'about:blank' \|\| signinHold\(svc\)\) return;/);
});

test('settleChange: a type or key act takes no late watch; click and select keep it', async () => {
  assert.strictEqual(lateMsFor('type'), 0);
  assert.strictEqual(lateMsFor('key'), 0);
  assert.strictEqual(lateMsFor('click'), LATE_CHANGE_MS);
  assert.strictEqual(lateMsFor('select'), LATE_CHANGE_MS);
  const w = fakeWatch(['same', 'same', 'same']);
  await settleChange({ before: 'same', ...w.opts, lateMs: lateMsFor('type') });
  assert.strictEqual(w.sleeps.length, 0);
  const c = fakeWatch(['same', 'same', 'same']);
  await settleChange({ before: 'same', ...c.opts, lateMs: lateMsFor('click') });
  assert.ok(c.sleeps.length > 0);
  assert.strictEqual((CHILD_SRC.match(/lateMsFor\(op\)\)/g) || []).length, 4, 'every withChange call passes lateMsFor(op)');
});

test('page scripts: TILE_SEL shares BOX_SEL with contextOf and no longer matches [class*=tile]', () => {
  assert.ok(scripts.TILE_SEL.includes(scripts.BOX_SEL) && !scripts.TILE_SEL.includes('tile'));
  assert.ok(scripts.READ_INTERACTIVE(false, {}).includes(`el.closest(${JSON.stringify(scripts.BOX_SEL)})`));
});

test('page scripts: consequentialOf tags one label per category, diacritic- and case-insensitive; Carduri nav does not match', () => {
  const c = scripts.consequentialOf;
  const rows = [
    [{ label: 'Card bancar' }, 'payment'], [{ label: 'Plătește' }, 'payment'], [{ label: 'Pay now' }, 'payment'],
    [{ value: 'Checkout' }, 'payment'], [{ aria: 'Confirm payment' }, 'payment'],
    [{ label: 'Cumpără acum' }, 'purchase'], [{ label: 'Place order' }, 'purchase'],
    [{ label: 'ȘTERGE' }, 'deletion'], [{ idClass: 'btn-delete' }, 'deletion'],
    [{ label: 'Ieşire' }, 'sign-out'], [{ label: 'Ieșire' }, 'sign-out'], [{ label: 'Log out' }, 'sign-out'], [{ idClass: 'logout ' }, 'sign-out'],
    [{ label: 'Arm' }, 'alarm'], [{ label: 'Disarm' }, 'alarm'],
    [{ label: 'Dezabonare' }, 'unsubscribe'], [{ label: 'Cancel subscription' }, 'unsubscribe'],
    [{ label: 'Send money' }, 'transfer'], [{ formaction: '/transfer' }, 'transfer'],
    [{ label: 'Trimite', action: '/plata/pay' }, 'payment'], [{ label: 'Go', action: '/orders/new' }, 'purchase'],
    [{ label: 'Carduri' }, null], [{ label: 'Avizier' }, null], [{ label: 'Armată' }, null], [{ label: 'Wireless' }, null],
    [{ label: 'Lista de plată pentru Bloc M4 Tabelul cu sumele de plată pe luna august' }, null],
    [{ label: 'Card bancar', textual: true }, null],
  ];
  for (const [d, want] of rows) assert.strictEqual(c(d), want, JSON.stringify(d));
  assert.match(scripts.READ_INTERACTIVE(false, {}), /line: kind \+ ' ' \+ \(cqOf\(el\) \? '⚠ ' : ''\) \+ line/);
  assert.match(scripts.OVERLAY, /cqOf\(el\) \? ';border:2px solid #e00'/);
});

test('page scripts: READ_TEXT keeps chrome landmarks and marks each of their text nodes for chromeStrip', () => {
  const src = scripts.READ_TEXT(false);
  const drop = /const DROP = '([^']*)'/.exec(src)[1].split(',');
  for (const sel of scripts.CHROME_SEL.split(',')) assert.ok(!drop.includes(sel), sel);
  assert.ok(src.includes(`clone.querySelectorAll(${JSON.stringify(scripts.CHROME_SEL)})`));
  assert.ok(src.includes(`t.data = ${JSON.stringify(scripts.CHROME_MARK)} + t.data`));
  assert.ok(scripts.READ_INTERACTIVE(false, {}).includes(`if (it.el.closest(${JSON.stringify(scripts.CHROME_SEL)})) chrome.push(n);`));
});
