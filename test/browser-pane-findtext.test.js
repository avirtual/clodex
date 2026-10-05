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
