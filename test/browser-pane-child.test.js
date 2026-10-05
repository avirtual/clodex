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
  changedOf, rowChanged, consequentialRefusal, scrollCode, signinHold, lateMsFor, loadNumbers, flushNumbers, forgetNumbers, numbersFile, originSlug, genRefusal, NUMBERS_SCHEMA,
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

test('page scripts: SCROLL_INFO counts article first, then [role=listitem], then li under the read root, with y/height/vh', () => {
  const run = ({ article = 0, listitem = 0, li = 0, root = true }) => {
    const rootEl = { querySelectorAll: (sel) => ({ length: sel === '[role=listitem]' ? listitem : sel === 'li' ? li : 0 }) };
    const document = {
      querySelector: (sel) => (root && sel.startsWith('main article') ? rootEl : null),
      querySelectorAll: (sel) => ({ length: sel === 'article' ? article : 0 }),
      body: { querySelectorAll: () => ({ length: 0 }) },
      scrollingElement: { scrollHeight: 9500.4 },
    };
    return new Function('document', 'window', `return ${scripts.SCROLL_INFO}`)(document, { scrollY: 1867.6, innerHeight: 868 });
  };
  assert.deepStrictEqual(run({ article: 12, listitem: 30, li: 40 }), { y: 1868, height: 9500, vh: 868, items: 12 });
  assert.strictEqual(run({ listitem: 30, li: 40 }).items, 30);
  assert.strictEqual(run({ li: 40 }).items, 40);
  assert.strictEqual(run({ li: 40, root: false }).items, 0);
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

test('page scripts: labelFrom skips placeholder alts and falls back to test id, class, handle, href segment, src; posters read video', () => {
  const L = scripts.labelFrom;
  const rows = [
    [{ tag: 'div', alts: ['icon'], src: '/img/lock.png?v=3' }, 'lock'],
    [{ tag: 'div', alts: [null, 'padlock'], src: '/img/lock.png' }, 'padlock'],
    [{ tag: 'div', alts: ['image'], testid: 'power-icon-container' }, 'power-icon'],
    [{ tag: 'div', alts: ['Logo'] }, 'Logo'],
    [{ tag: 'div', alts: ['photo'], classes: 'css-1dbjc4n wrapper device-tile' }, 'device-tile'],
    [{ tag: 'div', classes: 'btn-primary nav-link col-md-3' }, ''],
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
  assert.match(CHILD_SRC, /svc\.win\.destroy\(\);\n\s*forgetNumbers\(svc, path\.join\(data, 'numbers', name\)\);/);
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
    [{ label: 'Card bancar', control: true }, 'payment'], [{ label: 'Plătește' }, 'payment'], [{ label: 'Pay now' }, 'payment'],
    [{ value: 'Checkout' }, 'payment'], [{ aria: 'Confirm payment' }, 'payment'],
    [{ label: 'Cumpără acum' }, 'purchase'], [{ label: 'Place order' }, 'purchase'],
    [{ label: 'ȘTERGE' }, 'deletion'], [{ idClass: 'btn-delete' }, 'deletion'],
    [{ label: 'Ieşire' }, 'sign-out'], [{ label: 'Ieșire' }, 'sign-out'], [{ label: 'Log out' }, 'sign-out'], [{ idClass: 'logout ' }, 'sign-out'],
    [{ label: 'Abmelden' }, 'sign-out'],
    [{ label: 'Arm' }, 'alarm'], [{ label: 'Disarm' }, 'alarm'],
    [{ label: 'Dezabonare' }, 'unsubscribe'], [{ label: 'Cancel subscription' }, 'unsubscribe'],
    [{ label: 'Send money' }, 'transfer'], [{ formaction: '/transfer' }, 'transfer'],
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
  ];
  for (const [d, want] of rows) assert.strictEqual(c(d), want, JSON.stringify(d));
  const ri = scripts.READ_INTERACTIVE(false, {});
  assert.match(ri, /const cq = cqOf\(el\);\n {4}items\.push\(\{ el, full, cq, line: kind \+ ' ' \+ \(cq \? '⚠ ' : ''\) \+ line/);
  assert.match(ri, /if \(it\.cq\) cats\[n\] = it\.cq;/);
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
  const article = (line) => ({ tagName: 'ARTICLE', innerText: `musclebooster\n@musclebooster_\n${line}\nNo gym. No complicated equipment`, parentElement: null });
  const inside = (e, art) => ({ ...e, closest: (sel) => (sel === 'article' ? art : e.closest(sel)) });
  const wrapper = () => el('div', 'musclebooster @musclebooster_ Ad No gym. No complicated equi', { plain: true });
  assert.deepStrictEqual(cqHit(inside(wrapper(), article('Ad'))), { cat: 'ad', term: 'Ad' });
  assert.strictEqual(cqOf(inside(wrapper(), article('Promoted'))), 'ad');
  assert.strictEqual(cqHit(inside(wrapper(), article('Admittedly'))), null);
  assert.strictEqual(cqOf(inside(el('button', 'Like'), article('Ad'))), 'publish');
  assert.strictEqual(cqHit(inside(el('a', '268K views', { attrs: { href: '/x/status/1/analytics' } }), article('Ad'))), null);
  const adKeyOf = new Function('vis', `${src.slice(src.indexOf('  const SIGN_OUT'), src.indexOf('  const rowText'))}\nreturn adKeyOf;`)((e) => !e.hidden);
  const outer = article('Ad');
  const nested = { tagName: 'ARTICLE', innerText: 'quoted', parentElement: { closest: (sel) => (sel === 'article' ? outer : null) } };
  const other = article('Promoted');
  const link = inside(el('a', '@musclebooster_', { attrs: { href: '/musclebooster_' } }), nested);
  assert.strictEqual(adKeyOf(inside(wrapper(), outer)), 0);
  assert.strictEqual(adKeyOf(link), 0);
  assert.strictEqual(adKeyOf(inside(wrapper(), other)), 1);
  assert.strictEqual(adKeyOf(inside(wrapper(), article('Admittedly'))), null);
  assert.strictEqual(adKeyOf(wrapper()), null);
  const ri = scripts.READ_INTERACTIVE(false, {});
  assert.match(ri, /if \(it\.cq === 'ad'\) \{ const k = adKeyOf\(it\.el\); if \(k != null\) adKeys\[n\] = k; \}/);
  assert.match(ri, /chrome, cats, adKeys, posts:/);
  assert.match(CHILD_SRC, /cats: el\.cats \|\| \{\},\n\s*adKeys: el\.adKeys \|\| \{\},/);
  assert.match(scripts.INSPECT(1), /warn: cqHit\(el\),/);
});

test('page scripts: consequentialHit names the category and the source term; consequentialOf stays the bare category', () => {
  assert.deepStrictEqual(scripts.consequentialHit({ label: 'Go', action: '/orders/new' }), { cat: 'purchase', term: 'order' });
  assert.deepStrictEqual(scripts.consequentialHit({ label: 'Log out' }), { cat: 'sign-out', term: 'log out' });
  assert.strictEqual(scripts.consequentialOf({ label: 'Log out' }), 'sign-out');
  assert.strictEqual(scripts.consequentialHit({ label: 'Carduri' }), null);
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
  assert.ok(src.includes(`clone.querySelectorAll(${JSON.stringify(scripts.CHROME_SEL)})`));
  assert.ok(src.includes(`t.data = ${JSON.stringify(scripts.CHROME_MARK)} + t.data`));
  assert.ok(scripts.READ_INTERACTIVE(false, {}).includes(`if (it.el.closest(${JSON.stringify(scripts.CHROME_SEL)})) chrome.push(n);`));
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
  assert.match(CHILD_SRC, /if \(Array\.isArray\(args\.known\)\) known = args\.known\.map\(String\)\.filter\(\(n\) => SERVICE_RE\.test\(n\)\);/);
  assert.match(CHILD_SRC, /\n {4}opened\.add\(name\);\n/);
});

test('readPage: a compact read runs FEED with the read\'s ⚠ categories after numbering and reports the feed; any read reports the article count', () => {
  assert.match(CHILD_SRC, /mergeNumbers\(svc, el\);\n\s*const posts = el && Number\(el\.posts\) > 0 \? Number\(el\.posts\) : 0;\n\s*let feed = posts \? \{ count: posts \} : null;\n\s*if \(args\.compact && el\) \{\n\s*const f = await inIsolated\(wc, scripts\.FEED\(main, el\.cats \|\| \{\}\)\);/);
  assert.match(CHILD_SRC, /\.\.\.\(feed \? \{ feed \} : \{\}\),/);
  assert.match(scripts.READ_INTERACTIVE(false, {}), /posts: \[\.\.\.\(document\)\.querySelectorAll\('article'\)\]\.filter\(a => !\(a\.parentElement && a\.parentElement\.closest\('article'\)\)\)\.length,/);
  assert.match(scripts.READ_INTERACTIVE(true, {}), /posts: \[\.\.\.\(mainRootOf\(\) \|\| document\)\.querySelectorAll/);
  assert.match(CHILD_SRC, /: \{ count: posts, failed: true \};/);
});
