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
  keepOrFold, settleDownload, wireHost, numberVerdict, inspectKind, retiredOf, numState, mergeNumbers, numberRefusal, notOpenError, navOf, tickersOf, targetDiff, settleChange, LATE_CHANGE_MS, ORIGINS_MAX,
  changedOf, rowChanged, coveredRefusal, consequentialRefusal, passwordRefusal, enterRefusal, scrollCode, signinHold, lateMsFor, loadNumbers, flushNumbers, forgetNumbers, numbersFile, originSlug, genRefusal, NUMBERS_SCHEMA,
} = require('../plugins/browser-pane/child');
const K = require('../plugins/browser-pane/keys');
const R = require('../plugins/browser-pane/replies');
const RF = require('../plugins/browser-pane/read-format');
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
  assert.match(src, /return \{ n, fresh: n != null && fresh\.includes\(n\), text: /);
  assert.match(src, /if \(!window\.__cxEls \|\| !window\.__cxKeys\) return \{ unstamped: true \};/);
  assert.match(src, /const nameOf = el => String\(el\.getAttribute\('aria-label'\) \|\| el\.getAttribute\('title'\) \|\| ''\)/);
  assert.match(src, /return \{ count: pick\.length, byName, hits: /);
  assert.ok(src.indexOf('textOf = flatOf') < src.indexOf('textOf = nameOf'));
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
    hasAttribute: () => false, querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ height: 20 }),
    closest(sel) { return this.row == null || sel === 'article' ? null : { innerText: this.row }; },
  };
}

function stampAll(state, els) {
  const p = page(state);
  const stored = p.storedKeysOf(els);
  const ns = els.map((el, i) => p.place(el, stored[i]));
  const known = { ...state.known, ...p.assigned };
  return { p, ns, stored, state: { known, next: p.next() } };
}

function xbutton(label, permalink, text = '') {
  const art = permalink == null ? null : { querySelector: (sel) => (sel === 'a[href*="/status/"]' ? { getAttribute: () => permalink } : null) };
  const attrs = label == null ? {} : { 'aria-label': label };
  return {
    tagName: 'BUTTON', isConnected: true, innerText: text, labels: null, value: '', id: '',
    matches: (sel) => sel.split(',').includes('button'),
    getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; },
    hasAttribute: (k) => k in attrs, querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ height: 20 }),
    closest: (sel) => (sel === 'article' ? art : null),
  };
}

test('numbering: feed buttons keep their numbers when only their counts move; amounts are not counters', () => {
  const keysOf = (r) => Object.fromEntries(r.ns.map((n, i) => [n, r.stored[i]]));
  const first = stampAll({ known: {}, next: 1 }, [
    xbutton('248 Likes. Like', '/karolzdeb/status/1'), xbutton('Like', '/ana/status/2'), xbutton('1.2K views. View post analytics', '/ana/status/2'),
    xbutton(null, null, '19,486'), xbutton('3 Following', null),
  ]);
  const second = stampAll(first.state, [
    xbutton('250 Likes. Like', '/karolzdeb/status/1'), xbutton('1 Like. Like', '/ana/status/2'), xbutton('1.3K views. View post analytics', '/ana/status/2'),
    xbutton(null, null, '19,486'), xbutton('4 Following', null),
  ]);
  assert.deepStrictEqual(second.ns, first.ns);
  assert.deepStrictEqual([...second.p.fresh], []);
  assert.deepStrictEqual(retiredOf(keysOf(first), keysOf(second), true), []);
  assert.notStrictEqual(first.stored[0], first.stored[1], 'two posts keep two like buttons');
  const amount = stampAll(first.state, [xbutton(null, null, '19,500')]);
  assert.deepStrictEqual(amount.ns, [6]);
  assert.deepStrictEqual([...amount.p.fresh], [6]);
});

function xarticle(text, permalink) {
  const art = { querySelector: (sel) => (sel === 'a[href*="/status/"]' && permalink ? { getAttribute: () => permalink } : null) };
  const attrs = { tabindex: '0' };
  return {
    tagName: 'ARTICLE', isConnected: true, innerText: text, labels: null, value: '', id: '',
    matches: () => false,
    getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; },
    hasAttribute: (k) => k in attrs, querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ height: 20 }),
    closest: (sel) => (sel === 'article' ? art : null),
  };
}

test('numbering: a feed article keys by its permalink while its bare counts move; without one every count in its label is masked', () => {
  const a = stampAll({ known: {}, next: 1 }, [xarticle('Ana @ana · 3h Hello world 84 587 3K 88K', '/ana/status/2'), xarticle('Bob @bob Hi 12 4', '/bob/status/9')]);
  const b = stampAll(a.state, [xarticle('Ana @ana · 3h Hello world 85 590 3.1K 89K', '/ana/status/2'), xarticle('Bob @bob Hi 13 4', '/bob/status/9')]);
  assert.deepStrictEqual(b.ns, a.ns);
  assert.notStrictEqual(a.stored[0], a.stored[1]);
  assert.strictEqual(K.parseStored(a.stored[0]).label, 'article /ana/status/2');
  const c = stampAll({ known: {}, next: 1 }, [xarticle('Promoted 84 587 3K', null)]);
  const d = stampAll(c.state, [xarticle('Promoted 90 601 3.4K', null)]);
  assert.deepStrictEqual(d.ns, c.ns);
  assert.strictEqual(K.parseStored(c.stored[0]).label, 'Promoted # # #');
});

test('numbering: an element keeps its number when new elements appear before it on a later page', () => {
  const first = stampAll({ known: {}, next: 1 }, [button('Acasa'), button('Mobil')]);
  assert.deepStrictEqual(first.ns, [1, 2]);
  const second = stampAll(first.state, [button('Factura nouă'), button('Altceva'), button('Mobil'), button('Acasa')]);
  assert.deepStrictEqual(second.ns, [3, 4, 2, 1]);
  assert.deepStrictEqual([...second.p.fresh], [3, 4]);
});

test('numbering: two same-label buttons in different rows get ordinal+context keys; reordered rows keep their numbers', () => {
  const a = button('Delete', 'Factura A 120 lei');
  const b = button('Delete', 'Factura B 80 lei');
  const first = stampAll({ known: {}, next: 1 }, [a, b]);
  assert.deepStrictEqual(first.stored.map((k) => K.parseStored(k).context), ['Factura A 120 lei', 'Factura B 80 lei']);
  const second = stampAll(first.state, [button('Delete', 'Factura B 80 lei'), button('Delete', 'Factura A 120 lei')]);
  assert.deepStrictEqual(second.ns, [2, 1]);
  const twins = stampAll({ known: {}, next: 1 }, [button('Delete', 'Same row'), button('Delete', 'Same row')]);
  assert.deepStrictEqual(twins.stored.map((k) => K.parseStored(k).ordinal), [1, 2], 'the ordinal breaks a tie of identical context');
  const same = stampAll(first.state, [button('Delete', 'Factura A 120 lei'), button('Delete', 'Factura B 80 lei')]);
  assert.deepStrictEqual(same.ns, [1, 2]);
});

test('numbering: a duplicate keys by its own block, so a retired twin never hands its number to the next one', () => {
  const list = { innerText: 'Trends', parentElement: null };
  const trends = ['Trending in Romania\nRomanians\n12.5K posts', 'Trending\n#connect\n3,100 posts', 'Politics\nElection\n890 posts', 'Sports\nDerby\n45K posts']
    .map((innerText) => ({ innerText, parentElement: list }));
  const carets = trends.map((t) => Object.assign(button('More', null), { parentElement: t }));
  const { p, ns, stored, state } = stampAll({ known: {}, next: 1 }, carets);
  assert.deepStrictEqual(ns, [1, 2, 3, 4]);
  assert.deepStrictEqual(stored.map((k) => K.parseStored(k).context), ['Trending in Romania Romanians # posts', 'Trending #connect # posts', 'Politics Election # posts', 'Sports Derby # posts']);
  carets[0].isConnected = false;
  trends[1].innerText = 'Trending\n#connect\n3,400 posts';
  assert.strictEqual(p.verify(ns[0], stored[0]), null, 'the retired caret is gone, not ok');
  assert.strictEqual(p.verify(ns[1], stored[1]), 'ok', 'the next caret still yields its own key');
  const after = stampAll(state, carets.slice(1));
  assert.deepStrictEqual(after.ns, [2, 3, 4], 'the second caret keeps [2]');
  trends[2].innerText = 'Weather\nStorm';
  assert.strictEqual(p.verify(ns[2], stored[2]), 'ambiguous', 'a changed block context is refused, never re-pointed');
});

test('FIND_TEXT: a loose duplicate is keyed the way verify recomputes it; a twin whose page key another connected element holds is not placed', () => {
  const style = { visibility: 'visible', display: 'block', opacity: '1', position: 'fixed', clip: 'auto', clipPath: 'none', overflow: 'visible', overflowX: 'visible', overflowY: 'visible' };
  const list = { innerText: 'Trends', parentElement: null };
  const order = [];
  const caret = (block, own) => {
    const b = Object.assign(button('More', null), {
      parentElement: { innerText: block, parentElement: list }, childNodes: [{ nodeType: 3, nodeValue: own }],
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 30, bottom: 30, width: 20, height: 20 }),
      compareDocumentPosition: (o) => (order.indexOf(o) > order.indexOf(b) ? 4 : 2),
    });
    return b;
  };
  const twin = caret('Trending in Romania Romanians', 'More');
  const a = caret('Trending in Romania Romanians', 'More');
  const b = caret('Trending #connect', 'More');
  const c = caret('Politics Election', 'More Election');
  order.push(twin, a, b, c);
  const doc = { querySelectorAll: (sel) => (sel === '*' ? order : []), documentElement: {}, scrollingElement: {} };
  const ctx = { Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, document: doc, WeakRef, URL, URLSearchParams, location: { origin: 'https://x.test', href: 'https://x.test/' },
    getComputedStyle: () => style, innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 0 };
  ctx.window = ctx;
  vm.createContext(ctx);
  ctx.__stamp = [a, b];
  const stamped = vm.runInContext(`(() => {${scripts.numbering({ known: {}, next: 1 })}
  resetTable();
  const stored = storedKeysOf(__stamp);
  __stamp.forEach((el, i) => place(el, stored[i]));
  return { assigned, next };
})()`, ctx);
  const state = { known: stamped.assigned, next: stamped.next };
  const found = vm.runInContext(scripts.FIND_TEXT('Election', state), ctx);
  assert.strictEqual(found.count, 1);
  const n = found.hits[0].n;
  assert.strictEqual(n, 3);
  const verify = (m) => vm.runInContext(scripts.CHECK(m, ctx.__cxKeys[m], { known: { ...state.known, ...found.assigned }, next: found.next }), ctx);
  assert.strictEqual(verify(n), 'ok', 'the number FIND_TEXT placed passes the act\'s CHECK');
  twin.childNodes = [{ nodeType: 3, nodeValue: 'More Romanians' }];
  const again = vm.runInContext(scripts.FIND_TEXT('Romanians', { known: { ...state.known, ...found.assigned }, next: found.next }), ctx);
  const full = vm.runInContext(`(() => {${scripts.numbering({ known: {}, next: 1 })}
  return storedKeysOf(__all);
})()`, Object.assign(ctx, { __all: order }));
  assert.strictEqual(K.parseStored(full[0]).base, K.parseStored(ctx.__cxKeys[1]).base);
  assert.strictEqual(full[0], ctx.__cxKeys[1], 'a read over the whole page keys the twin as [1]\'s key');
  assert.deepStrictEqual(Array.from(again.hits, (h) => h.n), [null], 'the twin is not placed on a number another connected element holds');
  assert.strictEqual(ctx.__cxOf.get(a), 1);
  assert.strictEqual(verify(1), 'ok', '[1] still points at its own caret');
  assert.match(CHILD_SRC, /if \(found\.hits\[0\]\.n == null\) throw codedError\('AMBIGUOUS', TEXT\.twinText\(svc\.name, text\)\);/);
});

test('FIND_TEXT: a control\'s aria-label is tried only when no visible text matched, and the result says byName', () => {
  const style = { visibility: 'visible', display: 'block', opacity: '1', position: 'fixed', clip: 'auto', clipPath: 'none', overflow: 'visible', overflowX: 'visible', overflowY: 'visible' };
  const order = [];
  const ctl = (label, own) => {
    const b = Object.assign(button(label, null), {
      parentElement: null, childNodes: [{ nodeType: 3, nodeValue: own }],
      getBoundingClientRect: () => ({ left: 10, top: 10 + 30 * order.length, right: 30, bottom: 30 + 30 * order.length, width: 20, height: 20 }),
      compareDocumentPosition: (o) => (order.indexOf(o) > order.indexOf(b) ? 4 : 2),
    });
    order.push(b);
    return b;
  };
  const x = ctl('×', '×');
  x.setAttribute('aria-label', 'Close drawer');
  const save = ctl('Save', 'Save');
  const doc = { querySelectorAll: (sel) => (sel === '*' ? order : []), documentElement: {}, scrollingElement: {} };
  const ctx = { Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, document: doc, WeakRef, URL, URLSearchParams, location: { origin: 'https://x.test', href: 'https://x.test/' },
    getComputedStyle: () => style, innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 0 };
  ctx.window = ctx;
  vm.createContext(ctx);
  ctx.__stamp = order;
  const stamped = vm.runInContext(`(() => {${scripts.numbering({ known: {}, next: 1 })}
  resetTable();
  const stored = storedKeysOf(__stamp);
  __stamp.forEach((el, i) => place(el, stored[i]));
  return { assigned, next };
})()`, ctx);
  const find = (t) => vm.runInContext(scripts.FIND_TEXT(t, { known: stamped.assigned, next: stamped.next }), ctx);
  const close = find('Close drawer');
  assert.strictEqual(close.count, 1);
  assert.strictEqual(close.byName, true);
  assert.strictEqual(close.hits[0].text, 'Close drawer');
  assert.strictEqual(typeof close.hits[0].n, 'number');
  assert.deepStrictEqual([find('Save').count, find('Save').byName], [1, false]);
  assert.deepStrictEqual([find('close').count, find('close').byName], [1, true]);
  save.setAttribute('aria-label', 'Save changes');
  const s2 = find('Save');
  assert.deepStrictEqual([s2.count, s2.byName, s2.hits[0].text], [1, false, 'Save']);
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
    hasAttribute: (k) => k in attrs, querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ height: 20 }), closest: () => null,
  };
}

test('numbering: CHECK verifies a link with a learned volatile param under the same learned list as the read', () => {
  const state = { known: {}, next: 1, volatile: ['sess'] };
  const { p, ns, stored } = stampAll(state, [link('Mobil', '/x?sess=1&a=1')]);
  assert.strictEqual(stored[0], 'link\u0000Mobil\u0000/x?a=1');
  assert.strictEqual(p.verify(ns[0], stored[0]), 'ok');
  assert.match(scripts.CHECK(1, stored[0], state), /const learned = \["sess"\];/);
});

test('numberVerdict: a stale number whose label head is listed is retired naming its successor; absent is gone; never assigned was not read', () => {
  const head = 'Lista de plată pentru Bloc M4 Tabelul cu sumele de plată pe luna ';
  const stored = K.keyOf({ kind: 'link', label: head + '[Document generat 03.07.2026]', href: '/l.pdf' });
  const now = K.keyOf({ kind: 'link', label: head + '[Document generat 03.08.2026]', href: '/l.pdf' });
  const retired = numberVerdict(null, stored, { 3: K.keyOf({ kind: 'link', label: 'Acasa', href: '/' }), 23: now });
  assert.deepStrictEqual(retired, { verdict: 'retired', now: 23 });
  assert.strictEqual(numberRefusal('ebloc', 10, stored, retired).message, '[10] retired: its text changed since your read (now [23]?) — read again');
  const gone = numberVerdict(null, stored, { 3: K.keyOf({ kind: 'link', label: 'Acasa', href: '/' }) });
  assert.strictEqual(gone, 'gone');
  assert.strictEqual(numberRefusal('ebloc', 10, stored, gone).message, '[10] is no longer on this page of ebloc — read again');
  assert.strictEqual(numberRefusal('ebloc', 99, undefined, 'ok').message, '[99] was not in your read of ebloc — read again');
  assert.strictEqual(numberVerdict(null, stored, { 23: K.keyOf({ kind: 'button', label: head + 'x', href: '' }) }), 'gone', 'another kind is not a successor');
  assert.match(CHILD_SRC, /numberVerdict\(verdict, stored, page && page\.keys\)/);
});

let overlayLegend = null;

function overlayRun(rects, words = [], extra = {}, bg = '') {
  const els = rects.map(([left, top, width, height, o = {}]) => ({
    tagName: o.tagName || 'A', type: '', form: null, labels: null, innerText: 'x', isContentEditable: false, isConnected: true, style: {}, parentElement: null,
    getAttribute: (k) => (k === 'href' ? '/x' : null), hasAttribute: () => false,
    closest: (sel) => (o.hidden && sel.includes('aria-hidden') ? {} : null),
    matches: (sel) => (sel.includes(':disabled') ? !!o.disabled : true), querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
  }));
  const badges = [];
  const document = {
    getElementById: () => null, documentElement: { scrollWidth: 1200, scrollHeight: 800 },
    createElement: (tag) => { const n = { tag, style: {}, appendChild: (c) => badges.push(c) }; return n; },
    body: { appendChild: () => {} },
    ...extra,
    caretRangeFromPoint: (x, y) => {
      if (!words.length) return null;
      const w = words.find((o) => x >= o.left && x <= o.left + o.width && y >= o.top && y <= o.top + o.height)
        || words.reduce((a, o) => (Math.abs(o.left - x) < Math.abs(a.left - x) ? o : a));
      const cw = w.width / w.text.length;
      const node = { nodeType: 3, data: w.text, w };
      return { startContainer: node, startOffset: Math.max(0, Math.min(w.text.length, Math.round((x - w.left) / cw))) };
    },
    createRange: () => {
      const q = {};
      return {
        setStart: (n, i) => { q.n = n; q.i = i; }, setEnd: () => {},
        getBoundingClientRect: () => {
          const { w } = q.n;
          const cw = w.width / w.text.length;
          return { left: w.left + q.i * cw, right: w.left + (q.i + 1) * cw, top: w.top, bottom: w.top + w.height };
        },
      };
    },
  };
  const window = { __cxEls: Object.fromEntries(els.map((e, i) => [String(i + 1), { deref: () => e }])) };
  const style = (e) => ({ visibility: 'visible', display: 'inline', opacity: '1', clip: 'auto', clipPath: 'none', overflow: 'visible', overflowX: 'visible', lineHeight: '18px', fontSize: '15px', backgroundImage: e && e.bg ? bg : 'none' });
  new Function('getComputedStyle', 'document', 'window', 'scrollX', 'scrollY', 'innerWidth', 'innerHeight', 'requestAnimationFrame', 'setTimeout', `return ${scripts.OVERLAY}`)(
    style, document, window, 0, 0, 1200, 800, () => {}, () => {});
  overlayLegend = (badges.find((b) => b.textContent.startsWith('not drawn')) || {}).textContent || null;
  return badges.filter((b) => !b.textContent.startsWith('not drawn')).map((b) => {
    const left = Number(/left:(\d+)px/.exec(b.style.cssText)[1]);
    const top = Number(/top:(\d+)px/.exec(b.style.cssText)[1]);
    const w = Math.ceil(b.textContent.length * 7.3) + 6;
    return { left, top, right: left + w, bottom: top + 16, dim: /opacity:\.6/.test(b.style.cssText) };
  });
}

test('page scripts: overlay badges never cover a neighbouring inline link or another badge; block rows and top-edge boxes get a 3 px nudge', () => {
  const links = [[100, 50, 40, 18], [142, 50, 40, 18], [184, 50, 60, 18], [300, 200, 500, 60], [400, 2, 50, 18], [460, 2, 50, 18]];
  const got = overlayRun(links);
  const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const rects = links.map(([l, t, w, h]) => ({ left: l, top: t, right: l + w, bottom: t + h }));
  got.forEach((b, i) => {
    rects.forEach((r, j) => { if (i !== j) assert.ok(!hit(b, r), `badge ${i + 1} covers link ${j + 1}`); });
    got.forEach((c, j) => { if (i !== j) assert.ok(!hit(b, c), `badge ${i + 1} covers badge ${j + 1}`); });
  });
  assert.deepStrictEqual([got[0].left, got[0].top], [84, 50], 'a free left gap keeps the badge left of the box');
  assert.deepStrictEqual([got[1].left, got[1].top], [142, 34], 'a tight gap moves it above');
  assert.deepStrictEqual([got[3].left, got[3].top], [297, 200], 'a block row is nudged 3 px left');
  assert.deepStrictEqual([got[5].left, got[5].top], [512, 2], 'no room left or above: right of the box');
  assert.match(scripts.OVERLAY, /cqOf\(el\) \? ';background:#e00' : ';background:#111'/);
});

test('page scripts: overlay badges skip words between inline links and never land on the line above', () => {
  const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const box = ([l, t, w, h]) => ({ left: l, top: t, right: l + w, bottom: t + h });
  const links = [[100, 50, 40, 18], [162, 50, 50, 18], [242, 50, 50, 18]];
  const words = [{ left: 146, top: 50, width: 12, height: 18, text: 'de' }, { left: 218, top: 50, width: 18, height: 18, text: 'sau' }];
  const got = overlayRun(links, words);
  const wordRects = words.map((w) => box([w.left, w.top, w.width, w.height]));
  got.forEach((b, i) => {
    links.map(box).forEach((r, j) => { if (i !== j) assert.ok(!hit(b, r), `badge ${i + 1} covers link ${j + 1}`); });
    wordRects.forEach((r, j) => assert.ok(!hit(b, r), `badge ${i + 1} covers word ${words[j].text}`));
  });
  assert.deepStrictEqual([got[0].left, got[0].top], [84, 50], 'no word left of the first link: the badge stays left');
  const lines = overlayRun([[100, 50, 60, 18], [162, 50, 60, 18], [100, 68, 40, 18], [142, 68, 40, 18]]);
  assert.deepStrictEqual([lines[1].left, lines[1].top], [162, 34], 'a first-line link with a tight gap goes above');
  assert.deepStrictEqual([lines[3].left, lines[3].top], [184, 68], 'a second-line link whose above rect holds a first-line link goes right');
  assert.ok(!hit(lines[1], box([100, 50, 60, 18])) && !hit(lines[3], box([100, 50, 60, 18])), 'no badge covers the first line');
  const [inside] = overlayRun([[200, 68, 40, 18]], [{ left: 186, top: 68, width: 12, height: 18, text: 'de' }, { left: 200, top: 50, width: 30, height: 18, text: 'casa' }]);
  assert.deepStrictEqual([inside.left, inside.top], [242, 68], 'a word left and a word above: right of the link when the right is clear');
  const words4 = [{ left: 186, top: 68, width: 12, height: 18, text: 'de' }, { left: 200, top: 50, width: 30, height: 18, text: 'casa' },
    { left: 244, top: 68, width: 12, height: 18, text: 'și' }, { left: 200, top: 86, width: 30, height: 18, text: 'jos' }];
  const [noSup] = overlayRun([[200, 68, 40, 18]], words4);
  assert.deepStrictEqual([noSup.left, noSup.top], [200, 87], 'every slot, the superscript and the right scan blocked: under the line, over the next line\'s leading');
  const words5 = [words4[0], words4[2], words4[3]];
  const [sup] = overlayRun([[200, 68, 40, 18], [208, 36, 40, 18]], words5);
  assert.ok(sup.top === 68 - 17 && sup.left < 200, 'every slot blocked, the line above clear at the badge centre: a superscript whose bottom clears the line box');
  assert.deepStrictEqual([sup.left, sup.top], [193, 51]);
  const [ad] = overlayRun([[112, 50, 70, 18], [112, 49, 200, 18], [60, 44, 40, 40]]);
  assert.deepStrictEqual([ad.left, ad.top], [112, 34], 'an ad name row: a wrapper sharing the left edge and an avatar left of the slot leave the above slot free');
  const img = { left: 270, top: 100, right: 298, bottom: 118 };
  const elementFromPoint = (x, y) => (x >= img.left && x <= img.right && y >= img.top && y <= img.bottom
    ? { nodeType: 1, closest: (sel) => (sel.split(',').includes('img') ? {} : null), contains: () => false } : { nodeType: 1, closest: () => null, contains: () => false });
  const [logo] = overlayRun([[300, 100, 40, 18]], [], { elementFromPoint });
  assert.deepStrictEqual([logo.left, logo.top], [300, 84], 'a logo image in the left slot blocks it');
  const [bare] = overlayRun([[300, 100, 40, 18]]);
  assert.deepStrictEqual([bare.left, bare.top], [284, 100]);
  const page = { nodeType: 1, bg: true, closest: () => null, contains: () => true };
  const [onBg] = overlayRun([[300, 100, 40, 18]], [], { elementFromPoint: () => page }, 'url("hero.jpg")');
  assert.deepStrictEqual([onBg.left, onBg.top], [284, 100], 'a background image on an ancestor of the link is not media beside it');
  const tile = { nodeType: 1, bg: true, closest: () => null, contains: () => false };
  const [offTile] = overlayRun([[300, 100, 40, 18]], [], { elementFromPoint: (x) => (x < 300 ? tile : null) }, 'url("visa.png")');
  assert.deepStrictEqual([offTile.left, offTile.top], [300, 84], 'a background-image tile beside the link blocks the slot');
});

test('page scripts: overlay badges of two adjacent short links never overlap, even when both fall back inside their links', () => {
  const xs = (n) => 'x'.repeat(n);
  const words = [{ left: 60, top: 32, width: 100, height: 18, text: xs(25) }, { left: 60, top: 68, width: 100, height: 18, text: xs(25) },
    { left: 70, top: 50, width: 28, height: 18, text: xs(7) }, { left: 116, top: 50, width: 60, height: 18, text: xs(15) }];
  const got = overlayRun([[100, 50, 6, 18], [108, 50, 6, 18]], words);
  const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  assert.strictEqual(got.length, 2);
  assert.deepStrictEqual([got[0].left, got[0].top], [100, 69], 'every slot blocked: under the first link');
  assert.ok(!hit(got[0], got[1]), `badges overlap: ${JSON.stringify(got)}`);
  const many = overlayRun(Array.from({ length: 12 }, (_v, i) => [100 + i * 9, 50, 7, 18]), words);
  many.forEach((b, i) => many.forEach((c, j) => { if (i < j) assert.ok(!hit(b, c), `badge ${i + 1} overlaps badge ${j + 1}`); }));
});

test('page scripts: a zero-box or hidden numbered element gets no badge and is listed in the overlay legend', () => {
  const got = overlayRun([[100, 50, 40, 18], [300, 100, 0, 0], [400, 100, 40, 1]]);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(overlayLegend, 'not drawn: [2] [3]');
  overlayRun([[100, 50, 40, 18]]);
  assert.strictEqual(overlayLegend, null);
});

test('page scripts: an aria-hidden, inert-wrapped or disabled control gets no badge and is listed in the overlay legend', () => {
  const got = overlayRun([[100, 50, 40, 18], [300, 100, 157, 28, { tagName: 'BUTTON', hidden: true }], [500, 100, 36, 36, { tagName: 'BUTTON', disabled: true }], [600, 100, 40, 18, { hidden: true }]]);
  assert.strictEqual(got.length, 1);
  assert.deepStrictEqual([got[0].left, got[0].top], [84, 50], 'a normal link is still badged');
  assert.strictEqual(overlayLegend, 'not drawn: [2] [3] [4]');
  assert.match(scripts.OVERLAY, /el\.closest\('\[aria-hidden="true"\],\[inert\]'\)/, 'an ancestor counts, not only the element');
  assert.match(scripts.OVERLAY, /el\.matches\(':disabled,\[aria-disabled="true"\]'\)/);
});

test('page scripts: a container taller than the viewport gets a dimmed badge at its clamped corner that displaces no other badge', () => {
  const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const [link, big] = overlayRun([[284, -40, 600, 28000], [288, 9, 50, 16]]);
  assert.deepStrictEqual([link.left, link.top, link.dim], [272, 9, false], 'the link keeps its own slot');
  assert.deepStrictEqual([big.left, big.top, big.dim], [281, 26, true], 'the dimmed badge dodges the real one');
  assert.ok(!hit(big, link));
  const [under, wide] = overlayRun([[0, 300, 1500, 40], [3, 300, 300, 40]]);
  assert.deepStrictEqual([under.left, under.top, wide.left, wide.top, wide.dim], [0, 300, 0, 317, true], 'a box wider than the viewport pushes nothing below it');
  assert.ok(!hit(wide, under));
});

test('page scripts: an inline link with every slot blocked takes the badge under its line, not over its first letters', () => {
  const xs = (n) => 'x'.repeat(n);
  const words = [{ left: 600, top: 461, width: 36, height: 13, text: xs(6) }, { left: 670, top: 461, width: 60, height: 13, text: xs(10) },
    { left: 560, top: 448, width: 200, height: 13, text: xs(30) }, { left: 560, top: 476, width: 200, height: 13, text: xs(30) }];
  const [mobil] = overlayRun([[638, 461, 30, 13]], words);
  assert.deepStrictEqual([mobil.left, mobil.top], [638, 475]);
});

test('page scripts: the overlay legend is a badge too, and a badge chain that would leave the viewport goes right instead', () => {
  const [low] = overlayRun([[2, 784, 200, 60], [300, 100, 0, 0]]);
  assert.strictEqual(overlayLegend, 'not drawn: [2]');
  assert.ok(low.left >= Math.ceil(7.3 * overlayLegend.length + 4) - 1 && low.top === 784, `badge sits on the legend: ${JSON.stringify(low)}`);
  const chain = overlayRun([[100, 760, 200, 60], [100, 770, 200, 60], [100, 780, 200, 60]]);
  assert.deepStrictEqual(chain.map((b) => [b.left, b.top]), [[97, 760], [97, 777], [112, 780]]);
  chain.forEach((b) => assert.ok(b.bottom <= 800, `badge past the viewport: ${JSON.stringify(b)}`));
  const [edge] = overlayRun([[2, 790, 200, 60], [300, 100, 0, 0]]);
  assert.deepStrictEqual([edge.top, edge.bottom], [784, 800], 'a slot that already ends past the viewport is lifted into it when it goes right');
});

test('page scripts: a logo covering only the right part of the left slot still blocks it', () => {
  const img = { left: 292, top: 100, right: 298, bottom: 118 };
  const elementFromPoint = (x, y) => (x >= img.left && x <= img.right && y >= img.top && y <= img.bottom
    ? { nodeType: 1, closest: (sel) => (sel.split(',').includes('img') ? {} : null), contains: () => false } : { nodeType: 1, closest: () => null, contains: () => false });
  const [logo] = overlayRun([[300, 100, 40, 18]], [], { elementFromPoint });
  assert.deepStrictEqual([logo.left, logo.top], [300, 84]);
});

test('page scripts: inputLine labels button-type inputs by their value once; a blank wrapping label falls through to aria, placeholder, name, id', () => {
  const info = { tag: 'input', type: 'button', value: 'Informaţii asociaţie', label: '', name: '', id: 'informatii_asociatie' };
  assert.strictEqual(scripts.inputLine(info), 'Informaţii asociaţie');
  assert.strictEqual(scripts.inputLine({ ...info, label: 'Informaţii asociaţie' }), 'Informaţii asociaţie', 'a label that resolves to the value reads the same');
  assert.strictEqual(scripts.inputLine({ tag: 'input', type: 'submit', value: 'Card bancar', label: '\n ' }), 'Card bancar');
  const rows = [
    [{ tag: 'input', type: 'text', value: '', label: ' ', aria: 'Cauta' }, 'Cauta'],
    [{ tag: 'input', type: 'text', value: 'abc', label: '', placeholder: 'Nume' }, 'Nume = "abc"'],
    [{ tag: 'input', type: 'text', value: '', label: '', name: 'q', id: 'x' }, 'q'],
    [{ tag: 'input', type: 'text', value: '', label: '', id: 'x' }, 'x'],
    [{ tag: 'input', type: 'email', value: 'a@b', label: 'Email' }, 'Email = "a@b"'],
    [{ tag: 'input', type: 'password', value: 'secret', label: 'Parola' }, 'Parola (operator only)'],
    [{ tag: 'input', type: 'checkbox', value: 'on', checked: true, label: 'Tine-ma minte' }, 'Tine-ma minte = "on" [x]'],
    [{ tag: 'input', type: 'button', value: '', label: '', name: 'go' }, 'go'],
    [{ tag: 'input', type: 'submit', value: '  ', label: '', aria: 'Trimite' }, 'Trimite'],
  ];
  for (const [d, want] of rows) assert.strictEqual(scripts.inputLine(d), want, JSON.stringify(d));
  assert.match(scripts.READ_INTERACTIVE(false, {}), /line = inputLine\(\{\n\s*tag, type: el\.type, value: el\.value/);
});

test('page scripts: look-alike long labels show a head and their distinguishing tail; unique ones keep the clip', () => {
  const head = 'Lista de plată pentru Bloc M4 Tabelul cu sumele de plată pe luna ';
  const out = scripts.distinctClips([head + '[Document generat 04 Septembrie 2026]', head + '[Document generat 03 August 2026]', 'Acasa', 'x'.repeat(80)]);
  assert.deepStrictEqual(out, ['Lista de plată pentru Bloc M4 … generat 04 Septembrie 2026]', 'Lista de plată pentru Bloc M4 … generat 03 August 2026]', null, null]);
  const mid = (m) => `${head}${m} anexa la lista de plata a lunii curente`;
  assert.deepStrictEqual(scripts.distinctClips([mid('A1'), mid('B2')]), [null, null], 'same head and tail keep the clip');
  const sep = head + '[Document generat 04 Septembrie 2026]';
  assert.deepStrictEqual(scripts.distinctClips([sep, sep, head + '[Document generat 03 August 2026]']),
    [out[0], out[0], out[1]], 'two identical labels and one other: the other gets its tail, the twins stay identical');
  assert.match(scripts.READ_INTERACTIVE(false, {}), /const tails = distinctClips\(items\.map/);
});

test('page scripts: LOGIN_PROBE reads a localized sign-out link (Ieşire → index.php?page=5) as signed in', () => {
  const { loginLabel } = require('../plugins/browser-pane/read-format');
  const link = (text, href) => ({
    tagName: 'A', innerText: text, textContent: text, parentElement: null, type: '',
    getAttribute: (k) => (k === 'href' ? href : null), matches: () => false,
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 60, height: 18, right: 70, bottom: 28 }),
  });
  const run = (els) => new Function('getComputedStyle', 'document', 'location', 'scrollX', 'scrollY', 'innerWidth', 'innerHeight', `return ${scripts.LOGIN_PROBE}`)(
    () => ({ visibility: 'visible', display: 'inline', opacity: '1', clip: 'auto', clipPath: 'none', overflow: 'visible', overflowX: 'visible' }),
    { querySelectorAll: () => els, documentElement: { scrollWidth: 1200, scrollHeight: 800 }, body: { innerText: '' } },
    { hostname: 'www.e-bloc.ro', pathname: '/index.php' }, 0, 0, 1200, 800);
  const ebloc = run([link('Avizier', 'index.php?page=1'), link('Ieşire', 'index.php?page=5')]);
  assert.strictEqual(ebloc.logoutLink, true);
  assert.strictEqual(loginLabel(ebloc), 'signed in');
  assert.strictEqual(run([link('', '/account/logout')]).logoutLink, true);
  assert.strictEqual(run([link('Avizier', 'index.php?page=1'), link('Ieşirea blocului', '/x')]).logoutLink, false);
  assert.strictEqual(loginLabel(run([link('Avizier', 'index.php?page=1')])), 'none');
});

test('page scripts: LOGIN_PROBE ignores a hidden Sign out and a long product title with deconectare; a short visible exit still signs in', () => {
  const { loginLabel } = require('../plugins/browser-pane/read-format');
  const link = (text, href, hidden = false) => ({
    tagName: 'A', innerText: text, textContent: text, parentElement: null, type: '',
    getAttribute: (k) => (k === 'href' ? href : null), matches: () => false,
    getBoundingClientRect: () => (hidden ? { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 } : { left: 10, top: 10, width: 60, height: 18, right: 70, bottom: 28 }),
  });
  const run = (els) => new Function('getComputedStyle', 'document', 'location', 'scrollX', 'scrollY', 'innerWidth', 'innerHeight', `return ${scripts.LOGIN_PROBE}`)(
    () => ({ visibility: 'visible', display: 'inline', opacity: '1', clip: 'auto', clipPath: 'none', overflow: 'visible', overflowX: 'visible' }),
    { querySelectorAll: () => els, documentElement: { scrollWidth: 1200, scrollHeight: 800 }, body: { innerText: '' } },
    { hostname: 'www.example.com', pathname: '/' }, 0, 0, 1200, 800);
  const guardian = run([link('Sign out', '/signout', true), link('Sign in', '/signin')]);
  assert.strictEqual(guardian.loggedInHint, null);
  assert.strictEqual(guardian.logoutLink, false);
  assert.strictEqual(loginLabel(guardian), 'none');
  assert.strictEqual(run([link('Sign out', '/signout', true)]).loggedInHint, null);
  assert.strictEqual(run([link('Sign out', '/signout'), link('Sign in', '/signin')]).loggedInHint, null);
  const emag = run([link('Fierbator apa Bosch TWK70B03, 1.7 l, 2400 W, Deconectare automata', '/fierbator/pd/X1'), link('Contul meu', '/user/login')]);
  assert.strictEqual(emag.loggedInHint, null);
  assert.strictEqual(emag.logoutLink, false);
  assert.strictEqual(loginLabel(emag), 'none');
  const kettle = run([link('Fierbator apa Bosch TWK70B03, 1.7 l, 2400 W, Deconectare automata', '/fierbator/pd/X1')]);
  assert.strictEqual(kettle.loggedInHint, null);
  assert.strictEqual(kettle.logoutLink, false);
  assert.strictEqual(run([link('Fierbator apa Bosch …', '/fierbator-apa-bosch-2400-w-1-7-l-cana-sticla-filtru-anticalcar-deconectare-automata-inox-twk70b03/pd/DTXYTCBBM/')]).logoutLink, false);
  assert.strictEqual(run([link('', '/account/logout')]).logoutLink, true);
  assert.strictEqual(run([link('Sign out', '/signout'), link('Contul meu', '/user/login')]).logoutLink, false);
  assert.strictEqual(run([link('Sign out', '/signout')]).logoutLink, true);
  const ebloc = run([link('Ieşire', 'index.php?page=5')]);
  assert.strictEqual(ebloc.loggedInHint, 'logout');
  assert.strictEqual(loginLabel(ebloc), 'signed in');
});

test('page scripts: LOGIN_PROBE treats a password-change form on a signed-in page as signed in, not a sign-in hold', () => {
  const { loginLabel } = require('../plugins/browser-pane/read-format');
  const rect = () => ({ left: 10, top: 10, width: 60, height: 18, right: 70, bottom: 28 });
  const link = (text, href) => ({
    tagName: 'A', innerText: text, textContent: text, parentElement: null, type: '',
    getAttribute: (k) => (k === 'href' ? href : null), matches: () => false, getBoundingClientRect: rect,
  });
  const pw = (attrs = {}) => ({
    tagName: 'INPUT', type: 'password', innerText: '', textContent: '', parentElement: null, id: attrs.id || '',
    getAttribute: (k) => (k in attrs ? attrs[k] : null), matches: () => false, getBoundingClientRect: rect,
  });
  const run = (els) => new Function('getComputedStyle', 'document', 'location', 'scrollX', 'scrollY', 'innerWidth', 'innerHeight', `return ${scripts.LOGIN_PROBE}`)(
    () => ({ visibility: 'visible', display: 'inline', opacity: '1', clip: 'auto', clipPath: 'none', overflow: 'visible', overflowX: 'visible' }),
    { querySelectorAll: () => els, documentElement: { scrollWidth: 1200, scrollHeight: 800 }, body: { innerText: '' } },
    { hostname: 'www.e-bloc.ro', pathname: '/index.php' }, 0, 0, 1200, 800);
  const login = run([pw({ name: 'pass' })]);
  assert.strictEqual(login.password, true);
  assert.strictEqual(loginLabel(login), 'password field');
  const change = run([link('Ieşire', 'index.php?page=5'), pw({ name: 'parola' }), pw({ name: 'parola2' })]);
  assert.strictEqual(change.password, false);
  assert.strictEqual(change.passwordChange, true);
  assert.strictEqual(change.logoutLink, true);
  assert.strictEqual(loginLabel(change), 'signed in (password-change form)');
  assert.strictEqual(run([link('Ieşire', 'index.php?page=5'), pw({ autocomplete: 'new-password' })]).password, false);
  assert.strictEqual(run([link('Ieşire', 'index.php?page=5'), pw({ name: 'parola_noua' })]).password, false);
  const reauth = run([link('Ieşire', 'index.php?page=5'), pw({ name: 'pass' })]);
  assert.strictEqual(reauth.password, true);
  assert.strictEqual(loginLabel(reauth), 'password field');
});

test('page scripts: wallScan skips script text, quotes the gate sentence and never takes body or html as the gate box', () => {
  const src = scripts.READ_TEXT(false);
  assert.ok(src.includes('const SKIP = new Set(["SCRIPT","STYLE","NOSCRIPT","TEMPLATE"]);'));
  assert.ok(src.includes('all = textsOf(document.body, []).filter(t => t.data.trim() && t.parentElement && vis(t.parentElement));'));
  assert.ok(src.includes('(vis(e) || boxVis(e))'));
  assert.ok(src.includes('for (const t of textsOf(box, [])) if (WALL.test(norm(t.data)) && t.parentElement && vis(t.parentElement)) return { text: quote(t.data, t.parentElement, WALL), n: null };'));
  assert.ok(src.includes('return { text: clip(box.innerText), n: null };'));
  assert.ok(src.includes('if (!wholeLabel(t) && !moreLink(t) || floating(t)) return { text: quote(t.data, t.parentElement, re), b };'));
  assert.ok(src.includes('const TOKEN = /^(paywall|regwall|piano-.*|tp-modal|meter(ed)?-?(gate|wall|modal|content)?|gate-toast|article-gate)$/i;'));
  assert.ok(src.includes('[...e.classList].some(c => TOKEN.test(c))'));
  assert.ok(src.includes('e !== document.body && e !== document.documentElement'));
  assert.ok(src.includes("(WALL.test(e.innerText) || String(e.innerText).trim().length <= 300)"));
  assert.ok(src.includes('[id*=gate-toast i]'));
});

test('page scripts: wallScan picks over the whole page nearest the root end, skips chrome and in-body CTA labels, ranks the badge last and surfaces errors', () => {
  const src = scripts.READ_TEXT(false);
  assert.ok(!scripts.WALL_RE.source.includes('members?-only story'));
  assert.ok(!scripts.WALL_RE.test('Member-only story'));
  assert.ok(scripts.WALL_WEAK_RE.test('Member-only story'));
  assert.ok(src.includes("const boxVis = e => { const bw = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); let k = 0; for (let t = bw.nextNode(); t && k < 400; t = bw.nextNode(), k++) if (t.data.trim() && !scripted(t) && vis(t.parentElement)) return true; return false; };"));
  assert.ok(src.includes("const chrome = t => { const p = t.parentElement; const h = p && p.closest('header,nav,[role=banner],[role=navigation]'); return !!h && !h.closest('article,main,[role=main]'); };"));
  assert.ok(src.includes("const wholeLabel = t => { const a = t.parentElement && t.parentElement.closest('a,button,[role=button]'); if (!a) return false; const icon = s => s.trim().length <= 2 && !/[\\p{L}\\p{N}]/u.test(s); return norm([...a.childNodes].map(n => n.nodeType === 3 ? n.data : (n.innerText || '')).filter(s => !icon(s)).join(' ')).trim() === norm(t.data).trim(); };"));
  assert.ok(src.includes("const floating = t => { let k = 0; for (let e = t.parentElement; e && k < 6; e = e.parentElement, k++) if (['fixed', 'sticky'].includes(getComputedStyle(e).position)) return true; return false; };"));
  assert.ok(src.includes("const labels = [...b.querySelectorAll('a,button,[role=button]')].map(a => norm(a.innerText).trim()).filter(l => l && re.test(l));"));
  assert.ok(src.includes("for (const l of labels) rest = rest.replace(l, ' ');"));
  assert.ok(src.includes('return re.test(rest) || (/\\b(sign in|log in|subscribe)\\b/i.test(rest) && labels.some(l => /\\b(start a free trial|create (a free )?account)\\b/i.test(l)));'));
  assert.ok(src.includes('      if (!bt) return null;\n      if (re.test(own) && bt === own.trim() && wholeLabel(t) && teaser(b) && GATE_LINK.test(own) && !moreLink(t) && truncates(b)) return { text: quote(t.data, t.parentElement, re), b };\n      return gated(b, bt, re) ? { text: quote(authored(b), b, re), b } : null;'));
  assert.ok(src.includes('const GATE_LINK = /\\b(subscribe|sign (in|up)|log in|create (a free )?account|already a subscriber|abonează-te|pentru a citi)\\b/i;'));
  assert.ok(src.includes('const truncates = (b) =>'));
  assert.ok(src.includes("a.matches('.more-link,[rel=bookmark]')"));
  assert.ok(src.includes("const sentence = (s, re) => { const segs = norm(s).split(/(?<=[.!?])\\s+|\\s*\\|\\s*/).map(x => x.trim()).filter(Boolean); const hits = segs.filter(x => re.test(x)); return clip(hits.length ? hits.sort((a, b) => b.split(' ').length - a.split(' ').length)[0] : s.replace(/^\\s*\\|\\s*|\\s*\\|\\s*$/g, '')); };"));
  assert.ok(src.includes('(r => r.width > 2 && r.height > 2)(t.parentElement.getBoundingClientRect())'));
  assert.ok(src.includes('if (j >= tc.length) { over = true; return ch; }'));
  assert.ok(src.includes('return over ? null : out;'));
  assert.ok(src.includes("const tc2 = norm(textsOf(b, []).filter(t => !scripted(t)).map(t => t.data).join(' '));"));
  assert.ok(src.includes('return zip(tc) || zip(tc2) || it;'));
  assert.ok(src.includes('let i = -1; for (const x of textsOf(b, [])) { const k = all.indexOf(x); if (k > i) i = k; } const after = all.slice(i + 1)'));
  assert.ok(src.includes("const teaser = b => { for (let e = b, k = 0; e && k < 4; e = e.parentElement, k++) { const p = e.previousElementSibling; if (p) return norm(p.innerText || '').trim().length >= 80; } return false; };"));
  const authored = new Function('norm', 'textsOf', 'vis', 'scripted', `return ${/const authored = (b => \{[\s\S]*?\n    \});/.exec(src)[1]}`)((x) => String(x || '').replace(/\s+/g, ' '), (b) => b.nodes, (e) => !e.hidden, () => false);
  const node = (data, w = 100, hidden = false) => ({ data, parentElement: { hidden, getBoundingClientRect: () => ({ width: w, height: w }) } });
  assert.strictEqual(authored({ innerText: 'TO READ THIS STORY,\nSIGN IN.', nodes: [node('to read this story, Sign in.')] }), 'to read this story, Sign in.');
  assert.strictEqual(authored({ innerText: 'CREATE AN ACCOUNT.\nTHE AUTHOR', nodes: [node('Create an account.'), node('The author')] }), 'Create an account. The author');
  assert.strictEqual(authored({ innerText: 'THIS IS YOUR LAST FREE ARTICLE |', nodes: [node('This is your last free article'), node('Subscriber benefits', 1), node('|')] }), 'This is your last free article |');
  assert.strictEqual(authored({ innerText: 'LAST FREE ARTICLE EXTRA', nodes: [node('last free article')] }), 'LAST FREE ARTICLE EXTRA');
  assert.strictEqual(authored({ innerText: 'LAST FREE ARTICLE\nSubscriber benefits |', nodes: [node('Last free article'), node('Subscriber benefits', 1), node('|')] }), 'Last free article Subscriber benefits |');
  assert.ok(src.includes('return blockText(blk) ? clip(authored(blk)) : sentence(s, re);'));
  assert.ok(src.includes("const norm = s => String(s || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ');"));
  assert.ok(src.includes("if (!blockTexts.has(b)) { const bt = norm(b.innerText).trim(); blockTexts.set(b, bt.length <= 300 ? bt : ''); }"));
  assert.ok(src.includes('const seen = new Set();'));
  assert.ok(src.includes('if (b && seen.has(b)) continue;'));
  assert.ok(src.includes('if (hit.b) seen.add(hit.b);'));
  assert.ok(src.includes('if (i > endIdx) return { text: hit.text, n: null };'));
  assert.ok(src.includes('return before ? { text: before.text, n: null } : null;'));
  assert.ok(src.includes('const textsOf = (n, out) => { for (const c of n.childNodes) { if (c.nodeType === 3) out.push(c); else if (c.nodeType === 1 && !SKIP.has(c.tagName)) { textsOf(c, out); if (c.shadowRoot) textsOf(c.shadowRoot, out); } } return out; };'));
  assert.ok(src.includes('const inside = (r, t) => { for (let n = t; n; n = n.parentNode || n.host) if (n === r) return true; return false; };'));
  assert.ok(src.includes('const inRoot = all.filter(t => inside(root, t));'));
  assert.ok(src.includes('endIdx = inRoot.length ? all.lastIndexOf(inRoot[inRoot.length - 1]) : -1;'));
  assert.ok(!src.includes('createTreeWalker(document.body'));
  assert.ok(src.includes("} catch (e) { return { text: null, error: String(e && e.message || e).slice(0, 80) }; }"));
  assert.ok(!src.includes('fixedBar'));
  assert.ok(!src.includes('tail.concat(after)'));
  const strong = src.indexOf('const strong = pick(WALL);');
  const box = src.indexOf('const box =', strong);
  const weak = src.indexOf('return pick(WEAK);');
  assert.ok(strong > 0 && box > strong && weak > box);
});

test('page scripts: READ_TEXT and PAGE_TEXT render content-visibility:auto subtrees in the off-screen clone and drop the style with the host', () => {
  for (const src of [scripts.READ_TEXT(false), scripts.PAGE_TEXT]) {
    assert.ok(src.includes("host.setAttribute('data-cxb-read-host', '');"));
    assert.ok(src.includes("const cv = document.createElement('style'); cv.textContent = '[data-cxb-read-host] * { content-visibility: visible !important; }'; document.head.appendChild(cv);"));
    assert.ok(src.indexOf('document.head.appendChild(cv);') < src.indexOf('document.body.appendChild(host);'));
    assert.ok(src.includes('host.remove(); cv.remove();'));
  }
});

test('page scripts: READ_TEXT and PAGE_TEXT carry each open shadow root into its host\'s clone twin', () => {
  const cut = "if (orig && !orig.getClientRects().length && getComputedStyle(orig).display !== 'contents' && !(twin.parentElement && twin.parentElement.closest('[data-cxb-cut]'))) { twin.setAttribute('data-cxb-cut', ''); twin.textContent = ''; }";
  const zip = "const origs = [...root.querySelectorAll('*')]; [...clone.querySelectorAll('*')].forEach((twin, i) => { const orig = origs[i]; " + cut + " else if (orig && orig.shadowRoot) twin.append(...[...orig.shadowRoot.childNodes].map(n => n.cloneNode(true))); });";
  const read = scripts.READ_TEXT(false);
  const readZip = "const origs = [...root.querySelectorAll('*')]; [...clone.querySelectorAll('*')].forEach((twin, i) => { const orig = origs[i]; " + cut + " else if (orig && getComputedStyle(orig).visibility === 'hidden' && (orig.innerText || '').trim() === '') { twin.textContent = ''; } else if (orig && getComputedStyle(orig).opacity === '0' && !faded(orig) && (orig.innerText || '').trim().length >= 3) { twin.prepend(Object.assign(document.createElement('div'), { textContent: '(hidden)' })); twin.append(Object.assign(document.createElement('div'), { textContent: '(end hidden)' })); } if (orig && orig.shadowRoot && !twin.hasAttribute('data-cxb-cut')) twin.append(...[...orig.shadowRoot.childNodes].map(n => n.cloneNode(true)));";
  assert.ok(read.includes(readZip));
  assert.ok(read.indexOf("c.prepend('(was ')") < read.indexOf(readZip) && read.indexOf(readZip) < read.indexOf('clone.querySelectorAll(DROP)'));
  assert.ok(scripts.PAGE_TEXT.includes('const root = document.body;\n  ' + zip));
  assert.ok(scripts.PAGE_TEXT.indexOf(zip) < scripts.PAGE_TEXT.indexOf("clone.querySelectorAll('script,style"));
});

test('page scripts: READ_TEXT gives two-digit superscript cents a decimal separator', () => {
  const src = scripts.READ_TEXT(false);
  assert.ok(src.includes("clone.querySelectorAll('sup').forEach(c => {"));
  assert.ok(src.includes("if (/^\\d{2}$/.test(String(c.textContent || '').trim()) && /\\d$/.test(p)) c.prepend(/\\d,\\d{3}$/.test(p) ? '.' : ',');"));
});

test('page scripts: READ_TEXT renders struck-through text as (was …)', () => {
  const src = scripts.READ_TEXT(false);
  assert.ok(src.includes("String(getComputedStyle(e).textDecorationLine || '').includes('line-through')"));
  assert.ok(src.includes("wrapped.add(c); c.prepend('(was '); c.append(')');"));
});

test('page scripts: READ_TEXT tags the top element faded by its own opacity:0 as (hidden), after the struck pass', () => {
  const src = scripts.READ_TEXT(false);
  assert.ok(src.includes("else if (orig && getComputedStyle(orig).opacity === '0' && !faded(orig) && (orig.innerText || '').trim().length >= 3) { twin.prepend(Object.assign(document.createElement('div'), { textContent: '(hidden)' })); twin.append(Object.assign(document.createElement('div'), { textContent: '(end hidden)' })); }"));
  assert.ok(src.includes("twin.setAttribute('data-cxb-cut', ''); twin.textContent = '';"));
  assert.ok(scripts.PAGE_TEXT.includes("twin.setAttribute('data-cxb-cut', ''); twin.textContent = '';"));
  assert.ok(src.indexOf("twin.prepend(Object.assign(document.createElement('div'), { textContent: '(hidden)' }))") > src.indexOf("c.prepend('(was ')"));
});

test('page scripts: a filter or search reset is not deletion; Delete account and Remove item still are', () => {
  const c = scripts.consequentialOf;
  assert.strictEqual(c({ label: 'Sterge toate filtrele' }), null);
  assert.strictEqual(c({ label: 'Clear filters' }), null);
  assert.strictEqual(c({ label: 'Delete account' }), 'deletion');
  assert.strictEqual(c({ label: 'Remove item' }), 'deletion');
});

test('page scripts: LOGIN_PROBE reads a short Cloudflare "Just a moment" page as a captcha, a long page with that title or a plain page as none', () => {
  const run = (title, text) => new Function('getComputedStyle', 'document', 'location', 'scrollX', 'scrollY', 'innerWidth', 'innerHeight', `return ${scripts.LOGIN_PROBE}`)(
    () => ({ visibility: 'visible', display: 'block', opacity: '1', clip: 'auto', clipPath: 'none', overflow: 'visible', overflowX: 'visible' }),
    { title, querySelectorAll: () => [], documentElement: { scrollWidth: 1200, scrollHeight: 800 }, body: { innerText: text } },
    { hostname: 'ghiseul.ro', pathname: '/' }, 0, 0, 1200, 800);
  assert.ok(scripts.LOGIN_PROBE.includes('/^just a moment|checking your browser|verify you are human|attention required/i.test(document.title)'));
  assert.strictEqual(run('Just a moment...', 'Performing security verification').captcha, true);
  assert.strictEqual(run('Attention Required! | Cloudflare', 'Sorry, you have been blocked').captcha, true);
  assert.strictEqual(run('Just a moment...', 'x'.repeat(700)).captcha, false);
  assert.strictEqual(run('Ghiseul.ro', 'Performing security verification').captcha, false);
});

test('child: a challenges.cloudflare.com frame makes the probe a captcha hold; an ordinary frame does not', () => {
  const { framesOf, challenged, signinOf } = require('../plugins/browser-pane/child');
  const wcOf = (...urls) => { const mainFrame = { url: 'https://ghiseul.ro/' }; return { mainFrame: Object.assign(mainFrame, { framesInSubtree: [mainFrame, ...urls.map((url) => ({ url }))] }) }; };
  const cf = wcOf('about:blank', 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0');
  assert.deepStrictEqual(framesOf(cf), ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0']);
  assert.strictEqual(signinOf(challenged({ captcha: false }, framesOf(cf), 'Just a moment...')), 'captcha');
  assert.strictEqual(signinOf(challenged({ captcha: false }, framesOf(cf), 'Contact form')), null, 'an invisible Turnstile on an ordinary page is no hold');
  assert.strictEqual(signinOf(challenged({ captcha: false }, framesOf(wcOf('https://www.google.com/recaptcha/api2/bframe?k=x')), 'Just a moment...')), null, 'a reCAPTCHA v3 frame is left to the visible-iframe probe');
  assert.strictEqual(signinOf(challenged({ captcha: false }, framesOf(wcOf('https://www.youtube.com/embed/x')), 'Just a moment...')), null);
  assert.deepStrictEqual(framesOf({ mainFrame: null }), []);
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'browser-pane', 'child.js'), 'utf8');
  assert.ok(src.includes('const login = challenged(await probe(svc), framesOf(svc.wc), svc.wc.getTitle());'));
  assert.ok(src.includes('const login = challenged(await probe(svc), allFrames, wc.getTitle());'));
});

test('page scripts: LOGIN_PROBE profile hint is void while a visible Sign in link is on the page', () => {
  const { loginLabel } = require('../plugins/browser-pane/read-format');
  const rect = () => ({ left: 10, top: 10, width: 60, height: 18, right: 70, bottom: 28 });
  const el = (tagName, text, href, profile = false) => ({
    tagName, innerText: text, textContent: text, parentElement: null, type: '',
    getAttribute: (k) => (k === 'href' ? href : null), matches: (sel) => profile && sel.includes('/profile'), getBoundingClientRect: rect,
  });
  const run = (els) => new Function('getComputedStyle', 'document', 'location', 'scrollX', 'scrollY', 'innerWidth', 'innerHeight', `return ${scripts.LOGIN_PROBE}`)(
    () => ({ visibility: 'visible', display: 'inline', opacity: '1', clip: 'auto', clipPath: 'none', overflow: 'visible', overflowX: 'visible' }),
    { querySelectorAll: () => els, documentElement: { scrollWidth: 1200, scrollHeight: 800 }, body: { innerText: '' } },
    { hostname: 'www.theguardian.com', pathname: '/uk' }, 0, 0, 1200, 800);
  const profile = el('A', 'Profile', '/profile', true);
  const gated = run([profile, el('A', 'Sign in', '/signin')]);
  assert.strictEqual(gated.loggedInHint, null);
  assert.strictEqual(loginLabel(gated), 'none');
  assert.strictEqual(run([profile, el('A', 'Contul meu', '/user/login')]).loggedInHint, null);
  assert.strictEqual(run([profile, el('A', 'Sign in to comment', '/discussion')]).loggedInHint, 'profile');
  const signed = run([profile, el('A', 'News', '/news')]);
  assert.strictEqual(signed.loggedInHint, 'profile');
  assert.strictEqual(loginLabel(signed), 'signed in');
});

test('page scripts: LOGIN_PROBE reads a hidden profile link or composer as no hint; visible ones keep profile/composer', () => {
  const shown = { left: 10, top: 10, width: 60, height: 18, right: 70, bottom: 28 };
  const gone = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  const el = (sel, hidden) => ({
    tagName: 'A', innerText: 'x', textContent: 'x', parentElement: null, type: '',
    getAttribute: () => null, matches: (s) => s.includes(sel), getBoundingClientRect: () => (hidden ? gone : shown),
  });
  const run = (els) => new Function('getComputedStyle', 'document', 'location', 'scrollX', 'scrollY', 'innerWidth', 'innerHeight', `return ${scripts.LOGIN_PROBE}`)(
    () => ({ visibility: 'visible', display: 'inline', opacity: '1', clip: 'auto', clipPath: 'none', overflow: 'visible', overflowX: 'visible' }),
    { querySelectorAll: () => els, documentElement: { scrollWidth: 1200, scrollHeight: 800 }, body: { innerText: '' } },
    { hostname: 'contactform7.com', pathname: '/' }, 0, 0, 1200, 800);
  assert.strictEqual(run([el('/profile', true)]).loggedInHint, null);
  assert.strictEqual(run([el('[contenteditable=true][role=textbox]', true)]).loggedInHint, null);
  assert.strictEqual(run([el('/profile', false)]).loggedInHint, 'profile');
  assert.strictEqual(run([el('[contenteditable=true][role=textbox]', false)]).loggedInHint, 'composer');
});

test('page scripts: LOGIN_PROBE holds a captcha only beside a password field or covering a quarter of the viewport; an invisible badge never', () => {
  const box = (w, h) => ({ left: 10, top: 10, width: w, height: h, right: 10 + w, bottom: 10 + h });
  const frame = (src, rect, badge = false) => ({
    tagName: 'IFRAME', src, innerText: '', textContent: '', parentElement: null, type: '',
    getAttribute: () => null, matches: () => false, closest: (s) => (badge && s === '.grecaptcha-badge' ? {} : null), getBoundingClientRect: () => rect,
  });
  const pwd = { tagName: 'INPUT', type: 'password', innerText: '', textContent: '', parentElement: null, getAttribute: () => null, matches: () => false, getBoundingClientRect: () => box(200, 30) };
  const run = (els, text = 'Contact us '.repeat(60)) => new Function('getComputedStyle', 'document', 'location', 'scrollX', 'scrollY', 'innerWidth', 'innerHeight', `return ${scripts.LOGIN_PROBE}`)(
    () => ({ visibility: 'visible', display: 'block', opacity: '1', clip: 'auto', clipPath: 'none', overflow: 'visible', overflowX: 'visible' }),
    { title: 'Contact', querySelectorAll: () => els, documentElement: { scrollWidth: 1200, scrollHeight: 800 }, body: { innerText: text } },
    { hostname: 'contactform7.com', pathname: '/' }, 0, 0, 1200, 800);
  const v2 = 'https://www.google.com/recaptcha/api2/anchor?k=x&size=normal';
  assert.strictEqual(run([frame('https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible', box(256, 60))]).captcha, false);
  assert.strictEqual(run([frame(v2, box(256, 60), true)]).captcha, false);
  assert.strictEqual(run([frame(v2, box(304, 78))]).captcha, false);
  assert.strictEqual(run([frame(v2, box(304, 78)), pwd]).captcha, true);
  assert.strictEqual(run([frame('https://challenges.cloudflare.com/x', box(800, 400))]).captcha, true);
  assert.ok(scripts.LOGIN_PROBE.includes("!/size=invisible/.test(el.src || '') && !el.closest('.grecaptcha-badge')"));
  const name = { tagName: 'INPUT', type: 'text', innerText: '', textContent: '', parentElement: null, getAttribute: (k) => (k === 'name' ? 'name' : null), matches: () => false, getBoundingClientRect: () => box(200, 30) };
  const sorry = 'Our systems have detected unusual traffic from your computer network. '.repeat(3);
  assert.strictEqual(run([frame(v2, box(304, 78))], sorry).captcha, true, 'a sparse page with nothing else to fill');
  assert.strictEqual(run([frame(v2, box(304, 78)), name], sorry).captcha, false, 'a visible field to fill');
  assert.strictEqual(run([frame(v2, box(304, 78))], 'x'.repeat(700)).captcha, false, 'a 700-char body');
  assert.strictEqual(run([frame('https://challenges.cloudflare.com/x', box(300, 65))], sorry).captcha, false, 'a Cloudflare frame is left to the title rule');
  assert.ok(scripts.LOGIN_PROBE.includes("const sparse = body.trim().length < 600 && !fillable && captchaFrames.some(el => !/challenges\\.cloudflare\\.com/.test(el.src || ''));"));
  assert.ok(scripts.LOGIN_PROBE.includes('captcha: interstitial || (captchaFrames.length > 0 && (pwds.length > 0 || captchaFrames.some(big) || sparse)),'));
});

test('page scripts: READ_TEXT falls back to body when the best-scoring block holds under half the body text', () => {
  assert.ok(scripts.READ_TEXT(false).includes("(best.innerText || '').length < 0.5 * ((document.body && document.body.innerText) || '').length ? document.body : best"));
});

test('numberVerdict: an unresolved number is ambiguous when its base key is on the page under another key, else gone', () => {
  const base = K.keyOf({ kind: 'button', label: 'Delete', href: '' });
  const stored = K.storedKey(base, 1, 'Factura A');
  assert.strictEqual(numberVerdict(null, stored, { 5: K.storedKey(base, 1, 'Factura B') }), 'ambiguous');
  assert.strictEqual(numberVerdict(null, stored, { 5: K.keyOf({ kind: 'link', label: 'Acasa', href: '/' }) }), 'gone');
  assert.strictEqual(numberVerdict(null, stored, null), 'gone');
  assert.strictEqual(numberVerdict('ok', stored, null), 'ok');
});

test('numberVerdict: a header whose sort label flipped after the click is the same element, not ambiguous or retired', () => {
  const stored = K.keyOf({ kind: 'button', label: 'Age: Activate to sort', href: '' });
  const keys = { 55: K.keyOf({ kind: 'button', label: 'Name: Activate to sort', href: '' }), 56: K.keyOf({ kind: 'button', label: 'Age: Activate to invert sorting', href: '' }) };
  assert.strictEqual(numberVerdict(keys[56] === stored ? 'ok' : null, stored, keys), 'ok');
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

test('page scripts: VALUE_ACTIVE reads the focused text field after a key, never a password or a code; a radio, checkbox or select answers its choice', () => {
  const run = (tag, type, value, attrs = {}) => new Function('document', `return ${scripts.VALUE_ACTIVE}`)({
    activeElement: { tagName: tag.toUpperCase(), type, value, isContentEditable: false, shadowRoot: null, getAttribute: (k) => attrs[k] || null } });
  assert.strictEqual(run('input', 'text', 'ab'), 'ab');
  assert.strictEqual(run('textarea', '', 'x'.repeat(500)).length, 200);
  assert.strictEqual(run('input', 'password', 'hunter2'), null);
  assert.strictEqual(run('input', 'text', '123456', { autocomplete: 'one-time-code' }), null);
  const node = (tag, o = {}) => ({ tagName: tag.toUpperCase(), type: o.type || '', name: o.name || '', form: null, value: o.value || '', checked: !!o.checked, multiple: false,
    isContentEditable: false, shadowRoot: null, labels: o.label ? [{ innerText: o.label }] : [], innerText: '', id: '',
    getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [], closest: () => null, getBoundingClientRect: () => ({ height: 20 }) });
  const probe = (el) => new Function('document', `return ${scripts.VALUE_ACTIVE}`)({ activeElement: el });
  const livrare = node('input', { type: 'radio', name: 'm', value: 'delivery', label: 'Livrare' });
  const ridicare = node('input', { type: 'radio', name: 'm', value: 'pickup', label: 'Ridicare', checked: true });
  const other = node('input', { type: 'radio', name: 'x', value: 'x', label: 'Other', checked: true });
  livrare.getRootNode = () => ({ querySelectorAll: () => [other, livrare, ridicare] });
  assert.deepStrictEqual(probe(livrare), { kind: 'choice', label: 'Ridicare', value: 'pickup' }, 'the group\'s checked radio after the key');
  assert.deepStrictEqual(probe(node('input', { type: 'checkbox', value: 'on', label: 'Remember me', checked: true })), { kind: 'choice', label: 'Remember me [x]', value: 'on' });
  const sel = node('select', { value: 'card', label: 'Payment method' });
  sel.options = [{ text: 'Cash' }, { text: ' Card  bancar ' }];
  sel.selectedIndex = 1;
  assert.deepStrictEqual(probe(sel), { kind: 'choice', select: true, label: 'Card bancar', value: 'card' });
  assert.match(CHILD_SRC, /else if \(value && value\.kind === 'choice' && typeof value\.label === 'string'\) \{\n\s*out\.choice = value\.label;\n\s*if \(value\.select\) out\.choiceKind = 'select';/);
  assert.match(scripts.INSPECT(1), /\.\.\.\(textual && !secret\(el\) \? \{ value: String\(el\.value == null \? '' : el\.value\) \} : \{\}\),/);
  assert.match(CHILD_SRC, /const out = await withChange\(svc, pre, \{ \.\.\.nav\(\), idle: idleOf\(idle\) \}, lateMsFor\(op\)\);\n\s*if \(out\.changed === '' && !wc\.isDestroyed\(\)\) \{\n\s*const value = await inIsolated\(wc, scripts\.VALUE_ACTIVE\);/);
});

test('page scripts: SCROLL_INFO counts article first, then [role=listitem], then the rows of the largest list under the read root (a nav bigger than the main list wins), with y/height/vh', () => {
  const LISTS = 'ul,ol,tbody,table,[role=list]';
  const listOf = (n) => ({ children: [...Array.from({ length: n }, () => ({ matches: (s) => s === 'li,tr' })), { matches: () => false }] });
  const run = ({ article = 0, listitem = 0, lists = [], root = true }) => {
    const rootEl = { querySelectorAll: (sel) => (sel === LISTS ? lists.map(listOf) : { length: sel === '[role=listitem]' ? listitem : 0 }) };
    const document = {
      querySelector: (sel) => (root && sel.startsWith('main article') ? rootEl : null),
      querySelectorAll: (sel) => ({ length: sel === 'article' ? article : 0 }),
      body: { querySelectorAll: (sel) => (sel === LISTS ? [] : { length: 0 }) },
      scrollingElement: { scrollHeight: 9500.4 },
    };
    return new Function('document', 'window', `return ${scripts.SCROLL_INFO}`)(document, { scrollY: 1867.6, innerHeight: 868 });
  };
  assert.deepStrictEqual(run({ article: 12, listitem: 30, lists: [40] }), { y: 1868, height: 9500, vh: 868, items: 12 });
  assert.strictEqual(run({ listitem: 30, lists: [40] }).items, 30);
  assert.strictEqual(run({ lists: [42, 5] }).items, 42);
  assert.strictEqual(run({ lists: [3, 5] }).items, 5);
  assert.strictEqual(run({ lists: [3] }).items, 3);
  assert.strictEqual(run({ lists: [40], root: false }).items, 0);
  assert.ok(scripts.READ_TEXT(false).includes(JSON.stringify(scripts.READ_ROOT_SEL)));
});

test('child: every --main scope resolves through mainRootOf', () => {
  assert.match(scripts.READ_TEXT(true), /const forced = mainRootOf\(\);/);
  const ri = scripts.READ_INTERACTIVE(true, {});
  assert.match(ri, /const mainRoot = mainRootOf\(\);/);
  assert.match(ri, /posts: \[\.\.\.\(mainRootOf\(\) \|\| document\)\.querySelectorAll\('article'\)\]/);
  assert.match(scripts.FEED(true, {}), /const scope = mainRootOf\(\) \|\| document;/);
  assert.ok(scripts.MAIN_ROOT.includes('document.querySelector("main, article, [role=main]")'));
  assert.ok(!scripts.READ_TEXT(false).includes('const forced = mainRootOf'));
});

test('child: scroll moves by innerHeight minus 40 per page, or to top/bottom', () => {
  assert.strictEqual(scrollCode('down', 3), "window.scrollBy({ top: (window.innerHeight - 40) * 3, behavior: 'instant' })");
  assert.strictEqual(scrollCode('up', 1), "window.scrollBy({ top: -(window.innerHeight - 40) * 1, behavior: 'instant' })");
  assert.strictEqual(scrollCode('top'), "window.scrollTo({ top: 0, behavior: 'instant' })");
  assert.match(scrollCode('bottom'), /^window\.scrollTo\(\{ top: .*scrollHeight, behavior: 'instant' \}\)$/);
  const inner = scrollCode('down', 1, true);
  assert.ok(inner.includes("document.querySelector('[data-cxb-scroller]')"));
  assert.ok(inner.includes("el.scrollBy({ top: (el.clientHeight - 40) * 1, behavior: 'instant' })"));
  assert.ok(inner.includes(scrollCode('down', 1)), 'no tagged scroller falls back to the window');
  assert.ok(scrollCode('up', 2, true).includes('el.scrollBy({ top: -(el.clientHeight - 40) * 2'));
  assert.ok(scrollCode('bottom', 1, true).includes("el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })"));
  assert.ok(!scrollCode('down', 1).includes('data-cxb-scroller'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'browser-pane', 'child.js'), 'utf8');
  assert.ok(src.includes("const docStuck = doc.height <= doc.vh + 2 || (forward ? doc.y + doc.vh >= doc.height - 2 : doc.y <= 0);"));
  assert.ok(src.includes('const scroller = docStuck && !wc.isDestroyed() ? await inMain(wc, scripts.MAIN_SCROLLER(dir)) : null;'));
  assert.ok(src.includes('const measureInner = async () => { const d = await measure(); const sc = d && await inMain(wc, scripts.SCROLLER_INFO); return d && sc ? { ...sc, items: d.items } : null; };'));
  assert.ok(src.includes('await inMain(wc, scrollCode(dir, pages, inner));'));
  assert.ok(src.includes('...(inner ? { scroller: scroller.label } : {}),'));
});

test('page scripts: READ_TEXT appends the absolute local time to a relative age read from the original element', () => {
  const src = scripts.READ_TEXT(false);
  assert.ok(src.includes(`const AGE_SEL = 'time[datetime], [title*="T"][class*="age" i], [data-time]';`));
  assert.ok(src.includes('const AGE_RE = /\\b(\\d+|an?|one)\\s+(second|minute|hour|day|week|month|year)s?\\s+ago\\b|\\bjust now\\b|\\bacum\\b/i;'));
  assert.ok(src.includes("if (!isNaN(d)) twin.append(' (' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ')');"));
  assert.ok(src.indexOf('const AGE_SEL') > src.indexOf("c.prepend('(was ')"));
});

test('page scripts: READ_TEXT inlines a same-origin or srcdoc frame body under a [frame] line; read lists only the frames it did not inline', () => {
  const src = scripts.READ_TEXT(false);
  assert.ok(src.includes("if (orig && orig.tagName === 'IFRAME') { let fd = null; try { fd = orig.contentDocument; } catch {}"));
  assert.ok(src.includes('if (vis(orig) && fd && fd.body && fd.body.innerText.trim()) { const box'), 'an empty or hidden frame is not inlined');
  assert.ok(src.includes("box.append('[frame]\\n', fd.body.cloneNode(true)); const inner = [...fd.querySelectorAll('iframe[srcdoc]')].length; if (inner) nested.push(inner); twin.replaceWith(box);"));
  assert.ok(src.includes("if (!forced && !modal && (!root || ((root.innerText || '').length < 200 && !framed(root)))) {"));
  assert.ok(src.includes('return { text, busy, outline, wall, inlined, nested, hidden };'));
  assert.ok(src.indexOf("orig.tagName === 'IFRAME'") < src.indexOf('clone.querySelectorAll(DROP)'));
  const child = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'browser-pane', 'child.js'), 'utf8');
  assert.ok(child.includes('const hidden = new Set(got && Array.isArray(got.hidden) ? got.hidden : []); const frames = allFrames.filter((u) => !inlined.has(u) && !hidden.has(u));'));
  assert.ok(src.includes("if (!vis(orig)) hidden.push(orig.srcdoc ? 'about:srcdoc' : (fd && fd.location && fd.location.href) || orig.src || '');"));
  assert.ok(child.includes("const nestedN = got && Array.isArray(got.nested) ? got.nested.reduce((a, b) => a + b, 0) : 0;"));
  assert.ok(child.includes("frames.push(...Array(nestedN).fill('nested'))"));
  assert.ok(child.includes('const login = challenged(await probe(svc), allFrames, wc.getTitle());'));
});

test('page scripts: READ_TEXT reads an epoch token in an age title first and a zone-less ISO time as UTC', () => {
  const src = scripts.READ_TEXT(false);
  assert.ok(src.includes("/^\\d{9,10}$/.test(tok[1] || '') ? new Date(Number(tok[1]) * 1000)"));
  assert.ok(src.includes("const bare = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?$/.test(tok[0]);"));
  assert.ok(src.includes("bare ? new Date(tok[0] + 'Z') : new Date(v)"));
});

test('page scripts: READ_TEXT reads a visible modal dialog covering a quarter of the viewport as the root, under a [dialog] line', () => {
  const src = scripts.READ_TEXT(false);
  assert.ok(src.includes("const DIALOG_SEL = '[role=dialog], [role=alertdialog], dialog[open], [aria-modal=true]';"));
  assert.ok(/const modal = forced \? null : .*a: paintedArea\(e\).*\n  if \(modal\) root = modal\.e;/.test(src));
  assert.ok(src.includes('x.by !== \'aria\' ? x.a >= innerWidth * innerHeight / 16 : x.a >= innerWidth * innerHeight / 4'));
  assert.ok(src.includes("(a.by === 'drawer') - (b.by === 'drawer') || b.a - a.a"));
  assert.ok(src.includes('const paintedArea = (e) => { const s = getComputedStyle(e); if (s.pointerEvents !== \'none\' && s.backgroundColor !== \'rgba(0, 0, 0, 0)\') return'));
  assert.ok(src.includes('const modalBy = (e) =>'));
  assert.ok(src.includes("[...document.querySelectorAll('div,aside,section')]"));
  assert.ok(src.includes('/close|dismiss|^×$/i.test('));
  const ri = scripts.READ_INTERACTIVE(false, {});
  assert.strictEqual(lineOf(ri, 'const modalBy = (e) =>'), lineOf(src, 'const modalBy = (e) =>'));
  assert.strictEqual(lineOf(ri, 'const modal = forced ? null :'), lineOf(src, 'const modal = forced ? null :'));
  assert.ok(ri.includes('covered.push(n);'));
  assert.ok(ri.includes('rows: rowsOut, chrome, covered, cats,'));
  assert.ok(src.includes('[...document.querySelectorAll(DIALOG_SEL), ...drawersOf()].filter(vis)'));
  assert.match(CHILD_SRC, /chrome: el\.chrome \|\| \[\],\n\s*covered: el\.covered \|\| \[\],/);
  assert.ok(src.includes('const dialogRead = !!modal && root === modal.e;'));
  assert.ok(src.includes("if (!forced && !modal && (!root || ((root.innerText || '').length < 200 && !framed(root)))) {"));
  assert.ok(src.includes("(dialogRead ? '[dialog]\\n' : '')"));
  assert.ok(src.indexOf('const DIALOG_SEL') < src.indexOf('const framed ='));
  assert.ok(src.indexOf('const dialogRead') > src.indexOf('root = best &&'));
  assert.ok(src.includes("const score = el => { if (!el.getClientRects().length) return -1;"));
  assert.ok(src.indexOf("const score = el => { if (!el.getClientRects().length) return -1;") < src.indexOf('const forced ='));
});

test('page scripts: the short-root fallback scores an element with no layout box -1, a rendered one by its text', () => {
  const score = new Function(`${scripts.READ_TEXT(false).match(/(const score = el => \{[\s\S]*?\n  \};)/)[1]}\nreturn score;`)();
  assert.strictEqual(score({ getClientRects: () => [], innerText: 'x'.repeat(500), querySelectorAll: () => [] }), -1);
  assert.strictEqual(score({ getClientRects: () => [{}], innerText: 'x'.repeat(500), querySelectorAll: () => [] }), 500);
});

function lineOf(src, head) {
  const i = src.indexOf(head);
  return src.slice(i, src.indexOf('\n', i));
}

test('page scripts: wholeLabel drops an icon-only child from the label, keeps real extra words', () => {
  const src = scripts.READ_TEXT(false);
  const wholeLabel = new Function(`${lineOf(src, 'const norm = s =>')}\n${lineOf(src, 'const wholeLabel = t =>')}\nreturn wholeLabel;`)();
  const label = (...kids) => {
    const a = { closest: () => a, childNodes: [] };
    const t = { nodeType: 3, data: kids[0], parentElement: a };
    a.childNodes = [t, ...kids.slice(1).map((innerText) => ({ nodeType: 1, innerText }))];
    return t;
  };
  assert.strictEqual(wholeLabel(label('Continue reading ', '→')), true);
  assert.strictEqual(wholeLabel(label('Continue reading ', '»')), true);
  assert.strictEqual(wholeLabel(label('Continue reading ', 'the full story')), false);
  assert.strictEqual(wholeLabel(label('Subscribe')), true);
  assert.strictEqual(wholeLabel(label('Page ', '2')), false);
});

function modalByOf() {
  const src = scripts.READ_TEXT(false);
  const make = new Function('getComputedStyle', 'document', 'innerWidth', 'innerHeight', 'vis', `${lineOf(src, 'const drawerAt = (e) =>')}\n${lineOf(src, 'const drawerKeep = (e) =>')}\n${lineOf(src, 'const modalBy = (e) =>')}\nreturn modalBy;`);
  const body = { children: [] };
  return { body, modalBy: make((e) => e.style, { body, documentElement: { clientWidth: 1185 } }, 1200, 800, () => true) };
}

function node(parentElement, { attrs = {}, style = {}, rect = { width: 100, height: 100 }, aria = false, role = false, innerText = '', nav = '', controls = [] } = {}) {
  const e = { attrs, style, parentElement, innerText, children: [], previousElementSibling: null,
    closest: () => (nav === 'in' ? {} : null), querySelector: () => (nav === 'has' ? {} : null),
    querySelectorAll: () => controls.map((name) => ({ getAttribute: (k) => (k === 'aria-label' ? name : null), innerText: '' })),
    matches: (sel) => (sel === '[role=dialog]' ? role : aria), getAttribute: (k) => (k in attrs ? attrs[k] : null), hasAttribute: (k) => k in attrs, getBoundingClientRect: () => rect };
  if (parentElement) {
    e.previousElementSibling = parentElement.children[parentElement.children.length - 1] || null;
    parentElement.children.push(e);
  }
  return e;
}

test('page scripts: modalBy proves a dialog modal by aria-modal, aria-hidden page siblings or a full-viewport backdrop', () => {
  {
    const { body, modalBy } = modalByOf();
    node(body, { attrs: { 'aria-hidden': 'true' }, innerText: 'Accounts Holdings Activities Portfolio Overview Settings' });
    node(body, { attrs: { 'aria-hidden': 'true' }, innerText: 'Footer links: About, Blog, Pricing, Privacy policy' });
    const container = node(body);
    const pane = node(node(container));
    assert.strictEqual(modalBy(pane), 'hidden');
  }
  {
    const { body, modalBy } = modalByOf();
    node(body, { attrs: { 'aria-hidden': 'true' }, innerText: '' });
    assert.strictEqual(modalBy(node(body)), '');
  }
  {
    const { body, modalBy } = modalByOf();
    node(body);
    const wrap = node(body);
    node(wrap, { style: { position: 'fixed' }, rect: { width: 1200, height: 800 } });
    assert.strictEqual(modalBy(node(wrap, { aria: true })), 'backdrop');
  }
  {
    const { body, modalBy } = modalByOf();
    node(body);
    const wrap = node(body);
    node(wrap, { style: { position: 'fixed' }, rect: { width: 1200, height: 800 } });
    assert.strictEqual(modalBy(node(wrap)), 'backdrop');
  }
  {
    const { body, modalBy } = modalByOf();
    node(body);
    const wrap = node(body);
    node(wrap, { style: { position: 'static' }, rect: { width: 1200, height: 800 } });
    assert.strictEqual(modalBy(node(wrap)), '');
  }
  {
    const { body, modalBy } = modalByOf();
    node(body);
    assert.strictEqual(modalBy(node(node(body), { aria: true })), 'aria');
  }
  {
    const { body, modalBy } = modalByOf();
    node(body, { innerText: 'Work items: Item 1, Item 2, Item 3, Item 4, Item 5, Item 6' });
    const drawer = (style, rect) => modalBy(node(body, { role: true, style, rect }));
    const docked = { left: 720, right: 1200, top: 0, bottom: 800, width: 480, height: 800 };
    assert.strictEqual(drawer({ position: 'fixed' }, docked), 'drawer');
    assert.strictEqual(drawer({ position: 'fixed' }, { ...docked, left: 280, width: 920 }), '');
    assert.strictEqual(drawer({ position: 'absolute' }, docked), '');
    assert.strictEqual(drawer({ position: 'fixed' }, { ...docked, left: 100, right: 580 }), '');
    assert.strictEqual(drawer({ position: 'fixed' }, { ...docked, height: 500, bottom: 500 }), '');
    const paneled = { left: 660, right: 1200, top: 0, bottom: 800, width: 540, height: 800 };
    const bare = (rect, opts) => modalBy(node(body, { style: { position: 'fixed' }, rect, controls: ['Close panel'], ...opts }));
    assert.strictEqual(bare(paneled), 'drawer', 'a role-less fixed docked panel with a close control is a drawer');
    assert.strictEqual(bare({ ...paneled, left: 645, right: 1185 }), 'drawer', 'a classic scrollbar does not undock it');
    const inset = { left: 417, right: 1177, top: 48, bottom: 800, width: 760, height: 752 };
    assert.strictEqual(bare(inset), 'drawer', 'an 8 px inset, 0.63 vw panel is a drawer');
    assert.strictEqual(bare({ ...inset, left: 405, right: 1165 }), '', 'a 20 px inset is not docked');
    assert.strictEqual(bare({ ...inset, left: 272, width: 920 }), '', 'over 0.75 vw is not a drawer');
    assert.strictEqual(bare(paneled, { nav: 'in' }), '', 'a panel inside a nav is not a drawer');
    assert.strictEqual(bare(paneled, { nav: 'has' }), '', 'a panel holding a nav is not a drawer');
    assert.strictEqual(bare(paneled, { controls: ['Save'] }), '', 'a panel with no close control is not a drawer');
    assert.strictEqual(drawer({ position: 'fixed' }, paneled), 'drawer', 'a role=dialog drawer needs no close control');
  }
  assert.ok(scripts.READ_TEXT(false).includes('r.right >= w - 16') && scripts.READ_TEXT(false).includes('innerWidth * 0.75'));
  assert.strictEqual(lineOf(scripts.READ_TEXT(false), 'const modalBy = (e) =>'), "const modalBy = (e) => { for (let n = e; n && n !== document.body; n = n.parentElement) { const sib = [...n.parentElement ? n.parentElement.children : []].filter(x => x !== n && vis(x)); if (sib.length && sib.some(x => (x.innerText || '').trim().length >= 40) && sib.every(x => x.getAttribute('aria-hidden') === 'true' || x.hasAttribute('inert'))) return 'hidden'; } const prev = e.previousElementSibling; if (prev && vis(prev)) { const s = getComputedStyle(prev), r = prev.getBoundingClientRect(); if ((s.position === 'fixed' || s.position === 'absolute') && r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9) return 'backdrop'; } if (e.matches('[aria-modal=true], dialog[open]')) return 'aria'; if (drawerAt(e) && (e.matches('[role=dialog]') || drawerKeep(e))) return 'drawer'; return ''; };");
});

test('child: a --text target matched by label carries byName onto the click and inspect replies', () => {
  const child = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'browser-pane', 'child.js'), 'utf8');
  assert.ok(child.includes('byName: !!found.byName'));
  assert.ok(child.includes('if (byName) out.byName = true;'));
  assert.ok(child.includes('clickOnly: !!found.clickOnly'));
  assert.ok(child.includes('if (clickOnly) out.clickOnly = true;'));
  assert.ok(child.includes('...(byName ? { byName: true } : {})'));
});

test('child: idleOf carries the ticker the idle wait ignored', () => {
  const child = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'browser-pane', 'child.js'), 'utf8');
  assert.ok(child.includes('...(idle.ticker ? { ticker: idle.ticker } : {}), ...(Array.isArray(idle.churn) && idle.churn.length ? { churn: idle.churn } : {}), ...(idle.polls ? { polls: idle.polls } : {}), ...(idle.held ? { held: idle.held } : {}) });'));
  assert.strictEqual((child.match(/driver\.armIdle\(svc\.wc, \{ worldId: scripts\.ISOLATED_WORLD \}\)/g) || []).length, 2);
  assert.strictEqual(child.split('driver.act(').length, 2);
  assert.strictEqual(child.split('driver.waitIdle(').length, 2);
  assert.ok(child.includes('const act = (wc, fn, opts = {}) => driver.act(wc, fn, { worldId: scripts.ISOLATED_WORLD, ...opts });'));
  assert.ok(child.includes('const waitIdle = (wc, opts = {}) => driver.waitIdle(wc, { worldId: scripts.ISOLATED_WORLD, ...opts });'));
});

test('page scripts: MAIN_SCROLLER tags the largest visible overflow-auto element that can move and returns its metrics, null when none', () => {
  const mk = (id, w, h, overflowY, scrollHeight, clientHeight) => {
    const attrs = {};
    return {
      id, tagName: 'DIV', classList: ['list', 'x'], scrollTop: 120, scrollHeight, clientHeight, overflowY, attrs,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h }),
      setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; },
    };
  };
  const run = (els, old = []) => new Function('document', 'getComputedStyle', 'innerWidth', 'innerHeight', `return ${scripts.MAIN_SCROLLER('down')}`)(
    { querySelectorAll: (s) => (s === '*' ? els : old) }, (e) => ({ overflowY: e.overflowY }), 1200, 800);
  const small = mk('code', 300, 100, 'auto', 900, 100);
  const big = mk('list', 1000, 600, 'auto', 6000, 600);
  const hidden = mk('clip', 1200, 800, 'hidden', 6000, 800);
  const short = mk('short', 1200, 800, 'scroll', 820, 800);
  const prev = mk('prev', 10, 10, 'auto', 900, 10);
  prev.attrs['data-cxb-scroller'] = '';
  assert.deepStrictEqual(run([small, big, hidden, short], [prev]), { y: 120, height: 6000, vh: 600, label: 'div#list.list' });
  assert.ok('data-cxb-scroller' in big.attrs);
  assert.ok(!('data-cxb-scroller' in prev.attrs));
  assert.strictEqual(run([hidden, short]), null);
});

test('page scripts: MAIN_SCROLLER skips a candidate already at the requested end, the page body and one under a tenth of the viewport', () => {
  const mk = (id, w, h, scrollTop, scrollHeight, clientHeight) => {
    const attrs = {};
    return {
      id, tagName: 'DIV', classList: [], scrollTop, scrollHeight, clientHeight, overflowY: 'auto', attrs,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h }),
      setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; },
    };
  };
  const run = (els, dir, docEls = {}) => new Function('document', 'getComputedStyle', 'innerWidth', 'innerHeight', `return ${scripts.MAIN_SCROLLER(dir)}`)(
    { querySelectorAll: (s) => (s === '*' ? els : []), ...docEls }, (e) => ({ overflowY: e.overflowY }), 1200, 800);
  const column = mk('col', 1200, 800, 5200, 6000, 800);
  const vp = mk('vp', 600, 400, 0, 9000, 400);
  assert.strictEqual(run([column, vp], 'down').label, 'div#vp');
  assert.ok('data-cxb-scroller' in vp.attrs && !('data-cxb-scroller' in column.attrs));
  assert.strictEqual(run([column, vp], 'up').label, 'div#col');
  assert.strictEqual(run([column, vp], 'bottom').label, 'div#vp');
  assert.strictEqual(run([column, vp], 'top').label, 'div#col');
  const tiny = mk('tiny', 300, 300, 0, 900, 300);
  assert.strictEqual(run([column, tiny], 'down'), null);
  const body = mk('body', 1200, 800, 0, 6000, 800);
  assert.strictEqual(run([body], 'down', { body }), null);
  assert.strictEqual(run([body], 'down', { documentElement: body }), null);
  assert.strictEqual(run([body], 'down', { scrollingElement: body }), null);
  assert.ok(!('data-cxb-scroller' in body.attrs));
  assert.strictEqual(run([body], 'down').label, 'div#body');
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
  assert.strictEqual(vis(box(10, 10, 80, 20, {}, box(0, 0, 500, 500, { opacity: '0' }))), false);
  assert.strictEqual(vis(box(10, 10, 80, 20, {}, box(0, 0, 500, 500, { opacity: '0.5' }))), true);
  let chain = box(0, 0, 1200, 800, { opacity: '0' });
  for (let i = 0; i < 12; i++) chain = box(0, 0, 1200, 800, {}, chain);
  assert.strictEqual(vis(box(10, 10, 80, 20, {}, chain)), true);
  const src = scripts.READ_TEXT(false);
  assert.ok(src.includes('const faded = (el) => { let k = 0; const seen = []; for (let e = upOf(el); e && e !== document.body && k < 12; e = upOf(e), k++)'));
  assert.ok(src.includes("    if (s.opacity === '0') return false;\n    if (faded(el)) return false;"));
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

test('page scripts: the busy scan counts a spinner-sized element or an explicit aria-busy page, not a page-sized loading container', () => {
  const make = new Function('getComputedStyle', 'document', 'scrollX', 'scrollY', 'innerWidth', 'innerHeight', `${scripts.DEEP}${scripts.BUSY}\nreturn busyScan();`);
  const el = (b, attrs = {}, innerText = '') => ({ ...b, innerText, getAttribute: (k) => (k in attrs ? attrs[k] : null) });
  const scan = (els) => {
    const doc = { documentElement: { scrollWidth: 1200, scrollHeight: 3000 }, querySelectorAll: () => els };
    return make((e) => ({ visibility: 'visible', display: 'block', opacity: '1', clip: 'auto', clipPath: 'none', overflow: 'visible', overflowX: 'visible', animationName: 'none', animationPlayState: 'running', ...e.style }),
      doc, 0, 0, 1200, 800);
  };
  assert.strictEqual(scan([el(box(0, 0, 1200, 3000), { class: 'content-loading' }, 'x'.repeat(400))]).count, 0);
  assert.deepStrictEqual(scan([el(box(580, 380, 40, 40), { class: 'spinner' }, 'Loading')]), { count: 1, text: 'Loading' });
  assert.strictEqual(scan([el(box(0, 0, 1200, 800), { 'aria-busy': 'true' }, 'x'.repeat(400))]).count, 1);
});

test('page scripts: a text-less, unanimated loading placeholder is not busy; an animated one, a labelled spinner or a progressbar is', () => {
  const make = new Function('getComputedStyle', 'document', 'scrollX', 'scrollY', 'innerWidth', 'innerHeight', `${scripts.DEEP}${scripts.BUSY}\nreturn busyScan();`);
  const el = (b, attrs = {}, innerText = '') => ({ ...b, innerText, getAttribute: (k) => (k in attrs ? attrs[k] : null) });
  const scan = (els) => make((e) => ({ visibility: 'visible', display: 'block', opacity: '1', clip: 'auto', clipPath: 'none', overflow: 'visible', overflowX: 'visible', animationName: 'none', animationPlayState: 'running', ...e.style }),
    { documentElement: { scrollWidth: 1200, scrollHeight: 3000 }, querySelectorAll: () => els }, 0, 0, 1200, 800);
  assert.strictEqual(scan([el(box(100, 100, 40, 40, { animationName: 'none' }), { class: 'loading' })]).count, 0);
  assert.strictEqual(scan([el(box(100, 100, 40, 40, { animationName: 'spin' }), { class: 'loading' })]).count, 1);
  assert.strictEqual(scan([el(box(100, 100, 40, 40), { class: 'spinner' }, 'Loading…')]).count, 1);
  assert.strictEqual(scan([el(box(0, 0, 1200, 800), { role: 'progressbar' }, 'x'.repeat(400))]).count, 1);
  assert.match(scripts.BUSY, /\[role=progressbar\]/);
});

test('page scripts: PAGE_TEXT renders tables as cell | cell rows with the same code as READ_TEXT', () => {
  const rows = /const cellText = [\s\S]*?t\.replaceWith\(box\);\n {2}\}/;
  const a = rows.exec(scripts.PAGE_TEXT);
  assert.ok(a);
  assert.strictEqual(a[0], rows.exec(scripts.READ_TEXT(false))[0]);
});

test('page scripts: labelFrom skips placeholder alts and falls back to test id, class, handle, href segment, src; posters read video', () => {
  const L = scripts.labelFrom;
  const rows = [
    [{ tag: 'div', alts: ['icon'], src: '/img/lock.png?v=3' }, 'lock'],
    [{ tag: 'div', alts: [null, 'padlock'], src: '/img/lock.png' }, 'padlock'],
    [{ tag: 'div', alts: ['image'], testid: 'power-icon-container' }, 'power-icon'],
    [{ tag: 'div', alts: ['Logo'] }, 'Logo'],
    [{ tag: 'div', alts: ['photo'], classes: 'css-1dbjc4n wrapper device-tile' }, 'device-tile'],
    [{ tag: 'div', classes: 'btn-primary nav-link col-md-3' }, ''],
    [{ tag: 'button', text: '', classes: 'mdc-button mdc-ripple' }, ''],
    [{ tag: 'button', text: '', classes: 'mdc-button', tooltip: 'Add account' }, 'Add account'],
    [{ tag: 'button', text: '', svgAria: 'Delete' }, 'Delete'],
    [{ tag: 'button', text: '', title: 'Edit', tooltip: 'x' }, 'Edit'],
    [{ tag: 'textarea', value: 'typed secret', id: 'msg' }, 'msg'],
    [{ tag: 'div', src: 'data:image/gif;base64,R0l' }, ''],
    [{ tag: 'a', href: '/karolzdeb', alts: [''] }, '@karolzdeb'],
    [{ tag: 'a', href: '/karolzdeb', alts: ['Karol avatar'] }, '@karolzdeb'],
    [{ tag: 'a', href: '/karolzdeb', alts: ['Karol Zdeb profile picture'] }, '@karolzdeb'],
    [{ tag: 'a', href: '/ana_m', alts: ['Photo of Ana'] }, '@ana_m'], [{ tag: 'a', href: '/ana_m', alts: ['User image'] }, '@ana_m'],
    [{ tag: 'a', href: '/ana_m/status/19/photo/2', alts: ['Image'] }, 'photo 2'], [{ tag: 'a', href: '/ana_m/status/19/photo/1', text: '1' }, 'photo 1'],
    [{ tag: 'a', href: '/ana_m/status/19/photo/1', text: 'Sunset' }, 'Sunset'],
    [{ tag: 'label', text: '', inner: 'Informatii' }, 'Informatii'], [{ tag: 'input', value: '', name: 'Informatii' }, 'Informatii'],
    [{ tag: 'label', text: 'Tine-ma minte', inner: 'x' }, 'Tine-ma minte'],
    [{ tag: 'a', href: '/i/bookmarks', svgTestid: 'bookmark-icon' }, 'bookmark-icon'],
    [{ tag: 'a', href: '/i/bookmarks', svgTitle: 'Bookmarks' }, 'Bookmarks'],
    [{ tag: 'a', href: '/settings/account/security' }, 'security'],
    [{ tag: 'div', src: 'https://pbs.example/media/poster_1.jpg', video: true }, 'video'],
    [{ tag: 'div', src: 'https://pbs.example/media/poster_1.jpg' }, 'poster 1'],
    [{ tag: 'label', text: '', for: 'attach_main', src: '/img/attach_icon.png', classes: 'uiLabelButtonSmall' }, 'attach icon'],
    [{ tag: 'label', text: '', for: 'attach_main', classes: 'uiLabelButtonSmall' }, 'attach main'],
    [{ tag: 'label', text: '', classes: 'uiLabelButtonSmall' }, 'uiLabelButtonSmall'],
    [{ tag: 'div', alts: ['OSHY3ewP_bigger.jpg'], src: 'https://pbs.twimg.com/profile_images/1/OSHY3ewP_bigger.jpg' }, 'avatar'],
    [{ tag: 'div', src: 'https://pbs.twimg.com/profile_images/1/k3Yq_400x400.png' }, 'avatar'],
    [{ tag: 'div', src: 'https://pbs.twimg.com/media/GxQ_big.jpg' }, 'GxQ big'],
    [{ tag: 'button', text: 'john_mini' }, 'john_mini'],
    [{ tag: 'button', text: '\n ', name: 'info', id: 'b1' }, 'info'],
    [{ tag: 'button', text: ' ', id: 'b1' }, 'b1'],
    [{ tag: 'button', aria: 'Informatii', text: 'x', name: 'info' }, 'Informatii'],
    [{ tag: 'input', value: 'Card bancar', title: 'Plata', name: 'card' }, 'Card bancar'],
    [{ tag: 'input', title: 'Plata', name: 'card' }, 'Plata'],
    [{ tag: 'div', text: ' ', id: 'ondiv' }, ''],
    [{ tag: 'a', href: '/elonmusk', alts: ['OSHY3ewP_bigger.jpg'], src: 'https://pbs.twimg.com/profile_images/123/OSHY3ewP_bigger.jpg' }, '@elonmusk'],
    [{ tag: 'a', href: '/AOC', alts: [null, 'X20dMMBa_bigger.jpg'], src: 'https://pbs.twimg.com/profile_images/9/X20dMMBa_bigger.jpg' }, '@AOC'],
    [{ tag: 'a', href: '/photo/1', alts: ['Image'] }, 'photo 1'],
    [{ tag: 'div', role: 'link', src: 'x_bigger.jpg', h: 16, inLink: true }, 'badge'],
    [{ tag: 'div', role: 'link', alts: ['x_bigger.jpg'], h: 16, inLink: true }, 'badge'],
    [{ tag: 'a', href: '/elonmusk', alts: ['x_bigger.jpg'], h: 40 }, '@elonmusk'],
    [{ tag: 'div', role: 'link', src: 'x_bigger.jpg', h: 40, inLink: false }, 'avatar'],
  ];
  for (const [d, want] of rows) assert.strictEqual(L(d), want, JSON.stringify(d));
  assert.match(scripts.READ_INTERACTIVE(false, {}), /inner: btn \? \(btn\.tagName === 'INPUT' \? btn\.value : btn\.innerText\)/);
  assert.match(scripts.READ_INTERACTIVE(false, {}), /h: e\.getBoundingClientRect\(\)\.height,\n\s*inLink: !!e\.closest\('a\[href\] \*'\),/);
  const ri = scripts.READ_INTERACTIVE(false, {});
  assert.ok(ri.includes("svgAria: svg ? svg.getAttribute('aria-label') : '',"));
  assert.ok(ri.includes("tooltip: e.getAttribute('data-tooltip') || e.getAttribute('data-original-title') || '',"));
  assert.ok(ri.includes("line: [kind, cq ? '⚠' : '', line].filter(Boolean).join(' ') + flags,"));
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
  assert.strictEqual(gone.message, R.TEXT.unknownN('ebloc', 5));
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

test('numbers persist: a merge marks the origin dirty, a flush saves it, and a fresh service loads the same numbers back', () => {
  const dir = path.join(fs.realpathSync(mkTmpRoot('clodex-bp-child-')), 'numbers', 'ebloc');
  let scheduled = 0;
  const svc = { ...svcOf(), numDir: dir, scheduleSave: () => { scheduled += 1; } };
  const a = stampOn(svc, 'https://www.e-bloc.ro/index.php', ['Acasa', 'Lista PDF', 'Plătește']);
  svc.num.volatile.add('t');
  svc.num.listed.add(2);
  assert.ok(scheduled >= 1);
  assert.ok(!fs.existsSync(numbersFile(dir, 'https://www.e-bloc.ro')));
  flushNumbers(svc, 5000);
  const file = numbersFile(dir, 'https://www.e-bloc.ro');
  assert.strictEqual(path.basename(file), 'https___www.e-bloc.ro.json');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(disk.v, NUMBERS_SCHEMA);
  assert.deepStrictEqual([disk.nextN, disk.volatile, disk.listed], [4, ['t'], [2]]);
  const again = { ...svcOf(), numDir: dir };
  const st = numState(again, 'https://www.e-bloc.ro/contoare');
  assert.strictEqual(st.known[a.stored[1]], 2);
  assert.strictEqual(again.num.byN.get(3), a.stored[2]);
  assert.deepStrictEqual([st.next, st.volatile, [...again.num.listed]], [4, ['t'], [2]]);
  assert.strictEqual(again.num.lastRead, null);
  assert.strictEqual(disk.savedAt, new Date(5000).toISOString());
  assert.strictEqual(again.num.restoredAt, disk.savedAt, 'a loaded entry carries when it was saved');
  assert.strictEqual(svc.num.restoredAt, null, 'an entry never loaded has no restoredAt');
  assert.match(CHILD_SRC, /first && ent\.restoredAt != null \? \{ restored: ent\.restoredAt \} : first \? \{ first: firstHost \|\| true \}/);
});

test('forgetNumbers: forget deletes the service numbers directory, and a flush or merge racing after it does not recreate it', () => {
  const dir = path.join(fs.realpathSync(mkTmpRoot('clodex-bp-child-')), 'numbers', 'ebloc');
  const svc = { ...svcOf(), numDir: dir, dirty: new Set(), saveTimer: setTimeout(() => {}, 60000).unref() };
  stampOn(svc, 'https://www.e-bloc.ro/index.php', ['Acasa']);
  flushNumbers(svc);
  assert.ok(fs.existsSync(numbersFile(dir, 'https://www.e-bloc.ro')));
  const e = svc.num;
  svc.dirty.add(e);
  forgetNumbers(svc, dir);
  assert.ok(!fs.existsSync(dir));
  assert.strictEqual(svc.saveTimer, null);
  assert.deepStrictEqual([svc.origins.size, svc.dirty.size, svc.num], [0, 0, null]);
  flushNumbers(svc);
  svc.num = e;
  mergeNumbers(svc, { assigned: { k: 9 }, next: 10 });
  flushNumbers(svc);
  assert.ok(!fs.existsSync(dir), 'a late flush or merge writes nothing');
  forgetNumbers(null, dir);
  assert.match(CHILD_SRC, /for \(const svc of windowsOf\(profile\)\) \{\n\s*svc\.win\.destroy\(\);\n\s*forgetNumbers\(svc, null\);\n\s*\}\n\s*forgetNumbers\(null, path\.join\(data, 'numbers', profile\)\);/);
});

test('numbers persist: a corrupt or other-schema file is ignored and overwritten on the next save', () => {
  const dir = fs.realpathSync(mkTmpRoot('clodex-bp-child-'));
  const file = numbersFile(dir, 'https://x.com');
  fs.writeFileSync(file, '{"v":1,"origin":"https://x.com","numbers":{');
  assert.strictEqual(loadNumbers(dir, 'https://x.com'), null);
  fs.writeFileSync(file, JSON.stringify({ v: NUMBERS_SCHEMA + 1, origin: 'https://x.com', numbers: { k: 9 }, nextN: 10 }));
  assert.strictEqual(loadNumbers(dir, 'https://x.com'), null);
  const svc = { ...svcOf(), numDir: dir };
  const st = stampOn(svc, 'https://x.com/home', ['Home']);
  assert.deepStrictEqual(st.ns, [1]);
  flushNumbers(svc);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).v, NUMBERS_SCHEMA);
  assert.strictEqual(loadNumbers(dir, 'https://x.com').byN.get(1), st.stored[0]);
  fs.writeFileSync(file, JSON.stringify({ v: NUMBERS_SCHEMA, origin: 'https://x.com', numbers: { k: 9 }, nextN: 10 }));
  const mtime = new Date(2026, 9, 5, 8, 21);
  fs.utimesSync(file, mtime, mtime);
  const old = loadNumbers(dir, 'https://x.com');
  assert.strictEqual(old.restoredAt, mtime.toISOString(), 'an old file without savedAt dates its restore by the file mtime');
  const head = RF.formatRead({ url: 'https://x.com/home', title: 'X', text: 'Home', elements: [], restored: old.restoredAt, fresh: [] }, { service: 'x' }).content.split('\n').find((l) => l.startsWith('doc:'));
  assert.match(head, /numbers restored \(saved 2026-10-05 08:21\)/);
});

test('numbers persist: at most ORIGINS_MAX origin files per service, least recently used deleted; a slug keeps [a-z0-9.-] and 120 chars', () => {
  const dir = fs.realpathSync(mkTmpRoot('clodex-bp-child-'));
  const svc = { ...svcOf(), numDir: dir };
  for (let i = 0; i <= ORIGINS_MAX; i += 1) {
    stampOn(svc, `https://s${i}.test/`, ['X']);
    flushNumbers(svc, 10000 + i * 1000);
    if (i === 3) { loadNumbers(dir, 'https://s0.test', 10000 + i * 1000 + 500); }
  }
  const files = fs.readdirSync(dir).sort();
  assert.strictEqual(files.length, ORIGINS_MAX);
  assert.ok(files.includes('https___s0.test.json'));
  assert.ok(!files.includes('https___s1.test.json'));
  assert.strictEqual(originSlug('http://127.0.0.1:8080'), 'http___127.0.0.1_8080');
  assert.strictEqual(originSlug(`https://${'a'.repeat(200)}.ro`).length, 120);
});

test('genRefusal: a number act or inspect carrying a read gen from another child is RESTARTED; same gen, --text and key pass', () => {
  const e = genRefusal('ebloc', 'click', { n: 36, gen: 111 }, 222);
  assert.strictEqual(e.code, 'RESTARTED');
  assert.strictEqual(e.message, 'numbers from before the browser restarted are void on ebloc — read again');
  for (const op of ['type', 'select', 'download', 'inspect']) assert.strictEqual(genRefusal('x', op, { n: 1, gen: null }, 222).code, 'RESTARTED', op);
  assert.strictEqual(genRefusal('ebloc', 'click', { n: 36, gen: 222 }, 222), null);
  assert.strictEqual(genRefusal('ebloc', 'click', { byText: 'Plata', gen: 111 }, 222), null);
  assert.strictEqual(genRefusal('ebloc', 'key', { key: 'Enter', gen: 111 }, 222), null);
  assert.strictEqual(genRefusal('ebloc', 'download', { url: 'https://x/a.pdf', n: null, gen: 111 }, 222), null);
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'browser-pane', 'child.js'), 'utf8');
  assert.match(src, /const stale = genRefusal\(name, op, args, gen\);\n\s*if \(stale\) throw stale;/);
  assert.match(src, /const base = \{ url: wc\.getURL\(\), title: wc\.getTitle\(\), doc: svc\.doc, contentType, gen \};/);
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
  const cover = 'https://docsify.js.org/#/cover';
  assert.deepStrictEqual(navOf({ docBefore: 3, docAfter: 3, hrefBefore: cover, hrefAfter: 'https://docsify.js.org/#/configuration', titleBefore: 'docsify', titleAfter: 'Configuration - docsify' }),
    { navigated: true, inPage: true, titleChanged: true });
  assert.deepStrictEqual(navOf({ docBefore: 3, docAfter: 3, hrefBefore: cover, hrefAfter: 'https://docsify.js.org/#/configuration', titleBefore: 'docsify', titleAfter: 'docsify' }),
    { navigated: true, inPage: true });
  assert.deepStrictEqual(navOf({ docBefore: 3, docAfter: 3, hrefBefore: cover, hrefAfter: cover, titleBefore: 'docsify', titleAfter: 'Configuration - docsify' }), { navigated: false });
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
  assert.deepStrictEqual(targetDiff({ el: {}, tile: null, panel: { class: 'panel' } }, { el: {}, tile: null, panel: { class: 'panel open' } }), { text: 'panel class +open', strong: false });
  assert.deepStrictEqual(targetDiff({ el: {}, tile: null, panel: { 'aria-expanded': 'false' } }, { el: {}, tile: null, panel: { 'aria-expanded': 'true' } }), { text: 'panel aria-expanded "false" → "true"', strong: true });
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
  assert.match(ri, /sigs\[n\] = counterMask\(it\.sig == null \? it\.line : it\.sig\) \+ '.' \+ counterMask\(rowsOut\[n\]\);/);
  assert.match(CHILD_SRC, /if \(rowChanged\(svc\.num && svc\.num\.lastRead, n, el\.row\)\) out\.textChanged = true;/);
  assert.ok(/ent\.lastRead = \{ .*, rows: el\.rows \|\| \{\} \};/.test(CHILD_SRC));
  assert.match(scripts.FIND(1), /row: rowOf\(el\),/);
  assert.match(scripts.READ_INTERACTIVE(false, {}), /rowsOut\[n\] = rowOf\(it\.el\);/);
});

test('rowChanged: a click whose row text differs from the last read is flagged at click time; the same row is not', () => {
  const lastRead = { rows: { 10: 'Iulie 2026 | Lista de plată | 98 lei' } };
  assert.strictEqual(rowChanged(lastRead, 10, 'August 2026 | Lista de plată | 120 lei'), true);
  assert.strictEqual(rowChanged(lastRead, 10, 'Iulie 2026 | Lista de plată | 98 lei'), false);
  assert.strictEqual(rowChanged(lastRead, 11, 'x'), false);
  assert.strictEqual(rowChanged(null, 10, 'x'), false);
});

test('consequentialRefusal: a tagged element is refused without --confirm, naming the category; with it the act proceeds', () => {
  const e = consequentialRefusal(27, { label: 'Card bancar', consequential: 'payment' }, false);
  assert.strictEqual(e.code, 'CONSEQUENTIAL');
  assert.strictEqual(e.message, '[27] "Card bancar" looks consequential (payment) — re-issue with --confirm if the operator asked for it');
  assert.strictEqual(consequentialRefusal(27, { label: 'Card bancar', consequential: 'payment' }, true), null);
  assert.strictEqual(consequentialRefusal(36, { label: 'Post', consequential: 'publish' }, false).message,
    '[36] "Post" publishes as the operator — re-issue with --confirm if the operator asked for it');
  assert.strictEqual(consequentialRefusal(3, { label: 'Avizier', consequential: null }, false), null);
  const act = /const el = await resolve\(svc, n\);\n\s*const coveredErr = coveredRefusal\(n, el\);\n\s*if \(coveredErr\) throw coveredErr;\n\s*const refused = consequentialRefusal\(n, el, !!args\.confirm\);\n\s*if \(refused\) throw refused;/;
  assert.match(CHILD_SRC, act, 'click, --text click and select all pass this check after resolve');
  assert.match(scripts.FIND(1), /consequential: cqOf\(el\),/);
});

test('coveredRefusal: a covered click point is refused naming what covers it, before the ⚠ gate looks at the element', () => {
  const e = coveredRefusal(5, { label: 'Pret crescator', covered: true, hitN: 8, hitLabel: 'Delete account', hitConsequential: 'deletion' });
  assert.strictEqual(e.code, 'COVERED');
  assert.strictEqual(e.message, '[5] "Pret crescator" is covered at its click point by [8] ⚠ "Delete account" (deletion) — read again, or click it with --confirm if the operator asked for it');
  assert.strictEqual(coveredRefusal(5, { label: 'Pret crescator', covered: true, hitN: 8, hitLabel: 'Sterge filtre', hitConsequential: null }).message,
    '[5] "Pret crescator" is covered at its click point by [8] "Sterge filtre" — read again, or click the element that covers it');
  assert.strictEqual(coveredRefusal(311, { label: 'Friday, October 16, 2026', covered: true, hitN: 274, hitLabel: 'Cookie banner', hitConsequential: null, hitButtons: [{ n: 277, label: 'Decline' }, { n: 278, label: 'Accept' }] }).message,
    '[311] "Friday, October 16, 2026" is covered at its click point by [274] "Cookie banner" whose buttons are [277] "Decline" · [278] "Accept" — read again, or click one of them');
  assert.strictEqual(coveredRefusal(5, { label: 'Pret crescator', covered: true, hitN: null, hitLabel: 'Prin apăsarea „Accept toate”', hitButtons: [{ n: 208, label: 'Accept toate' }, { n: 209, label: 'Refuză toate' }] }).message,
    '[5] "Pret crescator" is covered at its click point by an unnumbered element ("Prin apăsarea „Accept toate”") whose buttons are [208] "Accept toate" · [209] "Refuză toate" — read again, or click one of them');
  assert.strictEqual(coveredRefusal(5, { label: 'Pret crescator', covered: true, hitN: null, hitLabel: 'Rezultate: 3 produse' }).message,
    '[5] "Pret crescator" is covered at its click point by an unnumbered element ("Rezultate: 3 produse") — read again, or click the element that covers it');
  assert.strictEqual(coveredRefusal(5, { label: 'Pret crescator', covered: false }), null);
  assert.ok(CHILD_SRC.indexOf('coveredRefusal(n, el)') < CHILD_SRC.indexOf('consequentialRefusal(n, el, !!args.confirm)'));
  assert.match(CHILD_SRC, /'CONSEQUENTIAL', 'COVERED',/);
  assert.match(CHILD_SRC, /const coveredErr = paths\.directHref\(el\.href, svc\.wc\.getURL\(\)\) \? null : coveredRefusal\(n, el\);\n\s*if \(coveredErr\) throw coveredErr;\n\s*dispatch\(svc, \{ type: 'describe', what: `download/);
});

function findOn(el, under, { numbered = {}, onFrame = () => {}, extra = {} } = {}) {
  const els = { 5: new WeakRef(el) };
  const of = new WeakMap([[el, 5]]);
  for (const [n, e] of Object.entries(numbered)) { els[n] = new WeakRef(e); of.set(e, Number(n)); }
  const ctx = {
    document: { elementFromPoint: under, querySelectorAll: () => [], documentElement: {}, createTreeWalker: () => ({ nextNode: () => null }) },
    getComputedStyle: (e) => e.style || { visibility: 'visible', display: 'block', opacity: '1' }, innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 0,
    location: { href: 'http://x/', origin: 'http://x' }, __cxEls: els, __cxOf: of, WeakRef, URL, Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    requestAnimationFrame: (f) => { onFrame(); f(); }, setTimeout: () => 0, ...extra,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  return vm.runInContext(scripts.FIND(5), ctx);
}

function boxEl(tag, text, rect, parent = null) {
  const e = {
    tagName: tag.toUpperCase(), isConnected: true, innerText: text, textContent: text, labels: null, value: '', type: '', form: null, parentElement: parent, parentNode: parent, childNodes: [],
    matches: (sel) => sel.split(',').some((x) => x.trim() === tag), getAttribute: () => null, setAttribute: () => {}, hasAttribute: () => false,
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    rect, getBoundingClientRect: () => e.rect, scrolls: [], scrollIntoView(o) { e.scrolls.push({ ...o }); if (e.onScroll) e.onScroll(); },
    contains(o) { for (let x = o; x; x = x.parentElement) if (x === e) return true; return false; },
  };
  return e;
}

test('UNDER_POINT: names the element under the click point when it is not the target or its kin; the click watch asks for it', () => {
  const box = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });
  const under = (el, hitAt) => {
    const ctx = {
      document: { elementFromPoint: hitAt, querySelectorAll: () => [], documentElement: {}, createTreeWalker: () => ({ nextNode: () => null }) },
      getComputedStyle: (e) => e.style || { visibility: 'visible', display: 'block', opacity: '1' }, innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 0,
      location: { href: 'http://x/', origin: 'http://x' }, __cxEls: { 5: new WeakRef(el) }, WeakRef, URL, Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    return vm.runInContext(scripts.UNDER_POINT(5), ctx);
  };
  const row = boxEl('div', 'Invoice March', box(10, 100, 400, 30));
  row.classList = [];
  const veil = Object.assign(boxEl('div', 'Loading', box(0, 0, 1200, 800)), { id: 'veil', classList: ['overlay', 'x'] });
  assert.strictEqual(under(row, () => veil), 'div#veil.overlay "Loading"');
  const odd = Object.assign(boxEl('div', '', box(0, 0, 1200, 800)), { id: 'a b"<x>', classList: [] });
  assert.strictEqual(under(row, () => odd), 'div#abx');
  assert.strictEqual(under(row, () => row), null);
  const child = Object.assign(boxEl('span', 'Invoice', box(10, 100, 50, 30), row), { classList: [] });
  assert.strictEqual(under(row, () => child), null);
  const shell = Object.assign(boxEl('div', 'Invoice March', box(0, 0, 1200, 800)), { classList: [] });
  row.parentElement = shell;
  assert.strictEqual(under(row, () => shell), null);
  assert.strictEqual(under(boxEl('div', 'x', box(0, 0, 0, 0)), () => veil), null);
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'browser-pane', 'child.js'), 'utf8');
  assert.ok(src.includes("if (done.watched) { const under = await inIsolated(wc, scripts.UNDER_POINT(n)); if (typeof under === 'string' && under) done.under = under; }"));
});

test('FIND: scrolls only an element outside the viewport, to nearest, and reports what sits under the click point', async () => {
  const box = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });
  const plain = (o) => JSON.parse(JSON.stringify(o));
  const inView = boxEl('button', 'Pret crescator', box(10, 100, 100, 30));
  const a = plain(findOn(inView, () => inView));
  assert.deepStrictEqual(inView.scrolls, [], 'an element in view is not scrolled');
  assert.deepStrictEqual([a.x, a.y, a.covered, a.hitN], [60, 115, false, undefined]);
  const below = boxEl('button', 'Pret crescator', box(10, 900, 100, 30));
  below.onScroll = () => { below.rect = box(10, 700, 100, 30); };
  const b = plain(await findOn(below, () => below));
  assert.deepStrictEqual(below.scrolls, [{ block: 'nearest', inline: 'nearest' }]);
  assert.deepStrictEqual([b.x, b.y, b.covered], [60, 715, false]);
  const del = boxEl('button', 'Delete account', box(0, 680, 260, 120));
  const menu = boxEl('button', 'Pret crescator', box(10, 900, 100, 30));
  menu.onScroll = () => { menu.rect = box(10, 700, 100, 30); };
  const seen = [];
  const c = plain(await findOn(menu, (x, y) => { seen.push([x, y]); return del; }, { numbered: { 8: del }, onFrame: () => { menu.rect = box(0, 0, 0, 0); } }));
  assert.deepStrictEqual(seen, [[60, 715]], 'a menu the page closed on scroll is hit-tested where it was');
  assert.deepStrictEqual([c.covered, c.hitN, c.hitLabel, c.hitConsequential], [true, 8, 'Delete account', 'deletion']);
  const overlay = boxEl('div', 'Accept cookies', box(0, 0, 1200, 800));
  const d = plain(findOn(inView, () => overlay));
  assert.deepStrictEqual([d.covered, d.hitN, d.hitLabel], [true, null, 'Accept cookies']);
  const span = boxEl('span', 'Pret', box(20, 105, 40, 20), inView);
  assert.strictEqual(plain(findOn(inView, () => span)).covered, false, 'the element\'s own child is not a cover');
  const label = boxEl('label', 'Email', box(0, 90, 300, 60));
  const field = boxEl('input', '', box(10, 100, 100, 30), label);
  assert.strictEqual(plain(findOn(field, () => label)).covered, false, 'an ancestor under the point is not a cover');
  const list = Object.assign(boxEl('div', 'Brand', box(0, 100, 300, 150)), { scrollHeight: 600, clientHeight: 150, style: { overflowX: 'hidden', overflowY: 'auto', position: 'static' } });
  const clipped = boxEl('a', 'Samsung', box(10, 300, 100, 30), list);
  clipped.onScroll = () => { clipped.rect = box(10, 220, 100, 30); };
  const e = plain(await findOn(clipped, () => clipped));
  assert.deepStrictEqual(clipped.scrolls, [{ block: 'nearest', inline: 'nearest' }], 'an item clipped by its overflow:auto list is scrolled into the list');
  assert.deepStrictEqual([e.x, e.y, e.covered], [60, 235, false]);
  const backdrop = boxEl('div', '', box(0, 0, 1200, 800));
  assert.strictEqual(plain(findOn(inView, () => backdrop)).hitLabel, 'div', 'a blank cover is named by its tag');
  const gone = boxEl('button', 'Pret crescator', box(0, 0, 0, 0));
  assert.strictEqual(findOn(gone, () => null), null, 'an element with no box is no longer on the page');
});

test('FIND: a target our scroll parked under a sticky header is scrolled clear once; a modal cover is retried once at centre and still refused; an overlay names its numbered buttons', async () => {
  const box = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });
  const plain = (o) => JSON.parse(JSON.stringify(o));
  const shown = { visibility: 'visible', display: 'block', opacity: '1' };
  const header = Object.assign(boxEl('header', 'Site header', box(0, 0, 1200, 80)), { style: { ...shown, position: 'sticky' } });
  const parked = (moves) => {
    const top = boxEl('a', 'Top link under the header', box(20, -500, 200, 40));
    top.onScroll = () => { top.rect = box(20, 0, 200, 40); };
    const scrollBys = [];
    const scrollBy = (o) => { scrollBys.push({ ...o }); if (moves) top.rect = box(20, top.rect.top - o.top, 200, 40); };
    return { top, scrollBys, run: () => findOn(top, (x, y) => (y < 80 ? header : top), { extra: { scrollBy } }) };
  };
  const ok = parked(true);
  const a = plain(await ok.run());
  assert.deepStrictEqual(ok.top.scrolls, [{ block: 'nearest', inline: 'nearest' }]);
  assert.deepStrictEqual(ok.scrollBys, [{ left: 0, top: -84, behavior: 'instant' }]);
  assert.deepStrictEqual([a.covered, a.x, a.y], [false, 120, 104]);
  const stuck = parked(false);
  const b = plain(await stuck.run());
  assert.strictEqual(stuck.scrollBys.length, 1, 'one retry, not a loop');
  assert.deepStrictEqual([b.covered, b.hitN, b.hitLabel], [true, null, 'Site header']);
  const modal = Object.assign(boxEl('div', 'Confirm', box(0, 0, 1200, 800)), { style: { ...shown, position: 'fixed' } });
  const below = boxEl('button', 'Pret crescator', box(10, 900, 100, 30));
  below.onScroll = () => { below.rect = box(10, 700, 100, 30); };
  const modalBys = [];
  const c = plain(await findOn(below, () => modal, { extra: { scrollBy: (o) => modalBys.push(o) } }));
  assert.deepStrictEqual(below.scrolls, [{ block: 'nearest', inline: 'nearest' }, { block: 'center', inline: 'nearest' }]);
  assert.deepStrictEqual([modalBys.length, c.covered, c.hitLabel], [0, true, 'Confirm']);
  const accept = boxEl('button', 'Accept toate', box(900, 700, 100, 40));
  const refuse = boxEl('button', 'Refuză toate', box(1010, 700, 100, 40));
  const more = boxEl('a', 'Detalii', box(10, 700, 60, 20));
  const banner = Object.assign(boxEl('div', 'Prin apăsarea Accept toate', box(0, 600, 1200, 200)), { style: { ...shown, position: 'fixed' }, querySelectorAll: () => [accept, more, refuse] });
  const para = boxEl('p', 'Prin apăsarea Accept toate', box(10, 610, 800, 60), banner);
  const inView = boxEl('button', 'Pret crescator', box(10, 620, 100, 30));
  const d = plain(findOn(inView, () => para, { numbered: { 208: accept, 209: refuse } }));
  assert.deepStrictEqual([d.covered, d.hitN, d.hitButtons], [true, null, [{ n: 208, label: 'Accept toate' }, { n: 209, label: 'Refuză toate' }]]);
  const parkedLow = (cover, move) => {
    const t = boxEl('button', 'Pret crescator', box(10, 900, 100, 40));
    t.onScroll = () => { t.rect = box(10, 760, 100, 40); };
    const bys = [];
    const scrollBy = (o) => { bys.push({ ...o }); t.rect = move(t.rect, o); };
    const under = (x, y) => (y >= 800 ? null : y >= cover.rect.top && y < cover.rect.bottom ? cover : t);
    return { t, bys, run: () => findOn(t, under, { numbered: { 208: accept, 209: refuse }, extra: { scrollBy } }) };
  };
  const card = Object.assign(boxEl('div', 'Prin apăsarea Accept toate', box(0, 584, 1200, 200)), { style: { ...shown, position: 'fixed' }, querySelectorAll: () => [accept, refuse] });
  const lifted = parkedLow(card, (r, o) => box(10, r.top - o.top, 100, 40));
  const e = plain(await lifted.run());
  assert.deepStrictEqual(lifted.bys, [{ left: 0, top: 220, behavior: 'instant' }], 'a floating card near the bottom scrolls the target up past it');
  assert.deepStrictEqual([e.covered, e.y], [false, 560]);
  const away = parkedLow(card, () => box(10, 788, 100, 40));
  const f = plain(await away.run());
  assert.deepStrictEqual([f.covered, f.y, f.hitButtons], [true, 780, [{ n: 208, label: 'Accept toate' }, { n: 209, label: 'Refuză toate' }]], 'a retry that lands off the viewport keeps the first refusal');
  const bar = Object.assign(boxEl('div', 'Cos', box(0, 720, 1200, 80)), { style: { ...shown, position: 'fixed' } });
  const barred = parkedLow(bar, (r, o) => box(10, r.top - o.top, 100, 40));
  const g = plain(await barred.run());
  assert.deepStrictEqual([barred.bys, g.covered, g.y], [[{ left: 0, top: 84, behavior: 'instant' }], false, 696]);
  const layer = Object.assign(boxEl('div', 'Prin apăsarea Accept toate', box(0, 0, 1200, 800)), { style: { ...shown, position: 'static', zIndex: '5' }, querySelectorAll: () => [accept, refuse] });
  const text = boxEl('p', 'Prin apăsarea Accept toate', box(10, 610, 800, 60), layer);
  const h = plain(findOn(inView, () => text, { numbered: { 208: accept, 209: refuse } }));
  assert.deepStrictEqual(h.hitButtons, [{ n: 208, label: 'Accept toate' }, { n: 209, label: 'Refuză toate' }], 'a big z-indexed layer with no positioned ancestor names its buttons');
  const roled = (role, text, kids) => Object.assign(boxEl('div', text, box(0, 540, 1200, 260)), { style: { ...shown, position: 'fixed' }, getAttribute: (a) => (a === 'role' ? role : null), querySelectorAll: () => kids });
  const decline = boxEl('button', 'Decline', box(900, 560, 100, 40));
  const agree = boxEl('button', 'Accept', box(1010, 560, 100, 40));
  const region = roled('region', 'Cookie banner', [decline, agree]);
  const i = plain(findOn(inView, () => region, { numbered: { 274: region, 277: decline, 278: agree } }));
  assert.deepStrictEqual([i.covered, i.hitN, i.hitButtons], [true, 274, [{ n: 277, label: 'Decline' }, { n: 278, label: 'Accept' }]], 'a numbered tabindexed region names its own buttons');
  const realBtn = Object.assign(boxEl('button', 'Filtre', box(0, 600, 1200, 200)), { querySelectorAll: () => [decline] });
  const j = plain(findOn(inView, () => realBtn, { numbered: { 8: realBtn, 277: decline } }));
  assert.deepStrictEqual([j.covered, j.hitN, j.hitConsequential, j.hitButtons], [true, 8, null, undefined], 'a numbered real control is its own answer');
  const del = boxEl('button', 'Delete account', box(900, 560, 100, 40));
  const keep = boxEl('button', 'Cancel', box(1010, 560, 100, 40));
  const dialog = roled('dialog', 'Your account', [del, keep]);
  del.parentElement = del.parentNode = dialog;
  const k = plain(findOn(inView, () => del, { numbered: { 30: dialog, 31: del, 32: keep } }));
  assert.deepStrictEqual([k.hitN, k.hitConsequential, k.hitButtons], [31, 'deletion', undefined], 'a ⚠ hit keeps the --confirm reply');
  const l = plain(findOn(inView, () => dialog, { numbered: { 30: dialog, 31: del, 32: keep } }));
  assert.deepStrictEqual([l.hitN, l.hitConsequential, l.hitButtons], [30, null, [{ n: 31, label: 'Delete account' }, { n: 32, label: 'Cancel' }]], 'a numbered dialog lists its buttons, ⚠ ones included');
});

test('FIND: a bare backdrop with no buttons names the topmost on-screen dialog beside it and that dialog\'s buttons', () => {
  const box = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });
  const plain = (o) => JSON.parse(JSON.stringify(o));
  const shown = { visibility: 'visible', display: 'block', opacity: '1' };
  const labels = ['Mai multe informații', 'aici', 'Listă parteneri (furnizori)', 'VREAU SA MODIFIC SETARILE INDIVIDUAL', 'ACCEPT TOATE'];
  const btns = labels.map((t, i) => boxEl('button', t, box(300 + i * 100, 300, 90, 40)));
  const consent = Object.assign(boxEl('div', '', box(0, 0, 1200, 800)), { id: 'onetrust-consent-sdk', style: { ...shown, position: 'fixed', zIndex: 'auto' }, querySelectorAll: () => btns });
  const backdrop = Object.assign(boxEl('div', '', box(0, 0, 1200, 800), consent), { style: { ...shown, position: 'fixed', zIndex: '2147483645' } });
  const banner = Object.assign(boxEl('div', 'Banner pentru cookie-uri', box(300, 60, 600, 300), consent), { id: 'onetrust-banner-sdk', style: { ...shown, position: 'fixed', zIndex: '2147483646' }, querySelectorAll: () => btns });
  const gone = Object.assign(boxEl('div', '', box(0, 0, 1200, 800)), { id: 'cookie-old', style: { ...shown, position: 'fixed', display: 'none', zIndex: '9999999999' }, querySelectorAll: () => btns });
  const offscreen = Object.assign(boxEl('div', '', box(0, 900, 1200, 100)), { id: 'cookie-low', style: { ...shown, position: 'fixed', zIndex: '9999999999' }, querySelectorAll: () => btns });
  const group = Object.assign(boxEl('div', '', box(300, 300, 600, 40), banner), { id: 'onetrust-button-group', style: { ...shown, zIndex: 'auto' }, querySelectorAll: () => btns.slice(3) });
  const bar = Object.assign(boxEl('div', '', box(0, 700, 1200, 100)), { className: 'cookie-bar', style: { ...shown, position: 'fixed', zIndex: '10' }, querySelectorAll: () => btns });
  const links = Object.assign(boxEl('div', '', box(0, 760, 1200, 40)), { id: 'cookie-links', style: { ...shown, position: 'static', zIndex: '99999999999' }, querySelectorAll: () => btns });
  const inView = boxEl('button', 'Sortare:', box(1100, 170, 80, 40));
  const numbered = Object.fromEntries(btns.map((b, i) => [10 + i, b]));
  const document = (dialogs) => ({ elementFromPoint: () => backdrop, querySelectorAll: () => dialogs, documentElement: {}, createTreeWalker: () => ({ nextNode: () => null }) });
  const a = plain(findOn(inView, () => backdrop, { numbered, extra: { document: document([consent, gone, offscreen, banner, group, bar, links]) } }));
  assert.deepStrictEqual([a.covered, a.hitN, a.hitDialog, a.hitButtons[0], a.hitButtons.length], [true, null, 'onetrust-banner-sdk', { n: 14, label: 'ACCEPT TOATE' }, 5]);
  assert.match(R.TEXT.covered(5, a), /^\[5\] "Sortare:" is covered at its click point by an unnumbered element \("div"\) whose dialog "onetrust-banner-sdk" has buttons \[14\] "ACCEPT TOATE" · \[10\] "Mai multe informații" · /);
  const inner = Object.assign(boxEl('div', '', box(300, 300, 600, 40), consent), { id: 'ot-sdk-row', style: { ...shown, position: 'sticky', zIndex: 'auto' }, querySelectorAll: () => btns.slice(3) });
  assert.strictEqual(plain(findOn(inView, () => backdrop, { numbered, extra: { document: document([consent, inner]) } })).hitDialog, 'onetrust-consent-sdk', 'at equal z the outer dialog keeps its place over a part nested in it');
  const classed = Object.assign(boxEl('div', '', box(0, 600, 1200, 200)), { getAttribute: (k) => (k === 'class' ? ' consent-banner shown' : null), style: { ...shown, position: 'fixed', zIndex: '5' }, querySelectorAll: () => btns });
  assert.strictEqual(plain(findOn(inView, () => backdrop, { numbered, extra: { document: document([classed]) } })).hitDialog, 'consent-banner', 'a dialog with no id is named by its first class');
  assert.strictEqual(plain(findOn(inView, () => backdrop, { numbered, extra: { document: document([links]) } })).hitDialog, undefined, 'an in-flow cookie footer is not a dialog');
  const b = plain(findOn(inView, () => backdrop, { numbered, extra: { document: document([gone, offscreen]) } }));
  assert.deepStrictEqual([b.covered, b.hitButtons, b.hitDialog], [true, undefined, undefined], 'no on-screen dialog leaves the bare cover reply');
  const c = plain(findOn(inView, () => backdrop, { numbered: {}, extra: { document: document([banner]) } }));
  assert.deepStrictEqual([c.hitButtons, c.hitDialog], [undefined, undefined], 'a dialog with no numbered button is not named');
});

test('FIND: a cover lists its accept/reject/close buttons first and up to eight of them', () => {
  const box = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });
  const plain = (o) => JSON.parse(JSON.stringify(o));
  const shown = { visibility: 'visible', display: 'block', opacity: '1' };
  const coverWith = (labels) => {
    const btns = labels.map((t, i) => boxEl('button', t, box(10 + i * 50, 700, 40, 20)));
    const banner = Object.assign(boxEl('div', 'Cookie consent', box(0, 600, 1200, 200)), { style: { ...shown, position: 'fixed' }, querySelectorAll: () => btns });
    const para = boxEl('p', 'Cookie consent', box(10, 610, 800, 60), banner);
    const inView = boxEl('button', 'Pret crescator', box(10, 620, 100, 30));
    const numbered = Object.fromEntries(btns.map((b, i) => [300 + i, b]));
    return plain(findOn(inView, () => para, { numbered })).hitButtons;
  };
  const five = coverWith(['Detalii', 'Parteneri', 'Politica', 'Setări', 'ACCEPT TOATE', '×']);
  assert.deepStrictEqual(five.map((b) => b.label), ['ACCEPT TOATE', '×', 'Detalii', 'Parteneri', 'Politica', 'Setări']);
  assert.deepStrictEqual(five.map((b) => b.n), [304, 305, 300, 301, 302, 303]);
  const ten = coverWith(Array.from({ length: 10 }, (_, i) => `Link ${i}`));
  assert.deepStrictEqual(ten.map((b) => b.label), Array.from({ length: 8 }, (_, i) => `Link ${i}`));
});

test('page scripts: FIND and INSPECT share one clipOf from DEEP', () => {
  for (const src of [scripts.FIND(1), scripts.INSPECT(1)]) assert.strictEqual(src.split('const clipOf = ').length, 2);
  assert.match(scripts.FIND(1), /const clip = clipOf\(el\);\n\s*const outside = outOf\(r0, /);
  assert.match(scripts.INSPECT(1), /const list = clipOf\(el\);/);
  assert.match(scripts.INSPECT(1), /clipped: !!list && outOf\(r, list\.rect\),/);
});

test('enterRefusal: Enter that would submit a consequential target is refused without --confirm; type and key gate before acting', async () => {
  const card = { from: 26, n: 27, label: 'Card bancar', consequential: 'payment' };
  const calls = [];
  const isolated = (target) => async (code) => { calls.push(code); return target; };
  const e = await enterRefusal(isolated(card), 26, { enter: true });
  assert.strictEqual(e.code, 'CONSEQUENTIAL');
  assert.strictEqual(e.message, 'Enter in [26] would submit through [27] "Card bancar" which looks consequential (payment) — re-issue with --confirm if the operator asked for it');
  assert.strictEqual(calls[0], scripts.SUBMIT_TARGET(26));
  const k = await enterRefusal(isolated(card), null, { key: 'Enter' });
  assert.strictEqual(k.message, 'Enter in [26] would submit through [27] "Card bancar" which looks consequential (payment) — re-issue with --confirm if the operator asked for it');
  assert.strictEqual(calls[1], scripts.SUBMIT_TARGET(null));
  assert.strictEqual(await enterRefusal(isolated(card), 26, { enter: true, confirm: true }), null);
  assert.strictEqual(calls.length, 2, '--confirm skips the probe');
  const lost = await enterRefusal(isolated(null), 26, { enter: true });
  assert.strictEqual(lost.code, 'INTERNAL', 'a probe that failed or timed out refuses instead of letting Enter through');
  assert.strictEqual(lost.message, 'could not tell what Enter would submit — read again, or add --confirm if the operator asked for it');
  assert.strictEqual(await enterRefusal(isolated({ none: true }), 26, { enter: true }), null);
  assert.strictEqual(await enterRefusal(isolated({ ...card, consequential: null }), 26, { enter: true }), null);
  const typeGate = /const refused = consequentialRefusal\(n, el, !!args\.confirm\);\n\s*if \(refused\) throw refused;\n\s*const refusedEnter = op === 'type' && args\.enter \? await enterRefusal\(\(code\) => inIsolated\(wc, code\), n, args\) : null;\n\s*if \(refusedEnter\) throw refusedEnter;\n\s*dispatch\(svc, \{ type: 'describe'/;
  assert.match(CHILD_SRC, typeGate, 'type refuses before it types anything, and only with --enter');
  const keyGate = /const refusedKey = args\.key === 'Enter' \|\| args\.key === 'Space' \|\| scripts\.ARROW_KEYS\.includes\(args\.key\) \? await enterRefusal\(\(code\) => inIsolated\(wc, code\), null, args\) : null;\n\s*if \(refusedKey\) throw refusedKey;\n\s*const pre = await preAct\(svc, null\);\n\s*const \{ idle \} = await act\(wc, \(\) => driver\.pressKey\(wc, args\.key\)/;
  assert.match(CHILD_SRC, keyGate, 'key probes only for Enter, Space and the arrows, before pressing');
  const btn = { from: 2, n: 2, press: true, label: 'Card bancar', consequential: 'payment' };
  const sp = await enterRefusal(isolated(btn), null, { key: 'Space' });
  assert.strictEqual(sp.code, 'CONSEQUENTIAL');
  assert.strictEqual(sp.message, 'Space on [2] would press [2] "Card bancar" which looks consequential (payment) — re-issue with --confirm if the operator asked for it');
  assert.strictEqual(calls[calls.length - 1], scripts.SUBMIT_TARGET(null, 'Space'));
  assert.notStrictEqual(scripts.SUBMIT_TARGET(null, 'Space'), scripts.SUBMIT_TARGET(null, 'Enter'));
  assert.strictEqual(await enterRefusal(isolated({ none: true }), null, { key: 'Space' }), null, 'Space on a text field proceeds');
  assert.strictEqual((await enterRefusal(isolated(null), null, { key: 'Space' })).message,
    'could not tell what Space would press — read again, or add --confirm if the operator asked for it');
  assert.strictEqual(CHILD_SRC.match(/SUBMIT_TARGET/g).length, 1);
  const transfer = { from: 1, n: 2, press: true, choose: true, label: 'Transfer', consequential: 'transfer' };
  const down = await enterRefusal(isolated(transfer), null, { key: 'ArrowDown' });
  assert.strictEqual(down.code, 'CONSEQUENTIAL');
  assert.strictEqual(down.message, 'ArrowDown on [1] would choose [2] "Transfer" which looks consequential (transfer) — re-issue with --confirm if the operator asked for it');
  assert.strictEqual(calls[calls.length - 1], scripts.SUBMIT_TARGET(null, 'ArrowDown'));
  assert.strictEqual(await enterRefusal(isolated({ ...transfer, label: 'Card', consequential: null }), null, { key: 'ArrowDown' }), null, 'a plain next radio proceeds');
  const method = { from: 3, n: 3, press: true, choose: true, change: true, label: 'Payment method', consequential: 'payment' };
  assert.strictEqual((await enterRefusal(isolated(method), null, { key: 'ArrowUp' })).message,
    'ArrowUp on [3] would change [3] "Payment method" which looks consequential (payment) — re-issue with --confirm if the operator asked for it');
  assert.strictEqual(await enterRefusal(isolated(transfer), null, { key: 'ArrowDown', confirm: true }), null);
});

test('page scripts: SUBMIT_TARGET finds the default submit of the field\'s form, or the focused element for key Enter', () => {
  const byN = scripts.SUBMIT_TARGET(26);
  assert.ok(byN.includes(JSON.stringify('button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]')));
  assert.match(byN, /window\.__cxEls\[26\]/);
  assert.ok(!byN.includes('document.activeElement'));
  const focused = scripts.SUBMIT_TARGET(null);
  assert.match(focused, /let el = document\.activeElement;\n\s*while \(el && el\.shadowRoot && el\.shadowRoot\.activeElement\) el = el\.shadowRoot\.activeElement;/);
  assert.match(focused, /const hit = consequentialHit\(\{ action \}, \[\]\);/);
  assert.match(focused, /consequential: cqOf\(btn\)/);
  assert.doesNotThrow(() => new Function(byN));
  assert.doesNotThrow(() => new Function(focused));
});

test('page scripts: SUBMIT_TARGET picks what Enter activates — the default submit in tree order (image buttons too), else the lone-field form, else nothing', () => {
  const src = scripts.SUBMIT_TARGET(26);
  const body = src.slice(src.indexOf('  const numOf'), src.lastIndexOf('})()'));
  const SEL = 'button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]';
  const mk = (tag, o = {}) => ({ tagName: tag.toUpperCase(), type: o.type || '', form: o.form || null, label: o.label || '', isContentEditable: !!o.editable, attrs: o.attrs || {},
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, hasAttribute(k) { return k in this.attrs; } });
  const defaultSubmit = (e) => (e.tagName === 'BUTTON' && !['button', 'reset'].includes(e.type)) || (e.tagName === 'INPUT' && ['submit', 'image'].includes(e.type));
  let rooted = [];
  const root = { querySelectorAll: (sel) => { assert.strictEqual(sel, SEL); return rooted.filter(defaultSubmit); } };
  const run = (el, page, cq = {}) => {
    rooted = page.tree;
    const els = { 26: el, ...page.numbered };
    const win = { __cxEls: Object.fromEntries(Object.entries(els).map(([k, e]) => [k, { deref: () => e }])) };
    const doc = { querySelectorAll: () => [] };
    const tag = el.tagName.toLowerCase();
    return new Function('el', 'tag', 'type', 'label', 'labelOf', 'cqOf', 'consequentialHit', 'document', 'window', body)(
      el, tag, el.type, el.label, (e) => e.label, (e) => cq[e.label] || null, scripts.consequentialHit, doc, win);
  };
  const form = (action, fields = []) => ({ getAttribute: () => action, elements: fields, getRootNode: () => root });
  const shop = form('/cart');
  const amount = mk('input', { type: 'text', form: shop, label: 'Amount' });
  const qty = mk('input', { type: 'text', form: shop, label: 'Qty' });
  const buy = mk('input', { type: 'image', form: shop, label: 'Buy now' });
  shop.elements = [amount, qty];
  assert.deepStrictEqual(run(amount, { tree: [amount, qty, buy], numbered: { 27: buy } }, { 'Buy now': 'purchase' }),
    { from: 26, n: 27, label: 'Buy now', consequential: 'purchase' }, 'an image button is the default submit though form.elements omits it');
  const lit = form('/x');
  const card = mk('input', { type: 'submit', form: lit, label: 'Card bancar' });
  const cardNo = mk('input', { type: 'text', form: lit, label: 'Card' });
  lit.elements = [cardNo, mk('input', { type: 'text', form: lit, label: 'CVV' }), card];
  assert.deepStrictEqual(run(cardNo, { tree: [cardNo, card], numbered: { 29: card } }, { 'Card bancar': 'payment' }),
    { from: 26, n: 29, label: 'Card bancar', consequential: 'payment' }, 'a form inside a shadow root finds its submit through the form\'s root, not document');
  const other = mk('button', { form: form('/delete'), label: 'Delete' });
  const pay = mk('button', { form: shop, label: 'Plata' });
  assert.deepStrictEqual(run(amount, { tree: [other, amount, pay], numbered: { 28: pay } }, { Delete: 'deletion', Plata: 'payment' }),
    { from: 26, n: 28, label: 'Plata', consequential: 'payment' }, 'a submit owned by another form is skipped');
  const plata = form('/checkout/pay');
  const sum = mk('input', { type: 'text', form: plata, label: 'Suma' });
  plata.elements = [sum, mk('input', { type: 'hidden', form: plata })];
  const tree = [sum, mk('input', { type: 'reset', form: plata }), mk('button', { type: 'button', form: plata, label: 'Back' })];
  assert.deepStrictEqual(run(sum, { tree, numbered: {} }), { from: 26, n: null, label: 'pay', consequential: 'payment' }, 'reset and type=button are not submits; implicit submission judges the action');
  plata.elements = [sum, mk('input', { type: 'email', form: plata })];
  assert.deepStrictEqual(run(sum, { tree, numbered: {} }), { none: true }, 'two fields and no submit: Enter submits nothing');
  assert.deepStrictEqual(run(mk('textarea', { form: shop }), { tree: [buy], numbered: {} }), { none: true });
  assert.deepStrictEqual(run(mk('div', { editable: true }), { tree: [], numbered: {} }), { none: true });
  assert.deepStrictEqual(run(mk('input', { type: 'text' }), { tree: [buy], numbered: {} }), { none: true }, 'no form');
  const focusedBtn = mk('button', { form: shop, label: 'Card bancar' });
  assert.deepStrictEqual(run(focusedBtn, { tree: [focusedBtn], numbered: {} }, { 'Card bancar': 'payment' }),
    { from: 26, n: 26, press: true, label: 'Card bancar', consequential: 'payment' });
  const order = form('/x');
  const confirm = mk('input', { type: 'checkbox', form: order, label: 'Confirm order' });
  const ship = mk('input', { type: 'radio', form: order, label: 'Courier' });
  const country = mk('select', { form: order, label: 'Country' });
  const place = mk('button', { form: order, label: 'Place order' });
  order.elements = [confirm, ship, country, place];
  const placed = { from: 26, n: 11, label: 'Place order', consequential: 'purchase' };
  for (const el of [confirm, ship, country]) {
    assert.deepStrictEqual(run(el, { tree: [el, place], numbered: { 11: place } }, { 'Place order': 'purchase' }), placed, `${el.type || 'select'} submits through the form's default submit`);
  }
  const two = form('/checkout/pay');
  const box = mk('input', { type: 'checkbox', form: two, label: 'Agree' });
  two.elements = [box, mk('input', { type: 'text', form: two }), mk('input', { type: 'text', form: two })];
  assert.deepStrictEqual(run(box, { tree: [box], numbered: {} }), { none: true }, 'a checkbox in a form with two fields and no submit submits nothing');
  two.elements = [box];
  assert.deepStrictEqual(run(box, { tree: [box], numbered: {} }), { none: true }, 'a checkbox-only form with no submit submits nothing');
});

test('page scripts: SUBMIT_TARGET for Space presses a focused button, checkbox or radio, never a link or a text field', () => {
  const src = scripts.SUBMIT_TARGET(null, 'Space');
  const body = src.slice(src.indexOf('  const numOf'), src.lastIndexOf('})()'));
  const mk = (tag, type, attrs = {}) => ({ tagName: tag.toUpperCase(), type, label: 'Card bancar', isContentEditable: false, form: {},
    getAttribute: (k) => (k in attrs ? attrs[k] : null), hasAttribute: (k) => k in attrs });
  const run = (el) => new Function('el', 'tag', 'type', 'label', 'cqOf', 'window', body)(
    el, el.tagName.toLowerCase(), el.type, el.label, () => 'payment', { __cxEls: { 2: { deref: () => el } } });
  const pressed = { from: 2, n: 2, press: true, label: 'Card bancar', consequential: 'payment' };
  for (const el of [mk('button', 'submit'), mk('input', 'submit'), mk('input', 'image'), mk('input', 'checkbox'), mk('input', 'radio'), mk('div', '', { role: 'button' })]) {
    assert.deepStrictEqual(run(el), pressed, `${el.tagName} ${el.type}`);
  }
  for (const el of [mk('a', '', { href: '/pay' }), mk('input', 'text'), mk('textarea', ''), mk('div', '', { role: 'link' })]) {
    assert.deepStrictEqual(run(el), { none: true }, `${el.tagName} ${el.type}`);
  }
  assert.ok(!src.includes('consequentialHit({ action }'), 'Space never submits a form');
});

test('page scripts: SUBMIT_TARGET for an arrow key chooses the next or previous radio of the focused one\'s group, or changes a focused select', () => {
  const mk = (tag, type, o = {}) => ({ tagName: tag.toUpperCase(), type, name: o.name || '', form: o.form || null, label: o.label || '', disabled: !!o.disabled, multiple: !!o.multiple,
    getAttribute: () => null, hasAttribute: () => false });
  const run = (key, el, tree, numbered = {}) => {
    const src = scripts.SUBMIT_TARGET(null, key);
    const body = src.slice(src.indexOf('  const numOf'), src.lastIndexOf('})()'));
    el.getRootNode = () => ({ querySelectorAll: (sel) => { assert.strictEqual(sel, 'input[type=radio]'); return tree.filter((e) => e.type === 'radio'); } });
    const els = { 1: el, ...numbered };
    const win = { __cxEls: Object.fromEntries(Object.entries(els).map(([k, e]) => [k, { deref: () => e }])) };
    return new Function('el', 'tag', 'type', 'label', 'labelOf', 'cqOf', 'window', body)(
      el, el.tagName.toLowerCase(), el.type, el.label, (e) => e.label, (e) => (e.label === 'Transfer' ? 'transfer' : e.label === 'Payment method' ? 'payment' : null), win);
  };
  const pay = {};
  const card = mk('input', 'radio', { name: 'm', form: pay, label: 'Card' });
  const transfer = mk('input', 'radio', { name: 'm', form: pay, label: 'Transfer' });
  const cash = mk('input', 'radio', { name: 'm', form: pay, label: 'Cash' });
  const other = mk('input', 'radio', { name: 'x', form: pay, label: 'Other group' });
  const tree = [card, other, transfer, cash];
  const nums = { 2: transfer, 3: cash, 4: other };
  const chose = (n, label, consequential = null) => ({ from: 1, n, press: true, choose: true, label, consequential });
  assert.deepStrictEqual(run('ArrowDown', card, tree, nums), chose(2, 'Transfer', 'transfer'), 'next in the group, skipping another name');
  assert.deepStrictEqual(run('ArrowRight', card, tree, nums), chose(2, 'Transfer', 'transfer'));
  assert.deepStrictEqual(run('ArrowUp', card, tree, nums), chose(3, 'Cash'), 'previous wraps to the last');
  assert.deepStrictEqual(run('ArrowLeft', card, tree, nums), chose(3, 'Cash'));
  assert.deepStrictEqual(run('ArrowDown', cash, tree, { 2: card }), { from: 1, n: 2, press: true, choose: true, label: 'Card', consequential: null }, 'next wraps to the first');
  const elsewhere = mk('input', 'radio', { name: 'm', form: {}, label: 'Transfer' });
  assert.deepStrictEqual(run('ArrowDown', card, [card, elsewhere], { 2: elsewhere }), { none: true }, 'same name in another form is another group');
  const method = mk('select', '', { label: 'Payment method' });
  assert.deepStrictEqual(run('ArrowDown', method, []), { from: 1, n: 1, press: true, choose: true, change: true, label: 'Payment method', consequential: 'payment' });
  assert.deepStrictEqual(run('ArrowDown', mk('select', '', { label: 'Payment method', multiple: true }), []), { none: true });
  assert.deepStrictEqual(run('ArrowDown', mk('input', 'text', { label: 'Amount' }), []), { none: true }, 'arrows move the caret');
  assert.deepStrictEqual(run('ArrowDown', mk('input', 'checkbox', { label: 'Transfer' }), []), { none: true });
});

test('child: op close hides the window before closing it, waits for closed, sweeps unowned same-title orphans, keeping the partition', () => {
  const body = CHILD_SRC.slice(CHILD_SRC.indexOf('async function opClose(name)'), CHILD_SRC.indexOf('async function opForget(profile)'));
  assert.match(body, /const tabs = tabOf\(name\) \|\| !windowsOf\(name\)\.length \? \[need\(name\)\] : windowsOf\(name\);\n\s*for \(const svc of tabs\) \{\n\s*if \(svc\.win\.isDestroyed\(\)\) continue;\n\s*shut\.set\(svc\.name, name\);\n\s*const closed = new Promise\(\(resolve\) => svc\.win\.once\('closed', resolve\)\);\n\s*svc\.win\.hide\(\);\n\s*svc\.win\.close\(\);\n\s*await closed;\n\s*const owned = new Set\(\[\.\.\.services\.values\(\)\]\.map\(\(s\) => s\.win\)\);\n\s*for \(const w of BrowserWindow\.getAllWindows\(\)\) \{\n\s*if \(!w\.isDestroyed\(\) && !owned\.has\(w\) && w\.getTitle\(\) === `\$\{svc\.name\} — Clodex Browser`\) w\.destroy\(\);\n\s*\}\n\s*\}\n\s*const also = tabs\.map\(\(s\) => s\.name\)\.filter\(\(n\) => n !== name\);\n\s*return \{ closed: name, also, windows: services\.size, electron: BrowserWindow\.getAllWindows\(\)\.length \};/);
  assert.ok(!/svc\.win\.destroy|clearStorageData|clearCache|forgetNumbers/.test(body), 'close destroys only unowned orphans and never clears the sign-in');
  assert.match(CHILD_SRC, /else if \(op === 'close'\) result = await serial\(name, \(\) => opClose\(name\)\);/);
});

test('child: a tab is stamped with its first opener; a close of chain x does not blame the operator for x:riot', () => {
  assert.ok(CHILD_SRC.includes('policy: null, barMsg: null, lastDenied: null, blockedNav: null, openedBy: null,'));
  assert.ok(CHILD_SRC.includes('const svc = openService(name);\n    if (created) svc.openedBy = frame.seat || null;'));
  assert.ok(CHILD_SRC.includes('...pageInfo(svc), openedBy: svc.openedBy, ...extra });'));
  assert.ok(CHILD_SRC.includes("const closedError = (name) => codedError('CLOSED', shut.has(name) ? `the ${name} window was closed by close ${shut.get(name)} — open it again` : `the operator closed the ${name} window — open it again`);"));
  assert.ok(CHILD_SRC.includes('opened.add(name);\n    shut.delete(name);'));
});

test('child: exits when reparented away from its host or sent SIGTERM', () => {
  assert.match(CHILD_SRC, /const PARENT_POLL_MS = 5000;/);
  assert.ok(CHILD_SRC.includes("const parentPid = process.ppid;\n  setInterval(() => { if (process.ppid !== parentPid) shutdown(); }, PARENT_POLL_MS).unref();\n  process.on('SIGTERM', () => shutdown());"));
});

test('child: a click with no change probes VALUE_CHOICE for the clicked element', () => {
  assert.ok(CHILD_SRC.includes("const done = await withChange(svc, pre, out, lateMsFor(op));\n        if ((done.changed === '' || done.watched) && !wc.isDestroyed()) {\n          const value = await inIsolated(wc, scripts.VALUE_CHOICE(n));\n          if (value && value.kind === 'choice' && typeof value.label === 'string') {\n            done.choice = value.label;\n            if (value.select) done.choiceKind = 'select';"));
});

test('page scripts: VALUE_ACTIVE and VALUE_CHOICE share CHOICE_OF; VALUE_CHOICE answers the numbered radio group', () => {
  assert.ok(scripts.VALUE_ACTIVE.includes(scripts.CHOICE_OF));
  assert.ok(scripts.VALUE_CHOICE(7).includes(scripts.CHOICE_OF));
  const radio = (label, value, checked) => ({ tagName: 'INPUT', type: 'radio', name: 'm', form: null, value, checked, isConnected: true, labels: [{ innerText: label }], innerText: '', id: '',
    getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [], closest: () => null, getBoundingClientRect: () => ({ height: 20 }) });
  const livrare = radio('Livrare', 'delivery', false);
  const ridicare = radio('Ridicare', 'pickup', true);
  ridicare.getRootNode = () => ({ querySelectorAll: () => [livrare, ridicare] });
  const win = { __cxEls: { 7: { deref: () => ridicare } } };
  assert.deepStrictEqual(new Function('window', 'document', `return ${scripts.VALUE_CHOICE(7)}`)(win, {}), { kind: 'choice', label: 'Ridicare', value: 'pickup' });
  assert.strictEqual(new Function('window', 'document', `return ${scripts.VALUE_CHOICE(8)}`)(win, {}), null);
});

test('page scripts: VALUE_CHOICE and TARGET_STATE on a label read its radio or checkbox control', () => {
  const radio = (label, value, checked) => ({ tagName: 'INPUT', type: 'radio', name: 'q', form: null, value, checked, isConnected: true, labels: [{ innerText: label }], innerText: '', id: '',
    getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [], closest: () => null, getBoundingClientRect: () => ({ height: 20 }) });
  const yes = radio('Yes', 'yes', false);
  const no = radio('No', 'no', true);
  no.getRootNode = () => ({ querySelectorAll: () => [yes, no] });
  const label = { tagName: 'LABEL', control: no, isConnected: true, getAttribute: () => null, parentElement: null };
  const plain = { tagName: 'LABEL', control: null, isConnected: true, getAttribute: () => null, parentElement: null };
  const win = { __cxEls: { 3: { deref: () => label }, 4: { deref: () => plain } } };
  const run = (code) => new Function('window', 'document', `return ${code}`)(win, {});
  assert.deepStrictEqual(run(scripts.VALUE_CHOICE(3)), { kind: 'choice', label: 'No', value: 'no' });
  assert.strictEqual(run(scripts.VALUE_CHOICE(4)), null);
  assert.deepStrictEqual(run(scripts.TARGET_STATE(3)), { el: { checked: true }, tile: null, panel: null });
  assert.deepStrictEqual(run(scripts.TARGET_STATE(4)), { el: {}, tile: null, panel: null });
});

test('page scripts: TARGET_STATE carries the state of the panel its target aria-controls', () => {
  const attrs = (o) => (k) => (k in o ? o[k] : null);
  const panel = { getAttribute: attrs({ class: 'panel open', 'aria-expanded': 'true' }) };
  const btn = { tagName: 'BUTTON', isConnected: true, getAttribute: attrs({ 'aria-controls': ' d e' }), parentElement: null };
  const win = { __cxEls: { 5: { deref: () => btn } } };
  const doc = { getElementById: (id) => (id === 'd' ? panel : null) };
  assert.deepStrictEqual(new Function('window', 'document', `return ${scripts.TARGET_STATE(5)}`)(win, doc), { el: {}, tile: null, panel: { class: 'panel open', 'aria-expanded': 'true' } });
  const shadowBtn = { ...btn, getRootNode: () => doc };
  const win2 = { __cxEls: { 5: { deref: () => shadowBtn } } };
  assert.deepStrictEqual(new Function('window', 'document', `return ${scripts.TARGET_STATE(5)}`)(win2, {}).panel, { class: 'panel open', 'aria-expanded': 'true' });
});

test('page scripts: consequentialHit with no terms judges a form by its action alone', () => {
  assert.deepStrictEqual(scripts.consequentialHit({ action: '/account/checkout' }, []), { cat: 'payment', term: 'checkout' });
  assert.strictEqual(scripts.consequentialHit({ action: '/cauta' }, []), null);
  assert.strictEqual(scripts.consequentialHit({ action: 'https://www.booking.com/searchresults.html' }, []), null);
  assert.strictEqual(scripts.consequentialHit({ action: '/notebook/save' }, []), null);
  assert.strictEqual(scripts.consequentialHit({ action: '/reorder-list' }, []), null);
  assert.strictEqual(scripts.consequentialHit({ action: '/display/settings' }, []), null);
  assert.deepStrictEqual(scripts.consequentialHit({ action: '/booking/confirm' }, []), { cat: 'booking', term: 'book' });
  assert.deepStrictEqual(scripts.consequentialHit({ action: '/hotel/book' }, []), { cat: 'booking', term: 'book' });
  assert.deepStrictEqual(scripts.consequentialHit({ action: 'https://shop.example/payment?ref=booking' }, []), { cat: 'payment', term: 'pay' });
  assert.strictEqual(scripts.consequentialHit({ label: 'Pay', action: '' }, []), null);
  assert.ok(scripts.READ_INTERACTIVE(false, {}).includes("action: submit && (e.hasAttribute('formaction') || !(form && String(form.getAttribute('method') || '').toLowerCase() === 'get')) ? "));
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
  const BADGE = "This property is part of our Preferred Partner Programme. It's committed to providing a great experience for guests, and it might pay Booking.com a little more to be in this programme.";
  const c = scripts.consequentialOf;
  const rows = [
    [{ label: 'Card bancar', control: true }, 'payment'], [{ label: 'Plătește' }, 'payment'], [{ label: 'Pay now' }, 'payment'],
    [{ value: 'Checkout' }, 'payment'], [{ aria: 'Confirm payment' }, 'payment'],
    [{ label: 'Cumpără acum' }, 'purchase'], [{ label: 'Place order' }, 'purchase'],
    [{ label: 'ȘTERGE' }, 'deletion'], [{ idClass: 'btn-delete' }, 'deletion'],
    [{ label: 'Ieşire' }, 'sign-out'], [{ label: 'Ieșire' }, 'sign-out'], [{ label: 'Log out' }, 'sign-out'], [{ idClass: 'logout ' }, 'sign-out'],
    [{ label: 'Abmelden' }, 'sign-out'],
    [{ label: 'Arm' }, 'alarm'], [{ label: 'Disarm' }, 'alarm'],
    [{ label: 'Dezabonare' }, 'unsubscribe'], [{ label: 'Cancel subscription' }, 'unsubscribe'],
    [{ label: 'Send money' }, 'transfer'], [{ formaction: '/transfer' }, 'transfer'],
    [{ label: 'Depune cererea', capped: true }, null], [{ label: 'DEPUNE ACUM', capped: true }, null],
    [{ label: 'Depune bani', control: true }, 'transfer'], [{ label: 'Depune 100 lei', control: true }, 'transfer'],
    [{ label: 'Trimite', action: '/plata/pay' }, 'payment'], [{ label: 'Go', action: '/orders/new' }, 'purchase'],
    [{ label: 'Carduri' }, null], [{ label: 'Avizier' }, null], [{ label: 'Armată' }, null], [{ label: 'Wireless' }, null],
    [{ label: 'Lista de plată pentru Bloc M4 Tabelul cu sumele de plată pe luna august', capped: true }, null],
    [{ label: 'Make payment', control: true }, 'payment'], [{ label: 'Submit payment', control: true }, 'payment'],
    [{ label: 'Plătește acum 335,90 Lei prin card bancar online', action: '/plata' }, 'payment'],
    [{ idClass: 'card card-body' }, null], [{ idClass: 'sort-order' }, null], [{ idClass: 'transfer-list' }, null],
    [{ label: 'Card bancar', textual: true, control: true }, null],
    [{ label: 'Card bancar' }, null], [{ label: 'Make payment' }, null],
    [{ label: 'Lista de plată', capped: true }, null], [{ label: 'Plati online', capped: true }, null],
    [{ label: 'Ordin de plată 12/2026', capped: true }, null], [{ label: 'Suma de plată 335,90 Lei', capped: true }, null],
    [{ label: 'Post' }, 'publish'], [{ label: 'Repost' }, 'publish'], [{ label: 'Like' }, 'publish'], [{ label: 'Follow @OpenAI' }, 'publish'],
    [{ label: 'Follow back' }, 'publish'], [{ label: 'Send' }, 'publish'], [{ aria: 'Share' }, null], [{ aria: '84 Likes. Like' }, 'publish'],
    [{ aria: 'Share post' }, null], [{ label: 'Distribuie' }, null], [{ aria: 'Send via Direct Message' }, 'publish'], [{ label: 'Trimite mesaj' }, 'publish'],
    [{ label: 'Caută', formaction: 'post.php', action: 'post.php', control: true }, null], [{ label: 'Caută', formaction: 'send.php' }, null],
    [{ label: 'Continuă', formaction: '/pay', action: '/pay', control: true }, 'payment'],
    [{ label: 'Trimite' }, 'publish'], [{ label: 'Latest posts', capped: true }, null], [{ label: 'Postal code', textual: true }, null],
    [{ label: 'Like-minded people', capped: true }, null], [{ label: 'Read the latest post' }, null],
    [{ label: 'Copy link' }, null], [{ label: 'Copy', idClass: 'btn-copy-user-from-search' }, 'trading'], [{ label: 'Copy', idClass: 'copy-btn' }, null],
    [{ label: 'Close' }, null], [{ label: 'Close', idClass: 'portfolio-position-list-button-close-position' }, 'trading'], [{ label: 'Close All' }, 'trading'],
    [{ label: 'Sell' }, 'trading'], [{ label: 'Sell your crypto' }, 'trading'], [{ label: 'Bestseller' }, null],
    [{ label: 'Trade' }, 'trading'], [{ label: 'Trade-in' }, 'trading'],
    [{ label: 'Deposit' }, 'transfer'], [{ label: 'Add Funds to USD' }, 'transfer'], [{ label: 'Withdraw' }, 'transfer'], [{ label: 'Create Wallet' }, 'transfer'],
    [{ label: '36', idClass: 'social-likes ets-icon-like' }, 'publish'], [{ label: '36', idClass: 'likely-list' }, null],
    [{ label: BADGE, control: true, capped: false }, null], [{ label: 'Pay now', control: true, capped: false }, 'payment'],
    [{ label: 'Review your basket details and then confirm payment to finish', control: true, capped: false }, 'payment'],
  ];
  for (const [d, want] of rows) assert.strictEqual(c(d), want, JSON.stringify(d));
  const ri = scripts.READ_INTERACTIVE(false, {});
  assert.match(ri, /const cq = cqOf\(el\);\n {4}items\.push\(\{ el, full, cq, line: \[kind, cq \? '⚠' : '', line\]\.filter\(Boolean\)\.join\(' '\) \+ flags/);
  assert.match(ri, /if \(it\.cq\) cats\[n\] = it\.cq;/);
  assert.ok(ri.includes("e.getAttribute('data-automation-id'), e.getAttribute('data-testid'), e.getAttribute('data-test')"));
  assert.match(ri, /control: button && !doc && \(!!\(form \|\| e\.closest\('form'\)\) \|\| e\.hasAttribute\('formaction'\)\),/);
});

test('page scripts: cqOf tags payment nouns only on a button or submit inside a form; links, display rows and documents never by a noun', () => {
  const src = scripts.FIND(1);
  const cqOf = new Function('vis', `${src.slice(src.indexOf('  const SIGN_OUT'), src.indexOf('  const rowText'))}\nreturn cqOf;`)((e) => !e.hidden);
  const el = (tag, text, o = {}) => {
    const attrs = { ...(o.attrs || {}) };
    return {
      tagName: tag.toUpperCase(), type: o.type || '', form: o.form || null, labels: null, innerText: text, value: o.value || '', isContentEditable: false, hidden: !!o.hidden,
      getAttribute: (k) => (k in attrs ? attrs[k] : null), hasAttribute: (k) => k in attrs, querySelectorAll: () => o.inner || [],
      closest: (sel) => (sel === 'form' && o.inForm ? {} : null),
      matches: (sel) => !o.plain && sel.split(',').some((x) => x === tag || x.startsWith(tag + '[') || x.startsWith(tag + ':')),
    };
  };
  const form = { getAttribute: () => '/index.php?page=10' };
  const rows = [
    ['input:submit Card bancar in the Datorii form', el('input', '', { type: 'submit', value: 'Card bancar', form }), 'payment'],
    ['button Plata in a form', el('button', 'Plata', { form }), 'payment'],
    ['role=button Plata inside a form', el('div', 'Plata', { attrs: { role: 'button' }, inForm: true, plain: true }), 'payment'],
    ['button Plata with formaction', el('button', 'Plata', { attrs: { formaction: '/x' } }), 'payment'],
    ['button Plata outside any form', el('button', 'Plata'), null],
    ['nav link Plati online', el('a', 'Plati online', { attrs: { href: '/plati' } }), null],
    ['link Lista de plată', el('a', 'Lista de plată', { attrs: { href: '/lista' } }), null],
    ['clickable row Suma de plată 335,90 Lei', el('div', 'Suma de plată 335,90 Lei', { plain: true }), null],
    ['clickable row Ordin de plată', el('tr', 'Ordin de plată 12', { plain: true }), null],
    ['document link role=button in a form', el('a', 'Plata', { attrs: { href: '/f/plata.pdf', role: 'button' }, inForm: true }), null],
    ['download link in a form', el('a', 'Plata', { attrs: { href: '/f', download: '' }, inForm: true }), null],
    ['link Ieşire (a verb) anywhere', el('a', 'Ieşire', { attrs: { href: 'index.php?page=5' } }), 'sign-out'],
    ['clickable Plătește (a verb)', el('div', 'Plătește', { plain: true }), 'payment'],
    ['label.btn around a hidden input:submit Plătește', el('label', '', { plain: true, inner: [el('input', '', { type: 'submit', value: 'Plătește', hidden: true })] }), 'payment'],
    ['div onclick around a hidden Card bancar submit in a form', el('div', '', { plain: true, inner: [el('input', '', { type: 'submit', value: 'Card bancar', form, hidden: true })] }), 'payment'],
    ['div onclick around a visible listed Card bancar submit: the submit carries the ⚠', el('div', '', { plain: true, inner: [el('input', '', { type: 'submit', value: 'Card bancar', form })] }), null],
    ['div role=button around a visible button Follow', el('div', 'OpenAI @OpenAI Follow', { attrs: { role: 'button' }, plain: true, inner: [el('button', 'Follow')] }), null],
    ['clickable cell around a visible button Follow', el('div', 'OpenAI @OpenAI Follow', { plain: true, inner: [el('button', 'Follow')] }), null],
    ['clickable cell around a hidden button Follow', el('div', 'OpenAI @OpenAI Follow', { plain: true, inner: [el('button', 'Follow', { hidden: true })] }), 'publish'],
    ['the Follow button itself', el('button', 'Follow'), 'publish'],
    ['label around a Caută submit', el('label', '', { plain: true, inner: [el('input', '', { type: 'submit', value: 'Caută', form })] }), null],
    ['div around two submits takes neither', el('div', '', { plain: true, inner: [el('button', 'Plătește'), el('button', 'Caută')] }), null],
    ['role=link quote card with buy deep in 300 chars of text', { ...el('div', ('Markets moved today and traders weigh buy/sell decisions ' + 'x'.repeat(300)).slice(0, 300), { attrs: { role: 'link' } }), matches: () => true }, null],
    ['role=link Buy now', { ...el('div', 'Buy now', { attrs: { role: 'link' } }), matches: () => true }, 'purchase'],
  ];
  for (const [name, e, want] of rows) assert.strictEqual(cqOf(e), want, name);
  const cqHit = new Function('vis', `${src.slice(src.indexOf('  const SIGN_OUT'), src.indexOf('  const rowText'))}\nreturn cqHit;`)((e) => !e.hidden);
  assert.deepStrictEqual(cqHit({ ...el('div', 'Buy now', { attrs: { role: 'link' } }), matches: () => true }), { cat: 'purchase', term: 'buy' });
  assert.deepStrictEqual(cqHit(el('button', 'Go', { form: { getAttribute: () => '/orders/new' } })), { cat: 'purchase', term: 'order' });
  const article = (line, cards = []) => ({ tagName: 'ARTICLE', innerText: `musclebooster\n@musclebooster_\n${line}\nNo gym. No complicated equipment`, parentElement: null, querySelectorAll: (sel) => (sel === '[role=link]' ? cards : []) });
  const inside = (e, art) => ({ ...e, closest: (sel) => (sel === 'article' ? art : e.closest(sel)) });
  const wrapper = () => el('div', 'musclebooster @musclebooster_ Ad No gym. No complicated equi', { plain: true });
  assert.deepStrictEqual(cqHit(inside(wrapper(), article('Ad'))), { cat: 'ad', term: 'Ad' });
  assert.strictEqual(cqOf(inside(wrapper(), article('Promoted'))), 'ad');
  assert.strictEqual(cqHit(inside(wrapper(), article('Admittedly'))), null);
  assert.strictEqual(cqOf(inside(el('button', 'Like'), article('Ad'))), 'publish');
  assert.strictEqual(cqHit(inside(el('a', '268K views', { attrs: { href: '/x/status/1/analytics' } }), article('Ad'))), null);
  const quoteCard = { tagName: 'DIV', innerText: 'Jev\n@jev\nAd\nquoted words' };
  assert.strictEqual(cqHit(inside(wrapper(), article('Jev\n@jev\nAd\nquoted words', [quoteCard]))), null);
  assert.deepStrictEqual(cqHit(inside(wrapper(), article('Ad\nJev\n@jev\nquoted words', [{ tagName: 'DIV', innerText: 'Jev\n@jev\nquoted words' }]))), { cat: 'ad', term: 'Ad' });
  const adKeyOf = new Function('vis', `${src.slice(src.indexOf('  const SIGN_OUT'), src.indexOf('  const rowText'))}\nreturn adKeyOf;`)((e) => !e.hidden);
  const outer = article('Ad');
  const nested = { tagName: 'ARTICLE', innerText: 'quoted', parentElement: { closest: (sel) => (sel === 'article' ? outer : null) }, querySelectorAll: () => [] };
  const other = article('Promoted');
  const link = inside(el('a', '@musclebooster_', { attrs: { href: '/musclebooster_' } }), nested);
  assert.strictEqual(adKeyOf(inside(wrapper(), outer)), 0);
  assert.strictEqual(adKeyOf(link), 0);
  assert.strictEqual(adKeyOf(inside(wrapper(), other)), 1);
  assert.strictEqual(adKeyOf(inside(wrapper(), article('Admittedly'))), null);
  assert.strictEqual(adKeyOf(wrapper()), null);
  const ri = scripts.READ_INTERACTIVE(false, {});
  assert.match(ri, /if \(it\.cq === 'ad'\) \{ const k = adKeyOf\(it\.el\); if \(k != null\) adKeys\[n\] = k; \}/);
  assert.match(ri, /chrome, covered, cats, adKeys, posts:/);
  assert.match(CHILD_SRC, /cats: el\.cats \|\| \{\},\n\s*adKeys: el\.adKeys \|\| \{\},/);
  assert.match(scripts.INSPECT(1), /warn: cqHit\(el\),/);
});

test('page scripts: consequentialHit names the category and the source term; consequentialOf stays the bare category', () => {
  assert.deepStrictEqual(scripts.consequentialHit({ label: 'Go', action: '/orders/new' }), { cat: 'purchase', term: 'order' });
  assert.deepStrictEqual(scripts.consequentialHit({ label: 'Log out' }), { cat: 'sign-out', term: 'log out' });
  assert.strictEqual(scripts.consequentialOf({ label: 'Log out' }), 'sign-out');
  assert.strictEqual(scripts.consequentialHit({ label: 'Carduri' }), null);
});

test('page scripts: post edit history and a like count are not publish; a Like button and a like-classed button still are', () => {
  assert.strictEqual(scripts.consequentialHit({ label: 'post edit history', idClass: 'post-edit-history' }), null);
  assert.strictEqual(scripts.consequentialHit({ label: '19 likes', idClass: 'like-count' }), null);
  assert.strictEqual(scripts.consequentialHit({ label: '3 reactions', idClass: 'discourse-reactions-counter only-like' }), null);
  assert.strictEqual(scripts.consequentialHit({ label: '1 reaction', idClass: 'discourse-reactions-counter' }), null);
  assert.strictEqual(scripts.consequentialHit({ label: 'Like', idClass: 'like' }).cat, 'publish');
  assert.strictEqual(scripts.consequentialHit({ label: 'Post' }).cat, 'publish');
  assert.deepStrictEqual(scripts.consequentialHit({ label: 'Please sign up or log in to like this post', idClass: 'like' }), { cat: 'publish', term: 'like' });
  assert.strictEqual(scripts.labelFrom({ tag: 'button', label: '\u200b', title: 'Please sign up or log in to like this post' }), 'Please sign up or log in to like this post');
  assert.ok(String(scripts.labelFrom).includes("const flat = (s) => String(s == null ? '' : s).replace(/[\\u200b\\u200c\\u200d\\ufeff]/g, '').replace(/\\s+/g, ' ').trim();"));
});

test('page scripts: Forward is a publish verb; an Order Status/history link is not a purchase, Place order still is', () => {
  assert.deepStrictEqual(scripts.consequentialHit({ label: 'Forward' }), { cat: 'publish', term: 'forward' });
  assert.strictEqual(scripts.consequentialHit({ label: 'Order Status' }), null);
  assert.strictEqual(scripts.consequentialHit({ label: 'Order history' }), null);
  assert.deepStrictEqual(scripts.consequentialHit({ label: 'Go', action: '/orders/new' }), { cat: 'purchase', term: 'order' });
  assert.strictEqual(scripts.consequentialHit({ label: 'Place order' }).cat, 'purchase');
  assert.strictEqual(scripts.consequentialHit({ label: 'Order now' }).cat, 'purchase');
  assert.strictEqual(scripts.consequentialHit({ label: 'Sort order' }), null);
  assert.strictEqual(scripts.consequentialHit({ label: 'Order by date' }), null);
  assert.strictEqual(scripts.consequentialHit({ label: 'Order of columns' }), null);
  assert.deepStrictEqual(scripts.consequentialHit({ label: 'Place order' }), { cat: 'purchase', term: 'order' });
  assert.deepStrictEqual(scripts.consequentialHit({ label: 'Order now' }), { cat: 'purchase', term: 'order' });
});

test('page scripts: a has-delete class on a filter reset honours the row\'s unless; a delete label still hits', () => {
  assert.strictEqual(scripts.consequentialHit({ label: 'Sterge toate filtrele', idClass: 'has-delete' }), null);
  assert.deepStrictEqual(scripts.consequentialHit({ label: 'Sterge contul', idClass: 'has-delete' }), { cat: 'deletion', term: 'delete' });
});

test('page scripts: a label-less × that clears a field is never deletion; reserve/book controls are booking', () => {
  assert.strictEqual(scripts.consequentialHit({ label: 'Șterge', control: true, clearer: true }), null);
  assert.deepStrictEqual(scripts.consequentialHit({ label: 'Șterge anunțul', control: true, clearer: false }), { cat: 'deletion', term: 'sterge' });
  assert.strictEqual(scripts.consequentialHit({ label: 'Delete', control: true, clearer: true }), null);
  assert.deepStrictEqual(scripts.consequentialHit({ value: 'Delete', control: true, clearer: false }), { cat: 'deletion', term: 'delete' });
  assert.ok(scripts.READ_INTERACTIVE(false, {}).includes("clearer: button && tg !== 'input' && !String(e.innerText || '').replace(/[×✕✖⨯x\\s]/gi, '') && !!(e.parentElement && (e.parentElement.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),[role=combobox],[contenteditable=true]') || (e.parentElement.parentElement && e.parentElement.parentElement.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),[role=combobox]')))),"));
  assert.deepStrictEqual(scripts.consequentialHit({ label: 'Reserve your apartment stay', control: true }), { cat: 'booking', term: 'reserve' });
  assert.strictEqual(scripts.consequentialOf({ label: "I'll reserve", control: true }), 'booking');
  assert.strictEqual(scripts.consequentialOf({ label: 'Rezervă acum', control: true }), 'booking');
  assert.strictEqual(scripts.consequentialHit({ label: 'Book', control: true }), null);
  assert.deepStrictEqual(scripts.consequentialHit({ action: '/hotel/book' }), { cat: 'booking', term: 'book' });
  assert.strictEqual(scripts.consequentialOf({ label: 'Complete booking', capped: true }), 'booking');
});

test('page scripts: a sort button\'s third state is not deletion, a plain Remove still is', () => {
  assert.strictEqual(scripts.consequentialHit({ label: 'Age: Activate to remove sorting' }), null);
  assert.strictEqual(scripts.consequentialHit({ label: 'Age', aria: 'Age: Activate to remove sorting' }), null);
  assert.strictEqual(scripts.consequentialOf({ label: 'Remove' }), 'deletion');
});

test('page scripts: clickPoint lands a tall role=link card on its time link, a short one or a plain element at its centre', () => {
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const node = (tag, attrs, r, kids = []) => {
    const e = { tagName: tag.toUpperCase(), parentElement: null, kids, getAttribute: (k) => (k in attrs ? attrs[k] : null), getBoundingClientRect: () => r };
    for (const k of kids) k.parentElement = e;
    e.contains = (o) => { for (let x = o; x; x = x.parentElement) if (x === e) return true; return false; };
    e.closest = (sel) => { for (let x = e; x; x = x.parentElement) if (x.tagName.toLowerCase() === sel) return x; return null; };
    const all = () => e.kids.flatMap((k) => [k, ...(k.all ? k.all() : [])]);
    e.all = all;
    e.querySelectorAll = (sel) => all().filter((k) => k.tagName.toLowerCase() === sel);
    return e;
  };
  const doc = { createTreeWalker: () => ({ nextNode: () => null }) };
  const time = node('time', {}, rect(0, 0, 0, 0));
  const head = node('a', { href: '/cy/status/2' }, rect(20, 10, 200, 20), [time]);
  const photo = node('a', { href: '/cy/status/2/photo/1' }, rect(0, 100, 500, 270));
  const card = node('div', { role: 'link' }, rect(0, 0, 500, 370), [head, photo]);
  assert.deepStrictEqual(scripts.clickPoint(card, card.getBoundingClientRect(), doc), { x: 120, y: 20 });
  const short = node('div', { role: 'link' }, rect(0, 0, 500, 100), [node('a', {}, rect(20, 10, 200, 20), [node('time', {}, rect(0, 0, 0, 0))])]);
  assert.deepStrictEqual(scripts.clickPoint(short, short.getBoundingClientRect(), doc), { x: 250, y: 50 });
  const tallDiv = node('div', {}, rect(0, 0, 500, 370), [node('a', {}, rect(20, 10, 200, 20), [node('time', {}, rect(0, 0, 0, 0))])]);
  assert.deepStrictEqual(scripts.clickPoint(tallDiv, tallDiv.getBoundingClientRect(), doc), { x: 250, y: 185 });
  const text = { nodeValue: 'Cy @cy', parentElement: null };
  const textDoc = {
    createTreeWalker: () => { const q = [{ nodeValue: '  ' }, text]; return { nextNode: () => q.shift() || null }; },
    createRange: () => ({ selectNodeContents: () => {}, getBoundingClientRect: () => rect(30, 40, 60, 10) }),
  };
  const plainCard = node('div', { role: 'link' }, rect(0, 0, 500, 370), [photo]);
  assert.deepStrictEqual(scripts.clickPoint(plainCard, plainCard.getBoundingClientRect(), textDoc), { x: 60, y: 45 });
  const hiddenDoc = {
    createTreeWalker: () => { const q = [{ nodeValue: 'Open' }, text]; return { nextNode: () => q.shift() || null }; },
    createRange: () => { let n = null; return { selectNodeContents: (t) => { n = t; }, getBoundingClientRect: () => (n === text ? rect(30, 40, 60, 10) : rect(-9999, 0, 60, 10)) }; },
  };
  assert.deepStrictEqual(scripts.clickPoint(plainCard, plainCard.getBoundingClientRect(), hiddenDoc), { x: 60, y: 45 });
  const farTime = node('div', { role: 'link' }, rect(0, 0, 500, 370), [node('a', {}, rect(-9999, 10, 200, 20), [node('time', {}, rect(0, 0, 0, 0))])]);
  assert.deepStrictEqual(scripts.clickPoint(farTime, farTime.getBoundingClientRect(), doc), { x: 250, y: 185 });
  assert.match(scripts.FIND(1), /x: at\.x, y: at\.y,/);
});

test('page scripts: bulletItems marks each list item once so a filter on a reference returns that item alone, without its backref', () => {
  const t = (data) => ({ nodeType: 3, data });
  const e = (...childNodes) => ({ nodeType: 1, childNodes });
  const textOf = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(textOf).join(''));
  const ref = (back, body) => e(e(e(e(t(back)))), t(' '), e(t(body)));
  const lis = [ref('^ Jump up to: a b', 'Smith, J. (2020). Bucharest housing survey.'), ref('^', 'Ionescu, A. (2019). Bloc M4.'), ref('^', 'Doe 2001')];
  const nested = e(t('\n'), e(t('Inner item')));
  const chrome = e(t(`${scripts.CHROME_MARK}Acasa`));
  let asked = '';
  scripts.bulletItems({ querySelectorAll: (sel) => { asked = sel; return [...lis, nested, nested.childNodes[1], chrome]; } }, scripts.CHROME_MARK, () => false);
  assert.strictEqual(asked, 'ul > li:not([role=menuitem]), ol > li:not([role=menuitem])');
  assert.strictEqual(textOf(nested), '\n• Inner item', 'a nested item is marked once');
  assert.strictEqual(textOf(chrome), `${scripts.CHROME_MARK}Acasa`, 'chrome items keep their mark only');
  const lines = ['References', ...lis.map(textOf), '', 'External links'];
  assert.deepStrictEqual(lines.slice(1, 4), ['• ^ Jump up to: a b Smith, J. (2020). Bucharest housing survey.', '• ^ Ionescu, A. (2019). Bloc M4.', '• ^ Doe 2001']);
  assert.deepStrictEqual(RF.filterLines(lines, 'ionescu', { blocks: true }), ['• Ionescu, A. (2019). Bloc M4.']);
  assert.deepStrictEqual(RF.filterLines(lines, 'housing', { blocks: true }), ['• Smith, J. (2020). Bucharest housing survey.']);
  assert.deepStrictEqual(RF.filterLines(['• First item', 'continues here', '• Second', 'more of it', '', 'Tail'], 'second', { blocks: true }), ['• Second', 'more of it'],
    'an item runs to the next bullet or blank');
  assert.ok(scripts.READ_TEXT(false).includes(`bulletItems(clone, ${JSON.stringify(scripts.CHROME_MARK)});`));
});

test('page scripts: a Parsoid reference item gets its bullet past the hidden backlink, so a filter returns that one cite alone', () => {
  const t = (data) => ({ nodeType: 3, data });
  const e = (tag, cls, ...childNodes) => ({ nodeType: 1, tagName: tag, cls, childNodes });
  const textOf = (n) => (n.nodeType === 3 ? n.data : n.cls === 'mw-linkback-text' ? '' : n.childNodes.map(textOf).join(''));
  const ref = (cite) => e('LI', '', e('SPAN', 'mw-cite-backlink', e('A', '', e('SPAN', 'mw-linkback-text', t('↑')))), t(' '),
    e('SPAN', 'reference-text', e('CITE', '', e('A', '', t(`"${cite}"`)), t('. Retrieved 2026.'))));
  const lis = [ref('Census of Population 2022'), ref('The population grew by 1,450 (Hagstofa Íslands)'), ref('Peste 358 mii de locuitori')];
  const tabled = e('LI', '', e('TABLE', '', t('cell text')));
  const hidden = (n) => n.cls === 'mw-linkback-text';
  scripts.bulletItems({ querySelectorAll: () => [...lis, tabled] }, scripts.CHROME_MARK, hidden);
  const lines = ['References', ...lis.map(textOf), 'External links'];
  assert.ok(lines.slice(1, 4).every((l) => /^\s*• "/.test(l)), 'every item is one bulleted line');
  assert.deepStrictEqual(RF.filterLines(lines, 'hagstofa', { blocks: true }).map((l) => l.trim()), ['• "The population grew by 1,450 (Hagstofa Íslands)". Retrieved 2026.']);
  assert.strictEqual(textOf(tabled), 'cell text', 'no bullet inside a table cell');
});

test('page scripts: READ_TEXT outline headings skip a screen-reader-only 1x1 overflow-hidden h1', () => {
  const h = (text, [l, t, w, hh], st = {}) => ({ innerText: text, textContent: text, parentElement: null, st,
    getClientRects: () => [1], getBoundingClientRect: () => ({ left: l, top: t, width: w, height: hh, right: l + w, bottom: t + hh }) });
  const heads = [h('To view keyboard shortcuts, press question mark', [0, 0, 1, 1], { overflow: 'hidden' }), h('Trending', [10, 100, 200, 30]), h('Trending in Romania', [10, 200, 200, 30])];
  const document = { title: 'X', querySelector: () => null, body: null, documentElement: { scrollWidth: 1200, scrollHeight: 3000 },
    querySelectorAll: (sel) => (sel === 'h1,h2,h3' ? heads : []) };
  const getComputedStyle = (e) => ({ visibility: 'visible', display: 'block', opacity: '1', clip: 'auto', clipPath: 'none', overflow: 'visible', overflowX: 'visible', position: 'static', ...(e.st || {}) });
  const ctx = vm.createContext({ document, getComputedStyle, scrollX: 0, scrollY: 0, innerWidth: 1200, innerHeight: 800 });
  assert.deepStrictEqual([...vm.runInContext(scripts.READ_TEXT(false), ctx).outline.headings], ['Trending', 'Trending in Romania']);
});

test('page scripts: READ_TEXT keeps chrome landmarks and marks each of their text nodes for chromeStrip', () => {
  const src = scripts.READ_TEXT(false);
  const drop = /const DROP = '([^']*)'/.exec(src)[1].split(',');
  for (const sel of scripts.CHROME_SEL.split(',')) assert.ok(!drop.includes(sel), sel);
  assert.ok(!drop.includes('form'), 'text inside a form is read');
  assert.ok(drop.includes('button') && drop.includes('select'), 'button labels and options stay element rows');
  assert.ok(src.includes(`clone.querySelectorAll(${JSON.stringify(scripts.CHROME_SEL)})`));
  assert.ok(src.includes(`t.data = ${JSON.stringify(scripts.CHROME_MARK)} + t.data`));
  assert.ok(scripts.READ_INTERACTIVE(false, {}).includes(`if (it.el.closest(${JSON.stringify(scripts.CHROME_SEL)})) chrome.push(n);`));
});

test('page scripts: READ_TEXT reads the text of a table inside a form and drops its button label', () => {
  const src = scripts.READ_TEXT(false);
  const DROP = /const DROP = '([^']*)'/.exec(src)[1];
  const node = (tag, kids = [], text = '') => {
    const n = {
      tagName: tag.toUpperCase(), kids, text, parent: null, getClientRects: () => [1], closest: () => null,
      get innerText() { return [this.text, ...this.kids.map((k) => k.innerText)].filter(Boolean).join('\n'); },
      all() { return this.kids.flatMap((k) => [k, ...k.all()]); },
      querySelectorAll(sel) { return sel === DROP ? this.all().filter((e) => DROP.split(',').includes(e.tagName.toLowerCase())) : []; },
      remove() { this.parent.kids = this.parent.kids.filter((k) => k !== this); },
      cloneNode() { return node(tag, this.kids.map((k) => k.cloneNode()), this.text); },
    };
    kids.forEach((k) => { k.parent = n; });
    return n;
  };
  const root = node('div', [
    node('p', [], 'Datorii curente '.repeat(15)),
    node('form', [node('table', [node('tr', [node('td', [], 'Întreţinere August 2026'), node('td', [], '315,90 Lei')])]), node('button', [], 'Plăteşte')]),
  ]);
  const document = { title: 'e-bloc', querySelector: () => root, querySelectorAll: () => [], body: { appendChild() {} }, head: { appendChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }) };
  const ctx = vm.createContext({ document, getComputedStyle: () => ({}), scrollX: 0, scrollY: 0, innerWidth: 1200, innerHeight: 800 });
  const { text } = vm.runInContext(src, ctx);
  assert.ok(text.includes('Întreţinere August 2026\n315,90 Lei'), text);
  assert.ok(!text.includes('Plăteşte'));
});

test('notOpenError: a name never opened here and without saved numbers is not a service; a known closed one is not open', () => {
  const dir = fs.realpathSync(mkTmpRoot('clodex-bp-child-'));
  fs.mkdirSync(path.join(dir, 'ebloc'));
  const opened = new Set(['x']);
  assert.strictEqual(notOpenError('nosuch', opened, dir).message, 'nosuch is not a service here — services: ebloc, x — [agent:browser open nosuch] <url> opens a new one');
  assert.strictEqual(notOpenError('ebloc', opened, dir).message, 'ebloc is not open — [agent:browser open ebloc] <url>');
  assert.strictEqual(notOpenError('x', opened, dir).message, 'x is not open — [agent:browser open x] <url>');
  assert.strictEqual(notOpenError('nosuch', new Set(), path.join(dir, 'none')).code, 'NOT_OPEN');
  assert.match(R.TEXT.twinText('x', 'More'), /— read x; the re-read numbers both$/);
  assert.strictEqual(notOpenError('nosuch', opened, dir, ['gh', 'hn']).message, 'nosuch is not a service here — services: ebloc, gh, hn, x — [agent:browser open nosuch] <url> opens a new one');
  assert.strictEqual(notOpenError('gh', opened, dir, ['gh']).message, 'gh is not open — [agent:browser open gh] <url>');
  assert.match(CHILD_SRC, /throw notOpenError\(name, opened, path\.join\(data, 'numbers'\), known\);/);
  assert.match(CHILD_SRC, /if \(Array\.isArray\(args\.known\)\) known = args\.known\.map\(String\)\.filter\(\(n\) => NAME_RE\.test\(n\)\);/);
  assert.match(CHILD_SRC, /\n {4}opened\.add\(name\);\n/);
  assert.strictEqual(notOpenError('ebloc:riot', new Set(), dir).message, 'ebloc:riot is not open — [agent:browser open ebloc:riot] <url>');
  assert.match(notOpenError('y:riot', new Set(), dir).message, /^y:riot is not a service here/);
});

test('child: partition, numbers dir, downloads dir, cookie watch and download router are per profile; NAME_RE is grammar\'s', () => {
  assert.strictEqual(CHILD_SRC.split("session.fromPartition('persist:' + profile)").length - 1, 2);
  assert.ok(!CHILD_SRC.includes("'persist:' + name"));
  for (const s of ["path.join(data, 'numbers', profile)", 'watchCookies(profile, ses)', 'routerFor(profile, ses)']) assert.ok(CHILD_SRC.includes(s), s);
  assert.strictEqual(CHILD_SRC.split('path.join(downloadsRoot, profile').length - 1, 2);
  assert.ok(CHILD_SRC.includes("ses.on('will-download', (_e, item, from) => {"));
  assert.ok(CHILD_SRC.includes('if (!w) w = waiters.find((x) => !x.url && x.wc && x.wc === from);\n'));
  assert.ok(!CHILD_SRC.includes('waiters.find((x) => !x.url);'), 'no cross-tab URL-less fallback');
  assert.deepStrictEqual(['.expect({ dir, wc });', '.expect({ url, dir, nameHint, wc: svc.wc });', '.expect({ dir, nameHint, wc });'].map((x) => CHILD_SRC.split(x).length - 1), [1, 1, 1]);
  assert.ok(CHILD_SRC.includes("const { NAME_RE, profileOf, tabOf } = require('./grammar');"));
});

test('readPage: a compact read runs FEED with the read\'s ⚠ categories after numbering and reports the feed; any read reports the article count', () => {
  assert.match(CHILD_SRC, /mergeNumbers\(svc, el\);\n\s*const posts = el && Number\(el\.posts\) > 0 \? Number\(el\.posts\) : 0;\n\s*const cloaked = el && Number\(el\.cloaked\) > 0 \? Number\(el\.cloaked\) : 0;\n\s*let feed = posts \? \{ count: posts, cloaked \} : null;\n\s*if \(args\.compact && el\) \{\n\s*const f = await inIsolated\(wc, scripts\.FEED\(main, el\.cats \|\| \{\}\)\);/);
  assert.match(CHILD_SRC, /\.\.\.\(feed \? \{ feed \} : \{\}\),/);
  assert.match(scripts.READ_INTERACTIVE(false, {}), /posts: \[\.\.\.\(document\)\.querySelectorAll\('article'\)\]\.filter\(a => !\(a\.parentElement && a\.parentElement\.closest\('article'\)\)\)\.length,/);
  assert.match(scripts.READ_INTERACTIVE(true, {}), /posts: \[\.\.\.\(mainRootOf\(\) \|\| document\)\.querySelectorAll/);
  assert.match(CHILD_SRC, /: \{ count: posts, cloaked, failed: true \};/);
  assert.match(CHILD_SRC, /\{ count: f\.posts\.length, cloaked, posts: f\.posts,/);
  assert.ok(scripts.READ_INTERACTIVE(false, {}).includes("cloaked: [...(document).querySelectorAll('article, [data-post-number], [id^=post_], .post-stream--cloaked')].filter(a => !(a.parentElement && a.parentElement.closest('article, [data-post-number]')) && (a.innerText || '').trim().length < 40 && a.getBoundingClientRect().height >= 200).length, url:"));
});

test('windows: a service window opens hidden and surfaces without focus only on open --show; operator show still raises and focuses', () => {
  const svcFn = CHILD_SRC.slice(CHILD_SRC.indexOf('function openService('), CHILD_SRC.indexOf('const inIsolated ='));
  assert.ok(svcFn.includes('show: false,'));
  assert.ok(!svcFn.includes('showInactive'));
  assert.doesNotMatch(CHILD_SRC, /paintWhenInitiallyHidden/);
  assert.strictEqual(CHILD_SRC.split('showInactive').length - 1, 1);
  assert.ok(CHILD_SRC.includes("if (args.show && !svc.win.isDestroyed()) svc.win.showInactive();\n    return created ? { ...out, shown: !!args.show } : out;"));
  assert.ok(CHILD_SRC.includes("const created = !(have && !have.win.isDestroyed());\n    const svc = openService(name);"));
  assert.ok(svcFn.includes("const view = new WebContentsView({\n      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },"));
  assert.ok(CHILD_SRC.includes("if ([...services.values()].some((s) => !s.win.isDestroyed() && s.win.isVisible())) Promise.resolve(app.dock.show()).catch(() => {});\n    else app.dock.hide();"));
  assert.ok(svcFn.includes("win.on('show', dockSync);\n    win.on('hide', dockSync);"));
  const opFn = CHILD_SRC.slice(CHILD_SRC.indexOf('function operatorOp('), CHILD_SRC.indexOf('async function readPage('));
  assert.ok(opFn.includes('svc.win.show();\n    svc.win.focus();\n    app.focus({ steal: true });'));
});

test('windows: a show or hide sends a visibility frame and every state frame carries visible', () => {
  const svcFn = CHILD_SRC.slice(CHILD_SRC.indexOf('function openService('), CHILD_SRC.indexOf('const inIsolated ='));
  assert.ok(svcFn.includes("const visibility = () => { if (!win.isDestroyed()) send({ event: 'visibility', service: name, visible: win.isVisible() }); };\n    win.on('show', visibility);\n    win.on('hide', visibility);"));
  assert.ok(CHILD_SRC.includes("send({ event: 'state', service: svc.name, state: svc.lock.state, reason: svc.lock.reason, visible: !svc.win.isDestroyed() && svc.win.isVisible(), ...pageInfo(svc), openedBy: svc.openedBy, ...extra });"));
});

test('passwordRefusal: a password-change form on a signed-in page refuses without a handoff; a sign-in page still hands off', () => {
  const pw = { password: true, otp: false };
  const change = passwordRefusal('ebloc', 7, pw, { password: false, passwordChange: true, logoutLink: true });
  assert.strictEqual(change.code, 'PASSWORD_FIELD');
  assert.strictEqual(change.handoff, undefined);
  assert.strictEqual(change.message, R.TEXT.passwordFieldSignedIn('ebloc', 7));
  assert.strictEqual(change.message,
    '[7] is a password field — credentials never pass through agents; this is a password-change form on a signed-in page, so nothing to wait for. Leave it to the operator.');
  const login = passwordRefusal('ebloc', 7, pw, { password: true });
  assert.strictEqual(login.code, 'PASSWORD_FIELD');
  assert.deepStrictEqual(login.handoff, { password: true, otp: false });
  assert.strictEqual(login.message, R.TEXT.passwordField('ebloc', 7));
  assert.deepStrictEqual(passwordRefusal('ebloc', 7, pw, {}).handoff, { password: true, otp: false }, 'a probe that answered nothing still hands off');
  assert.deepStrictEqual(passwordRefusal('ebloc', 3, { password: false, otp: true }, { password: false, otp: true }).handoff, { password: false, otp: true });
});

test('page scripts: a countdown with spaced colons masks like an unspaced one', () => {
  const ri = scripts.READ_INTERACTIVE(false, {});
  const lit = /\.replace\((\/[^\n]*?\/g), '#:##:##'\)/.exec(ri)[1];
  const re = new Function(`return ${lit};`)();
  const mask = (t) => t.replace(re, '#:##:##');
  assert.strictEqual(mask('Promotion is live 19 : 49 : 05'), mask('Promotion is live 19 : 49 : 06'));
  assert.strictEqual(mask('live 19 : 49 : 05'), 'live #:##:##');
  assert.strictEqual(mask('live 7:56:12'), 'live #:##:##');
});

test('page scripts: transfer and swap are consequential only with a money or token word', () => {
  const c = scripts.consequentialOf;
  assert.strictEqual(c({ label: 'Include self-transfer flights' }), null);
  assert.strictEqual(c({ label: 'Airport transfer' }), null);
  assert.strictEqual(c({ label: 'Transfer funds' }), 'transfer');
  assert.strictEqual(c({ label: 'Transfer €100' }), 'transfer');
  assert.strictEqual(c({ label: 'swap-stations' }), null);
  assert.strictEqual(c({ label: 'Swap ETH for USDT' }), 'trading');
  assert.strictEqual(c({ formaction: '/transfer' }), 'transfer');
});

test('page scripts: READ_TEXT scans for a registration or pay wall and returns it as wall; child lifts it onto the read', () => {
  const src = scripts.READ_TEXT(false);
  const WALL = /\b(create (a free )?account to (read|continue)|sign (in|up) to (read|continue)|subscribe to (read|continue)|continue reading|read the full (story|article)|this article is for subscribers|already a subscriber|start a free trial|pentru a citi (mai departe|articolul)|abonează-te)\b/i;
  assert.ok(src.includes(`const WALL = ${WALL};`));
  assert.ok(src.includes('const WEAK = /\\bmembers?-only story\\b/i;'));
  assert.ok(src.includes('[class*=paywall i],[class*=meter i],[class*=regwall i],[class*=gate i],[class*=piano- i],[class*=tp-modal i]'));
  assert.ok(src.includes('const wall = wallScan(root);'));
  assert.ok(src.includes('return { text, busy, outline, wall, inlined, nested, hidden };'));
  const child = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'browser-pane', 'child.js'), 'utf8');
  assert.ok(child.includes("const wall = got && got.wall && typeof got.wall === 'object' ? got.wall : null;"));
  assert.ok(child.includes('...(wall ? { wall } : {}),'));
});
