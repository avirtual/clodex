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
    for (const t of verbs) out.push({ cat, t, id: idTerms.includes(t), noun: false, lead: leadCats.includes(cat), re: termRe(t, leadCats.includes(cat)) });
    for (const t of nouns) out.push({ cat, t, id: false, noun: true, re: termRe(t) });
  }
  return out;
}

function consequentialOf(d, res = cqCompile(CONSEQUENTIAL, ID_TERMS, LEAD_CATS)) {
  const hit = consequentialHit(d, res);
  return hit ? hit.cat : null;
}

function consequentialHit(d, res = cqCompile(CONSEQUENTIAL, ID_TERMS, LEAD_CATS)) {
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
    if (!r.lead) return { cat: r.cat, term: r.t };
    lead = { cat: r.cat, term: r.t };
  }
  const action = fold(d.action);
  if (action) for (const [cat, w] of FORM_ACTIONS) if (action.includes(w)) return { cat, term: w };
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
  ${consequentialHit.toString()}
  const CQ_RES = cqCompile(CONSEQUENTIAL, ID_TERMS, LEAD_CATS);
  const CQ_INNER = 'input[type=submit],input[type=button],input[type=image],button,[role=button]';
  const cqInputs = e => {
    const tg = e.tagName.toLowerCase();
    const ty = String(e.type || '').toLowerCase();
    const textual = tg === 'textarea' || e.isContentEditable
      || (tg === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file'].includes(ty));
    const submit = (tg === 'button' && (ty === 'submit' || !e.getAttribute('type'))) || (tg === 'input' && (ty === 'submit' || ty === 'image'));
    const form = e.form || null;
    const href = tg === 'a' ? String(e.getAttribute('href') || '').split(/[?#]/)[0] : '';
    const doc = tg === 'a' && (e.hasAttribute('download') || /\\.(pdf|xlsx?|docx?)$/i.test(href));
    const button = tg === 'button' || (tg === 'input' && ['submit', 'button', 'image'].includes(ty)) || e.getAttribute('role') === 'button';
    return {
      textual,
      button,
      control: button && !doc && (!!(form || e.closest('form')) || e.hasAttribute('formaction')),
      capped: tg === 'a' || e.getAttribute('role') === 'link' || !e.matches(${JSON.stringify(STD_SEL)}),
      label: (e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('aria-label') || e.innerText || e.getAttribute('title') || '',
      value: tg === 'input' && ty !== 'password' ? e.value : '',
      aria: e.getAttribute('aria-label'),
      idClass: (e.id || '') + ' ' + (e.getAttribute('class') || ''),
      formaction: e.getAttribute('formaction'),
      action: submit ? e.getAttribute('formaction') || (form ? form.getAttribute('action') : '') : '',
    };
  };
  const adLines = new Map();
  const adArticle = e => {
    let art = null;
    for (let a = e.closest ? e.closest('article') : null; a; a = a.parentElement ? a.parentElement.closest('article') : null) art = a;
    if (!art) return null;
    if (!adLines.has(art)) adLines.set(art, String(art.innerText || '').split('\\n').map(l => l.replace(/\\s+/g, ' ').trim()).find(l => /^(ad|promoted|sponsored)$/i.test(l)) || null);
    return adLines.get(art);
  };
  const cqHit = e => {
    const d = cqInputs(e);
    const statusLink = e.tagName.toLowerCase() === 'a' && /\\/status\\//.test(String(e.getAttribute('href') || '').split(/[?#]/)[0]);
    const ad = d.button || d.textual || statusLink ? null : adArticle(e);
    if (ad) return { cat: 'ad', term: ad };
    const inner = d.button || d.textual ? [] : e.querySelectorAll(CQ_INNER);
    return consequentialHit(d, CQ_RES) || (inner.length === 1 && !vis(inner[0]) ? cqHit(inner[0]) : null);
  };
  const cqOf = e => { const hit = cqHit(e); return hit ? hit.cat : null; };`;

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

function bulletItems(root, mark, hidden = (e) => getComputedStyle(e).display === 'none') {
  const first = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3 && c.data.trim()) return c;
      const t = c.nodeType === 1 && c.tagName !== 'TABLE' && !hidden(c) ? first(c) : null;
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

const READ_ROOT_SEL = 'main article, article, [role=main], main, #mw-content-text, #content';

const SCROLL_INFO = `(() => {
  const root = document.querySelector(${JSON.stringify(READ_ROOT_SEL)}) || document.body;
  const count = (el, sel) => (el ? el.querySelectorAll(sel).length : 0);
  const items = count(document, 'article') || count(root, '[role=listitem]') || count(root, 'li');
  const se = document.scrollingElement || document.documentElement;
  return { y: Math.round(window.scrollY), height: Math.round(se.scrollHeight), vh: Math.round(window.innerHeight), items };
})()`;

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
  let root = forced || document.querySelector(${JSON.stringify(READ_ROOT_SEL)});
  if (!forced && (!root || (root.innerText || '').length < 200)) {
    let best = document.body, bs = -1;
    document.querySelectorAll('div,section,td').forEach(el => {
      const s = score(el); if (s > bs) { bs = s; best = el; }
    });
    root = best;
  }
  const busyEls = [...document.querySelectorAll(${JSON.stringify(BUSY_SEL)})].filter(vis);
  const busy = { count: busyEls.length, text: busyEls.length ? (busyEls[0].innerText || busyEls[0].textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) : '' };
  const labels = (sel, k, of) => [...document.querySelectorAll(sel)].filter(vis).map(e => (of(e) || '').replace(/\\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, k);
  const outline = { headings: labels('h1,h2,h3', 6, e => e.innerText || e.textContent), landmarks: labels('main,nav,[role=main],[role=navigation]', 3, e => e.getAttribute('aria-label')) };
  if (!root) return { text: '', busy, outline };
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
  bulletItems(clone, ${JSON.stringify(CHROME_MARK)});
  ${TABLES}
  const txt = clone.innerText; host.remove();
  const text = (document.title + '\\n\\n' + txt).replace(/[ \\t]+/g, ' ').replace(/\\n\\s*\\n+/g, '\\n\\n').trim().slice(0, ${TEXT_MAX});
  return { text, busy, outline };
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
  const dupContexts = els => {
    const blockText = new Map();
    const under = new Map();
    for (const el of els) for (let a = el.parentElement; a; a = a.parentElement) under.set(a, (under.get(a) || 0) + 1);
    return els.map(el => {
      let block = null;
      for (let a = el.parentElement; a && under.get(a) === 1; a = a.parentElement) block = a;
      if (block && block !== document.body && block !== document.documentElement) {
        if (!blockText.has(block)) {
          const t = flat(block.innerText || block.textContent || '').slice(0, CONTEXT_MAX * 4);
          blockText.set(block, counterMask(t).replace(${HMS_RE}, '#:##:##'));
        }
        if (blockText.get(block)) return blockText.get(block);
      }
      return contextOf(el);
    });
  };
  const dupKeys = (b, els) => {
    const ctx = dupContexts(els);
    const ord = new Map();
    return els.map((_el, j) => {
      const tie = storedKey(b, 1, ctx[j]);
      const o = (ord.get(tie) || 0) + 1;
      ord.set(tie, o);
      return storedKey(b, o, ctx[j]);
    });
  };
  const twinKey = (el, base) => {
    const group = [el];
    for (const [m, r] of Object.entries(window.__cxEls || {})) {
      const e = r && r.deref();
      if (!e || !e.isConnected || group.includes(e) || parseStored(window.__cxKeys[m]).base !== base) continue;
      if (baseKeyOf(e) === base) group.push(e);
    }
    group.sort((a, b) => (a.compareDocumentPosition ? (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1) : 0));
    return dupKeys(base, group)[group.indexOf(el)];
  };
  const storedKeysOf = (els, bases = els.map(baseKeyOf)) => {
    const groups = new Map();
    bases.forEach((b, i) => { if (!groups.has(b)) groups.set(b, []); groups.get(b).push(i); });
    const out = bases.slice();
    for (const [b, idx] of groups) {
      if (idx.length < 2) continue;
      dupKeys(b, idx.map(i => els[i])).forEach((k, j) => { out[idx[j]] = k; });
    }
    return out;
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
    const base = baseKeyOf(el);
    if (!p.ordinal) return base === k ? 'ok' : 'ambiguous';
    return twinKey(el, base) === k ? 'ok' : 'ambiguous';
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
  const lab = flat((btn && flat(d.value)) || flat(d.label) || d.aria || d.placeholder || d.name || d.id);
  const shown = flat(d.value) && !pw && !(btn && lab === flat(d.value));
  return clip(lab, 50) + (shown ? ' = "' + clip(d.value, 30) + '"' : '')
    + (d.type === 'checkbox' || d.type === 'radio' ? (d.checked ? ' [x]' : ' [ ]') : '')
    + (pw ? ' (operator only)' : '');
}

function joinUrls(s) {
  return String(s || '').replace(/(https?:\/\/)\s+/g, '$1').replace(/(https?:\/\/[\w.-]*)\s+(?=[\w.-]*\.[a-z]{2,}\/)/g, '$1');
}

function collect(main) {
  return `
  ${joinUrls.toString()}
  const sel = ${JSON.stringify(STD_SEL)};
  const xsel = ${JSON.stringify(X_SEL)};
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
      full = joinUrls(flat(labelOf(el)));
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
    const cq = cqOf(el);
    items.push({ el, full, cq, line: kind + ' ' + (cq ? '⚠ ' : '') + line + (disabled ? ' [disabled]' : ''), sig: sig == null ? null : kind + ' ' + sig + (disabled ? ' [disabled]' : '') });
  }
`;
}

function readInteractive(main, state) {
  return `(() => {${DEEP}${numbering(state)}
  ${distinctClips.toString()}
  ${inputLine.toString()}
  resetTable();${collect(main)}  const tails = distinctClips(items.map(i => (i.line != null && i.full) || ''));
  items.forEach((it, i) => {
    if (!tails[i]) return;
    it.line = it.line.replace(clip(it.full, 60), () => tails[i]);
    if (it.sig != null) it.sig = it.sig.replace(clip(it.full, 60), () => tails[i]);
  });
  const parts = items.map(i => partsOf(i.el));
  const stored = storedKeysOf(items.map(i => i.el), parts.map(keyOf));
  const out = []; const keys = {}; const descs = []; const sigs = {}; const chrome = []; const rowsOut = {}; const cats = {};${ROW}
  items.forEach((it, i) => {
    const n = place(it.el, stored[i], it.line != null);
    keys[n] = stored[i];
    const p = parts[i];
    if (p.raw.includes('?')) descs.push({ kind: p.kind, label: p.label, href: p.raw });
    if (it.line != null) {
      out.push('[' + n + '] ' + it.line);
      if (it.cq) cats[n] = it.cq;
      rowsOut[n] = rowOf(it.el);
      sigs[n] = counterMask(it.sig == null ? it.line : it.sig) + '\u0000' + counterMask(rowsOut[n]);
      if (it.el.closest(${JSON.stringify(CHROME_SEL)})) chrome.push(n);
    }
  });
  return { lines: out, truncated, assigned, next, fresh, keys, descs, sigs, rows: rowsOut, chrome, cats, posts: [...(${main ? `document.querySelector('main, [role=main]') || document` : 'document'}).querySelectorAll('article')].filter(a => !(a.parentElement && a.parentElement.closest('article'))).length, url: location.href };
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
  const human = (s) => flat(s).replace(/[_-]+/g, ' ').trim();
  const avatar = (s) => /^[\w-]+_(bigger|normal|mini|200x200|400x400|x96)(\.(jpe?g|png|webp|gif))?$/i.test(s);
  const form = ['button', 'input', 'select', 'textarea'].includes(d.tag);
  const photo = d.tag === 'a' && d.href ? /\/photo\/(\d+)\/?$/.exec(path(d.href)) : null;
  const handle = d.tag === 'a' && d.href && segs(d.href).length === 1 && /^[A-Za-z0-9_]{1,30}$/.test(segs(d.href)[0]) ? '@' + segs(d.href)[0] : '';
  const named = pick([flat(d.label), flat(d.aria), flat(d.text), flat(d.placeholder), ['input', 'select', 'button'].includes(d.tag) ? flat(d.value) : '', flat(d.title),
    () => (handle ? '' : (d.alts || []).map(alt).find(Boolean)), () => (form ? flat(d.name) || flat(d.id) : flat(d.inner))]);
  const pic = d.inLink && d.h <= 24 ? 'badge' : !d.inLink || d.h >= 32 ? 'avatar' : '';
  if (named) return photo && /^\d+$/.test(named) ? 'photo ' + photo[1] : avatar(named) && /\.(jpe?g|png|webp|gif)$/i.test(named) ? pic || named : named;
  if (photo) return 'photo ' + photo[1];
  if (d.tag === 'a' && d.href && path(d.href) !== '/') {
    return pick([tid(d.svgTestid), flat(d.svgTitle), handle, () => last(d.href)]);
  }
  const src = /^data:/i.test(flat(d.src)) ? '' : flat(d.src).split(/[?#]/)[0].split('/').pop() || '';
  const marked = pick([flat(d.svgTitle), tid(d.testid), tid(d.svgTestid)]);
  if (marked) return marked;
  if (src && d.video && /\.(jpe?g|png|webp|gif)$/i.test(src)) return 'video';
  if (avatar(src) && pic) return pic;
  return pick([human(src.replace(/\.\w{2,5}$/, '')), human(d.for), cls(d.classes)]);
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
      name: e.getAttribute('name'), id: e.id, for: e.getAttribute('for'),
      href: tg === 'a' ? e.getAttribute('href') : '',
      testid: e.getAttribute('data-testid') || (inner ? inner.getAttribute('data-testid') : ''),
      svgTestid: svg ? svg.getAttribute('data-testid') : '',
      svgTitle: st ? st.textContent : '',
      classes: e.getAttribute('class'),
      src: [e.getAttribute('src') || '', ...[...e.querySelectorAll('img[src]')].map(i => i.getAttribute('src'))].find(u => u && !/^data:/i.test(u)) || '',
      inner: btn ? (btn.tagName === 'INPUT' ? btn.value : btn.innerText) || btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.getAttribute('name') || '' : '',
      video: !!(e.closest('video,[data-testid*=video i]') || e.querySelector('video,[data-testid*=video i]')),
      h: e.getBoundingClientRect().height,
      inLink: !!e.closest('a[href] *'),
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

function clickPoint(el, r, doc) {
  const centre = (b) => ({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) });
  if (!(el.tagName.toLowerCase() === 'a' || el.getAttribute('role') === 'link') || r.height <= 120) return centre(r);
  const ta = [...el.querySelectorAll('time')].map((t) => t.closest('a')).find((a) => a && a !== el && el.contains(a));
  const within = (b) => { const c = centre(b); return b.width && b.height && c.x >= r.left && c.x <= r.right && c.y >= r.top && c.y <= r.bottom; };
  const tb = ta && ta.getBoundingClientRect();
  if (tb && within(tb)) return centre(tb);
  const walker = doc.createTreeWalker(el, 4);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!String(t.nodeValue || '').trim()) continue;
    const range = doc.createRange();
    range.selectNodeContents(t);
    const b = range.getBoundingClientRect();
    if (within(b)) return centre(b);
  }
  return centre(r);
}

function find(n) {
  return `(() => {${DEEP}
  ${REF(n)}
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  ${clickPoint.toString()}
  const at = clickPoint(el, r, document);
  ${KIND_LABEL}${CQ}${ROW}
  const textual = tag === 'textarea' || (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden'].includes(type));
  return {
    x: at.x, y: at.y, tag, type, kind, label,
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
  ${KIND_LABEL}${CQ}
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
    visible: vis(el), ancestors, html: clip(clone.outerHTML, 300), warn: cqHit(el),
  };
})()`;
}

const PAGE_TEXT = `(() => {
  if (!document.body) return '';
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,template,iframe,object,embed,video,audio,[aria-hidden=true],[inert]').forEach(n => n.remove());
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
  ${inputLine.toString()}
  if (!window.__cxEls || !window.__cxKeys) return { unstamped: true };
  const want = ${JSON.stringify(want)};${collect(false)}
  const stored = storedKeysOf(items.map(i => i.el));
  const keyed = new Map(items.map((it, i) => [it.el, stored[i]]));
  const fullOf = new Map(items.map(it => [it.el, String(it.full || '').toLowerCase()]));
  const plainOf = (el, t) => {
    for (let p = el; p; p = p.parentElement) if (keyed.has(p)) return rows.has(p) || fullOf.get(p) === t.toLowerCase() ? p : null;
    return null;
  };
  const TEXT_SKIP = new Set(['HTML', 'HEAD', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'OPTION', 'OPTGROUP', 'SELECT', 'TEXTAREA']);
  const BUTTONS = new Set(['button', 'submit', 'reset']);
  const own = el => {
    let t = el.tagName === 'INPUT' && BUTTONS.has(el.type) ? el.value || '' : '';
    for (const c of el.childNodes) if (c.nodeType === 3) t += c.nodeValue;
    return t.replace(/\\s+/g, ' ').trim();
  };
  const hits = deepAll(document, el => !TEXT_SKIP.has(el.tagName) && own(el).toLowerCase().includes(want)).filter(vis);
  const found = [];
  const loose = [];
  for (const el of hits) {
    const t = own(el);
    const ctl = el.matches(sel) ? el : el.closest(sel);
    if (ctl && !keyed.has(ctl)) continue;
    const c = ctl || plainOf(el, t);
    if (!c || !keyed.has(c)) { loose.push({ n: null, loose: true, text: t }); continue; }
    const have = found.find(x => x.el === c);
    if (have) { have.exact = have.exact || t.toLowerCase() === want; continue; }
    found.push({ el: c, text: t, exact: t.toLowerCase() === want });
  }
  const exact = found.filter(x => x.exact);
  const pick = exact.length ? exact : [...found, ...loose];
  const clipT = t => (t.length > 60 ? t.slice(0, 59) + '…' : t);
  return { count: pick.length, hits: pick.slice(0, 5).map(h => {
    if (h.loose) return { n: null, loose: true, text: clipT(h.text) };
    const s = keyed.get(h.el);
    const ref = known[s] != null && window.__cxEls[known[s]];
    const held = ref && ref.deref();
    if (held && held.isConnected && held !== h.el) return { n: null, text: clipT(h.text) };
    const n = place(h.el, s);
    return { n, fresh: n != null && fresh.includes(n), text: clipT(h.text) };
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
  const undrawn = [];
  for (const [k, ref] of Object.entries(window.__cxEls || {})) {
    const el = ref && ref.deref();
    if (!el || !el.isConnected) continue;
    const r = el.getBoundingClientRect();
    if (!(r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight)) continue;
    if (r.width <= 1 || r.height <= 1 || !vis(el) || el.closest('[aria-hidden="true"],[inert]')
      || el.matches(':disabled,[aria-disabled="true"]')) { undrawn.push(Number(k)); continue; }
    items.push({ k, el, r, huge: r.height > innerHeight || r.width > innerWidth });
  }
  const badgeRects = [];
  const legendText = undrawn.length ? 'not drawn: ' + undrawn.sort((a, b) => a - b).map(n => '[' + n + ']').join(' ') : '';
  if (legendText) badgeRects.push({ left: 0, top: innerHeight - 14, right: ${BADGE_CHAR_PX} * legendText.length + 4, bottom: innerHeight });
  const hits = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  const wordAt = (x, y) => {
    const c = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    const t = c && c.startContainer;
    if (!t || t.nodeType !== 3) return false;
    for (const i of [c.startOffset - 1, c.startOffset]) {
      if (i < 0 || i >= t.data.length || !/\\S/.test(t.data[i])) continue;
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
  const mediaIn = (q, el) => {
    const y = q.top + ${BADGE_H_PX} / 2;
    const w = q.right - q.left;
    return [q.left + w / 6, q.left + w / 2, q.right - w / 6].some(x => mediaAt(x, y, el));
  };
  const below = (q) => {
    for (let hit = badgeRects.find(o => hits(o, q)); hit; hit = badgeRects.find(o => hits(o, q))) {
      q = hit.bottom + 1 + ${BADGE_H_PX} > innerHeight
        ? { left: hit.right + 1, right: hit.right + 1 + q.right - q.left, top: Math.min(q.top, innerHeight - ${BADGE_H_PX}), bottom: Math.min(q.bottom, innerHeight) }
        : { left: q.left, right: q.right, top: hit.bottom + 1, bottom: hit.bottom + 1 + ${BADGE_H_PX} };
    }
    return q;
  };
  const mediaAt = (x, y, el) => {
    const e = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
    if (!e || e.nodeType !== 1) return false;
    if (e.closest('img,svg,canvas,video,picture')) return true;
    if (e.contains(el)) return false;
    return /url\\(/.test(String(getComputedStyle(e).backgroundImage || ''));
  };
  for (const { k, el, r, huge } of [...items.filter(i => !i.huge), ...items.filter(i => i.huge)]) {
    const b = document.createElement('span');
    b.textContent = k;
    const st = getComputedStyle(el);
    const lh = parseFloat(st.lineHeight) || (parseFloat(st.fontSize) || 15) * 1.2;
    const media = el.tagName === 'IMG' || !!el.querySelector('img,video,canvas');
    const bw = Math.ceil(k.length * ${BADGE_CHAR_PX}) + ${BADGE_PAD_PX};
    const slot = (left, top) => ({ left, top, right: left + bw, bottom: top + ${BADGE_H_PX} });
    let at = slot(r.left - ${BADGE_NUDGE_PX}, huge ? Math.max(r.top, 0) : r.top);
    if (!huge && !media && r.height <= 2 * lh + 2) {
      const rects = [...items.map(i => i.r).filter(o => o !== r && !(o.left <= r.left && o.right >= r.right && o.top <= r.top && o.bottom >= r.bottom)), ...badgeRects];
      const clash = q => q.left < 0 || q.top < 0 || q.right > innerWidth || q.bottom > innerHeight
        || rects.some(o => hits(o, q))
        || mediaIn(q, el);
      const blocked = q => clash(q) || textUnder(q.left, q.right, q.top + ${BADGE_H_PX} / 2);
      const right = () => {
        for (let d = 0; d <= bw; d += 2) if (!blocked(slot(r.right + 2 + d, r.top))) return slot(r.right + 2 + d, r.top);
        return null;
      };
      const tries = [slot(r.left - bw - 2, r.top), slot(r.left, Math.floor(r.top) - ${BADGE_H_PX}), slot(r.right + 2, r.top), slot(r.left, Math.ceil(r.bottom)), slot(r.left - bw / 2, r.top - ${BADGE_H_PX} - 1)];
      const under = slot(r.left, Math.ceil(r.bottom) + 1);
      at = tries.find(q => !blocked(q)) || right() || (clash(under) ? null : under) || slot(r.left, r.top);
    }
    at = below(at);
    const x = at.left;
    const y = at.top;
    if (!huge) badgeRects.push(at);
    b.style.cssText = 'position:fixed;font:bold 12px/14px monospace;color:#fff;padding:0 2px;border-radius:2px;border:1px solid #fff;z-index:2147483647'
      + (cqOf(el) ? ';background:#e00' : ';background:#111') + (huge ? ';opacity:.6' : '')
      + ';left:' + Math.max(0, Math.round(x)) + 'px;top:' + Math.max(0, Math.round(y)) + 'px';
    layer.appendChild(b);
    drawn += 1;
  }
  if (legendText) {
    const legend = document.createElement('span');
    legend.textContent = legendText;
    legend.style.cssText = 'position:fixed;left:0;bottom:0;font:bold 12px/14px monospace;color:#fff;background:#111;padding:0 2px;z-index:2147483647';
    layer.appendChild(legend);
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


function feedPosts(scope, cats, byEl, loc) {
  const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => { const t = flat(s); return t.length > n ? t.slice(0, n) : t; };
  const inside = (e, box) => !!box && (e === box || box.contains(e));
  const pathOf = (a) => {
    const h = a && a.getAttribute('href');
    if (!h) return null;
    try { return new URL(h, loc.href).pathname; } catch { return null; }
  };
  const numOf = (e) => (e && byEl.has(e) ? byEl.get(e) : null);
  const outer = (a) => !(a.parentElement && a.parentElement.closest('article'));
  const arts = [...scope.querySelectorAll('article')].filter(outer);
  const topOf = (e) => {
    let a = e.closest('article');
    while (a && !outer(a)) a = a.parentElement.closest('article');
    return a;
  };
  const fmtSecs = (s) => {
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return hh ? hh + ':' + String(mm).padStart(2, '0') + ':' + ss : mm + ':' + ss;
  };
  const durationOf = (l) => {
    for (const m of String(l || '').matchAll(/(?:(\d+) hours?\s*)?(?:(\d+) minutes?\s*)?(?:(\d+) seconds?)?/gi)) {
      if (m[1] || m[2] || m[3]) return fmtSecs(Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0));
    }
    return null;
  };
  const nearVideo = (img, art) => {
    let e = img.parentElement;
    for (let i = 0; e && e !== art && i < 4; i++, e = e.parentElement) if (e.querySelector('video')) return true;
    return false;
  };
  const statusPath = (p) => (p == null ? null : String(p).replace(/[?#].*$/, '').replace(/\/(?:analytics|history|(?:photo|video)\/\d+)\/?$/, ''));
  const statusId = (p) => { const m = /\/status\/(\d+)/.exec(p || ''); return m ? m[1] : null; };
  const plain = (e) => !/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(e.tagName) && !/^(button|link|tab|menuitem|checkbox|combobox)$/.test(e.getAttribute('role') || '');
  const wrapperNum = (box, up) => {
    if (numOf(box) != null) return numOf(box);
    let best = null;
    for (const [e, n] of byEl) if (e !== box && inside(e, box) && plain(e) && (best == null || n < best)) best = n;
    if (best != null || !up) return best;
    for (let e = box.parentElement; e; e = e.parentElement) {
      if (arts.some((o) => o !== box && e.contains(o))) return null;
      if (numOf(e) != null && plain(e)) return numOf(e);
    }
    return null;
  };
  const common = (x, y) => { for (let e = x; e; e = e.parentElement) if (e.contains(y)) return e; return null; };
  const depth = (e) => { let d = 0; for (; e; e = e.parentElement) d++; return d; };
  const ownText = (e) => flat([...(e.childNodes || [])].filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join(''));
  const find = (root, fn) => {
    for (const c of root.children) {
      if (fn(c)) return c;
      const r = find(c, fn);
      if (r) return r;
    }
    return null;
  };
  const nameNear = (el, art) => {
    for (let e = el, i = 0; e && e !== art && i < 3; e = e.parentElement, i++) {
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) {
        const t = flat(s.innerText);
        if (t) return s;
      }
    }
    return null;
  };
  const host = (h) => {
    try {
      const u = new URL(h, loc.href);
      return u.origin !== loc.origin ? u.hostname.replace(/^www\./, '') : null;
    } catch { return null; }
  };
  const HOST_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i;
  const LABEL_RE = /^(parody|fan|commentary) account$/i;
  const FROM_RE = new RegExp('^from\\s+(' + HOST_RE.source + ')', 'i');
  const SHORT_HOSTS = new Set(['t.co', 'bit.ly', 'lnkd.in', 'buff.ly']);
  const overlap = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  };
  const mediaOf = (box, keep, authorPath) => {
    const vids = [...box.querySelectorAll('video')].filter(keep);
    const videos = vids.length;
    const secs = vids.map((v) => Math.round(Number(v.duration))).find((d) => Number.isFinite(d) && d > 0);
    let duration = secs ? fmtSecs(secs) : null;
    for (const e of box.querySelectorAll('[aria-label]')) {
      if (!videos || duration || !keep(e) || e.closest('time') || e.querySelector('time')) continue;
      duration = durationOf(e.getAttribute('aria-label'));
    }
    const vrects = vids.map((v) => v.getBoundingClientRect());
    const photos = [...box.querySelectorAll('img')].filter((img) => {
      if (!keep(img)) return false;
      const r = img.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) return false;
      if (vrects.some((v) => overlap(r, v) >= 0.5 * r.width * r.height)) return false;
      const a = img.closest('a');
      if (a && host(a.getAttribute('href'))) return false;
      const p = pathOf(a);
      return !(authorPath && p && p.toLowerCase() === authorPath) && !nearVideo(img, box);
    }).length;
    return { videos, duration, photos };
  };
  const post = (art) => {
    const times = [...art.querySelectorAll('time')];
    const isHandle = (a) => {
      const m = /^\/@?([\w.-]+)\/?$/.exec(pathOf(a) || '');
      const t = flat(a.innerText).toLowerCase();
      return !!m && (t === '@' + m[1].toLowerCase() || t.startsWith('@' + m[1].toLowerCase() + '@'));
    };
    const hl0 = [...art.querySelectorAll('a[href]')].find(isHandle) || null;
    const ownStatus = hl0 ? pathOf(hl0).replace(/\/$/, '').toLowerCase() + '/status/' : null;
    const linked = times.map((t) => t.closest('a')).filter((a) => a && inside(a, art));
    const ownTimes = ownStatus ? linked.filter((a) => (statusPath(pathOf(a)) || '').toLowerCase().startsWith(ownStatus)) : [];
    const inCard = (a) => { const c = a.parentElement && a.parentElement.closest('[role=link]'); return !!c && c !== art && art.contains(c); };
    const timeA = ownTimes.find((a) => !inCard(a)) || ownTimes[ownTimes.length - 1] || linked[0] || null;
    const links = [...art.querySelectorAll('a[href*="/status/"]')];
    const clean = links.find((a) => { const p = pathOf(a); return p && statusPath(p) === p; }) || null;
    const pl = timeA || clean;
    const time = (timeA && timeA.querySelector('time')) || times[0] || null;
    const qt = times.find((t) => t !== time && !(pl && pl.contains(t)));
    let qbox = null;
    if (qt && time) {
      qbox = qt;
      while (qbox.parentElement && qbox.parentElement !== art && !qbox.parentElement.contains(time)) qbox = qbox.parentElement;
      let cardBox = null;
      for (let e = qt; e && inside(e, qbox); e = e.parentElement) if (e.getAttribute('role') === 'link') cardBox = e;
      if (cardBox) qbox = cardBox;
    }
    const own = (e) => !inside(e, qbox);
    const ownA = [...art.querySelectorAll('a[href]')].filter(own);
    const path = statusPath(pl ? pathOf(pl) : links.length ? pathOf(links[0]) : null);
    const qLines = new Set(qbox ? String(qbox.innerText || '').split('\n').map(flat).filter(Boolean) : []);
    const ownLines = String(art.innerText || '').split('\n').map(flat).filter((l) => l && !qLines.has(l));
    const isAd = ownLines.some((l) => /^(ad|promoted|sponsored)$/i.test(l));
    const n = isAd ? ((pl ? numOf(pl) : null) ?? (path == null ? null : ownA.map((a) => (pathOf(a) === path ? numOf(a) : null)).find((x) => x != null) ?? null))
      : pl ? numOf(pl) : wrapperNum(art, true);
    const hl = ownA.find(isHandle);
    let handleEl = hl || null;
    let nameEl = null;
    let handle = null;
    let authorLinks = [];
    if (hl) {
      handle = flat(hl.innerText).slice(1);
      const hp = pathOf(hl).toLowerCase();
      authorLinks = ownA.filter((a) => (pathOf(a) || '').toLowerCase() === hp);
      nameEl = authorLinks.filter((a) => a !== hl && flat(a.innerText) && flat(a.innerText) !== flat(hl.innerText))
        .reduce((b, a) => (!b || depth(common(a, hl)) > depth(common(b, hl)) ? a : b), null);
    } else {
      handleEl = find(art, (e) => own(e) && /^@[\w.-]+(?:@[\w.-]+)?$/.test(ownText(e)));
      if (handleEl) handle = ownText(handleEl).slice(1);
    }
    if (handleEl && !nameEl) nameEl = nameNear(handleEl, art);
    const name = nameEl ? clip(nameEl.innerText, 40).replace(/[\s·]+$/, '') || null : null;
    let row = handleEl ? (nameEl ? common(handleEl, nameEl) : handleEl.parentElement) : null;
    if (row === art || (row && !inside(row, art))) row = null;
    const verified = [...authorLinks, ...(row ? [row] : [])]
      .some((e) => [...e.querySelectorAll('svg[aria-label]')].some((s) => /verified/i.test(s.getAttribute('aria-label'))));
    let above = '';
    if (row) {
      const range = document.createRange();
      range.setStart(art, 0);
      range.setEndBefore(row);
      above = flat(range.toString());
    }
    const flags = {};
    if (isAd) flags.ad = true;
    const rp = /^(.*?)\s*\b(?:reposted|retweeted)\b/i.exec(above);
    const rpBy = rp ? (/@\w+/.exec(rp[1]) || [flat(rp[1])])[0] : null;
    if (rp) flags.repostedBy = rpBy || true;
    if (/pinned/i.test(above)) flags.pinned = true;
    if (ownA.some((a) => LABEL_RE.test(flat(a.innerText)))) flags.parody = true;
    const rt = ownLines.map((l) => /^replying to (@\S+)/i.exec(l)).find(Boolean);
    if (rt) flags.replyTo = rt[1];
    let body = [...art.querySelectorAll('[lang]')].find(own);
    if (!body) {
      const head = row ? String(row.innerText || '').split('\n').map(flat).filter(Boolean)[0] || '' : '';
      const described = new Set([...art.querySelectorAll('[aria-describedby]')].flatMap((e) => e.getAttribute('aria-describedby').split(/\s+/)).filter(Boolean));
      const isDescribed = (e) => described.has(e.getAttribute('id')) || [...e.querySelectorAll('[id]')].some((x) => described.has(x.getAttribute('id')));
      body = [...art.querySelectorAll('p,div')]
        .filter((e) => own(e) && !(head && String(e.innerText || '').includes(head))
          && !(row && (inside(e, row) || e.contains(row))) && ![handleEl, nameEl, time].some((x) => x && e.contains(x))
          && !e.closest('button,[role=button],[role=group]') && !e.querySelector('button,[role=button],[role=group]')
          && !isDescribed(e) && !/^[\d.,\s]*[KkMm]?(\s+[\d.,]+[KkMm]?)*$/.test(flat(e.innerText)) && !/^[\s\p{P}]*$/u.test(flat(e.innerText)))
        .reduce((b, e) => (!b || flat(e.innerText).length > flat(b.innerText).length ? e : b), null);
    }
    const moreEl = [...art.querySelectorAll('button,[role=button]')]
      .find((e) => own(e) && (/^(show|see) more$/i.test(flat(e.innerText)) || /^(show|see) more$/i.test(flat(e.getAttribute('aria-label')))));
    const counts = [];
    const seen = new Set();
    for (const e of art.querySelectorAll('button,a,[role=button]')) {
      if (!own(e) || e === pl || e.querySelector('time')) continue;
      const hit = /^([\d.,]+[KkMm]?)\s+([A-Za-z]+)/.exec(flat(e.getAttribute('aria-label'))) || /^([\d.,]+[KkMm]?)\s*(views?)$/i.exec(flat(e.innerText));
      if (!hit) continue;
      const word = hit[2].toLowerCase();
      if (seen.has(word) || /^(seconds?|minutes?|hours?|days?|weeks?|months?|years?)$/.test(word)) continue;
      seen.add(word);
      counts.push({ num: hit[1], word });
    }
    const media = mediaOf(art, own, handle ? '/' + handle.toLowerCase() : null);
    const cardAs = ownA.filter((a) => host(a.getAttribute('href')) && !LABEL_RE.test(flat(a.innerText)) && !inside(a, body));
    const tokOf = (s) => { const m = HOST_RE.exec(flat(s)); return m ? m[0].toLowerCase().replace(/^www\./, '') : null; };
    const fromA = cardAs.map((a) => FROM_RE.exec(flat(a.innerText))).find(Boolean);
    const bigA = cardAs.find((a) => !SHORT_HOSTS.has(host(a.getAttribute('href')))
      && [...a.querySelectorAll('img')].some((img) => { const r = img.getBoundingClientRect(); return r.width >= 100 && r.height >= 100; }));
    media.card = (fromA && tokOf(fromA[1]))
      || cardAs.map((a) => tokOf(a.innerText) || tokOf(a.getAttribute('aria-label'))).find(Boolean)
      || (bigA ? host(bigA.getAttribute('href')) : null);
    let quote = null;
    if (qbox) {
      const pid = statusId(path);
      const nested = [...qbox.querySelectorAll('[role=link]')].filter((e) => !e.contains(qt));
      const qas = [...qbox.querySelectorAll('a[href*="/status/"]')].filter((a) => { const id = statusId(pathOf(a)); return id && id !== pid && !nested.some((e) => e.contains(a)); });
      const suffixed = (a) => { const p = pathOf(a); return !!p && statusPath(p) !== p; };
      const qa = qas.find((a) => a.contains(qt)) || qas.find((a) => !suffixed(a)) || null;
      let cardEl = null;
      for (let e = qt; e && inside(e, qbox); e = e.parentElement) if (e.getAttribute('role') === 'link' && numOf(e) != null) cardEl = e;
      const qm = /@(\w+)/.exec(String(qbox.innerText || ''));
      const qPre = qm ? '/' + qm[1].toLowerCase() + '/status/' : null;
      const qpa = [qa, ...qas].find((a) => a && (!qPre || (statusPath(pathOf(a)) || '').toLowerCase().startsWith(qPre))) || null;
      const ql = qbox.querySelector('[lang]');
      const byHandle = qm ? [...qbox.querySelectorAll('a')].find((a) => numOf(a) != null && !suffixed(a) && flat(a.innerText).includes('@' + qm[1])) : null;
      quote = {
        n: (qa && numOf(qa)) ?? numOf(cardEl) ?? wrapperNum(qbox, false) ?? numOf(byHandle), handle: qm ? qm[1] : null, rel: flat(qt.innerText) || null,
        text: clip(joinUrls(ql ? ql.innerText : ''), 160), path: qpa ? statusPath(pathOf(qpa)) : null,
        media: mediaOf(qbox, () => true, null),
      };
      const qtl = String(qbox.innerText || '').split('\n').map(flat).filter(Boolean);
      const titleOf = (t) => clip(t, 160).trimEnd();
      const label = flat((cardEl || qbox).getAttribute('aria-label'));
      if (/\bArticle\b/.test(label)) {
        const at = quote.rel ? qtl.indexOf(quote.rel) : -1;
        const hi = quote.handle ? qtl.indexOf('@' + quote.handle) : -1;
        const skip = new Set(['Quote', '·', ...(hi >= 0 ? [qtl[hi], qtl[hi - 1]] : [])]);
        const title = (at >= 0 && qtl.slice(at + 1).find((l) => !skip.has(l))) || (/\bArticle\s+(.+)$/.exec(label) || [])[1];
        if (title) quote.article = titleOf(title);
      }
      for (let i = 0; i < qtl.length && !quote.article; i++) {
        const am = /^article(?:\s+(.+))?$/i.exec(qtl[i]);
        const title = am && (am[1] || qtl[i + 1]);
        if (title) quote.article = titleOf(title);
      }
    }
    return {
      n, path, handle, name, verified,
      time: time ? { rel: flat(time.innerText) || null, iso: time.getAttribute('datetime') || null } : null,
      text: body ? clip(joinUrls(body.innerText), 260) : '', more: numOf(moreEl), counts,
      media, flags, quote,
    };
  };
  const set = new Set(arts);
  const numbers = [];
  for (const [e, n] of byEl) if (set.has(topOf(e))) numbers.push(n);
  numbers.sort((a, b) => a - b);
  const folded = {};
  for (const n of numbers) if (cats[n]) folded[cats[n]] = (folded[cats[n]] || 0) + 1;
  return { posts: arts.map(post), numbers, folded };
}

function feed(main, cats) {
  return `(() => {
  ${joinUrls.toString()}
  ${feedPosts.toString()}
  const byEl = new Map();
  for (const [k, ref] of Object.entries(window.__cxEls || {})) { const e = ref && ref.deref(); if (e) byEl.set(e, Number(k)); }
  const scope = ${main ? `document.querySelector('main, [role=main]') || document` : 'document'};
  return feedPosts(scope, ${JSON.stringify(cats || {})}, byEl, location);
})()`;
}

const CONTENT_TYPE = 'document.contentType';

module.exports = {
  ISOLATED_WORLD, TEXT_MAX, BOX_SEL, CHROME_SEL, CHROME_MARK, ELEMENTS_MAX, VALUE_MAX, OVERLAY_ID, OVERLAY, OVERLAY_OFF, LOGIN_PROBE, CONTENT_TYPE, READ_ROOT_SEL, SCROLL_INFO, POINTER_SCAN_MAX, PAGE_TEXT, DEEP,
  READ_TEXT: readText, INSPECT: inspect, READ_INTERACTIVE: readInteractive, FEED: feed, CHECK: check, numbering, FIND: find, FIND_TEXT: findText, CLEAR: clear, SELECT: select, VALUE: value,
  TARGET_STATE: targetState, TILE_SEL, STATE_ATTRS, CONSEQUENTIAL, SIGN_OUT, consequentialOf, consequentialHit, clickPoint, signOutOf, labelFrom, distinctClips, inputLine, bulletItems,
};
