'use strict';

const keys = require('./keys');

const ISOLATED_WORLD = 4242;
const TEXT_MAX = 400000;
const BUSY_SEL = '[aria-busy=true], .loading, .spinner, [class*=loading i], [class*=spinner i], [id*=loading i]';
const ELEMENTS_MAX = 6000;
const MAIN_SEL = 'main, article, [role=main]';
const STD_SEL = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=combobox],summary,[contenteditable=true]';
const X_SEL = 'a:not([href]),[onclick],[tabindex]:not([tabindex="-1"])';
const POINTER_SCAN_MAX = 3000;
const LAYOUT_CELL_CHARS = 400;
const VALUE_MAX = 200;
const OVERLAY_ID = '__cx_numbers';
const CHROME_SEL = 'nav,header,footer,aside,[role=banner],[role=navigation],[role=contentinfo],[role=complementary]';
const CHROME_MARK = '\u0001';

const DEEP = `
  const deepAll = (root, test, out = []) => {
    for (const el of root.querySelectorAll('*')) {
      if (test(el)) out.push(el);
      if (el.shadowRoot) deepAll(el.shadowRoot, test, out);
    }
    return out;
  };
  const upOf = (e) => e.parentElement || (e.parentNode && e.parentNode.host) || null;
  const scrollers = new Map();
  const FIXED = {};
  const scrollerOf = (start) => {
    const d = document.documentElement;
    const se = document.scrollingElement || d;
    const seen = [];
    let found = null;
    for (let p = start; p && p !== d && p !== se; p = upOf(p)) {
      if (scrollers.has(p)) { found = scrollers.get(p); break; }
      seen.push(p);
      const ps = getComputedStyle(p);
      if (/auto|scroll/.test(ps.overflowX + ' ' + ps.overflowY) && (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth)) { found = p; break; }
      if (ps.position === 'fixed') { found = FIXED; break; }
    }
    for (const q of seen) scrollers.set(q, found);
    return found;
  };
  const placedScroller = new Map();
  const inViewport = r => r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  const placed = (e, r, st) => {
    if (st.position === 'fixed') return inViewport(r);
    const sc = scrollerOf(upOf(e));
    if (sc === FIXED) return inViewport(r);
    if (!sc) {
      const se = document.scrollingElement || document.documentElement;
      return r.right + scrollX > 0 && r.bottom + scrollY > 0
        && r.left + scrollX < Math.max(se.scrollWidth, innerWidth) && r.top + scrollY < Math.max(se.scrollHeight, innerHeight);
    }
    const pr = sc.getBoundingClientRect();
    const top = pr.top - sc.scrollTop;
    const left = pr.left - sc.scrollLeft;
    if (!(r.bottom > top && r.top < top + sc.scrollHeight && r.right > left && r.left < left + sc.scrollWidth)) return false;
    if (!placedScroller.has(sc)) placedScroller.set(sc, placed(sc, pr, getComputedStyle(sc)));
    return placedScroller.get(sc);
  };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    if (s.opacity === '0') return false;
    if (!placed(el, r, s)) return false;
    if (s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clip === 'rect(1px, 1px, 1px, 1px)') return false;
    if (s.clipPath === 'inset(50%)' || s.clipPath === 'inset(100%)') return false;
    if (r.width <= 1 && r.height <= 1 && (s.overflow === 'hidden' || s.overflowX === 'hidden')) return false;
    return true;
  };`;

const TABLES = `
  const cellText = c => {
    if (!c.getClientRects().length) return '';
    const t = (c.innerText || '').replace(/\\s+/g, ' ').trim();
    const img = t ? null : c.querySelector('img[alt]');
    return t || (img ? img.getAttribute('alt').replace(/\\s+/g, ' ').trim() : '');
  };
  const tables = [...clone.querySelectorAll('table')];
  const layout = new Set(tables.filter(t => t.querySelector('table')
    || [...t.rows].some(r => [...r.cells].some(c => (c.innerText || '').length > ${LAYOUT_CELL_CHARS}))));
  for (const t of tables.reverse()) {
    if (layout.has(t)) continue;
    const box = document.createElement('div');
    const line = (s) => { const d = document.createElement('div'); d.textContent = s; box.appendChild(d); };
    if (t.caption) line(cellText(t.caption));
    for (const tr of t.rows) if (tr.getClientRects().length) line([...tr.cells].map(cellText).join(' | '));
    t.replaceWith(box);
  }`;

function readText(main) {
  return `(() => {${DEEP}
  const DROP = 'script,style,noscript,select,svg,nav,header,footer,aside,form,[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true],.navbox,.mw-editsection,.reference,.reflist,#toc,.toc';
  const score = el => {
    const t = (el.innerText || '').length;
    let l = 0; el.querySelectorAll('a').forEach(a => l += (a.innerText || '').length);
    return t - 2 * l;
  };
  const forced = ${main ? `document.querySelector(${JSON.stringify(MAIN_SEL)})` : 'null'};
  let root = forced || document.querySelector('main article, article, [role=main], main, #mw-content-text, #content');
  if (!forced && (!root || (root.innerText || '').length < 200)) {
    let best = document.body, bs = -1;
    document.querySelectorAll('div,section,td').forEach(el => {
      const s = score(el); if (s > bs) { bs = s; best = el; }
    });
    root = best;
  }
  const busyEls = [...document.querySelectorAll(${JSON.stringify(BUSY_SEL)})].filter(vis);
  const busy = { count: busyEls.length, text: busyEls.length ? (busyEls[0].innerText || busyEls[0].textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) : '' };
  if (!root) return { text: '', busy };
  const clone = root.cloneNode(true);
  clone.querySelectorAll(DROP).forEach(n => n.remove());
  const chrome = root.closest(${JSON.stringify(CHROME_SEL)}) ? [clone] : [...clone.querySelectorAll(${JSON.stringify(CHROME_SEL)})];
  for (const c of chrome) {
    const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) if (t.data.trim()) t.data = ${JSON.stringify(CHROME_MARK)} + t.data;
  }
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:1000px';
  host.appendChild(clone); document.body.appendChild(host);
  ${TABLES}
  const txt = clone.innerText; host.remove();
  const text = (document.title + '\\n\\n' + txt).replace(/[ \\t]+/g, ' ').replace(/\\n\\s*\\n+/g, '\\n\\n').trim().slice(0, ${TEXT_MAX});
  return { text, busy };
})()`;
}

const numbering = (state) => {
  const known = state && state.known && typeof state.known === 'object' ? state.known : {};
  const next = Math.max(1, Number(state && state.next) | 0);
  const learned = state && Array.isArray(state.volatile) ? state.volatile.map(String) : [];
  const listedBefore = state && Array.isArray(state.listed) ? state.listed.map(Number) : null;
  return `${ICON}
  ${keys.PAGE_SOURCE}
  const known = ${JSON.stringify(known)};
  const learned = ${JSON.stringify(learned)};
  const listedBefore = ${listedBefore ? `new Set(${JSON.stringify(listedBefore)})` : 'null'};
  let next = ${next};
  const assigned = {};
  const fresh = [];
  const flat = s => String(s || '').replace(/\\s+/g, ' ').trim();
  const clip = (s, n) => { s = flat(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const labelOf = el => {
    if (el.labels && el.labels[0]) return el.labels[0].innerText;
    return el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.getAttribute('placeholder')
      || el.value || (el.querySelector('img[alt]') || {}).alt || el.getAttribute('name') || '';
  };
  const kindOf = el => {
    const tag = el.tagName.toLowerCase();
    if (!el.matches(${JSON.stringify(STD_SEL)})) return 'clickable';
    return el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? 'input:' + (el.type || 'text') : tag);
  };
  const partsOf = el => {
    const tag = el.tagName.toLowerCase();
    const kind = kindOf(el);
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const btn = tag === 'input' && /^(button|submit|reset)$/.test(el.type);
      const label = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('aria-label') || (btn ? el.value : '') || '';
      return { kind, label: flat(label), raw: '', href: el.getAttribute('name') || el.getAttribute('placeholder') || el.id || '' };
    }
    const label = flat(labelOf(el) || (kind === 'clickable' ? el.getAttribute('alt') || iconLabel(el) : ''));
    if (tag !== 'a' || !el.hasAttribute('href')) return { kind, label, raw: '', href: '' };
    let raw = '';
    try { const u = new URL(el.href); u.hash = ''; raw = u.origin === location.origin ? u.pathname + u.search : u.href; } catch {}
    return { kind, label, raw, href: normHref(el.href, location.origin, learned) };
  };
  const baseKeyOf = el => keyOf(partsOf(el));
  let headings = null;
  const boxText = new Map();
  const contextOf = el => {
    const box = el.closest('tr,li,article,[role=row],section');
    if (box) {
      if (!boxText.has(box)) boxText.set(box, box.innerText || box.textContent || '');
      return boxText.get(box);
    }
    if (!headings) headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    let h = null;
    for (const x of headings) {
      if (x.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) h = x;
      else break;
    }
    return h ? h.innerText || h.textContent || '' : '';
  };
  const storedKeysOf = (els, bases = els.map(baseKeyOf)) => {
    const count = new Map();
    for (const b of bases) count.set(b, (count.get(b) || 0) + 1);
    const ord = new Map();
    return bases.map((b, i) => {
      if (count.get(b) === 1) return b;
      const o = (ord.get(b) || 0) + 1;
      ord.set(b, o);
      return storedKey(b, o, contextOf(els[i]));
    });
  };
  const place = (el, s, listed = true) => {
    let n = known[s];
    const isNew = n == null;
    if (isNew) { n = next++; known[s] = n; assigned[s] = n; }
    if (listed && (listedBefore ? !listedBefore.has(n) : isNew)) { fresh.push(n); if (listedBefore) listedBefore.add(n); }
    window.__cxEls[n] = new WeakRef(el);
    window.__cxKeys[n] = s;
    window.__cxOf.set(el, n);
    el.setAttribute('data-cx', String(n));
    return n;
  };
  const verify = (n, expect) => {
    const ref = window.__cxEls && window.__cxEls[n];
    const el = ref && ref.deref();
    if (!el || !el.isConnected) return null;
    const k = window.__cxKeys && window.__cxKeys[n];
    if (k == null || k !== expect) return 'ambiguous';
    const p = parseStored(k);
    const now = p.ordinal ? storedKey(baseKeyOf(el), p.ordinal, contextOf(el)) : baseKeyOf(el);
    return now === k ? 'ok' : 'ambiguous';
  };
  const resetTable = () => {
    for (const r of Object.values(window.__cxEls || {})) { const e = r && r.deref(); if (e) e.removeAttribute('data-cx'); }
    window.__cxEls = {}; window.__cxKeys = {}; window.__cxOf = new WeakMap();
  };`;
};

function readInteractive(main, state) {
  return `(() => {${DEEP}${numbering(state)}
  const sel = ${JSON.stringify(STD_SEL)};
  const xsel = ${JSON.stringify(X_SEL)};
  resetTable();
  const mainRoot = ${main ? `document.querySelector(${JSON.stringify(MAIN_SEL)})` : 'null'};
  const inScope = el => {
    if (!mainRoot) return true;
    let n = el;
    while (n) { if (n === mainRoot) return true; n = n.parentNode || n.host; }
    return false;
  };
  const SKIP = new Set(['HTML', 'BODY', 'HEAD', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION', 'OPTGROUP', 'BR', 'META', 'LINK', 'TITLE']);
  let scans = 0;
  const cursorOf = e => e && e.nodeType === 1 ? getComputedStyle(e).cursor : '';
  const pointer = el => {
    if (scans >= ${POINTER_SCAN_MAX}) return false;
    scans += 1;
    if (cursorOf(el) !== 'pointer') return false;
    const up = el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : el.parentNode && el.parentNode.host;
    return cursorOf(up) !== 'pointer';
  };
  const std = new Set();
  const cands = deepAll(document, e => {
    if (e.matches(sel)) { std.add(e); return true; }
    if (SKIP.has(e.tagName)) return false;
    return e.matches(xsel) || pointer(e);
  });
  const rows = new Set();
  const underRow = el => {
    for (let p = el.parentNode || el.host; p; p = p.parentNode || p.host) if (rows.has(p)) return true;
    return false;
  };
  const items = []; const seen = new Set(); let listed = 0; let truncated = false;
  for (const el of cands) {
    if (!vis(el)) continue;
    const tag = el.tagName.toLowerCase();
    const plain = !std.has(el);
    const kind = plain ? 'clickable' : el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? 'input:' + (el.type || 'text') : tag);
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    let line = '';
    if (plain) {
      if (underRow(el)) continue;
      const inner = el.querySelectorAll(sel);
      if (inner.length === 1 && inner[0].matches('input,button,select,a[href]') && vis(inner[0])) continue;
      const label = clip(labelOf(el) || el.getAttribute('alt') || iconLabel(el), 60);
      if (tag === 'a' && !label) continue;
      if (tag === 'tr' || el.getAttribute('role') === 'row' || !el.querySelector(sel)) rows.add(el);
      line = label ? JSON.stringify(label) : '(icon)';
    } else if (tag === 'a') {
      let h = el.getAttribute('href') || '';
      try { const u = new URL(el.href); h = u.origin === location.origin ? u.pathname + u.search + u.hash : u.href; } catch {}
      if (h.startsWith('#') || h.startsWith('javascript:')) h = '';
      const label = clip(labelOf(el), 60);
      const key = label + '|' + h;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!label.trim() && !h) continue;
      line = label + (h ? ' → ' + clip(h, 80) : '') + (el.hasAttribute('download') ? ' [download]' : '');
    } else if (tag === 'select') {
      const opts = [...el.options].map(o => o.text.trim());
      const cur = el.selectedOptions[0] ? el.selectedOptions[0].text : '';
      const shown = opts.length <= 40 ? opts.join('|') : opts.slice(0, 20).join('|') + '|…(+' + (opts.length - 20) + ' more)';
      line = clip(labelOf(el) === el.value ? (el.name || el.id) : labelOf(el), 40) + ' = "' + clip(cur, 30) + '" {' + shown + '}';
    } else if (tag === 'input' || tag === 'textarea') {
      const lab = el.labels && el.labels[0] ? el.labels[0].innerText : (el.getAttribute('aria-label') || el.placeholder || el.name || el.id);
      const pw = el.type === 'password';
      line = clip(lab, 50) + (el.value && !pw ? ' = "' + clip(el.value, 30) + '"' : '')
        + (el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? ' [x]' : ' [ ]') : '')
        + (pw ? ' (operator only)' : '');
    } else {
      line = clip(labelOf(el), 60);
    }
    if (!inScope(el)) { items.push({ el, line: null }); continue; }
    if (listed >= ${ELEMENTS_MAX}) { truncated = true; items.push({ el, line: null }); continue; }
    listed += 1;
    items.push({ el, line: kind + ' ' + line + (disabled ? ' [disabled]' : '') });
  }
  const parts = items.map(i => partsOf(i.el));
  const stored = storedKeysOf(items.map(i => i.el), parts.map(keyOf));
  const out = []; const keys = {}; const descs = []; const sigs = {}; const chrome = [];
  const rowText = new Map();
  const rowOf = el => {
    const r = el.closest('tr,[role=row]');
    if (!r) return '';
    if (!rowText.has(r)) rowText.set(r, clip(r.innerText || r.textContent || '', 200));
    return rowText.get(r);
  };
  items.forEach((it, i) => {
    const n = place(it.el, stored[i], it.line != null);
    keys[n] = stored[i];
    const p = parts[i];
    if (p.raw.includes('?')) descs.push({ kind: p.kind, label: p.label, href: p.raw });
    if (it.line != null) {
      out.push('[' + n + '] ' + it.line);
      sigs[n] = it.line + '\u0000' + rowOf(it.el);
      if (it.el.closest(${JSON.stringify(CHROME_SEL)})) chrome.push(n);
    }
  });
  return { lines: out, truncated, assigned, next, fresh, keys, descs, sigs, chrome, url: location.href };
})()`;
}

const ICON = `
  const iconLabel = e => {
    const img = [...e.querySelectorAll('img')].find(i => (i.getAttribute('alt') || '').trim());
    const t = e.querySelector('svg > title');
    const src = [...e.querySelectorAll('img[src]')].map(i => i.getAttribute('src')).find(u => !/^data:/i.test(u)) || '';
    return (img && img.getAttribute('alt')) || e.getAttribute('title') || e.getAttribute('aria-label') || (t && t.textContent)
      || src.split(/[?#]/)[0].split('/').pop() || '';
  };`;

const KIND_LABEL = `${ICON}
  const tag = el.tagName.toLowerCase();
  const type = (el.type || '').toLowerCase();
  const kind = !el.matches(${JSON.stringify(STD_SEL)}) ? 'clickable'
    : el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? 'input:' + (type || 'text') : tag);
  const raw = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('aria-label') || el.innerText
    || el.getAttribute('title') || el.getAttribute('placeholder') || (tag === 'input' && type !== 'password' ? el.value : '') || el.getAttribute('name')
    || (kind === 'clickable' ? el.getAttribute('alt') || iconLabel(el) : '') || '';
  const label = String(raw).replace(/\\s+/g, ' ').trim().slice(0, 60);`;

const REF = (n) => `const ref = window.__cxEls && window.__cxEls[${Number(n) | 0}];
  const el = ref && ref.deref();
  if (!el || !el.isConnected) return null;`;

function check(n, expect, state) {
  return `(() => {${numbering(state)}
  return verify(${Number(n) | 0}, ${JSON.stringify(expect == null ? null : String(expect))});
})()`;
}

function find(n) {
  return `(() => {
  ${REF(n)}
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  ${KIND_LABEL}
  const textual = tag === 'textarea' || (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden'].includes(type));
  return {
    x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag, type, kind, label,
    password: tag === 'input' && type === 'password',
    otp: el.getAttribute('autocomplete') === 'one-time-code',
    editable: (textual && !el.disabled && !el.readOnly) || el.isContentEditable,
    href: tag === 'a' && typeof el.href === 'string' ? el.href : '',
    download: tag === 'a' && el.hasAttribute('download') ? el.getAttribute('download') : null,
  };
})()`;
}

function inspect(n) {
  return `(() => {${DEEP}
  ${REF(n)}
  ${KIND_LABEL}
  const clip = (s, k) => { s = String(s || '').replace(/\\s+/g, ' ').trim(); return s.length > k ? s.slice(0, k - 1) + '…' : s; };
  const secret = e => e.tagName === 'INPUT' && (e.type === 'password' || e.getAttribute('autocomplete') === 'one-time-code');
  const FIRST = ['href', 'onclick', 'role', 'tabindex', 'type', 'name', 'value'];
  const rank = k => { const i = FIRST.indexOf(k); return i < 0 ? FIRST.length : i; };
  const names = [...el.attributes].map(a => a.name)
    .filter(k => k !== 'id' && k !== 'class' && k !== 'data-cx' && !(k === 'value' && secret(el)));
  names.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const attrs = names.slice(0, 8).map(k => [k, clip(el.getAttribute(k), 60)]);
  const short = (e, k) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + [...e.classList].slice(0, k).map(c => '.' + c).join('');
  const up = e => e.parentElement || (e.parentNode && e.parentNode.host) || null;
  const ancestors = [];
  for (let p = up(el); p && ancestors.length < 5; p = up(p)) ancestors.push(short(p, 2));
  const clone = el.cloneNode(true);
  for (const e of [clone, ...clone.querySelectorAll('*')]) {
    e.removeAttribute('data-cx');
    if (secret(e)) e.removeAttribute('value');
  }
  const r = el.getBoundingClientRect();
  return {
    tag, id: el.id || '', classes: [...el.classList].slice(0, 5), kind, label, attrs,
    cursor: getComputedStyle(el).cursor,
    marked: el.matches(${JSON.stringify(X_SEL)}),
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    visible: vis(el), ancestors, html: clip(clone.outerHTML, 300),
  };
})()`;
}

const PAGE_TEXT = `(() => {
  if (!document.body) return '';
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,template,iframe,object,embed,video,audio').forEach(n => n.remove());
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:1000px';
  host.appendChild(clone); document.body.appendChild(host);
  ${TABLES}
  const t = clone.innerText || ''; host.remove();
  return t.replace(/[ \\t]+/g, ' ').split('\\n').map(l => l.trim()).filter(Boolean).join('\\n').slice(0, ${TEXT_MAX});
})()`;

function findText(text, state) {
  const want = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
  return `(() => {${DEEP}${numbering(state)}
  if (!window.__cxEls || !window.__cxKeys) return { unstamped: true };
  const want = ${JSON.stringify(want)};
  const SKIP = new Set(['HTML', 'HEAD', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'OPTION', 'OPTGROUP', 'SELECT', 'TEXTAREA']);
  const BUTTONS = new Set(['button', 'submit', 'reset']);
  const own = el => {
    let t = el.tagName === 'INPUT' && BUTTONS.has(el.type) ? el.value || '' : '';
    for (const c of el.childNodes) if (c.nodeType === 3) t += c.nodeValue;
    return t.replace(/\\s+/g, ' ').trim();
  };
  const hits = deepAll(document, el => !SKIP.has(el.tagName) && own(el).toLowerCase().includes(want)).filter(vis);
  const top = hits.slice(0, 5);
  const loose = top.filter(el => !window.__cxOf.get(el));
  const pageBases = new Set(Object.values(window.__cxKeys).map(k => parseStored(k).base));
  const bases = loose.map(baseKeyOf);
  const dup = bases.map(b => pageBases.has(b) || bases.filter(x => x === b).length > 1);
  const ord = new Map();
  const storedOf = new Map(loose.map((el, i) => {
    if (!dup[i]) return [el, bases[i]];
    let o = (ord.get(bases[i]) || 0) + 1;
    while (Object.values(window.__cxKeys).some(k => parseStored(k).base === bases[i] && parseStored(k).ordinal === o)) o += 1;
    ord.set(bases[i], o);
    return [el, storedKey(bases[i], o, contextOf(el))];
  }));
  return { count: hits.length, hits: top.map(el => {
    const t = own(el);
    const n = window.__cxOf.get(el) || place(el, storedOf.get(el));
    return { n, fresh: fresh.includes(n), text: t.length > 60 ? t.slice(0, 59) + '…' : t };
  }), assigned, next };
})()`;
}

function clear(n) {
  return `(() => {
  ${REF(n)}
  el.focus();
  if (el.isContentEditable) document.execCommand('selectAll');
  else if (typeof el.select === 'function') el.select();
  return true;
})()`;
}

function value(n) {
  return `(() => {
  ${REF(n)}
  const v = el.isContentEditable ? el.textContent : String(el.value == null ? '' : el.value);
  return v.length > ${VALUE_MAX} ? v.slice(0, ${VALUE_MAX - 1}) + '…' : v;
})()`;
}

function select(n, option) {
  return `(() => {
  ${REF(n)}
  if (el.tagName !== 'SELECT') return { err: 'NOT_SELECT' };
  const want = ${JSON.stringify(String(option))};
  const opts = [...el.options].map(o => ({ o, value: o.value, text: o.text.trim() }));
  let hit = opts.filter(x => x.value === want || x.text === want);
  if (!hit.length) hit = opts.filter(x => x.value.toLowerCase() === want.toLowerCase() || x.text.toLowerCase() === want.toLowerCase());
  if (!hit.length) hit = opts.filter(x => x.text.toLowerCase().includes(want.toLowerCase()));
  if (hit.length !== 1) return { err: 'NO_OPTION', ambiguous: hit.length > 1, options: (hit.length ? hit : opts).map(x => x.text) };
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(el, hit[0].value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { value: el.value, text: hit[0].text };
})()`;
}

const PROFILE_SEL = 'a[href$="/profile"], a[aria-label*="Profile" i], [data-testid*="AppTabBar_Profile" i], [aria-label*="Account menu" i]';

const LOGIN_PROBE = `(() => {${DEEP}
  const any = (test) => deepAll(document, test).some(vis);
  const host = location.hostname;
  const idp = /(^|\\.)accounts\\.google\\.com$/.test(host) ? 'google'
    : /(^|\\.)(login\\.microsoftonline\\.com|login\\.live\\.com)$/.test(host) ? 'microsoft'
    : /(^|\\.)appleid\\.apple\\.com$/.test(host) ? 'apple'
    : /(^|\\.)okta\\.com$/.test(host) ? 'okta' : null;
  const body = (document.body && document.body.innerText) || '';
  const has = (test) => deepAll(document, test).length > 0;
  const loggedInHint = () => {
    if (has(el => el.tagName === 'INPUT' && el.type === 'password')) return null;
    const exit = /log ?out|sign ?out|deconectare|ieșire/i;
    if (has(el => (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'menuitem' || el.getAttribute('role') === 'button')
      && exit.test((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')))) return 'logout';
    if (has(el => el.matches(${JSON.stringify(PROFILE_SEL)}))) return 'profile';
    if (has(el => el.matches('[contenteditable=true][role=textbox]'))) return 'composer';
    return null;
  };
  return {
    password: any(el => el.tagName === 'INPUT' && el.type === 'password'),
    otp: any(el => el.tagName === 'INPUT' && el.getAttribute('autocomplete') === 'one-time-code'),
    captcha: any(el => el.tagName === 'IFRAME' && /recaptcha|hcaptcha|challenges\\.cloudflare\\.com/.test(el.src || '')),
    idp,
    googleRejected: idp === 'google' && (location.pathname.startsWith('/v3/signin/rejected') || body.includes('This browser or app may not be secure')),
    logoutLink: any(el => (el.tagName === 'A' || el.tagName === 'BUTTON') && /\\b(log|sign)\\s?out\\b/i.test(el.innerText || '')),
    loggedInHint: loggedInHint(),
  };
})()`;

const OVERLAY = `(() => {${DEEP}
  const old = document.getElementById(${JSON.stringify(OVERLAY_ID)});
  if (old) old.remove();
  const layer = document.createElement('div');
  layer.id = ${JSON.stringify(OVERLAY_ID)};
  layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483647';
  let drawn = 0;
  for (const [k, ref] of Object.entries(window.__cxEls || {})) {
    const el = ref && ref.deref();
    if (!el || !el.isConnected || !vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (!(r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight)) continue;
    const b = document.createElement('span');
    b.textContent = k;
    b.style.cssText = 'position:fixed;font:bold 12px/14px monospace;color:#fff;background:#111;border:1px solid #fff;padding:0 2px;border-radius:2px;z-index:2147483647'
      + ';left:' + Math.max(0, Math.round(r.left)) + 'px;top:' + Math.max(0, Math.round(r.top)) + 'px';
    layer.appendChild(b);
    drawn += 1;
  }
  (document.body || document.documentElement).appendChild(layer);
  return new Promise(res => { setTimeout(() => res(drawn), 150); requestAnimationFrame(() => requestAnimationFrame(() => res(drawn))); });
})()`;

const OVERLAY_OFF = `(() => {
  const layer = document.getElementById(${JSON.stringify(OVERLAY_ID)});
  if (layer) layer.remove();
  return !!layer;
})()`;
const TILE_SEL = '[role=button],article,li,tr,[role=row],section,[class*=card],[class*=tile]';
const STATE_ATTRS = ['aria-label', 'aria-pressed', 'aria-checked', 'aria-expanded', 'class'];

function targetState(n) {
  return `(() => {
  ${REF(n)}
  const of = e => {
    if (!e) return null;
    const o = {};
    for (const a of ${JSON.stringify(STATE_ATTRS)}) { const v = e.getAttribute(a); if (v != null) o[a] = v; }
    if (typeof e.value === 'string' && e.type !== 'password') o.value = e.value.slice(0, ${VALUE_MAX});
    return o;
  };
  const up = el.parentElement || (el.parentNode && el.parentNode.host) || null;
  return { el: of(el), tile: of(up && up.closest(${JSON.stringify(TILE_SEL)})) };
})()`;
}


const CONTENT_TYPE = 'document.contentType';

module.exports = {
  ISOLATED_WORLD, TEXT_MAX, CHROME_SEL, CHROME_MARK, ELEMENTS_MAX, VALUE_MAX, OVERLAY_ID, OVERLAY, OVERLAY_OFF, LOGIN_PROBE, CONTENT_TYPE, POINTER_SCAN_MAX, PAGE_TEXT, DEEP,
  READ_TEXT: readText, INSPECT: inspect, READ_INTERACTIVE: readInteractive, CHECK: check, numbering, FIND: find, FIND_TEXT: findText, CLEAR: clear, SELECT: select, VALUE: value,
  TARGET_STATE: targetState, TILE_SEL, STATE_ATTRS,
};
