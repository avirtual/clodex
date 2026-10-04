'use strict';

const ISOLATED_WORLD = 4242;
const TEXT_MAX = 400000;
const ELEMENTS_MAX = 6000;
const MAIN_SEL = 'main, article, [role=main]';
const STD_SEL = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=combobox],summary,[contenteditable=true]';
const X_SEL = 'a:not([href]),[onclick],[tabindex]:not([tabindex="-1"])';
const POINTER_SCAN_MAX = 3000;
const LAYOUT_CELL_CHARS = 400;

const DEEP = `
  const deepAll = (root, test, out = []) => {
    for (const el of root.querySelectorAll('*')) {
      if (test(el)) out.push(el);
      if (el.shadowRoot) deepAll(el.shadowRoot, test, out);
    }
    return out;
  };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };`;

function readText(main) {
  return `(() => {
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
  if (!root) return '';
  const clone = root.cloneNode(true);
  clone.querySelectorAll(DROP).forEach(n => n.remove());
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:1000px';
  host.appendChild(clone); document.body.appendChild(host);
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
  }
  const txt = clone.innerText; host.remove();
  return (document.title + '\\n\\n' + txt).replace(/[ \\t]+/g, ' ').replace(/\\n\\s*\\n+/g, '\\n\\n').trim().slice(0, ${TEXT_MAX});
})()`;
}

function readInteractive(main) {
  return `(() => {${DEEP}${ICON}
  const sel = ${JSON.stringify(STD_SEL)};
  const xsel = ${JSON.stringify(X_SEL)};
  if (!window.__cxEls) { window.__cxEls = [null]; window.__cxOf = new WeakMap(); }
  const clip = (s, n) => { s = (s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const labelOf = el => {
    if (el.labels && el.labels[0]) return el.labels[0].innerText;
    return el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.getAttribute('placeholder')
      || el.value || (el.querySelector('img[alt]') || {}).alt || el.getAttribute('name') || '';
  };
  const mainRoot = ${main ? `document.querySelector(${JSON.stringify(MAIN_SEL)})` : 'null'};
  const inScope = el => {
    if (!mainRoot) return true;
    let n = el;
    while (n) { if (n === mainRoot) return true; n = n.parentNode || n.host; }
    return false;
  };
  const stamp = el => {
    let n = window.__cxOf.get(el);
    if (!n) { n = window.__cxEls.length; window.__cxEls.push(new WeakRef(el)); window.__cxOf.set(el, n); }
    el.setAttribute('data-cx', String(n));
    return n;
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
  const out = []; const seen = new Set(); let truncated = false;
  for (const el of cands) {
    if (!vis(el)) continue;
    const tag = el.tagName.toLowerCase();
    const plain = !std.has(el);
    const kind = plain ? 'clickable' : el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? 'input:' + (el.type || 'text') : tag);
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    let line = '';
    if (plain) {
      if (underRow(el)) continue;
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
    if (!inScope(el)) { stamp(el); continue; }
    if (out.length >= ${ELEMENTS_MAX}) { truncated = true; stamp(el); continue; }
    out.push('[' + stamp(el) + '] ' + kind + ' ' + line + (disabled ? ' [disabled]' : ''));
  }
  return { lines: out, truncated };
})()`;
}

const ICON = `
  const iconLabel = e => {
    const img = [...e.querySelectorAll('img')].find(i => (i.getAttribute('alt') || '').trim());
    const t = e.querySelector('svg > title');
    return (img && img.getAttribute('alt')) || e.getAttribute('title') || e.getAttribute('aria-label') || (t && t.textContent) || '';
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
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    visible: vis(el), ancestors, html: clip(clone.outerHTML, 300),
  };
})()`;
}

const PAGE_TEXT = `(() => {
  const t = (document.body && document.body.innerText) || '';
  return t.replace(/[ \\t]+/g, ' ').split('\\n').map(l => l.trim()).filter(Boolean).join('\\n').slice(0, ${TEXT_MAX});
})()`;

function findText(text) {
  const want = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
  return `(() => {${DEEP}
  if (!window.__cxEls) { window.__cxEls = [null]; window.__cxOf = new WeakMap(); }
  const want = ${JSON.stringify(want)};
  const SKIP = new Set(['HTML', 'HEAD', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'OPTION', 'OPTGROUP', 'SELECT', 'TEXTAREA']);
  const BUTTONS = new Set(['button', 'submit', 'reset']);
  const own = el => {
    let t = el.tagName === 'INPUT' && BUTTONS.has(el.type) ? el.value || '' : '';
    for (const c of el.childNodes) if (c.nodeType === 3) t += c.nodeValue;
    return t.replace(/\\s+/g, ' ').trim();
  };
  const hits = deepAll(document, el => !SKIP.has(el.tagName) && own(el).toLowerCase().includes(want)).filter(vis);
  const stamp = el => {
    let n = window.__cxOf.get(el);
    if (!n) { n = window.__cxEls.length; window.__cxEls.push(new WeakRef(el)); window.__cxOf.set(el, n); }
    el.setAttribute('data-cx', String(n));
    return n;
  };
  return { count: hits.length, hits: hits.slice(0, 5).map(el => {
    const t = own(el);
    return { n: stamp(el), text: t.length > 60 ? t.slice(0, 59) + '…' : t };
  }) };
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

const LOGIN_PROBE = `(() => {${DEEP}
  const any = (test) => deepAll(document, test).some(vis);
  const host = location.hostname;
  const idp = /(^|\\.)accounts\\.google\\.com$/.test(host) ? 'google'
    : /(^|\\.)(login\\.microsoftonline\\.com|login\\.live\\.com)$/.test(host) ? 'microsoft'
    : /(^|\\.)appleid\\.apple\\.com$/.test(host) ? 'apple'
    : /(^|\\.)okta\\.com$/.test(host) ? 'okta' : null;
  const body = (document.body && document.body.innerText) || '';
  return {
    password: any(el => el.tagName === 'INPUT' && el.type === 'password'),
    otp: any(el => el.tagName === 'INPUT' && el.getAttribute('autocomplete') === 'one-time-code'),
    captcha: any(el => el.tagName === 'IFRAME' && /recaptcha|hcaptcha|challenges\\.cloudflare\\.com/.test(el.src || '')),
    idp,
    googleRejected: idp === 'google' && (location.pathname.startsWith('/v3/signin/rejected') || body.includes('This browser or app may not be secure')),
    logoutLink: any(el => (el.tagName === 'A' || el.tagName === 'BUTTON') && /\\b(log|sign)\\s?out\\b/i.test(el.innerText || '')),
  };
})()`;

const CONTENT_TYPE = 'document.contentType';

module.exports = {
  ISOLATED_WORLD, TEXT_MAX, ELEMENTS_MAX, LOGIN_PROBE, CONTENT_TYPE, POINTER_SCAN_MAX, PAGE_TEXT,
  READ_TEXT: readText, INSPECT: inspect, READ_INTERACTIVE: readInteractive, FIND: find, FIND_TEXT: findText, CLEAR: clear, SELECT: select,
};
