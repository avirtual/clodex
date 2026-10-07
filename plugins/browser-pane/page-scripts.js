'use strict';

const keys = require('./keys');

const ISOLATED_WORLD = 4242;
const TEXT_MAX = 400000;
const BUSY_SEL = '[aria-busy=true], [role=progressbar], .loading, .spinner, [class*=loading i], [class*=spinner i], [id*=loading i]';
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
const SIDE_SEL = 'aside, [role=complementary], [aria-label*="Trending" i], [aria-label*="Who to follow" i]';
const MAIN_ROOT = `
  const mainRootOf = () => {
    const outerArts = r => [...r.querySelectorAll('article')].filter(a => !(a.parentElement && a.parentElement.closest('article')));
    const body = document.body;
    const root = document.querySelector('main, [role=main]')
      || (body && outerArts(body).length > 1 ? body : document.querySelector(${JSON.stringify(MAIN_SEL)}));
    if (!root) return null;
    const arts = outerArts(root);
    if (arts.length < 2) return root;
    let lca = arts[0];
    while (lca !== root && !arts.every(a => lca.contains(a))) lca = lca.parentElement;
    const outside = (p, n, sel) => [...p.querySelectorAll(sel)].some(e => !n.contains(e));
    while (lca !== root && lca.parentElement) {
      const p = lca.parentElement;
      if (outside(p, lca, ${JSON.stringify(SIDE_SEL)})) break;
      lca = p;
    }
    return lca;
  };
`;

const SIGN_OUT = ['sign out', 'log out', 'logout', 'iesire', 'deconectare', 'abmelden', 'deconnexion', 'cerrar sesion', 'uitloggen', 'esci', 'sair'];
const CONSEQUENTIAL = [
  ['payment', ['pay', 'pay now', 'checkout', 'confirm payment', 'plateste', 'platiti', 'achita'], ['payment', 'payments', 'plata', 'plati', 'platire', 'card']],
  ['purchase', ['purchase', 'buy', 'cumpara', 'order', 'comanda'], [], [], {}, '\\border (status|history|number|tracking|details|istoric)\\b|\\b(sort|display|view) order\\b|\\border (by|of)\\b'],
  ['booking', ['reserve', "i'll reserve", 'book now', 'complete booking', 'confirm booking', 'rezerva', 'rezerva acum', 'finalizeaza rezervarea'], []],
  ['deletion', ['delete', 'sterge', 'remove', 'elimina'], [], [], {}, '\\b(filtr|filter|selection|selectie|search|cautare|sort)'],
  ['sign-out', SIGN_OUT, []],
  ['alarm', ['arm', 'disarm'], []],
  ['unsubscribe', ['unsubscribe', 'dezabonare', 'cancel subscription'], []],
  ['transfer', ['transfer', 'send money', 'wire', 'deposit', 'add funds', 'withdraw', 'withdrawal', 'fund', 'top up', 'depune', 'retrage', 'create wallet'], [], [],
    { transfer: '(^|[^a-z0-9])(money|funds|bani|balance|amount|lei|eur|usd)(?![a-z0-9])|[€$]', depune: '(^|[^a-z0-9])(bani|lei|eur|ron|euro|numerar|suma|sold|fonduri|money|funds)(?![a-z0-9])|[€$]' }],
  ['trading', ['trade', 'sell', 'close position', 'close all', 'close trade', 'invest', 'copy trader', 'stake', 'unstake', 'swap', 'vinde', 'tranzactioneaza'], [],
    ['copy-user', 'copytrader', 'copy-trader', 'btn-copy-user', 'close-position', 'close-all-positions'],
    { swap: '(^|[^a-z0-9])(tokens?|coins?|crypto|currency|currencies|assets?|eth|btc|usdt)(?![a-z0-9])' }],
  ['publish', ['post', 'reply', 'forward', 'repost', 'retweet', 'quote', 'like', 'unlike', 'follow', 'unfollow', 'follow back', 'send', 'send via direct message', 'send message', 'comment', 'publish', 'tweet',
    'submit review', 'posteaza', 'trimite', 'trimite mesaj', 'urmareste', 'apreciaza'], [], ['like', 'likes', 'social-likes', 'icon-like'], {}, '\\b(post|edit) history\\b|^\\d+ (likes?|reactions?)$|\\bliked by\\b|\\bwho liked\\b'],
];
const LEAD_CATS = ['publish'];
const ID_TERMS = ['pay', 'checkout', 'purchase', 'buy', 'delete', 'remove', 'sign out', 'log out', 'unsubscribe', 'arm', 'disarm', 'reserve'];
const FORM_ACTIONS = [['payment', 'pay'], ['payment', 'checkout'], ['purchase', 'order'], ['deletion', 'delete'], ['booking', 'book']];
const CQ_LABEL_MAX = 40;
const CQ_CONTROL_MAX = 100;
const CQ_STATE_SUFFIX = keys.STATE_SUFFIX;
const HMS_RE = `/${keys.HMS_RE.source}/g`;

function termRe(t, lead) {
  const body = t.split(' ').join('[\\s_-]?');
  return lead ? new RegExp('(^|\\. )' + body + '(?![a-z0-9-])') : new RegExp('(^|[^a-z0-9])' + body + '(?![a-z0-9])');
}

function cqCompile(table, idTerms, leadCats = []) {
  const out = [];
  for (const [cat, verbs, nouns, idOnly = [], withs = {}, unless = null] of table) {
    for (const t of verbs) {
      out.push({ cat, t, id: idTerms.includes(t), noun: false, lead: leadCats.includes(cat), re: termRe(t, leadCats.includes(cat)), with: withs[t] ? new RegExp(withs[t]) : null, unless: unless ? new RegExp(unless) : null });
    }
    for (const t of nouns) out.push({ cat, t, id: false, noun: true, re: termRe(t) });
    for (const t of idOnly) out.push({ cat, t, id: true, idOnly: true, noun: false, lead: false, re: termRe(t), unless: unless ? new RegExp(unless) : null });
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
  const text = (x) => { const f = fold(x); return f.length > (d.capped ? CQ_LABEL_MAX : CQ_CONTROL_MAX) ? '' : f; };
  const bare = (x) => text(x).replace(CQ_STATE_SUFFIX, '');
  const hay = [bare(d.label), text(d.value), bare(d.aria)].filter(Boolean);
  const fa = fold(d.formaction);
  const idClass = fold(d.idClass);
  let lead = null;
  for (const r of res) {
    if (r.noun && !d.control) continue;
    if (lead && r.lead) continue;
    if (r.cat === 'deletion' && d.clearer) continue;
    if (r.cat === 'deletion' && d.chip && /^(remove|clear|reset)\b/.test(hay[0] || '')) continue;
    const inText = (h) => r.re.test(h) && (!r.with || r.with.test(h)) && (!r.unless || !r.unless.test(h));
    const byText = !r.idOnly && (hay.some(inText) || (!r.lead && !!fa && r.re.test(fa)));
    if (!(byText || (r.id && idClass && r.re.test(idClass) && !(r.unless && hay.some(h => r.unless.test(h)))))) continue;
    if (!r.lead) return { cat: r.cat, term: r.t };
    lead = { cat: r.cat, term: r.t };
  }
  const actionPath = (a) => { try { return new URL(a, 'http://x/').pathname; } catch { return String(a || '').split(/[?#]/)[0]; } };
  const action = d.action ? fold(actionPath(d.action)) : '';
  if (action) for (const [cat, w] of FORM_ACTIONS) if (new RegExp('(^|[^a-z0-9])' + w + '(s|ing|ment)?(?![a-z0-9])').test(action)) return { cat, term: w };
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
  const CQ_CONTROL_MAX = ${CQ_CONTROL_MAX};
  const CQ_STATE_SUFFIX = new RegExp(${JSON.stringify(keys.STATE_SUFFIX.source)}, 'i');
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
      clearer: button && tg !== 'input' && !String(e.innerText || '').replace(/[×✕✖⨯x\\s]/gi, '') && !!(e.parentElement && (e.parentElement.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),[role=combobox],[contenteditable=true]') || (e.parentElement.parentElement && e.parentElement.parentElement.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),[role=combobox]')))),
      chip: !!e.closest('[role=search], form[role=search], [class*="filter"], [class*="chip"], [class*="token"], [aria-label*="filter" i], [aria-label*="search" i]'),
      control: button && !doc && (!!(form || e.closest('form')) || e.hasAttribute('formaction')),
      capped: tg === 'a' || e.getAttribute('role') === 'link' || !e.matches(${JSON.stringify(STD_SEL)}),
      label: (e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('aria-label') || e.innerText || e.getAttribute('title') || '',
      value: tg === 'input' && ty !== 'password' ? e.value : '',
      aria: e.getAttribute('aria-label'),
      idClass: [e.id, e.getAttribute('class'), e.getAttribute('data-automation-id'), e.getAttribute('data-testid'), e.getAttribute('data-test')].filter(Boolean).join(' '),
      formaction: e.getAttribute('formaction'),
      action: submit && (e.hasAttribute('formaction') || !(form && String(form.getAttribute('method') || '').toLowerCase() === 'get')) ? e.getAttribute('formaction') || (form ? form.getAttribute('action') : '') : '',
    };
  };
  const adLines = new Map();
  const adArts = [];
  const outerArticle = e => {
    let art = null;
    for (let a = e.closest ? e.closest('article') : null; a; a = a.parentElement ? a.parentElement.closest('article') : null) art = a;
    return art;
  };
  const adArticle = art => {
    if (!adLines.has(art)) {
      const linesOf = n => String(n.innerText || '').split('\\n').map(l => l.replace(/\\s+/g, ' ').trim());
      const quoted = new Set([...art.querySelectorAll('[role=link]')].flatMap(linesOf));
      adLines.set(art, linesOf(art).find(l => !quoted.has(l) && /^(ad|promoted|sponsored)$/i.test(l)) || null);
    }
    return adLines.get(art);
  };
  const cqHit = e => {
    const d = cqInputs(e);
    const statusLink = e.tagName.toLowerCase() === 'a' && /\\/status\\//.test(String(e.getAttribute('href') || '').split(/[?#]/)[0]);
    const art = d.button || d.textual || statusLink ? null : outerArticle(e);
    const ad = art ? adArticle(art) : null;
    if (ad) return { cat: 'ad', term: ad };
    const inner = d.button || d.textual ? [] : e.querySelectorAll(CQ_INNER);
    return consequentialHit(d, CQ_RES) || (inner.length === 1 && !vis(inner[0]) ? cqHit(inner[0]) : null);
  };
  const adKeyOf = e => {
    const art = outerArticle(e);
    if (!art || !adArticle(art)) return null;
    if (!adArts.includes(art)) adArts.push(art);
    return adArts.indexOf(art);
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
  const clipOf = (el) => {
    const sc = scrollerOf(upOf(el));
    return sc && sc !== FIXED ? { sc, rect: sc.getBoundingClientRect() } : null;
  };
  const outOf = (r, c) => r.top < c.top || r.bottom > c.bottom || r.left < c.left || r.right > c.right;
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
  const fadedMemo = new Map(); const faded = (el) => { let k = 0; const seen = []; for (let e = upOf(el); e && e !== document.body && k < 12; e = upOf(e), k++) { if (fadedMemo.has(e)) { const v = fadedMemo.get(e); for (const x of seen) fadedMemo.set(x, v); return v; } seen.push(e); if (getComputedStyle(e).opacity === '0') { for (const x of seen) fadedMemo.set(x, true); return true; } } for (const x of seen) fadedMemo.set(x, false); return false; };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    if (s.opacity === '0') return false;
    if (faded(el)) return false;
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
const WALL_RE = /\b(create (a free )?account to (read|continue)|sign (in|up) to (read|continue)|subscribe to (read|continue)|continue reading|read the full (story|article)|this article is for subscribers|already a subscriber|start a free trial|pentru a citi (mai departe|articolul)|abonează-te)\b/i;
const WALL_WEAK_RE = /\bmembers?-only story\b/i;
const WALL_SEL = '[class*=paywall i],[class*=meter i],[class*=regwall i],[class*=gate i],[class*=piano- i],[class*=tp-modal i]';
const WALL_ID_SEL = '[id*=paywall i],[id*=regwall i],[id*=gate-toast i],[data-testid*=paywall i]';
const WALL_TOKEN_RE = /^(paywall|regwall|piano-.*|tp-modal|meter(ed)?-?(gate|wall|modal|content)?|gate-toast|article-gate)$/i;
const WALL_SKIP = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'];
const WALL_BLOCK = 'p,div,section,li,h1,h2,h3,h4,h5,h6,[role=alert]';
const WALL = `
  const wallScan = (root) => {
    const WALL = ${WALL_RE};
    const WEAK = ${WALL_WEAK_RE};
    const TOKEN = ${WALL_TOKEN_RE};
    const SKIP = new Set(${JSON.stringify(WALL_SKIP)});
    const clip = t => String(t || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    const norm = s => String(s || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ');
    const scripted = t => { for (let e = t.parentElement; e; e = e.parentElement) if (SKIP.has(e.tagName)) return true; return false; };
    const textsOf = (n, out) => { for (const c of n.childNodes) { if (c.nodeType === 3) out.push(c); else if (c.nodeType === 1 && !SKIP.has(c.tagName)) { textsOf(c, out); if (c.shadowRoot) textsOf(c.shadowRoot, out); } } return out; };
    const inside = (r, t) => { for (let n = t; n; n = n.parentNode || n.host) if (n === r) return true; return false; };
    const sentence = (s, re) => { const segs = norm(s).split(/(?<=[.!?])\\s+|\\s*\\|\\s*/).map(x => x.trim()).filter(Boolean); const hits = segs.filter(x => re.test(x)); return clip(hits.length ? hits.sort((a, b) => b.split(' ').length - a.split(' ').length)[0] : s.replace(/^\\s*\\|\\s*|\\s*\\|\\s*$/g, '')); };
    const blockOf = t => (t.parentElement && t.parentElement.closest(${JSON.stringify(WALL_BLOCK)})) || null;
    const blockTexts = new Map();
    const blockText = b => {
      if (!b) return '';
      if (!blockTexts.has(b)) { const bt = norm(b.innerText).trim(); blockTexts.set(b, bt.length <= 300 ? bt : ''); }
      return blockTexts.get(b);
    };
    const authored = b => {
      const it = norm(b.innerText).trim();
      const zip = tc => {
        let j = 0;
        let over = false;
        const out = [...it].map(ch => {
          if (/\\s/.test(ch)) return ch;
          while (j < tc.length && tc[j].toLowerCase() !== ch.toLowerCase()) j++;
          if (j >= tc.length) { over = true; return ch; }
          return tc[j++];
        }).join('');
        return over ? null : out;
      };
      const tc = norm(textsOf(b, []).filter(t => t.parentElement && vis(t.parentElement) && !scripted(t) && (r => r.width > 2 && r.height > 2)(t.parentElement.getBoundingClientRect())).map(t => t.data).join(' '));
      const tc2 = norm(textsOf(b, []).filter(t => !scripted(t)).map(t => t.data).join(' '));
      return zip(tc) || zip(tc2) || it;
    };
    const quote = (s, el, re) => {
      if (norm(s).trim().length >= 20) return sentence(s, re);
      const blk = el && el.closest(${JSON.stringify(WALL_BLOCK)});
      return blockText(blk) ? clip(authored(blk)) : sentence(s, re);
    };
    const boxVis = e => { const bw = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); let k = 0; for (let t = bw.nextNode(); t && k < 400; t = bw.nextNode(), k++) if (t.data.trim() && !scripted(t) && vis(t.parentElement)) return true; return false; };
    const chrome = t => { const p = t.parentElement; const h = p && p.closest('header,nav,[role=banner],[role=navigation]'); return !!h && !h.closest('article,main,[role=main]'); };
    const wholeLabel = t => { const a = t.parentElement && t.parentElement.closest('a,button,[role=button]'); if (!a) return false; const icon = s => s.trim().length <= 2 && !/[\\p{L}\\p{N}]/u.test(s); return norm([...a.childNodes].map(n => n.nodeType === 3 ? n.data : (n.innerText || '')).filter(s => !icon(s)).join(' ')).trim() === norm(t.data).trim(); };
    const floating = t => { let k = 0; for (let e = t.parentElement; e && k < 6; e = e.parentElement, k++) if (['fixed', 'sticky'].includes(getComputedStyle(e).position)) return true; return false; };
    const gated = (b, bt, re) => {
      const labels = [...b.querySelectorAll('a,button,[role=button]')].map(a => norm(a.innerText).trim()).filter(l => l && re.test(l));
      let rest = norm(bt);
      for (const l of labels) rest = rest.replace(l, ' ');
      return re.test(rest) || (/\\b(sign in|log in|subscribe)\\b/i.test(rest) && labels.some(l => /\\b(start a free trial|create (a free )?account)\\b/i.test(l)));
    };
    const teaser = b => { for (let e = b, k = 0; e && k < 4; e = e.parentElement, k++) { const p = e.previousElementSibling; if (p) return norm(p.innerText || '').trim().length >= 80; } return false; };
    const GATE_LINK = /\\b(subscribe|sign (in|up)|log in|create (a free )?account|already a subscriber|abonează-te|pentru a citi)\\b/i;
    const truncates = (b) => { const r = (document.querySelector(${JSON.stringify(READ_ROOT_SEL)}) || document.body); let i = -1; for (const x of textsOf(b, [])) { const k = all.indexOf(x); if (k > i) i = k; } const after = all.slice(i + 1).filter(t => inside(r, t) && !floating(t) && !chrome(t)); let n = 0; for (const t of after) { n += norm(t.data).trim().length; if (n >= 80) return false; } return true; };
    const moreLink = (t) => { const a = t.parentElement && t.parentElement.closest('a'); return !!a && (a.matches('.more-link,[rel=bookmark]') || /\\bmore-link\\b/.test(a.className)); };
    let all = [];
    let endIdx = -1;
    const hitOf = (t, re) => {
      if (chrome(t)) return null;
      const b = blockOf(t);
      const own = norm(t.data);
      if (re.test(own)) {
        if (!wholeLabel(t) && !moreLink(t) || floating(t)) return { text: quote(t.data, t.parentElement, re), b };
      }
      const bt = blockText(b);
      if (!bt) return null;
      if (re.test(own) && bt === own.trim() && wholeLabel(t) && teaser(b) && GATE_LINK.test(own) && !moreLink(t) && truncates(b)) return { text: quote(t.data, t.parentElement, re), b };
      return gated(b, bt, re) ? { text: quote(authored(b), b, re), b } : null;
    };
    const pick = (re) => {
      let before = null;
      const seen = new Set();
      for (let i = 0; i < all.length; i++) {
        const b = blockOf(all[i]);
        if (b && seen.has(b)) continue;
        const hit = hitOf(all[i], re);
        if (!hit) continue;
        if (hit.b) seen.add(hit.b);
        if (i > endIdx) return { text: hit.text, n: null };
        before = hit;
      }
      return before ? { text: before.text, n: null } : null;
    };
    try {
      if (root && document.body) {
        all = textsOf(document.body, []).filter(t => t.data.trim() && t.parentElement && vis(t.parentElement));
        const inRoot = all.filter(t => inside(root, t));
        endIdx = inRoot.length ? all.lastIndexOf(inRoot[inRoot.length - 1]) : -1;
      }
      const strong = pick(WALL);
      if (strong) return strong;
      const ID_SEL = ${JSON.stringify(WALL_ID_SEL)};
      const box = [...document.querySelectorAll(${JSON.stringify(WALL_SEL)} + ',' + ID_SEL)].find(e => e !== document.body && e !== document.documentElement
        && (e.matches(ID_SEL) || [...e.classList].some(c => TOKEN.test(c))) && (vis(e) || boxVis(e)) && clip(e.innerText)
        && (WALL.test(e.innerText) || String(e.innerText).trim().length <= 300));
      if (box) {
        for (const t of textsOf(box, [])) if (WALL.test(norm(t.data)) && t.parentElement && vis(t.parentElement)) return { text: quote(t.data, t.parentElement, WALL), n: null };
        return { text: clip(box.innerText), n: null };
      }
      return pick(WEAK);
    } catch (e) { return { text: null, error: String(e && e.message || e).slice(0, 80) }; }
  };`;

const SCROLL_INFO = `(() => {
  const root = document.querySelector(${JSON.stringify(READ_ROOT_SEL)}) || document.body;
  const count = (el, sel) => (el ? el.querySelectorAll(sel).length : 0);
  const rowsOf = (c) => [...c.children].filter(k => k.matches('li,tr')).length;
  const best = Math.max(0, ...[...root.querySelectorAll('ul,ol,tbody,table,[role=list]')].map(rowsOf));
  const items = count(document, 'article') || count(root, '[role=listitem]') || best;
  const se = document.scrollingElement || document.documentElement;
  return { y: Math.round(window.scrollY), height: Math.round(se.scrollHeight), vh: Math.round(window.innerHeight), items };
})()`;

const MAIN_SCROLLER = (dir) => `(() => {
  for (const e of document.querySelectorAll('[data-cxb-scroller]')) e.removeAttribute('data-cxb-scroller');
  let best = null;
  let area = 0;
  for (const e of [...document.querySelectorAll('*')].slice(0, 3000)) {
    if (e.scrollHeight <= e.clientHeight + 40 || !/^(auto|scroll)$/.test(getComputedStyle(e).overflowY)) continue;
    if (e === document.documentElement || e === document.body || e === document.scrollingElement) continue;
    const fwd = ${JSON.stringify(dir === 'down' || dir === 'bottom')}; if (fwd ? e.scrollTop + e.clientHeight >= e.scrollHeight - 2 : e.scrollTop <= 1) continue;
    const r = e.getBoundingClientRect();
    const a = r.width * r.height;
    if (a > area && a >= innerWidth * innerHeight / 10 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) { best = e; area = a; }
  }
  if (!best) return null;
  best.setAttribute('data-cxb-scroller', '');
  const label = best.tagName.toLowerCase() + (best.id ? '#' + best.id : '') + (best.classList[0] ? '.' + best.classList[0] : '');
  return { y: Math.round(best.scrollTop), height: Math.round(best.scrollHeight), vh: Math.round(best.clientHeight), label };
})()`;

const SCROLLER_INFO = `(() => { const el = document.querySelector('[data-cxb-scroller]'); if (!el) return null; return { y: Math.round(el.scrollTop), height: Math.round(el.scrollHeight), vh: Math.round(el.clientHeight) }; })()`;

const BUSY = `
  const busyScan = () => {
    const small = e => {
      if (e.getAttribute('aria-busy') === 'true' || e.getAttribute('role') === 'progressbar') return true;
      const r = e.getBoundingClientRect();
      if (r.width * r.height >= 0.25 * innerWidth * innerHeight) return false;
      const t = (e.innerText || e.textContent || '').slice(0, 200).trim();
      if (t.length > 80) return false;
      const s = getComputedStyle(e);
      return t.length > 0 || (!!s.animationName && s.animationName !== 'none' && s.animationPlayState !== 'paused');
    };
    const seen = [...document.querySelectorAll(${JSON.stringify(BUSY_SEL)})].filter(vis);
    const busyEls = seen.filter(small);
    return { count: busyEls.length, text: busyEls.length ? (busyEls[0].innerText || busyEls[0].textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) : '' };
  };`;

const HIT_AT = `
  const hitAt = (at) => {
    let hit = document.elementFromPoint ? document.elementFromPoint(at.x, at.y) : null;
    while (hit && hit.shadowRoot && hit.shadowRoot.elementFromPoint) {
      const inner = hit.shadowRoot.elementFromPoint(at.x, at.y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };
  const within = (outer, e) => { for (; e; e = upOf(e)) if (e === outer) return true; return false; };
  const coveredBy = (el, hit) => !!hit && !within(el, hit) && !within(hit, el);`;

const MODAL_FINDER = `const paintedArea = (e) => { const s = getComputedStyle(e); if (s.pointerEvents !== 'none' && s.backgroundColor !== 'rgba(0, 0, 0, 0)') return (r => r.width * r.height)(e.getBoundingClientRect()); let best = 0; const w = document.createTreeWalker(e, NodeFilter.SHOW_ELEMENT); for (let n = w.nextNode(), k = 0; n && k < 400; n = w.nextNode(), k++) { if (!vis(n)) continue; const r = n.getBoundingClientRect(); const a = r.width * r.height; if (a > best) best = a; } return best; };
  const DIALOG_SEL = '[role=dialog], [role=alertdialog], dialog[open], [aria-modal=true]';
  const drawerAt = (e) => { const r = e.getBoundingClientRect(), w = Math.min(innerWidth, (document.documentElement && document.documentElement.clientWidth) || innerWidth); return r.height >= innerHeight * 0.8 && (r.left <= 16 || r.right >= w - 16) && r.width >= innerWidth * 0.2 && r.width <= innerWidth * 0.75 && /^(fixed|absolute)$/.test(getComputedStyle(e).position); };
  const drawerKeep = (e) => !e.closest('nav, [role=navigation]') && !e.querySelector('nav, [role=navigation]') && [...e.querySelectorAll('button, a, [role=button]')].some(b => /\\b(close|dismiss)\\b|^×$/i.test((b.getAttribute('aria-label') || b.innerText || b.getAttribute('title') || '').trim()));
  const drawersOf = () => [...document.querySelectorAll('div,aside,section')].slice(0, ${POINTER_SCAN_MAX}).filter(e => !e.matches(DIALOG_SEL) && drawerAt(e) && vis(e) && drawerKeep(e)).filter((e, _i, a) => !a.some(x => x !== e && e.contains(x)));
  const modalBy = (e) => { for (let n = e; n && n !== document.body; n = n.parentElement) { const sib = [...n.parentElement ? n.parentElement.children : []].filter(x => x !== n && vis(x)); if (sib.length && sib.some(x => (x.innerText || '').trim().length >= 40) && sib.every(x => x.getAttribute('aria-hidden') === 'true' || x.hasAttribute('inert'))) return 'hidden'; } const prev = e.previousElementSibling; if (prev && vis(prev)) { const s = getComputedStyle(prev), r = prev.getBoundingClientRect(); if ((s.position === 'fixed' || s.position === 'absolute') && r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9) return 'backdrop'; } if (e.matches('[aria-modal=true], dialog[open]')) return 'aria'; if (drawerAt(e) && (e.matches('[role=dialog]') || drawerKeep(e))) return 'drawer'; return ''; };
  const modal = forced ? null : [...document.querySelectorAll(DIALOG_SEL), ...drawersOf()].filter(vis).map(e => ({ e, by: modalBy(e), a: paintedArea(e) })).filter(x => x.by && (x.by !== 'aria' ? x.a >= innerWidth * innerHeight / 16 : x.a >= innerWidth * innerHeight / 4)).sort((a, b) => (a.by === 'drawer') - (b.by === 'drawer') || b.a - a.a)[0];`;

function readText(main) {
  return `(() => {${DEEP}${BUSY}${WALL}
  ${bulletItems.toString()}
  const DROP = 'script,style,noscript,select,button,svg,[aria-hidden=true],.navbox,.mw-editsection,.reference,.reflist,#toc,.toc';
  const score = el => { if (!el.getClientRects().length) return -1; const t = (el.innerText || '').length;
    let l = 0; el.querySelectorAll('a').forEach(a => l += (a.innerText || '').length);
    return t - 2 * l;
  };
  ${main ? MAIN_ROOT : ''}
  const forced = ${main ? 'mainRootOf()' : 'null'};
  let root = forced || document.querySelector(${JSON.stringify(READ_ROOT_SEL)});
  ${MODAL_FINDER}
  if (modal) root = modal.e;
  const framed = el => [...el.querySelectorAll('iframe')].some(f => { try { return !!(f.contentDocument && f.contentDocument.body && f.contentDocument.body.innerText.trim()); } catch { return false; } });
  if (!forced && !modal && (!root || ((root.innerText || '').length < 200 && !framed(root)))) {
    let best = document.body, bs = -1;
    document.querySelectorAll('div,section,td').forEach(el => {
      const s = score(el); if (s > bs) { bs = s; best = el; }
    });
    root = best && (best.innerText || '').length < 0.5 * ((document.body && document.body.innerText) || '').length ? document.body : best;
  }
  const dialogRead = !!modal && root === modal.e;
  const busy = busyScan();
  const labels = (sel, k, of) => [...document.querySelectorAll(sel)].filter(vis).map(e => (of(e) || '').replace(/\\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, k);
  const outline = { headings: labels('h1,h2,h3', 6, e => e.innerText || e.textContent), landmarks: labels('main,nav,[role=main],[role=navigation]', 3, e => e.getAttribute('aria-label')) };
  const wall = wallScan(root);
  if (!root) return { text: '', busy, outline, wall, inlined: [], nested: [], hidden: [] };
  const STRUCK = /^(S|DEL|STRIKE)$/;
  const struck = new Set();
  [...root.querySelectorAll('*')].forEach((e, i) => {
    if ((e.textContent || '').trim().length > 40 || !(e.textContent || '').trim()) return;
    if (STRUCK.test(e.tagName) || String(getComputedStyle(e).textDecorationLine || '').includes('line-through')) struck.add(i);
  });
  const clone = root.cloneNode(true);
  const twins = struck.size ? [...clone.querySelectorAll('*')] : [];
  const wrapped = new Set();
  for (const i of struck) {
    const c = twins[i];
    let up = c && c.parentElement;
    while (up && !wrapped.has(up)) up = up.parentElement;
    if (!c || up) continue;
    wrapped.add(c); c.prepend('(was '); c.append(')');
  }
  const AGE_SEL = 'time[datetime], [title*="T"][class*="age" i], [data-time]';
  const AGE_RE = /\\b(\\d+|an?|one)\\s+(second|minute|hour|day|week|month|year)s?\\s+ago\\b|\\bjust now\\b|\\bacum\\b/i;
  const pad2 = n => String(n).padStart(2, '0');
  const ageOrigs = [...root.querySelectorAll('*')];
  [...clone.querySelectorAll('*')].forEach((twin, i) => {
    const o = ageOrigs[i];
    if (!o || !o.matches(AGE_SEL) || o.querySelector(AGE_SEL) || !AGE_RE.test(o.textContent || '')) return;
    const v = String(o.getAttribute('datetime') || o.getAttribute('title') || o.getAttribute('data-time') || '').trim();
    const tok = v.split(/\\s+/); const bare = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?$/.test(tok[0]); const d = /^\\d{9,10}$/.test(tok[1] || '') ? new Date(Number(tok[1]) * 1000) : bare ? new Date(tok[0] + 'Z') : new Date(v);
    if (!isNaN(d)) twin.append(' (' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ')');
  });
  const inlined = [];
  const nested = [];
  const hidden = [];
  const origs = [...root.querySelectorAll('*')]; [...clone.querySelectorAll('*')].forEach((twin, i) => { const orig = origs[i]; if (orig && !orig.getClientRects().length && getComputedStyle(orig).display !== 'contents' && !(twin.parentElement && twin.parentElement.closest('[data-cxb-cut]'))) { twin.setAttribute('data-cxb-cut', ''); twin.textContent = ''; } else if (orig && getComputedStyle(orig).visibility === 'hidden' && (orig.innerText || '').trim() === '') { twin.textContent = ''; } else if (orig && getComputedStyle(orig).opacity === '0' && !faded(orig) && (orig.innerText || '').trim().length >= 3) { twin.prepend(Object.assign(document.createElement('div'), { textContent: '(hidden)' })); twin.append(Object.assign(document.createElement('div'), { textContent: '(end hidden)' })); } if (orig && orig.shadowRoot && !twin.hasAttribute('data-cxb-cut')) twin.append(...[...orig.shadowRoot.childNodes].map(n => n.cloneNode(true))); if (orig && orig.tagName === 'IFRAME') { let fd = null; try { fd = orig.contentDocument; } catch {} if (!vis(orig)) hidden.push(orig.srcdoc ? 'about:srcdoc' : (fd && fd.location && fd.location.href) || orig.src || ''); if (vis(orig) && fd && fd.body && fd.body.innerText.trim()) { const box = document.createElement('div'); box.append('[frame]\\n', fd.body.cloneNode(true)); const inner = [...fd.querySelectorAll('iframe[srcdoc]')].length; if (inner) nested.push(inner); twin.replaceWith(box); inlined.push(orig.srcdoc ? 'about:srcdoc' : (fd.location && fd.location.href) || orig.src || ''); } } });
  clone.querySelectorAll('sup').forEach(c => {
    const p = c.previousSibling ? String(c.previousSibling.textContent || '') : '';
    if (/^\\d{2}$/.test(String(c.textContent || '').trim()) && /\\d$/.test(p)) c.prepend(/\\d,\\d{3}$/.test(p) ? '.' : ',');
  });
  clone.querySelectorAll(DROP).forEach(n => n.remove());
  const chrome = root.closest(${JSON.stringify(CHROME_SEL)}) ? [clone] : [...clone.querySelectorAll(${JSON.stringify(CHROME_SEL)})];
  for (const c of chrome) {
    const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) if (t.data.trim()) t.data = ${JSON.stringify(CHROME_MARK)} + t.data;
  }
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:1000px';
  host.setAttribute('data-cxb-read-host', '');
  const cv = document.createElement('style'); cv.textContent = '[data-cxb-read-host] * { content-visibility: visible !important; }'; document.head.appendChild(cv);
  host.appendChild(clone); document.body.appendChild(host);
  bulletItems(clone, ${JSON.stringify(CHROME_MARK)});
  ${TABLES}
  const txt = clone.innerText; host.remove(); cv.remove();
  const text = (document.title + '\\n\\n' + (dialogRead ? '[dialog]\\n' : '') + txt).replace(/[ \\t]+/g, ' ').replace(/\\n\\s*\\n+/g, '\\n\\n').trim().slice(0, ${TEXT_MAX});
  return { text, busy, outline, wall, inlined, nested, hidden };
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
  ${main ? MAIN_ROOT : ''}
  const mainRoot = ${main ? 'mainRootOf()' : 'null'};
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
  const UNREAD = /\\b(unread|necitit)/i;
  const MARK = /\\b(mark(ed)?|marcheaz[aă]|marca(t|ti|ți)?) (as|ca)\\b/i;
  const says = x => UNREAD.test(x) && !MARK.test(x);
  const ownText = e => [...e.childNodes].some(c => c.nodeType === 3 && c.nodeValue.trim());
  const unreadOf = el => {
    if (!(el.tagName === 'TR' || el.getAttribute('role') === 'row' || (el.tagName === 'LI' && el.parentElement && el.parentElement.closest('[role=list],[role=listbox],ul')))) return false;
    if (says(el.getAttribute('aria-label') || '')) return true;
    const kids = [...el.querySelectorAll('*')].slice(0, 60);
    if (kids.some(e => says(e.getAttribute('aria-label') || '') || (!e.children.length && says(e.textContent || '') && !vis(e)))) return true;
    const CELL = 'td,th,[role=gridcell],[role=cell]';
    const all = [...el.querySelectorAll(CELL)];
    const outer = all.filter(c => { const up = c.parentElement && c.parentElement.closest(CELL); return !up || !all.includes(up); });
    const cells = outer.length ? outer : el.children.length ? [...el.children] : [el];
    const heavy = e => parseInt(getComputedStyle(e).fontWeight, 10) >= 600;
    const owned = c => [c, ...[...c.querySelectorAll('*')].slice(0, 20)].filter(ownText);
    const texted = cells.filter(c => owned(c).length > 0);
    const bold = texted.filter(c => owned(c).some(heavy));
    return texted.length > 0 && bold.length * 2 >= texted.length;
  };
  const items = []; const seen = new Set(); let listed = 0; let truncated = false;
  for (const el of cands) {
    if (!vis(el)) continue;
    const tag = el.tagName.toLowerCase();
    const ctl = tag === 'label' && !std.has(el) ? el.control : null;
    const hid = !!ctl && ctl.tagName === 'INPUT' && /^(radio|checkbox)$/.test(ctl.type) && !vis(ctl);
    const plain = !std.has(el) && !hid;
    const kind = hid ? 'input:' + ctl.type : plain ? 'clickable' : el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? 'input:' + (el.type || 'text') : tag);
    const disabled = (hid ? ctl : el).disabled === true || el.getAttribute('aria-disabled') === 'true';
    let line = '';
    let sig = null;
    let full = null;
    let unread = false;
    if (plain) {
      if (underRow(el)) continue;
      const inner = el.querySelectorAll(sel);
      if (inner.length === 1 && inner[0].matches('input,button,select,a[href]') && vis(inner[0])) continue;
      full = flat(labelOf(el));
      const label = clip(full, 60);
      if (tag === 'a' && !label) continue;
      if (tag === 'tr' || el.getAttribute('role') === 'row' || !el.querySelector(sel)) rows.add(el);
      line = label ? JSON.stringify(label) : '(icon)';
      unread = unreadOf(el);
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
    } else if (hid) {
      line = inputLine({
        tag: 'input', type: ctl.type, value: ctl.value, checked: ctl.checked, label: el.innerText,
        aria: ctl.getAttribute('aria-label'), placeholder: ctl.placeholder, name: ctl.name, id: ctl.id,
      });
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
    const th = el.closest('th,[role=columnheader]');
    const sorted = (el.getAttribute('aria-sort') || (th && th.getAttribute('aria-sort')) || '').toLowerCase();
    const flags = (disabled ? ' [disabled]' : '') + (sorted === 'ascending' ? ' [sorted ↑]' : sorted === 'descending' ? ' [sorted ↓]' : '')
      + (/^(page|true)$/i.test(el.getAttribute('aria-current') || '') ? ' [current]' : '') + (unread ? ' [unread]' : '');
    const cq = cqOf(el);
    items.push({ el, full, cq, line: [kind, cq ? '⚠' : '', line].filter(Boolean).join(' ') + flags, sig: sig == null ? null : kind + ' ' + sig + flags });
  }
`;
}

function readInteractive(main, state) {
  return `(() => {${DEEP}${numbering(state)}
  ${distinctClips.toString()}
  ${inputLine.toString()}
  resetTable();${collect(main)}${HIT_AT}
  const forced = ${main ? 'mainRootOf()' : 'null'};
  ${MODAL_FINDER}
  const cover = modal && modal.by !== 'drawer' ? modal.e : null;
  const tails = distinctClips(items.map(i => (i.line != null && i.full) || ''));
  items.forEach((it, i) => {
    if (!tails[i]) return;
    it.line = it.line.replace(clip(it.full, 60), () => tails[i]);
    if (it.sig != null) it.sig = it.sig.replace(clip(it.full, 60), () => tails[i]);
  });
  const parts = items.map(i => partsOf(i.el));
  const stored = storedKeysOf(items.map(i => i.el), parts.map(keyOf));
  const out = []; const keys = {}; const descs = []; const sigs = {}; const chrome = []; const covered = []; const rowsOut = {}; const cats = {}; const adKeys = {};${ROW}
  items.forEach((it, i) => {
    const n = place(it.el, stored[i], it.line != null);
    keys[n] = stored[i];
    const p = parts[i];
    if (p.raw.includes('?')) descs.push({ kind: p.kind, label: p.label, href: p.raw });
    if (it.line != null) {
      out.push('[' + n + '] ' + it.line);
      if (it.cq) cats[n] = it.cq;
      if (it.cq === 'ad') { const k = adKeyOf(it.el); if (k != null) adKeys[n] = k; }
      rowsOut[n] = rowOf(it.el);
      sigs[n] = counterMask(it.sig == null ? it.line : it.sig) + '\u0000' + counterMask(rowsOut[n]);
      if (it.el.closest(${JSON.stringify(CHROME_SEL)})) chrome.push(n);
      if (cover && !within(cover, it.el) && coveredBy(it.el, hitAt((r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))(it.el.getBoundingClientRect())))) covered.push(n);
    }
  });
  return { lines: out, truncated, assigned, next, fresh, keys, descs, sigs, rows: rowsOut, chrome, covered, cats, adKeys, posts: [...(${main ? 'mainRootOf() || document' : 'document'}).querySelectorAll('article')].filter(a => !(a.parentElement && a.parentElement.closest('article'))).length, cloaked: [...(${main ? 'mainRootOf() || document' : 'document'}).querySelectorAll('article, [data-post-number], [id^=post_], .post-stream--cloaked')].filter(a => !(a.parentElement && a.parentElement.closest('article, [data-post-number]')) && (a.innerText || '').trim().length < 40 && a.getBoundingClientRect().height >= 200).length, url: location.href };
})()`;
}

const PLACEHOLDER_ALTS = ['alt', 'image', 'icon', 'img', 'photo', 'picture'];
const PLACEHOLDER_ALT_RE = 'profile picture|avatar|user image|photo of';
const GENERIC_CLASSES = ['container', 'wrapper', 'wrap', 'inner', 'outer', 'row', 'col', 'flex', 'grid', 'item', 'box', 'btn', 'button', 'icon', 'clickable', 'active', 'selected', 'link', 'nav', 'text', 'bg', 'is', 'has', 'js', 'ui'];

function labelFrom(d) {
  const flat = (s) => String(s == null ? '' : s).replace(/[\u200b\u200c\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
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
  const named = pick([flat(d.label), flat(d.aria), flat(d.text), flat(d.placeholder), ['input', 'select', 'button'].includes(d.tag) ? flat(d.value) : '', flat(d.title), flat(d.svgAria), flat(d.svgTitle), flat(d.tooltip),
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
  return pick([human(src.replace(/\.\w{2,5}$/, '')), human(d.for), () => (form ? '' : cls(d.classes))]);
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
      svgAria: svg ? svg.getAttribute('aria-label') : '',
      tooltip: e.getAttribute('data-tooltip') || e.getAttribute('data-original-title') || '',
      classes: e.getAttribute('class'),
      src: [e.getAttribute('src') || '', ...[...e.querySelectorAll('img[src]')].map(i => i.getAttribute('src'))].find(u => u && !/^data:/i.test(u)) || '',
      inner: btn ? (btn.tagName === 'INPUT' ? btn.value : btn.innerText) || btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.getAttribute('name') || '' : '',
      video: !!(e.closest('video,[data-testid*=video i]') || e.querySelector('video,[data-testid*=video i]')),
      h: e.getBoundingClientRect().height,
      inLink: !!e.closest('a[href] *'),
    };
  };
  const SORT_STATE = new RegExp(${JSON.stringify(keys.STATE_SUFFIX.source)}, 'i');
  const headed = (el, l) => {
    const th = el.closest && el.closest('th,[role=columnheader]');
    if (!th || th === el) return l;
    const bare = String(l || '').replace(SORT_STATE, '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/\\s+/g, ' ').trim();
    if (!/^(?:sort(?: ascending| descending| by)?|sortare)$/.test(bare)) return l;
    const own = String(el.innerText || '').trim();
    const all = String(th.innerText || '');
    const head = (own ? all.replace(own, '') : all).replace(/\\s+/g, ' ').trim().slice(0, 40).trim();
    return head ? head + ': ' + l : l;
  };
  const labelOf = el => headed(el, labelFrom(descOf(el)));`;


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
  ${clickPoint.toString()}
  ${KIND_LABEL}${CQ}${ROW}
  const textual = tag === 'textarea' || (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden'].includes(type));
  const r0 = el.getBoundingClientRect();
  if (!r0.width || !r0.height) return null;
  const clip = clipOf(el);
  const outside = outOf(r0, { top: 0, left: 0, bottom: innerHeight, right: innerWidth }) || (!!clip && outOf(r0, clip.rect));
  if (outside) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const first = clickPoint(el, el.getBoundingClientRect(), document);
  const positioned = e => { const p = getComputedStyle(e).position; return p === 'fixed' || p === 'sticky'; };
  const stickyOf = (h) => { for (let e = h; e && e.getBoundingClientRect; e = upOf(e)) if (positioned(e)) return e; return null; };
  const overlayOf = (h) => {
    let big = null;
    for (let e = h; e && e.getBoundingClientRect; e = upOf(e)) {
      if (positioned(e) || e.tagName === 'DIALOG' || e.getAttribute('role') === 'dialog' || e.getAttribute('aria-modal') === 'true') return e;
      const b = e.getBoundingClientRect();
      if (Number(getComputedStyle(e).zIndex) > 0 && b.width * b.height >= innerWidth * innerHeight / 4) big = e;
    }
    return big;
  };
  const numberOf = (e) => {
    const m = window.__cxOf && window.__cxOf.get(e);
    return m != null && window.__cxEls[m] && window.__cxEls[m].deref() === e ? m : null;
  };
  const buttonsOf = (o) => {
    const out = [];
    for (const b of o ? o.querySelectorAll('button,[role=button],a') : []) {
      const m = numberOf(b);
      if (m != null) out.push({ n: m, label: labelOf(b).slice(0, 60) });
    }
    const PRIO = /\\b(accept|agree|allow|reject|refuse|decline|respinge|refuz|sunt de acord|save|salveaz|close|dismiss|got it|ok)\\b|^[×✕✖⨯x]$/i;
    return [...out.filter(b => PRIO.test(b.label)), ...out.filter(b => !PRIO.test(b.label))].slice(0, 8);
  };
  const DIALOG_SEL = '[role=dialog],[aria-modal=true],dialog,[id*=banner i],[class*=banner i],[id*=consent i],[class*=consent i],[id*=cookie i],[class*=cookie i]';
  const dialogOf = () => {
    let best = null, bz = -Infinity;
    for (const d of document.querySelectorAll(DIALOG_SEL)) {
      const r = d.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
      const s = getComputedStyle(d);
      if (!positioned(d) && !d.matches('dialog,[role=dialog],[aria-modal=true]')) continue;
      if (s.visibility === 'hidden' || s.display === 'none' || !buttonsOf(d).length) continue;
      const z = Number(s.zIndex) || 0;
      let nested = false;
      for (let e = d; e && best && !nested; e = upOf(e)) nested = e === best;
      if (z > bz || (z === bz && !nested)) { best = d; bz = z; }
    }
    return best;
  };
  let lastHit = null;${HIT_AT}
  const report = () => {
    const r = el.getBoundingClientRect();
    const at = r.width && r.height ? clickPoint(el, r, document) : first;
    const hit = hitAt(at);
    const covered = coveredBy(el, hit);
    lastHit = covered ? hit : null;
    let hitN = null;
    for (let e = covered ? hit : null; e && hitN == null; e = upOf(e)) hitN = numberOf(e);
    return {
      x: at.x, y: at.y, tag, type, kind, label,
      password: tag === 'input' && type === 'password',
      otp: el.getAttribute('autocomplete') === 'one-time-code',
      editable: (textual && !el.disabled && !el.readOnly) || el.isContentEditable,
      href: tag === 'a' && typeof el.href === 'string' ? el.href : '',
      download: tag === 'a' && el.hasAttribute('download') ? el.getAttribute('download') : null,
      consequential: cqOf(el),
      row: rowOf(el),
      covered,
      ...(covered ? { hitN, hitLabel: labelOf(hit).slice(0, 60) || hit.tagName.toLowerCase(), hitConsequential: cqOf(hit) } : {}),
    };
  };
  const clear = () => {
    const cover = stickyOf(lastHit);
    const r = el.getBoundingClientRect();
    const c = cover && cover.getBoundingClientRect();
    let dx = 0, dy = 0;
    if (c && c.height < innerHeight && c.top < r.bottom && c.bottom > r.top) dy = c.top <= innerHeight - c.bottom ? -(c.bottom - r.top + 4) : r.bottom - c.top + 4;
    else if (c && c.width < innerWidth && c.left < r.right && c.right > r.left) dx = c.left <= innerWidth - c.right ? -(c.right - r.left + 4) : r.right - c.left + 4;
    if (!dx && !dy) return el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const by = { left: dx, top: dy, behavior: 'instant' };
    (clip ? clip.sc : window).scrollBy(by);
    const moved = el.getBoundingClientRect();
    if (clip && moved.top === r.top && moved.left === r.left) window.scrollBy(by);
  };
  const settle = f => new Promise(res => {
    let done = false;
    const once = () => { if (!done) { done = true; res(f()); } };
    setTimeout(once, 150);
    requestAnimationFrame(() => requestAnimationFrame(once));
  });
  const named = (o, hit) => {
    let host = null;
    for (let e = o.covered && o.hitN != null && !o.hitConsequential ? hit : null; e && !host; e = upOf(e)) if (numberOf(e) != null) host = e;
    const hitButtons = !o.covered ? [] : o.hitN == null ? buttonsOf(overlayOf(hit))
      : host && !host.matches(${JSON.stringify(STD_SEL)}) ? buttonsOf(host) : [];
    if (hitButtons.length) return { ...o, hitButtons };
    const dialog = o.covered && o.hitN == null ? dialogOf() : null;
    if (!dialog) return o;
    return { ...o, hitButtons: buttonsOf(dialog), hitDialog: dialog.id || String(dialog.getAttribute('class') || '').trim().split(/\\s+/)[0] || dialog.tagName.toLowerCase() };
  };
  const onScreen = o => o.x >= 0 && o.y >= 0 && o.x < innerWidth && o.y < innerHeight;
  if (!outside) return named(report(), lastHit);
  return settle(() => {
    const out = report();
    const hit = lastHit;
    const r = el.getBoundingClientRect();
    if (!out.covered || !r.width || !r.height) return named(out, hit);
    clear();
    return settle(() => {
      const again = report();
      return onScreen(again) ? named(again, lastHit) : named(out, hit);
    });
  });
})()`;
}

const DEFAULT_SUBMIT_SEL = 'button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]';

const ACTIVE = `let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { none: true };`;

const NON_TEXT_TYPES = ['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file', 'range', 'color', 'hidden'];

const SPACE_PRESS = `if (tag === 'button' || (tag === 'input' && ['submit', 'image', 'button', 'reset', 'checkbox', 'radio'].includes(type)) || role === 'button') {
    return { from, n: from, press: true, label, consequential: cqOf(el) };
  }
  return { none: true };`;

const ENTER_SUBMIT = `if (tag === 'button' || (tag === 'input' && ['submit', 'image', 'button'].includes(type))
    || (tag === 'a' && el.hasAttribute('href')) || role === 'button' || role === 'link') {
    return { from, n: from, press: true, label, consequential: cqOf(el) };
  }
  if (tag === 'textarea' || el.isContentEditable) return { none: true };
  const textualIn = e => e.tagName.toLowerCase() === 'input' && !${JSON.stringify(NON_TEXT_TYPES)}.includes((e.type || '').toLowerCase());
  const inForm = tag === 'select' || (tag === 'input' && !['button', 'submit', 'image', 'reset', 'hidden'].includes(type));
  if (!inForm || !el.form) return { none: true };
  const form = el.form;
  const btn = [...form.getRootNode().querySelectorAll(${JSON.stringify(DEFAULT_SUBMIT_SEL)})].find(b => b.form === form);
  if (btn) return { from, n: numOf(btn), label: labelOf(btn).slice(0, 60), consequential: cqOf(btn) };
  if ([...form.elements].filter(textualIn).length !== 1) return { none: true };
  const action = form.getAttribute('action') || '';
  const hit = consequentialHit({ action }, []);
  const seg = action.split(/[?#]/)[0].split('/').filter(Boolean).pop();
  return { from, n: null, label: String(seg || 'form').slice(0, 60), consequential: hit ? hit.cat : null };`;

const ARROW_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

const ARROW_CHOOSE = (forward) => `if (tag === 'input' && type === 'radio') {
    const group = el.name ? [...el.getRootNode().querySelectorAll('input[type=radio]')]
      .filter(r => r.name === el.name && r.form === el.form && (r === el || !r.disabled)) : [el];
    if (group.length < 2) return { none: true };
    const i = group.indexOf(el);
    const target = group[(i + ${forward ? 1 : -1} + group.length) % group.length];
    return { from, n: numOf(target), press: true, choose: true, label: labelOf(target).slice(0, 60), consequential: cqOf(target) };
  }
  if (tag === 'select' && !el.multiple) return { from, n: from, press: true, choose: true, change: true, label, consequential: cqOf(el) };
  return { none: true };`;

function submitTarget(n, key = 'Enter') {
  return `(() => {${DEEP}
  ${n == null ? ACTIVE : REF(n)}
  ${KIND_LABEL}${CQ}
  const numOf = e => {
    for (const [k, r] of Object.entries(window.__cxEls || {})) if (r && r.deref() === e) return Number(k);
    return null;
  };
  const from = numOf(el);
  const role = el.getAttribute('role');
  ${ARROW_KEYS.includes(key) ? ARROW_CHOOSE(key === 'ArrowDown' || key === 'ArrowRight') : key === 'Space' ? SPACE_PRESS : ENTER_SUBMIT}
})()`;
}

function inspect(n) {
  return `(() => {${DEEP}
  ${REF(n)}
  ${KIND_LABEL}${CQ}
  const clip = (s, k) => { s = String(s || '').replace(/\\s+/g, ' ').trim(); return s.length > k ? s.slice(0, k - 1) + '…' : s; };
  const secret = e => e.tagName === 'INPUT' && (e.type === 'password' || e.getAttribute('autocomplete') === 'one-time-code');
  const textual = tag === 'textarea' || (tag === 'input' && !${JSON.stringify(NON_TEXT_TYPES)}.includes(type));
  const FIRST = ['href', 'onclick', 'role', 'tabindex', 'type', 'name', 'value'];
  const rank = k => { const i = FIRST.indexOf(k); return i < 0 ? FIRST.length : i; };
  const names = [...el.attributes].map(a => a.name)
    .filter(k => k !== 'id' && k !== 'class' && k !== 'data-cx' && !(k === 'value' && secret(el)));
  names.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const attrs = names.slice(0, 8).map(k => [k, clip(el.getAttribute(k), 60)]);
  const short = (e, k) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + [...e.classList].slice(0, k).map(c => '.' + c).join('');
  const up = e => e.parentElement || (e.parentNode && e.parentNode.host) || null;
  const ancestorsOf = (e) => { const out = []; for (let p = up(e), k = 0; p && k < 12; p = up(p), k++) if (!k || p.id || p.getAttribute('aria-label') || p.getAttribute('role') || /^(NAV|ASIDE|HEADER|FOOTER|MAIN|FORM|DIALOG)$/.test(p.tagName) || /dialog|drawer|panel|modal|sidebar|nav|form/i.test(p.className || '')) out.push(p); return (out.length > 6 ? [...out.slice(0, 5), out[out.length - 1]] : out).map(p => short(p, 2)); };
  const ancestors = ancestorsOf(el);
  const clone = el.cloneNode(true);
  for (const e of [clone, ...clone.querySelectorAll('*')]) {
    e.removeAttribute('data-cx');
    if (secret(e)) e.removeAttribute('value');
  }
  const r = el.getBoundingClientRect();
  const list = clipOf(el);
  return {
    tag, id: el.id || '', classes: [...el.classList].slice(0, 5), kind, label, attrs,
    cursor: getComputedStyle(el).cursor,
    marked: el.matches(${JSON.stringify(X_SEL)}),
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    visible: vis(el), clipped: !!list && outOf(r, list.rect), ancestors, html: clip(clone.outerHTML, 300), warn: cqHit(el),
    ...(textual && !secret(el) ? { value: String(el.value == null ? '' : el.value) } : {}),
  };
})()`;
}

const PAGE_TEXT = `(() => {
  if (!document.body) return '';
  const clone = document.body.cloneNode(true);
  const root = document.body;
  const origs = [...root.querySelectorAll('*')]; [...clone.querySelectorAll('*')].forEach((twin, i) => { const orig = origs[i]; if (orig && !orig.getClientRects().length && getComputedStyle(orig).display !== 'contents' && !(twin.parentElement && twin.parentElement.closest('[data-cxb-cut]'))) { twin.setAttribute('data-cxb-cut', ''); twin.textContent = ''; } else if (orig && orig.shadowRoot) twin.append(...[...orig.shadowRoot.childNodes].map(n => n.cloneNode(true))); });
  clone.querySelectorAll('script,style,noscript,template,iframe,object,embed,video,audio,[aria-hidden=true],[inert]').forEach(n => n.remove());
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:1000px';
  host.setAttribute('data-cxb-read-host', '');
  const cv = document.createElement('style'); cv.textContent = '[data-cxb-read-host] * { content-visibility: visible !important; }'; document.head.appendChild(cv);
  host.appendChild(clone); document.body.appendChild(host);
  ${TABLES}
  const t = clone.innerText || ''; host.remove(); cv.remove();
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
  const flatOf = el => String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  let textOf = own;
  let byName = false;
  let hits = deepAll(document, el => !TEXT_SKIP.has(el.tagName) && own(el).toLowerCase().includes(want)).filter(vis);
  if (!hits.length) {
    const spans = el => { const t = flatOf(el); return t.length <= 400 && t.toLowerCase().includes(want); };
    textOf = flatOf;
    hits = deepAll(document, el => !TEXT_SKIP.has(el.tagName) && !!own(el) && spans(el) && ![...el.children].some(spans)).filter(vis);
  }
  if (!hits.length) {
    const nameOf = el => String(el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
    hits = deepAll(document, el => el.matches(sel) && nameOf(el).toLowerCase().includes(want)).filter(vis);
    textOf = nameOf;
    byName = hits.length > 0;
  }
  const found = [];
  const loose = [];
  for (const el of hits) {
    const t = textOf(el);
    const ctl = el.matches(sel) ? el : el.closest(sel);
    if (ctl && !keyed.has(ctl)) continue;
    const c = ctl || plainOf(el, t);
    if (!c || !keyed.has(c)) { loose.push({ n: null, loose: true, text: t }); continue; }
    const have = found.find(x => x.el === c);
    if (have) { have.exact = have.exact || t.toLowerCase() === want; continue; }
    found.push({ el: c, text: t, exact: t.toLowerCase() === want });
  }
  const exact = found.filter(x => x.exact);
  const pick = exact.length ? exact : found.length ? found : loose;
  const clickOnly = pick.length > 0 && loose.length > 0 && !pick.some(x => x.loose);
  const clipT = t => (t.length > 60 ? t.slice(0, 59) + '…' : t);
  return { count: pick.length, byName, clickOnly, hits: pick.slice(0, 5).map(h => {
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

const CHOICE_OF = `const ch = el.tagName === 'LABEL' && el.control && el.control.tagName === 'INPUT' && /^(radio|checkbox)$/.test(el.control.type) ? el.control : el;
  const tag = ch.tagName.toLowerCase();
  const type = (ch.type || '').toLowerCase();
  if (tag === 'input' && type === 'radio') {
    const group = ch.name ? [...ch.getRootNode().querySelectorAll('input[type=radio]')].filter(r => r.name === ch.name && r.form === ch.form) : [ch];
    const on = group.find(r => r.checked);
    return on ? { kind: 'choice', label: labelOf(on).slice(0, 60), value: String(on.value) } : null;
  }
  if (tag === 'input' && type === 'checkbox') return { kind: 'choice', label: labelOf(ch).slice(0, 60) + (ch.checked ? ' [x]' : ' [ ]'), value: String(ch.value) };
  if (tag === 'select' && !ch.multiple) {
    const opt = ch.options[ch.selectedIndex];
    return opt ? { kind: 'choice', select: true, label: String(opt.text).replace(/\\s+/g, ' ').trim().slice(0, 60), value: String(ch.value) } : null;
  }`;

const VALUE_ACTIVE = `(() => {${ICON}
  ${ACTIVE}
  ${CHOICE_OF}
  const textual = tag === 'textarea' || (tag === 'input' && !${JSON.stringify(NON_TEXT_TYPES)}.includes(type));
  if (!(textual || el.isContentEditable) || type === 'password' || el.getAttribute('autocomplete') === 'one-time-code') return null;
  const v = el.isContentEditable ? el.textContent : String(el.value == null ? '' : el.value);
  return v.length > ${VALUE_MAX} ? v.slice(0, ${VALUE_MAX - 1}) + '…' : v;
})()`;

function GONE(nums) {
  return `(() => {${DEEP}
  const groups = new Map();
  let total = 0;
  const groupOf = (el) => {
    let p = upOf(el);
    for (let k = 0; p && k < 12; p = upOf(p), k++) {
      const label = p.getAttribute && p.getAttribute('aria-label');
      if (label) return label;
      if (p.getAttribute && p.getAttribute('role') === 'dialog') return 'dialog';
      if (/^(NAV|ASIDE|HEADER|FOOTER)$/.test(p.tagName || '')) return p.tagName.toLowerCase();
    }
    return 'page';
  };
  for (const n of ${JSON.stringify(nums)}) {
    const ref = window.__cxEls && window.__cxEls[n];
    const el = ref && ref.deref();
    if (el && el.isConnected && vis(el)) continue;
    total++;
    const g = el ? String(groupOf(el)).slice(0, 40) : 'page';
    groups.set(g, (groups.get(g) || 0) + 1);
  }
  return { total, groups: [...groups].sort((x, y) => y[1] - x[1]) };
})()`;
}

function UNDER_POINT(n) {
  return `(() => {${DEEP}
  ${REF(n)}
  ${clickPoint.toString()}
  ${KIND_LABEL}
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const at = clickPoint(el, r, document);
  let hit = document.elementFromPoint ? document.elementFromPoint(at.x, at.y) : null;
  while (hit && hit.shadowRoot && hit.shadowRoot.elementFromPoint) {
    const inner = hit.shadowRoot.elementFromPoint(at.x, at.y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return null;
  const hl = labelOf(hit);
  return (hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (hit.classList[0] ? '.' + hit.classList[0] : '')).replace(/[^\\w#.:-]/g, '') + (hl ? ' ' + JSON.stringify(hl.slice(0, 40)) : '');
})()`;
}

const VALUE_CHOICE = (n) => `(() => {${ICON}
  ${REF(n)}
  ${CHOICE_OF}
  return null;
})()`;

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
  const hrefPath = el => { const p = String(el.getAttribute('href') || '').split(/[?#]/)[0]; return p.length <= 40 ? p.replace(/[/._-]+/g, ' ') : ''; };
  const any = (test) => deepAll(document, test).some(vis);
  const host = location.hostname;
  const idp = /(^|\\.)accounts\\.google\\.com$/.test(host) ? 'google'
    : /(^|\\.)(login\\.microsoftonline\\.com|login\\.live\\.com)$/.test(host) ? 'microsoft'
    : /(^|\\.)appleid\\.apple\\.com$/.test(host) ? 'apple'
    : /(^|\\.)okta\\.com$/.test(host) ? 'okta' : null;
  const body = (document.body && document.body.innerText) || '';
  const has = (test) => deepAll(document, test).length > 0;
  const short = x => { const s = String(x || '').replace(/\\s+/g, ' ').trim(); return s.length <= 30 ? s : ''; };
  const SIGN_IN = /\\b(sign in|log in|login|intra in cont|autentificare|conectare|contul meu)\\b/i;
  const fold = x => String(x || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/\\s+/g, ' ');
  const signInShown = any(el => (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button')
    && SIGN_IN.test(fold(el.innerText || el.textContent) + ' ' + fold(el.getAttribute('aria-label')))
    && (!el.getAttribute('href') || /login|signin|sign-in|auth/i.test(el.getAttribute('href'))));
  const loggedInHint = () => {
    if (has(el => el.tagName === 'INPUT' && el.type === 'password')) return null;
    if (signInShown) return null;
    const exit = /log ?out|sign ?out|deconectare|iesire/i;
    if (any(el => (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'menuitem' || el.getAttribute('role') === 'button')
      && [el.innerText || el.textContent, el.getAttribute('aria-label')].some(x => exit.test(fold(short(x)))))) return 'logout';
    if (any(el => el.matches(${JSON.stringify(PROFILE_SEL)}))) return 'profile';
    if (any(el => el.matches('[contenteditable=true][role=textbox]'))) return 'composer';
    return null;
  };
  const pwds = deepAll(document, el => el.tagName === 'INPUT' && el.type === 'password').filter(vis);
  const logoutLink = !signInShown && any(el => (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'menuitem')
    && signOutOf([short(el.innerText || el.textContent), short(el.getAttribute('aria-label')), hrefPath(el)], SO_RES));
  const interstitial = /^just a moment|checking your browser|verify you are human|attention required/i.test(document.title) && body.trim().length < 600;
  const captchaFrames = deepAll(document, el => el.tagName === 'IFRAME' && /recaptcha|hcaptcha|challenges\\.cloudflare\\.com/.test(el.src || '') && !/size=invisible/.test(el.src || '') && !el.closest('.grecaptcha-badge')).filter(vis);
  const big = el => { const r = el.getBoundingClientRect(); return r.width * r.height >= innerWidth * innerHeight / 4; };
  const fillable = any(el => el.tagName === 'INPUT' && !['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio'].includes(el.type) || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
  const sparse = body.trim().length < 600 && !fillable && captchaFrames.some(el => !/challenges\\.cloudflare\\.com/.test(el.src || ''));
  const NEW_PW = /new|confirm|nou|noua|confirma|repeta|neu|nouveau/i;
  const passwordChange = logoutLink && pwds.length > 0 && (pwds.length >= 2
    || pwds.some(el => el.getAttribute('autocomplete') === 'new-password'
      || NEW_PW.test([el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label')].filter(Boolean).join(' '))));
  return {
    password: pwds.length > 0 && !passwordChange,
    passwordChange,
    otp: any(el => el.tagName === 'INPUT' && el.getAttribute('autocomplete') === 'one-time-code'),
    captcha: interstitial || (captchaFrames.length > 0 && (pwds.length > 0 || captchaFrames.some(big) || sparse)),
    idp,
    googleRejected: idp === 'google' && (location.pathname.startsWith('/v3/signin/rejected') || body.includes('This browser or app may not be secure')),
    logoutLink,
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
  const own = of(el);
  if (el.tagName === 'LABEL' && el.control && el.control.tagName === 'INPUT' && /^(radio|checkbox)$/.test(el.control.type)) own.checked = el.control.checked;
  const ctl = (el.getAttribute('aria-controls') || '').trim().split(/\\s+/)[0]; const scope = el.getRootNode && el.getRootNode().getElementById ? el.getRootNode() : document; const panel = ctl ? scope.getElementById(ctl) : null;
  return { el: own, tile: of(up && up.closest(${JSON.stringify(TILE_SEL)})), panel: of(panel) };
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
      const described = new Set([...document.querySelectorAll('[aria-describedby]')].flatMap((e) => e.getAttribute('aria-describedby').split(/\s+/)).filter(Boolean));
      const inControl = (e) => { const c = e.closest('button,[role=button],[role=group]'); return !!c && art.contains(c); };
      const isDescribed = (e) => described.has(e.getAttribute('id')) || [...e.querySelectorAll('[id]')].some((x) => described.has(x.getAttribute('id')));
      body = [...art.querySelectorAll('p,div')]
        .filter((e) => own(e) && !(head && String(e.innerText || '').includes(head))
          && !(row && (inside(e, row) || e.contains(row))) && ![handleEl, nameEl, time].some((x) => x && e.contains(x))
          && !inControl(e) && !e.querySelector('button,[role=button],[role=group]')
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
  ${main ? MAIN_ROOT : ''}
  const scope = ${main ? 'mainRootOf() || document' : 'document'};
  return feedPosts(scope, ${JSON.stringify(cats || {})}, byEl, location);
})()`;
}

const CONTENT_TYPE = 'document.contentType';

module.exports = {
  ISOLATED_WORLD, TEXT_MAX, BOX_SEL, CHROME_SEL, CHROME_MARK, ELEMENTS_MAX, VALUE_MAX, OVERLAY_ID, MAIN_ROOT, OVERLAY, OVERLAY_OFF, LOGIN_PROBE, CONTENT_TYPE, READ_ROOT_SEL, WALL_RE, WALL_WEAK_RE, SCROLL_INFO, MAIN_SCROLLER, SCROLLER_INFO, POINTER_SCAN_MAX, PAGE_TEXT, DEEP, BUSY,
  READ_TEXT: readText, INSPECT: inspect, READ_INTERACTIVE: readInteractive, FEED: feed, CHECK: check, numbering, FIND: find, SUBMIT_TARGET: submitTarget, ARROW_KEYS, FIND_TEXT: findText, CLEAR: clear, SELECT: select, VALUE: value, VALUE_ACTIVE, VALUE_CHOICE, UNDER_POINT, GONE, CHOICE_OF,
  TARGET_STATE: targetState, TILE_SEL, STATE_ATTRS, CONSEQUENTIAL, SIGN_OUT, consequentialOf, consequentialHit, clickPoint, signOutOf, labelFrom, distinctClips, inputLine, bulletItems,
};
