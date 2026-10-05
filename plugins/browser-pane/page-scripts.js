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
const BADGE_CHAR_PX = 7.3;
const BADGE_PAD_PX = 6;
const BADGE_H_PX = 16;
const BADGE_LINE_PX = 8;
const BADGE_NUDGE_PX = 3;
const BOX_SEL = 'tr,li,article,[role=row],section';
const CHROME_SEL = 'nav,header,footer,aside,[role=banner],[role=navigation],[role=contentinfo],[role=complementary]';
const CHROME_MARK = '\u0001';

const SIGN_OUT = ['sign out', 'log out', 'logout', 'iesire', 'deconectare', 'abmelden', 'deconnexion', 'cerrar sesion', 'uitloggen', 'esci', 'sair'];
const CONSEQUENTIAL = [
  ['payment', ['pay', 'pay now', 'checkout', 'confirm payment', 'plateste', 'platiti', 'achita'], ['payment', 'payments', 'plata', 'plati', 'platire', 'card']],
  ['purchase', ['purchase', 'buy', 'cumpara', 'order', 'comanda'], []],
  ['deletion', ['delete', 'sterge', 'remove', 'elimina'], []],
  ['sign-out', SIGN_OUT, []],
  ['alarm', ['arm', 'disarm'], []],
  ['unsubscribe', ['unsubscribe', 'dezabonare', 'cancel subscription'], []],
  ['transfer', ['transfer', 'send money', 'wire'], []],
  ['publish', ['post', 'reply', 'repost', 'retweet', 'quote', 'like', 'unlike', 'follow', 'unfollow', 'follow back', 'send', 'send via direct message', 'send message', 'comment', 'publish', 'tweet',
    'submit review', 'posteaza', 'trimite', 'trimite mesaj', 'urmareste', 'apreciaza'], []],
];
const LEAD_CATS = ['publish'];
const ID_TERMS = ['pay', 'checkout', 'purchase', 'buy', 'delete', 'remove', 'sign out', 'log out', 'unsubscribe', 'arm', 'disarm'];
const FORM_ACTIONS = [['payment', 'pay'], ['payment', 'checkout'], ['purchase', 'order'], ['deletion', 'delete']];
const CQ_LABEL_MAX = 40;
const HMS_RE = '/\\b\\d{1,2}:\\d{2}:\\d{2}\\b/g';

function termRe(t, lead) {
  const body = t.split(' ').join('[\\s_-]?');
  return lead ? new RegExp('(^|\\. )' + body + '(?![a-z0-9-])') : new RegExp('(^|[^a-z0-9])' + body + '(?![a-z0-9])');
}

function cqCompile(table, idTerms, leadCats = []) {
  const out = [];
  for (const [cat, verbs, nouns] of table) {
    for (const t of verbs) out.push({ cat, id: idTerms.includes(t), noun: false, lead: leadCats.includes(cat), re: termRe(t, leadCats.includes(cat)) });
    for (const t of nouns) out.push({ cat, id: false, noun: true, re: termRe(t) });
  }
  return out;
}

function consequentialOf(d, res = cqCompile(CONSEQUENTIAL, ID_TERMS, LEAD_CATS)) {
  if (!d || d.textual) return null;
  const fold = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const text = (x) => { const f = fold(x); return d.capped && f.length > CQ_LABEL_MAX ? '' : f; };
  const hay = [text(d.label), text(d.value), text(d.aria)].filter(Boolean);
  const hayAll = [...hay, fold(d.formaction)].filter(Boolean);
  const idClass = fold(d.idClass);
  let lead = null;
  for (const r of res) {
    if (r.noun && !d.control) continue;
    if (lead && r.lead) continue;
    if (!((r.lead ? hay : hayAll).some((h) => r.re.test(h)) || (r.id && idClass && r.re.test(idClass)))) continue;
    if (!r.lead) return r.cat;
    lead = r.cat;
  }
  const action = fold(d.action);
  if (action) for (const [cat, w] of FORM_ACTIONS) if (action.includes(w)) return cat;
  return lead;
}

function signOutOf(texts, res = SIGN_OUT.map((t) => termRe(t))) {
  const fold = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  return texts.some((t) => res.some((re) => re.test(fold(t))));
}

const CQ = `
  const SIGN_OUT = ${JSON.stringify(SIGN_OUT)};
  const CONSEQUENTIAL = ${JSON.stringify(CONSEQUENTIAL)};
  const ID_TERMS = ${JSON.stringify(ID_TERMS)};
  const FORM_ACTIONS = ${JSON.stringify(FORM_ACTIONS)};
  const CQ_LABEL_MAX = ${CQ_LABEL_MAX};
  const LEAD_CATS = ${JSON.stringify(LEAD_CATS)};
  ${termRe.toString()}
  ${cqCompile.toString()}
  ${consequentialOf.toString()}
  const CQ_RES = cqCompile(CONSEQUENTIAL, ID_TERMS, LEAD_CATS);
  const CQ_INNER = 'input[type=submit],input[type=button],input[type=image],button,[role=button]';
  const cqOf = e => {
    const tg = e.tagName.toLowerCase();
    const ty = String(e.type || '').toLowerCase();
    const textual = tg === 'textarea' || e.isContentEditable
      || (tg === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file'].includes(ty));
    const submit = (tg === 'button' && (ty === 'submit' || !e.getAttribute('type'))) || (tg === 'input' && (ty === 'submit' || ty === 'image'));
    const form = e.form || null;
    const href = tg === 'a' ? String(e.getAttribute('href') || '').split(/[?#]/)[0] : '';
    const doc = tg === 'a' && (e.hasAttribute('download') || /\\.(pdf|xlsx?|docx?)$/i.test(href));
    const button = tg === 'button' || (tg === 'input' && ['submit', 'button', 'image'].includes(ty)) || e.getAttribute('role') === 'button';
    const inner = button || textual ? [] : e.querySelectorAll(CQ_INNER);
    return consequentialOf({
      textual,
      control: button && !doc && (!!(form || e.closest('form')) || e.hasAttribute('formaction')),
      capped: tg === 'a' || !e.matches(${JSON.stringify(STD_SEL)}),
      label: (e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('aria-label') || e.innerText || e.getAttribute('title') || '',
      value: tg === 'input' && ty !== 'password' ? e.value : '',
      aria: e.getAttribute('aria-label'),
      idClass: (e.id || '') + ' ' + (e.getAttribute('class') || ''),
      formaction: e.getAttribute('formaction'),
      action: submit ? e.getAttribute('formaction') || (form ? form.getAttribute('action') : '') : '',
    }, CQ_RES) || (inner.length === 1 ? cqOf(inner[0]) : null);
  };`;

const ROW = `
  const rowText = new Map();
  const rowOf = el => {
    const r = el.closest('tr,[role=row]');
    if (!r) return '';
    if (!rowText.has(r)) rowText.set(r, String(r.innerText || r.textContent || '').replace(/\\s+/g, ' ').trim().replace(${HMS_RE}, '#:##:##').slice(0, 200));
    return rowText.get(r);
  };`;

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

function bulletItems(root, mark) {
  const first = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3 && c.data.trim()) return c;
      const t = c.nodeType === 1 ? first(c) : null;
      if (t) return t;
    }
    return null;
  };
  for (const li of root.querySelectorAll('ul > li:not([role=menuitem]), ol > li:not([role=menuitem])')) {
    const t = first(li);
    if (!t || t.data.startsWith(mark) || t.data.trimStart().startsWith('• ')) continue;
    t.data = '• ' + t.data.trimStart();
  }
}

function readText(main) {
  return `(() => {${DEEP}
  ${bulletItems.toString()}
  const DROP = 'script,style,noscript,select,svg,form,[aria-hidden=true],.navbox,.mw-editsection,.reference,.reflist,#toc,.toc';
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
  bulletItems(clone, ${JSON.stringify(CHROME_MARK)});
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
  return `${ICON}${CQ}
  ${keys.PAGE_SOURCE}
  const known = ${JSON.stringify(known)};
  const learned = ${JSON.stringify(learned)};
  const listedBefore = ${listedBefore ? `new Set(${JSON.stringify(listedBefore)})` : 'null'};
  let next = ${next};
  const assigned = {};
  const fresh = [];
  const flat = s => String(s || '').replace(/\\s+/g, ' ').trim();
  const clip = (s, n) => { s = flat(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
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
    let label = counterMask(flat(labelOf(el)));
    const inArt = el.closest('article');
    const art = (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') && inArt;
    const act = art ? actionOf(label) : '';
    const permalink = a => {
      const time = a.querySelector('time');
      const pl = a.querySelector('a[href*="/status/"]') || (time && time.closest('a'));
      return pl ? pl.getAttribute('href') || '' : null;
    };
    const pl = inArt ? permalink(inArt) : null;
    if (act && pl != null) label = act + ' ' + pl;
    else if (inArt && (tag === 'article' || kind === 'clickable') && pl && !actionOf(label)) {
      let p = pl;
      try { p = new URL(pl, location.href).pathname; } catch {}
      label = 'article ' + p;
    } else if (inArt) label = label.replace(/\\b\\d[\\d.,]*[KkMm]?\\b/g, '#');
    if (tag !== 'a' || !el.hasAttribute('href')) return { kind, label, raw: '', href: '' };
    let raw = '';
    try { const u = new URL(el.href); u.hash = ''; raw = u.origin === location.origin ? u.pathname + u.search : u.href; } catch {}
    return { kind, label, raw, href: normHref(el.href, location.origin, learned) };
  };
  const baseKeyOf = el => keyOf(partsOf(el));
  let headings = null;
  const boxText = new Map();
  const contextOf = el => {
    const box = el.closest(${JSON.stringify(BOX_SEL)});
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

function distinctClips(labels, max = 60, part = 30) {
  const clipOf = (s) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
  const groups = new Map();
  labels.forEach((s, i) => {
    if (!s || s.length <= max) return;
    const c = clipOf(s);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(i);
  });
  const out = labels.map(() => null);
  for (const idx of groups.values()) {
    if (new Set(idx.map((i) => labels[i])).size < 2) continue;
    for (const i of idx) {
      const s = labels[i];
      let head = s.slice(0, part);
      if (s[part] !== ' ' && head.lastIndexOf(' ') > 0) head = head.slice(0, head.lastIndexOf(' '));
      let tail = s.slice(-part);
      if (s[s.length - part - 1] !== ' ' && tail.indexOf(' ') >= 0) tail = tail.slice(tail.indexOf(' ') + 1);
      out[i] = head.trim() + ' … ' + tail.trim();
    }
    if (new Set(idx.map((i) => out[i])).size < new Set(idx.map((i) => labels[i])).size) for (const i of idx) out[i] = null;
  }
  return out;
}

function inputLine(d) {
  const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const clip = (s, n) => { s = flat(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const pw = d.type === 'password';
  const btn = d.tag === 'input' && /^(button|submit|reset|image)$/.test(d.type);
  const lab = flat((btn && d.value) || flat(d.label) || d.aria || d.placeholder || d.name || d.id);
  const shown = d.value && !pw && !(btn && lab === flat(d.value));
  return clip(lab, 50) + (shown ? ' = "' + clip(d.value, 30) + '"' : '')
    + (d.type === 'checkbox' || d.type === 'radio' ? (d.checked ? ' [x]' : ' [ ]') : '')
    + (pw ? ' (operator only)' : '');
}

function readInteractive(main, state) {
  return `(() => {${DEEP}${numbering(state)}
  ${distinctClips.toString()}
  ${inputLine.toString()}
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
    let sig = null;
    let full = null;
    if (plain) {
      if (underRow(el)) continue;
      const inner = el.querySelectorAll(sel);
      if (inner.length === 1 && inner[0].matches('input,button,select,a[href]') && vis(inner[0])) continue;
      full = flat(labelOf(el));
      const label = clip(full, 60);
      if (tag === 'a' && !label) continue;
      if (tag === 'tr' || el.getAttribute('role') === 'row' || !el.querySelector(sel)) rows.add(el);
      line = label ? JSON.stringify(label) : '(icon)';
    } else if (tag === 'a') {
      let h = el.getAttribute('href') || '';
      try { const u = new URL(el.href); h = u.origin === location.origin ? u.pathname + u.search + u.hash : u.href; } catch {}
      if (h.startsWith('#') || h.startsWith('javascript:')) h = '';
      full = flat(labelOf(el));
      const label = clip(full, 60);
      const key = label + '|' + h;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!label.trim() && !h) continue;
      line = label + (h ? ' → ' + clip(h, 80) : '') + (el.hasAttribute('download') ? ' [download]' : '');
      sig = label + (el.hasAttribute('download') ? ' [download]' : '');
    } else if (tag === 'select') {
      const opts = [...el.options].map(o => o.text.trim());
      const cur = el.selectedOptions[0] ? el.selectedOptions[0].text : '';
      const shown = opts.length <= 40 ? opts.join('|') : opts.slice(0, 20).join('|') + '|…(+' + (opts.length - 20) + ' more)';
      line = clip(labelOf(el) === el.value ? (el.name || el.id) : labelOf(el), 40) + ' = "' + clip(cur, 30) + '" {' + shown + '}';
    } else if (tag === 'input' || tag === 'textarea') {
      line = inputLine({
        tag, type: el.type, value: el.value, checked: el.checked, label: el.labels && el.labels[0] ? el.labels[0].innerText : '',
        aria: el.getAttribute('aria-label'), placeholder: el.placeholder, name: el.name, id: el.id,
      });
    } else {
      full = flat(labelOf(el));
      line = clip(full, 60);
    }
    if (!inScope(el)) { items.push({ el, line: null }); continue; }
    if (listed >= ${ELEMENTS_MAX}) { truncated = true; items.push({ el, line: null }); continue; }
    listed += 1;
    items.push({ el, full, line: kind + ' ' + (cqOf(el) ? '⚠ ' : '') + line + (disabled ? ' [disabled]' : ''), sig: sig == null ? null : kind + ' ' + sig + (disabled ? ' [disabled]' : '') });
  }
  const tails = distinctClips(items.map(i => (i.line != null && i.full) || ''));
  items.forEach((it, i) => {
    if (!tails[i]) return;
    it.line = it.line.replace(clip(it.full, 60), () => tails[i]);
    if (it.sig != null) it.sig = it.sig.replace(clip(it.full, 60), () => tails[i]);
  });
  const parts = items.map(i => partsOf(i.el));
  const stored = storedKeysOf(items.map(i => i.el), parts.map(keyOf));
  const out = []; const keys = {}; const descs = []; const sigs = {}; const chrome = []; const rowsOut = {};${ROW}
  items.forEach((it, i) => {
    const n = place(it.el, stored[i], it.line != null);
    keys[n] = stored[i];
    const p = parts[i];
    if (p.raw.includes('?')) descs.push({ kind: p.kind, label: p.label, href: p.raw });
    if (it.line != null) {
      out.push('[' + n + '] ' + it.line);
      rowsOut[n] = rowOf(it.el);
      sigs[n] = counterMask(it.sig == null ? it.line : it.sig) + '\u0000' + counterMask(rowsOut[n]);
      if (it.el.closest(${JSON.stringify(CHROME_SEL)})) chrome.push(n);
    }
  });
  return { lines: out, truncated, assigned, next, fresh, keys, descs, sigs, rows: rowsOut, chrome, url: location.href };
})()`;
}

const PLACEHOLDER_ALTS = ['alt', 'image', 'icon', 'img', 'photo', 'picture'];
const PLACEHOLDER_ALT_RE = 'profile picture|avatar|user image|photo of';
const GENERIC_CLASSES = ['container', 'wrapper', 'wrap', 'inner', 'outer', 'row', 'col', 'flex', 'grid', 'item', 'box', 'btn', 'button', 'icon', 'clickable', 'active', 'selected', 'link', 'nav', 'text', 'bg', 'is', 'has', 'js', 'ui'];

function labelFrom(d) {
  const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const alt = (s) => { const a = flat(s); return a && !PLACEHOLDER_ALTS.includes(a.toLowerCase()) && !new RegExp(PLACEHOLDER_ALT_RE, 'i').test(a) ? a : ''; };
  const tid = (s) => flat(s).replace(/[-_](container|wrapper|wrap|button|btn)$/i, '');
  const cls = (s) => flat(s).split(' ').find((c) => c.length <= 30 && /^[a-z]{2,}(?:[-_][a-z]{2,})*$/i.test(c) && !GENERIC_CLASSES.includes(c.toLowerCase().split(/[-_]/)[0])) || '';
  const path = (h) => { try { return new URL(h, 'http://x.invalid/').pathname; } catch { return ''; } };
  const segs = (h) => path(h).split('/').filter(Boolean);
  const last = (h) => { const s = segs(h).pop() || ''; try { return decodeURIComponent(s); } catch { return s; } };
  const pick = (xs) => { for (const x of xs) { const v = typeof x === 'function' ? x() : x; if (v) return v; } return ''; };
  const form = ['button', 'input', 'select', 'textarea'].includes(d.tag);
  const photo = d.tag === 'a' && d.href ? /\/photo\/(\d+)\/?$/.exec(path(d.href)) : null;
  const handle = d.tag === 'a' && d.href && segs(d.href).length === 1 && /^[A-Za-z0-9_]{1,30}$/.test(segs(d.href)[0]) ? '@' + segs(d.href)[0] : '';
  const named = pick([flat(d.label), flat(d.aria), flat(d.text), flat(d.placeholder), ['input', 'select', 'button'].includes(d.tag) ? flat(d.value) : '', flat(d.title),
    () => (handle ? '' : (d.alts || []).map(alt).find(Boolean)), () => (form ? flat(d.name) || flat(d.id) : flat(d.inner))]);
  if (named) return photo && /^\d+$/.test(named) ? 'photo ' + photo[1] : named;
  if (photo) return 'photo ' + photo[1];
  if (d.tag === 'a' && d.href && path(d.href) !== '/') {
    return pick([tid(d.svgTestid), flat(d.svgTitle), handle, () => last(d.href)]);
  }
  const src = /^data:/i.test(flat(d.src)) ? '' : flat(d.src).split(/[?#]/)[0].split('/').pop() || '';
  const icon = pick([flat(d.svgTitle), tid(d.testid), tid(d.svgTestid), cls(d.classes), src]);
  return icon && icon === src && d.video && /\.(jpe?g|png|webp|gif)$/i.test(src) ? 'video' : icon;
}

const ICON = `
  const PLACEHOLDER_ALTS = ${JSON.stringify(PLACEHOLDER_ALTS)};
  const PLACEHOLDER_ALT_RE = ${JSON.stringify(PLACEHOLDER_ALT_RE)};
  const GENERIC_CLASSES = ${JSON.stringify(GENERIC_CLASSES)};
  ${labelFrom.toString()}
  const descOf = e => {
    const tg = e.tagName.toLowerCase();
    const svg = e.querySelector('svg');
    const st = e.querySelector('svg > title');
    const inner = e.querySelector('[data-testid]');
    const btn = ['button', 'input', 'select', 'textarea'].includes(tg) ? null : e.querySelector('button,input[type=button],input[type=submit],input[type=image]');
    return {
      tag: tg,
      label: e.labels && e.labels[0] ? e.labels[0].innerText : '',
      aria: e.getAttribute('aria-label'),
      text: e.innerText,
      placeholder: e.getAttribute('placeholder'),
      value: typeof e.value === 'string' && !(tg === 'input' && String(e.type).toLowerCase() === 'password') ? e.value : '',
      title: e.getAttribute('title'),
      alts: [e.getAttribute('alt'), ...[...e.querySelectorAll('img')].map(i => i.getAttribute('alt'))],
      name: e.getAttribute('name'), id: e.id,
      href: tg === 'a' ? e.getAttribute('href') : '',
      testid: e.getAttribute('data-testid') || (inner ? inner.getAttribute('data-testid') : ''),
      svgTestid: svg ? svg.getAttribute('data-testid') : '',
      svgTitle: st ? st.textContent : '',
      classes: e.getAttribute('class'),
      src: [e.getAttribute('src') || '', ...[...e.querySelectorAll('img[src]')].map(i => i.getAttribute('src'))].find(u => u && !/^data:/i.test(u)) || '',
      inner: btn ? (btn.tagName === 'INPUT' ? btn.value : btn.innerText) || btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.getAttribute('name') || '' : '',
      video: !!(e.closest('video,[data-testid*=video i]') || e.querySelector('video,[data-testid*=video i]')),
    };
  };
  const labelOf = el => labelFrom(descOf(el));`;


const KIND_LABEL = `${ICON}
  const tag = el.tagName.toLowerCase();
  const type = (el.type || '').toLowerCase();
  const kind = !el.matches(${JSON.stringify(STD_SEL)}) ? 'clickable'
    : el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? 'input:' + (type || 'text') : tag);
  const label = labelOf(el).slice(0, 60);`;

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
  ${KIND_LABEL}${CQ}${ROW}
  const textual = tag === 'textarea' || (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden'].includes(type));
  return {
    x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag, type, kind, label,
    password: tag === 'input' && type === 'password',
    otp: el.getAttribute('autocomplete') === 'one-time-code',
    editable: (textual && !el.disabled && !el.readOnly) || el.isContentEditable,
    href: tag === 'a' && typeof el.href === 'string' ? el.href : '',
    download: tag === 'a' && el.hasAttribute('download') ? el.getAttribute('download') : null,
    consequential: cqOf(el),
    row: rowOf(el),
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
  const SIGN_OUT = ${JSON.stringify(SIGN_OUT)};
  ${termRe.toString()}
  ${signOutOf.toString()}
  const SO_RES = SIGN_OUT.map((t) => termRe(t));
  const hrefPath = el => String(el.getAttribute('href') || '').split(/[?#]/)[0].replace(/[/._-]+/g, ' ');
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
    logoutLink: any(el => (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'menuitem')
      && signOutOf([el.innerText || el.textContent, el.getAttribute('aria-label'), hrefPath(el)], SO_RES)),
    loggedInHint: loggedInHint(),
  };
})()`;

const OVERLAY = `(() => {${DEEP}${CQ}
  const old = document.getElementById(${JSON.stringify(OVERLAY_ID)});
  if (old) old.remove();
  const layer = document.createElement('div');
  layer.id = ${JSON.stringify(OVERLAY_ID)};
  layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483647';
  let drawn = 0;
  const items = [];
  for (const [k, ref] of Object.entries(window.__cxEls || {})) {
    const el = ref && ref.deref();
    if (!el || !el.isConnected || !vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (!(r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight)) continue;
    items.push({ k, el, r });
  }
  const badgeRects = [];
  const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const wordAt = (x, y) => {
    const c = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    const t = c && c.startContainer;
    if (!t || t.nodeType !== 3) return false;
    for (const i of [c.startOffset - 1, c.startOffset]) {
      if (i < 0 || i >= t.data.length || !/\S/.test(t.data[i])) continue;
      const q = document.createRange();
      q.setStart(t, i);
      q.setEnd(t, i + 1);
      const b = q.getBoundingClientRect();
      if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return true;
    }
    return false;
  };
  const textUnder = (left, right, y) => {
    for (let x = left; x < right; x += 4) if (wordAt(x, y)) return true;
    return wordAt(right, y);
  };
  for (const { k, el, r } of items) {
    const b = document.createElement('span');
    b.textContent = k;
    const st = getComputedStyle(el);
    const lh = parseFloat(st.lineHeight) || (parseFloat(st.fontSize) || 15) * 1.2;
    const media = el.tagName === 'IMG' || !!el.querySelector('img,video,canvas');
    const bw = Math.ceil(k.length * ${BADGE_CHAR_PX}) + ${BADGE_PAD_PX};
    let x = r.left - ${BADGE_NUDGE_PX};
    let y = r.top;
    if (!media && r.height <= 2 * lh + 2) {
      const lx = r.left - bw - 2;
      const blocked = lx < 0 || [...items.map(i => i.r), ...badgeRects].some(o => o !== r && Math.abs(o.top - r.top) < ${BADGE_LINE_PX}
        && o.left < r.left && o.right > lx && !(o.left <= r.left && o.right >= r.right))
        || textUnder(lx, r.left - 2, r.top + r.height / 2);
      const above = { left: r.left, top: r.top - ${BADGE_H_PX}, right: r.left + bw, bottom: r.top };
      const aboveBlocked = above.top < 0 || [...items.map(i => i.r), ...badgeRects].some(o => o !== r && hits(o, above)
        && !(o.left <= r.left && o.right >= r.right && o.top <= r.top && o.bottom >= r.bottom));
      if (!blocked) x = lx;
      else if (!aboveBlocked) { x = r.left; y = r.top - ${BADGE_H_PX}; }
    }
    badgeRects.push({ left: x, top: y, right: x + bw, bottom: y + ${BADGE_H_PX} });
    b.style.cssText = 'position:fixed;font:bold 12px/14px monospace;color:#fff;padding:0 2px;border-radius:2px;border:1px solid #fff;z-index:2147483647'
      + (cqOf(el) ? ';background:#e00' : ';background:#111')
      + ';left:' + Math.max(0, Math.round(x)) + 'px;top:' + Math.max(0, Math.round(y)) + 'px';
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
const TILE_SEL = `[role=button],${BOX_SEL},[class*=card]`;
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
  ISOLATED_WORLD, TEXT_MAX, BOX_SEL, CHROME_SEL, CHROME_MARK, ELEMENTS_MAX, VALUE_MAX, OVERLAY_ID, OVERLAY, OVERLAY_OFF, LOGIN_PROBE, CONTENT_TYPE, POINTER_SCAN_MAX, PAGE_TEXT, DEEP,
  READ_TEXT: readText, INSPECT: inspect, READ_INTERACTIVE: readInteractive, CHECK: check, numbering, FIND: find, FIND_TEXT: findText, CLEAR: clear, SELECT: select, VALUE: value,
  TARGET_STATE: targetState, TILE_SEL, STATE_ATTRS, CONSEQUENTIAL, SIGN_OUT, consequentialOf, signOutOf, labelFrom, distinctClips, inputLine, bulletItems,
};
