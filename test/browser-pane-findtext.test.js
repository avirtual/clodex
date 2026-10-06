'use strict';

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const scripts = require('../plugins/browser-pane/page-scripts');

function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '[' || ch === '(') depth += 1;
    if (ch === ']' || ch === ')') depth -= 1;
    if (ch === sep && !depth) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function compound(el, sel) {
  let rest = sel.trim();
  const m = /^([a-zA-Z][\w-]*|\*)/.exec(rest);
  if (m) {
    if (m[1] !== '*' && el.tagName !== m[1].toUpperCase()) return false;
    rest = rest.slice(m[1].length);
  }
  while (rest) {
    if (rest.startsWith(':not(')) {
      let depth = 0;
      let k = 4;
      for (; k < rest.length; k++) {
        if (rest[k] === '(') depth += 1;
        if (rest[k] === ')') { depth -= 1; if (!depth) break; }
      }
      if (compound(el, rest.slice(5, k))) return false;
      rest = rest.slice(k + 1);
      continue;
    }
    const a = /^\[([\w-]+)(?:([*$^]?=)"?([^\]"]*)"?(\s+i)?)?\]/.exec(rest);
    if (!a) return false;
    rest = rest.slice(a[0].length);
    const v = el.getAttribute(a[1]);
    if (v == null) return false;
    if (!a[2]) continue;
    const have = a[4] ? v.toLowerCase() : v;
    const want = a[4] ? a[3].toLowerCase() : a[3];
    if (a[2] === '=' && have !== want) return false;
    if (a[2] === '*=' && !have.includes(want)) return false;
    if (a[2] === '$=' && !have.endsWith(want)) return false;
    if (a[2] === '^=' && !have.startsWith(want)) return false;
  }
  return true;
}

function complex(el, sel) {
  const parts = sel.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  const walk = (node, i) => {
    if (!node || !node.tagName || !compound(node, parts[i])) return false;
    if (i === 0) return true;
    if (parts[i - 1] === '>') return walk(node.parentElement, i - 2);
    for (let p = node.parentElement; p; p = p.parentElement) if (walk(p, i - 1)) return true;
    return false;
  };
  return walk(el, parts.length - 1);
}

const matches = (el, sel) => splitTop(sel, ',').some((s) => complex(el, s));

function mkPage() {
  const all = [];
  const textOf = (n) => (n.nodeType === 3 ? n.nodeValue : n.childNodes.map(textOf).join(' '));
  const mk = (tag, attrs = {}, kids = [], rect = [0, 0, 100, 20]) => {
    const el = {
      nodeType: 1, tagName: tag.toUpperCase(), attrs: { ...attrs }, childNodes: [], parentElement: null, isConnected: true, labels: null,
      shadowRoot: null, isContentEditable: false, disabled: false, form: null, id: attrs.id || '', type: attrs.type || '', value: '',
      get parentNode() { return this.parentElement; },
      get innerText() { return textOf(this).replace(/\s+/g, ' ').trim(); },
      get textContent() { return this.innerText; },
      get href() { return this.attrs.href == null ? undefined : new URL(this.attrs.href, 'https://x.test/').href; },
      get children() { return this.childNodes.filter((c) => c.nodeType === 1); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      hasAttribute(k) { return k in this.attrs; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      removeAttribute(k) { delete this.attrs[k]; },
      matches(sel) { return matches(this, sel); },
      closest(sel) { for (let p = this; p; p = p.parentElement) if (matches(p, sel)) return p; return null; },
      descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); },
      querySelectorAll(sel) { return this.descendants().filter((d) => sel === '*' || matches(d, sel)); },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      compareDocumentPosition(o) { return all.indexOf(o) > all.indexOf(this) ? 4 : 2; },
      getBoundingClientRect() { const [left, top, width, height] = rect; return { left, top, width, height, right: left + width, bottom: top + height }; },
    };
    all.push(el);
    for (const k of kids) {
      const c = typeof k === 'string' ? { nodeType: 3, nodeValue: k } : k;
      if (c.nodeType === 1) c.parentElement = el;
      el.childNodes.push(c);
    }
    return el;
  };
  return { mk, all };
}

function context(body) {
  const { all } = body;
  const html = all.find((e) => e.tagName === 'HTML');
  const document = {
    title: 'X', documentElement: html, scrollingElement: html, body: all.find((e) => e.tagName === 'BODY'),
    querySelectorAll: (sel) => (sel === '*' ? all.filter((e) => e !== html) : all.filter((e) => e !== html && matches(e, sel))),
    querySelector: (sel) => document.querySelectorAll(sel)[0] || null,
  };
  const style = { visibility: 'visible', display: 'block', opacity: '1', position: 'static', clip: 'auto', clipPath: 'none', overflow: 'visible', overflowX: 'visible', overflowY: 'visible', cursor: 'auto' };
  const ctx = {
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, document, WeakRef, WeakMap, URL, URLSearchParams, location: { origin: 'https://x.test', href: 'https://x.test/home' },
    getComputedStyle: () => style, innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 0,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  return ctx;
}

function xPage() {
  const page = mkPage();
  const { mk } = page;
  const more1 = mk('button', {}, ['More'], [300, 40, 30, 20]);
  const more2 = mk('button', {}, ['More'], [300, 140, 30, 20]);
  const show = mk('button', {}, ['Show more'], [10, 240, 80, 20]);
  const post = mk('div', {}, ['More details on the vote'], [10, 280, 300, 20]);
  const home = mk('a', { href: '/home' }, ['Home'], [10, 10, 40, 20]);
  const row1 = mk('div', {}, [mk('span', {}, ['Trending in Romania'], [10, 40, 200, 20]), more1], [10, 40, 330, 20]);
  const row2 = mk('div', {}, [mk('span', {}, ['Politics Election'], [10, 140, 200, 20]), more2], [10, 140, 330, 20]);
  const body = mk('body', {}, [home, row1, row2, show, post], [0, 0, 1200, 800]);
  Object.assign(mk('html', {}, [body], [0, 0, 1200, 800]), { scrollWidth: 1200, scrollHeight: 800 });
  return { page, more1, more2, show, post, home };
}

const merged = (state, out) => ({ known: { ...state.known, ...out.assigned }, next: out.next });

test('FIND_TEXT: an exact label outranks "Show more" and post text; the candidates carry the numbers the next read gives them', () => {
  const p = xPage();
  const ctx = context(p.page);
  Object.assign(ctx, { __cxEls: {}, __cxKeys: {}, __cxOf: new WeakMap() });
  const state = { known: {}, next: 1 };
  const found = vm.runInContext(scripts.FIND_TEXT('More', state), ctx);
  assert.strictEqual(found.count, 2, 'only the two exact "More" buttons are candidates');
  assert.deepStrictEqual(Array.from(found.hits, (h) => h.text), ['More', 'More']);
  const ns = Array.from(found.hits, (h) => h.n);
  assert.ok(ns.every((n) => Number.isInteger(n)) && ns[0] !== ns[1]);
  const read = vm.runInContext(scripts.READ_INTERACTIVE(false, merged(state, found)), ctx);
  assert.deepStrictEqual([ctx.__cxOf.get(p.more1), ctx.__cxOf.get(p.more2)], ns, 'the read numbers both buttons as FIND_TEXT did');
  assert.ok(!Object.values(read.assigned).some((n) => ns.includes(n)), 'the read assigns nothing new to them');
  const shown = vm.runInContext(scripts.FIND_TEXT('Show more', merged(merged(state, found), read)), ctx);
  assert.strictEqual(shown.count, 1);
  assert.strictEqual(shown.hits[0].n, ctx.__cxOf.get(p.show));
});

test('FIND_TEXT: a text hit with no clickable around it is listed as not clickable and consumes no number', () => {
  const p = xPage();
  const ctx = context(p.page);
  const read = vm.runInContext(scripts.READ_INTERACTIVE(false, { known: {}, next: 1 }), ctx);
  const state = merged({ known: {} }, read);
  const found = vm.runInContext(scripts.FIND_TEXT('details', state), ctx);
  assert.strictEqual(found.count, 1);
  assert.deepStrictEqual({ ...found.hits[0] }, { n: null, loose: true, text: 'More details on the vote' });
  assert.strictEqual(found.next, state.next, 'nextN unchanged');
  assert.deepStrictEqual({ ...found.assigned }, {});
  assert.strictEqual(p.post.getAttribute('data-cx'), null);
  const R = require('../plugins/browser-pane/replies');
  assert.strictEqual(R.TEXT.looseText('x', 'details', found.hits[0]), '"details" on x is only text: [–] "More details on the vote" (not clickable) — read x and use a number');
  assert.strictEqual(R.TEXT.manyText('x', 'ore', 2, [{ n: 4, text: 'Show more' }, found.hits[0]]),
    '"ore" matches 2 visible elements on x: [4] "Show more", [–] "More details on the vote" (not clickable) — click one by number');
  const src = require('node:fs').readFileSync(require.resolve('../plugins/browser-pane/child'), 'utf8');
  assert.match(src, /if \(found\.hits\[0\]\.loose\) throw codedError\('NO_ELEMENT', TEXT\.looseText\(svc\.name, text, found\.hits\[0\]\)\);/);
});

test('FIND_TEXT: a cell of a clickable row targets the row; a link the read folded into its twin is skipped, not listed as text', () => {
  const page = mkPage();
  const { mk } = page;
  const row = mk('div', { onclick: 'go()' }, [mk('span', {}, ['Factura iulie'], [10, 40, 100, 20]), mk('span', {}, ['120 lei'], [120, 40, 60, 20])], [10, 40, 300, 20]);
  const next1 = mk('a', { href: '/n' }, ['Next'], [10, 100, 40, 20]);
  const next2 = mk('a', { href: '/n' }, ['Next'], [10, 400, 40, 20]);
  const body = mk('body', {}, [row, next1, next2], [0, 0, 1200, 800]);
  Object.assign(mk('html', {}, [body], [0, 0, 1200, 800]), { scrollWidth: 1200, scrollHeight: 800 });
  const ctx = context(page);
  const read = vm.runInContext(scripts.READ_INTERACTIVE(false, { known: {}, next: 1 }), ctx);
  const state = merged({ known: {} }, read);
  const cell = vm.runInContext(scripts.FIND_TEXT('Factura iulie', state), ctx);
  assert.strictEqual(cell.count, 1);
  assert.strictEqual(cell.hits[0].n, ctx.__cxOf.get(row));
  const nx = vm.runInContext(scripts.FIND_TEXT('Nex', state), ctx);
  assert.strictEqual(nx.count, 1);
  assert.strictEqual(nx.hits[0].n, ctx.__cxOf.get(next1));
  const R = require('../plugins/browser-pane/replies');
  assert.match(R.TEXT.manyText('x', 'Duplicat', 2, [{ n: null, loose: true, text: 'Duplicat' }, { n: null, loose: true, text: 'Duplicat' }]),
    /\(not clickable\) — read x and use a number$/);
});

test('READ_INTERACTIVE: a link label joins an https:// split from its host', () => {
  const page = mkPage();
  const { mk } = page;
  const yt = mk('a', { href: 'https://youtu.be/x' }, ['https:// youtu.be/x'], [10, 40, 200, 20]);
  const body = mk('body', {}, [yt], [0, 0, 1200, 800]);
  Object.assign(mk('html', {}, [body], [0, 0, 1200, 800]), { scrollWidth: 1200, scrollHeight: 800 });
  const ctx = context(page);
  const read = vm.runInContext(scripts.READ_INTERACTIVE(false, { known: {}, next: 1 }), ctx);
  assert.deepStrictEqual(Array.from(read.lines), ['[1] link https://youtu.be/x → https://youtu.be/x']);
});

test('READ_INTERACTIVE: a label whose radio is visually hidden is listed as that radio with its state; a visible wrapped checkbox stays one line; a label with no control stays clickable', () => {
  const page = mkPage();
  const { mk } = page;
  const no = Object.assign(mk('input', { type: 'radio', id: 'r1' }, [], [10, 40, 20, 20]), { css: { opacity: '0' }, name: 'q', value: 'no', checked: true });
  const noLab = Object.assign(mk('label', { for: 'r1' }, ['No'], [40, 40, 100, 20]), { css: { cursor: 'pointer' }, control: no });
  const terms = Object.assign(mk('input', { type: 'checkbox' }, [], [10, 80, 20, 20]), { name: 't' });
  const termsLab = Object.assign(mk('label', {}, [terms, 'Terms'], [10, 80, 200, 20]), { css: { cursor: 'pointer' }, control: terms });
  terms.labels = [termsLab];
  const loose = Object.assign(mk('label', {}, ['Plain'], [10, 120, 100, 20]), { css: { cursor: 'pointer' }, control: null });
  const body = mk('body', {}, [no, noLab, termsLab, loose], [0, 0, 1200, 800]);
  Object.assign(mk('html', {}, [body], [0, 0, 1200, 800]), { scrollWidth: 1200, scrollHeight: 800 });
  const ctx = context(page);
  const base = ctx.getComputedStyle();
  ctx.getComputedStyle = (e) => ({ ...base, ...(e && e.css) });
  const read = vm.runInContext(scripts.READ_INTERACTIVE(false, { known: {}, next: 1 }), ctx);
  assert.deepStrictEqual(Array.from(read.lines), ['[1] input:radio No = "no" [x]', '[2] input:checkbox Terms [ ]', '[3] clickable "Plain"']);
  assert.strictEqual(ctx.__cxOf.get(noLab), 1, 'the number maps to the label');
});

test('READ_INTERACTIVE: an ARIA grid [role=columnheader] with aria-sort prints [sorted ↑] on its button', () => {
  const page = mkPage();
  const { mk } = page;
  const btn = mk('button', { 'aria-label': 'Age' }, ['Age'], [10, 10, 80, 20]);
  const head = mk('div', { role: 'columnheader', 'aria-sort': 'ascending' }, [btn], [10, 10, 100, 20]);
  const body = mk('body', {}, [head], [0, 0, 1200, 800]);
  Object.assign(mk('html', {}, [body], [0, 0, 1200, 800]), { scrollWidth: 1200, scrollHeight: 800 });
  const ctx = context(page);
  const read = vm.runInContext(scripts.READ_INTERACTIVE(false, { known: {}, next: 1 }), ctx);
  assert.deepStrictEqual(Array.from(read.lines), ['[1] button Age [sorted ↑]']);
});

test('READ_INTERACTIVE: a bare Sort button inside a column header is listed as <Column>: Sort; one outside any header stays Sort', () => {
  const page = mkPage();
  const { mk } = page;
  const sortBtn = mk('button', { 'aria-label': 'Sort' }, [], [90, 10, 20, 20]);
  const head = mk('div', { role: 'columnheader', 'aria-sort': 'descending' }, ['Rating', sortBtn], [10, 10, 100, 20]);
  const loose = mk('button', {}, ['Sort'], [10, 60, 60, 20]);
  const body = mk('body', {}, [head, loose], [0, 0, 1200, 800]);
  Object.assign(mk('html', {}, [body], [0, 0, 1200, 800]), { scrollWidth: 1200, scrollHeight: 800 });
  const ctx = context(page);
  const read = vm.runInContext(scripts.READ_INTERACTIVE(false, { known: {}, next: 1 }), ctx);
  assert.deepStrictEqual(Array.from(read.lines), ['[1] button Rating: Sort [sorted ↓]', '[2] button Sort']);
});

test('READ_INTERACTIVE: a sorted column header prints [sorted ↑]/[sorted ↓], the current pagination link [current]; a header whose sort label flips keeps its number', () => {
  const page = mkPage();
  const { mk } = page;
  const ageBtn = mk('button', { 'aria-label': 'Age: Activate to invert sorting' }, ['Age'], [10, 10, 80, 20]);
  const age = mk('th', { 'aria-sort': 'ascending' }, [ageBtn], [10, 10, 100, 20]);
  const nameBtn = mk('button', { 'aria-label': 'Name: Activate to sort' }, ['Name'], [110, 10, 80, 20]);
  const name = mk('th', {}, [nameBtn], [110, 10, 100, 20]);
  const cityBtn = mk('button', { 'aria-label': 'City: Activate to sort' }, ['City'], [210, 10, 80, 20]);
  const city = mk('th', { 'aria-sort': 'descending' }, [cityBtn], [210, 10, 100, 20]);
  const p2 = mk('a', { href: '/list?page=2', 'aria-current': 'page' }, ['2'], [10, 60, 20, 20]);
  const p3 = mk('a', { href: '/list?page=3' }, ['3'], [40, 60, 20, 20]);
  const body = mk('body', {}, [age, name, city, p2, p3], [0, 0, 1200, 800]);
  Object.assign(mk('html', {}, [body], [0, 0, 1200, 800]), { scrollWidth: 1200, scrollHeight: 800 });
  const ctx = context(page);
  const read = vm.runInContext(scripts.READ_INTERACTIVE(false, { known: {}, next: 1 }), ctx);
  assert.deepStrictEqual(Array.from(read.lines), [
    '[1] button Age: Activate to invert sorting [sorted ↑]',
    '[2] button Name: Activate to sort',
    '[3] button City: Activate to sort [sorted ↓]',
    '[4] link 2 → /list?page=2 [current]',
    '[5] link 3 → /list?page=3',
  ]);
  nameBtn.setAttribute('aria-label', 'Name: Activate to invert sorting');
  assert.strictEqual(vm.runInContext(scripts.CHECK(2, read.keys[2], merged({ known: {}, next: 1 }, read)), ctx), 'ok');
});

test('READ_INTERACTIVE: a bold mail row is listed with [unread] and the marker is in its signature; a normal-weight row is not', () => {
  const page = mkPage();
  const { mk } = page;
  const cell = (t, y) => mk('td', {}, [mk('span', {}, [t], [10, y, 200, 20])], [10, y, 300, 20]);
  const fresh = Object.assign(mk('tr', { class: 'zA zE' }, [cell('Ana', 40), cell('Factura iunie', 40)], [10, 40, 600, 20]), { css: { cursor: 'pointer', fontWeight: '700' } });
  const old = Object.assign(mk('tr', { class: 'zA yO' }, [cell('Ion', 60), cell('Avizier', 60)], [10, 60, 600, 20]), { css: { cursor: 'pointer', fontWeight: '400' } });
  const body = mk('body', {}, [mk('table', {}, [mk('tbody', {}, [fresh, old], [10, 40, 600, 40])], [10, 40, 600, 40])], [0, 0, 1200, 800]);
  Object.assign(mk('html', {}, [body], [0, 0, 1200, 800]), { scrollWidth: 1200, scrollHeight: 800 });
  const ctx = context(page);
  const base = ctx.getComputedStyle();
  const weightOf = (e) => { for (let p = e; p; p = p.parentElement) if (p.css && p.css.fontWeight) return p.css.fontWeight; return '400'; };
  ctx.getComputedStyle = (e) => ({ ...base, ...(e && e.css), fontWeight: e && e.nodeType === 1 ? weightOf(e) : '400', cursor: (e && e.css && e.css.cursor) || 'auto' });
  const read = vm.runInContext(scripts.READ_INTERACTIVE(false, { known: {}, next: 1 }), ctx);
  assert.deepStrictEqual(Array.from(read.lines), ['[1] clickable "Ana Factura iunie" [unread]', '[2] clickable "Ion Avizier"']);
  assert.ok(read.sigs[1].includes('[unread]'));
  assert.ok(!read.sigs[2].includes('[unread]'));
});

test('READ_INTERACTIVE: a read row\'s Mark as unread action is not [unread]; an Unread label or hidden unread text is', () => {
  const page = mkPage();
  const { mk } = page;
  const row = (y, extra) => Object.assign(mk('tr', {}, [mk('td', {}, [mk('span', {}, ['Ion ' + y], [10, y, 200, 20])], [10, y, 300, 20]), extra], [10, y, 600, 20]), { css: { cursor: 'pointer', fontWeight: '400' } });
  const action = row(40, mk('td', {}, [mk('ul', { role: 'toolbar' }, [mk('li', { 'aria-label': 'Mark as unread' }, [], [400, 40, 20, 20])], [400, 40, 20, 20])], [400, 40, 100, 20]));
  const ro = row(60, mk('td', {}, [mk('li', { 'aria-label': 'Marchează ca necitit' }, [], [400, 60, 20, 20])], [400, 60, 100, 20]));
  const labelled = row(80, mk('td', {}, [mk('span', { 'aria-label': 'Unread' }, [], [400, 80, 20, 20])], [400, 80, 100, 20]));
  const hidden = row(100, mk('td', {}, [mk('span', {}, ['unread'], [0, 0, 0, 0])], [400, 100, 100, 20]));
  const body = mk('body', {}, [mk('table', {}, [mk('tbody', {}, [action, ro, labelled, hidden], [10, 40, 600, 80])], [10, 40, 600, 80])], [0, 0, 1200, 800]);
  Object.assign(mk('html', {}, [body], [0, 0, 1200, 800]), { scrollWidth: 1200, scrollHeight: 800 });
  const ctx = context(page);
  const base = ctx.getComputedStyle();
  ctx.getComputedStyle = (e) => ({ ...base, ...(e && e.css), fontWeight: '400', cursor: (e && e.css && e.css.cursor) || 'auto' });
  const read = vm.runInContext(scripts.READ_INTERACTIVE(false, { known: {}, next: 1 }), ctx);
  const lines = Array.from(read.lines);
  assert.strictEqual(lines.length, 4, lines.join('\n'));
  assert.ok(!lines[0].includes('[unread]'), lines[0]);
  assert.ok(!lines[1].includes('[unread]'), lines[1]);
  assert.ok(lines[2].endsWith('[unread]'), lines[2]);
  assert.ok(lines[3].endsWith('[unread]'), lines[3]);
});

test('FIND_TEXT: a suggestion whose text is split by highlight spans is found by its whole phrase; a phrase across two siblings is not', () => {
  const page = mkPage();
  const { mk } = page;
  const luton = mk('li', { onclick: 'pick()' }, ['London ', mk('b', {}, ['Luton'], [60, 40, 40, 20]), ' LTN'], [10, 40, 200, 20]);
  const gatwick = mk('li', { onclick: 'pick()' }, ['Gatwick'], [10, 60, 200, 20]);
  const stansted = mk('li', { onclick: 'pick()' }, ['Stansted'], [10, 80, 200, 20]);
  const list = mk('ul', { role: 'listbox' }, [luton, gatwick, stansted], [10, 40, 200, 60]);
  const body = mk('body', {}, [list], [0, 0, 1200, 800]);
  Object.assign(mk('html', {}, [body], [0, 0, 1200, 800]), { scrollWidth: 1200, scrollHeight: 800 });
  const ctx = context(page);
  const read = vm.runInContext(scripts.READ_INTERACTIVE(false, { known: {}, next: 1 }), ctx);
  const state = merged({ known: {} }, read);
  const found = vm.runInContext(scripts.FIND_TEXT('London Luton', state), ctx);
  assert.strictEqual(found.count, 1);
  assert.strictEqual(found.hits[0].n, ctx.__cxOf.get(luton));
  assert.strictEqual(vm.runInContext(scripts.FIND_TEXT('Gatwick Stansted', state), ctx).count, 0);
});
